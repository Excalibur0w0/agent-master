import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** am's own commands; an extension cannot take one of these names. */
export const BUILTIN = new Set(["start", "profiles", "list", "open", "status", "prompt", "wait", "read", "approve", "deny", "interrupt", "keys", "stop", "resume", "forget", "install", "uninstall", "help", "-h", "--help"]);

/**
 * Other packages of this repo extend am with commands of their own, declared in
 * their package.json as "am": { "commands": { "<command>": "<executable>" } }.
 * am runs them as they are and knows nothing else about them.
 */
export function extensions(packagesDir = fileURLToPath(new URL("../../", import.meta.url))): Map<string, string> {
  const found = new Map<string, string>();
  for (const dir of readdirSync(packagesDir).sort()) {
    let manifest: any;
    try {
      manifest = JSON.parse(readFileSync(join(packagesDir, dir, "package.json"), "utf8"));
    } catch {
      continue;
    }
    for (const [command, bin] of Object.entries(manifest?.am?.commands ?? {})) {
      if (typeof bin === "string" && /^[a-z][a-z0-9-]*$/.test(command) && !BUILTIN.has(command)) found.set(command, join(packagesDir, dir, bin));
    }
  }
  return found;
}

