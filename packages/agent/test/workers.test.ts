// Profiles, the worker contract, stall detection and am resume. Real tmux on an
// isolated server; the "agent" is a shell script, so no model is ever called.
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { after, before, test } from "node:test";

import { Tmux } from "@agent-master/tmux";

import { forgetAgent, noOutputStall, promptAgent, resolveStart, resumeAgent, savedAgents, startAgent, stopAgent, waitAgent, withContract } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { claude } from "../src/drivers/claude.ts";
import { codex } from "../src/drivers/codex.ts";
import { opencode, opencodeStall } from "../src/drivers/opencode.ts";
import { findRecord, writeRecord, type AgentRecord } from "../src/registry.ts";
import { readSaved, savedStatus, type SavedAgent } from "../src/saved.ts";
import { claudeFailure, codexFailure, codexTurnEnded } from "../src/transcript.ts";

const tmux = new Tmux({ socketName: `am-workers-test-${process.pid}` });
let dir = "";

before(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "am-workers-")));
  // am remembers agents and caches Claude settings under these; keep the user's own untouched.
  process.env.AM_STATE_DIR = join(dir, "state");
  process.env.XDG_CACHE_HOME = join(dir, "cache");
  delete process.env.AM_CONTRACT;
  await tmux.newSession("base", { command: "sh" });
});
after(() => tmux.killServer());

function record(overrides: Partial<AgentRecord>): AgentRecord {
  const base = { paneId: "%1", tmuxSession: "am-a", name: "a", kind: "claude", cwd: "/tmp", startedAt: 0, paneDead: false, state: "idle", detail: "", event: "" };
  const strings = ["session", "transcript", "turn", "pending", "url", "auth", "trustOverride", "model", "profile", "contract", "contractSent", "stallSeen"];
  return { ...base, ...Object.fromEntries(strings.map((k) => [k, ""])), updatedAt: 0, offset: 0, seq: 0, ...overrides } as AgentRecord;
}

const lines = (...records: object[]) => records.map((r) => JSON.stringify(r)).join("\n") + "\n";

test("profiles come from the user's am.json and the request overrides them", async () => {
  const path = join(dir, "am.json");
  await writeFile(
    path,
    JSON.stringify({
      profiles: {
        rea: { kind: "claude", args: ["--permission-mode", "bypassPermissions", "--mcp-config", "~/.claude/mcp/rea.json"], description: "reverse engineering" },
        ds: { kind: "opencode", model: "deepseek/deepseek-flash#max", env: { HTTP_PROXY: "http://p", A: "1" }, args: ["--auto"], contract: "~/c.md" },
      },
      stallAfterMinutes: 20,
    }),
  );
  const config = await loadConfig(path);
  assert.equal(config.stallAfterMinutes, 20);

  const rea = await resolveStart({ name: "x", profile: "rea", args: ["--resume", "s"] }, path);
  assert.equal(rea.kind, "claude");
  assert.deepEqual(rea.args, ["--permission-mode", "bypassPermissions", "--mcp-config", join(homedir(), ".claude/mcp/rea.json"), "--resume", "s"], "profile args first, ~/ expanded");

  const ds = await resolveStart({ name: "x", profile: "ds", model: "deepseek/other", env: { A: "2" } }, path);
  assert.equal(ds.model, "deepseek/other", "an explicit option wins");
  assert.deepEqual(ds.env, { HTTP_PROXY: "http://p", A: "2" }, "env is merged, the request wins");
  assert.equal(ds.contract, join(homedir(), "c.md"));

  await assert.rejects(resolveStart({ name: "x", profile: "rea", kind: "codex" }, path), /conflicts with profile rea/);
  await assert.rejects(resolveStart({ name: "x", profile: "nope" }, path), /no profile named nope .*profiles: rea, ds/);
  assert.deepEqual((await loadConfig(join(dir, "missing.json"))).profiles, {}, "no file, no profiles");
  await writeFile(join(dir, "bad.json"), JSON.stringify({ profiles: { b: { kind: "vim" } } }));
  await assert.rejects(loadConfig(join(dir, "bad.json")), /profile "b": kind must be one of/);

  process.env.AM_CONTRACT = join(dir, "env-contract.md");
  try {
    assert.equal((await resolveStart({ name: "x", kind: "codex" }, path)).contract, join(dir, "env-contract.md"), "$AM_CONTRACT is the fallback");
    assert.equal((await resolveStart({ name: "x", kind: "codex", contract: "/c/own.md" }, path)).contract, "/c/own.md");
  } finally {
    delete process.env.AM_CONTRACT;
  }
});

