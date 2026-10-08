import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseToml } from "smol-toml";

import type { AgentRecord } from "../registry.ts";
import { codexFinalReply, codexInterrupted, jsonLines, readFrom } from "../transcript.ts";
import { AmError, poll, shellCommand, sleep, type Driver } from "./types.ts";

const HOOK = fileURLToPath(new URL("../../hooks/codex.sh", import.meta.url));

const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PermissionRequest", "PostToolUse", "Stop", "Interrupt", "SessionEnd"];

// Codex announces SessionStart only with the first prompt, so readiness is a
// settle delay after launch instead of an event.
const STARTUP_SETTLE_MS = 3000;

export function codexHookArgs(hook = HOOK): string[] {
  const command = shellCommand(hook);
  return HOOK_EVENTS.flatMap((event) => ["-c", `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(command)}}]}]`]);
}

function snake(event: string): string {
  return event.replace(/[A-Z]/g, (c, i) => `${i ? "_" : ""}${c.toLowerCase()}`);
}

function gitRoot(cwd: string): Promise<string | undefined> {
  return new Promise((done) =>
    execFile("git", ["-C", cwd, "rev-parse", "--show-toplevel"], (error, stdout) => done(error ? undefined : stdout.trim() || undefined)),
  );
}

function readConfig(): Promise<string> {
  return readFile(join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "config.toml"), "utf8").catch(() => "");
}

type TrustLevel = "trusted" | "untrusted";

interface HookState {
  trustedHash: string;
  enabled: boolean;
}

interface CodexConfig {
  hookStates: Map<string, HookState>;
  projects: Record<string, TrustLevel>;
}

/**
 * The parts of config.toml that decide Codex's two trust prompts. A config
 * that does not parse counts as trusting nothing (Codex would not start either).
 */
export function parseCodexConfig(configText: string): CodexConfig {
  let doc: any = {};
  try {
    doc = parseToml(configText);
  } catch {
    doc = {};
  }
  const hookStates = new Map<string, HookState>();
  for (const [key, value] of Object.entries<any>(doc?.hooks?.state ?? {})) {
    const hash = typeof value?.trusted_hash === "string" && /^sha256:[0-9a-f]{64}$/.test(value.trusted_hash) ? value.trusted_hash : "";
    hookStates.set(key, { trustedHash: hash, enabled: value?.enabled !== false });
  }
  const projects: Record<string, TrustLevel> = {};
  for (const [dir, value] of Object.entries<any>(doc?.projects ?? {})) {
    if (value?.trust_level === "trusted" || value?.trust_level === "untrusted") projects[dir] = value.trust_level;
  }
  return { hookStates, projects };
}

/**
 * The hash Codex stores once the user trusts a hook: sha256 over the compact,
 * key-sorted JSON of the hook's normalized identity (codex-rs hooks
 * discovery.rs hook_hash + config fingerprint.rs version_for_toml). Unset
 * optional fields are absent (TOML has no null); timeouts are normalized to
 * 600s, or 1s for SessionEnd and Interrupt.
 */
