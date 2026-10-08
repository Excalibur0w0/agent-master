import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface TmuxOptions {
  /** `tmux -L <name>`: use a separate server, e.g. for tests. */
  socketName?: string;
  bin?: string;
}

export interface PaneInfo {
  paneId: string;
  tty: string;
  pid: number;
  currentCommand: string;
  currentPath: string;
}

export interface SpawnOptions {
  cwd?: string;
  env?: Record<string, string>;
  /** argv, executed directly without a shell; a string goes through the default shell. */
  command?: string | string[];
}

const PANE_FORMAT = ["#{pane_id}", "#{pane_tty}", "#{pane_pid}", "#{pane_current_command}", "#{pane_current_path}"].join("\t");

function spawnArgs(options: SpawnOptions): string[] {
  const args: string[] = [];
  if (options.cwd) args.push("-c", options.cwd);
  for (const [key, value] of Object.entries(options.env ?? {})) args.push("-e", `${key}=${value}`);
  if (typeof options.command === "string") args.push(options.command);
  else if (options.command) args.push(...options.command);
  return args;
}

/** Separates commands in one tmux invocation; every other argument is data. */
export const SEP: unique symbol = Symbol("tmux-command-separator");
export type TmuxArg = string | typeof SEP;

/**
 * tmux treats an argument ending in ";" as a command separator and drops the
 * semicolon ("echo hi;" arrives as "echo hi"). A backslash before the final
 * ";" makes it literal (and turns a literal "\;" into "\\;").
 */
export function escapeArg(arg: string): string {
  return arg.endsWith(";") ? `${arg.slice(0, -1)}\\;` : arg;
}

/**
 * Quotes a value for a tmux command string (e.g. the command an if-shell runs):
 * a double-quoted string with backslash escapes, so `$VAR`, `;` and spaces stay literal.
 */
export function quoteArg(value: string): string {
  return `"${value.replace(/[\\"$]/g, (c) => `\\${c}`)}"`;
}

export class Tmux {
  readonly bin: string;
  readonly socketName: string | undefined;

  constructor(options: TmuxOptions = {}) {
    this.bin = options.bin ?? "tmux";
    this.socketName = options.socketName;
  }

  private argv(args: TmuxArg[]): string[] {
    const encoded = args.map((arg) => (arg === SEP ? ";" : escapeArg(arg)));
    return this.socketName ? ["-L", this.socketName, ...encoded] : encoded;
  }

  async run(args: TmuxArg[]): Promise<string> {
    const { stdout } = await execFileAsync(this.bin, this.argv(args), { maxBuffer: 16 * 1024 * 1024 });
    return stdout;
  }

  /** Like `run`, with `input` on the command's stdin (e.g. `load-buffer -`). */
  runWithInput(args: TmuxArg[], input: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, this.argv(args), { stdio: ["pipe", "ignore", "pipe"] });
      let stderr = "";
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
      child.on("error", reject);
      child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tmux ${String(args[0])} failed: ${stderr.trim()}`))));
      child.stdin.end(input);
    });
  }

  /** Without `target`, tmux resolves the caller's current pane (also from inside a popup). */
  async display(target: string | undefined, format: string): Promise<string> {
    const targetArgs = target ? ["-t", target] : [];
    const out = await this.run(["display-message", "-p", ...targetArgs, format]);
    return out.replace(/\n$/, "");
  }

  async paneInfo(target?: string): Promise<PaneInfo> {
    const [paneId, tty, pid, currentCommand, currentPath] = (await this.display(target, PANE_FORMAT)).split("\t");
    return { paneId, tty, pid: Number(pid), currentCommand, currentPath };
  }

  /** One row per pane on the server, rendered with `format`. */
  async listPanes(format: string): Promise<string[]> {
    try {
      return (await this.run(["list-panes", "-a", "-F", format])).split("\n").filter(Boolean);
    } catch {
      return []; // No server running.
    }
  }

  /** Sets pane-scoped user options (`@name`) in a single tmux invocation. */
  async setPaneOptions(target: string, options: Record<string, string>): Promise<void> {
    const args: TmuxArg[] = [];
    for (const [key, value] of Object.entries(options)) {
      if (args.length) args.push(SEP);
      args.push("set-option", "-p", "-t", target, key, value);
    }
    if (args.length) await this.run(args);
  }

  /** Types `text` into the pane as literal keys. Never appends Enter. */
  async sendLiteral(target: string, text: string): Promise<void> {
    await this.run(["send-keys", "-t", target, "-l", "--", text]);
  }

  async sendKeys(target: string, ...keys: string[]): Promise<void> {
    await this.run(["send-keys", "-t", target, ...keys]);
  }

  /**
   * Pastes `text` as one bracketed paste, so newlines stay inside the input
   * instead of submitting it. Never appends Enter.
   */
  async paste(target: string, text: string): Promise<void> {
    const buffer = `am-${process.pid}-${Date.now()}`;
    await this.runWithInput(["load-buffer", "-b", buffer, "-"], text);
    await this.run(["paste-buffer", "-p", "-d", "-b", buffer, "-t", target]);
  }

  /** Creates a detached session and returns the id of its first pane. */
  async newSession(name: string, options: { width?: number; height?: number } & SpawnOptions = {}): Promise<string> {
    const args: TmuxArg[] = ["new-session", "-d", "-P", "-F", "#{pane_id}", "-s", name];
    if (options.width) args.push("-x", String(options.width));
    if (options.height) args.push("-y", String(options.height));
    return (await this.run([...args, ...spawnArgs(options)])).trim();
  }

  /** Opens a detached window in `session` and returns its pane id. */
  async newWindow(session: string, command: string | string[], options: Omit<SpawnOptions, "command"> & { windowName?: string } = {}): Promise<string> {
    const args: TmuxArg[] = ["new-window", "-d", "-P", "-F", "#{pane_id}", "-t", `${session}:`];
    if (options.windowName) args.push("-n", options.windowName);
    return (await this.run([...args, ...spawnArgs({ ...options, command })])).trim();
  }

  /** Splits `target` without moving focus and returns the new pane id. */
  async splitWindow(target: string, options: SpawnOptions & { direction?: "right" | "down" } = {}): Promise<string> {
    const args = ["split-window", "-d", "-P", "-F", "#{pane_id}", "-t", target, options.direction === "down" ? "-v" : "-h"];
    return (await this.run([...args, ...spawnArgs(options)])).trim();
  }

  async hasSession(name: string): Promise<boolean> {
    try {
      await this.run(["has-session", "-t", `=${name}`]);
      return true;
    } catch {
      return false;
    }
  }

  async killPane(target: string): Promise<void> {
    await this.run(["kill-pane", "-t", target]);
  }

  /** Server socket; `TMUX=<socketPath>` points plain `tmux` clients (child processes) at this server. */
  async socketPath(): Promise<string> {
    return this.display(undefined, "#{socket_path}");
  }

  async killServer(): Promise<void> {
    try {
      await this.run(["kill-server"]);
    } catch {
      // No server running.
    }
  }
}
