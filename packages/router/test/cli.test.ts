import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const bin = resolve(import.meta.dirname, "../bin/am-router");

/**
 * A stand-in for am that logs its arguments; `status` reports $AM_STATE when set, or no such agent;
 * `ledger list` prints $AM_LEDGER_LIST (default: an empty ledger); `ledger import` fails when $AM_IMPORT_FAIL is set;
 * `list --saved` prints $AM_SAVED; a prompt's text is kept in $AM_LOG.prompt; `start` fails with code $AM_START_FAIL when
 * it is set, and `ledger add` when $AM_ADD_FAIL is; `start`
 * logs its $AM_CONTRACT to $AM_LOG.env; `prompt` fails when $AM_PROMPT_FAIL is set.
 */
async function fakeAm(dir: string): Promise<string> {
  const path = join(dir, "am");
  await writeFile(
    path,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$AM_LOG"
if [ "$1" = status ]; then
  [ -n "$AM_STATE" ] || { echo '{"error":"not_found"}' >&2; exit 1; }
  echo "{\\"state\\":\\"$AM_STATE\\",\\"session\\":\\"$AM_SESSION\\"}"
fi
if [ "$1 $2" = "list --saved" ]; then echo "\${AM_SAVED:-[]}"; fi
if [ "$1" = start ]; then
  printf 'AM_CONTRACT=%s\\n' "$AM_CONTRACT" >> "$AM_LOG.env"
  [ -z "$AM_START_FAIL" ] || { echo 'am: warning: Claude has not trusted it yet' >&2; echo "{\\"error\\":\\"$AM_START_FAIL\\",\\"message\\":\\"claude did not finish starting\\"}" >&2; exit 1; }
fi
if [ "$1" = prompt ]; then
  cat > "$AM_LOG.prompt"
  [ -z "$AM_PROMPT_OUT" ] || echo "$AM_PROMPT_OUT"
  [ -z "$AM_PROMPT_FAIL" ] || { echo "it did not confirm receiving the prompt" >&2; exit 1; }
fi
if [ "$1 $2" = "ledger list" ]; then echo "\${AM_LEDGER_LIST:-[]}"; fi
if [ "$1 $2" = "ledger add" ]; then
  [ -z "$AM_ADD_FAIL" ] || { echo "the ledger is locked" >&2; exit 1; }
  case "$*" in *--json*) echo '{"id":7}' ;; esac
fi
if [ "$1 $2" = "ledger import" ]; then
  [ -z "$AM_IMPORT_FAIL" ] || { echo "cannot read it" >&2; exit 1; }
  echo "imported 1 task(s)"
fi
`,
  );
  await chmod(path, 0o755);
  return path;
}

async function setup() {
  // Real path: the router records its cwd, and macOS's /var is /private/var.
  const dir = await realpath(await mkdtemp(join(tmpdir(), "am-router-test-")));
  const log = join(dir, "log");
  await writeFile(log, "");
  // XDG_CONFIG_HOME: never pick up the user's own worker contract.
  const env = { ...process.env, AM_BIN: await fakeAm(dir), AM_LOG: log, XDG_STATE_HOME: join(dir, "state"), XDG_CONFIG_HOME: join(dir, "config"), AM_STATE: "", AM_CONTRACT: "", AM_START_FAIL: "", AM_PROMPT_FAIL: "" };
  const run = (args: string[], extra: Record<string, string> = {}, input = "") =>
    new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
      const child = execFile(bin, args, { cwd: dir, env: { ...env, ...extra } }, (error, stdout, stderr) => done({ code: error ? Number(error.code) : 0, stdout, stderr }));
      child.stdin!.end(input);
    });
  const calls = async () => (await readFile(log, "utf8")).split("\n").filter(Boolean);
  return { dir, run, calls, home: (name: string) => join(dir, "state", "agent-master", "router", name), contract: join(dir, "config", "agent-master", "worker-contract.md") };
}

test("start writes the router's home and starts it there through am", async () => {
  const { dir, run, calls, home } = await setup();
  const { code, stdout } = await run(["start"]);
  assert.equal(code, 0);
  assert.deepEqual(await calls(), [
    "status router --json",
    `start router --kind claude --cwd ${home("router")} --env AM_ROUTER=router -- --dangerously-skip-permissions`,
    "ledger list --router router --json",
  ]);
  const instructions = await readFile(join(home("router"), "AGENTS.md"), "utf8");
  assert.match(instructions, new RegExp(`Default project: \`${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\``));
  assert.match(stdout, /talk to it with: am open router/);
});

