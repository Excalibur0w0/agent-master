// am trust. Real tmux on an isolated server; the agents are scripts that stand at a dialog as Claude and
// Codex do, take keys one by one, and record the answer where the real ones do.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after, before, test } from "node:test";

import { Tmux } from "@agent-master/tmux";

import { queuePrompt, startAgent, stopAgent } from "../src/agent.ts";
import { loadConfig } from "../src/config.ts";
import { deliverQueue } from "../src/deliver.ts";
import { codexHookHash } from "../src/drivers/codex.ts";
import { DRIVERS } from "../src/drivers/index.ts";
import { shellCommand } from "../src/drivers/types.ts";
import { listQueued } from "../src/queue.ts";
import { writeRecord } from "../src/registry.ts";
import { below, trustFolder } from "../src/trust.ts";

const tmux = new Tmux({ socketName: `am-trust-test-${process.pid}` });
const git = (...args: string[]) => promisify(execFile)("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args]);
let dir = "";
/** The one directory am may trust things below. */
let work = "";
let bin = "";

before(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "am-trust-")));
  work = join(dir, "work");
  await mkdir(work);
  process.env.AM_STATE_DIR = join(dir, "state");
  process.env.XDG_CACHE_HOME = join(dir, "cache");
  // Where Claude and Codex keep their records; the fakes inherit these from the tmux server, as the real ones do.
  process.env.CLAUDE_CONFIG_DIR = join(dir, "claude");
  process.env.CODEX_HOME = join(dir, "codex");
  process.env.AM_BIN = "/usr/bin/true";
  delete process.env.AM_CONTRACT;
  await Promise.all([mkdir(process.env.CLAUDE_CONFIG_DIR), mkdir(process.env.CODEX_HOME)]);
  await tmux.newSession("base", { command: "sh" });
  bin = join(dir, "fake-agent");
  await writeFile(
    bin,
    `#!/usr/bin/env node
// $FAKE_OPTIONS: the dialog's answers, the first one highlighted. $FAKE_ROOT: what trust is recorded for.
const fs = require("fs"), { execFileSync } = require("child_process");
const { FAKE_KEYS, FAKE_OPTIONS, FAKE_ROOT, FAKE_THEN, FAKE_RECORD, TMUX_PANE, CLAUDE_CONFIG_DIR, CODEX_HOME } = process.env;
const report = (...options) => execFileSync("tmux", options.flatMap(([k, v], i) => [...(i ? [";"] : []), "set-option", "-p", "-F", "-t", TMUX_PANE, k, v]));
let at = 0, asking = true;
process.stdin.setRawMode(true);
process.stdin.on("data", (data) => {
  fs.appendFileSync(FAKE_KEYS, JSON.stringify(String(data)) + "\\n");
  if (!asking) {
    if (String(data).includes("\\r")) report(["@am_seq", "#{e|+:#{@am_seq},1}"], ["@am_state", "working"], ["@am_event", "UserPromptSubmit"]);
    return;
  }
  if (FAKE_OPTIONS === "deaf") return;
  if (String(data) === "\\x1b[B") at = Math.min(at + 1, 1);
  if (String(data) !== "\\r") return;
  if (FAKE_OPTIONS.split(",")[at] !== "trust") process.exit(1);
  asking = false;
  if (FAKE_RECORD === "claude") {
    const file = CLAUDE_CONFIG_DIR + "/.claude.json", known = JSON.parse(fs.readFileSync(file, "utf8"));
    known.projects[FAKE_ROOT] = { hasTrustDialogAccepted: true };
    fs.writeFileSync(file, JSON.stringify(known));
    if (FAKE_THEN !== "dialog") report(["@am_session", "s1"], ["@am_event", "SessionStart"], ["@am_state", "idle"]);
  } else fs.appendFileSync(CODEX_HOME + "/config.toml", "\\n[projects." + JSON.stringify(FAKE_ROOT) + "]\\ntrust_level = \\"trusted\\"\\n");
});
`,
  );
  await chmod(bin, 0o755);
});
after(() => tmux.killServer());

/** A repository below `work`, with a linked worktree beside it. */
async function repository(name: string) {
  const [main, linked] = [join(work, name), join(work, `${name}-wt`)];
  await git("init", "-q", main);
  await git("-C", main, "commit", "-q", "--allow-empty", "-m", "x");
  await git("-C", main, "worktree", "add", "-q", linked);
  return { main, linked };
}

const claudeKnows = (known: object) => writeFile(join(dir, "claude", ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, projects: {}, ...known }));

async function hooksTrusted(): Promise<string> {
  const command = shellCommand(fileURLToPath(new URL("../hooks/codex.sh", import.meta.url)));
  const events = ["SessionStart", "UserPromptSubmit", "PermissionRequest", "PostToolUse", "Stop", "Interrupt", "SessionEnd"];
  const label = (event: string) => event.replace(/(?!^)[A-Z]/g, (c) => `_${c}`).toLowerCase();
  return events.map((event) => `[hooks.state."/<session-flags>/config.toml:${label(event)}:0:0"]\ntrusted_hash = "${codexHookHash(event, command)}"\n`).join("\n");
}

