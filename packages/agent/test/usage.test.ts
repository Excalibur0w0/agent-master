import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { BUILTIN } from "../src/extensions.ts";
import { asksHelp, usageOf } from "../src/usage.ts";

const USAGE = `am fly — for the test

  am fly up <name> [--fast]   Goes up
                              --fast: quickly
  am fly up --all             All of them
  am fly down [name] | am fly land
           [--soft]
                              Comes down

  am fly up is not down, says this line
    nor is this
  Every command takes --json
      (and this belongs to no command)`;

test("help is asked for before any --; what follows goes to the agent", () => {
  assert.equal(asksHelp(["x", "-h"]), true);
  assert.equal(asksHelp(["--help"]), true);
  assert.equal(asksHelp([]), false);
  assert.equal(asksHelp(["x", "--kind", "claude", "--", "--help", "-h"]), false);
  assert.equal(asksHelp(["x", "the -h flag", "--title=-h"]), false, "only as an argument of its own");
});

test("a command's part of the usage: all its forms, the lines under them, and nothing else", () => {
  const down = "  am fly down [name] | am fly land\n           [--soft]\n                              Comes down";
  assert.equal(usageOf(USAGE, ["am", "fly", "down"], 2), down);
  assert.equal(usageOf(USAGE, ["am", "fly", "land", "now"], 2), down, "the second command of a line; arguments are left out of the name");
  assert.match(usageOf(USAGE, ["am", "fly", "up", "down"], 2)!, /^  am fly up <name> \[--fast\]   Goes up\n +--fast: quickly\n  am fly up --all +All of them\n/);
  assert.doesNotMatch(usageOf(USAGE, ["am", "fly", "up"], 2)!, /Comes down|Every command|no command/);
  assert.equal(usageOf(USAGE, ["am", "fly", "upwards"], 2), undefined, "not the start of a word");
  assert.equal(usageOf(USAGE, ["am", "fly"], 2), undefined);
});

/** am with state and settings directories, and a tmux server (none running), of its own. */
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "am-usage-"));
  const env = { ...process.env, XDG_STATE_HOME: dir, XDG_CACHE_HOME: dir, XDG_CONFIG_HOME: dir, AM_STATE_DIR: dir, HOME: dir, TMUX: "", TMUX_TMPDIR: dir };
  return (...args: string[]) =>
    new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
      const child = execFile(resolve(import.meta.dirname, "../bin/am"), args, { env }, (error, stdout, stderr) => done({ code: error ? Number(error.code) : 0, stdout, stderr }));
      child.stdin!.end();
    });
}

test("every am command answers -h with its own part of the help, and does nothing else", async () => {
  const am = await setup();
  const commands = [...BUILTIN].filter((command) => !["deliver", "help", "-h", "--help"].includes(command));
  for (const command of commands) {
    const { code, stdout, stderr } = await am(command, "-h");
    assert.deepEqual([code, stderr], [0, ""], command);
    assert.ok(stdout.split("\n").some((line) => line.slice(2).split(" | ").some((form) => `${form} `.startsWith(`am ${command} `))), `${command}: ${stdout}`);
    assert.doesNotMatch(stdout, /^am — /m, `${command}: not the whole help`);
  }
  // Arguments and options do not get in the way, and nothing is started, sent or stopped.
  assert.match((await am("wait", "nobody", "--read", "--help")).stdout, /^  am wait <name> /);
  assert.match((await am("prompt", "nobody", "hello", "-h")).stdout, /^  am prompt <name> [^]*\n  am prompt <name> <text\|-> --queue /);
  assert.match((await am("uninstall", "-h")).stdout, /^  am install .* \| am uninstall\n/);
  // After "--" it is the agent's.
  assert.deepEqual([(await am("keys", "nobody", "--", "-h")).code, (await am("stop", "nobody")).code], [1, 1]);
  const whole = (await am("-h")).stdout;
  assert.match(whole, /^am — /);
  for (const args of [["help", "-h"], ["-h", "-h"], ["nope", "-h"], ["deliver", "nobody", "-h"]]) assert.equal((await am(...args)).stdout, whole, args.join(" "));
});