test("the worker contract goes in full once, then as a reminder, and never onto slash commands", () => {
  const contract = { path: "/home/u/contract.md", content: "- never push", hash: "h1" };
  const full = withContract("fix the bug", contract, "");
  assert.match(full, /^fix the bug\n\n---\nWorker contract \(\/home\/u\/contract\.md\)\. It applies to this task and to every later message in this session:\n\n- never push\n$/);
  assert.equal(withContract("and the test", contract, "h1"), "and the test\n\n(The worker contract in /home/u/contract.md still applies.)");
  assert.match(withContract("again", contract, "h0"), /- never push/, "a changed contract goes in full again");
  assert.equal(withContract("/compact", contract, ""), "/compact");
  assert.equal(withContract("hi", undefined, ""), "hi");
});

test("a Claude turn that ended on an API error is a stall; one Claude went on from is not", async () => {
  const limit = { type: "assistant", uuid: "u9", timestamp: new Date().toISOString(), isApiErrorMessage: true, error: "rate_limit", message: { content: [{ type: "text", text: "You've hit your 5-hour limit · resets 6:20am" }] } };
  assert.deepEqual(claudeFailure([{ type: "user", message: { content: "go" } }, limit]), { reason: "usage_limit", message: "You've hit your 5-hour limit · resets 6:20am", id: "u9", at: Date.parse(limit.timestamp) });
  const flagged = { ...limit, uuid: "u1", error: "invalid_request", message: { stop_reason: "refusal", content: [{ type: "text", text: "API Error: safeguards flagged this message" }] } };
  assert.equal(claudeFailure([flagged])?.reason, "content_filter");
  assert.equal(claudeFailure([flagged, { type: "system" }, { type: "assistant", message: { content: [{ type: "text", text: "continuing" }] } }]), undefined);

  const transcript = join(dir, "claude.jsonl");
  await writeFile(transcript, lines({ type: "user", message: { content: "go" } }, limit));
  const idle = await claude.status(record({ state: "idle", transcript, turn: "p1" }));
  assert.equal(idle.state, "stalled");
  assert.equal(idle.stall, "usage_limit");
  assert.equal(idle.detail, "usage limit: You've hit your 5-hour limit · resets 6:20am");
  assert.equal((await claude.status(record({ state: "working", transcript, turn: "p1" }))).state, "working", "a fresh error while working: Claude may still go on");
  await writeFile(transcript, lines({ ...limit, timestamp: new Date(Date.now() - 60_000).toISOString() }));
  assert.equal((await claude.status(record({ state: "working", transcript, turn: "p1" }))).state, "stalled", "an error that stood for a while");
});

test("a Codex turn that failed is a stall even though no Stop hook fired", async () => {
  const started = { type: "event_msg", payload: { type: "task_started" } };
  const failed = (error: object) => ({ type: "event_msg", timestamp: "2026-11-14T08:21:58.270Z", payload: { type: "task_complete", turn_id: "t1", last_agent_message: null, error } });
  const usage = failed({ message: "You’ve hit your usage limit. Upgrade to Pro or try again at 2:52 AM.", codex_error_info: "usage_limit_exceeded" });
  assert.equal(codexFailure([started, usage])?.reason, "usage_limit");
  const guidance = { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "<content_filter_guidance>\nYour previous response was blocked" }] } };
  assert.equal(codexFailure([started, { type: "response_item", payload: { role: "assistant", content: [{ text: "I'm sorry" }] } }, guidance, failed({ message: "stream disconnected", codex_error_info: "other" })])?.reason, "content_filter");
  assert.equal(codexFailure([started, failed({ message: "Selected model is at capacity.", codex_error_info: "server_overloaded" })])?.reason, "error");
  assert.equal(codexFailure([started, usage, started]), undefined, "a later task started: the failure belongs to an older one");
  assert.equal(codexTurnEnded([started, { type: "event_msg", payload: { type: "task_complete" } }, started]), false);

  const transcript = join(dir, "codex.jsonl");
  await writeFile(transcript, lines(started, usage));
  const view = await codex.status(record({ kind: "codex", state: "working", transcript, turn: "t1" }));
  assert.equal(view.state, "stalled");
  assert.match(view.detail, /^usage limit: You’ve hit your usage limit/);
  await writeFile(transcript, lines(started, { type: "event_msg", payload: { type: "task_complete", last_agent_message: "done" } }));
  assert.equal((await codex.status(record({ kind: "codex", state: "working", transcript }))).state, "idle", "a missed Stop hook");
});