test("start passes the name, kind, model and the agent's own arguments on", async () => {
  const { dir, run, calls, home } = await setup();
  const { code } = await run(["start", "ops", "--kind", "codex", "--model", "gpt-x", "--project", dir, "--worker-kind", "dsh", "--", "--foo", "bar"]);
  assert.equal(code, 0);
  assert.equal((await calls())[1], `start ops --kind codex --cwd ${home("ops")} --model gpt-x --env AM_ROUTER=ops -- --foo bar`);
  assert.match(await readFile(join(home("ops"), "CLAUDE.md"), "utf8"), /Default worker kind: `dsh`/);
});

test("a Claude router skips permission prompts unless its own arguments choose a mode", async () => {
  const { run, calls, home } = await setup();
  assert.equal((await run(["start", "a", "--", "--resume", "x"])).code, 0);
  assert.equal((await run(["start", "b", "--", "--permission-mode", "plan"])).code, 0);
  const starts = (await calls()).filter((call) => call.startsWith("start "));
  assert.deepEqual(starts, [
    `start a --kind claude --cwd ${home("a")} --env AM_ROUTER=a -- --dangerously-skip-permissions --resume x`,
    `start b --kind claude --cwd ${home("b")} --env AM_ROUTER=b -- --permission-mode plan`,
  ]);
});

test("the user's worker contract reaches the router's workers, not the router", async () => {
  const { run, calls, home, contract, dir } = await setup();
  const none = await run(["start", "a"]);
  assert.match(none.stdout, /no worker contract/);
  await mkdir(join(dir, "config", "agent-master"), { recursive: true });
  await writeFile(contract, "- never push\n");
  assert.equal((await run(["start", "b"], { AM_CONTRACT: "/somewhere/else.md" })).code, 0);
  const starts = (await calls()).filter((call) => call.startsWith("start "));
  assert.deepEqual(starts, [
    `start a --kind claude --cwd ${home("a")} --env AM_ROUTER=a -- --dangerously-skip-permissions`,
    `start b --kind claude --cwd ${home("b")} --env AM_ROUTER=b --env AM_CONTRACT=${contract} -- --dangerously-skip-permissions`,
  ]);
  assert.match(await readFile(join(home("b"), "CLAUDE.md"), "utf8"), new RegExp(`worker contract travels by itself\\*\\* \\(\`${contract.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\``));
  assert.equal((await run(["start", "c", "--contract", join(dir, "missing.md")])).code, 2);
});

test("an old LEDGER.md moves into am ledger once; a router whose ledger holds work is asked to take it over", async () => {
  const { run, calls, home } = await setup();
  assert.equal((await run(["start"])).code, 0);
  const ledger = join(home("router"), "LEDGER.md");
  assert.ok(!existsSync(ledger), "no markdown ledger any more");
  assert.ok(!(await calls()).some((call) => call.startsWith("prompt ")), "nothing to take over yet");

  // An older router left its markdown ledger behind; the restart stops it first, so the file is final.
  await writeFile(ledger, "# Ledger\n\n## In progress\n\n### 修登录\n- Worker: fix-login (claude, conversation s1) in /w\n\n## Queued\n");
  const { code, stdout } = await run(["restart"], { AM_STATE: "idle", AM_LEDGER_LIST: '[{"id":1}]' });
  assert.equal(code, 0);
  assert.deepEqual((await calls()).slice(-6), [
    "status router --json",
    "stop router",
    `ledger import ${ledger} --router router`,
    `start router --kind claude --cwd ${home("router")} --env AM_ROUTER=router -- --dangerously-skip-permissions`,
    "ledger list --router router --json",
    "prompt router -",
  ]);
  assert.ok(!existsSync(ledger), "moved aside, never imported twice");
  assert.ok((await readdir(home("router"))).some((f) => f.startsWith("LEDGER.md.imported-")));
  assert.match(stdout, /imported 1 task\(s\)[\s\S]*taking over the work in its ledger/);

  // A ledger that cannot be imported stops the start, and the file stays.
  await writeFile(ledger, "# Ledger\n");
  const failed = await run(["start", "--", "--effort", "low"], { AM_IMPORT_FAIL: "1" });
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /could not move .*LEDGER\.md into the ledger, so router was not started: cannot read it/);
  assert.ok(existsSync(ledger));
  assert.ok(!(await calls()).at(-1)!.startsWith("start "));
});

