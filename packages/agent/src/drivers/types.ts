import type { Tmux } from "@agent-master/tmux";

import type { AgentKind, AgentRecord, AgentState } from "../registry.ts";

export interface LaunchPlan {
  command: string[];
  env?: Record<string, string>;
  /** Extra pane fields to record before the agent starts (e.g. opencode's URL). */
  fields?: Partial<Record<"url" | "auth" | "trustOverride", string>>;
}

export interface StatusView {
  state: AgentState;
  detail: string;
}

export interface Driver {
  readonly kind: AgentKind;
  /** Problems worth telling the user about before launching (never fatal). */
  preflight(cwd: string, args: string[]): Promise<string[]>;
  launch(options: { cwd: string; model?: string; args: string[] }): Promise<LaunchPlan>;
  /** Resolves once the agent accepts input; `reload` re-reads the pane record. */
  waitReady(tmux: Tmux, reload: () => Promise<AgentRecord>, deadline: number): Promise<void>;
  status(record: AgentRecord): Promise<StatusView>;
  /** A value that changes once the agent has accepted a newly submitted prompt. */
  promptMarker(record: AgentRecord): Promise<string>;
  /** How long a submitted prompt may take to change the marker. */
  readonly acceptTimeoutMs: number;
  /** Records which conversation the accepted prompt went to; `marker` is the value that confirmed it. */
  afterAccepted?(tmux: Tmux, record: AgentRecord, marker: string): Promise<void>;
  /** The agent's final message in its latest turn. */
  readReply(record: AgentRecord): Promise<string>;
  approve(tmux: Tmux, record: AgentRecord, scope: "once" | "always"): Promise<void>;
  deny(tmux: Tmux, record: AgentRecord): Promise<void>;
  interrupt(tmux: Tmux, record: AgentRecord): Promise<void>;
}

export class AmError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "AmError";
    this.code = code;
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Hook commands are run by a shell. Paths made of safe characters stay as-is
 * (a changed command string makes Codex ask to re-trust its hooks); anything
 * else is single-quoted.
 */
export function shellCommand(path: string): string {
  return /^[A-Za-z0-9_./+-]+$/.test(path) ? path : `'${path.replace(/'/g, `'\\''`)}'`;
}

/**
 * Polls `probe` every `interval` ms until it returns a value or `deadline`
 * passes (0 = no deadline). Transient errors are retried; AmError ends the wait.
 */
export async function poll<T>(probe: () => Promise<T | undefined>, deadline: number, interval = 250): Promise<T | undefined> {
  for (;;) {
    const value = await probe().catch((error) => {
      if (error instanceof AmError) throw error;
      return undefined;
    });
    if (value !== undefined) return value;
    if (deadline && Date.now() >= deadline) return undefined;
    await sleep(interval);
  }
}
