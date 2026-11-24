// Prompts queued for a busy agent. Real tmux on an isolated server; the "agent" is a shell script.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { after, before, test } from "node:test";

import { Tmux } from "@agent-master/tmux";

import { forgetAgent, getAgent, queuePrompt, resumeAgent, startAgent, stopAgent, waitAgent } from "../src/agent.ts";
import { deliverQueue } from "../src/deliver.ts";
import { addPrompt, claimPrompt, clearQueue, listQueued, lockDeliverer, pendingPrompts, queueDir, settlePrompt, unlockDeliverer } from "../src/queue.ts";
import { findRecord } from "../src/registry.ts";

const am = resolve(import.meta.dirname, "../bin/am");
const tmux = new Tmux({ socketName: `am-queue-test-${process.pid}` });
let dir = "";
let bin = "";

before(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "am-queue-")));
  process.env.AM_STATE_DIR = join(dir, "state");
  process.env.XDG_CACHE_HOME = join(dir, "cache");
  // Deliverers are run in-process here, except where a test runs the command itself.
  process.env.AM_BIN = "/usr/bin/true";
  delete process.env.AM_CONTRACT;
  await tmux.newSession("base", { command: "sh" });
  // Works on every line typed into it until the test says its turn ended; with $AM_FAKE_DIALOG it first waits for a key.
  bin = join(dir, "fake-claude");
  await writeFile(
    bin,
    `#!/bin/sh
[ -z "$AM_FAKE_DIALOG" ] || IFS= read -r answer
tmux set-option -p -t "$TMUX_PANE" @am_session sess-1 \\; set-option -p -t "$TMUX_PANE" @am_event SessionStart \\; set-option -p -t "$TMUX_PANE" @am_state idle
while IFS= read -r line; do
  printf '%s\\n' "$line" >> "$AM_FAKE_INPUT"
  tmux set-option -p -F -t "$TMUX_PANE" @am_seq '#{e|+:#{@am_seq},1}' \\; set-option -p -t "$TMUX_PANE" @am_state working
done
`,
  );
  await chmod(bin, 0o755);
});
after(() => tmux.killServer());

async function worker(name: string, env: Record<string, string> = {}, timeoutMs = 10_000) {
  const input = join(dir, `${name}.txt`);
  await writeFile(input, "");
  const started = startAgent(tmux, { name, kind: "claude", bin, cwd: dir, env: { AM_FAKE_INPUT: input, ...env }, timeoutMs });
  const typed = async () => (await readFile(input, "utf8")).split("\n").filter(Boolean);
  /** Ends the turn the latest prompt started. (The agent notes a line a moment before it says it is working.) */
  const endTurn = async () => {
    await until(`${name} working`, async () => (await findRecord(tmux, name)).state === "working");
    await tmux.setPaneOptions((await findRecord(tmux, name)).paneId, { "@am_state": "idle" });
  };
  return { started, typed, endTurn };
}

