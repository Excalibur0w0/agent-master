import assert from "node:assert/strict";
import { appendFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { claudeFinalReply, claudeInterrupted, codexFinalReply, codexInterrupted, jsonLines, readFrom } from "../src/transcript.ts";

const jsonl = (...records: unknown[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

const prompt = (text: string, promptId = "p1") => ({ type: "user", promptId, message: { role: "user", content: text } });
const assistant = (...content: unknown[]) => ({ type: "assistant", message: { role: "assistant", content } });
const marker = (text: string, promptId: string) => ({ type: "user", promptId, message: { role: "user", content: [{ type: "text", text }] } });

test("claudeFinalReply keeps only the text after the last tool call of the latest turn", () => {
  const records = [
    prompt("old question", "p0"),
    assistant({ type: "text", text: "old answer" }),
    prompt("review this"),
    { type: "user", isMeta: true, message: { content: "<system-reminder>not a prompt</system-reminder>" } },
    assistant({ type: "thinking", thinking: "…" }, { type: "text", text: "Let me look." }),
    assistant({ type: "tool_use", id: "t1", name: "Bash", input: {} }),
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] } },
    assistant({ type: "text", text: "Found 2 bugs." }),
    assistant({ type: "text", text: "1. off-by-one" }),
  ];
  assert.equal(claudeFinalReply(records), "Found 2 bugs.\n\n1. off-by-one");
});

test("claudeInterrupted matches the marker structure and the turn's promptId", () => {
  const records = [marker("[Request interrupted by user for tool use]", "p2")];
  assert.equal(claudeInterrupted(records, "p2"), true);
  assert.equal(claudeInterrupted(records, "p3"), false, "a marker from another turn does not count");
  assert.equal(claudeInterrupted(records), true);
  assert.equal(claudeInterrupted([marker("[Request interrupted by user]", "p2")], "p2"), true);
  // The user literally typing the marker text is a string prompt, not an interrupt.
  assert.equal(claudeInterrupted([prompt("[Request interrupted by user]", "p2")], "p2"), false);
});

test("codex final reply and interrupts come from event_msg records", () => {
  const records = [
    { type: "event_msg", payload: { type: "task_started" } },
    { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "preamble" }] } },
    { type: "event_msg", payload: { type: "task_complete", last_agent_message: " done " } },
  ];
  assert.equal(codexFinalReply(records), "done");
  assert.equal(codexInterrupted(records), false);
  assert.equal(codexInterrupted([...records, { type: "event_msg", payload: { type: "turn_aborted", reason: "interrupted" } }]), true);
});

test("readFrom reads from the turn offset and restarts when the file shrinks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "am-transcript-"));
  const path = join(dir, "t.jsonl");
  await writeFile(path, jsonl(prompt("first", "p0")));
  const offset = Buffer.byteLength(jsonl(prompt("first", "p0")));
  await appendFile(path, jsonl(prompt("second", "p1"), assistant({ type: "text", text: "two" })));

  const turn = jsonLines((await readFrom(path, offset)).text);
  assert.equal(turn.length, 2);
  assert.equal(claudeFinalReply(turn), "two");

  const later = Buffer.byteLength(jsonl(prompt("first", "p0"), prompt("second", "p1"), assistant({ type: "text", text: "two" })));
  await writeFile(path, jsonl({ type: "user" }));
  assert.equal(jsonLines((await readFrom(path, later)).text).length, 1, "offset beyond EOF means a new file");
  assert.deepEqual(await readFrom(join(dir, "missing.jsonl"), 0), { text: "", truncated: false });
});

test("readFrom reports truncation and drops the partial first record", async () => {
  const dir = await mkdtemp(join(tmpdir(), "am-transcript-"));
  const path = join(dir, "t.jsonl");
  const tail = jsonl(assistant({ type: "text", text: "tail" }));
  await writeFile(path, jsonl(prompt("x".repeat(200), "p0")) + tail);
  // The window starts inside the long prompt record and covers the whole tail record.
  const { text, truncated } = await readFrom(path, 0, Buffer.byteLength(tail) + 20);
  assert.equal(truncated, true);
  assert.deepEqual(jsonLines(text).map((r) => r.type), ["assistant"]);
});

test("a truncation window that starts exactly at a line boundary keeps that line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "am-transcript-"));
  const path = join(dir, "t.jsonl");
  const tail = jsonl(assistant({ type: "text", text: "tail" }));
  await writeFile(path, jsonl(prompt("x".repeat(200), "p0")) + tail);
  const { text, truncated } = await readFrom(path, 0, Buffer.byteLength(tail));
  assert.equal(truncated, true);
  assert.equal(claudeFinalReply(jsonLines(text)), "tail");
});
