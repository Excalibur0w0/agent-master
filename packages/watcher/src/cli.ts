import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { loadState } from "./feed.ts";
import { agentArgs, configPath, deskDir, loadWatchers, logFile, pick, routerOf, rulesFile, stateFile, UsageError, watcherDir, writeHome } from "./home.ts";
import { run, withoutContract } from "./run.ts";

const USAGE = `am watcher — a long-running Claude session that watches a message source and puts what needs you up for
review in the ledger (am ledger show, "For review"; am ledger inbox)

  am watcher start [name]  Start the watcher (default: the only one configured): its Claude session, am agent
                             <name>, read-only (no MCP servers, no settings files but am's, only its own files and the
                             source's commands), and its feed loop in tmux session am-<name>-feed. Starts whichever
                             of the two is not running
  am watcher stop [name]   Stop both; its entries, rules and state stay for the next start
  am watcher status [name] Its Claude session and feed loop, what is pending or queued, what is up for review
  am watcher list          The watchers configured in your am.json
  am watcher run <name>    The feed loop itself (what start runs in tmux): runs the source's poller, and wakes the
                             watcher through am prompt when it is idle and new items are queued

  Configure a watcher under "watchers" in ${configPath()}:
    "<name>": { "poll": ["node", "/path/poll.js"], "instructions": "/path/SOURCE.md",
                "commands": ["node /path/context.js"], "description": "...", "model": "...", "batch": 20 }
  The poller prints one JSON line {"pending": [{"id": "...", ...}]} with everything pending whenever that may have
  changed; the loop works out what is new and what the user has read elsewhere.
  "router" (default: router) names whose ledger the entries go to.
  Files: ~/.local/state/agent-master/watcher/<name>/desk/RULES.md (your corrections), feed.log, state.json`;

const tmuxBin = process.env.AM_TMUX ?? "tmux";
const tmux = (args: string[]) => spawnSync(tmuxBin, args, { encoding: "utf8" });
const feedSession = (name: string) => `am-${name}-feed`;
const feeding = (name: string) => tmux(["has-session", "-t", `=${feedSession(name)}`]).status === 0;

function am(args: string[], capture = true): SpawnSyncReturns<string> {
  const result = spawnSync(process.env.AM_BIN ?? "am", args, { encoding: "utf8", env: withoutContract(), stdio: capture ? "pipe" : "inherit" });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") throw new Error("am not found on PATH; install it first (am install in the agent-master repo)");
  if (result.error) throw result.error;
  return result;
}

/** The watcher agent's state, or undefined when it is not running. */
function agentState(name: string): any {
  const status = am(["status", name, "--json"]);
  if (status.status !== 0) return undefined;
  const view = JSON.parse(status.stdout);
  return view.state === "exited" ? undefined : view;
}

function startFeed(name: string): void {
  // The loop runs on the tmux server's environment; hand it what decides where things are.
  const env = ["PATH", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "AM_STATE_DIR", "AM_TMUX"].flatMap((key) => (process.env[key] ? ["-e", `${key}=${process.env[key]}`] : []));
  const amBin = process.env.AM_BIN ?? "am";
  const created = tmux(["new-session", "-d", "-s", feedSession(name), "-c", watcherDir(name), "-e", `AM_BIN=${amBin}`, ...env, fileURLToPath(new URL("../bin/am-watcher", import.meta.url)), "run", name]);
  if (created.status !== 0) throw new Error(`could not start the feed loop: ${created.stderr.trim()}`);
}

async function start(name: string | undefined): Promise<number> {
  const [chosen, config] = pick(await loadWatchers(), name);
  await writeHome(chosen, config);
  const agent = agentState(chosen);
  const feed = feeding(chosen);
  if (agent && feed) {
    process.stdout.write(`${chosen} is already running (${agent.state}); see am watcher status ${chosen}\n`);
    return 0;
  }
  if (!agent) {
    const started = am(
      [
        "start", chosen, "--kind", "claude", "--cwd", deskDir(chosen),
        ...(config.model ? ["--model", config.model] : []),
        // The source's commands find the feed state here (to stay within the items it was given).
        "--env", `AM_WATCHER_DIR=${watcherDir(chosen)}`,
        // Its am ledger inbox commands record entries as this watcher, in this router's ledger.
        "--env", `AM_WATCHER=${chosen}`,
        "--env", `AM_ROUTER=${routerOf(config)}`,
        "--", ...agentArgs(chosen, config),
      ],
      false,
    );
    if (started.status !== 0) {
      process.stderr.write(`am watcher: ${chosen}'s Claude session did not start; fix that (am open ${chosen} if it waits for you), then run am watcher start ${chosen} again\n`);
      return started.status ?? 1;
    }
  }
  if (!feed) startFeed(chosen);
  process.stdout.write(
    [
      `${chosen} is running: Claude session am-${chosen} (am open ${chosen}), feed loop ${feedSession(chosen)}`,
      `what needs you: am ledger show (For review) or am ledger inbox list --router ${routerOf(config)}`,
      `your corrections: ${rulesFile(chosen)}`,
    ].join("\n") + "\n",
  );
  return 0;
}

