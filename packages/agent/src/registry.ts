import type { Tmux } from "@agent-master/tmux";

export const AGENT_KINDS = ["claude", "codex", "opencode"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/**
 * `starting` until the agent can take input; `exited` once its pane or process
 * is gone; `unknown` when its state source cannot be reached.
 */
export type AgentState = "starting" | "idle" | "working" | "blocked" | "exited" | "unknown";

/** What `am` stores on an agent's tmux pane (pane-scoped `@am_*` user options). */
export interface AgentRecord {
  paneId: string;
  /** tmux session that holds the agent's pane. */
  tmuxSession: string;
  name: string;
  kind: AgentKind;
  cwd: string;
  startedAt: number;
  paneDead: boolean;
  /** Last state written by a hook (claude, codex) or by `am` itself. */
  state: AgentState;
  detail: string;
  event: string;
  updatedAt: number;
  session: string;
  transcript: string;
  /** Prompt id (claude) or turn id (codex) of the latest submitted prompt. */
  turn: string;
  /** Transcript size when the latest prompt was submitted. */
  offset: number;
  /** Count of prompts the agent accepted (claude, codex); only UserPromptSubmit moves it. */
  seq: number;
  /** tool_use_id of the request the agent is blocked on, if any. */
  pending: string;
  /** opencode: base URL and password of the TUI's built-in server. */
  url: string;
  auth: string;
  /** codex: directories trusted for this launch only via `-c projects."<dir>".trust_level="trusted"`. */
  trustOverride: string;
}

const FIELDS = {
  paneId: "#{pane_id}",
  tmuxSession: "#{session_name}",
  paneDead: "#{pane_dead}",
  name: "#{@am_name}",
  kind: "#{@am_kind}",
  cwd: "#{@am_cwd}",
  startedAt: "#{@am_started}",
  state: "#{@am_state}",
  detail: "#{@am_detail}",
  event: "#{@am_event}",
  updatedAt: "#{@am_ts}",
  session: "#{@am_session}",
  transcript: "#{@am_transcript}",
  turn: "#{@am_turn}",
  offset: "#{@am_offset}",
  seq: "#{@am_seq}",
  pending: "#{@am_pending}",
  url: "#{@am_url}",
  auth: "#{@am_auth}",
  trustOverride: "#{@am_trust_override}",
} as const;

// tmux escapes control characters in format output (e.g. \x1f becomes "\037"), but passes tabs through.
const SEPARATOR = "\t";
const FORMAT = Object.values(FIELDS).join(SEPARATOR);

export const NAME_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/;

export function parseRecord(row: string): AgentRecord | undefined {
  const values = row.split(SEPARATOR);
  const raw = Object.fromEntries(Object.keys(FIELDS).map((key, i) => [key, values[i] ?? ""])) as Record<keyof typeof FIELDS, string>;
  if (!raw.name || !(AGENT_KINDS as readonly string[]).includes(raw.kind)) return undefined;
  return {
    ...raw,
    kind: raw.kind as AgentKind,
    state: (raw.state || "starting") as AgentState,
    paneDead: raw.paneDead === "1",
    startedAt: Number(raw.startedAt) || 0,
    updatedAt: Number(raw.updatedAt) || 0,
    offset: Number(raw.offset) || 0,
    seq: Number(raw.seq) || 0,
  };
}

export async function listRecords(tmux: Tmux): Promise<AgentRecord[]> {
  return (await tmux.listPanes(FORMAT)).map(parseRecord).filter((r): r is AgentRecord => r !== undefined);
}

export class AgentNotFound extends Error {
  constructor(target: string) {
    super(`no agent named "${target}" (see am list)`);
    this.name = "AgentNotFound";
  }
}

/** Resolves a live agent by name, or by the id of the pane that hosts it. */
export async function findRecord(tmux: Tmux, target: string): Promise<AgentRecord> {
  const records = await listRecords(tmux);
  const found = target.startsWith("%") ? records.find((r) => r.paneId === target) : records.find((r) => r.name === target);
  if (!found) throw new AgentNotFound(target);
  return found;
}

/** Pane option names (`@am_*`) for the given record fields, e.g. to set them at pane creation. */
export function paneOptions(fields: Partial<Record<keyof typeof FIELDS, string | number>>): Record<string, string> {
  const options: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    const format = FIELDS[key as keyof typeof FIELDS];
    if (value !== undefined && format.startsWith("#{@")) options[format.slice(2, -1)] = String(value);
  }
  return options;
}

export async function writeRecord(tmux: Tmux, paneId: string, fields: Partial<Record<keyof typeof FIELDS, string | number>>): Promise<void> {
  await tmux.setPaneOptions(paneId, paneOptions(fields));
}
