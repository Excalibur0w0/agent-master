// The ledger: work in flight for each router (tasks), and the messages watchers
// put up for the user's review (inbox entries, which are not tasks). One SQLite
// file shared by the router, the watchers and the user. How many tasks are in
// progress at once is the user's call: nothing here caps it.
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export class LedgerError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export function ledgerPath(): string {
  return process.env.AM_LEDGER_DB || join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "agent-master", "ledger.db");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  router TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'queued', 'paused', 'closed')),
  worker TEXT NOT NULL DEFAULT '',
  worker_kind TEXT NOT NULL DEFAULT '',
  worker_profile TEXT NOT NULL DEFAULT '',
  worker_session TEXT NOT NULL DEFAULT '',
  worker_cwd TEXT NOT NULL DEFAULT '',
  waiting TEXT NOT NULL DEFAULT '',
  next TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS tasks_by_router ON tasks (router, status);
CREATE TABLE IF NOT EXISTS inbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  router TEXT NOT NULL,
  watcher TEXT NOT NULL,
  priority TEXT NOT NULL CHECK (priority IN ('urgent', 'normal', 'low')),
  title TEXT NOT NULL,
  who TEXT NOT NULL DEFAULT '',
  place TEXT NOT NULL DEFAULT '',
  at TEXT NOT NULL DEFAULT '',
  why TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'read', 'dismissed', 'taken')),
  task_id INTEGER REFERENCES tasks (id),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  auto INTEGER NOT NULL DEFAULT 0,
  noticed_at INTEGER
);
CREATE INDEX IF NOT EXISTS inbox_by_router ON inbox (router, status);
CREATE TABLE IF NOT EXISTS inbox_items (
  entry INTEGER NOT NULL REFERENCES inbox (id),
  watcher TEXT NOT NULL,
  item TEXT NOT NULL,
  PRIMARY KEY (watcher, item)
);
CREATE TABLE IF NOT EXISTS read_items (
  watcher TEXT NOT NULL,
  item TEXT NOT NULL,
  at INTEGER NOT NULL,
  PRIMARY KEY (watcher, item)
);
`;

export function openLedger(path = ledgerPath()): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // Router, watchers and the user write from separate processes.
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  addColumns(db, "inbox", { auto: "INTEGER NOT NULL DEFAULT 0", noticed_at: "INTEGER" });
  return db;
}

/** Columns added after a table was first created; another process may add them at the same moment. */
function addColumns(db: DatabaseSync, table: string, columns: Record<string, string>): void {
  const have = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name));
  for (const [name, type] of Object.entries(columns)) {
    if (have.has(name)) continue;
    try {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
    } catch (error) {
      if (!/duplicate column/i.test((error as Error).message)) throw error;
    }
  }
}

/** Runs `work` in one write transaction: a check and the write it allows cannot be split by another process. */
export function transaction<T>(db: DatabaseSync, work: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

// --- Tasks -------------------------------------------------------------------

export type TaskStatus = "active" | "queued" | "paused" | "closed";

export interface Task {
  id: number;
  router: string;
  title: string;
  status: TaskStatus;
  worker: string;
  worker_kind: string;
  worker_profile: string;
  worker_session: string;
  worker_cwd: string;
  waiting: string;
  next: string;
  notes: string;
  origin: string;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

/** What am knows about a worker, recorded on the task so it survives the worker. */
export interface WorkerSnapshot {
  worker: string;
  worker_kind?: string;
  worker_profile?: string;
  worker_session?: string;
  worker_cwd?: string;
}

export interface TaskFields extends Partial<WorkerSnapshot> {
  title?: string;
  waiting?: string;
  next?: string;
  /** Appended to the notes as a new line. */
  note?: string;
  /** Replaces the notes (import). */
  notes?: string;
  origin?: string;
}

const now = () => Date.now();

export function getTask(db: DatabaseSync, id: number): Task {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as unknown as Task | undefined;
  if (!task) throw new LedgerError("not_found", `no task #${id}`);
  return task;
}

export function activeTasks(db: DatabaseSync, router: string): Task[] {
  return db.prepare("SELECT * FROM tasks WHERE router = ? AND status = 'active' ORDER BY id").all(router) as unknown as Task[];
}

export function listTasks(db: DatabaseSync, router: string, all = false): Task[] {
  const order = "ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'queued' THEN 1 WHEN 'paused' THEN 1 ELSE 2 END, id";
  return db.prepare(`SELECT * FROM tasks WHERE router = ? ${all ? "" : "AND status <> 'closed'"} ${order}`).all(router) as unknown as Task[];
}