export function codexHookHash(event: string, command: string): string {
  const label = snake(event);
  const timeout = label === "session_end" || label === "interrupt" ? 1 : 600;
  // Keys in sorted order, as serde_json's sort_all_objects produces.
  const identity = { event_name: label, hooks: [{ async: false, command, timeout, type: "command" }] };
  return `sha256:${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

/** Every am hook is trusted for exactly this command and not disabled, as Codex would decide. */
export async function codexHooksTrusted(configText?: string, command = shellCommand(HOOK)): Promise<boolean> {
  const states = parseCodexConfig(configText ?? (await readConfig())).hookStates;
  return HOOK_EVENTS.every((event) => {
    const state = states.get(`/<session-flags>/config.toml:${snake(event)}:0:0`);
    return state !== undefined && state.enabled && state.trustedHash === codexHookHash(event, command);
  });
}

/** Per-launch `-c projects."<dir>".trust_level=...` overrides; the last one for a directory wins. */
export function trustOverrides(args: string[]): Record<string, TrustLevel> {
  const levels: Record<string, TrustLevel> = {};
  args.forEach((arg, i) => {
    const value = arg === "-c" || arg === "--config" ? args[i + 1] : arg.startsWith("--config=") ? arg.slice(9) : undefined;
    const match = value && /^projects\."([^"]+)"\.trust_level\s*=\s*"(trusted|untrusted)"$/.exec(value);
    if (match) levels[match[1]] = match[2] as TrustLevel;
  });
  return levels;
}

/**
 * Codex asks once per project whether to trust it; answers live under
 * [projects."<dir>"]. Inside a git repo the project is the repo root, and
 * neither a trusted parent directory nor a -c override counts there
 * (observed with Codex 0.160). Outside git, overrides take precedence, and the
 * nearest directory with an answer decides.
 */
export function codexDirectoryTrusted(configText: string, cwd: string, gitRoot?: string, overrides: Record<string, TrustLevel> = {}): boolean {
  const levels: Record<string, TrustLevel> = { ...parseCodexConfig(configText).projects };
  if (gitRoot) return levels[gitRoot] === "trusted";
  Object.assign(levels, overrides);
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    if (levels[dir]) return levels[dir] === "trusted";
    if (dir === dirname(dir)) return false;
  }
}

/** Both trust prompts answered, as recorded in config.toml. */
async function trustAnswered(record: AgentRecord): Promise<boolean> {
  const config = await readConfig();
  // Stored as JSON: pane options are read back one line per pane.
  const overrides: Record<string, TrustLevel> = record.trustOverride ? JSON.parse(record.trustOverride) : {};
  return codexDirectoryTrusted(config, record.cwd, await gitRoot(record.cwd), overrides) && (await codexHooksTrusted(config));
}

export const codex: Driver = {
  kind: "codex",
  // The first prompt creates the session (SessionStart, MCP servers) before UserPromptSubmit fires.
  acceptTimeoutMs: 20_000,

  async preflight(cwd, args) {
    const config = await readConfig();
    const warnings: string[] = [];
    if (!codexDirectoryTrusted(config, cwd, await gitRoot(cwd), trustOverrides(args))) warnings.push(`Codex 还没信任过 ${cwd}：启动时会先问是否信任这个目录，需要你到它的 tmux 会话里（am open）确认`);
    if (!(await codexHooksTrusted(config))) warnings.push("Codex 首次加载 am 的 hooks 时需要你信任一次：到它的 tmux 会话里（am open）选「Trust all and continue」");
    return warnings;
  },

  async launch({ model, args }) {
    const overrides = trustOverrides(args);
    return {
      // An update prompt at startup would take the first prompt's Enter as its answer.
      command: ["codex", ...codexHookArgs(), "-c", "check_for_update_on_startup=false", ...(model ? ["-m", model] : []), ...args],
      fields: Object.keys(overrides).length ? { trustOverride: JSON.stringify(overrides) } : undefined,
    };
  },

  async waitReady(_tmux, reload, deadline) {
    // Both trust prompts block input and nothing reports them except the answer
    // landing in config.toml. Until then a submitted prompt's Enter would answer
    // the dialog on the user's behalf, so never report ready before that.
    const trusted = await poll(async () => {
      const record = await reload();
      if (record.paneDead) throw new AmError("exited", "codex 启动后退出了");
      return (await trustAnswered(record)) ? true : undefined;
    }, deadline, 500);
    if (!trusted) {
      throw new AmError("start_timeout", "codex 在等你确认信任（目录或 am 的 hooks）：用 am open 打开它的会话确认后，再用 am status 查看");
    }
    const { startedAt } = await reload();
    await sleep(Math.max(0, startedAt + STARTUP_SETTLE_MS - Date.now()));
    if ((await reload()).paneDead) throw new AmError("exited", "codex 启动后退出了");
  },

  async status(record) {
    if (record.paneDead) return { state: "exited", detail: "" };
    if (record.state === "starting") {
      // `am start` may have timed out before the user answered a trust prompt; recover once it is answered.
      const ready = Date.now() - record.startedAt >= STARTUP_SETTLE_MS && (await trustAnswered(record));
      return { state: ready ? "idle" : "starting", detail: "" };
    }
    if (record.state === "working" || record.state === "blocked") {
      // Backstop in case the Interrupt hook was missed.
      if (codexInterrupted(jsonLines((await readFrom(record.transcript, record.offset)).text))) return { state: "idle", detail: "interrupted" };
    }
    return { state: record.state, detail: record.detail };
  },

  async promptMarker(record) {
    // Only UserPromptSubmit moves @am_seq; other hook events must not count as acceptance.
    return String(record.seq);
  },

  async readReply(record) {
    const read = async () => {
      const { text, truncated } = await readFrom(record.transcript, record.offset);
      return { reply: codexFinalReply(jsonLines(text)), truncated };
    };
    let { reply, truncated } = await read();
    // The Stop hook fires a few milliseconds before task_complete is flushed.
    if (!reply && record.state === "idle" && record.detail !== "interrupted") {
      const later = await poll(async () => {
        const result = await read();
        truncated = result.truncated;
        return result.reply || undefined;
      }, Date.now() + 3000, 200);
      reply = later ?? "";
    }
    if (!reply && truncated) throw new AmError("reply_unavailable", "这一轮的对话记录超过 32MB，读不到完整回复；让它把结果写进文件再读");
    return reply;
  },

  async approve(tmux, record, scope) {
    if (scope === "always") throw new AmError("unsupported", "codex 只支持单次批准（am approve 不带 --always）");
    await tmux.sendKeys(record.paneId, "Enter");
  },

  async deny(tmux, record) {
    await tmux.sendKeys(record.paneId, "Escape");
  },

  async interrupt(tmux, record) {
    await tmux.sendKeys(record.paneId, "Escape");
  },
};
