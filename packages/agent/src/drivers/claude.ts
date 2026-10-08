import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { claudeFinalReply, claudeInterrupted, jsonLines, readFrom } from "../transcript.ts";
import { AmError, poll, shellCommand, sleep, type Driver } from "./types.ts";

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
  acceptTimeoutMs: 8000,

  async preflight(cwd) {
    if ((await isTrusted(cwd)) === false) {
      return [`Claude has not trusted ${cwd} yet: it will stop at the trust dialog on start; confirm it once in its tmux session (am open)`];
    }
    return [];
  },

  async launch({ model, args }) {
    return { command: ["claude", "--settings", await settingsFile(), ...(model ? ["--model", model] : []), ...args] };
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
    if (record.state === "working" || record.state === "blocked") {
      const records = jsonLines((await readFrom(record.transcript, record.offset)).text);
      if (claudeInterrupted(records, record.turn)) return { state: "idle", detail: "interrupted" };
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
