// `am trust`: answers the folder-trust dialog an agent stands at on its first start in a directory. The
// screen is never read: the agent's own records say that this dialog is the one it stands at, and that
// the answer was taken. Keys are pressed once per launch, whatever comes of it: the dialogs that may
// follow (bypass permissions, MCP servers, hooks) would take the same keys as their answer.
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

import type { Tmux } from "@agent-master/tmux";

import { acquireSendLock, getAgent, markReady, releaseSendLock, view, type AgentView } from "./agent.ts";
import { config, configPath, expandHome } from "./config.ts";
import { AmError, DRIVERS, poll, sleep } from "./drivers/index.ts";
import { findRecord, type AgentRecord } from "./registry.ts";
import { readSaved } from "./saved.ts";

/** How long an agent's screen may take to come up: of keys sent before it, some could be lost and the rest pick another answer. */
const SCREEN_MS = 5000;
const KEY_GAP_MS = 300;
/** How long the answer may take to be on record. */
const ANSWER_MS = 10_000;

export interface TrustOptions {
  /** How long to wait for the agent to be ready after the answer. */
  timeoutMs?: number;
  /** Default: trustRoots in am.json. */
  trustRoots?: string[];
  screenMs?: number;
  answerMs?: number;
}

export interface Trusted {
  agent: AgentView;
  /** The directory the agent recorded its trust for. */
  root: string;
  /** It is a git repository, trusted as a whole. */
  repository: boolean;
}

/** With one of these set, the agent may keep its records elsewhere, or ask nothing. */
const ELSEWHERE_ENV = ["HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "CLAUDE_CODE_SANDBOXED", "CLAUDE_CODE_IGNORE_PERSISTED_TRUST"];
/** With one of these, it works in another directory, or asks although it has trusted this one. */
const ELSEWHERE_ARGS = /^(-C.*|--cd(=.*)?|-w|--worktree(=.*)?|--ignore-persisted-trust)$/;

/** Whether `dir` lies below one of `roots`, all with symlinks resolved; a root itself does not. */
export async function below(dir: string, roots: string[]): Promise<boolean> {
  const real = (path: string) => realpath(path).catch(() => undefined);
  const path = await real(dir);
  if (!path) return false;
  for (const root of await Promise.all(roots.map((root) => real(resolve(expandHome(root)))))) {
    if (root && path !== root && path.startsWith(root === "/" ? root : `${root}/`)) return true;
  }
  return false;
}

const LEFT = "am-left-the-dialog";

/**
 * Presses one key, in one step with checking that nothing happened to the agent meanwhile. The first
 * key marks the pane, so no later `am trust` presses one again.
 */
async function press(tmux: Tmux, { paneId, name }: AgentRecord, token: string, key: string, first: boolean): Promise<void> {
  const starting = `#{&&:#{==:#{@am_lock},${token}},#{==:#{@am_state},starting}}`;
  const out = await tmux.run([
    "if-shell", "-F", "-t", paneId,
    first ? `#{&&:${starting},#{==:#{@am_trust},}}` : starting,
    `${first ? `set-option -p -t ${paneId} @am_trust ${Date.now()} ; ` : ""}send-keys -t ${paneId} ${key}`,
    `display-message -p ${LEFT}`,
  ]);
  if (out.includes(LEFT)) throw new AmError("not_starting", `${name} is no longer at a startup dialog, or am trust has answered one for it already; stopped`);
}

/** Refuses what am cannot be sure of, before any key is pressed. */
async function checkLaunch(record: AgentRecord): Promise<void> {
  const saved = await readSaved(record.name);
  const unsure = (why: string) => new AmError("unsupported", `${why}, so am cannot tell which dialog ${record.name} is at; the user must answer it in am open ${record.name}`);
  if (!saved || saved.startedAt !== record.startedAt) throw unsure("am has no record of how it was started");
  const env = ELSEWHERE_ENV.find((name) => name in saved.env);
  if (env) throw unsure(`it was started with ${env} set`);
  const arg = saved.args.find((value) => ELSEWHERE_ARGS.test(value));
  if (arg) throw unsure(`it was started with ${arg}`);
}

export async function trustFolder(tmux: Tmux, target: string, options: TrustOptions = {}): Promise<Trusted> {
  const record = await findRecord(tmux, target);
  const { name, kind, paneId } = record;
  const driver = DRIVERS[kind];
  const { state } = await view(record);
  if (state !== "starting") throw new AmError("not_starting", `${name} is ${state}: it is at no startup dialog`);
  if (!driver.trustDialog) throw new AmError("unsupported", `${kind} does not ask whether to trust a folder`);
  if (await tmux.display(paneId, "#{@am_trust}")) {
    throw new AmError("already_answered", `am trust has answered a dialog of ${name}'s already, and presses keys only once; the user must look at it in am open ${name}`);
  }
  await checkLaunch(record);
  const dialog = await driver.trustDialog(record.cwd);
  const roots = options.trustRoots ?? (await config()).trustRoots;
  for (const dir of [dialog.root, record.cwd]) {
    if (!(await below(dir, roots))) {
      throw new AmError("not_allowed", `${dir} is not below ${roots.join(" or ") || "any directory"} (trustRoots in ${configPath()}); the user must answer the dialog in am open ${name}`);
    }
  }

  await sleep(Math.max(0, record.startedAt + (options.screenMs ?? SCREEN_MS) - Date.now()));
  const token = await acquireSendLock(tmux, paneId, name);
  try {
    for (const [i, key] of dialog.keys.entries()) {
      if (i) await sleep(KEY_GAP_MS);
      // Someone answered it meanwhile: the next dialog is not ours.
      if (await dialog.answered()) throw new AmError("not_starting", `${kind} now trusts ${dialog.root}: someone else answered; am stopped`);
      await press(tmux, record, token, key, i === 0);
    }
  } finally {
    await releaseSendLock(tmux, paneId, token);
  }

  const answered = await poll(async () => {
    if (await dialog.answered()) return true;
    const now = await findRecord(tmux, paneId).catch(() => undefined);
    if (!now || now.paneDead) throw new AmError("exited", `${name} exited at the dialog and ${kind} has not trusted ${dialog.root}: the dialog's answers may be in another order in this version of ${kind}`);
    return undefined;
  }, Date.now() + (options.answerMs ?? ANSWER_MS));
  if (!answered) {
    throw new AmError("trust_unconfirmed", `${kind} has not recorded that it trusts ${dialog.root}; am pressed ${dialog.keys.join(" ")} once and will not again: the user must look at it in am open ${name}`);
  }

  await markReady(tmux, record, Date.now() + (options.timeoutMs ?? 30_000)).catch((error) => {
    // Trusted all the same; it may be at another dialog.
    if (!(error instanceof AmError && error.code === "start_timeout")) throw error;
  });
  return { agent: await getAgent(tmux, paneId), root: dialog.root, repository: dialog.repository };
}
