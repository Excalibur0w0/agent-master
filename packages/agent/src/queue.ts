// Prompts waiting for a busy agent: `am prompt --queue` writes them here, and a detached
// `am deliver <name>` sends them in order as the agent becomes idle (deliver.ts). One JSON
// file per prompt in $AM_STATE_DIR/queue/<name>, mode 0600: it holds the prompt's text.
import { spawn } from "node:child_process";
import { appendFile, chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentRecord } from "./registry.ts";
import { savedDir } from "./saved.ts";

export interface QueuedPrompt {
  /** Sorts by when it was queued. */
  id: string;
  /** The launch it is for: an agent of the same name started later never gets it. */
  startedAt: number;
  at: number;
  text: string;
  /** An am command (its arguments) to run once the agent took it. */
  after?: string[];
  /** Why it was not delivered; it stays here, and is never sent again by itself. */
  failed?: string;
}

export const queueDir = (name: string) => join(savedDir(), "..", "queue", name);

const WAITING = /^(\d{15}-[a-z0-9]+)\.json$/;
/** Taken by the deliverer with that pid, which has not said how it went. */
const SENDING = /^(\d{15}-[a-z0-9]+)\.sending\.(\d+)$/;

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readPrompt(path: string): Promise<QueuedPrompt | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as QueuedPrompt;
  } catch {
    return undefined;
  }
}

async function writePrompt(name: string, prompt: QueuedPrompt): Promise<void> {
  const dir = queueDir(name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.${prompt.id}.${process.pid}.tmp`);
  await writeFile(tmp, `${JSON.stringify(prompt)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600);
  await rename(tmp, join(dir, `${prompt.id}.json`));
}

/** Everything queued under a name, oldest first; one whose deliverer died mid-send counts as failed: it may have arrived. */
export async function listQueued(name: string): Promise<QueuedPrompt[]> {
  const files = await readdir(queueDir(name)).catch(() => [] as string[]);
  const found = await Promise.all(
    files.map(async (file) => {
      const sending = SENDING.exec(file);
      if (!sending && !WAITING.test(file)) return undefined;
      const prompt = await readPrompt(join(queueDir(name), file));
      if (!prompt || !sending || alive(Number(sending[2]))) return prompt;
      return { ...prompt, failed: prompt.failed ?? "its delivery was cut off; it may or may not have arrived" };
    }),
  );
  return found.filter((p): p is QueuedPrompt => !!p).sort((a, b) => a.id.localeCompare(b.id));
}

/** Prompts this launch of the agent is still to be given. */
export async function pendingPrompts(record: Pick<AgentRecord, "name" | "startedAt">): Promise<QueuedPrompt[]> {
  return (await listQueued(record.name)).filter((p) => p.startedAt === record.startedAt && !p.failed);
}

export async function addPrompt(record: Pick<AgentRecord, "name" | "startedAt">, text: string, after?: string[]): Promise<QueuedPrompt> {
  const at = Date.now();
  // Two queued within a millisecond by one process still sort in order: process.hrtime breaks the tie.
  const tie = (process.hrtime.bigint() % 1_000_000_000n).toString(36).padStart(6, "0");
  const prompt: QueuedPrompt = { id: `${String(at).padStart(15, "0")}-${tie}${Math.random().toString(36).slice(2, 6)}`, startedAt: record.startedAt, at, text, ...(after ? { after } : {}) };
  await writePrompt(record.name, prompt);
  return prompt;
}

/** Takes a prompt for sending; only one taker succeeds, so none is ever sent twice. */
export async function claimPrompt(name: string, id: string): Promise<boolean> {
  return rename(join(queueDir(name), `${id}.json`), join(queueDir(name), `${id}.sending.${process.pid}`)).then(
    () => true,
    () => false,
  );
}

/** Settles a claimed prompt: delivered (gone), put back, or kept with why it failed. */
export async function settlePrompt(name: string, prompt: QueuedPrompt, result: "delivered" | "back" | { failed: string }): Promise<void> {
  const sending = join(queueDir(name), `${prompt.id}.sending.${process.pid}`);
  if (result === "back") {
    await rename(sending, join(queueDir(name), `${prompt.id}.json`));
    return;
  }
  if (result !== "delivered") await writePrompt(name, { ...prompt, failed: result.failed });
  await rm(sending, { force: true });
}

/** Drops what is queued under a name (not what is being sent right now); returns how many. */
export async function clearQueue(name: string): Promise<number> {
  const files = await readdir(queueDir(name)).catch(() => [] as string[]);
  const drop = files.filter((file) => WAITING.test(file) || !alive(Number(SENDING.exec(file)?.[2] ?? process.pid)));
  await Promise.all(drop.map((file) => rm(join(queueDir(name), file), { force: true })));
  return drop.length;
}

export async function removeQueue(name: string): Promise<void> {
  await rm(queueDir(name), { recursive: true, force: true });
}

/** A resumed agent gets what was queued for the launch it continues. */
export async function moveQueue(name: string, from: number, to: number): Promise<number> {
  const moved = (await listQueued(name)).filter((p) => p.startedAt === from && !p.failed);
  for (const prompt of moved) await writePrompt(name, { ...prompt, startedAt: to });
  return moved.length;
}

export async function logQueue(name: string, line: string): Promise<void> {
  await appendFile(join(queueDir(name), "log"), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 }).catch(() => {});
}

/** This am, for the detached deliverer and for a prompt's `after`. */
export const amCommand = () => process.env.AM_BIN ?? fileURLToPath(new URL("../bin/am", import.meta.url));

/** Starts a deliverer for the agent; one that finds another at work leaves at once. */
export function startDeliverer(name: string): void {
  const child = spawn(amCommand(), ["deliver", name], { cwd: homedir(), detached: true, stdio: "ignore" });
  child.on("error", () => {});
  child.unref();
}

const lockFile = (name: string) => join(queueDir(name), ".deliverer");

export async function delivererPid(name: string): Promise<number | undefined> {
  const pid = Number(await readFile(lockFile(name), "utf8").catch(() => ""));
  return pid && alive(pid) ? pid : undefined;
}

/** One deliverer per agent; a dead one's lock is taken over. (Claiming keeps prompts single even if two run.) */
export async function lockDeliverer(name: string): Promise<boolean> {
  await mkdir(queueDir(name), { recursive: true, mode: 0o700 });
  for (let tries = 0; tries < 2; tries++) {
    try {
      await writeFile(lockFile(name), String(process.pid), { flag: "wx", mode: 0o600 });
      return true;
    } catch {
      if (await delivererPid(name)) return false;
      await rm(lockFile(name), { force: true });
    }
  }
  return false;
}

export async function unlockDeliverer(name: string): Promise<void> {
  if (Number(await readFile(lockFile(name), "utf8").catch(() => "")) === process.pid) await rm(lockFile(name), { force: true });
}
