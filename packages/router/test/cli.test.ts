import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

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
  const env = { ...process.env, AM_BIN: await fakeAm(dir), AM_LOG: log, XDG_STATE_HOME: join(dir, "state"), AM_STATE: "" };
  const run = (args: string[], extra: Record<string, string> = {}) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((done) =>
      execFile(bin, args, { cwd: dir, env: { ...env, ...extra } }, (error, stdout, stderr) => done({ code: error ? Number(error.code) : 0, stdout, stderr })),
    );
  const calls = async () => (await readFile(log, "utf8")).split("\n").filter(Boolean);
  return { dir, run, calls, home: (name: string) => join(dir, "state", "agent-master", "router", name) };
}

test("start writes the router's home and starts it there through am", async () => {
  const { dir, run, calls, home } = await setup();
  const { code, stdout } = await run(["start"]);
  assert.equal(code, 0);
  assert.deepEqual(await calls(), ["status router --json", `start router --kind claude --cwd ${home("router")}`]);
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
