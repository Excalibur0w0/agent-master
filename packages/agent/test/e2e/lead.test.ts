// Agent-led mode: a Claude "lead", invoked with /am, starts an opencode
// helper, delegate a question, read the answer and stop the helper.
// Opt in with AM_E2E_LEAD=1 (it spends a few model calls on both agents).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";

import { Tmux } from "@agent-master/tmux";

import { installProject } from "../../src/install.ts";
import { forgetTestSessions } from "./cleanup.ts";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const binDir = resolve(import.meta.dirname, "../../bin");
const cli = resolve(import.meta.dirname, "../../src/cli.ts");
// Its own project dir with the /am entry points installed, so the lead's and
// the helper's sessions stay out of this repo's history and can be deleted.
const workDir = join(repoRoot, ".state", `e2e-lead-${process.pid}`);
const startedAt = Date.now();
const tmux = new Tmux({ socketName: `am-e2e-lead-${process.pid}` });
let env: NodeJS.ProcessEnv;

function am(...args: string[]): Promise<any> {
  return new Promise((done, fail) => {
    const [command, ...rest] = args;
    execFile(process.execPath, ["--disable-warning=ExperimentalWarning", cli, command, "--json", ...rest], { env, timeout: 600_000 }, (error, stdout, stderr) => {
      if (error) fail(new Error(stderr || error.message));
      else done(JSON.parse(stdout.trim().split("\n").pop() || "null"));
    });
  });
}

before(async () => {
  await mkdir(workDir, { recursive: true });
  await installProject(workDir);
  const user = await tmux.newSession("user", { width: 240, height: 60, cwd: workDir, command: "sh" });
  env = { ...process.env, TMUX: `${await tmux.socketPath()},0,0`, TMUX_PANE: user };
});
after(async () => {
  await tmux.killServer();
  await forgetTestSessions([workDir], startedAt);
});

test("a lead agent delegates to an opencode helper through the am skill", { skip: process.env.AM_E2E_LEAD !== "1", timeout: 600_000 }, async () => {
  await am(
    "start", "lead", "--kind", "claude", "--cwd", workDir, "--model", "sonnet",
    "--env", `PATH=${binDir}:${process.env.PATH}`,
    "--", "--permission-mode", "default", "--allowedTools", "Bash(am:*)",
  );

  // The guide is explicit-only, so the lead gets it through /am like a user would type it.
  const task = [
    "/am 完成下面的事：",
    "1. 启动一个 opencode agent，名字叫 helper，加参数 --model openrouter/deepseek/deepseek-v4.1-flash",
    "2. 让 helper 回答：「17 乘以 23 等于多少？只回复数字」，用 --wait 并加 --timeout 120000",
    "3. 用 am read 读取 helper 的回复",
    "4. am stop helper",
    "最后只回复 helper 的原始回复，不要别的内容。",
  ].join("\n");

  const seen = new Set<string>();
  const watcher = setInterval(async () => {
    for (const agent of await am("list").catch(() => [])) seen.add(`${agent.name}:${agent.kind}`);
  }, 1000);
  try {
    const settled = await am("prompt", "lead", task, "--wait", "--timeout", "480000");
    assert.equal(settled.state, "idle", `lead ended ${settled.state}: ${settled.detail}`);
  } finally {
    clearInterval(watcher);
  }

  const { reply } = await am("read", "lead");
  assert.match(reply, /391/, `lead reply: ${reply}`);
  assert.ok(seen.has("helper:opencode"), `the lead started an opencode helper (saw ${[...seen].join(", ")})`);
  const remaining = (await am("list")).map((a: any) => a.name);
  assert.deepEqual(remaining, ["lead"], "the helper was stopped");
  await am("stop", "lead");
});
