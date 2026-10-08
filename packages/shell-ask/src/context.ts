import { basename } from "node:path";
import { release, type } from "node:os";

import { Tmux, foregroundProcess } from "@agent-master/tmux";

import type { HostProfile, ShellAskConfig } from "./config.ts";

export interface TargetContext {
  paneId: string;
  location: "local" | "ssh";
  /** Human-readable target, e.g. "本机" or "dev@remote-sim:2222". */
  label: string;
  host?: string;
  user?: string;
  port?: number;
  os: string;
  shell: string;
  cwd?: string;
  notes?: string;
  /** Command line of the pane's foreground process. */
  foreground: string;
  /** False when the user is inside something else (an editor, a REPL...). */
  foregroundIsShell: boolean;
}

export interface SshTarget {
  host: string;
  user?: string;
  port?: number;
}

const KNOWN_SHELLS = new Set(["sh", "bash", "zsh", "fish", "dash", "ksh", "mksh", "tcsh", "csh", "nu", "xonsh", "elvish"]);

// ssh(1) options that consume an argument.
const SSH_OPTIONS_WITH_VALUE = new Set("BbcDEeFIiJLlmOoPpQRSWw".split(""));

function programName(argv0: string): string {
  return basename(argv0.replace(/^-/, ""));
}

/** Extracts the destination from an ssh command line as shown by ps. */
export function parseSshArgs(commandLine: string): SshTarget | undefined {
  const argv = commandLine.trim().split(/\s+/);
  if (programName(argv[0] ?? "") !== "ssh") return undefined;

  let user: string | undefined;
  let port: number | undefined;
  let destination: string | undefined;

  for (let i = 1; i < argv.length && !destination; i++) {
    const arg = argv[i];
    if (arg === "--") {
      destination = argv[i + 1];
      break;
    }
    if (!arg.startsWith("-") || arg === "-") {
      destination = arg;
      break;
    }
    for (let j = 1; j < arg.length; j++) {
      const flag = arg[j];
      if (!SSH_OPTIONS_WITH_VALUE.has(flag)) continue;
      const value = j + 1 < arg.length ? arg.slice(j + 1) : argv[++i];
      if (flag === "p") port = Number(value);
      if (flag === "l") user = value;
      if (flag === "o" && value) {
        const [key, optionValue] = value.split("=", 2);
        if (/^port$/i.test(key)) port = Number(optionValue);
        if (/^user$/i.test(key)) user = optionValue;
      }
      break;
    }
  }
  if (!destination) return undefined;

  const url = /^ssh:\/\/(?:([^@]+)@)?([^:/]+)(?::(\d+))?/.exec(destination);
  if (url) {
    return { host: url[2], user: url[1] ?? user, port: url[3] ? Number(url[3]) : port };
  }
  const at = destination.lastIndexOf("@");
  if (at >= 0) return { host: destination.slice(at + 1), user: destination.slice(0, at), port };
  return { host: destination, user, port };
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(`^${escaped.join(".*")}$`, "i");
}

/** Exact key first, then the first matching glob in insertion order. */
export function matchHostProfile(host: string, hosts: Record<string, HostProfile>): HostProfile | undefined {
  if (hosts[host]) return hosts[host];
  for (const [pattern, profile] of Object.entries(hosts)) {
    if (pattern.includes("*") && globToRegExp(pattern).test(host)) return profile;
  }
  return undefined;
}

function localOs(): string {
  if (process.platform === "darwin") return `macOS (Darwin ${release()}, BSD userland; GNU tools not assumed)`;
  return `${type()} ${release()}`;
}

export async function resolveTarget(tmux: Tmux, config: ShellAskConfig, target?: string): Promise<TargetContext> {
  const pane = await tmux.paneInfo(target);
  const fg = await foregroundProcess(pane.tty);
  const foreground = fg?.args ?? pane.currentCommand;
  const program = programName(foreground.split(/\s+/)[0] ?? "");

  const ssh = parseSshArgs(foreground);
  if (ssh) {
    const profile = matchHostProfile(ssh.host, config.hosts);
    const label = `${ssh.user ? `${ssh.user}@` : ""}${ssh.host}${ssh.port ? `:${ssh.port}` : ""}`;
    return {
      paneId: pane.paneId,
      location: "ssh",
      label,
      ...ssh,
      os: profile?.os ?? config.defaultRemote.os,
      shell: profile?.shell ?? config.defaultRemote.shell,
      notes: profile?.notes,
      foreground,
      // The remote side is assumed to sit at its shell prompt.
      foregroundIsShell: true,
    };
  }

  const isShell = KNOWN_SHELLS.has(program);
  return {
    paneId: pane.paneId,
    location: "local",
    label: "本机",
    os: localOs(),
    shell: isShell ? program : programName(process.env.SHELL ?? "sh"),
    cwd: pane.currentPath,
    foreground,
    foregroundIsShell: isShell,
  };
}
