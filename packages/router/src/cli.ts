import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { access, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { LEDGER, loadStart, routerHome, saveStart, writeHome, type SavedStart } from "./home.ts";

const USAGE = `am router — a long-running agent session that hands your requests to other coding agents through am

  am router start [name] [--kind K] [--model M] [--project DIR] [--worker-kind K] [--contract FILE]
                  [--resume | --conversation ID] [-- <native agent args>]
                     Start the router (default name: router) in tmux session am-<name>; talk to it with: am open <name>
                     --kind: the router's own agent (default claude); --worker-kind: its workers' default (default claude)
                     --project: where workers run unless you name another directory (default: the current directory)
                     --contract: the worker contract am appends to what the router sends workers
                     (default: ${defaultContract()}, when it exists)
                     A claude router starts with --dangerously-skip-permissions unless you pass a permission mode after --
                     Its ledger is am ledger (--router <name>); when it lists work, a new router is first asked to take
                     it over. A LEDGER.md left in the router's directory by an older router is moved into it first
                     --resume continues the router's last conversation instead of a new one; --conversation ID continues
                     that one (claude, codex, opencode routers)
  am router restart [name] [--resume | --conversation ID]
                     Replace a router with a new session started the same way; it picks up from its ledger.
                     Without --resume it starts on a new conversation; with it, on the conversation it has now (the
                     session field of am status <name> --json). Run it from your own terminal, not from inside the router
  am router stop [name]
                     Stop the router; its ledger stays for the next start

  Everything else goes through am: am list, am open <name>, ...`;

const SKIP_PERMISSIONS = "--dangerously-skip-permissions";
const TAKE_OVER = "Take over: your ledger lists work in flight (am ledger show).";
/** On a continued conversation the router remembers, but its background waits died with the old process. */
const TAKE_OVER_RESUMED =
  "You were restarted on this same conversation. Your background am waits ended with the old process, and your instructions may have changed: follow them as they are now. Take over: your ledger lists work in flight (am ledger show).";

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

/** The conversation to continue: the running router's current one (it follows a /resume inside it), else the last one am remembers. */
function lastConversation(name: string): string | undefined {
  const status = am(["status", name, "--json"], true);
  if (status.status === 0) {
    try {
      const view = JSON.parse(status.stdout);
      if (view.state !== "exited" && view.session) return view.session;
    } catch {}
  }
  try {
    const saved = JSON.parse(am(["list", "--saved", "--json"], true).stdout) as Array<{ name: string; session?: string }>;
    return saved.find((agent) => agent.name === name)?.session || undefined;
  } catch {
    return undefined;
  }
}

/** --conversation ID, or with --resume the router's last conversation; undefined for a new one. */
function conversationFor(name: string, values: { resume?: boolean; conversation?: string }): string | undefined {
  if (values.conversation) return values.conversation;
  if (!values.resume) return undefined;
  const id = lastConversation(name);
  if (!id) throw new UsageError(`am has no conversation recorded for ${name}; start it without --resume, or name one with --conversation ID`);
  return id;
}

function running(name: string): string | undefined {
  const status = am(["status", name, "--json"], true);
  if (status.status !== 0) return undefined;
  const { state } = JSON.parse(status.stdout);
  return state === "exited" ? undefined : state;
}

/**
 * An older router kept its ledger as LEDGER.md in its home. Called while no
 * router runs, so the file is final: its tasks move into am ledger once, and the
 * file is renamed so neither a router nor a later start uses it again.
 */
async function migrateLedger(name: string, home: string): Promise<void> {
  const file = join(home, LEDGER);
  if (!(await access(file).then(() => true, () => false))) return;
  const imported = am(["ledger", "import", file, "--router", name], true);
  if (imported.status !== 0) throw new Error(`could not move ${file} into the ledger, so ${name} was not started: ${imported.stderr.trim()}`);
  process.stdout.write(imported.stdout);
  // To the second, so a later migration never overwrites an earlier one's file.
  const done = `${file}.imported-${new Date().toISOString().slice(0, 19).replace(/:/g, "")}`;
  await rename(file, done);
  process.stdout.write(`kept the old file as ${done}\n`);
}

/** Whether the router's ledger holds tasks in progress or queued. */
function ledgerHasWork(name: string): boolean {
  const list = am(["ledger", "list", "--router", name, "--json"], true);
  try {
    return list.status === 0 && JSON.parse(list.stdout).length > 0;
  } catch {
    return false;
  }
}

/** Writes the router's home and starts it there; on a ledger with work, asks it to take it over. */
async function launch(name: string, options: SavedStart, conversation?: string): Promise<number> {
  // A Claude router runs without permission prompts unless its own arguments choose a mode.
  // It takes the flag: Claude Code ignores a bypass default written in project settings.
  const choosesMode = options.args.some((arg) => arg === SKIP_PERMISSIONS || arg.startsWith("--permission-mode"));
  const agentArgs = options.kind === "claude" && !choosesMode ? [SKIP_PERMISSIONS, ...options.args] : options.args;

  const home = routerHome(name);
  await migrateLedger(name, home);
  await writeHome(home, { project: options.project, workerKind: options.workerKind, contract: options.contract });
  await saveStart(home, { ...options, args: withoutResume(options.kind, options.args) });
  const started = am([
    "start", name, "--kind", options.kind, "--cwd", home,
    ...(options.model ? ["--model", options.model] : []),
    // Its am ledger commands go to its own ledger.
    "--env", `AM_ROUTER=${name}`,
    // Workers the router starts inherit it: am attaches the contract to what it sends them.
    ...(options.contract ? ["--env", `AM_CONTRACT=${options.contract}`] : []),
    // Never saved in router.json: a later plain restart starts a new conversation again.
    ...(conversation ? ["--conversation", conversation] : []),
    ...(agentArgs.length ? ["--", ...agentArgs] : []),
  ]);
  if (started.status !== 0) return started.status ?? 1;
  if (!options.contract) process.stdout.write(`note: no worker contract (${defaultContract()} does not exist); workers get only the user's words\n`);
  if (ledgerHasWork(name)) {
    const kickoff = am(["prompt", name, "-"], true, conversation ? TAKE_OVER_RESUMED : TAKE_OVER);
    if (kickoff.status !== 0) process.stderr.write(`am router: could not ask ${name} to take over its ledger: ${kickoff.stderr.trim()}\n`);
    else process.stdout.write(`${name} is taking over the work in its ledger (am ledger show --router ${name})\n`);
  }
  process.stdout.write(`${name} routes your requests to workers in ${options.project} unless you name another directory${conversation ? `; it continues conversation ${conversation}` : ""}; talk to it with: am open ${name}\n`);
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
      resume: { type: "boolean" },
      conversation: { type: "string" },
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
  if (state) throw new Error(`${name} is already running (${state}); talk to it with: am open ${name}, or replace it with a new session: am router restart ${name} [--resume]`);

  const conversation = conversationFor(name, values);
  return launch(name, { kind: values.kind ?? "claude", model: values.model, project, workerKind: values["worker-kind"] ?? "claude", contract, args: native }, conversation);
}

async function restart(args: string[]): Promise<number> {
  const { values, positionals } = parseArgs({ args, allowPositionals: true, options: { resume: { type: "boolean" }, conversation: { type: "string" } } });
  const [name = "router", extra] = positionals;
  if (extra !== undefined) throw new UsageError(`unexpected argument: ${extra}`);
  const saved = await loadStart(routerHome(name));
  if (!saved) throw new UsageError(`no saved start options for ${name}; start it with am router start`);
  // Read before stopping: the running router knows its current conversation.
  const conversation = conversationFor(name, values);
  if (running(name)) {
    const stopped = am(["stop", name]);
    if (stopped.status !== 0) return stopped.status ?? 1;
  }
  return launch(name, saved, conversation);
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