/** Starts a fake that stands at its dialog; `am start` gives up on it. */
async function held(name: string, kind: "claude" | "codex", cwd: string, fake: { options: string; root: string; then?: string }, more: { env?: Record<string, string>; args?: string[] } = {}) {
  const keysFile = join(dir, `${name}.keys`);
  await writeFile(keysFile, "");
  const env = { FAKE_KEYS: keysFile, FAKE_OPTIONS: fake.options, FAKE_ROOT: fake.root, FAKE_THEN: fake.then ?? "", FAKE_RECORD: kind, ...more.env };
  await assert.rejects(startAgent(tmux, { name, kind, bin, cwd, env, args: more.args, timeoutMs: 1500 }), (error: { code?: string }) => error.code === "start_timeout");
  return async () => (await readFile(keysFile, "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line) as string);
}

const trust = (name: string, trustRoots = [work]) => trustFolder(tmux, name, { trustRoots, screenMs: 1500, answerMs: 2000, timeoutMs: 1500 });
const refusal = (code: string, message: RegExp) => (error: { code?: string; message: string }) => (assert.equal(error.code, code, error.message), assert.match(error.message, message), true);
const DOWN = "\x1b[B";

test("claude: one Down and one Enter trust the repository, and what was queued arrives, once", async () => {
  const { main, linked } = await repository("shop");
  await claudeKnows({});
  const keys = await held("c1", "claude", linked, { options: "exit,trust", root: main });
  assert.ok((await queuePrompt(tmux, "c1", "do it")).queued);
  const delivering = deliverQueue(tmux, "c1", { holdMs: 300, intervalMs: 50, runAfter: () => {} });
  const { agent, root, repository: whole } = await trust("c1");
  assert.deepEqual([agent.state === "starting", root, whole], [false, main, true]);
  await delivering;
  assert.deepEqual(await listQueued("c1"), []);
  const pressed = await keys();
  assert.deepEqual(pressed.slice(0, 2), [DOWN, "\r"]);
  assert.equal(pressed.join("").split("do it").length, 2, "the queued prompt, once");
  await assert.rejects(trust("c1"), refusal("not_starting", /it is at no startup dialog/));
});

test("what comes after the trust dialog is the user's: no second key, whatever am trust is asked", async () => {
  const { main } = await repository("cart");
  await claudeKnows({});
  const keys = await held("c2", "claude", main, { options: "exit,trust", root: main, then: "dialog" });
  const { agent } = await trust("c2");
  assert.equal(agent.state, "starting");
  await assert.rejects(trust("c2"), refusal("already_answered", /presses keys only once/));
  assert.deepEqual(await keys(), [DOWN, "\r"]);
});

test("a dialog that takes the keys otherwise: the agent exits or ignores them, nothing is trusted or pressed again", async () => {
  const { main } = await repository("odd");
  await claudeKnows({});
  await held("c3", "claude", main, { options: "trust,exit", root: main });
  await assert.rejects(trust("c3"), refusal("exited", /another order/));
  assert.deepEqual(JSON.parse(await readFile(join(dir, "claude", ".claude.json"), "utf8")).projects, {});

  const keys = await held("c4", "claude", main, { options: "deaf", root: main });
  await assert.rejects(trust("c4"), refusal("trust_unconfirmed", /pressed Down Enter once and will not again/));
  await assert.rejects(trust("c4"), refusal("already_answered", /only once/));
  assert.deepEqual(await keys(), [DOWN, "\r"]);
});

test("claude: no key is pressed unless its records say the dialog is the trust one", async () => {
  const { main, linked } = await repository("known");
  await claudeKnows({});
  const keys = await held("c5", "claude", linked, { options: "exit,trust", root: main });
  const refuses = async (known: object, message: RegExp, code = "no_trust_dialog") => {
    await claudeKnows(known);
    await assert.rejects(trust("c5"), refusal(code, message));
  };
  await refuses({ projects: { [main]: { hasTrustDialogAccepted: true } } }, /already trusts .*known: it is at another dialog/);
  await refuses({ projects: { [work]: { hasTrustDialogAccepted: true } } }, /already trusts .*work/);
  await refuses({ hasCompletedOnboarding: false }, /setup screens come before/);
  await writeFile(join(dir, "claude", ".claude.json"), "{ not json");
  await assert.rejects(trust("c5"), refusal("no_trust_dialog", /cannot be read/));
  await claudeKnows({});
  await assert.rejects(trust("c5", []), refusal("not_allowed", /not below any directory/));
  await assert.rejects(trust("c5", [join(dir, "other")]), refusal("not_allowed", /not below/));
  await assert.rejects(trust("c5", [linked]), refusal("not_allowed", /known is not below/), "the repository counts, not only the worktree");
  await assert.rejects(trust("c5", [main]), refusal("not_allowed", /known is not below/), "below a root, not the root itself");
  assert.deepEqual(await keys(), []);
  await stopAgent(tmux, "c5");

  for (const [name, more, what] of [
    ["c6", { env: { CLAUDE_CONFIG_DIR: join(dir, "claude") } }, /CLAUDE_CONFIG_DIR/],
    ["c7", { args: ["--worktree", "x"] }, /--worktree/],
  ] as const) {
    const pressed = await held(name, "claude", linked, { options: "exit,trust", root: main }, more as { env?: Record<string, string>; args?: string[] });
    await assert.rejects(trust(name), refusal("unsupported", what));
    assert.deepEqual(await pressed(), []);
  }
});

test("codex: one Enter trusts the repository; outside git, logged out or already answered it is another screen", async () => {
  const { main, linked } = await repository("api");
  const auth = join(dir, "codex", "auth.json");
  const configFile = join(dir, "codex", "config.toml");
  await writeFile(configFile, await hooksTrusted());
  const keys = await held("x1", "codex", linked, { options: "trust,back", root: main });
  await assert.rejects(trust("x1"), refusal("no_trust_dialog", /no login on record/));
  await writeFile(auth, "{}");
  await writeFile(configFile, `[projects.${JSON.stringify(main)}]\ntrust_level = "untrusted"\n\n${await hooksTrusted()}`);
  await assert.rejects(trust("x1"), refusal("no_trust_dialog", /down as untrusted/));
  await writeFile(configFile, await hooksTrusted());
  assert.deepEqual(await keys(), []);
  const { agent, root } = await trust("x1");
  assert.deepEqual([agent.state, root], ["idle", main]);
  assert.deepEqual(await keys(), ["\r"]);

  // am's own hooks not trusted yet: Codex asks that next, and that one is the user's.
  const second = await repository("api2");
  await writeFile(configFile, "");
  const keys2 = await held("x2", "codex", second.main, { options: "trust,back", root: second.main });
  assert.equal((await trust("x2")).agent.state, "starting");
  assert.deepEqual(await keys2(), ["\r"]);

  const plain = join(work, "plain");
  await mkdir(plain);
  const keys3 = await held("x3", "codex", plain, { options: "trust,back", root: plain });
  await assert.rejects(trust("x3"), refusal("no_trust_dialog", /only inside a git repository/));
  assert.deepEqual(await keys3(), []);
});

test("am trust never goes near a working agent, or one whose kind asks nothing", async () => {
  assert.deepEqual([!!DRIVERS.claude.trustDialog, !!DRIVERS.codex.trustDialog, !!DRIVERS.opencode.trustDialog, !!DRIVERS.dsh.trustDialog], [true, true, false, false]);
  const { main } = await repository("busy");
  await claudeKnows({});
  const keys = await held("c8", "claude", main, { options: "exit,trust", root: main });
  const pane = (await tmux.listPanes("#{pane_id}\t#{@am_name}")).find((row) => row.endsWith("\tc8"))!.split("\t")[0];
  for (const state of ["working", "blocked", "idle"] as const) {
    await writeRecord(tmux, pane, { state });
    await assert.rejects(trust("c8"), refusal("not_starting", new RegExp(`c8 is ${state}`)));
  }
  assert.deepEqual(await keys(), []);
});

test("only what lies below a trusted root counts, symlinks resolved", async () => {
  const inside = join(work, "inside");
  await mkdir(inside);
  await mkdir(join(dir, "outside"));
  await mkdir(join(dir, "workshop"));
  await symlink(join(dir, "outside"), join(work, "sneaky"));
  await symlink(work, join(dir, "alias"));
  assert.equal(await below(inside, [work]), true);
  assert.equal(await below(join(dir, "alias", "inside"), [work]), true);
  assert.equal(await below(inside, [join(dir, "nowhere"), join(dir, "alias")]), true);
  assert.equal(await below(join(work, "sneaky"), [work]), false, "a link out of it");
  assert.equal(await below(join(dir, "workshop"), [work]), false, "not merely the same start");
  assert.equal(await below(work, [work]), false);
  assert.equal(await below(join(work, "missing"), [work]), false);
  assert.equal(await below(inside, ["/"]), true);
});

test("trustRoots comes from am.json, ~/workspace unless it says otherwise", async () => {
  const path = join(dir, "am.json");
  assert.deepEqual((await loadConfig(join(dir, "none.json"))).trustRoots, ["~/workspace"]);
  const load = async (doc: object) => (await writeFile(path, JSON.stringify(doc)), (await loadConfig(path)).trustRoots);
  assert.deepEqual(await load({}), ["~/workspace"]);
  assert.deepEqual(await load({ trustRoots: ["~/src", "/srv"] }), ["~/src", "/srv"]);
  assert.deepEqual(await load({ trustRoots: [] }), []);
  for (const bad of ["~/src", ["src"], [1]]) await assert.rejects(load({ trustRoots: bad }), refusal("bad_config", /trustRoots must be an array of absolute paths/));
});
