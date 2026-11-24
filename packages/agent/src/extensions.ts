import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** am's own commands; an extension cannot take one of these names. */
export const BUILTIN = new Set(["start", "profiles", "list", "open", "status", "prompt", "queue", "deliver", "wait", "read", "approve", "deny", "interrupt", "keys", "stop", "resume", "forget", "install", "uninstall", "help", "-h", "--help"]);

const PACKAGES = fileURLToPath(new URL("../../", import.meta.url));

/** Each package's own commands, as declared in its package.json. */
function manifests(packagesDir: string): Array<{ commands: Map<string, string>; am: any }> {
  const found: Array<{ commands: Map<string, string>; am: any }> = [];
  for (const dir of readdirSync(packagesDir).sort()) {
    let manifest: any;
    try {
      manifest = JSON.parse(readFileSync(join(packagesDir, dir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    const commands = new Map<string, string>();
    for (const [command, bin] of Object.entries(manifest?.am?.commands ?? {})) {
      if (typeof bin === "string" && /^[a-z][a-z0-9-]*$/.test(command) && !BUILTIN.has(command)) commands.set(command, join(packagesDir, dir, bin));
    }
    found.push({ commands, am: manifest?.am });
  }
  return found;
}

/**
 * Other packages of this repo extend am with commands of their own, declared in
 * their package.json as "am": { "commands": { "<command>": "<executable>" } }.
 * am runs them as they are and knows nothing else about them.
 */
export function extensions(packagesDir = PACKAGES): Map<string, string> {
  return new Map(manifests(packagesDir).flatMap(({ commands }) => [...commands]));
}

export interface ResumeStep {
  command: string;
  bin: string;
  args: string[];
}

/**
 * What extensions run after am resume --all, to bring back what they ran beside the
 * agents lost with the tmux server: "am": { "afterResumeAll": ["<its command>", ...args] }.
 */
export function afterResumeAll(packagesDir = PACKAGES): ResumeStep[] {
  const steps: ResumeStep[] = [];
  for (const { commands, am } of manifests(packagesDir)) {
    const [command, ...args] = Array.isArray(am?.afterResumeAll) ? am.afterResumeAll : [];
    const bin = typeof command === "string" ? commands.get(command) : undefined;
    if (bin && args.every((arg: unknown) => typeof arg === "string")) steps.push({ command, bin, args });
  }
  return steps;
}

/** Runs those steps; returns what they printed, and which failed. */
export function runAfterResumeAll(amBin: string, packagesDir = PACKAGES): string[] {
  const lines: string[] = [];
  for (const step of afterResumeAll(packagesDir)) {
    const run = spawnSync(step.bin, step.args, { encoding: "utf8", timeout: 120_000, env: { ...process.env, AM_BIN: amBin } });
    const said = (run.stdout ?? "").trimEnd();
    if (said) lines.push(said);
    if (run.status !== 0) {
      const why = (run.stderr ?? "").trim() || run.error?.message || `exit ${run.signal ?? run.status}`;
      lines.push(`am ${[step.command, ...step.args].join(" ")} failed: ${why}`);
    }
  }
  return lines;
}
