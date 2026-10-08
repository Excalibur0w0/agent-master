import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface ProcessEntry {
  pid: number;
  pgid: number;
  tpgid: number;
  args: string;
}

export function parsePsOutput(output: string): ProcessEntry[] {
  const entries: ProcessEntry[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(-?\d+)\s+(.*)$/.exec(line);
    if (!match) continue;
    entries.push({ pid: Number(match[1]), pgid: Number(match[2]), tpgid: Number(match[3]), args: match[4].trim() });
  }
  return entries;
}

/**
 * Returns the process that owns the terminal's foreground process group,
 * i.e. what the user is currently typing into (a shell, ssh, an editor...).
 */
export async function foregroundProcess(tty: string): Promise<ProcessEntry | undefined> {
  const { stdout } = await execFileAsync("ps", ["-ww", "-o", "pid=,pgid=,tpgid=,args=", "-t", tty.replace(/^\/dev\//, "")]);
  const foreground = parsePsOutput(stdout).filter((p) => p.pgid === p.tpgid);
  return foreground.find((p) => p.pid === p.pgid) ?? foreground[0];
}
