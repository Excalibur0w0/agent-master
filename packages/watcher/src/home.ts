// A watcher's configuration (the user's am.json, "watchers") and its files.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const GUIDE = fileURLToPath(new URL("../WATCHER.md", import.meta.url));

/** One entry of "watchers" in ~/.config/agent-master/am.json. */
export interface WatcherConfig {
  description?: string;
  /** The poller: argv of a command that prints {"pending": [...]} lines (see README). */
  poll: string[];
  /** A file with what the watcher must know about this source, appended to its instructions. */
  instructions?: string;
  /** Command prefixes the watcher may run (the source's read-only tools); nothing else runs. */
  commands?: string[];
  /** The Claude model; default: Claude Code's. */
  model?: string;
  /** Items per wake-up (default 20). */
  batch?: number;
  /** Whose ledger its entries go to (default: router). */
  router?: string;
  /** How the temporary workers for auto entries start (see auto.ts). */
  auto?: AutoStart;
}

/**
 * Overrides for a temporary worker's start. Unset, it starts as the router's workers do: the router's project,
 * the profile named after its worker kind (else that kind), and its worker contract (see auto.ts).
 */
export interface AutoStart {
  profile?: string;
  kind?: string;
  /** Claude asks once to trust a new directory: trust it beforehand. */
  cwd?: string;
  contract?: string;
}

export class UsageError extends Error {}

export function configPath(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "agent-master", "am.json");
}