async function until<T>(what: string, probe: () => Promise<T | undefined | false>, ms = 10_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out: ${what}`);
    await sleep(50);
  }
}

const quick = { holdMs: 700, intervalMs: 50 };

test("prompts queued for a busy agent go out in order as it becomes idle; waits begun before are not kept waiting", async () => {
  const { started, typed, endTurn } = await worker("q1");
  await started;
  assert.equal((await queuePrompt(tmux, "q1", "first")).queued, undefined, "idle: sent at once");
  assert.deepEqual(await typed(), ["first"]);

  const earlier = waitAgent(tmux, "q1", undefined, 10_000);
  await sleep(400);
  assert.equal((await queuePrompt(tmux, "q1", "second")).ahead, 0);
  const third = await queuePrompt(tmux, "q1", "third", ["ledger", "update", "3"]);
  assert.deepEqual([third.ahead, third.agent.queued, third.agent.detail], [1, 2, "2 queued prompts"]);
  const [file] = await listQueued("q1");
  assert.equal((await stat(join(queueDir("q1"), `${file.id}.json`))).mode & 0o777, 0o600);

  const ran: string[][] = [];
  const delivering = deliverQueue(tmux, "q1", { ...quick, runAfter: (args) => ran.push(args) });
  const later = waitAgent(tmux, "q1", undefined, 20_000);
  await sleep(1000);
  assert.deepEqual(await typed(), ["first"], "still working");

  await endTurn();
  assert.equal((await earlier).state, "idle", "it returns on the turn it was waiting for");
  assert.deepEqual(await typed(), ["first"], "before the next prompt hides that turn's reply");
  await until("second", async () => (await typed()).length === 2);
  assert.deepEqual(ran, []);
  await endTurn();
  await until("third", async () => (await typed()).length === 3);
  await delivering;
  assert.deepEqual(await typed(), ["first", "second", "third"]);
  assert.deepEqual(ran, [["ledger", "update", "3"]]);
  assert.deepEqual(await listQueued("q1"), []);

  assert.equal(await Promise.race([later.then(() => "done"), sleep(800, "waiting")]), "waiting", "the last one is still being worked on");
  await endTurn();
  assert.equal((await later).state, "idle");
  await stopAgent(tmux, "q1");
});

test("a prompt queued for an agent held at a dialog on its first start is sent once the dialog is answered", async () => {
  const { started, typed } = await worker("q2", { AM_FAKE_DIALOG: "1" }, 1200);
  await assert.rejects(started, (error: { code?: string }) => error.code === "start_timeout");
  const { queued, agent } = await queuePrompt(tmux, "q2", "task");
  assert.ok(queued);
  assert.equal(agent.state, "starting");
  const delivering = deliverQueue(tmux, "q2", quick);
  await sleep(1200);
  assert.deepEqual(await typed(), [], "nothing is typed into the dialog");
  await tmux.sendKeys((await findRecord(tmux, "q2")).paneId, "Enter");
  await delivering;
  assert.deepEqual(await typed(), ["task"]);
  await stopAgent(tmux, "q2");
});

test("a prompt that is not confirmed is kept, never sent again, and what is behind it is held back", async () => {
  const pane = await tmux.newWindow("base", "cat > /dev/null");
  await tmux.setPaneOptions(pane, { "@am_name": "q3", "@am_kind": "claude", "@am_state": "idle", "@am_started": "7" });
  const record = await findRecord(tmux, pane);
  await addPrompt(record, "lost");
  await addPrompt(record, "behind");
  await deliverQueue(tmux, "q3", quick);
  const kept = await listQueued("q3");
  assert.deepEqual(kept.map((p) => p.text), ["lost", "behind"]);
  assert.match(kept[0].failed!, /did not confirm receiving the prompt/);
  assert.match(kept[1].failed!, /held back/);
  assert.deepEqual(await pendingPrompts(record), []);
  const view = await waitAgent(tmux, "q3", undefined, 3000);
  assert.deepEqual([view.state, view.detail], ["idle", "2 queued prompts not delivered (am queue q3)"], "a wait does not hang on it");
  assert.equal(await clearQueue("q3"), 2);
  assert.equal((await getAgent(tmux, "q3")).detail, "");
});

test("one prompt has one taker, one deliverer runs at a time, and a dead one is taken over", async () => {
  const record = { name: "q4", startedAt: 1 };
  const prompt = await addPrompt(record, "x");
  assert.deepEqual([await claimPrompt("q4", prompt.id), await claimPrompt("q4", prompt.id)], [true, false]);
  assert.equal((await pendingPrompts(record)).length, 1, "being sent: still to come");
  await settlePrompt("q4", prompt, "back");
  assert.equal(await claimPrompt("q4", prompt.id), true);
  // The deliverer died mid-send: it may have arrived, so it is not sent again.
  const { rename } = await import("node:fs/promises");
  await rename(join(queueDir("q4"), `${prompt.id}.sending.${process.pid}`), join(queueDir("q4"), `${prompt.id}.sending.999999`));
  assert.match((await listQueued("q4"))[0].failed!, /may or may not have arrived/);
  assert.equal(await clearQueue("q4"), 1);

  assert.equal(await lockDeliverer("q4"), true);
  assert.equal(await lockDeliverer("q4"), false);
  await unlockDeliverer("q4");
  await writeFile(join(queueDir("q4"), ".deliverer"), "999999");
  assert.equal(await lockDeliverer("q4"), true);
  await unlockDeliverer("q4");
});

test("a queue belongs to one launch: am resume takes it along, a new agent of that name does not get it", async () => {
  const { started, typed } = await worker("q5");
  await started;
  await queuePrompt(tmux, "q5", "busy now");
  await queuePrompt(tmux, "q5", "for later");
  await stopAgent(tmux, "q5");
  await resumeAgent(tmux, "q5", { timeoutMs: 10_000 });
  assert.equal((await getAgent(tmux, "q5")).queued, 1);
  await deliverQueue(tmux, "q5", quick);
  assert.deepEqual(await typed(), ["busy now", "for later"]);

  await queuePrompt(tmux, "q5", "never taken");
  await stopAgent(tmux, "q5");
  const again = await worker("q5");
  await again.started;
  assert.equal((await getAgent(tmux, "q5")).queued, undefined);
  await deliverQueue(tmux, "q5", quick);
  assert.deepEqual(await again.typed(), []);
  assert.equal((await listQueued("q5")).length, 1);
  await stopAgent(tmux, "q5");
  await forgetAgent("q5");
  assert.deepEqual(await listQueued("q5"), []);
});

test("am prompt --queue hands the prompt to a deliverer of its own", async () => {
  const { started, typed, endTurn } = await worker("q6");
  await started;
  const env = { ...process.env, TMUX: `${await tmux.socketPath()},0,0`, AM_BIN: am };
  const run = (...args: string[]) => promisify(execFile)(am, args, { env });
  assert.equal((await run("prompt", "q6", "one")).stdout, "sent to q6\n");
  await assert.rejects(run("prompt", "q6", "two"), /still working/, "without --queue it is refused, as before");
  await assert.rejects(run("prompt", "q6", "two", "--after", "[]"), /--after goes with --queue/);
  await assert.rejects(run("prompt", "q6", "two", "--queue", "--after", "ledger"), /JSON array of strings/);
  const queued = await run("prompt", "q6", "two 第二件", "--queue", "--after", JSON.stringify(["keys", "q6", "C-l"]));
  assert.equal(queued.stdout, "queued for q6 (working): it is sent once q6 is idle\n");
  assert.match((await run("queue", "q6")).stdout, /^STATUS\s+AGE\s+PROMPT\s+WHY\nwaiting\s+\d+s\s+two 第二件\n$/);
  assert.match((await run("list")).stdout, /q6\s+claude\s+working\s+am-q6\s+\d+s\s+1 queued prompt/);
  await endTurn();
  await until("delivery", async () => (await typed()).includes("two 第二件"), 20_000);
  await until("an empty queue", async () => (await run("queue", "q6")).stdout === "nothing queued for q6\n");
  await stopAgent(tmux, "q6");
});
