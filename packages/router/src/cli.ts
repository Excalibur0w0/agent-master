import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import { routerHome, writeHome } from "./home.ts";
import { installGlobal, uninstallGlobal } from "./install.ts";

const USAGE = `am-router — a long-running agent session that hands your requests to other coding agents through am

  am-router start [name] [--kind K] [--model M] [--project DIR] [--worker-kind K] [-- <native agent args>]
                     Start the router (default name: router) in tmux session am-<name>; talk to it with: am open <name>
                     --kind: the router's own agent (default claude); --worker-kind: its workers' default (default claude)
                     --project: where workers run unless you name another directory (default: the current directory)
  am-router install | am-router uninstall
                     Link am-router into ~/.local/bin; it drives agents with am, which must be installed too (am install)

  Everything else goes through am: am list, am open <name>, am stop <name>, ...`;

class UsageError extends Error {}

/** Runs am as the user would: the router depends on am's command line only. */
function am(args: string[], capture = false): SpawnSyncReturns<string> {
  const result = spawnSync(process.env.AM_BIN ?? "am", args, { encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
    throw new Error("am not found on PATH; install it first (am install in the agent-master repo)");
  }
  if (result.error) throw result.error;
  return result;
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

  // Its instructions are rewritten on every start, so never under a router that is still running.
  const status = am(["status", name, "--json"], true);
  if (status.status === 0) {
    const { state } = JSON.parse(status.stdout);
    if (state !== "exited") throw new Error(`${name} is already running (${state}); talk to it with: am open ${name}, or stop it first: am stop ${name}`);
  }

  const home = routerHome(name);
  await writeHome(home, { project, workerKind: values["worker-kind"] ?? "claude" });
  const started = am([
    "start", name, "--kind", values.kind ?? "claude", "--cwd", home,
    ...(values.model ? ["--model", values.model] : []),
    ...(native.length ? ["--", ...native] : []),
  ]);
  if (started.status !== 0) return started.status ?? 1;
  process.stdout.write(`${name} routes your requests to workers in ${project} unless you name another directory; talk to it with: am open ${name}\n`);
  return 0;
}

async function main([command, ...rest]: string[]): Promise<number> {
  switch (command) {
    case "start":
      return start(rest);
    case "install":
    case "uninstall":
      for (const line of await (command === "install" ? installGlobal() : uninstallGlobal())) process.stdout.write(`${line}\n`);
      return 0;
    case undefined:
    case "help":
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
    process.stderr.write(`am-router: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(usage ? 2 : 1);
  },
);