test("--resume continues the router's conversation; without it a restart starts a new one", async () => {
  const { dir, run, calls, home } = await setup();
  const starts = async () => (await calls()).filter((call) => call.startsWith("start "));
  const base = `start router --kind claude --cwd ${home("router")} --env AM_ROUTER=router`;
  assert.equal((await run(["start"])).code, 0);

  // restart --resume: the conversation the running router has now (after a /resume inside it, too).
  const kept = await run(["restart", "--resume"], { AM_STATE: "idle", AM_SESSION: "conv-now", AM_LEDGER_LIST: '[{"id":1}]' });
  assert.equal(kept.code, 0, kept.stderr);
  assert.equal((await starts()).at(-1), `${base} --conversation conv-now -- --dangerously-skip-permissions`);
  assert.match(kept.stdout, /it continues conversation conv-now/);
  assert.match(await readFile(join(dir, "log.prompt"), "utf8"), /^You were restarted on this same conversation\. Your background am waits ended with the old process[\s\S]*Take over: your ledger lists work in flight/);

  // A plain restart after it: a new conversation, and the plain takeover message.
  assert.equal((await run(["restart"], { AM_STATE: "idle", AM_SESSION: "conv-now", AM_LEDGER_LIST: '[{"id":1}]' })).code, 0);
  assert.equal((await starts()).at(-1), `${base} -- --dangerously-skip-permissions`, "--resume is never remembered");
  assert.equal(await readFile(join(dir, "log.prompt"), "utf8"), "Take over: your ledger lists work in flight (am ledger show).");

  // start --resume on a stopped router: the last conversation am remembers for it.
  assert.equal((await run(["start", "--resume"], { AM_SAVED: '[{"name":"other","session":"x"},{"name":"router","session":"conv-saved"}]' })).code, 0);
  assert.equal((await starts()).at(-1), `${base} --conversation conv-saved -- --dangerously-skip-permissions`);
  assert.equal((await run(["start", "--conversation", "conv-picked"])).code, 0);
  assert.equal((await starts()).at(-1), `${base} --conversation conv-picked -- --dangerously-skip-permissions`);
  const none = await run(["start", "ops", "--resume"]);
  assert.equal(none.code, 2);
  assert.match(none.stderr, /am has no conversation recorded for ops; start it without --resume, or name one with --conversation ID/);
});

test("restart starts a fresh session the way the router was first started", async () => {
  const { dir, run, calls, home } = await setup();
  assert.equal((await run(["restart", "ops"])).code, 2, "never started: nothing to repeat");
  assert.equal((await run(["start", "ops", "--model", "haiku", "--worker-kind", "codex", "--project", dir, "--", "--resume", "old", "--effort", "low"])).code, 0);
  assert.equal((await run(["restart", "ops"])).code, 0, "not running: just starts");
  const starts = (await calls()).filter((call) => call.startsWith("start "));
  assert.equal(starts[0], `start ops --kind claude --cwd ${home("ops")} --model haiku --env AM_ROUTER=ops -- --dangerously-skip-permissions --resume old --effort low`);
  assert.equal(starts[1], `start ops --kind claude --cwd ${home("ops")} --model haiku --env AM_ROUTER=ops -- --dangerously-skip-permissions --effort low`, "a fresh session: no --resume");
  assert.match(await readFile(join(home("ops"), "AGENTS.md"), "utf8"), /Default worker kind: `codex`/);
});

