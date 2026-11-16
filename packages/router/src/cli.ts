import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { ledgerHasTasks, loadStart, routerHome, saveStart, writeHome, type SavedStart } from "./home.ts";

const USAGE = `am router — a long-running agent session that hands your requests to other coding agents through am

  am router start [name] [--kind K] [--model M] [--project DIR] [--worker-kind K] [--contract FILE] [-- <native agent args>]
                     Start the router (default name: router) in tmux session am-<name>; talk to it with: am open <name>
                     --kind: the router's own agent (default claude); --worker-kind: its workers' default (default claude)
                     --project: where workers run unless you name another directory (default: the current directory)
                     --contract: the worker contract am appends to what the router sends workers
                     (default: ${defaultContract()}, when it exists)
                     A claude router starts with --dangerously-skip-permissions unless you pass a permission mode after --
                     When its LEDGER.md lists tasks, a new router is first asked to take them over
  am router restart [name]
                     Replace a router with a fresh session started the same way; the new one picks up from LEDGER.md.
                     Run it from your own terminal, not from inside the router
  am router stop [name]
                     Stop the router; its LEDGER.md stays for the next start

  Everything else goes through am: am list, am open <name>, ...`;

const SKIP_PERMISSIONS = "--dangerously-skip-permissions";
const TAKE_OVER = "Take over from LEDGER.md.";

class UsageError extends Error {}

function defaultContract(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "agent-master", "worker-contract.md");
}

/** Runs am as the user would: the router depends on am's command line only. */
function am(args: string[], capture = false, input?: string): SpawnSyncReturns<string> {
  // The router itself takes no worker contract: only the workers it starts do, through --env below.
  const { AM_CONTRACT: _, ...env } = process.env;
  const result = spawnSync(process.env.AM_BIN ?? "am", args, { encoding: "utf8", env, input, stdio: [input === undefined ? "inherit" : "pipe", capture ? "pipe" : "inherit", capture ? "pipe" : "inherit"] });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    throw new Error("am not found on PATH; install it first (am install in the agent-master repo)");
  }
  if (result.error) throw result.error;
  return result;
}

/** A conversation choice would defeat a fresh start, so restart never repeats one. */
function withoutResume(kind: string, args: string[]): string[] {
  if (kind !== "claude") return args;
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (["--resume", "-r"].includes(args[i])) {
      if (args[i + 1] !== undefined && !args[i + 1].startsWith("-")) i++;
      continue;
    }
    if (["--continue", "-c"].includes(args[i]) || args[i].startsWith("--resume=")) continue;
    out.push(args[i]);
  }
  return out;
}

function running(name: string): string | undefined {
  const status = am(["status", name, "--json"], true);
  if (status.status !== 0) return undefined;
  const { state } = JSON.parse(status.stdout);
  return state === "exited" ? undefined : state;
}

/** Writes the router's home and starts it there; on a ledger with tasks, asks it to take them over. */
async function launch(name: string, options: SavedStart): Promise<number> {
  // A Claude router runs without permission prompts unless its own arguments choose a mode.
  // It takes the flag: Claude Code ignores a bypass default written in project settings.
  const choosesMode = options.args.some((arg) => arg === SKIP_PERMISSIONS || arg.startsWith("--permission-mode"));
  const agentArgs = options.kind === "claude" && !choosesMode ? [SKIP_PERMISSIONS, ...options.args] : options.args;

  const home = routerHome(name);
  await writeHome(home, { project: options.project, workerKind: options.workerKind, contract: options.contract });
  await saveStart(home, { ...options, args: withoutResume(options.kind, options.args) });
  const started = am([
    "start", name, "--kind", options.kind, "--cwd", home,
    ...(options.model ? ["--model", options.model] : []),
    // Workers the router starts inherit it: am attaches the contract to what it sends them.
    ...(options.contract ? ["--env", `AM_CONTRACT=${options.contract}`] : []),
    ...(agentArgs.length ? ["--", ...agentArgs] : []),
  ]);
  if (started.status !== 0) return started.status ?? 1;
  if (!options.contract) process.stdout.write(`note: no worker contract (${defaultContract()} does not exist); workers get only the user's words\n`);
  if (await ledgerHasTasks(home)) {
    const kickoff = am(["prompt", name, "-"], true, TAKE_OVER);
    if (kickoff.status !== 0) process.stderr.write(`am router: could not ask ${name} to take over its ledger: ${kickoff.stderr.trim()}\n`);
    else process.stdout.write(`${name} is taking over the tasks in ${join(home, "LEDGER.md")}\n`);
  }
  process.stdout.write(`${name} routes your requests to workers in ${options.project} unless you name another directory; talk to it with: am open ${name}\n`);
  return 0;
}

