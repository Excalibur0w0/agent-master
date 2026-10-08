import { appendFileSync } from "node:fs";
import { createInterface, emitKeypressEvents } from "node:readline";

import type { Tmux } from "@agent-master/tmux";

import type { ShellAskConfig } from "./config.ts";
import { resolveTarget, type TargetContext } from "./context.ts";
import { GenerateError, generateCommand } from "./generate.ts";
import { buildPrompt } from "./prompt.ts";

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

type Key = "enter" | "retry" | "cancel";

/** Optional observability hook (used by the e2e tests): one JSON line per state change. */
function reportState(state: string, data: Record<string, unknown> = {}): void {
  const file = process.env.AM_ASK_STATE_FILE;
  if (file) appendFileSync(file, `${JSON.stringify({ state, ...data })}\n`);
}

function header(target: TargetContext): string {
  const where = target.location === "ssh" ? `${BOLD}${target.label}${RESET} ${DIM}(ssh)${RESET}` : `${BOLD}本机${RESET} ${DIM}${target.cwd ?? ""}${RESET}`;
  const lines = [` → ${where}  ${DIM}${target.os} · ${target.shell}${RESET}`];
  if (!target.foregroundIsShell) {
    lines.push(` ${YELLOW}⚠ 当前前台程序是 ${target.foreground}，命令会被直接敲进它的输入里${RESET}`);
  }
  return lines.join("\n");
}

/** Reads one line; resolves undefined on Esc or Ctrl-C. */
function askLine(prefill: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      process.stdin.off("keypress", onKeypress);
      rl.close();
      resolve(value);
    };
    const onKeypress = (_: string, key: { name?: string } | undefined) => {
      if (key?.name === "escape") finish(undefined);
    };
    emitKeypressEvents(process.stdin, rl);
    process.stdin.on("keypress", onKeypress);
    rl.on("SIGINT", () => finish(undefined));
    rl.on("close", () => finish(undefined));
    rl.question(` ${GREEN}❯${RESET} `, (answer) => finish(answer.trim() || undefined));
    if (prefill) rl.write(prefill);
  });
}

function readKey(): Promise<Key> {
  return new Promise((resolve) => {
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (data: Buffer) => {
      const s = data.toString();
      const key: Key | undefined =
        s === "\r" || s === "\n" ? "enter" : s === "r" || s === "R" ? "retry" : s === "\x1b" || s === "\x03" || s === "q" ? "cancel" : undefined;
      if (!key) return;
      process.stdin.off("data", onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      resolve(key);
    };
    process.stdin.on("data", onData);
  });
}

/** Runs `task` with a spinner; Ctrl-C or Esc aborts it. */
async function withSpinner<T>(label: string, task: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const started = Date.now();
  let frame = 0;
  const render = () => {
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    process.stdout.write(`\r\x1b[2K ${SPINNER[frame++ % SPINNER.length]} ${label} ${DIM}${seconds}s · Esc 取消${RESET}`);
  };
  render();
  const timer = setInterval(render, 80);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  const onData = (data: Buffer) => {
    const s = data.toString();
    if (s === "\x1b" || s === "\x03") controller.abort();
  };
  process.stdin.on("data", onData);
  try {
    return await task(controller.signal);
  } finally {
    clearInterval(timer);
    process.stdin.off("data", onData);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    process.stdout.write("\r\x1b[2K");
  }
}

export async function runPopup(options: { tmux: Tmux; config: ShellAskConfig; target?: string }): Promise<number> {
  const { tmux, config } = options;
  const target = await resolveTarget(tmux, config, options.target);
  process.stdout.write(`${header(target)}\n ${DIM}描述你要做的事，Enter 生成 · Esc 退出${RESET}\n`);

  let prefill = "";
  for (;;) {
    reportState("prompt");
    const request = await askLine(prefill);
    if (!request) {
      reportState("cancelled");
      return 1;
    }
    prefill = request;

    reportState("generating", { request });
    try {
      const result = await withSpinner(`生成中 ${DIM}(${config.model})${RESET}`, (signal) =>
        generateCommand({ prompt: buildPrompt(target, request), config, signal }),
      );
      process.stdout.write(`\n ${BOLD}${result.command}${RESET}\n\n ${DIM}Enter 填入（不执行） · r 改需求重来 · Esc 取消   ${(result.durationMs / 1000).toFixed(1)}s${RESET}\n`);
      reportState("ready", { command: result.command });
      const key = await readKey();
      if (key === "enter") {
        await tmux.sendLiteral(target.paneId, result.command);
        reportState("inserted", { command: result.command, paneId: target.paneId });
        return 0;
      }
      if (key === "cancel") {
        reportState("cancelled");
        return 1;
      }
    } catch (error) {
      const message = error instanceof GenerateError ? error.message : String(error);
      const detail = error instanceof GenerateError && error.detail ? `\n ${DIM}${error.detail}${RESET}` : "";
      process.stdout.write(` ${RED}✗ ${message}${RESET}${detail}\n ${DIM}r 改需求重来 · Esc 取消${RESET}\n`);
      reportState("error", { message });
      if ((await readKey()) !== "retry") {
        reportState("cancelled");
        return 1;
      }
    }
    process.stdout.write("\n");
  }
}
