// A subscriber's configuration (the user's am.json, "subscribers") and its files.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const GUIDE = fileURLToPath(new URL("../SUBSCRIBER.md", import.meta.url));

/** One entry of "subscribers" in ~/.config/agent-master/am.json. */
export interface SubscriberConfig {
  description?: string;
  /** The watcher: argv of a command that prints {"pending": [...]} lines (see README). */
  watch: string[];
  /** A file with what the subscriber must know about this source, appended to its instructions. */
  instructions?: string;
  /** Command prefixes the subscriber may run (the source's read-only tools); nothing else runs. */
  commands?: string[];
  /** The Claude model; default: Claude Code's. */
  model?: string;
  /** Items per wake-up (default 20). */
  batch?: number;
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

export async function loadSubscribers(path = configPath()): Promise<Record<string, SubscriberConfig>> {
  let doc: any;
  try {
    doc = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new UsageError(`${path} is not valid JSON: ${(error as Error).message}`);
  }
  const subscribers: Record<string, SubscriberConfig> = {};
  for (const [name, raw] of Object.entries<any>(doc?.subscribers ?? {})) {
    const bad = (what: string) => new UsageError(`${path}: subscriber "${name}": ${what}`);
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) throw bad("the name must match [a-z][a-z0-9_-]{0,31}");
    if (!raw || typeof raw !== "object") throw bad("must be an object");
    if (!strings(raw.watch) || !raw.watch.length) throw bad("watch must be the watcher's argv, an array of strings");
    if (raw.commands !== undefined && !strings(raw.commands)) throw bad("commands must be an array of strings");
    for (const key of ["description", "instructions", "model"]) if (raw[key] !== undefined && typeof raw[key] !== "string") throw bad(`${key} must be a string`);
    if (raw.batch !== undefined && !(Number.isInteger(raw.batch) && raw.batch > 0)) throw bad("batch must be a positive integer");
    subscribers[name] = {
      ...raw,
      watch: raw.watch.map(expandHome),
      commands: (raw.commands ?? []).map((c: string) => c.split(" ").map(expandHome).join(" ")),
      ...(raw.instructions ? { instructions: expandHome(raw.instructions) } : {}),
    };
  }
  return subscribers;
}

/** The named subscriber, or the only one when no name is given. */
export function pick(subscribers: Record<string, SubscriberConfig>, name?: string): [string, SubscriberConfig] {
  const names = Object.keys(subscribers);
  if (!names.length) throw new UsageError(`no subscribers in ${configPath()} (add one under "subscribers"; see am subscribe help)`);
  if (name === undefined) {
    if (names.length > 1) throw new UsageError(`name a subscriber: ${names.join(", ")}`);
    return [names[0], subscribers[names[0]]];
  }
  if (!subscribers[name]) throw new UsageError(`no subscriber named ${name} in ${configPath()} (subscribers: ${names.join(", ")})`);
  return [name, subscribers[name]];
}

/** Its own directory (state, log, instructions); the agent works in `desk` below it and sees nothing else. */
export function subscriberDir(name: string): string {
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "agent-master", "subscriber", name);
}

export const deskDir = (name: string) => join(subscriberDir(name), "desk");
export const instructionsFile = (name: string) => join(subscriberDir(name), "INSTRUCTIONS.md");
export const stateFile = (name: string) => join(subscriberDir(name), "state.json");
export const logFile = (name: string) => join(subscriberDir(name), "watch.log");
export const summaryFile = (name: string) => join(deskDir(name), "SUMMARY.md");
export const rulesFile = (name: string) => join(deskDir(name), "RULES.md");

export function summaryTemplate(name: string): string {
  return `# Summary: ${name}
Updated: -

<!-- Kept by the subscriber. Each entry ends with the ids of the items it covers. -->

## Urgent

## Normal

## Low

## Done
`;
}

export function rulesTemplate(name: string): string {
  return `# Rules: ${name}

<!-- Your corrections. The subscriber reads this before every batch and follows it over its own
judgment. It adds a line when you correct it in its session; you can edit this file yourself too.
Created once, never overwritten. -->

## People

## Priorities
`;
}

export async function renderInstructions(name: string, config: SubscriberConfig): Promise<string> {
  const source = config.instructions ? (await readFile(config.instructions, "utf8")).trim() : "No source instructions were configured.";
  const tools = config.commands?.length
    ? `\n\nThe commands you can run (Bash), and nothing else:\n${config.commands.map((c) => `- \`${c} ...\``).join("\n")}`
    : "\n\nYou have no commands to run.";
  return (await readFile(GUIDE, "utf8"))
    .replaceAll("{{NAME}}", name)
    .replaceAll("{{DESCRIPTION}}", config.description ?? "no description")
    .replace("{{SOURCE}}", `${source}${tools}`);
}

/** Rewrites the instructions; creates the summary and the rules once, never replacing them. */
export async function writeHome(name: string, config: SubscriberConfig): Promise<void> {
  await mkdir(deskDir(name), { recursive: true });
  await writeFile(instructionsFile(name), await renderInstructions(name, config));
  for (const [path, content] of [[summaryFile(name), summaryTemplate(name)], [rulesFile(name), rulesTemplate(name)]]) {
    await writeFile(path, content, { flag: "wx" }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
  }
}

/**
 * The Claude Code arguments that keep a subscriber read-only: no settings files
 * but am's, no MCP servers, file tools confined to its desk, and any tool not
 * listed here denied without asking (it handles text other people wrote).
 */
export function agentArgs(name: string, config: SubscriberConfig): string[] {
  const commands = config.commands ?? [];
  const tools = ["Read", "Grep", "Glob", "Edit", "Write", ...(commands.length ? ["Bash"] : [])];
  return [
    "--restricted",
    "--strict-mcp-config",
    "--permission-mode", "dontAsk",
    "--append-system-prompt-file", instructionsFile(name),
    "--tools", tools.join(","),
    "--allowedTools", ...tools.filter((t) => t !== "Bash"), ...commands.map((c) => `Bash(${c}:*)`),
  ];
}
