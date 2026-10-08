import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { Tmux } from "@agent-master/tmux";

import { configDir, loadConfig } from "./config.ts";
import { resolveTarget } from "./context.ts";
import { GenerateError, generateCommand } from "./generate.ts";
import { runPopup } from "./popup.ts";
import { buildPrompt } from "./prompt.ts";
import { renderTmuxConfig } from "./tmux-config.ts";

const USAGE = `am-ask — 用一句话描述，生成一行 shell 命令并填入 tmux pane（不执行）

  am-ask popup   [--target <pane>]                 交互式（tmux 快捷键调用的就是它）
  am-ask run     --request <text> [--target <pane>] [--insert] [--json]
  am-ask context [--target <pane>]                 查看识别出的目标环境
  am-ask tmux-install [--key a] [--no-source]      生成并加载 tmux 快捷键（prefix + key）

  --target 缺省为当前 pane；在 tmux popup 里即打开 popup 前所在的 pane。
  配置文件：${join(configDir(), "shell-ask.json")}（或 AM_SHELL_ASK_CONFIG）`;

/** PATH lookup keeps symlinks such as /opt/homebrew/bin/node, which survive upgrades unlike the resolved Cellar path. */
function which(program: string): string | undefined {
  try {
    return execFileSync("sh", ["-c", `command -v ${program}`], { encoding: "utf8" }).trim() || undefined;
  } catch {
    return undefined;
  }
}

async function tmuxInstall(key: string, source: boolean): Promise<void> {
  const content = renderTmuxConfig({
    key,
    node: which("node") ?? process.execPath,
    cli: fileURLToPath(import.meta.url),
    opencode: which("opencode") ?? "opencode",
  });
  const file = join(configDir(), "shell-ask.tmux");
  await mkdir(configDir(), { recursive: true });
  await writeFile(file, content);
  process.stdout.write(`已写入 ${file}\n`);

  if (source && process.env.TMUX) {
    await new Tmux().run(["source-file", file]);
    process.stdout.write(`已加载到当前 tmux：prefix + ${key}\n`);
  }
  process.stdout.write(`想永久生效，在 ~/.tmux.conf 加一行：\n  source-file -q ${file}\n`);
}

async function main(): Promise<number> {
  const [subcommand, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      target: { type: "string" },
      request: { type: "string" },
      insert: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      model: { type: "string" },
      key: { type: "string", default: "a" },
      "no-source": { type: "boolean", default: false },
    },
  });

  const config = await loadConfig();
  if (values.model) config.model = values.model;
  const tmux = new Tmux();

  switch (subcommand) {
    case "popup":
      return runPopup({ tmux, config, target: values.target });

    case "context": {
      const target = await resolveTarget(tmux, config, values.target);
      process.stdout.write(`${JSON.stringify(target, null, 2)}\n`);
      return 0;
    }

    case "run": {
      if (!values.request) throw new GenerateError("缺少 --request");
      const target = await resolveTarget(tmux, config, values.target);
      const result = await generateCommand({ prompt: buildPrompt(target, values.request), config });
      if (values.insert) await tmux.sendLiteral(target.paneId, result.command);
      process.stdout.write(values.json ? `${JSON.stringify({ ...result, target, inserted: values.insert })}\n` : `${result.command}\n`);
      return 0;
    }

    case "tmux-install":
      await tmuxInstall(values.key, !values["no-source"]);
      return 0;

    default:
      process.stdout.write(`${USAGE}\n`);
      return subcommand ? 2 : 0;
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const detail = error instanceof GenerateError && error.detail ? `\n${error.detail}` : "";
    process.stderr.write(`am-ask: ${message}${detail}\n`);
    process.exit(1);
  },
);
