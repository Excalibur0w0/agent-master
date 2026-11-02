// A Claude router, started by am-router, hands a question to a worker (Claude
// haiku: no third-party API in the loop), waits for it in the background and
// reports the answer once it wakes.
// Opt in with AM_E2E_ROUTER=1 (it spends a few model calls on both agents).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { promisify } from "node:util";

import { forgetTestSessions } from "../../../agent/test/e2e/cleanup.ts";

const run = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../../../..");
const router = resolve(import.meta.dirname, "../../bin/am-router");
const amDir = resolve(import.meta.dirname, "../../../agent/bin");
// Inside this repo: Claude already trusts it, and the sessions they leave can be found and deleted.
const root = join(repoRoot, ".state", `e2e-router-${process.pid}`);
const project = join(root, "project");
const state = join(root, "state");
const home = join(state, "agent-master", "router", "router");
const socket = `am-e2e-router-${process.pid}`;
const startedAt = Date.now();
let env: NodeJS.ProcessEnv;

async function am(...args: string[]): Promise<any> {
  const { stdout } = await run(join(amDir, "am"), [...args, "--json"], { env, timeout: 600_000 });
  return JSON.parse(stdout.trim().split("\n").pop() || "null");
}

/** The router's Claude transcript records. */
async function transcript(): Promise<any[]> {
  const dir = join(homedir(), ".claude", "projects", home.replace(/[^a-zA-Z0-9]/g, "-"));
  const records: any[] = [];
  for (const file of (await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".jsonl"))) {
    for (const line of (await readFile(join(dir, file), "utf8")).split("\n").filter(Boolean)) records.push(JSON.parse(line));
  }
  return records;
}

/** Every Bash command the router ran in the background. */
async function backgroundCommands(): Promise<string[]> {
  return (await transcript()).flatMap((record) =>
    (Array.isArray(record.message?.content) ? record.message.content : []).flatMap((part: any) =>
      part?.type === "tool_use" && part.name === "Bash" && part.input?.run_in_background ? [part.input.command] : [],
    ),
  );
}

/** What a failure needs to be understood once cleanup has deleted the sessions. */
async function scene(): Promise<string> {
  const agents = (await am("list").catch(() => [])).map((a: any) => `${a.name}:${a.kind}:${a.state}${a.detail ? ` (${a.detail})` : ""}`);
  const tail = (await transcript()).slice(-6).map((record) => {
    const content = record.message?.content;
    const text = typeof content === "string" ? content : (content ?? []).map((part: any) => part.text ?? part.content ?? JSON.stringify(part.input ?? "")).join(" | ");
    return `${record.type}: ${String(text).slice(0, 300)}`;
  });
  return [`agents: ${agents.join(", ")}`, `background: ${JSON.stringify(await backgroundCommands())}`, "transcript tail:", ...tail].join("\n");
}

before(async () => {
  await mkdir(project, { recursive: true });
  // The tmux server hands its environment to every agent: am on PATH, and the router's home under this test.
  env = { ...process.env, PATH: `${amDir}:${process.env.PATH}`, XDG_STATE_HOME: state };
  await run("tmux", ["-L", socket, "new-session", "-d", "-s", "user", "-x", "240", "-y", "60", "-c", project, "sh"], { env });
  const { stdout } = await run("tmux", ["-L", socket, "display-message", "-p", "-t", "user", "#{socket_path},#{pane_id}"]);
  const [path, pane] = stdout.trim().split(",");
  env = { ...env, TMUX: `${path},0,0`, TMUX_PANE: pane };
});
after(async () => {
  for (const agent of await am("list").catch(() => [])) await am("stop", agent.name).catch(() => {});
  await run("tmux", ["-L", socket, "kill-server"]).catch(() => {});
  await forgetTestSessions([home, project], startedAt);
  await rm(root, { recursive: true, force: true });
});

test("a router hands a request to a worker, waits in the background and reports back", { skip: process.env.AM_E2E_ROUTER !== "1", timeout: 600_000 }, async () => {
  await run(router, ["start", "--model", "sonnet", "--project", project, "--worker-kind", "claude", "--", "--permission-mode", "default"], { env });

  const seen = new Set<string>();
  const watch = async () => {
    for (const agent of await am("list").catch(() => [])) seen.add(`${agent.name}:${agent.kind}`);
  };
  const watcher = setInterval(watch, 1000);
  try {
    const request = "请让一个 worker（am start 时加参数 --model haiku）回答：「17 乘以 23 等于多少？只回复数字」。拿到结果后只回复那个数字。";
    const first = await am("prompt", "router", request, "--wait", "--timeout", "300000");
    assert.equal(first.state, "idle", `router ended its turn ${first.state}: ${first.detail}`);

    // The worker's end wakes the router for another turn, which reads and reports the answer.
    const deadline = Date.now() + 180_000;
    let reply = "";
    while (Date.now() < deadline && !/391/.test(reply)) {
      await new Promise((r) => setTimeout(r, 3000));
      const current = await am("status", "router");
      assert.notEqual(current.state, "blocked", `router blocked: ${current.detail}`);
      if (current.state === "idle") ({ reply } = await am("read", "router"));
    }
    if (!/391/.test(reply)) assert.fail(`router reply: ${reply}\n${await scene()}`);
  } finally {
    clearInterval(watcher);
  }
  await watch();
  assert.ok([...seen].some((agent) => agent !== "router:claude" && agent.endsWith(":claude")), `the router started a claude worker (saw ${[...seen].join(", ")})`);
  const waits = (await backgroundCommands()).filter((command) => command.startsWith("am wait"));
  assert.ok(waits.length > 0, "the router waited for its worker in the background");
});
