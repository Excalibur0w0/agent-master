// Sends an agent the prompts queued for it (queue.ts), in order, as it becomes idle. Runs as a
// detached `am deliver <name>` from the first queued prompt until none is left.
import { spawnSync } from "node:child_process";

import type { Tmux } from "@agent-master/tmux";

import { markReady, promptAgent, view } from "./agent.ts";
import { AmError, sleep } from "./drivers/index.ts";
import { amCommand, claimPrompt, lockDeliverer, logQueue, pendingPrompts, settlePrompt, unlockDeliverer, type QueuedPrompt } from "./queue.ts";
import { findRecord, type AgentRecord } from "./registry.ts";

/**
 * How long the agent must stay idle first: an `am wait --read` on the turn that just ended
 * still has to notice and read its reply (up to REPLY_SETTLE_MS), which the next prompt would hide.
 */
export const IDLE_HOLD_MS = 5000;

/** The agent got busy first (someone else prompted it): the prompt goes back to the queue. */
const RETRY = new Set(["agent_busy", "agent_blocked", "agent_not_ready"]);

export interface DeliverOptions {
  holdMs?: number;
  intervalMs?: number;
  /** Runs a delivered prompt's `after` command. */
  runAfter?: (args: string[]) => void;
}

const runAm = (args: string[]) => {
  spawnSync(amCommand(), args, { stdio: "ignore", timeout: 60_000 });
};

const launchOf = async (tmux: Tmux, name: string, startedAt?: number): Promise<AgentRecord | undefined> => {
  const record = await findRecord(tmux, name).catch(() => undefined);
  return record && !record.paneDead && (startedAt === undefined || record.startedAt === startedAt) ? record : undefined;
};

/** Waits until the agent has been idle for `holdMs`; false once its next prompt is gone or it is. */
async function idleFor(tmux: Tmux, record: AgentRecord, prompt: QueuedPrompt, holdMs: number, intervalMs: number): Promise<boolean> {
  let since = 0;
  for (;;) {
    const now = await launchOf(tmux, record.name, record.startedAt);
    if (!now || (await pendingPrompts(now))[0]?.id !== prompt.id) return false;
    // am start gave up on it at a startup dialog: see whether it has got past that.
    if (now.state === "starting") await markReady(tmux, now, Date.now() + intervalMs).catch(() => {});
    const { state } = await view(now).catch(() => ({ state: "unknown" }));
    if (state !== "idle") since = 0;
    else if (!since) since = Date.now();
    if (since && Date.now() - since >= holdMs) return true;
    await sleep(intervalMs);
  }
}

async function deliverAll(tmux: Tmux, name: string, { holdMs = IDLE_HOLD_MS, intervalMs = 1000, runAfter = runAm }: DeliverOptions): Promise<void> {
  for (;;) {
    const record = await launchOf(tmux, name);
    const prompt = record && (await pendingPrompts(record))[0];
    if (!record || !prompt) return;
    if (!(await idleFor(tmux, record, prompt, holdMs, intervalMs))) continue;
    if (!(await claimPrompt(name, prompt.id))) continue;
    try {
      await promptAgent(tmux, record.paneId, prompt.text);
    } catch (error) {
      if (error instanceof AmError && RETRY.has(error.code)) {
        await settlePrompt(name, prompt, "back");
        await sleep(intervalMs);
        continue;
      }
      // It may have arrived: never sent again by itself, and what is behind it waits for someone to look.
      const why = error instanceof Error ? error.message : String(error);
      await settlePrompt(name, prompt, { failed: why });
      await logQueue(name, `${prompt.id} failed: ${why}`);
      for (const later of await pendingPrompts(record)) {
        if (await claimPrompt(name, later.id)) await settlePrompt(name, later, { failed: "held back: a prompt queued before it was not confirmed" });
      }
      return;
    }
    await settlePrompt(name, prompt, "delivered");
    await logQueue(name, `${prompt.id} delivered`);
    if (prompt.after) runAfter(prompt.after);
  }
}

/** Delivers until nothing is queued; leaves at once when another deliverer is at work on this agent. */
export async function deliverQueue(tmux: Tmux, name: string, options: DeliverOptions = {}): Promise<void> {
  for (;;) {
    if (!(await lockDeliverer(name))) return;
    try {
      await deliverAll(tmux, name, options);
    } finally {
      await unlockDeliverer(name);
    }
    // One queued just before the lock went: its own deliverer found the lock taken and left.
    const record = await launchOf(tmux, name);
    if (!record || !(await pendingPrompts(record)).length) return;
  }
}
