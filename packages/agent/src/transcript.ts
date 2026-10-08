import { open } from "node:fs/promises";

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

// --- Codex -------------------------------------------------------------------

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
