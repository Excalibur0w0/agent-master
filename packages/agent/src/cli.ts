import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { Tmux } from "@agent-master/tmux";

import {
  approveAgent,
  denyAgent,
  forgetAgent,
  getAgent,
  interruptAgent,
  listAgents,
  openAgent,
  promptAgent,
  readReply,
  resolveStart,
  resumeAgent,
  resumeLost,
  savedAgents,
  sendKeys,
  startAgent,
  stopAgent,
  waitAgent,
  type AgentView,
  type SavedView,
} from "./agent.ts";
import { config, configPath } from "./config.ts";
import { BUILTIN, extensions, runAfterResumeAll } from "./extensions.ts";
import { AmError } from "./drivers/index.ts";
import { installGlobal, installProject, uninstallGlobal } from "./install.ts";
import { AGENT_KINDS, type AgentKind, type AgentState } from "./registry.ts";

const USAGE = `am — start, drive and coordinate coding agents (claude / codex / opencode / dsh) in tmux

  am start <name> (--kind <claude|codex|opencode|dsh> | --profile P) [--bin PATH] [--cwd DIR] [--model M]
           [--env K=V]... [--contract FILE] [--conversation ID] [--window] [--timeout MS] [-- <native agent args>]
                                        Runs in its own tmux session am-<name>; --window uses a new window of the current session
                                        --profile takes kind, bin, model, env and args from a profile in your am.json;
                                        options given here win, and args given here follow the profile's
                                        --bin runs another executable with the kind's arguments (a provider wrapper
                                        such as a gateway's launcher for codex or claude)
                                        --contract (default: the profile's, else $AM_CONTRACT) is appended to the
                                        prompts am sends it: in full the first time, then as a one-line reminder
                                        --conversation continues that existing conversation of the agent instead of
                                        starting a new one (claude, codex, opencode; not dsh)
  am profiles                           The profiles in your am.json
  am list [--saved]                     All agents and their states; --saved: every agent am remembers, running or not
  am open <name>                        Switch to its tmux session (outside tmux, print the attach command)
  am status <name>                      One agent's state
  am prompt <name> <text|-> [--wait] [--timeout MS]
                                        Send a task (- reads stdin); --wait returns once idle, blocked or stalled
  am wait <name> [--until idle,blocked,stalled] [--timeout MS]
                                        Wait for a state; a stall is reported once, the next wait waits for news
  am read <name>                        Final reply of its latest turn
  am approve <name> [--always]          Approve its pending permission request
  am deny <name>                        Deny it
  am interrupt <name>                   Interrupt the current turn
  am keys <name> <key>...               Send raw keys (tmux key names such as Enter Escape C-c)
  am stop <name>                        Close it together with its session (am still remembers it)
  am resume <name> [--window] [--timeout MS] | am resume --all
                                        Start a remembered agent again on its last conversation, with the options it
                                        was started with; --all: every agent lost with its tmux server (reboot, crash),
                                        then what the commands below ran beside them (their "afterResumeAll" step)
  am forget <name>                      Drop what am remembers about an agent
  am install [--project DIR] | am uninstall
                                        Install the am command and the explicit entry points (/am, $am); --project for one project only

  am help | am -h                       This text, including the commands below that other packages add to am

  <name> can also be a pane id (e.g. %12). Every command accepts --json.
  States: starting / idle / working / blocked / stalled / exited / unknown
  stalled: its turn will not finish without you: usage limit, content filter, an API error, or no output for
  stallAfterMinutes (default 15). Settings and profiles: ${configPath()}`;

/** This am, for extensions to drive agents through. */
const amBin = () => process.env.AM_BIN ?? fileURLToPath(new URL("../bin/am", import.meta.url));

/** am's own usage, then each extension's (`<executable> help`). */
function fullUsage(): string {
  const sections = [USAGE];
  for (const [command, bin] of extensions()) {
    const help = spawnSync(bin, ["help"], { encoding: "utf8", timeout: 15_000 });
    sections.push(help.status === 0 && help.stdout.trim() ? help.stdout.trimEnd() : `am ${command}: no usage available (${bin} help failed)`);
  }
  return sections.join("\n\n");
}

