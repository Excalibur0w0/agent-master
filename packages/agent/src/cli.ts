import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { Tmux } from "@agent-master/tmux";

import {
  approveAgent,
  denyAgent,
  getAgent,
  interruptAgent,
  listAgents,
  openAgent,
  promptAgent,
  readReply,
  sendKeys,
  startAgent,
  stopAgent,
  waitAgent,
  type AgentView,
} from "./agent.ts";
import { AmError } from "./drivers/index.ts";
import { installGlobal, installProject, uninstallGlobal } from "./install.ts";
import { AGENT_KINDS, type AgentKind, type AgentState } from "./registry.ts";

const USAGE = `am — 在 tmux 里启动、驱动、协同 coding agent（claude / codex / opencode）

  am start <name> --kind <claude|codex|opencode> [--cwd DIR] [--model M] [--env K=V]...
           [--window] [--timeout MS] [-- <agent 原生参数>]
                                        默认开在独立的 tmux 会话 am-<name>；--window 开在当前会话的新窗口
  am list                               所有 agent 及状态
  am open <name>                        切到它的 tmux 会话（tmux 外则打印 attach 命令）
  am status <name>                      单个 agent 的状态
  am prompt <name> <text|-> [--wait] [--timeout MS]
                                        发送任务（- 表示从 stdin 读）；--wait 等到 idle/blocked
  am wait <name> [--until idle,blocked] [--timeout MS]
  am read <name>                        读取它最近一轮的最终回复
  am approve <name> [--always]          批准它在等的权限请求
  am deny <name>                        拒绝
  am interrupt <name>                   中断当前这一轮
  am keys <name> <key>...               直接发按键（tmux 键名，如 Enter Escape C-c）
  am stop <name>                        关闭它（连同它的会话）
  am install [--project DIR] | am uninstall
                                        安装 am 命令和显式调用入口（/am、$am）；--project 只装到该项目

  <name> 也可以是 pane id（如 %12）。所有命令都支持 --json。
  状态：starting / idle / working / blocked / exited / unknown`;

function age(startedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function table(agents: AgentView[]): string {
  if (!agents.length) return "（没有 agent）";
  const rows = [["NAME", "KIND", "STATE", "SESSION", "AGE", "DETAIL"], ...agents.map((a) => [a.name, a.kind, a.state, a.tmuxSession, age(a.startedAt), a.detail])];
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => [...r[i]].length)));
  return rows.map((r) => r.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd()).join("\n");
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      kind: { type: "string" },
      cwd: { type: "string" },
      model: { type: "string" },
      window: { type: "boolean" },
      env: { type: "string", multiple: true },
      timeout: { type: "string" },
      wait: { type: "boolean" },
      until: { type: "string" },
      always: { type: "boolean" },
      project: { type: "string" },
      json: { type: "boolean" },
    },
  });
  const timeoutMs = values.timeout ? Number(values.timeout) : undefined;
  const out = (data: unknown, text: string) => process.stdout.write(`${values.json ? JSON.stringify(data) : text}\n`);
  const tmux = new Tmux();
  const target = () => {
    if (!positionals[0]) throw new AmError("usage", "缺少 agent 名字");
    return positionals[0];
  };

  switch (command) {
    case "start": {
      const kind = values.kind as AgentKind;
      if (!(AGENT_KINDS as readonly string[]).includes(kind)) throw new AmError("usage", `--kind 需要是 ${AGENT_KINDS.join(" / ")}`);
      const placement = values.window ? "window" : "session";
      const env: Record<string, string> = {};
      for (const pair of values.env ?? []) {
        const at = pair.indexOf("=");
        if (at <= 0) throw new AmError("usage", `--env 需要 KEY=VALUE 格式：${pair}`);
        env[pair.slice(0, at)] = pair.slice(at + 1);
      }
      const agent = await startAgent(tmux, {
        name: target(),
        kind,
        cwd: values.cwd,
        model: values.model,
        env,
        args: positionals.slice(1),
        placement,
        timeoutMs,
        warn: (message) => process.stderr.write(`am: 注意：${message}\n`),
      });
      out(agent, `${agent.name} 已就绪（${agent.kind}，tmux 会话 ${agent.tmuxSession}；查看：am open ${agent.name}）`);
      return 0;
    }
    case "open":
      process.stdout.write(`${await openAgent(tmux, target())}\n`);
      return 0;
    case "list": {
      const agents = await listAgents(tmux);
      out(agents, table(agents));
      return 0;
    }
    case "status": {
      const agent = await getAgent(tmux, target());
      out(agent, table([agent]));
      return 0;
    }
    case "prompt": {
      const text = positionals[1] === "-" ? readFileSync(0, "utf8") : positionals.slice(1).join(" ");
      if (!text.trim()) throw new AmError("usage", "缺少要发送的内容");
      const agent = await promptAgent(tmux, target(), text, { wait: values.wait, timeoutMs });
      out(agent, values.wait ? `${agent.name}: ${agent.state}${agent.detail ? `（${agent.detail}）` : ""}` : `已发送给 ${agent.name}`);
      return 0;
    }
    case "wait": {
      const until = values.until ? (values.until.split(",") as AgentState[]) : undefined;
      const agent = await waitAgent(tmux, target(), until, timeoutMs);
      out(agent, `${agent.name}: ${agent.state}${agent.detail ? `（${agent.detail}）` : ""}`);
      return 0;
    }
    case "read": {
      const reply = await readReply(tmux, target());
      out({ name: target(), reply }, reply);
      return 0;
    }
    case "approve":
      await approveAgent(tmux, target(), values.always ? "always" : "once");
      out({ ok: true }, "已批准");
      return 0;
    case "deny":
      await denyAgent(tmux, target());
      out({ ok: true }, "已拒绝");
      return 0;
    case "interrupt": {
      const agent = await interruptAgent(tmux, target());
      out(agent, `已中断，${agent.name}: ${agent.state}`);
      return 0;
    }
    case "keys":
      if (positionals.length < 2) throw new AmError("usage", "缺少按键");
      await sendKeys(tmux, target(), positionals.slice(1));
      out({ ok: true }, "已发送");
      return 0;
    case "stop":
      await stopAgent(tmux, target());
      out({ ok: true }, `已关闭 ${target()}`);
      return 0;
    case "install": {
      const report = values.project ? await installProject(resolve(values.project)) : await installGlobal();
      for (const line of report) process.stdout.write(`${line}\n`);
      return 0;
    }
    case "uninstall":
      for (const line of await uninstallGlobal()) process.stdout.write(`${line}\n`);
      return 0;
    case undefined:
    case "help":
    case "--help":
      process.stdout.write(`${USAGE}\n`);
      return 0;
    default:
      throw new AmError("usage", `未知命令 ${command}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    const code = error instanceof AmError ? error.code : error instanceof Error && error.name === "AgentNotFound" ? "not_found" : "error";
    const message = error instanceof Error ? error.message : String(error);
    if (process.argv.includes("--json")) process.stderr.write(`${JSON.stringify({ error: code, message })}\n`);
    else process.stderr.write(`am: ${message}\n`);
    process.exit(code === "usage" ? 2 : 1);
  },
);
