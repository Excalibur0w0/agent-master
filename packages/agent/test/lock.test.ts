import assert from "node:assert/strict";
import { after, test } from "node:test";

import { Tmux } from "@agent-master/tmux";

import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { acquireSendLock, gatedCommand, releaseSendLock, whileLocked } from "../src/agent.ts";

const tmux = new Tmux({ socketName: `am-lock-test-${process.pid}` });
after(() => tmux.killServer());

test("only one am prompt at a time can type into an agent", async () => {
  const pane = await tmux.newSession("lock", { command: "sh" });

  const results = await Promise.allSettled([acquireSendLock(tmux, pane, "a"), acquireSendLock(tmux, pane, "a"), acquireSendLock(tmux, pane, "a")]);
  const held = results.filter((r) => r.status === "fulfilled");
  assert.equal(held.length, 1, "exactly one concurrent caller gets the lock");
  assert.ok(results.some((r) => r.status === "rejected" && /另一个 am prompt/.test(String(r.reason))));

  const token = (held[0] as PromiseFulfilledResult<string>).value;
  await releaseSendLock(tmux, pane, "someone-else");
  await assert.rejects(acquireSendLock(tmux, pane, "a"), "a non-holder cannot release it");

  await releaseSendLock(tmux, pane, token);
  const next = await acquireSendLock(tmux, pane, "a");
  await releaseSendLock(tmux, pane, next);
});

test("an abandoned lock expires", async () => {
  const pane = await tmux.newSession("stale", { command: "sh" });
  await tmux.setPaneOptions(pane, { "@am_lock": "crashed-holder", "@am_lock_ts": String(Math.floor(Date.now() / 1000) - 600) });
  const token = await acquireSendLock(tmux, pane, "a");
  assert.notEqual(token, "crashed-holder");
});

test("keystrokes only go out while the lock is held, checked inside tmux", async () => {
  const dir = await mkdtemp(join(tmpdir(), "am-lock-"));
  const pane = await tmux.newSession("send", { cwd: dir, command: ["sh", "-c", "cat > out.txt"] });
  const token = await acquireSendLock(tmux, pane, "a");
  await whileLocked(tmux, pane, token, `send-keys -t ${pane} -l -- "held; \\$HOME"`);
  await assert.rejects(whileLocked(tmux, pane, "not-the-holder", `send-keys -t ${pane} -l -- LEAK`), /失去了发送锁/);
  await tmux.sendKeys(pane, "Enter", "C-d");
  await sleep(300);
  assert.equal(await readFile(join(dir, "out.txt"), "utf8"), "held; $HOME\n");
});

test("a gated agent starts only after am signals, even from a cold tmux server", async () => {
  const cold = new Tmux({ socketName: `am-gate-test-${process.pid}` });
  const dir = await mkdtemp(join(tmpdir(), "am-gate-"));
  try {
    const gate = `gate-${process.pid}`;
    // No server is running yet: creating the pane starts it.
    await cold.newSession("g", { cwd: dir, command: gatedCommand("tmux", gate, ["sh", "-c", "echo ran > ran.txt; sleep 5"]) });
    await sleep(500);
    await assert.rejects(readFile(join(dir, "ran.txt")), "nothing runs before the gate opens");
    await cold.run(["wait-for", "-S", gate]);
    await sleep(500);
    assert.equal(await readFile(join(dir, "ran.txt"), "utf8"), "ran\n");

    // Signalled before the pane even starts waiting: still not lost.
    const early = `early-${process.pid}`;
    await cold.run(["wait-for", "-S", early]);
    await cold.newWindow("g", gatedCommand("tmux", early, ["sh", "-c", "echo early > early.txt; sleep 5"]), { cwd: dir });
    await sleep(800);
    assert.equal(await readFile(join(dir, "early.txt"), "utf8"), "early\n");

    // Never signalled (am died): the pane gives up instead of starting the agent.
    const pane = await cold.newWindow("g", gatedCommand("tmux", `never-${process.pid}`, ["sh", "-c", "echo bad > bad.txt"], 1), { cwd: dir });
    await sleep(2500);
    await assert.rejects(readFile(join(dir, "bad.txt")));
    assert.ok(!(await cold.listPanes("#{pane_id}")).includes(pane), "the pane exited");
  } finally {
    await cold.killServer();
  }
});