test("opencode 2: a turn retrying its way nowhere or ended on an error is a stall; an interrupt is not", () => {
  const retry = (attempt: number, type: string) => ({ id: "m1", retry: { attempt, error: { type, message: "429 Too Many Requests" } } });
  assert.equal(opencodeStall(retry(1, "provider.rate-limit"), true), undefined, "a first retry is normal");
  assert.equal(opencodeStall(retry(3, "provider.rate-limit"), true)?.stall, "usage_limit");
  assert.equal(opencodeStall(retry(1, "provider.quota"), true)?.stall, "usage_limit", "out of quota: no point waiting");
  assert.equal(opencodeStall(retry(5, "provider.transport"), true)?.stallId, "m1:retry", "the same stall across attempts");
  assert.equal(opencodeStall({ id: "m2", error: { type: "provider.content-filter", message: "blocked" } }, false)?.stall, "content_filter");
  assert.equal(opencodeStall({ id: "m3", error: { type: "session.aborted", message: "aborted" } }, false), undefined);
});

test("a working turn with no output for too long is reported as stalled", () => {
  const now = Date.now();
  assert.equal(noOutputStall({ state: "working", detail: "", activity: now - 5 * 60_000 }, now, 15 * 60_000).state, "working");
  const stalled = noOutputStall({ state: "working", detail: "", activity: now - 16 * 60_000 }, now, 15 * 60_000);
  assert.deepEqual([stalled.state, stalled.stall, stalled.detail], ["stalled", "no_output", "no output for 16m"]);
  assert.equal(noOutputStall({ state: "working", detail: "" }, now, 1).state, "working", "a driver that cannot tell is never flagged");
});

