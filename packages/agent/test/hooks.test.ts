// Runs the real hook scripts against a real (isolated) tmux pane.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

import { Tmux } from "@agent-master/tmux";

import { findRecord } from "../src/registry.ts";

const tmux = new Tmux({ socketName: `am-hooks-test-${process.pid}` });
const hook = (name: string) => fileURLToPath(new URL(`../hooks/${name}.sh`, import.meta.url));
let socket = "";

before(async () => {
  await tmux.newSession("hooks", { command: "sh" });
  socket = await tmux.socketPath();
});
after(() => tmux.killServer());

async function agentPane(name: string, kind: string): Promise<string> {
  const pane = await tmux.newWindow("hooks", "sh");
  await tmux.setPaneOptions(pane, { "@am_name": name, "@am_kind": kind, "@am_state": "starting" });
  return pane;
}

function fire(script: string, pane: string, input: object): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = execFile(hook(script), { env: { ...process.env, TMUX: `${socket},0,0`, TMUX_PANE: pane } }, (error) => (error ? reject(error) : resolve()));
    child.stdin!.end(JSON.stringify(input));
  });
}

const pick = async <K extends string>(pane: string, ...keys: K[]) => {
  const record = (await findRecord(tmux, pane)) as unknown as Record<K, unknown>;
  return Object.fromEntries(keys.map((k) => [k, record[k]])) as Record<K, unknown>;
};

test("claude hook maps lifecycle events onto the pane", async () => {
  const pane = await agentPane("c1", "claude");
  const transcript = join(await mkdtemp(join(tmpdir(), "am-hook-")), "t.jsonl");
  await writeFile(transcript, '{"type":"user"}\n');
  const base = { session_id: "s-1", transcript_path: transcript };

  await fire("claude", pane, { ...base, hook_event_name: "SessionStart", source: "startup" });
  assert.deepEqual(await pick(pane, "state", "session", "transcript", "seq"), { state: "idle", session: "s-1", transcript, seq: 0 });

  await fire("claude", pane, { ...base, hook_event_name: "UserPromptSubmit", prompt_id: "p-7" });
  assert.deepEqual(await pick(pane, "state", "turn", "offset", "seq"), { state: "working", turn: "p-7", offset: 16, seq: 1 });

  await fire("claude", pane, { ...base, hook_event_name: "Stop", agent_id: "a-sub" });
  assert.equal((await pick(pane, "state")).state, "working", "subagent events never change the pane state");

  await fire("claude", pane, { ...base, hook_event_name: "SessionStart", source: "compact" });
  assert.equal((await pick(pane, "state")).state, "working", "auto-compaction is not a fresh start");

  await fire("claude", pane, { ...base, hook_event_name: "Notification", notification_type: "permission_prompt" });
  await fire("claude", pane, { ...base, hook_event_name: "Stop" });
  assert.deepEqual(await pick(pane, "state", "seq"), { state: "idle", seq: 1 }, "only UserPromptSubmit moves seq");
});

test("a parallel tool finishing does not hide a pending permission request", async () => {
  const pane = await agentPane("c2", "claude");
  const base = { session_id: "s-2", transcript_path: "/nonexistent.jsonl" };
  await fire("claude", pane, { ...base, hook_event_name: "UserPromptSubmit", prompt_id: "p-1" });

  // Real PermissionRequest input has no tool_use_id; requests are paired by tool name + input.
  await fire("claude", pane, { ...base, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "touch a", description: "d" } });
  const blocked = await pick(pane, "state", "detail", "pending");
  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.detail, "Bash");
  assert.match(String(blocked.pending), /^\d+-\d+$/);

  await fire("claude", pane, { ...base, hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "toolu_B", tool_input: { file_path: "x" } });
  assert.equal((await pick(pane, "state")).state, "blocked", "another tool finished; the dialog for Bash is still open");

  // Same call, keys in another order, plus the tool_use_id PostToolUse carries.
  await fire("claude", pane, { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "toolu_A", tool_input: { description: "d", command: "touch a" } });
  assert.deepEqual(await pick(pane, "state", "pending"), { state: "working", pending: "" });
});

test("values ending in ';' are stored literally", async () => {
  const pane = await agentPane("c3", "claude");
  await fire("claude", pane, { hook_event_name: "SessionStart", source: "startup", session_id: "s;", transcript_path: "/tmp/odd dir;/t.jsonl;" });
  assert.deepEqual(await pick(pane, "session", "transcript", "state"), { session: "s;", transcript: "/tmp/odd dir;/t.jsonl;", state: "idle" });
});

test("codex hook maps Interrupt to idle, keeps SessionStart informational, and ignores subagents", async () => {
  const pane = await agentPane("x1", "codex");
  const base = { session_id: "s-3", transcript_path: "/nonexistent.jsonl" };

  await fire("codex", pane, { ...base, hook_event_name: "SessionStart", source: "startup" });
  assert.deepEqual(await pick(pane, "state", "session"), { state: "starting", session: "s-3" });

  await fire("codex", pane, { ...base, hook_event_name: "UserPromptSubmit", turn_id: "t-1" });
  assert.deepEqual(await pick(pane, "state", "turn", "offset", "seq"), { state: "working", turn: "t-1", offset: 0, seq: 1 });

  await fire("codex", pane, { ...base, hook_event_name: "Stop", agent_id: "sub-1" });
  assert.equal((await pick(pane, "state")).state, "working", "a subagent's Stop is not the parent's");

  // Shapes recorded from Codex 0.160: the request carries an extra description.
  const asked = { command: "sleep 3 && touch a", description: "Do you want to allow running `sleep 3 && touch a`?" };
  await fire("codex", pane, { ...base, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: asked });
  await fire("codex", pane, { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "call_2", tool_input: { command: "ls" } });
  assert.equal((await pick(pane, "state")).state, "blocked", "a different command finished");
  await fire("codex", pane, { ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "call_1", tool_input: { command: "sleep 3 && touch a" } });
  assert.equal((await pick(pane, "state")).state, "working", "the approved command finished");

  // Only Bash requests carry the extra description; for other tools it is a real argument.
  await fire("codex", pane, { ...base, hook_event_name: "PermissionRequest", tool_name: "mcp__x", tool_input: { q: 1, description: "a" } });
  await fire("codex", pane, { ...base, hook_event_name: "PostToolUse", tool_name: "mcp__x", tool_use_id: "c3", tool_input: { q: 1, description: "b" } });
  assert.equal((await pick(pane, "state")).state, "blocked", "different description: a different call");
  await fire("codex", pane, { ...base, hook_event_name: "PostToolUse", tool_name: "mcp__x", tool_use_id: "c4", tool_input: { q: 1, description: "a" } });
  assert.equal((await pick(pane, "state")).state, "working");

  await fire("codex", pane, { ...base, hook_event_name: "Interrupt", turn_id: "t-1" });
  assert.deepEqual(await pick(pane, "state", "detail", "pending"), { state: "idle", detail: "interrupted", pending: "" });
});

test("hooks do nothing outside tmux", async () => {
  await new Promise<void>((resolve, reject) => {
    const env = { ...process.env };
    delete env.TMUX_PANE;
    const child = execFile(hook("claude"), { env }, (error) => (error ? reject(error) : resolve()));
    child.stdin!.end(JSON.stringify({ hook_event_name: "Stop" }));
  });
});