test("stop closes a running router through am", async () => {
  const { run, calls } = await setup();
  assert.equal((await run(["start"])).code, 0);
  assert.equal((await run(["stop"], { AM_STATE: "idle" })).code, 0);
  assert.deepEqual((await calls()).slice(-2), ["status router --json", "stop router"]);
  const idle = await run(["stop", "ops"]);
  assert.equal(idle.code, 1);
  assert.match(idle.stderr, /ops is not running/);
});

test("am router ... reaches the router, and am -h documents it with every other command", async () => {
  const am = resolve(import.meta.dirname, "../../agent/bin/am");
  const help = await promisify(execFile)(am, ["-h"]);
  for (const line of ["am start <name>", "am router start [name]", "am router restart [name]", "am router stop [name]", "am router dispatch <worker>", "am ledger show", "am ledger add <title>", "am ledger inbox take <n>", "am watcher start [name]", "am watcher stop [name]"]) {
    assert.ok(help.stdout.includes(line), line);
  }
  const routerHelp = await promisify(execFile)(am, ["router", "help"]);
  assert.match(routerHelp.stdout, /^am router — /);
  await assert.rejects(promisify(execFile)(am, ["router", "nope"]), (error: any) => error.code === 2 && /unknown command: nope/.test(error.stderr));
});

test("dispatch starts a worker, hands it the task and adds the task to the ledger, in one step", async () => {
  const { dir, run, calls } = await setup();
  const result = await run(
    ["dispatch", "fix-login", "-", "--title", "修登录", "--profile", "claude", "--cwd", ".", "--next", "汇报后转告用户", "--", "--foo"],
    { AM_CONTRACT: "/rules/contract.md" },
    "登录页点了没反应，查一下\n",
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await calls(), [
    `start fix-login --profile claude --cwd ${dir} --json -- --foo`,
    "prompt fix-login -",
    "ledger add 修登录 --worker fix-login --waiting the worker --next 汇报后转告用户",
  ]);
  assert.equal(await readFile(join(dir, "log.prompt"), "utf8"), "登录页点了没反应，查一下\n");
  assert.equal(await readFile(join(dir, "log.env"), "utf8"), "AM_CONTRACT=/rules/contract.md\n", "the worker gets the user's contract");

  assert.equal((await run(["dispatch", "w2", "看下", "日志", "--title", "t", "--kind", "codex", "--waiting", "nobody", "--router", "ops"])).code, 0);
  assert.deepEqual((await calls()).slice(3), ["start w2 --kind codex --json", "prompt w2 -", "ledger add t --worker w2 --waiting nobody --router ops"]);
  assert.equal(await readFile(join(dir, "log.prompt"), "utf8"), "看下 日志");
});

test("dispatch: a worker that fails to start leaves the ledger alone; one that does not take the task is still recorded", async () => {
  const { run, calls } = await setup();
  // Such as a name already taken: whatever runs under it must not get the task.
  const failed = await run(["dispatch", "a", "-", "--title", "t", "--profile", "claude"], { AM_START_FAIL: "name_taken", AM_STATE: "starting" }, "task");
  assert.equal(failed.code, 1);
  assert.equal(failed.stderr, "am: warning: Claude has not trusted it yet\nam: claude did not finish starting\n");
  assert.deepEqual(await calls(), ["start a --profile claude --json"]);
  // It gave up and is gone.
  assert.equal((await run(["dispatch", "a", "-", "--title", "t", "--profile", "claude"], { AM_START_FAIL: "start_timeout", AM_STATE: "exited" }, "task")).code, 1);
  assert.deepEqual((await calls()).slice(1), ["start a --profile claude --json", "status a --json"]);

  const unconfirmed = await run(["dispatch", "b", "-", "--title", "t", "--profile", "claude"], { AM_PROMPT_FAIL: "1" }, "task");
  assert.equal(unconfirmed.code, 1);
  assert.deepEqual((await calls()).slice(3), [
    "start b --profile claude --json",
    "prompt b -",
    "ledger add t --worker b --waiting the user: b started but did not confirm the task (see am status b); it was not resent",
  ]);
});

