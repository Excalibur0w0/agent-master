// The user's own settings for am, kept on their machine (never in this repo):
// $XDG_CONFIG_HOME/agent-master/am.json, by default ~/.config/agent-master/am.json.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import { AmError } from "./drivers/types.ts";
import { AGENT_KINDS, type AgentKind } from "./registry.ts";

/** A named set of `am start` options: `am start <name> --profile <profile>`. */
export interface Profile {
  kind: AgentKind;
  bin?: string;
  model?: string;
  env?: Record<string, string>;
  /** Native agent arguments, as after `--`. */
  args?: string[];
  /** A worker contract file attached to the prompts am sends this agent. */
  contract?: string;
  /** One line on when to use it; `am profiles` shows it. */
  description?: string;
}

export interface AmConfig {
  profiles: Record<string, Profile>;
  /** A turn with no output for this long is reported as `stalled` (no_output). */
  stallAfterMinutes: number;
}

export const DEFAULT_STALL_AFTER_MINUTES = 15;

export function configPath(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "agent-master", "am.json");
}

/** `~` and a leading `~/` mean the home directory, as in a shell. */
export function expandHome(value: string): string {
  if (value === "~") return homedir();
  return value.startsWith("~/") ? join(homedir(), value.slice(2)) : value;
}

const isStringRecord = (value: unknown): value is Record<string, string> =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((v) => typeof v === "string");

function checkProfile(name: string, raw: any, path: string): Profile {
  const bad = (what: string) => new AmError("bad_config", `${path}: profile "${name}": ${what}`);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw bad("must be an object");
  if (!(AGENT_KINDS as readonly string[]).includes(raw.kind)) throw bad(`kind must be one of: ${AGENT_KINDS.join(", ")}`);
  for (const key of ["bin", "model", "contract", "description"] as const) {
    if (raw[key] !== undefined && typeof raw[key] !== "string") throw bad(`${key} must be a string`);
  }
  if (raw.env !== undefined && !isStringRecord(raw.env)) throw bad("env must map names to strings");
  if (raw.args !== undefined && !(Array.isArray(raw.args) && raw.args.every((a: unknown) => typeof a === "string"))) throw bad("args must be an array of strings");
  return raw as Profile;
}

/** A missing file means no profiles and default settings; a broken one is an error. */
export async function loadConfig(path = configPath()): Promise<AmConfig> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { profiles: {}, stallAfterMinutes: DEFAULT_STALL_AFTER_MINUTES };
    throw error;
  }
  let doc: any;
  try {
    doc = JSON.parse(text);
  } catch (error) {
    throw new AmError("bad_config", `${path} is not valid JSON: ${(error as Error).message}`);
  }
  const profiles: Record<string, Profile> = {};
  for (const [name, raw] of Object.entries(doc?.profiles ?? {})) profiles[name] = checkProfile(name, raw, path);
  const stall = doc?.stallAfterMinutes ?? DEFAULT_STALL_AFTER_MINUTES;
  if (typeof stall !== "number" || !(stall > 0)) throw new AmError("bad_config", `${path}: stallAfterMinutes must be a positive number`);
  return { profiles, stallAfterMinutes: stall };
}

let cached: Promise<AmConfig> | undefined;

/** The config, read once per process. */
export function config(): Promise<AmConfig> {
  cached ??= loadConfig();
  return cached;
}

export function findProfile(cfg: AmConfig, name: string): Profile {
  const profile = cfg.profiles[name];
  if (!profile) {
    const known = Object.keys(cfg.profiles);
    throw new AmError("unknown_profile", `no profile named ${name} in ${configPath()}${known.length ? ` (profiles: ${known.join(", ")})` : " (it defines no profiles)"}`);
  }
  return profile;
}

/** Profile values with `~/` paths expanded: its bin, its contract and native arguments that are paths. */
export function profileLaunch(profile: Profile): Required<Pick<Profile, "kind" | "env" | "args">> & Pick<Profile, "bin" | "model" | "contract"> {
  return {
    kind: profile.kind,
    bin: profile.bin === undefined ? undefined : expandHome(profile.bin),
    model: profile.model,
    env: { ...profile.env },
    args: (profile.args ?? []).map(expandHome),
    contract: profile.contract === undefined ? undefined : expandHome(profile.contract),
  };
}

/** Where a contract file lives: `~/` expanded, relative paths from the caller's directory. */
export function contractPath(file: string): string {
  return resolve(expandHome(file));
}
