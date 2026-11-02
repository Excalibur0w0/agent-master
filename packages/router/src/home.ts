import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const GUIDE = fileURLToPath(new URL("../ROUTER.md", import.meta.url));

/** The am commands a router runs without asking; approve, deny, keys and open still ask the user. */
const ALLOWED = ["list", "status", "start", "prompt", "wait", "read", "interrupt", "stop"];

export interface RouterOptions {
  /** Where workers run unless the user names another directory. */
  project: string;
  /** The agent kind workers get unless the user names another. */
  workerKind: string;
}

export interface HomeFile {
  /** Relative to the router's home directory. */
  path: string;
  content: string;
}

/**
 * The router's working directory: one of its own, holding only its instructions,
 * so the agent reads them as project instructions and keeps them across compaction.
 */
export function routerHome(name: string): string {
  return join(process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "agent-master", "router", name);
}

export function renderHome(guide: string, options: RouterOptions): HomeFile[] {
  const instructions = guide.replaceAll("{{PROJECT}}", options.project).replaceAll("{{WORKER_KIND}}", options.workerKind);
  const settings = { permissions: { allow: ALLOWED.map((command) => `Bash(am ${command}:*)`) } };
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
