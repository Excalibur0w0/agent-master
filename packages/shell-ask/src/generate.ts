import { configPath, type ShellAskConfig } from "./config.ts";
import { extractCommand } from "./extract.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";

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

export type Completion = { ok: true; text: string } | { ok: false; error: string };

/** Reads the body of an OpenAI-compatible `/chat/completions` response. */
export function parseCompletion(body: string): Completion {
  let json: any;
  try {
    json = JSON.parse(body);
  } catch {
    return { ok: false, error: body.trim().slice(0, 300) || "响应为空" };
  }
  // OpenRouter can report upstream failures in the body of a 200 response.
  const error = json?.error ?? json?.choices?.[0]?.error;
  if (error) return { ok: false, error: String(error.message ?? JSON.stringify(error)) };
  const content = json?.choices?.[0]?.message?.content;
  return { ok: true, text: typeof content === "string" ? content : "" };
}

export async function generateCommand(options: {
  prompt: string;
  config: ShellAskConfig;
  signal?: AbortSignal;
}): Promise<GenerateResult> {
  const { prompt, config, signal } = options;
  if (!config.apiKey) throw new GenerateError(`缺少 apiKey：写进 ${configPath()}，或设置环境变量 AM_SHELL_ASK_API_KEY`);

  const timeout = AbortSignal.timeout(config.timeoutMs);
  const started = Date.now();
  let status: number;
  let body: string;
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.1,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: prompt },
        ],
      }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    status = response.status;
    body = await response.text();
  } catch (error) {
    if (signal?.aborted) throw new GenerateError("已取消");
    if (timeout.aborted) throw new GenerateError(`模型超过 ${Math.round(config.timeoutMs / 1000)}s 没有返回`);
    // fetch() reports every network failure as "fetch failed"; the reason is in `cause`.
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
    throw new GenerateError(`请求 ${config.baseUrl} 失败`, cause instanceof Error ? cause.message : String(cause));
  }

  const completion = parseCompletion(body);
  if (status < 200 || status >= 300) {
    throw new GenerateError(`模型请求失败 (HTTP ${status})`, completion.ok ? body.trim().slice(0, 300) : completion.error);
  }
  if (!completion.ok) throw new GenerateError("模型返回了错误", completion.error);

  const extracted = extractCommand(completion.text);
  if (!extracted.ok) {
    const message = extracted.reason === "empty" ? "模型没有返回内容" : "模型返回了多行内容，未插入（避免换行被当成回车执行）";
    throw new GenerateError(message, extracted.text);
  }
  return { command: extracted.command, durationMs: Date.now() - started };
}