async function start(args: string[]): Promise<number> {
  const { values, tokens } = parseArgs({
    args,
    allowPositionals: true,
    tokens: true,
    options: {
      kind: { type: "string" },
      model: { type: "string" },
      project: { type: "string" },
      "worker-kind": { type: "string" },
      contract: { type: "string" },
    },
  });
  // The name comes before "--"; the router agent's own arguments after it.
  const end = tokens.find((token) => token.kind === "option-terminator")?.index ?? args.length;
  const positional = (keep: (index: number) => boolean) =>
    tokens.flatMap((token) => (token.kind === "positional" && keep(token.index) ? [token.value] : []));
  const [name = "router", extra] = positional((index) => index < end);
  if (extra !== undefined) throw new UsageError(`unexpected argument: ${extra} (native agent arguments go after --)`);
  const native = positional((index) => index > end);

  const project = resolve(values.project ?? process.cwd());
  if (!(await stat(project).then((s) => s.isDirectory(), () => false))) throw new UsageError(`--project is not a directory: ${project}`);
  const exists = (path: string) => access(path).then(() => true, () => false);
  let contract: string | undefined;
  if (values.contract !== undefined) {
    contract = resolve(values.contract);
    if (!(await exists(contract))) throw new UsageError(`--contract does not exist: ${contract}`);
  } else if (await exists(defaultContract())) {
    contract = defaultContract();
  }

  // Its instructions are rewritten on every start, so never under a router that is still running.
  const state = running(name);
  if (state) throw new Error(`${name} is already running (${state}); talk to it with: am open ${name}, or replace it with a fresh session: am router restart ${name}`);

  return launch(name, { kind: values.kind ?? "claude", model: values.model, project, workerKind: values["worker-kind"] ?? "claude", contract, args: native });
}

async function restart(args: string[]): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const [name = "router", extra] = positionals;
  if (extra !== undefined) throw new UsageError(`unexpected argument: ${extra}`);
  const saved = await loadStart(routerHome(name));
  if (!saved) throw new UsageError(`no saved start options for ${name}; start it with am router start`);
  if (running(name)) {
    const stopped = am(["stop", name]);
    if (stopped.status !== 0) return stopped.status ?? 1;
  }
  return launch(name, saved);
}

async function stop(args: string[]): Promise<number> {
  const { positionals } = parseArgs({ args, allowPositionals: true, options: {} });
  const [name = "router", extra] = positionals;
  if (extra !== undefined) throw new UsageError(`unexpected argument: ${extra}`);
  if (!running(name)) throw new Error(`${name} is not running`);
  return am(["stop", name]).status ?? 1;
}

async function main([command, ...rest]: string[]): Promise<number> {
  switch (command) {
    case "start":
      return start(rest);
    case "restart":
      return restart(rest);
    case "stop":
      return stop(rest);
    case undefined:
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(`${USAGE}\n`);
      return 0;
    default:
      throw new UsageError(`unknown command: ${command}\n\n${USAGE}`);
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    const usage = error instanceof UsageError || String((error as NodeJS.ErrnoException)?.code).startsWith("ERR_PARSE_ARGS");
    process.stderr.write(`am router: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(usage ? 2 : 1);
  },
);
