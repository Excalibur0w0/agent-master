// End-to-end: real agents in an isolated tmux server, driven only through the
// `am` CLI. Costs a little model usage. AM_E2E_KINDS picks agents (default all).
// AM_E2E_TRUST_CODEX_HOOKS=1 answers Codex's one-time hook trust prompt.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { Tmux } from "@agent-master/tmux";

import { codexHooksTrusted } from "../../src/drivers/codex.ts";

const repoRoot = resolve(import.meta.dirname, "../../../..");
const cli = resolve(import.meta.dirname, "../../src/cli.ts");
const workDir = join(repoRoot, ".state", `e2e-${process.pid}`);
const tmux = new Tmux({ socketName: `am-e2e-agents-${process.pid}` });
const kinds = (process.env.AM_E2E_KINDS ?? "opencode,claude,codex").split(",");
let env: NodeJS.ProcessEnv;

interface Result {
  code: number;
  stdout: string;
  stderr: string;
  json: any;
}

function am(args: string[]): Promise<Result> {
  return new Promise((done) => {
    // --json goes right after the command: anything after `--` is handed to the agent.
    const [command, ...rest] = args;
    execFile(process.execPath, ["--disable-warning=ExperimentalWarning", cli, command, "--json", ...rest], { env, timeout: 300_000 }, (error, stdout, stderr) => {
      const code = error ? (typeof error.code === "number" ? error.code : 1) : 0;
      let json: any;
      try {
        json = JSON.parse((code === 0 ? stdout : stderr).trim().split("\n").pop() ?? "");
      } catch {
        json = undefined;
      }
      done({ code, stdout, stderr, json });
    });
  });
}

async function amOk(args: string[]): Promise<any> {
  const result = await am(args);
  assert.equal(result.code, 0, `am ${args.join(" ")} failed: ${result.stderr}`);
  return result.json;
}

const exists = (path: string) => access(path).then(() => true, () => false);

// Codex keys folder trust by git root and ignores a -c override inside a git
// repo, so it runs in a non-git temp dir that is trusted for this session only.
const codexDir = realpathSync(mkdtempSync(join(tmpdir(), "am-e2e-codex-")));

const SETUPS: Record<string, { args: string[]; env?: string[]; cwd?: string; permission: (file: string) => string }> = {
  opencode: {
    args: ["--model", "openrouter/deepseek/deepseek-v4.1-flash"],
    env: ['OPENCODE_CONFIG_CONTENT={"permission":{"bash":"ask"}}'],
    permission: (file) => `用 bash 工具执行 touch ${file}，然后只回复 done`,
  },
  claude: {
    args: ["--model", "haiku", "--", "--permission-mode", "default"],
    permission: (file) => `用 Bash 工具执行 touch ${file}，然后只回复 done`,
  },
  codex: {
    cwd: codexDir,
    args: ["--model", "gpt-6-luna", "--", "-c", 'model_reasoning_effort="low"', "-a", "on-request", "-s", "read-only", "-c", `projects."${codexDir}".trust_level="trusted"`],
    permission: (file) => `当前沙箱是只读的。请申请提权（require escalated permissions）来执行 touch ${file}，然后只回复 done`,
  },
};

before(async () => {
  await mkdir(workDir, { recursive: true });
  const lead = await tmux.newSession("lead", { width: 220, height: 60, cwd: workDir, command: "sh" });
  env = { ...process.env, TMUX: `${await tmux.socketPath()},0,0`, TMUX_PANE: lead };
});

after(() => tmux.killServer());

for (const kind of kinds) {
  const name = `e2e-${kind}`;
  const setup = SETUPS[kind];

  describe(kind, { timeout: 600_000 }, () => {
    it("starts in its own tmux session and reports idle", async () => {
      const start = am(["start", name, "--kind", kind, "--cwd", setup.cwd ?? workDir, ...(setup.env ?? []).flatMap((e) => ["--env", e]), ...setup.args]);
      if (kind === "codex" && process.env.AM_E2E_TRUST_CODEX_HOOKS === "1" && !(await codexHooksTrusted())) {
        // First run only: answer "2. Trust all and continue" in Codex's hook review.
        // The dialog takes a few seconds to appear; retry until config.toml records the trust.
        for (let attempt = 0; attempt < 10 && !(await codexHooksTrusted()); attempt++) {
          await sleep(3000);
          const agent = (await amOk(["list"])).find((a: any) => a.name === name);
          if (!agent) break;
          await tmux.sendKeys(agent.paneId, "2");
          await sleep(300);
          await tmux.sendKeys(agent.paneId, "Enter");
        }
      }
      const result = await start;
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.json.state, "idle");
      assert.equal(result.json.tmuxSession, `am-${name}`);
      assert.equal(await tmux.hasSession(`am-${name}`), true);
      const leadPanes = await tmux.run(["list-panes", "-t", "lead", "-F", "#{pane_id}"]);
      assert.equal(leadPanes.trim().split("\n").length, 1, "the caller's window is left alone");
      const agents = await amOk(["list"]);
      assert.ok(agents.some((a: any) => a.name === name && a.kind === kind));
    });

    it("answers a prompt and the reply is read back without the screen", async () => {
      const after = await amOk(["prompt", name, "只回复 pong 这一个词", "--wait", "--timeout", "120000"]);
      assert.equal(after.state, "idle");
      const { reply } = await amOk(["read", name]);
      assert.match(reply, /pong/i);
    });

    it("blocks on a permission request, refuses new prompts, then runs once approved", async () => {
      const file = join(setup.cwd ?? workDir, `${kind}-approved.txt`);
      await amOk(["prompt", name, setup.permission(file)]);
      const blocked = await amOk(["wait", name, "--until", "blocked", "--timeout", "90000"]);
      assert.equal(blocked.state, "blocked", JSON.stringify(blocked));

      const refused = await am(["prompt", name, "别的任务"]);
      assert.equal(refused.json?.error, "agent_blocked");

      await amOk(["approve", name]);
      const settled = await amOk(["wait", name, "--timeout", "90000"]);
      assert.equal(settled.state, "idle", JSON.stringify(settled));
      assert.equal(await exists(file), true, "the approved command ran");
    });

    it("can be interrupted mid-turn and becomes idle again", async () => {
      await amOk(["prompt", name, "写一篇 2000 字的散文，主题是秋天，不要调用任何工具"]);
      await amOk(["wait", name, "--until", "working", "--timeout", "30000"]);
      await amOk(["interrupt", name]);
      const settled = await amOk(["wait", name, "--until", "idle", "--timeout", "30000"]);
      assert.equal(settled.state, "idle");
    });

    it("stops and disappears from the list, taking its session with it", async () => {
      await amOk(["stop", name]);
      const agents = await amOk(["list"]);
      assert.ok(!agents.some((a: any) => a.name === name));
      assert.equal(await tmux.hasSession(`am-${name}`), false);
    });
  });
}
