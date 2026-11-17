// What am knows about a task's worker, read through am's command line only.
import { spawnSync } from "node:child_process";

import type { WorkerSnapshot } from "./db.ts";

export interface WorkerInfo extends Omit<WorkerSnapshot, "worker"> {
  /** am's live state (idle, working, blocked, stalled, ...), or what am remembers: stopped, exited, lost. */
  state: string;
  detail: string;
}

const am = (args: string[]) => spawnSync(process.env.AM_BIN ?? "am", args, { encoding: "utf8" });

/** Running agents by name, from one `am list`; undefined until loaded, or when that list failed. */
let live: Map<string, any> | undefined;
/** Each `am status` answer, so a name asked about twice costs one am call. */
const statuses = new Map<string, any>();
let saved: any[] | undefined;

/**
 * Reads every running agent with one `am list` instead of one `am status` per
 * task: each am call starts a process, so a ledger of 25 workers took 20-60
 * seconds. If the list fails, workerInfo falls back to asking one by one.
 */
export function loadLiveWorkers(): void {
  if (live !== undefined) return;
  const list = am(["list", "--json"]);
  if (list.status !== 0) return;
  try {
    const agents = JSON.parse(list.stdout);
    if (Array.isArray(agents)) live = new Map(agents.map((agent: any) => [agent.name, agent]));
  } catch {
    // Leave it unloaded: workerInfo asks am about each name.
  }
}

function liveView(name: string): any {
  if (live) return live.get(name);
  if (!statuses.has(name)) {
    const status = am(["status", name, "--json"]);
    let view: any;
    try {
      view = status.status === 0 ? JSON.parse(status.stdout) : undefined;
    } catch {
      view = undefined;
    }
    statuses.set(name, view);
  }
  return statuses.get(name);
}

/** A running agent's live view, else am's saved record of it, else undefined. */
export function workerInfo(name: string): WorkerInfo | undefined {
  if (!name) return undefined;
  const v = liveView(name);
  if (v) return { state: v.state, detail: v.detail ?? "", worker_kind: v.kind, worker_profile: v.profile ?? "", worker_session: v.session ?? "", worker_cwd: v.cwd ?? "" };
  if (saved === undefined) {
    const list = am(["list", "--saved", "--json"]);
    try {
      saved = list.status === 0 ? JSON.parse(list.stdout) : [];
    } catch {
      saved = [];
    }
  }
  const record = saved!.find((a) => a.name === name);
  if (!record) return undefined;
  return { state: record.status, detail: "", worker_kind: record.kind, worker_profile: record.profile ?? "", worker_session: record.session ?? "", worker_cwd: record.cwd ?? "" };
}
