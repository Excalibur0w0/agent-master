import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface HostProfile {
  /** e.g. "Ubuntu 24.04 (GNU coreutils)". */
  os?: string;
  /** Login shell on that host, e.g. "bash". */
  shell?: string;
  notes?: string;
}

export interface ShellAskConfig {
  /** opencode model, `provider/model`. */
  model: string;
  opencodeBin: string;
  timeoutMs: number;
  /** Keys are ssh destinations as typed (alias or hostname); `*` matches any run of characters. */
  hosts: Record<string, HostProfile>;
  /** Used for ssh destinations that match no entry in `hosts`. */
  defaultRemote: Required<Pick<HostProfile, "os" | "shell">>;
}

export const DEFAULT_CONFIG: ShellAskConfig = {
  // Pinned version: `~...-latest` aliases can silently switch models and pricing.
  model: "openrouter/deepseek/deepseek-v4.1-flash",
  opencodeBin: "opencode",
  timeoutMs: 60_000,
  hosts: {},
  defaultRemote: { os: "Linux (assume GNU coreutils; distribution unknown)", shell: "bash" },
};

export function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "agent-master");
}

export function configPath(): string {
  return process.env.AM_SHELL_ASK_CONFIG ?? join(configDir(), "shell-ask.json");
}

export async function loadConfig(): Promise<ShellAskConfig> {
  let raw = "";
  try {
    raw = await readFile(configPath(), "utf8");
  } catch {
    // No config file: defaults only.
  }
  const file = raw ? (JSON.parse(raw) as Partial<ShellAskConfig>) : {};
  const config: ShellAskConfig = {
    ...DEFAULT_CONFIG,
    ...file,
    hosts: { ...DEFAULT_CONFIG.hosts, ...file.hosts },
    defaultRemote: { ...DEFAULT_CONFIG.defaultRemote, ...file.defaultRemote },
  };
  if (process.env.AM_SHELL_ASK_MODEL) config.model = process.env.AM_SHELL_ASK_MODEL;
  if (process.env.AM_OPENCODE_BIN) config.opencodeBin = process.env.AM_OPENCODE_BIN;
  return config;
}
