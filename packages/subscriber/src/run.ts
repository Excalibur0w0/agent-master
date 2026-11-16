// The watcher loop: runs the source's watcher, keeps the feed state, and wakes
// the subscriber through am whenever it is idle and something is owed to it.
// No model runs here; the subscriber only wakes when there is news.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";

import { applySnapshot, batchPrompt, loadState, markDelivered, nextBatch, saveState, type FeedState } from "./feed.ts";
import { logFile, stateFile, subscriberDir, type SubscriberConfig } from "./home.ts";

export interface RunOptions {
  /** How often to check whether the subscriber can take a batch. */
  tickMs?: number;
  /** Wait before restarting a watcher that exited. */
  restartMs?: number;
}

const am = (args: string[], input?: string) =>
  spawnSync(process.env.AM_BIN ?? "am", args, { encoding: "utf8", input, env: withoutContract() });

/** The subscriber takes no worker contract: it is not a worker, and its own rules differ. */
export function withoutContract(): NodeJS.ProcessEnv {
  const { AM_CONTRACT: _, ...env } = process.env;
  return env;
}

export async function run(name: string, config: SubscriberConfig, options: RunOptions = {}): Promise<void> {
  const dir = subscriberDir(name);
  mkdirSync(dir, { recursive: true });
  const log = (line: string) => {
    const text = `${new Date().toISOString()} ${line}`;
    process.stdout.write(`${text}\n`);
    appendFileSync(logFile(name), `${text}\n`);
  };
  const state: FeedState = await loadState(stateFile(name));
  let child: ChildProcess | undefined;
  let stopping = false;
  let lastAgentNote = "";
  // One write at a time: snapshots and wake-ups both change the state.
  let saving: Promise<void> = Promise.resolve();
  const persist = () => {
    saving = saving.then(() => saveState(stateFile(name), state)).catch((error) => log(`could not save the state: ${error instanceof Error ? error.message : String(error)}`));
    return saving;
  };

  const stop = async () => {
    if (stopping) return;
    stopping = true;
    child?.kill("SIGTERM");
    await persist();
    log("stopped");
    process.exit(0);
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => void stop());

  const startWatcher = () => {
    if (stopping) return;
    const [command, ...args] = config.watch;
    log(`watcher: ${config.watch.join(" ")}`);
    const started = Date.now();
    let ended = false;
    const restart = (why: string) => {
      if (stopping || ended) return;
      ended = true;
      // A watcher that dies right away is retried less often.
      const wait = options.restartMs ?? (Date.now() - started < 30_000 ? 60_000 : 10_000);
      log(`watcher ${why}; restarting in ${Math.round(wait / 1000)}s`);
      setTimeout(startWatcher, wait);
    };
    child = spawn(command, args, { cwd: dir, env: { ...withoutContract(), AM_SUBSCRIBER_DIR: dir }, stdio: ["ignore", "pipe", "pipe"] });
    child.on("error", (error) => restart(`failed: ${error.message}`));
    createInterface({ input: child.stdout! }).on("line", (line) => {
      let message: any;
      try {
        message = JSON.parse(line);
      } catch {
        message = undefined;
      }
      if (!Array.isArray(message?.pending)) {
        // Only counts and errors belong in the log; never a message's text.
        log(`watcher printed a line that is not a snapshot (${line.length} chars), ignored`);
        return;
      }
      const { added, gone } = applySnapshot(state, message.pending);
      if (added || gone) log(`snapshot: ${state.pending.length} pending, ${added} new, ${gone} read elsewhere; ${state.queue.items.length} queued`);
      void persist();
    });
    createInterface({ input: child.stderr! }).on("line", (line) => log(`watcher: ${line.slice(0, 300)}`));
    child.on("exit", (code, signal) => restart(`exited (${signal ?? code})`));
  };

  const tick = async () => {
    const batch = nextBatch(state, config.batch ?? 20);
    if (!batch) return;
    const status = am(["status", name, "--json"]);
    const agent = status.status === 0 ? JSON.parse(status.stdout) : undefined;
    const note = agent ? `${agent.state}` : "not running";
    if (agent?.state !== "idle") {
      if (note !== lastAgentNote) log(`subscriber ${name} is ${note}; ${state.queue.items.length + state.queue.gone.length} waiting`);
      lastAgentNote = note;
      return;
    }
    lastAgentNote = "idle";
    const left = state.queue.items.length - batch.items.length;
    const sent = am(["prompt", name, "-"], batchPrompt(name, batch, left));
    if (sent.status !== 0) {
      log(`could not wake ${name}: ${sent.stderr.trim().slice(0, 300)}`);
      return;
    }
    markDelivered(state, batch);
    await persist();
    log(`woke ${name}: ${batch.items.length} new, ${batch.gone.length} read elsewhere${left ? `, ${left} still queued` : ""}`);
  };

  log(`started; ${state.pending.length} pending and ${state.queue.items.length} queued from before`);
  startWatcher();
  const loop = () =>
    tick()
      .catch((error) => log(`tick failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => {
        if (!stopping) setTimeout(loop, options.tickMs ?? 2000);
      });
  loop();
}
