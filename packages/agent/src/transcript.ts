import { open, stat } from "node:fs/promises";

import { classifyFailure, type StallReason } from "./drivers/types.ts";

// Transcripts are append-only JSONL files. Every read here starts at the byte
// offset recorded when the current prompt was submitted, so cost depends on
// the size of one turn rather than the whole session.

const MAX_READ = 32 * 1024 * 1024;

export interface TurnText {
  text: string;
  /** The turn exceeded MAX_READ; its start (and possibly a huge record) was skipped. */
  truncated: boolean;
}

/** Reads `path` from `offset` to the end; restarts at 0 if the file shrank (e.g. replaced). */
export async function readFrom(path: string, offset: number, maxRead = MAX_READ): Promise<TurnText> {
  if (!path) return { text: "", truncated: false };
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return { text: "", truncated: false };
  }
  try {
    const { size } = await handle.stat();
    let start = offset > size ? 0 : offset;
    const truncated = size - start > maxRead;
    if (truncated) start = size - maxRead;
    const buffer = Buffer.alloc(size - start);
    await handle.read(buffer, 0, buffer.length, start);
    let text = buffer.toString("utf8");
    if (truncated) {
      // Drop the first line only if the window starts mid-record.
      const before = Buffer.alloc(1);
      await handle.read(before, 0, 1, start - 1);
      if (before[0] !== 0x0a) text = text.slice(text.indexOf("\n") + 1);
    }
    return { text, truncated };
  } finally {
    await handle.close();
  }
}

/** When the file last changed (ms), or undefined if it cannot be read. */
export async function modifiedAt(path: string): Promise<number | undefined> {
  if (!path) return undefined;
  return stat(path).then((s) => s.mtimeMs, () => undefined);
}

/** A turn that ended on an error instead of an answer. */
export interface TurnFailure {
  reason: Exclude<StallReason, "no_output">;
  message: string;
  /** Unique per failure (the record's id). */
  id: string;
  /** When it was recorded (ms). */
  at: number;
}

export function jsonLines(text: string): any[] {
  const records: any[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A partial line at a read boundary.
    }
  }
  return records;
}

// --- Claude Code -----------------------------------------------------------

const CLAUDE_INTERRUPT = "[Request interrupted by user";

/**
 * Claude writes no hook on Esc; it appends a user record whose content is an
 * array (real prompts are plain strings) with this marker text. `turn` is the
 * hook's prompt_id; the marker carries the interrupted turn's promptId.
 */
export function claudeInterrupted(records: any[], turn?: string): boolean {
  return records.some(
    (r) =>
      r?.type === "user" &&
      Array.isArray(r.message?.content) &&
      r.message.content.some((c: any) => c?.type === "text" && typeof c.text === "string" && c.text.startsWith(CLAUDE_INTERRUPT)) &&
      (!turn || !r.promptId || r.promptId === turn),
  );
}

function isClaudePrompt(r: any): boolean {
  return r?.type === "user" && typeof r.message?.content === "string" && !r.isMeta;
}

/** Text the assistant wrote after its last tool call in the latest turn. */
export function claudeFinalReply(records: any[]): string {
  let start = 0;
  records.forEach((r, i) => {
    if (isClaudePrompt(r)) start = i + 1;
  });
  let parts: string[] = [];
  for (const r of records.slice(start)) {
    if (r?.type !== "assistant" || !Array.isArray(r.message?.content)) continue;
    for (const block of r.message.content) {
      if (block?.type === "tool_use") parts = [];
      else if (block?.type === "text" && block.text) parts.push(block.text);
    }
  }
  return parts.join("\n\n").trim();
}

/**
 * Claude Code ends a turn it cannot complete (usage limit, safeguards, an API
 * error it gave up retrying) with a synthetic assistant message flagged
 * isApiErrorMessage. It only counts while nothing came after it: after a
 * safeguard stop Claude may continue the turn on its own.
 */
export function claudeFailure(records: any[]): TurnFailure | undefined {
  let last: any;
  for (const r of records) if (r?.type === "assistant") last = r;
  if (!last?.isApiErrorMessage) return undefined;
  const content = last.message?.content;
  const text =
    (Array.isArray(content) ? content.filter((c: any) => c?.type === "text" && c.text).map((c: any) => c.text).join(" ") : typeof content === "string" ? content : "") ||
    `API error (${last.error ?? "unknown"})`;
  const reason = last.error === "rate_limit" ? "usage_limit" : last.message?.stop_reason === "refusal" ? "content_filter" : classifyFailure(text);
  return { reason, message: text, id: String(last.uuid ?? last.timestamp ?? ""), at: Date.parse(last.timestamp) || 0 };
}

// --- Codex -------------------------------------------------------------------

const codexEvent = (r: any, type: string) => r?.type === "event_msg" && r.payload?.type === type;

/** Records of the latest task (from its task_started on), so an earlier task's end never stands for the current one. */
function codexLatestTask(records: any[]): any[] {
  let start = 0;
  records.forEach((r, i) => {
    if (codexEvent(r, "task_started")) start = i;
  });
  return records.slice(start);
}

/** Codex finished its latest task (task_complete), successfully or not. */
export function codexTurnEnded(records: any[]): boolean {
  return codexLatestTask(records).some((r) => codexEvent(r, "task_complete"));
}

const CODEX_FILTER_GUIDANCE = "<content_filter_guidance>";

/**
 * Codex records a failed turn as task_complete with an `error` (it fires no
 * Stop hook then, so the pane still says working). A blocked response first
 * shows up as a developer message carrying content-filter guidance.
 */
export function codexFailure(records: any[]): TurnFailure | undefined {
  let complete: any;
  let filtered = false;
  for (const r of codexLatestTask(records)) {
    if (r?.type === "event_msg" && r.payload?.type === "task_complete") complete = r;
    if (r?.type === "response_item" && r.payload?.role === "developer" && JSON.stringify(r.payload.content ?? "").includes(CODEX_FILTER_GUIDANCE)) filtered = true;
  }
  const error = complete?.payload?.error;
  if (!error) return undefined;
  const message = String(error.message ?? error.codex_error_info ?? "turn failed");
  const reason = error.codex_error_info === "usage_limit_exceeded" ? "usage_limit" : filtered ? "content_filter" : classifyFailure(message);
  return { reason, message, id: String(complete.payload.turn_id ?? complete.timestamp ?? ""), at: Date.parse(complete.timestamp) || 0 };
}

export function codexInterrupted(records: any[]): boolean {
  return records.some((r) => r?.type === "event_msg" && r.payload?.type === "turn_aborted");
}

/** Codex records the final answer of each turn on its task_complete event. */
export function codexFinalReply(records: any[]): string {
  let reply = "";
  for (const r of records) {
    if (r?.type === "event_msg" && r.payload?.type === "task_complete") reply = r.payload.last_agent_message ?? "";
  }
  return reply.trim();
}
