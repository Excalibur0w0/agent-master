// Brings tasks over from the markdown LEDGER.md a router kept before the ledger
// moved to SQLite. Nothing is dropped: lines without a column of their own go
// to the task's notes.

export interface ImportedTask {
  title: string;
  status: "active" | "queued" | "paused";
  worker: string;
  worker_kind: string;
  worker_profile: string;
  worker_session: string;
  worker_cwd: string;
  waiting: string;
  next: string;
  notes: string;
}

/** "fix-login (profile claude, conversation abc) in /work（未运行）" → its parts; "无" or "none" → no worker. */
export function parseWorker(text: string): Pick<ImportedTask, "worker" | "worker_kind" | "worker_profile" | "worker_session" | "worker_cwd"> & { rest: string } {
  const empty = { worker: "", worker_kind: "", worker_profile: "", worker_session: "", worker_cwd: "", rest: "" };
  const match = /^([a-z][a-z0-9_-]{0,31})(?:\s*\(([^)]*)\))?(?:\s+in\s+(\/[^\s（(]*))?\s*(.*)$/.exec(text.trim());
  if (!match) return { ...empty, rest: text.trim() };
  const [, worker, inside = "", cwd = "", rest] = match;
  const parts = inside.split(",").map((p) => p.trim()).filter(Boolean);
  const session = parts.find((p) => p.startsWith("conversation "))?.slice(13).trim() ?? "";
  const how = parts.find((p) => !p.startsWith("conversation ")) ?? "";
  const profile = how.startsWith("profile ") ? how.slice(8).trim() : "";
  return { worker, worker_kind: profile ? "" : how, worker_profile: profile, worker_session: session, worker_cwd: cwd, rest: rest.trim() };
}

export function parseLedger(markdown: string): ImportedTask[] {
  const text = markdown.replace(/<!--[\s\S]*?-->/g, "");
  const tasks: ImportedTask[] = [];
  let section: "active" | "queued" | undefined;
  let current: { title: string; section: "active" | "queued"; lines: string[] } | undefined;
  const known = new Set(["worker", "status", "waiting on", "next"]);
  const flush = () => {
    if (!current) return;
    const fields = new Map<string, string>();
    const notes: string[] = [];
    for (const line of current.lines) {
      const field = /^- ([^:：]+)[:：]\s*(.*)$/.exec(line);
      const key = field?.[1].trim().toLowerCase();
      if (field && key && known.has(key) && !fields.has(key)) fields.set(key, field[2].trim());
      // Anything else (other fields keep their own spelling) goes to the notes.
      else if (line.trim()) notes.push(line.replace(/^- /, "").trim());
    }
    const worker = parseWorker(fields.get("worker") ?? "");
    const status = fields.get("status") ?? "";
    const workerNote = worker.rest && !/^(无|none|-)$/i.test(worker.rest) ? [`Worker: ${fields.get("worker")}`] : [];
    tasks.push({
      title: current.title,
      status: current.section === "active" ? "active" : /paused/i.test(status) ? "paused" : "queued",
      worker: worker.worker,
      worker_kind: worker.worker_kind,
      worker_profile: worker.worker_profile,
      worker_session: worker.worker_session,
      worker_cwd: worker.worker_cwd,
      waiting: fields.get("waiting on") ?? "",
      next: fields.get("next") ?? "",
      notes: [...(status ? [`Status before the move to SQLite: ${status}`] : []), ...workerNote, ...notes].join("\n"),
    });
    current = undefined;
  };
  for (const line of text.split("\n")) {
    const heading = /^(#{2,3})\s+(.*)$/.exec(line);
    if (heading?.[1] === "##") {
      flush();
      const name = heading[2].trim().toLowerCase();
      section = name.startsWith("in progress") ? "active" : name.startsWith("queued") ? "queued" : undefined;
    } else if (heading?.[1] === "###") {
      flush();
      if (section) current = { title: heading[2].trim(), section, lines: [] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  flush();
  return tasks;
}
