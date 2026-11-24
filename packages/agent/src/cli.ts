import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
  queuePrompt,
  readReply,
  resolveStart,
  settledReply,
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
import { deliverQueue } from "./deliver.ts";
import { BUILTIN, extensions, runAfterResumeAll } from "./extensions.ts";
import { AmError } from "./drivers/index.ts";
import { installGlobal, installProject, uninstallGlobal } from "./install.ts";
import { amCommand, clearQueue, listQueued } from "./queue.ts";
import { AGENT_KINDS, type AgentKind, type AgentState } from "./registry.ts";
import { asksHelp, usageOf } from "./usage.ts";

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
  am prompt <name> <text|-> --queue [--wait] [--after JSON]
                                        Send it now if the agent is idle, else as soon as it is, in the order queued (after
                                        a dialog it waits at on its first start, too). --after: an am command to run once
                                        the agent took it, as a JSON array of its arguments
  am queue <name> [--clear]             The prompts queued for it, and any that could not be delivered; --clear drops them
  am wait <name> [--until idle,blocked,stalled] [--timeout MS] [--read] [--turn]
                                        Wait for a state; a stall is reported once, the next wait waits for news
                                        Prompts queued before the wait are waited for too
                                        --read: when it is idle, also print its final reply (what am read prints)
                                        An agent whose turn ended with background tasks still running (claude) goes on
                                        by itself, so it is not idle yet, for up to stallAfterMinutes; --turn: return
                                        as its turn ends all the same (it was asked to start a dev server, say)
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
  am <command> -h                       Only what it says about that command

  <name> can also be a pane id (e.g. %12). Every command accepts --json.
  States: starting / idle / working / blocked / stalled / exited / unknown
  stalled: its turn will not finish without you: usage limit, content filter, an API error, or no output for
  stallAfterMinutes (default 15). Settings and profiles: ${configPath()}`;

/** An extension's usage (`<executable> help`). */
function extensionUsage(command: string, bin: string): string {
  const help = spawnSync(bin, ["help"], { encoding: "utf8", timeout: 15_000 });
  return help.status === 0 && help.stdout.trim() ? help.stdout.trimEnd() : `am ${command}: no usage available (${bin} help failed)`;
}

/** am's own usage, then each extension's. */
function fullUsage(): string {
  return [USAGE, ...[...extensions()].map(([command, bin]) => extensionUsage(command, bin))].join("\n\n");
}

/** `am <command> ... -h`, for am's own commands and the extensions' alike. */
function commandUsage(command: string, args: string[], bin: string | undefined): string {
  if (["help", "-h", "--help"].includes(command)) return fullUsage();
  const option = args.findIndex((arg) => arg.startsWith("-"));
  const words = ["am", command, ...args.slice(0, option < 0 ? args.length : option)];
  // am router -h: the whole of it.
  if (bin) return ((usage) => usageOf(usage, words, 2) ?? usage)(extensionUsage(command, bin));
  return usageOf(USAGE, words) ?? fullUsage();
}

/** `--after`: an am command's arguments. */
function amArguments(text: string): string[] {
  try {
    const args = JSON.parse(text);
    if (Array.isArray(args) && args.length && args.every((arg) => typeof arg === "string")) return args;
  } catch {
    // Reported below.
  }
  throw new AmError("usage", '--after takes a JSON array of strings, e.g. ["ledger","update","3","--waiting","the worker"]');
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
  if (command && asksHelp(rest)) {
    process.stdout.write(`${commandUsage(command, rest, extension)}\n`);
    return 0;
  }
  if (extension) {
    // Extensions drive agents through am's command line: point them at this am.
    const run = spawnSync(extension, rest, { stdio: "inherit", env: { ...process.env, AM_BIN: amCommand() } });
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
      read: { type: "boolean" },
      turn: { type: "boolean" },
      queue: { type: "boolean" },
      after: { type: "string" },
      clear: { type: "boolean" },
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
        const extra = runAfterResumeAll(amCommand());
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
      if (values.after !== undefined && !values.queue) throw new AmError("usage", "--after goes with --queue");
      if (values.queue) {
        const after = values.after === undefined ? undefined : amArguments(values.after);
        const { agent, queued, ahead } = await queuePrompt(tmux, name, text, after);
        if (!queued && after) spawnSync(amCommand(), after, { stdio: "ignore", timeout: 60_000 });
        const said = queued ? `queued for ${agent.name} (${agent.state})${ahead ? `, ${ahead} ahead of it` : ""}: it is sent once ${agent.name} is idle` : `sent to ${agent.name}`;
        if (!values.wait) {
          out({ ...agent, queuedId: queued?.id ?? null }, said);
          return 0;
        }
        const settled = await waitAgent(tmux, agent.paneId, undefined, timeoutMs);
        out(settled, `${settled.name}: ${settled.state}${settled.detail ? ` (${settled.detail})` : ""}`);
        return 0;
      }
      const agent = await promptAgent(tmux, name, text, { wait: values.wait, timeoutMs });
      out(agent, values.wait ? `${agent.name}: ${agent.state}${agent.detail ? ` (${agent.detail})` : ""}` : `sent to ${agent.name}`);
      return 0;
    }
    case "queue": {
      const name = target();
      if (values.clear) {
        const dropped = await clearQueue(name);
        out({ dropped }, `dropped ${dropped} queued prompt(s) of ${name}`);
        return 0;
      }
      const startedAt = (await getAgent(tmux, name).catch(() => undefined))?.startedAt;
      const queued = (await listQueued(name)).map((p) => ({ ...p, status: p.failed ? "failed" : p.startedAt === startedAt ? "waiting" : "earlier launch" }));
      const first = (text: string) => {
        const line = text.trim().split("\n")[0];
        return line.length > 60 ? `${line.slice(0, 59)}…` : line;
      };
      out(queued, queued.length ? columns([["STATUS", "AGE", "PROMPT", "WHY"], ...queued.map((p) => [p.status, age(p.at), first(p.text), p.failed ?? ""])]) : `nothing queued for ${name}`);
      return 0;
    }
    case "deliver":
      await deliverQueue(tmux, target());
      return 0;
    case "wait": {
      const until = values.until ? (values.until.split(",") as AgentState[]) : undefined;
      const agent = await waitAgent(tmux, target(), until, timeoutMs, { turn: values.turn });
      const line = `${agent.name}: ${agent.state}${agent.detail ? ` (${agent.detail})` : ""}`;
      if (!values.read || agent.state !== "idle") {
        out(agent, line);
        return 0;
      }
      // The wait is what was asked for: a reply that cannot be read is reported, not an error.
      try {
        const reply = await settledReply(() => readReply(tmux, agent.paneId));
        out({ ...agent, reply }, `${line}\n\n${reply || "(no final reply in its latest turn)"}`);
      } catch (error) {
        const readError = error instanceof Error ? error.message : String(error);
        out({ ...agent, readError }, `${line}\n\n(could not read its reply: ${readError}; try am read ${agent.name})`);
      }
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
    case "stop": {
      const left = (await getAgent(tmux, target())).queued;
      await stopAgent(tmux, target());
      out({ ok: true }, `stopped ${target()}${left ? `; ${left} queued prompt(s) were not delivered (am resume ${target()} delivers them)` : ""}`);
      return 0;
    }
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

/** Exits once everything written has gone out: a pipe takes 64 KB at a time, and process.exit drops the rest. */
function finish(code: number): void {
  // The reader closed the pipe (| head): nothing more to say.
  process.stdout.once("error", () => process.exit(code));
  process.stdout.write("", () => process.exit(code));
}

main(process.argv.slice(2)).then(
  finish,
  (error: unknown) => {
    const code = error instanceof AmError ? error.code : error instanceof Error && error.name === "AgentNotFound" ? "not_found" : "error";
    const message = error instanceof Error ? error.message : String(error);
    if (process.argv.includes("--json")) process.stderr.write(`${JSON.stringify({ error: code, message })}\n`);
    else process.stderr.write(`am: ${message}\n`);
    process.exit(code === "usage" ? 2 : 1);
  },
);
