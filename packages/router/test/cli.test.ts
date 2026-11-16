import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

const bin = resolve(import.meta.dirname, "../bin/am-router");

/** A stand-in for am that logs its arguments; `status` reports $AM_STATE when set, or no such agent. */
async function fakeAm(dir: string): Promise<string> {
  const path = join(dir, "am");
  await writeFile(
    path,
    `#!/bin/sh
printf '%s\\n' "$*" >> "$AM_LOG"
if [ "$1" = status ]; then
  [ -n "$AM_STATE" ] || { echo '{"error":"not_found"}' >&2; exit 1; }
  echo "{\\"state\\":\\"$AM_STATE\\"}"
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
  const env = { ...process.env, AM_BIN: await fakeAm(dir), AM_LOG: log, XDG_STATE_HOME: join(dir, "state"), XDG_CONFIG_HOME: join(dir, "config"), AM_STATE: "" };
  const run = (args: string[], extra: Record<string, string> = {}) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((done) =>
      execFile(bin, args, { cwd: dir, env: { ...env, ...extra } }, (error, stdout, stderr) => done({ code: error ? Number(error.code) : 0, stdout, stderr })),
    );
  const calls = async () => (await readFile(log, "utf8")).split("\n").filter(Boolean);
  return { dir, run, calls, home: (name: string) => join(dir, "state", "agent-master", "router", name), contract: join(dir, "config", "agent-master", "worker-contract.md") };
}

test("start writes the router's home and starts it there through am", async () => {
  const { dir, run, calls, home } = await setup();
  const { code, stdout } = await run(["start"]);
  assert.equal(code, 0);
  assert.deepEqual(await calls(), ["status router --json", `start router --kind claude --cwd ${home("router")} -- --dangerously-skip-permissions`]);
  const instructions = await readFile(join(home("router"), "AGENTS.md"), "utf8");
  assert.match(instructions, new RegExp(`Default project: \`${dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\``));
  assert.match(stdout, /talk to it with: am open router/);
});

test("start passes the name, kind, model and the agent's own arguments on", async () => {
  const { dir, run, calls, home } = await setup();
  const { code } = await run(["start", "ops", "--kind", "codex", "--model", "gpt-x", "--project", dir, "--worker-kind", "dsh", "--", "--foo", "bar"]);
  assert.equal(code, 0);
  assert.equal((await calls())[1], `start ops --kind codex --cwd ${home("ops")} --model gpt-x -- --foo bar`);
  assert.match(await readFile(join(home("ops"), "CLAUDE.md"), "utf8"), /Default worker kind: `dsh`/);
});

test("a Claude router skips permission prompts unless its own arguments choose a mode", async () => {
  const { run, calls, home } = await setup();
  assert.equal((await run(["start", "a", "--", "--resume", "x"])).code, 0);
  assert.equal((await run(["start", "b", "--", "--permission-mode", "plan"])).code, 0);
  const starts = (await calls()).filter((call) => call.startsWith("start "));
  assert.deepEqual(starts, [
    `start a --kind claude --cwd ${home("a")} -- --dangerously-skip-permissions --resume x`,
    `start b --kind claude --cwd ${home("b")} -- --permission-mode plan`,
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
    `start a --kind claude --cwd ${home("a")} -- --dangerously-skip-permissions`,
    `start b --kind claude --cwd ${home("b")} --env AM_CONTRACT=${contract} -- --dangerously-skip-permissions`,
  ]);
  assert.match(await readFile(join(home("b"), "CLAUDE.md"), "utf8"), new RegExp(`worker contract travels by itself\\*\\* \\(\`${contract.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\``));
  assert.equal((await run(["start", "c", "--contract", join(dir, "missing.md")])).code, 2);
});

test("the ledger is created once and survives restarts; a new router on a ledger with tasks is asked to take over", async () => {
  const { run, calls, home } = await setup();
  assert.equal((await run(["start"])).code, 0);
  const ledger = join(home("router"), "LEDGER.md");
  assert.match(await readFile(ledger, "utf8"), /## In progress\n\n## Queued/);
  assert.ok(!(await calls()).some((call) => call.startsWith("prompt ")), "nothing to take over yet");

  await writeFile(ledger, "# Ledger\n\n## In progress\n\n### 修登录\n- Worker: fix-login (claude, conversation s1) in /w\n\n## Queued\n");
  const { code, stdout } = await run(["restart"], { AM_STATE: "idle" });
  assert.equal(code, 0);
  assert.match(await readFile(ledger, "utf8"), /### 修登录/, "never overwritten");
  assert.deepEqual((await calls()).slice(-4), ["status router --json", "stop router", `start router --kind claude --cwd ${home("router")} -- --dangerously-skip-permissions`, "prompt router -"]);
  assert.match(stdout, /taking over the tasks/);
});

test("restart starts a fresh session the way the router was first started", async () => {
  const { dir, run, calls, home } = await setup();
  assert.equal((await run(["restart", "ops"])).code, 2, "never started: nothing to repeat");
  assert.equal((await run(["start", "ops", "--model", "haiku", "--worker-kind", "codex", "--project", dir, "--", "--resume", "old", "--effort", "low"])).code, 0);
  assert.equal((await run(["restart", "ops"])).code, 0, "not running: just starts");
  const starts = (await calls()).filter((call) => call.startsWith("start "));
  assert.equal(starts[0], `start ops --kind claude --cwd ${home("ops")} --model haiku -- --dangerously-skip-permissions --resume old --effort low`);
  assert.equal(starts[1], `start ops --kind claude --cwd ${home("ops")} --model haiku -- --dangerously-skip-permissions --effort low`, "a fresh session: no --resume");
  assert.match(await readFile(join(home("ops"), "AGENTS.md"), "utf8"), /Default worker kind: `codex`/);
});

test("stop closes a running router through am and leaves its ledger", async () => {
  const { run, calls, home } = await setup();
  assert.equal((await run(["start"])).code, 0);
  assert.equal((await run(["stop"], { AM_STATE: "idle" })).code, 0);
  assert.deepEqual((await calls()).slice(-2), ["status router --json", "stop router"]);
  assert.match(await readFile(join(home("router"), "LEDGER.md"), "utf8"), /## In progress/);
  const idle = await run(["stop", "ops"]);
  assert.equal(idle.code, 1);
  assert.match(idle.stderr, /ops is not running/);
});

test("am router ... reaches the router, and am -h documents it with every other command", async () => {
  const am = resolve(import.meta.dirname, "../../agent/bin/am");
  const help = await promisify(execFile)(am, ["-h"]);
  for (const line of ["am start <name>", "am router start [name]", "am router restart [name]", "am router stop [name]", "am subscribe start [name]", "am subscribe stop [name]"]) {
    assert.ok(help.stdout.includes(line), line);
  }
  const routerHelp = await promisify(execFile)(am, ["router", "help"]);
  assert.match(routerHelp.stdout, /^am router — /);
  await assert.rejects(promisify(execFile)(am, ["router", "nope"]), (error: any) => error.code === 2 && /unknown command: nope/.test(error.stderr));
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
