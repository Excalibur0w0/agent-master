import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GUIDE = fileURLToPath(new URL("../ROUTER.md", import.meta.url));

/** The am commands a router with permission prompts on runs without asking; approve, deny, keys and open still ask the user. */
const ALLOWED = ["list", "status", "start", "prompt", "wait", "read", "interrupt", "stop", "profiles", "resume", "ledger", "router dispatch"];

/** The markdown ledger routers kept before `am ledger`; `am router start` moves what it holds into the ledger once. */
export const LEDGER = "LEDGER.md";

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
 * The router's working directory: one of its own, holding only its instructions,
 * so the agent reads them as project instructions and keeps them across
 * compaction. Its ledger lives in the database behind `am ledger`.
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
      allow: ALLOWED.map((command) => `Bash(am ${command}:*)`),
    },
  };
  return [
    // Claude Code reads CLAUDE.md; Codex, opencode and dsh read AGENTS.md (dsh reads both, and keeps one of identical copies).
    { path: "CLAUDE.md", content: instructions },
    { path: "AGENTS.md", content: instructions },
    { path: join(".claude", "settings.json"), content: `${JSON.stringify(settings, null, 2)}\n` },
  ];
}

/** Writes the router's instructions into `home`, replacing what an earlier start wrote. */
export async function writeHome(home: string, options: RouterOptions): Promise<void> {
  for (const file of renderHome(await readFile(GUIDE, "utf8"), options)) {
    const path = join(home, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content);
  }
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
