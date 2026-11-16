import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { loadState } from "./feed.ts";
import { agentArgs, configPath, deskDir, loadSubscribers, logFile, pick, rulesFile, stateFile, subscriberDir, summaryFile, UsageError, writeHome } from "./home.ts";
import { run, withoutContract } from "./run.ts";

const USAGE = `am subscribe — a long-running Claude session that watches a message source and keeps a summary of what needs you

  am subscribe start [name]  Start the subscriber (default: the only one configured): its Claude session, am agent
                             <name>, read-only (no MCP servers, no settings files but am's, only its own files and the
                             source's commands), and its watcher loop in tmux session am-<name>-watch. Starts whichever
                             of the two is not running
  am subscribe stop [name]   Stop both; its summary, rules and state stay for the next start
  am subscribe status [name] Its session and watcher, what is pending or queued, where the summary is
  am subscribe list          The subscribers configured in your am.json
  am subscribe run <name>    The watcher loop itself (what start runs in tmux): runs the source's watcher, and wakes the
                             subscriber through am prompt when it is idle and new items are queued

  Configure a subscriber under "subscribers" in ${configPath()}:
    "<name>": { "watch": ["node", "/path/watch.js"], "instructions": "/path/SOURCE.md",
                "commands": ["node /path/context.js"], "description": "...", "model": "...", "batch": 20 }
  The watcher prints one JSON line {"pending": [{"id": "...", ...}]} with everything pending whenever that may have
  changed; the loop works out what is new and what the user has read elsewhere.
  Files: ~/.local/state/agent-master/subscriber/<name>/desk/SUMMARY.md (the summary) and RULES.md (your corrections)`;

const tmuxBin = process.env.AM_TMUX ?? "tmux";
const tmux = (args: string[]) => spawnSync(tmuxBin, args, { encoding: "utf8" });
const watchSession = (name: string) => `am-${name}-watch`;
const watching = (name: string) => tmux(["has-session", "-t", `=${watchSession(name)}`]).status === 0;

function am(args: string[], capture = true): SpawnSyncReturns<string> {
  const result = spawnSync(process.env.AM_BIN ?? "am", args, { encoding: "utf8", env: withoutContract(), stdio: capture ? "pipe" : "inherit" });
  if ((result.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") throw new Error("am not found on PATH; install it first (am install in the agent-master repo)");
  if (result.error) throw result.error;
  return result;
}

/** The subscriber agent's state, or undefined when it is not running. */
function agentState(name: string): any {
  const status = am(["status", name, "--json"]);
  if (status.status !== 0) return undefined;
  const view = JSON.parse(status.stdout);
  return view.state === "exited" ? undefined : view;
}

function startWatch(name: string): void {
  // The loop runs on the tmux server's environment; hand it what decides where things are.
  const env = ["PATH", "XDG_STATE_HOME", "XDG_CONFIG_HOME", "AM_STATE_DIR", "AM_TMUX"].flatMap((key) => (process.env[key] ? ["-e", `${key}=${process.env[key]}`] : []));
  const amBin = process.env.AM_BIN ?? "am";
  const created = tmux(["new-session", "-d", "-s", watchSession(name), "-c", subscriberDir(name), "-e", `AM_BIN=${amBin}`, ...env, fileURLToPath(new URL("../bin/am-subscribe", import.meta.url)), "run", name]);
  if (created.status !== 0) throw new Error(`could not start the watcher loop: ${created.stderr.trim()}`);
}

async function start(name: string | undefined): Promise<number> {
  const [chosen, config] = pick(await loadSubscribers(), name);
  await writeHome(chosen, config);
  const agent = agentState(chosen);
  const watch = watching(chosen);
  if (agent && watch) {
    process.stdout.write(`${chosen} is already running (${agent.state}); see am subscribe status ${chosen}\n`);
    return 0;
  }
  if (!agent) {
    const started = am(
      [
        "start", chosen, "--kind", "claude", "--cwd", deskDir(chosen),
        ...(config.model ? ["--model", config.model] : []),
        // The source's commands find the feed state here (to stay within the items it was given).
        "--env", `AM_SUBSCRIBER_DIR=${subscriberDir(chosen)}`,
        "--", ...agentArgs(chosen, config),
      ],
      false,
    );
    if (started.status !== 0) {
      process.stderr.write(`am subscribe: ${chosen}'s Claude session did not start; fix that (am open ${chosen} if it waits for you), then run am subscribe start ${chosen} again\n`);
      return started.status ?? 1;
    }
  }
  if (!watch) startWatch(chosen);
  process.stdout.write(
    [
      `${chosen} is running: Claude session am-${chosen} (am open ${chosen}), watcher loop ${watchSession(chosen)}`,
      `summary: ${summaryFile(chosen)}`,
      `your corrections: ${rulesFile(chosen)}`,
    ].join("\n") + "\n",
  );
  return 0;
}

async function stop(name: string | undefined): Promise<number> {
  const [chosen] = pick(await loadSubscribers(), name);
  let stopped = false;
  if (watching(chosen)) {
    tmux(["kill-session", "-t", `=${watchSession(chosen)}`]);
    stopped = true;
  }
  if (agentState(chosen)) {
    const result = am(["stop", chosen], false);
    if (result.status !== 0) return result.status ?? 1;
    stopped = true;
  }
  process.stdout.write(stopped ? `stopped ${chosen}; its summary stays at ${summaryFile(chosen)}\n` : `${chosen} is not running\n`);
  return 0;
}

async function status(name: string | undefined): Promise<number> {
  const [chosen] = pick(await loadSubscribers(), name);
  const agent = agentState(chosen);
  const state = await loadState(stateFile(chosen));
  const delivered = Object.values(state.delivered).filter((d) => !d.gone).length;
  const updated = (path: string) => {
    try {
      return statSync(path).mtime.toLocaleString();
    } catch {
      return "not created yet";
    }
  };
  let tail: string[] = [];
  try {
    tail = readFileSync(logFile(chosen), "utf8").trimEnd().split("\n").slice(-5);
  } catch {
    tail = [];
  }
  process.stdout.write(
    [
      `${chosen}: Claude session ${agent ? `${agent.state}${agent.detail ? ` (${agent.detail})` : ""}` : "not running"}; watcher loop ${watching(chosen) ? "running" : "not running"}`,
      `feed: ${state.pending.length} pending, ${delivered} given to the subscriber, ${state.queue.items.length} new and ${state.queue.gone.length} read-elsewhere waiting for it`,
      `summary: ${summaryFile(chosen)} (updated ${updated(summaryFile(chosen))})`,
      `rules: ${rulesFile(chosen)}`,
      ...(tail.length ? ["log:", ...tail.map((line) => `  ${line}`)] : []),
    ].join("\n") + "\n",
  );
  return 0;
}

async function list(): Promise<number> {
  const subscribers = await loadSubscribers();
  const names = Object.keys(subscribers);
  process.stdout.write(names.length ? names.map((n) => `${n}  ${subscribers[n].description ?? ""}\n  watch: ${subscribers[n].watch.join(" ")}`).join("\n") + "\n" : `no subscribers in ${configPath()}\n`);
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
      if (!name) throw new UsageError("am subscribe run needs the subscriber's name");
      const [chosen, config] = pick(await loadSubscribers(), name);
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
    process.stderr.write(`am subscribe: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(usage ? 2 : 1);
  },
);
