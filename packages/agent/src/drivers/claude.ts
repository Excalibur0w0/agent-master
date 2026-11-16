import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { claudeFailure, claudeFinalReply, claudeInterrupted, jsonLines, modifiedAt, readFrom } from "../transcript.ts";
import { AmError, poll, shellCommand, sleep, stalledView, type Driver } from "./types.ts";

const HOOK = fileURLToPath(new URL("../../hooks/claude.sh", import.meta.url));

const HOOK_EVENTS: Array<[event: string, matcher?: string]> = [
  ["SessionStart"],
  ["UserPromptSubmit"],
  // Tools that stop and wait for the user, without a PermissionRequest.
  ["PreToolUse", "AskUserQuestion|ExitPlanMode"],
  ["PermissionRequest"],
  ["PostToolUse"],
  ["PostToolUseFailure"],
  ["Stop"],
  ["StopFailure"],
  ["Notification", "idle_prompt"],
  ["SessionEnd"],
];

export function claudeHookSettings(hook = HOOK): object {
  const hooks: Record<string, unknown[]> = {};
  for (const [event, matcher] of HOOK_EVENTS) {
    hooks[event] = [{ ...(matcher ? { matcher } : {}), hooks: [{ type: "command", command: shellCommand(hook), timeout: 10 }] }];
  }
  return { hooks };
}

/** Passed with --settings, so the user's own settings files stay untouched. */
async function settingsFile(): Promise<string> {
  const path = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "agent-master", "claude-settings.json");
  const content = `${JSON.stringify(claudeHookSettings(), null, 2)}\n`;
  if ((await readFile(path, "utf8").catch(() => "")) !== content) {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return path;
}

/** Whether Claude's folder-trust dialog was already accepted for `cwd` or a parent. */
async function isTrusted(cwd: string): Promise<boolean | undefined> {
  try {
    const projects = JSON.parse(await readFile(join(homedir(), ".claude.json"), "utf8")).projects ?? {};
    for (let dir = resolve(cwd); ; dir = dirname(dir)) {
      if (projects[dir]?.hasTrustDialogAccepted) return true;
      if (dir === dirname(dir)) return false;
    }
  } catch {
    return undefined;
  }
}

export const claude: Driver = {
  kind: "claude",
  binCompatible: true,
  acceptTimeoutMs: 8000,

  async preflight(cwd) {
    if ((await isTrusted(cwd)) === false) {
      return [`Claude has not trusted ${cwd} yet: it will stop at the trust dialog on start; confirm it once in its tmux session (am open)`];
    }
    return [];
  },

  async launch({ model, args, bin, resume }) {
    const native = resume ? withoutSessionChoice(args) : args;
    return {
      command: [bin ?? "claude", "--settings", await settingsFile(), ...(model ? ["--model", model] : []), ...(resume ? ["--resume", resume] : []), ...native],
      fields: resume ? { session: resume } : undefined,
    };
  },

  async waitReady(_tmux, reload, deadline) {
    const ready = await poll(async () => {
      const record = await reload();
      if (record.paneDead) throw new AmError("exited", "claude exited right after starting");
      return record.event === "SessionStart" || record.state === "idle" ? true : undefined;
    }, deadline);
    if (!ready) {
      throw new AmError("start_timeout", "claude did not finish starting in time (it may be waiting at a trust or login dialog; check its session with am open)");
    }
    await sleep(500);
  },

  async status(record) {
    if (record.paneDead) return { state: "exited", detail: "" };
    if (record.state === "working" || record.state === "blocked" || record.state === "idle") {
      const records = jsonLines((await readFrom(record.transcript, record.offset)).text);
      if (record.state !== "idle" && claudeInterrupted(records, record.turn)) return { state: "idle", detail: "interrupted" };
      const failure = record.state === "blocked" ? undefined : claudeFailure(records);
      // A turn that ended (StopFailure) on an error is final. While the pane still
      // says working, give Claude a moment: after a safeguard stop it may go on.
      if (failure && (record.state === "idle" || Date.now() - failure.at > FAILURE_SETTLE_MS)) {
        return stalledView(failure.reason, failure.message, `${record.turn}:${failure.id}`);
      }
      if (record.state === "working") {
        const written = await modifiedAt(record.transcript);
        return { state: "working", detail: record.detail, activity: Math.max(written ?? 0, record.updatedAt * 1000) };
      }
    }
    return { state: record.state, detail: record.detail };
  },

  async promptMarker(record) {
    // Only UserPromptSubmit moves @am_seq; other hook events must not count as acceptance.
    return String(record.seq);
  },

  async readReply(record) {
    const { text, truncated } = await readFrom(record.transcript, record.offset);
    const reply = claudeFinalReply(jsonLines(text));
    if (!reply && truncated) throw new AmError("reply_unavailable", "this turn's transcript is over 32MB, so the full reply cannot be read; ask the agent to write its result to a file and read that");
    return reply;
  },

  async approve(tmux, record, scope) {
    if (scope === "always") throw new AmError("unsupported", "claude only supports one-time approval (am approve without --always)");
    await tmux.sendKeys(record.paneId, "Enter");
  },

  async deny(tmux, record) {
    await tmux.sendKeys(record.paneId, "Escape");
  },

  async interrupt(tmux, record) {
    // Esc before the model starts streaming does not interrupt: Claude puts the
    // prompt back into the input, with no hook and nothing in the transcript.
    // Leave the turn time to start so the interrupt is recorded.
    if (record.state === "working" && record.event === "UserPromptSubmit") {
      await sleep(Math.max(0, record.updatedAt * 1000 + MIN_TURN_AGE_MS - Date.now()));
    }
    await tmux.sendKeys(record.paneId, "Escape");
  },
};

const MIN_TURN_AGE_MS = 3000;

/** How long an API error must stand as the turn's last word before a working Claude counts as stalled. */
const FAILURE_SETTLE_MS = 20_000;

/** Native arguments minus any choice of conversation, so `--resume <id>` decides it alone. */
export function withoutSessionChoice(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--resume" || arg === "-r" || arg === "--session-id") {
      if (args[i + 1] !== undefined && !args[i + 1].startsWith("-")) i++;
      continue;
    }
    if (arg === "--continue" || arg === "-c" || arg === "--fork-session" || arg.startsWith("--resume=") || arg.startsWith("--session-id=")) continue;
    out.push(arg);
  }
  return out;
}
