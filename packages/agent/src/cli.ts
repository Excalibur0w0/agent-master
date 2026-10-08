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

const USAGE = `am — start, drive and coordinate coding agents (claude / codex / opencode) in tmux

  am start <name> --kind <claude|codex|opencode> [--cwd DIR] [--model M] [--env K=V]...
           [--window] [--timeout MS] [-- <native agent args>]
                                        Runs in its own tmux session am-<name>; --window uses a new window of the current session
  am list                               All agents and their states
  am open <name>                        Switch to its tmux session (outside tmux, print the attach command)
  am status <name>                      One agent's state
  am prompt <name> <text|-> [--wait] [--timeout MS]
                                        Send a task (- reads stdin); --wait returns once idle or blocked
  am wait <name> [--until idle,blocked] [--timeout MS]
                                        Wait for a state
  am read <name>                        Final reply of its latest turn
  am approve <name> [--always]          Approve its pending permission request
  am deny <name>                        Deny it
  am interrupt <name>                   Interrupt the current turn
  am keys <name> <key>...               Send raw keys (tmux key names such as Enter Escape C-c)
  am stop <name>                        Close it together with its session
  am install [--project DIR] | am uninstall
                                        Install the am command and the explicit entry points (/am, $am); --project for one project only

  <name> can also be a pane id (e.g. %12). Every command accepts --json.
  States: starting / idle / working / blocked / exited / unknown`;

function age(startedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function table(agents: AgentView[]): string {
  if (!agents.length) return "no agents";
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
    if (!positionals[0]) throw new AmError("usage", "missing agent name");
    return positionals[0];
  };

  switch (command) {
    case "start": {
      const kind = values.kind as AgentKind;
      if (!(AGENT_KINDS as readonly string[]).includes(kind)) throw new AmError("usage", `--kind must be one of: ${AGENT_KINDS.join(", ")}`);
      const placement = values.window ? "window" : "session";
      const env: Record<string, string> = {};
      for (const pair of values.env ?? []) {
        const at = pair.indexOf("=");
        if (at <= 0) throw new AmError("usage", `--env expects KEY=VALUE, got: ${pair}`);
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
        warn: (message) => process.stderr.write(`am: warning: ${message}\n`),
      });
      out(agent, `${agent.name} is ready (${agent.kind}, tmux session ${agent.tmuxSession}; watch it with: am open ${agent.name})`);
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
      const name = target();
      const text = positionals[1] === "-" ? readFileSync(0, "utf8") : positionals.slice(1).join(" ");
      if (!text.trim()) throw new AmError("usage", "nothing to send");
      const agent = await promptAgent(tmux, name, text, { wait: values.wait, timeoutMs });
      out(agent, values.wait ? `${agent.name}: ${agent.state}${agent.detail ? ` (${agent.detail})` : ""}` : `sent to ${agent.name}`);
      return 0;
    }
    case "wait": {
      const until = values.until ? (values.until.split(",") as AgentState[]) : undefined;
      const agent = await waitAgent(tmux, target(), until, timeoutMs);
      out(agent, `${agent.name}: ${agent.state}${agent.detail ? ` (${agent.detail})` : ""}`);
      return 0;
    }
    case "read": {
      const reply = await readReply(tmux, target());
      out({ name: target(), reply }, reply);
      return 0;
    }
    case "approve":
      await approveAgent(tmux, target(), values.always ? "always" : "once");
      out({ ok: true }, "approved");
      return 0;
    case "deny":
      await denyAgent(tmux, target());
      out({ ok: true }, "denied");
      return 0;
    case "interrupt": {
      const agent = await interruptAgent(tmux, target());
      out(agent, `interrupted; ${agent.name}: ${agent.state}`);
      return 0;
    }
    case "keys":
      if (positionals.length < 2) throw new AmError("usage", "missing keys");
      await sendKeys(tmux, target(), positionals.slice(1));
      out({ ok: true }, "sent");
      return 0;
    case "stop":
      await stopAgent(tmux, target());
      out({ ok: true }, `stopped ${target()}`);
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
      throw new AmError("usage", `unknown command: ${command}\n\n${USAGE}`);
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