function age(startedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h`;
}

function columns(rows: string[][]): string {
  const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => [...r[i]].length)));
  return rows.map((r) => r.map((cell, i) => cell.padEnd(widths[i])).join("  ").trimEnd()).join("\n");
}

function table(agents: AgentView[]): string {
  if (!agents.length) return "no agents";
  return columns([["NAME", "KIND", "STATE", "SESSION", "AGE", "DETAIL"], ...agents.map((a) => [a.name, a.kind, a.state, a.tmuxSession, age(a.startedAt), a.detail])]);
}

function savedTable(agents: SavedView[]): string {
  if (!agents.length) return "am remembers no agents";
  return columns([
    ["NAME", "KIND", "STATUS", "PROFILE", "CONVERSATION", "CWD"],
    ...agents.map((a) => [a.name, a.kind, a.status, a.profile ?? "", a.session || "-", a.cwd]),
  ]);
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const extension = command && !BUILTIN.has(command) ? extensions().get(command) : undefined;
  if (extension) {
    // Extensions drive agents through am's command line: point them at this am.
    const run = spawnSync(extension, rest, { stdio: "inherit", env: { ...process.env, AM_BIN: amBin() } });
    if (run.error) throw run.error;
    return run.status ?? 1;
  }
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      kind: { type: "string" },
      bin: { type: "string" },
      cwd: { type: "string" },
      model: { type: "string" },
      window: { type: "boolean" },
      env: { type: "string", multiple: true },
      timeout: { type: "string" },
      wait: { type: "boolean" },
      until: { type: "string" },
      profile: { type: "string" },
      contract: { type: "string" },
      conversation: { type: "string" },
      saved: { type: "boolean" },
      all: { type: "boolean" },
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

  const warn = (message: string) => process.stderr.write(`am: warning: ${message}\n`);
  const note = (message: string) => process.stderr.write(`am: ${message}\n`);
  const ready = (agent: AgentView) =>
    out(agent, `${agent.name} is ready (${agent.profile ? `profile ${agent.profile}, ` : ""}${agent.kind}${values.conversation ? `, on conversation ${values.conversation}` : ""}, tmux session ${agent.tmuxSession}; watch it with: am open ${agent.name})`);

  switch (command) {
    case "start": {
      const kind = values.kind as AgentKind | undefined;
      if (kind !== undefined && !(AGENT_KINDS as readonly string[]).includes(kind)) throw new AmError("usage", `--kind must be one of: ${AGENT_KINDS.join(", ")}`);
      if (kind === undefined && values.profile === undefined) throw new AmError("usage", "pass --kind or --profile (see am profiles)");
      const placement = values.window ? "window" : "session";
      const env: Record<string, string> = {};
      for (const pair of values.env ?? []) {
        const at = pair.indexOf("=");
        if (at <= 0) throw new AmError("usage", `--env expects KEY=VALUE, got: ${pair}`);
        env[pair.slice(0, at)] = pair.slice(at + 1);
      }
      const options = await resolveStart({
        name: target(),
        kind,
        profile: values.profile,
        bin: values.bin,
        cwd: values.cwd,
        model: values.model,
        env,
        contract: values.contract,
        args: positionals.slice(1),
        placement,
        timeoutMs,
      });
      ready(await startAgent(tmux, { ...options, resume: values.conversation || undefined, warn, note }));
      return 0;
    }
    case "profiles": {
      const { profiles } = await config();
      const rows = Object.entries(profiles).map(([name, p]) => ({ name, ...p }));
      const text = rows.length
        ? columns([["PROFILE", "KIND", "MODEL", "DESCRIPTION"], ...rows.map((p) => [p.name, p.bin ? `${p.kind} (${p.bin})` : p.kind, p.model ?? "", p.description ?? ""])])
        : `no profiles in ${configPath()}`;
      out(rows, text);
      return 0;
    }
    case "resume": {
      const placement = values.window ? "window" : "session";
      if (values.all) {
        const results = await resumeLost(tmux, { placement, timeoutMs, warn, note });
        const lines = results.map((r) => (r.agent ? `resumed ${r.name} (${r.agent.kind}, conversation ${r.agent.session})` : `could not resume ${r.name}: ${r.error}`));
        // Extensions bring back what they ran beside those agents (a watcher's feed loop, say).
        const extra = runAfterResumeAll(amBin());
        if (values.json && extra.length) process.stderr.write(`${extra.join("\n")}\n`);
        out(results, [...(lines.length ? lines : ["no lost agents to resume"]), ...extra].join("\n"));
        return results.some((r) => r.error) ? 1 : 0;
      }
      const agent = await resumeAgent(tmux, target(), { placement, timeoutMs, warn, note });
      out(agent, `${agent.name} resumed conversation ${agent.session} (${agent.kind}, tmux session ${agent.tmuxSession}; watch it with: am open ${agent.name})`);
      return 0;
    }
    case "forget":
      await forgetAgent(target());
      out({ ok: true }, `forgot ${target()}`);
      return 0;
    case "open":
      process.stdout.write(`${await openAgent(tmux, target())}\n`);
      return 0;
    case "list": {
      if (values.saved) {
        const saved = await savedAgents(tmux);
        // Never print the env values an agent was started with.
        out(saved.map(({ env, ...agent }) => ({ ...agent, env: Object.keys(env) })), savedTable(saved));
        return 0;
      }
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
    case "-h":
    case "--help":
      process.stdout.write(`${fullUsage()}\n`);
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
