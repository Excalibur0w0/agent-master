import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { parse as parseYaml } from "yaml";

/** Electron's userData directory for Bruno: preferences.json and the default workspace live here. */
export function brunoDataDir(): string {
  if (process.env.AM_BRUNO_DATA_DIR) return process.env.AM_BRUNO_DATA_DIR;
  switch (process.platform) {
    case "darwin":
      return join(homedir(), "Library", "Application Support", "bruno");
    case "win32":
      return join(process.env.APPDATA ?? join(homedir(), "AppData", "Roaming"), "bruno");
    default:
      return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "bruno");
  }
}

export interface Workspace {
  name: string;
  path: string;
}

export interface OpenedCollection {
  path: string;
  /** Absent for collections that Bruno versions before workspaces recorded on their own. */
  workspace?: Workspace;
}

interface Preferences {
  preferences?: { general?: { defaultWorkspacePath?: string } };
  workspaces?: { lastOpenedWorkspaces?: string[] };
  lastOpenedCollections?: string[];
}

interface WorkspaceFile {
  info?: { name?: string };
  collections?: { path?: string }[];
}

async function readPreferences(dataDir: string): Promise<Preferences> {
  try {
    return JSON.parse(await readFile(join(dataDir, "preferences.json"), "utf8")) as Preferences;
  } catch {
    return {};
  }
}

async function readWorkspace(path: string): Promise<{ workspace: Workspace; collections: string[] } | undefined> {
  let file: WorkspaceFile | null;
  try {
    file = parseYaml(await readFile(join(path, "workspace.yml"), "utf8")) as WorkspaceFile | null;
  } catch {
    return undefined;
  }
  const collections = (file?.collections ?? []).flatMap((entry) =>
    typeof entry?.path === "string" && entry.path ? [resolve(path, entry.path)] : [],
  );
  return { workspace: { name: file?.info?.name ?? path, path }, collections };
}

/**
 * Collections listed in the Bruno app's workspaces (the default one and every workspace it last had
 * open), plus collections recorded by Bruno versions before workspaces.
 */
export async function openedCollections(): Promise<OpenedCollection[]> {
  const dataDir = brunoDataDir();
  const preferences = await readPreferences(dataDir);
  const workspacePaths = new Set([
    resolve(preferences.preferences?.general?.defaultWorkspacePath ?? join(dataDir, "default-workspace")),
    ...(preferences.workspaces?.lastOpenedWorkspaces ?? []).map((path) => resolve(path)),
  ]);

  const result = new Map<string, OpenedCollection>();
  for (const workspacePath of workspacePaths) {
    const loaded = await readWorkspace(workspacePath);
    for (const path of loaded?.collections ?? []) {
      if (!result.has(path)) result.set(path, { path, workspace: loaded?.workspace });
    }
  }
  for (const path of (preferences.lastOpenedCollections ?? []).map((entry) => resolve(entry))) {
    if (!result.has(path)) result.set(path, { path });
  }
  return [...result.values()];
}
