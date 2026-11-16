import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GUIDE = fileURLToPath(new URL("../ROUTER.md", import.meta.url));

/** The am commands a router with permission prompts on runs without asking; approve, deny, keys and open still ask the user. */
const ALLOWED = ["list", "status", "start", "prompt", "wait", "read", "interrupt", "stop", "profiles", "resume"];

/** The router keeps its ledger in its home; editing it never needs the user. */
export const LEDGER = "LEDGER.md";

export const LEDGER_TEMPLATE = `# Ledger

<!-- Kept by the router (see "Ledger" in its CLAUDE.md / AGENTS.md). It survives router
restarts: a new router reads it first. At most 4 tasks in progress; only the user closes one. -->

## In progress

## Queued
`;

export interface RouterOptions {
  /** Where workers run unless the user names another directory. */
  project: string;
  /** The agent kind workers get unless the user names another. */
  workerKind: string;
  /** The worker contract am appends to what the router sends workers, if the user keeps one. */
  contract?: string;
}

export interface HomeFile {
  /** Relative to the router's home directory. */
  path: string;
  content: string;
}

/**
 * The router's working directory: one of its own, holding only its instructions
 * and its ledger, so the agent reads them as project instructions and keeps them
 * across compaction.
 */
export function routerHome(name: string): string {
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "agent-master", "router", name);
}

export function renderHome(guide: string, options: RouterOptions): HomeFile[] {
  const instructions = guide
    .replaceAll("{{PROJECT}}", options.project)
    .replaceAll("{{WORKER_KIND}}", options.workerKind)
    .replaceAll("{{CONTRACT}}", options.contract ?? "none configured");
  const settings = {
    permissions: {
      allow: [...ALLOWED.map((command) => `Bash(am ${command}:*)`), `Edit(./${LEDGER})`, `Write(./${LEDGER})`],
    },
  };
  return [
    // Claude Code reads CLAUDE.md; Codex, opencode and dsh read AGENTS.md (dsh reads both, and keeps one of identical copies).
    { path: "CLAUDE.md", content: instructions },
    { path: "AGENTS.md", content: instructions },
    { path: join(".claude", "settings.json"), content: `${JSON.stringify(settings, null, 2)}\n` },
  ];
}

/** Writes the router's instructions into `home`, replacing what an earlier start wrote; the ledger is created once and never replaced. */
export async function writeHome(home: string, options: RouterOptions): Promise<void> {
  for (const file of renderHome(await readFile(GUIDE, "utf8"), options)) {
    const path = join(home, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content);
  }
  await writeFile(join(home, LEDGER), LEDGER_TEMPLATE, { flag: "wx" }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
}

/** Whether the ledger lists any task (a `### ` heading outside comments). */
export async function ledgerHasTasks(home: string): Promise<boolean> {
  const text = await readFile(join(home, LEDGER), "utf8").catch(() => "");
  return /^### \S/m.test(text.replace(/<!--[\s\S]*?-->/g, ""));
}

/** What `am router start` was given, so `am router restart` can start a fresh session the same way. */
export interface SavedStart {
  kind: string;
  model?: string;
  project: string;
  workerKind: string;
  contract?: string;
  args: string[];
}

const STARTED = "router.json";

export async function saveStart(home: string, start: SavedStart): Promise<void> {
  await writeFile(join(home, STARTED), `${JSON.stringify(start, null, 2)}\n`);
}

export async function loadStart(home: string): Promise<SavedStart | undefined> {
  try {
    return JSON.parse(await readFile(join(home, STARTED), "utf8")) as SavedStart;
  } catch {
    return undefined;
  }
}
