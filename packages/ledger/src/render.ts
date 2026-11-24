// `am ledger show`: the ledger as markdown, in the shape the router's LEDGER.md had.
import type { Entry, Task } from "./db.ts";
import type { WorkerInfo } from "./workers.ts";

const pad = (n: number) => String(n).padStart(2, "0");
export function localTime(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** How long ago, in one unit: "now", "5m", "7h", "12d". */
export function age(ms: number, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - ms) / 60_000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 48 * 60) return `${Math.floor(minutes / 60)}h`;
  return `${Math.floor(minutes / (24 * 60))}d`;
}

/** "3d ago (2026-11-20 10:05)" */
const ago = (ms: number, now: number) => `${age(ms, now) === "now" ? "just now" : `${age(ms, now)} ago`} (${localTime(ms)})`;

/** "fix-login (profile claude, conversation abc) in /work — working" */
export function workerLine(task: Task, info: WorkerInfo | undefined): string {
  if (!task.worker) return "none";
  const what = [task.worker_profile ? `profile ${task.worker_profile}` : task.worker_kind, task.worker_session && `conversation ${task.worker_session}`].filter(Boolean).join(", ");
  const state = info ? `${info.state}${info.detail ? ` (${info.detail})` : ""}` : "not known to am";
  return `${task.worker}${what ? ` (${what})` : ""}${task.worker_cwd ? ` in ${task.worker_cwd}` : ""} — ${state}`;
}

function taskBlock(task: Task, info: WorkerInfo | undefined, now: number): string[] {
  const lines = [`### #${task.id} ${task.title}${task.status === "paused" ? " (paused)" : ""}`, `- Worker: ${workerLine(task, info)}`];
  if (task.waiting) lines.push(`- Waiting on: ${task.waiting}`);
  if (task.next) lines.push(`- Next: ${task.next}`);
  lines.push(`- Updated: ${ago(task.updated_at, now)}`);
  if (task.notes) {
    const [first, ...rest] = task.notes.split("\n");
    lines.push(`- Notes: ${first}`, ...rest.map((line) => `  ${line}`));
  }
  return lines;
}

/** `am ledger show <id>`: one task, whatever its status. */
export function renderTask(task: Task, info: WorkerInfo | undefined, now = Date.now()): string {
  const [title, ...rest] = taskBlock(task, info, now);
  const status = { active: "in progress", queued: "queued", paused: "paused", closed: "closed" }[task.status];
  const closed = task.closed_at ? `, closed ${ago(task.closed_at, now)}` : "";
  return [title.replace(/ \(paused\)$/, ""), `- Status: ${status}; added ${ago(task.created_at, now)}${closed}`, ...rest].join("\n");
}

function entryLine(entry: Entry): string {
  const from = [entry.at, entry.who, entry.place && `(${entry.place})`].filter(Boolean).join(" ");
  return `- i${entry.id} ${entry.auto ? "(auto) " : ""}${from}${from ? ": " : ""}${entry.title}${entry.why ? `. Why: ${entry.why}` : ""} [${entry.watcher}: ${entry.items.join(", ")}]`;
}

export function renderLedger(router: string, tasks: Task[], entries: Entry[], info: (task: Task) => WorkerInfo | undefined, now = Date.now()): string {
  const active = tasks.filter((t) => t.status === "active");
  const waiting = tasks.filter((t) => t.status === "queued" || t.status === "paused");
  const out = [
    `# Ledger: ${router}`,
    "",
    `Updated: ${localTime(now)} · ${active.length} in progress · ${waiting.length} queued · ${entries.length} for review`,
    "",
    "## In progress",
    "",
  ];
  for (const task of active) out.push(...taskBlock(task, info(task), now), "");
  if (!active.length) out.push("(none)", "");
  out.push("## Queued", "");
  for (const task of waiting) out.push(...taskBlock(task, info(task), now), "");
  if (!waiting.length) out.push("(none)", "");
  out.push("## For review", "", "<!-- Messages watchers put up for the user. Not tasks: they take no slot until the user wants one handled (am ledger inbox take). -->", "");
  for (const priority of ["urgent", "normal", "low"] as const) {
    const these = entries.filter((e) => e.priority === priority);
    if (!these.length) continue;
    out.push(`### ${priority[0].toUpperCase()}${priority.slice(1)}`, "", ...these.map(entryLine), "");
  }
  if (!entries.length) out.push("(none)", "");
  return `${out.join("\n").trimEnd()}\n`;
}
