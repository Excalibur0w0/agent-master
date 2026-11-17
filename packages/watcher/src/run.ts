// The feed loop: runs the source's poller, keeps the feed state, and wakes
// the watcher through am whenever it can take input (idle, or its last turn failed on an
// API error) and something is owed to it.
// No model runs here; the watcher only wakes when there is news.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { createInterface } from "node:readline";

import { applySnapshot, backoff, batchPrompt, canTake, loadState, markDelivered, markReported, nextBatch, saveState, type FeedState } from "./feed.ts";
import { logFile, routerOf, stateFile, watcherDir, type WatcherConfig } from "./home.ts";

export interface RunOptions {
  /** How often to look for news, and to check whether the watcher can take a batch (default 2s). */
  tickMs?: number;
  /** While the watcher cannot take a batch, checks back off from tickMs up to this (default 30s). */
  maxWaitMs?: number;
  /** Wait before restarting a poller that exited. */
  restartMs?: number;
}

const am = (args: string[], input?: string) =>
  spawnSync(process.env.AM_BIN ?? "am", args, { encoding: "utf8", input, env: withoutContract() });

/** The watcher takes no worker contract: it is not a worker, and its own rules differ. */
export function withoutContract(): NodeJS.ProcessEnv {
  const { AM_CONTRACT: _, ...env } = process.env;
  return env;
}

export async function run(name: string, config: WatcherConfig, options: RunOptions = {}): Promise<void> {
  const dir = watcherDir(name);
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

  const startPoller = () => {
    if (stopping) return;
    const [command, ...args] = config.poll;
    log(`poller: ${config.poll.join(" ")}`);
    const started = Date.now();
    let ended = false;
    const restart = (why: string) => {
      if (stopping || ended) return;
      ended = true;
      // A poller that dies right away is retried less often.
      const wait = options.restartMs ?? (Date.now() - started < 30_000 ? 60_000 : 10_000);
      log(`poller ${why}; restarting in ${Math.round(wait / 1000)}s`);
      setTimeout(startPoller, wait);
    };
    child = spawn(command, args, { cwd: dir, env: { ...withoutContract(), AM_WATCHER_DIR: dir }, stdio: ["ignore", "pipe", "pipe"] });
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
        log(`poller printed a line that is not a snapshot (${line.length} chars), ignored`);
        return;
      }
      const { added, gone } = applySnapshot(state, message.pending);
      if (added || gone) log(`snapshot: ${state.pending.length} pending, ${added} new, ${gone} read elsewhere; ${state.queue.items.length} queued`);
      void persist();
    });
    createInterface({ input: child.stderr! }).on("line", (line) => log(`poller: ${line.slice(0, 300)}`));
    child.on("exit", (code, signal) => restart(`exited (${signal ?? code})`));
  };

  const tickMs = options.tickMs ?? 2000;
  const maxWaitMs = options.maxWaitMs ?? 30_000;
  // Each am status starts a node process (about 0.2s of CPU): asked every 2s while the watcher is busy or
  // stuck, that alone kept a CPU core 6-7% busy. So a watcher that cannot take a batch is checked less
  // and less often, up to maxWaitMs; news reaches it at most that much later.
  let waitMs = tickMs;

  /** One round; returns how long to wait before the next. */
  const tick = async (): Promise<number> => {
    // Items the user read elsewhere: the ledger takes them off the review list. No model needed.
    const gone = [...state.queue.gone];
    if (gone.length) {
      const told = am(["ledger", "inbox", "read", "--watcher", name, "--router", routerOf(config), ...gone.flatMap((id) => ["--item", id])]);
      if (told.status === 0) {
        markReported(state, gone);
        await persist();
        log(`told the ledger ${gone.length} item(s) were read elsewhere`);
      } else {
        log(`could not tell the ledger about read items: ${told.stderr.trim().slice(0, 300)}`);
      }
    }
    const batch = nextBatch(state, config.batch ?? 20);
    if (!batch) return (waitMs = tickMs);
    const status = am(["status", name, "--json"]);
    const agent = status.status === 0 ? JSON.parse(status.stdout) : undefined;
    const how = canTake(agent);
    if (!how) {
      const note = agent ? `${agent.state}${agent.stall ? ` (${agent.stall})` : ""}` : "not running";
      if (note !== lastAgentNote) log(`watcher ${name} is ${note}; ${state.queue.items.length} waiting`);
      lastAgentNote = note;
      return (waitMs = backoff(waitMs, tickMs, maxWaitMs));
    }
    lastAgentNote = "idle";
    waitMs = tickMs;
    const left = state.queue.items.length - batch.length;
    const sent = am(["prompt", name, "-"], batchPrompt(name, batch, left, how === "interrupted"));
    if (sent.status !== 0) {
      log(`could not wake ${name}: ${sent.stderr.trim().slice(0, 300)}`);
      return tickMs;
    }
    markDelivered(state, batch);
    await persist();
    log(`woke ${name}${how === "interrupted" ? " after its last turn failed on an API error" : ""}: ${batch.length} new${left ? `, ${left} still queued` : ""}`);
    return tickMs;
  };

  log(`started; ${state.pending.length} pending and ${state.queue.items.length} queued from before`);
  startPoller();
  const loop = () =>
    tick()
      .catch((error) => {
        log(`tick failed: ${error instanceof Error ? error.message : String(error)}`);
        return tickMs;
      })
      .then((wait) => {
        if (!stopping) setTimeout(loop, wait);
      });
  loop();
}
