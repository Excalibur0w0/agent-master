import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import type { ShellAskConfig } from "./config.ts";
import { extractCommand } from "./extract.ts";

export const AGENT_NAME = "shell-command";
const AGENT_ASSET = new URL(`../assets/opencode-agents/${AGENT_NAME}.md`, import.meta.url);

export class GenerateError extends Error {
  readonly detail: string | undefined;

  constructor(message: string, detail?: string) {
    super(message);
    this.name = "GenerateError";
    this.detail = detail;
  }
}

export interface GenerateResult {
  command: string;
  durationMs: number;
}

export interface OpencodeEvents {
  text: string;
  sessionId: string | undefined;
  error: string | undefined;
  eventCount: number;
}

/** Parses the NDJSON stream of `opencode run --format json`. */
export function parseOpencodeEvents(stdout: string): OpencodeEvents {
  const result: OpencodeEvents = { text: "", sessionId: undefined, error: undefined, eventCount: 0 };
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    result.eventCount++;
    if (typeof event.sessionID === "string") result.sessionId = event.sessionID;
    if (event.type === "error" && !result.error) {
      result.error = event.error?.data?.message ?? event.error?.name ?? "opencode reported an error";
    }
    if (event.type === "text" && typeof event.part?.text === "string") result.text += event.part.text;
  }
  return result;
}

/**
 * opencode runs in a private directory outside any repo, so project
 * instructions (AGENTS.md etc.) never leak into the prompt. The agent
 * definition is copied there and refreshed when it changes.
 */
async function prepareWorkdir(): Promise<string> {
  const workdir = join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "agent-master", "shell-ask");
  const agentDir = join(workdir, ".opencode", "agents");
  const agentFile = join(agentDir, `${AGENT_NAME}.md`);
  const wanted = await readFile(AGENT_ASSET, "utf8");
  const current = await readFile(agentFile, "utf8").catch(() => "");
  if (current !== wanted) {
    await mkdir(agentDir, { recursive: true });
    await writeFile(agentFile, wanted);
  }
  return workdir;
}

/** opencode locates the project from $PWD rather than the real cwd, so both must point at the workdir. */
function opencodeEnv(workdir: string): NodeJS.ProcessEnv {
  return { ...process.env, PWD: workdir };
}

function deleteSessionInBackground(config: ShellAskConfig, workdir: string, sessionId: string): void {
  const child = spawn(config.opencodeBin, ["session", "delete", sessionId], {
    cwd: workdir,
    env: opencodeEnv(workdir),
    detached: true,
    stdio: "ignore",
  });
  child.on("error", () => {});
  child.unref();
}

export async function generateCommand(options: {
  prompt: string;
  config: ShellAskConfig;
  signal?: AbortSignal;
}): Promise<GenerateResult> {
  const { prompt, config, signal } = options;
  const workdir = await prepareWorkdir();
  const args = ["run", "--pure", "--format", "json", "--model", config.model, "--agent", AGENT_NAME, "--title", "shell-ask", prompt];
  const started = Date.now();

  const { code, stdout, stderr } = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(config.opencodeBin, args, { cwd: workdir, env: opencodeEnv(workdir), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));

    const timer = setTimeout(() => {
      child.kill();
      reject(new GenerateError(`opencode 超过 ${Math.round(config.timeoutMs / 1000)}s 没有返回`));
    }, config.timeoutMs);
    const onAbort = () => {
      child.kill();
      reject(new GenerateError("已取消"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new GenerateError(`无法启动 opencode (${config.opencodeBin})`, error.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, stdout, stderr });
    });
  });

  const events = parseOpencodeEvents(stdout);
  if (events.sessionId) deleteSessionInBackground(config, workdir, events.sessionId);

  if (code !== 0 || events.error) {
    const detail = events.error ?? stderr.trim().split("\n").pop();
    throw new GenerateError(`opencode 失败${code ? ` (exit ${code})` : ""}`, detail);
  }

  const extracted = extractCommand(events.text);
  if (!extracted.ok) {
    const message = extracted.reason === "empty" ? "模型没有返回内容" : "模型返回了多行内容，未插入（避免换行被当成回车执行）";
    throw new GenerateError(message, extracted.text);
  }
  return { command: extracted.command, durationMs: Date.now() - started };
}
