// What am knows about a task's worker, read through am's command line only.
import { spawnSync } from "node:child_process";

import type { WorkerSnapshot } from "./db.ts";

export interface WorkerInfo extends Omit<WorkerSnapshot, "worker"> {
  /** am's live state (idle, working, blocked, stalled, ...), or what am remembers: stopped, exited, lost. */
  state: string;
  detail: string;
}

const am = (args: string[]) => spawnSync(process.env.AM_BIN ?? "am", args, { encoding: "utf8" });

let saved: any[] | undefined;

/** A running agent's live view, else am's saved record of it, else undefined. */
export function workerInfo(name: string): WorkerInfo | undefined {
  if (!name) return undefined;
  const live = am(["status", name, "--json"]);
  if (live.status === 0) {
    try {
      const v = JSON.parse(live.stdout);
      return { state: v.state, detail: v.detail ?? "", worker_kind: v.kind, worker_profile: v.profile ?? "", worker_session: v.session ?? "", worker_cwd: v.cwd ?? "" };
    } catch {
      // Fall through to the saved record.
    }
  }
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
