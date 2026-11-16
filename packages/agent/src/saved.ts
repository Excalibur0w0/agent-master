// What am remembers about each agent on disk, so `am resume` can bring it back
// after tmux, the machine or the agent's CLI restarts. Pane options are the
// live record; this file outlives the pane. One JSON file per agent name in
// $AM_STATE_DIR/agents, by default ~/.local/state/agent-master/agents (honoring
// XDG_STATE_HOME), mode 0600: it holds the --env values the agent was started with.
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AgentKind, AgentRecord } from "./registry.ts";

export interface SavedAgent {
  name: string;
  kind: AgentKind;
  cwd: string;
  bin?: string;
  model?: string;
  /** Only what the user passed (--env, a profile's env); never am's own per-launch values. */
  env: Record<string, string>;
  args: string[];
  profile?: string;
  contract?: string;
  placement: "session" | "window";
  /** The agent's conversation id, as its CLI resumes it; empty until the agent reports one. */
  session: string;
  /** Hash of the worker contract the agent last received in full. */
  contractSent: string;
  /** Matches the pane's @am_started: identifies this launch. */
  startedAt: number;
  /** The tmux server that held the pane (socket path, pid and start time). */
  server: string;
  /** Set by `am stop`. */
  stoppedAt?: number;
  /** Set once am sees its pane gone while the same tmux server runs on (it exited by itself). */
  exitedAt?: number;
}

/** stopped: closed with am stop; exited: its pane closed while that tmux server kept running; lost: the server went away (reboot, crash). */
export type SavedStatus = "running" | "stopped" | "exited" | "lost";

export function savedDir(): string {
  const root = process.env.AM_STATE_DIR || join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "agent-master");
  return join(root, "agents");
}

const fileOf = (name: string) => join(savedDir(), `${name}.json`);

export async function readSaved(name: string): Promise<SavedAgent | undefined> {
  try {
    return JSON.parse(await readFile(fileOf(name), "utf8")) as SavedAgent;
  } catch {
    return undefined;
  }
}

export async function writeSaved(agent: SavedAgent): Promise<void> {
  const dir = savedDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${agent.name}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(agent, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, fileOf(agent.name));
}

export async function listSaved(): Promise<SavedAgent[]> {
  const names = await readdir(savedDir()).catch(() => [] as string[]);
  const agents = await Promise.all(names.filter((n) => n.endsWith(".json") && !n.startsWith(".")).map((n) => readSaved(n.slice(0, -5))));
  return agents.filter((a): a is SavedAgent => !!a).sort((a, b) => a.name.localeCompare(b.name));
}

export async function removeSaved(name: string): Promise<boolean> {
  const exists = (await readSaved(name)) !== undefined;
  await rm(fileOf(name), { force: true });
  return exists;
}

/** Applies `change` to the saved record of exactly this launch; a newer or older launch's record is left alone. */
export async function updateSaved(name: string, startedAt: number, change: Partial<SavedAgent>): Promise<void> {
  const saved = await readSaved(name);
  if (!saved || saved.startedAt !== startedAt) return;
  if (Object.entries(change).every(([key, value]) => saved[key as keyof SavedAgent] === value)) return;
  await writeSaved({ ...saved, ...change });
}

// Last session written per launch, so polling (am wait) does not reread the file every 250ms.
const synced = new Map<string, string>();

/** Keeps the saved conversation id in step with what the agent's hooks report on its pane. */
export async function syncSession(record: AgentRecord): Promise<void> {
  if (!record.session || !record.startedAt) return;
  const key = `${record.name}@${record.startedAt}`;
  if (synced.get(key) === record.session) return;
  await updateSaved(record.name, record.startedAt, { session: record.session }).catch(() => {});
  synced.set(key, record.session);
}

export function savedStatus(agent: SavedAgent, live: AgentRecord[], server: string | undefined): SavedStatus {
  if (live.some((r) => r.name === agent.name)) return "running";
  if (agent.stoppedAt) return "stopped";
  if (agent.exitedAt) return "exited";
  return server && server === agent.server ? "exited" : "lost";
}

/**
 * Records exits while they can still be told apart: once the tmux server is
 * gone, an agent that exited by itself would look lost and be resumed.
 */
export async function markExited(saved: SavedAgent[], live: AgentRecord[], server: string | undefined): Promise<void> {
  if (!server) return;
  const now = Date.now();
  await Promise.all(
    saved
      .filter((agent) => !agent.stoppedAt && !agent.exitedAt && agent.server === server && !live.some((r) => r.name === agent.name))
      .map((agent) => updateSaved(agent.name, agent.startedAt, { exitedAt: now }).catch(() => {})),
  );
}