test("dispatch: a worker held at a dialog on its first start gets the task once the user answered it, and the ledger has it at once", async () => {
  const { dir, run, calls } = await setup();
  const held = await run(["dispatch", "c", "-", "--title", "t", "--profile", "claude", "--next", "n", "--router", "ops"], { AM_START_FAIL: "start_timeout", AM_STATE: "starting" }, "task\n");
  assert.equal(held.code, 0, held.stderr);
  const waiting = "the user: c is held at a dialog on its first start (trusting the folder, or logging in): answer it in am open c; the task is then sent by itself";
  assert.deepEqual(await calls(), [
    "start c --profile claude --json",
    "status c --json",
    `ledger add t --worker c --waiting ${waiting} --next n --router ops --json`,
    'prompt c - --queue --after ["ledger","update","7","--waiting","the worker"] --json',
  ]);
  assert.equal(await readFile(join(dir, "log.prompt"), "utf8"), "task\n");
  assert.match(held.stdout, /^c is held at a dialog .*am open c\.\nThe task is queued \(task #7\) and sent once they have\.\n$/);

  // Without a ledger record the task is still queued, and that is said.
  const unrecorded = await run(["dispatch", "d", "-", "--title", "t", "--profile", "claude"], { AM_START_FAIL: "start_timeout", AM_STATE: "starting", AM_ADD_FAIL: "1" }, "task");
  assert.equal(unrecorded.code, 1);
  assert.equal((await calls()).at(-1), "prompt d - --queue --json");
  assert.match(unrecorded.stderr, /the ledger is locked/);
  assert.match(unrecorded.stdout, /ledger has no record of it/);

  // Not a dialog after all: it got through meanwhile and took the task at once.
  const slow = await run(["dispatch", "f", "-", "--title", "t", "--profile", "claude"], { AM_START_FAIL: "start_timeout", AM_STATE: "idle", AM_PROMPT_OUT: '{"queuedId":null}' }, "task");
  assert.deepEqual([slow.code, slow.stdout], [0, "f was slow to start; it has the task (task #7)\n"]);

  // It could not be queued: the ledger says so.
  const unqueued = await run(["dispatch", "e", "-", "--title", "t", "--profile", "claude"], { AM_START_FAIL: "start_timeout", AM_STATE: "starting", AM_PROMPT_FAIL: "1" }, "task");
  assert.equal(unqueued.code, 1);
  assert.match((await calls()).at(-1)!, /^ledger update 7 --waiting the user: e is held at a dialog, and the task could not be queued/);
});

test("dispatch refuses an incomplete request before touching am", async () => {
  const { run, calls } = await setup();
  for (const args of [
    ["dispatch"],
    ["dispatch", "w", "x", "--profile", "claude"],
    ["dispatch", "w", "x", "--title", "t"],
    ["dispatch", "w", "-", "--title", "t", "--profile", "claude"],
  ]) {
    assert.equal((await run(args, {}, "  \n")).code, 2, args.join(" "));
  }
  assert.deepEqual(await calls(), []);
});

test("start leaves a running router alone", async () => {
  const { run, calls } = await setup();
  const { code, stderr } = await run(["start"], { AM_STATE: "working" });
  assert.equal(code, 1);
  assert.match(stderr, /router is already running \(working\)/);
  assert.deepEqual(await calls(), ["status router --json"]);
});

test("start refuses bad arguments before touching am", async () => {
  const { run, calls } = await setup();
  assert.equal((await run(["start", "a", "b"])).code, 2);
  assert.equal((await run(["start", "--project", "/no/such/dir"])).code, 2);
  assert.equal((await run(["start", "--nope"])).code, 2);
  assert.deepEqual(await calls(), []);
});

test("a missing am is reported as such", async () => {
  const { run } = await setup();
  const { code, stderr } = await run(["start"], { AM_BIN: "/no/such/am" });
  assert.equal(code, 1);
  assert.match(stderr, /am not found on PATH/);
});