test("opencode confirms a model variant by reading the session back", async () => {
  let variant = "max";
  const server = createServer((req, res) => {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ data: { id: "ses_1", model: { providerID: "deepseek", id: "deepseek-flash", variant } } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    const rec = record({ kind: "opencode", name: "ds", url, auth: "pw", session: "ses_1" });
    assert.match((await opencode.confirmLaunch!(rec, { cwd: "/", args: [], model: "deepseek/deepseek-flash#max" }))!, /ds runs deepseek\/deepseek-flash#max: confirmed on opencode session ses_1/);
    assert.equal(await opencode.confirmLaunch!(rec, { cwd: "/", args: [], model: "deepseek/deepseek-flash" }), undefined, "nothing to confirm without a variant");
    variant = "high";
    await assert.rejects(opencode.confirmLaunch!(rec, { cwd: "/", args: [], model: "deepseek/deepseek-flash#max" }), /runs deepseek\/deepseek-flash#high, not deepseek\/deepseek-flash#max/);
  } finally {
    server.close();
  }
});

test("am wait reports a stall once, then waits for something new", async () => {
  const transcript = join(dir, "wait.jsonl");
  await writeFile(transcript, lines({ type: "event_msg", payload: { type: "task_started" } }, { type: "event_msg", timestamp: "2026-11-14T08:21:58Z", payload: { type: "task_complete", turn_id: "t1", error: { message: "You’ve hit your usage limit.", codex_error_info: "usage_limit_exceeded" } } }));
  const pane = await tmux.newWindow("base", "sh");
  await tmux.setPaneOptions(pane, { "@am_name": "stuck", "@am_kind": "codex", "@am_state": "working", "@am_transcript": transcript, "@am_turn": "t1", "@am_started": "1" });
  const first = await waitAgent(tmux, "stuck", undefined, 5000);
  assert.deepEqual([first.state, first.stall], ["stalled", "usage_limit"]);
  await assert.rejects(waitAgent(tmux, "stuck", undefined, 1500), /timed out/, "the same stall is not reported again");
  // A new turn that fails again is news.
  await writeRecord(tmux, pane, { turn: "t2" });
  assert.equal((await waitAgent(tmux, "stuck", undefined, 5000)).state, "stalled");
  assert.equal((await findRecord(tmux, pane)).stallSeen, "t2:t1");
});

/** A stand-in for Claude Code: reports SessionStart through the pane, records its argv, and acknowledges every line typed into it. */
async function fakeClaude(): Promise<string> {
  const path = join(dir, "fake-claude");
  await writeFile(
    path,
    `#!/bin/sh
printf '%s\\n' "$@" > "$AM_FAKE_ARGS"
tmux set-option -p -t "$TMUX_PANE" @am_session "\${AM_FAKE_SESSION:-sess-1}" \\; set-option -p -t "$TMUX_PANE" @am_event SessionStart \\; set-option -p -t "$TMUX_PANE" @am_state idle
while IFS= read -r line; do
  printf '%s\\n' "$line" >> "$AM_FAKE_INPUT"
  tmux set-option -p -F -t "$TMUX_PANE" @am_seq '#{e|+:#{@am_seq},1}' \\; set-option -p -t "$TMUX_PANE" @am_state idle
done
`,
  );
  await chmod(path, 0o755);
  return path;
}

test("am remembers a worker: its contract, conversation and launch options survive a stop and come back with am resume", async () => {
  const bin = await fakeClaude();
  const work = join(dir, "work");
  const contract = join(dir, "contract.md");
  const argsFile = join(dir, "args.txt");
  const input = join(dir, "input.txt");
  await mkdir(work, { recursive: true });
  await writeFile(contract, "- 不推送\n- 不打印密钥\n");
  const env = { AM_FAKE_ARGS: argsFile, AM_FAKE_INPUT: input };

  const started = await startAgent(tmux, { name: "w1", kind: "claude", bin, cwd: work, env, args: ["--permission-mode", "bypassPermissions"], contract, profile: "claude", timeoutMs: 10_000 });
  assert.equal(started.session, "sess-1");
  assert.equal(started.contract, contract);
  const saved = (await readSaved("w1"))!;
  assert.deepEqual([saved.kind, saved.bin, saved.cwd, saved.session, saved.profile, saved.args], ["claude", bin, work, "sess-1", "claude", ["--permission-mode", "bypassPermissions"]]);
  assert.deepEqual(saved.env, env);

  await promptAgent(tmux, "w1", "task one");
  await promptAgent(tmux, "w1", "task two");
  const typed = await readFile(input, "utf8");
  assert.match(typed, /task one\n\n---\nWorker contract \(.*contract\.md\)\. It applies/);
  assert.match(typed, /- 不推送\n- 不打印密钥/);
  assert.match(typed, /task two\n\n\(The worker contract in .*contract\.md still applies\.\)/);
  const sentHash = (await readSaved("w1"))!.contractSent;
  assert.ok(sentHash);

  await assert.rejects(resumeAgent(tmux, "w1"), /w1 is running/);
  await stopAgent(tmux, "w1");
  assert.equal((await savedAgents(tmux)).find((a) => a.name === "w1")?.status, "stopped");

  await writeFile(input, "");
  const resumed = await resumeAgent(tmux, "w1", { timeoutMs: 10_000 });
  assert.equal(resumed.session, "sess-1");
  const argv = (await readFile(argsFile, "utf8")).trim().split("\n");
  assert.deepEqual(argv.slice(argv.indexOf("--resume")), ["--resume", "sess-1", "--permission-mode", "bypassPermissions"]);
  assert.equal((await findRecord(tmux, "w1")).contractSent, sentHash, "the resumed conversation already has the contract");
  await promptAgent(tmux, "w1", "task three");
  assert.doesNotMatch(await readFile(input, "utf8"), /不推送/);

  await stopAgent(tmux, "w1");
  await forgetAgent("w1");
  assert.equal(await readSaved("w1"), undefined);
  await assert.rejects(resumeAgent(tmux, "w1"), /no record of w1/);
});

test("saved agents tell a stop, an exit and a lost tmux server apart", () => {
  const agent = { name: "a", server: "/tmp/s:1:100" } as SavedAgent;
  const live = [record({ name: "a" })];
  assert.equal(savedStatus(agent, live, "/tmp/s:1:100"), "running");
  assert.equal(savedStatus({ ...agent, stoppedAt: 1 }, [], "/tmp/s:1:100"), "stopped");
  assert.equal(savedStatus(agent, [], "/tmp/s:1:100"), "exited", "same server, pane gone: it exited by itself");
  assert.equal(savedStatus(agent, [], "/tmp/s:7:900"), "lost", "a new tmux server: the machine or tmux restarted");
  assert.equal(savedStatus(agent, [], undefined), "lost");
  assert.equal(savedStatus({ ...agent, exitedAt: 1 }, [], undefined), "exited", "an exit seen before the restart stays an exit");
});

test("am start --conversation continues an existing conversation instead of starting a new one", async () => {
  const fake = await fakeClaude();
  const argsFile = join(dir, "conversation-args.txt");
  const am = resolve(import.meta.dirname, "../bin/am");
  const socket = await tmux.socketPath();
  const { stdout } = await promisify(execFile)(
    am,
    ["start", "conv1", "--kind", "claude", "--bin", fake, "--cwd", dir, "--conversation", "sess-7", "--timeout", "10000",
      "--env", `AM_FAKE_ARGS=${argsFile}`, "--env", `AM_FAKE_INPUT=${join(dir, "conversation-input.txt")}`, "--env", "AM_FAKE_SESSION=sess-7", "--", "--permission-mode", "plan"],
    { env: { ...process.env, TMUX: `${socket},0,0` } },
  );
  assert.match(stdout, /^conv1 is ready \(claude, on conversation sess-7, tmux session am-conv1/);
  const argv = (await readFile(argsFile, "utf8")).trim().split("\n");
  assert.deepEqual(argv.slice(argv.indexOf("--resume")), ["--resume", "sess-7", "--permission-mode", "plan"]);
  assert.equal((await readSaved("conv1"))?.session, "sess-7");
  await stopAgent(tmux, "conv1");
});