function withNote(notes: string, note: string | undefined): string {
  if (!note) return notes;
  return notes ? `${notes}\n${note}` : note;
}

export function addTask(db: DatabaseSync, router: string, fields: TaskFields & { title: string }, options: { queue?: boolean } = {}): Task {
  return transaction(db, () => {
    const at = now();
    const result = db
      .prepare(
        `INSERT INTO tasks (router, title, status, worker, worker_kind, worker_profile, worker_session, worker_cwd, waiting, next, notes, origin, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        router, fields.title, options.queue ? "queued" : "active",
        fields.worker ?? "", fields.worker_kind ?? "", fields.worker_profile ?? "", fields.worker_session ?? "", fields.worker_cwd ?? "",
        fields.waiting ?? "", fields.next ?? "", withNote(fields.notes ?? "", fields.note), fields.origin ?? "", at, at,
      );
    return getTask(db, Number(result.lastInsertRowid));
  });
}

export function updateTask(db: DatabaseSync, id: number, fields: TaskFields): Task {
  return transaction(db, () => {
    const task = getTask(db, id);
    if (task.status === "closed") throw new LedgerError("closed", `task #${id} is closed`);
    const next = {
      title: fields.title ?? task.title,
      worker: fields.worker ?? task.worker,
      worker_kind: fields.worker_kind ?? (fields.worker !== undefined && fields.worker !== task.worker ? "" : task.worker_kind),
      worker_profile: fields.worker_profile ?? (fields.worker !== undefined && fields.worker !== task.worker ? "" : task.worker_profile),
      worker_session: fields.worker_session ?? (fields.worker !== undefined && fields.worker !== task.worker ? "" : task.worker_session),
      worker_cwd: fields.worker_cwd ?? (fields.worker !== undefined && fields.worker !== task.worker ? "" : task.worker_cwd),
      waiting: fields.waiting ?? task.waiting,
      next: fields.next ?? task.next,
      notes: fields.notes ?? withNote(task.notes, fields.note),
    };
    db.prepare(
      `UPDATE tasks SET title = ?, worker = ?, worker_kind = ?, worker_profile = ?, worker_session = ?, worker_cwd = ?, waiting = ?, next = ?, notes = ?, updated_at = ? WHERE id = ?`,
    ).run(next.title, next.worker, next.worker_kind, next.worker_profile, next.worker_session, next.worker_cwd, next.waiting, next.next, next.notes, now(), id);
    return getTask(db, id);
  });
}

/** Moves a task between in progress, queued and paused. */
export function setStatus(db: DatabaseSync, id: number, status: Exclude<TaskStatus, "closed">): Task {
  return transaction(db, () => {
    const task = getTask(db, id);
    if (task.status === "closed") throw new LedgerError("closed", `task #${id} is closed`);
    db.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").run(status, now(), id);
    return getTask(db, id);
  });
}

export function closeTask(db: DatabaseSync, id: number, note?: string): Task {
  return transaction(db, () => {
    const task = getTask(db, id);
    if (task.status === "closed") throw new LedgerError("closed", `task #${id} is already closed`);
    const at = now();
    db.prepare("UPDATE tasks SET status = 'closed', notes = ?, closed_at = ?, updated_at = ? WHERE id = ?").run(withNote(task.notes, note), at, at, id);
    return getTask(db, id);
  });
}

/** Records what am now reports about a task's worker (its conversation id appears after the first prompt). */
export function refreshWorker(db: DatabaseSync, id: number, snapshot: Omit<WorkerSnapshot, "worker">): void {
  db.prepare(
    `UPDATE tasks SET worker_kind = coalesce(nullif(?, ''), worker_kind), worker_profile = coalesce(nullif(?, ''), worker_profile),
     worker_session = coalesce(nullif(?, ''), worker_session), worker_cwd = coalesce(nullif(?, ''), worker_cwd) WHERE id = ?`,
  ).run(snapshot.worker_kind ?? "", snapshot.worker_profile ?? "", snapshot.worker_session ?? "", snapshot.worker_cwd ?? "", id);
}

// --- Inbox: messages put up for the user's review ------------------------------

export type Priority = "urgent" | "normal" | "low";
export const PRIORITIES: Priority[] = ["urgent", "normal", "low"];

export interface Entry {
  id: number;
  router: string;
  watcher: string;
  priority: Priority;
  title: string;
  who: string;
  place: string;
  at: string;
  why: string;
  status: "open" | "read" | "dismissed" | "taken";
  task_id: number | null;
  created_at: number;
  updated_at: number;
  /** From a conversation the user wants handled without waiting for them: the router hands it to a worker at once. */
  auto: boolean;
  /** When am ledger inbox wait reported it to the router. */
  noticed_at: number | null;
  items: string[];
}

export interface EntryFields {
  priority?: Priority;
  title?: string;
  who?: string;
  where?: string;
  at?: string;
  why?: string;
  /** Source item ids this entry covers; on update, added to the ones it has. */
  items?: string[];
  /** Hand it to a worker without waiting for the user (see Entry.auto). */
  auto?: boolean;
}

function itemsOf(db: DatabaseSync, entry: number): string[] {
  return (db.prepare("SELECT item FROM inbox_items WHERE entry = ? ORDER BY rowid").all(entry) as Array<{ item: string }>).map((r) => r.item);
}

export function getEntry(db: DatabaseSync, id: number): Entry {
  const row = db.prepare("SELECT * FROM inbox WHERE id = ?").get(id) as unknown as EntryRow | undefined;
  if (!row) throw new LedgerError("not_found", `no inbox entry i${id}`);
  return { ...row, auto: Boolean(row.auto), items: itemsOf(db, id) };
}

export function listEntries(db: DatabaseSync, router: string, all = false): Entry[] {
  const order = "ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END, id DESC";
  const rows = db.prepare(`SELECT * FROM inbox WHERE router = ? ${all ? "" : "AND status = 'open'"} ${order}`).all(router) as unknown as EntryRow[];
  return rows.map((row) => ({ ...row, auto: Boolean(row.auto), items: itemsOf(db, row.id) }));
}

type EntryRow = Omit<Entry, "items" | "auto"> & { auto: number };

/**
 * The open entries nobody has been told about yet that need someone now: the ones to hand to a worker at once
 * (auto) and the urgent ones. Each is reported once. autoOnly: just the auto ones (what a watcher's feed loop
 * hands to temporary workers); watcher: just that watcher's.
 */
export function noticeEntries(db: DatabaseSync, router: string, options: { autoOnly?: boolean; watcher?: string } = {}): Entry[] {
  return transaction(db, () => {
    const which = options.autoOnly ? "auto = 1" : "(auto = 1 OR priority = 'urgent')";
    const watcher = options.watcher === undefined ? "" : "AND watcher = ?";
    const args = options.watcher === undefined ? [router] : [router, options.watcher];
    const ids = (
      db.prepare(`SELECT id FROM inbox WHERE router = ? ${watcher} AND status = 'open' AND noticed_at IS NULL AND ${which} ORDER BY id`).all(...args) as Array<{ id: number }>
    ).map((r) => r.id);
    const at = now();
    for (const id of ids) db.prepare("UPDATE inbox SET noticed_at = ? WHERE id = ?").run(at, id);
    return ids.map((id) => getEntry(db, id));
  });
}

function checkPriority(priority: unknown): Priority {
  if (!PRIORITIES.includes(priority as Priority)) throw new LedgerError("usage", `priority must be one of: ${PRIORITIES.join(", ")}`);
  return priority as Priority;
}

function attachItems(db: DatabaseSync, entry: number, watcher: string, items: string[]): void {
  for (const item of items) {
    const owner = db.prepare("SELECT entry FROM inbox_items WHERE watcher = ? AND item = ?").get(watcher, item) as { entry: number } | undefined;
    if (owner && owner.entry !== entry) throw new LedgerError("duplicate_item", `item ${item} is already in entry i${owner.entry}; update that entry instead`);
    if (!owner) db.prepare("INSERT INTO inbox_items (entry, watcher, item) VALUES (?, ?, ?)").run(entry, watcher, item);
  }
}

/**
 * An entry whose items the user has all read elsewhere leaves the list. An auto entry stays: the user asked
 * for it to be handled whether or not they glance at the conversation.
 */
function settleRead(db: DatabaseSync, entry: number): void {
  const unread = db
    .prepare("SELECT count(*) AS n FROM inbox_items i LEFT JOIN read_items r ON r.watcher = i.watcher AND r.item = i.item WHERE i.entry = ? AND r.item IS NULL")
    .get(entry) as { n: number };
  if (unread.n === 0) db.prepare("UPDATE inbox SET status = 'read', updated_at = ? WHERE id = ? AND status = 'open' AND auto = 0").run(now(), entry);
}

export function addEntry(db: DatabaseSync, router: string, watcher: string, fields: EntryFields): Entry {
  if (!fields.title?.trim()) throw new LedgerError("usage", "an entry needs a title");
  if (!fields.items?.length) throw new LedgerError("usage", "an entry needs the ids of the items it covers");
  const priority = checkPriority(fields.priority);
  return transaction(db, () => {
    const at = now();
    const result = db
      .prepare("INSERT INTO inbox (router, watcher, priority, title, who, place, at, why, auto, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(router, watcher, priority, fields.title!.trim(), fields.who ?? "", fields.where ?? "", fields.at ?? "", fields.why ?? "", fields.auto ? 1 : 0, at, at);
    const id = Number(result.lastInsertRowid);
    attachItems(db, id, watcher, fields.items!.map(String));
    settleRead(db, id);
    return getEntry(db, id);
  });
}

export function updateEntry(db: DatabaseSync, id: number, fields: EntryFields): Entry {
  return transaction(db, () => {
    const entry = getEntry(db, id);
    db.prepare("UPDATE inbox SET priority = ?, title = ?, who = ?, place = ?, at = ?, why = ?, auto = ?, updated_at = ? WHERE id = ?").run(
      fields.priority ? checkPriority(fields.priority) : entry.priority,
      fields.title?.trim() || entry.title,
      fields.who ?? entry.who,
      fields.where ?? entry.place,
      fields.at ?? entry.at,
      fields.why ?? entry.why,
      (fields.auto ?? entry.auto) ? 1 : 0,
      now(),
      id,
    );
    // Newly marked auto: the router hears about it again (it may have been told only that it was urgent),
    // and a read entry comes back, since auto ones stay until handled.
    if (fields.auto && !entry.auto) db.prepare("UPDATE inbox SET noticed_at = NULL, status = CASE status WHEN 'read' THEN 'open' ELSE status END WHERE id = ?").run(id);
    if (fields.items?.length) {
      attachItems(db, id, entry.watcher, fields.items.map(String));
      // New unread items reopen an entry the user had read.
      db.prepare("UPDATE inbox SET status = 'open' WHERE id = ? AND status = 'read'").run(id);
      settleRead(db, id);
    }
    return getEntry(db, id);
  });
}

/** The user read these items elsewhere; returns the entries that left the list. */
export function markRead(db: DatabaseSync, watcher: string, items: string[]): number[] {
  return transaction(db, () => {
    const at = now();
    for (const item of items) db.prepare("INSERT OR IGNORE INTO read_items (watcher, item, at) VALUES (?, ?, ?)").run(watcher, String(item), at);
    const entries = new Set<number>();
    for (const item of items) {
      const owner = db.prepare("SELECT entry FROM inbox_items WHERE watcher = ? AND item = ?").get(watcher, String(item)) as { entry: number } | undefined;
      if (owner) entries.add(owner.entry);
    }
    const closed: number[] = [];
    for (const entry of entries) {
      const before = getEntry(db, entry).status;
      settleRead(db, entry);
      if (before === "open" && getEntry(db, entry).status === "read") closed.push(entry);
    }
    return closed;
  });
}

export function dismissEntry(db: DatabaseSync, id: number): Entry {
  const entry = getEntry(db, id);
  if (entry.status !== "open") throw new LedgerError("not_open", `entry i${id} is ${entry.status}`);
  db.prepare("UPDATE inbox SET status = 'dismissed', updated_at = ? WHERE id = ?").run(now(), id);
  return getEntry(db, id);
}

/** The user wants an entry handled: it becomes a task (in progress unless queued). */
export function takeEntry(db: DatabaseSync, id: number, options: { title?: string; queue?: boolean } = {}): Task {
  return transaction(db, () => {
    const entry = getEntry(db, id);
    if (entry.status === "taken") throw new LedgerError("not_open", `entry i${id} is already task #${entry.task_id}`);
    const source = [entry.who, entry.place && `(${entry.place})`, entry.at].filter(Boolean).join(" ");
    const at = now();
    const result = db
      .prepare("INSERT INTO tasks (router, title, status, notes, origin, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(entry.router, options.title?.trim() || entry.title, options.queue ? "queued" : "active", `From ${entry.watcher}: ${source}${source ? ": " : ""}${entry.title} [items: ${entry.items.join(", ")}]`, `inbox:i${id}`, at, at);
    const task = Number(result.lastInsertRowid);
    db.prepare("UPDATE inbox SET status = 'taken', task_id = ?, updated_at = ? WHERE id = ?").run(task, at, id);
    return getTask(db, task);
  });
}