async function stop(name: string | undefined): Promise<number> {
  const [chosen] = pick(await loadWatchers(), name);
  let stopped = false;
  if (feeding(chosen)) {
    tmux(["kill-session", "-t", `=${feedSession(chosen)}`]);
    stopped = true;
  }
  if (agentState(chosen)) {
    const result = am(["stop", chosen], false);
    if (result.status !== 0) return result.status ?? 1;
    stopped = true;
  }
  process.stdout.write(stopped ? `stopped ${chosen}; its entries stay in the ledger (am ledger inbox list)\n` : `${chosen} is not running\n`);
  return 0;
}

async function status(name: string | undefined): Promise<number> {
  const [chosen, config] = pick(await loadWatchers(), name);
  const agent = agentState(chosen);
  const state = await loadState(stateFile(chosen));
  const delivered = Object.values(state.delivered).filter((d) => !d.gone).length;
  const entries = am(["ledger", "inbox", "list", "--router", routerOf(config), "--json"]);
  let review = "unknown (am ledger failed)";
  try {
    const mine = (JSON.parse(entries.stdout) as Array<{ watcher: string; priority: string }>).filter((e) => e.watcher === chosen);
    review = `${mine.length} entr${mine.length === 1 ? "y" : "ies"} (${["urgent", "normal", "low"].map((p) => `${mine.filter((e) => e.priority === p).length} ${p}`).join(", ")})`;
  } catch {}
  let tail: string[] = [];
  try {
    tail = readFileSync(logFile(chosen), "utf8").trimEnd().split("\n").slice(-5);
  } catch {
    tail = [];
  }
  process.stdout.write(
    [
      `${chosen}: Claude session ${agent ? `${agent.state}${agent.detail ? ` (${agent.detail})` : ""}` : "not running"}; feed loop ${feeding(chosen) ? "running" : "not running"}`,
      `feed: ${state.pending.length} pending, ${delivered} given to the watcher, ${state.queue.items.length} new waiting for it`,
      `up for review in ${routerOf(config)}'s ledger: ${review}; see am ledger show`,
      `rules: ${rulesFile(chosen)}`,
      ...(tail.length ? ["log:", ...tail.map((line) => `  ${line}`)] : []),
    ].join("\n") + "\n",
  );
  return 0;
}

async function list(): Promise<number> {
  const watchers = await loadWatchers();
  const names = Object.keys(watchers);
  process.stdout.write(names.length ? names.map((n) => `${n}  ${watchers[n].description ?? ""}\n  poll: ${watchers[n].poll.join(" ")}`).join("\n") + "\n" : `no watchers in ${configPath()}\n`);
  return 0;
}

async function main([command, ...rest]: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: rest, allowPositionals: true, options: {} });
  if (positionals.length > 1) throw new UsageError(`unexpected argument: ${positionals[1]}`);
  const [name] = positionals;
  switch (command) {
    case "start":
      return start(name);
    case "stop":
      return stop(name);
    case "status":
      return status(name);
    case "list":
      return list();
    case "run": {
      if (!name) throw new UsageError("am watcher run needs the watcher's name");
      const [chosen, config] = pick(await loadWatchers(), name);
      await run(chosen, config);
      return -1; // Runs until stopped.
    }
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
  (code) => {
    if (code >= 0) process.exit(code);
  },
  (error: unknown) => {
    const usage = error instanceof UsageError || String((error as NodeJS.ErrnoException)?.code).startsWith("ERR_PARSE_ARGS");
    process.stderr.write(`am watcher: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(usage ? 2 : 1);
  },
);