/** `~` and a leading `~/` mean the home directory, as in a shell. */
export function expandHome(value: string): string {
  if (value === "~") return homedir();
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

const strings = (value: unknown) => Array.isArray(value) && value.every((v) => typeof v === "string");

export async function loadWatchers(path = configPath()): Promise<Record<string, WatcherConfig>> {
  let doc: any;
  try {
    doc = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new UsageError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  const watchers: Record<string, WatcherConfig> = {};
  for (const [name, raw] of Object.entries<any>(doc?.watchers ?? {})) {
    const bad = (what: string) => new UsageError(`${path}: watcher "${name}": ${what}`);
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw bad("the name must match [a-z][a-z0-9_-]{0,31}");
    if (!raw || typeof raw !== "object") throw bad("must be an object");
    if (!strings(raw.poll) || !raw.poll.length) throw bad("poll must be the poller's argv, an array of strings");
    if (raw.commands !== undefined && !strings(raw.commands)) throw bad("commands must be an array of strings");
    for (const key of ["description", "instructions", "model", "router"]) if (raw[key] !== undefined && typeof raw[key] !== "string") throw bad(`${key} must be a string`);
    if (raw.batch !== undefined && !(Number.isInteger(raw.batch) && raw.batch > 0)) throw bad("batch must be a positive integer");
    if (raw.auto !== undefined) {
      if (!raw.auto || typeof raw.auto !== "object") throw bad("auto must be an object");
      for (const key of ["profile", "kind", "cwd", "contract"]) if (raw.auto[key] !== undefined && typeof raw.auto[key] !== "string") throw bad(`auto.${key} must be a string`);
    }
    watchers[name] = {
      ...raw,
      poll: raw.poll.map(expandHome),
      commands: (raw.commands ?? []).map((c: string) => c.split(" ").map(expandHome).join(" ")),
      ...(raw.instructions ? { instructions: expandHome(raw.instructions) } : {}),
      ...(raw.auto
        ? {
            auto: {
              ...raw.auto,
              ...(raw.auto.cwd ? { cwd: expandHome(raw.auto.cwd) } : {}),
              ...(raw.auto.contract ? { contract: expandHome(raw.auto.contract) } : {}),
            },
          }
        : {}),
    };
  }
  return watchers;
}

/** The named watcher, or the only one when no name is given. */
export function pick(watchers: Record<string, WatcherConfig>, name?: string): [string, WatcherConfig] {
  const names = Object.keys(watchers);
  if (!names.length) throw new UsageError(`no watchers in ${configPath()} (add one under "watchers"; see am watcher help)`);
  if (name === undefined) {
    if (names.length > 1) throw new UsageError(`name a watcher: ${names.join(", ")}`);
    return [names[0], watchers[names[0]]];
  }
  if (!watchers[name]) throw new UsageError(`no watcher named ${name} in ${configPath()} (watchers: ${names.join(", ")})`);
  return [name, watchers[name]];
}

/** Its own directory (state, log, instructions); the agent works in `desk` below it and sees nothing else. */
export function watcherDir(name: string): string {
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "agent-master", "watcher", name);
}

export const deskDir = (name: string) => join(watcherDir(name), "desk");
export const instructionsFile = (name: string) => join(watcherDir(name), "INSTRUCTIONS.md");
export const stateFile = (name: string) => join(watcherDir(name), "state.json");
export const logFile = (name: string) => join(watcherDir(name), "feed.log");
export const rulesFile = (name: string) => join(deskDir(name), "RULES.md");
export const focusFile = (name: string) => join(watcherDir(name), "focus.json");

/**
 * A conversation the user asked the watcher to watch closely. The poller reads focus.json from $AM_WATCHER_DIR
 * on every look: it reports every new message there from others, not only mentions, marked "focus": true, and
 * "auto": true when the user wants matters from it handled without waiting for them.
 */
export interface Focus {
  /** The source's id for the conversation, such as a group id. */
  id: string;
  auto?: boolean;
  note?: string;
  since: string;
}

export async function loadFocus(name: string): Promise<Focus[]> {
  try {
    const value = JSON.parse(await readFile(focusFile(name), "utf8"));
    return Array.isArray(value?.conversations) ? value.conversations.filter((c: Focus) => typeof c?.id === "string") : [];
  } catch {
    return [];
  }
}

export async function saveFocus(name: string, conversations: Focus[]): Promise<void> {
  await mkdir(watcherDir(name), { recursive: true });
  const tmp = `${focusFile(name)}.${process.pid}.tmp`;
  await writeFile(tmp, `${JSON.stringify({ conversations }, null, 2)}\n`);
  await rename(tmp, focusFile(name));
}

/** The ledger its entries go to. */
export const routerOf = (config: WatcherConfig) => config.router ?? "router";

/** How it records what needs the user: the only am command it may run. */
export const RECORD = "am ledger inbox";

export function rulesTemplate(name: string): string {
  return `# Rules: ${name}

<!-- Your corrections. The watcher reads this before every batch and follows it over its own
judgment. It adds a line when you correct it in its session; you can edit this file yourself too.
Created once, never overwritten. -->

## People

## Priorities
`;
}

export async function renderInstructions(name: string, config: WatcherConfig): Promise<string> {
  const source = config.instructions ? (await readFile(config.instructions, "utf8")).trim() : "No source instructions were configured.";
  const tools = `\n\nThe commands you can run (Bash), and nothing else:\n${[RECORD, ...(config.commands ?? [])].map((c) => `- \`${c} ...\``).join("\n")}`;
  return (await readFile(GUIDE, "utf8"))
    .replaceAll("{{NAME}}", name)
    .replaceAll("{{DESCRIPTION}}", config.description ?? "no description")
    .replace("{{SOURCE}}", `${source}${tools}`);
}

/** Rewrites the instructions; creates the rules once, never replacing them. */
export async function writeHome(name: string, config: WatcherConfig): Promise<void> {
  await mkdir(deskDir(name), { recursive: true });
  await writeFile(instructionsFile(name), await renderInstructions(name, config));
  await writeFile(rulesFile(name), rulesTemplate(name), { flag: "wx" }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
}

/**
 * The Claude Code arguments that keep a watcher read-only: no settings files
 * but am's, no MCP servers, file tools confined to its desk, and any tool not
 * listed here denied without asking (it handles text other people wrote).
 */
export function agentArgs(name: string, config: WatcherConfig): string[] {
  const commands = [RECORD, ...(config.commands ?? [])];
  const tools = ["Read", "Grep", "Glob", "Edit", "Write", "Bash"];
  return [
    "--restricted",
    "--strict-mcp-config",
    "--permission-mode", "dontAsk",
    "--append-system-prompt-file", instructionsFile(name),
    "--tools", tools.join(","),
    "--allowedTools", ...tools.filter((t) => t !== "Bash"), ...commands.map((c) => `Bash(${c}:*)`),
  ];
}
