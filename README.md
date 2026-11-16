# agent-master

基于 tmux 的 agent 工具集（思路参考 [herdr](https://github.com/herdrdev/herdr)），pnpm monorepo。**全程不读屏幕**：状态来自 agent 的 hook、对话记录文件和官方 API。

MCP servers 在独立的 [agent-master-mcp](https://github.com/Excalibur0w0/agent-master-mcp) monorepo 中维护。

```
packages/
  tmux/         @agent-master/tmux       tmux CLI 的类型化封装 + pane 前台进程识别
  agent/        @agent-master/agent      am：在 tmux 里启动、驱动、协同 claude / codex / opencode
  router/       @agent-master/router     am router：建在 am 之上的常驻派活会话
  ledger/       @agent-master/ledger     am ledger：router 的台账和 watcher 的待过目消息（SQLite）
  watcher/      @agent-master/watcher    am watcher：常驻、只读地盯消息，整理需要你处理的
  shell-ask/    @agent-master/shell-ask  一句话 → 一行 shell 命令，填入当前 pane（本机或 ssh 远端）
infra/
  remote-sim/   @agent-master/remote-sim Docker 模拟的远程 Linux 服务器（Ubuntu 24.04 + bash + sshd）
.claude/commands/am.md、.agents/skills/am/、.opencode/commands/am.md、opencode.json
                         本仓库的 /am、$am 入口（am install --project . 生成）
```

## 环境要求

- tmux ≥ 3.3、jq（hook 脚本用）
- Node ≥ 22.18（直接运行 `.ts`，无构建步骤）。pnpm 脚本通过 `.npmrc` 的 `use-node-version` 固定用 22.18.0
- 用到哪个 agent 就装哪个：`claude`、`codex`、`opencode`
- Docker（只有 shell-ask 的 e2e 测试需要）

```sh
pnpm install
packages/agent/bin/am install   # ~/.local/bin/am + 三个 agent 的全局 /am、$am 入口（只写带 am 标记的文件，不覆盖别人的）
```

## am：agent 协同

人直接用；或者在某个 agent 里**显式**调用，让它去协调别的 agent。正文在 `packages/agent/skills/am/GUIDE.md`，`am install` 按各家格式生成入口，模型都不会自己调用：

| agent | 调用 | 怎么做到只能显式调用 | 全局入口 / 项目入口 |
| --- | --- | --- | --- |
| Claude Code | `/am <要委派的事>` | 命令文件带 `disable-model-invocation: true`（描述也不进上下文） | `~/.claude/commands/am.md` / `.claude/commands/am.md` |
| Codex | `$am <要委派的事>` | `agents/openai.yaml` 里 `allow_implicit_invocation: false` | `~/.codex/skills/am/` / `.agents/skills/am/` |
| opencode | `/am <要委派的事>` | 自定义命令；项目里的 `.agents/skills/am` 用 `opencode.json` 的 `permission.skill.am: deny` 对模型隐藏 | `~/.config/opencode/commands/am.md` / `.opencode/commands/am.md` |
| dsh | `/am <要委派的事>` | skill 带 `disable-model-invocation: true`：不进模型的技能目录，只在用户消息里出现 `/am` 时注入；项目里 `.dsh/skills` 排在 `.agents/skills` 前面，盖住给 Codex 的那份 | `~/.dsh/skills/am/` / `.dsh/skills/am/` |

dsh 的 `/am` 需要较新的 deepseek-harness-tui：它把不是 TUI 自己命令、但正好是用户可调用 skill 的 `/名字` 当消息发给 agent；旧版本会提示「未知命令」，这时可以把 `/am` 写在句中，例如「请按 /am 处理：…」。不用 `.claude/skills/am` 是因为 opencode 也会读它，而且不认 `disable-model-invocation`。`am prompt` 遇到以 `/` 开头的内容会逐字输入第一行，因为粘贴进去的 `/xxx` 不会被当成斜杠命令。

```sh
am start reviewer --kind codex            # 开在独立的 tmux 会话 am-reviewer；就绪后返回
am prompt reviewer "review 一下未提交的改动，只列可执行的问题" --wait --timeout 600000
am read reviewer                          # 它这一轮的最终回复（读对话记录 / API，不读屏幕）
am stop reviewer
```

| 命令 | 作用 |
| --- | --- |
| `am start <name> --kind claude\|codex\|opencode\|dsh [--bin PATH] [--cwd] [--model] [--env K=V] [--contract FILE] [--window] [-- 原生参数]` | 在独立会话 `am-<name>` 里启动（`--window` 改为当前会话的新窗口）、注入状态上报、等就绪；`--bin` 换成同参数的兼容 CLI（仅 claude / codex） |
| `am start <name> --profile <预设> [--cwd] [其它选项]` | 用本机预设起（见下文「预设」）；命令行上的选项覆盖预设，`--` 后的参数接在预设的参数后面 |
| `am start <name> ... --conversation <ID>` | 在这个 agent 已有的会话上起，不开新会话（claude / codex / opencode，dsh 不支持） |
| `am profiles` | 列出本机预设 |
| `am open <name>` | 切到它的会话（tmux 外打印 `tmux attach` 命令）；也可以 `prefix + s` 选 |
| `am list` / `am status <name>` | 状态：`starting` `idle` `working` `blocked` `stalled` `exited` `unknown`；`detail` 说明在等什么、为什么卡住 |
| `am list --saved` | am 记得的所有 agent：运行中、`stopped`（am stop 关的）、`exited`（自己退出的）、`lost`（随 tmux 或机器重启丢的） |
| `am prompt <name> <text\|-> [--wait] [--timeout]` | 粘贴 + 回车，并确认对方收到；blocked / working 时拒绝；带合同的 agent 自动附上合同 |
| `am wait <name> [--until idle,blocked,stalled]` | 等状态；同一次卡住只报一次 |
| `am read <name>` | 最近一轮的最终回复 |
| `am approve <name> [--always]` / `am deny <name>` | 处理权限请求（`--always` 仅 opencode） |
| `am interrupt <name>` / `am keys <name> <key>...` / `am stop <name>` | 中断 / 原始按键 / 关闭（am 仍记得它，可以 resume） |
| `am resume <name>` / `am resume --all` | 用当初的启动参数重新起来，并接回它原来的会话；`--all` 恢复所有随 tmux 或机器重启丢掉的 agent，再拉起 watcher 的 feed loop |
| `am forget <name>` | 删掉 am 对它的记录 |
| `am router start\|restart\|stop` | 常驻的派活会话，见下文「am router」 |
| `am watcher start\|stop\|status\|list\|resume` | 常驻、只读地盯消息，见下文「am watcher」 |
| `am ledger show\|list\|add\|update\|pause\|start\|close\|inbox …` | router 的台账和待过目消息，见下文「am ledger」 |
| `am -h` / `am help` | 所有命令的说明，包括 `am router`、`am watcher` |

所有命令支持 `--json`。每个 agent 一个后台会话，`am list` 的 SESSION 列就是会话名；在会话里可以直接接管（输入、Esc、批准），`am stop` 会连同会话一起关掉。

通过 `/am` 派活时，如果主 agent 能在后台运行命令、并在命令结束时被唤醒（Claude Code 的 Bash 后台运行就可以），指南会让它不再前台干等：用不带 `--wait` 的 `am prompt` 派出任务后，把 `am wait <name>` 放到后台，然后告诉你谁在干活，自己接着做别的事或结束这一轮；等对方做完（idle）、需要人决定（blocked）或退出时再被唤醒处理。没有这种能力的 agent 仍然用 `--wait --timeout` 前台等待。

### 预设（`--profile`）

每种 worker 的启动参数又长又容易写错，可以在本机配置文件 `~/.config/agent-master/am.json`（遵循 `XDG_CONFIG_HOME`）里写成预设，然后一个词起好。这个文件只在你的机器上，仓库里没有任何人的预设：

```json
{
  "stallAfterMinutes": 15,
  "profiles": {
    "codex": {
      "description": "Codex，1M 上下文，关 fast",
      "kind": "codex",
      "model": "gpt-6.1-sol",
      "env": { "HTTPS_PROXY": "http://127.0.0.1:7897" },
      "args": ["--yolo", "--no-alt-screen", "--disable", "fast_mode"]
    },
    "deepseek": { "kind": "opencode", "model": "deepseek/deepseek-flash#max", "args": ["--auto"] }
  }
}
```

```sh
am profiles                                   # 看有哪些
am start fix-login --profile codex --cwd ~/code/app
am start fix-login --profile codex -- -c model_reasoning_effort=high   # 命令行的参数接在预设后面
```

- 字段：`kind`（必填）、`bin`、`model`、`env`、`args`（`--` 后的原生参数）、`contract`（见下文）、`description`（`am profiles` 显示）。`bin`、`contract` 和以 `~/` 开头的参数会展开成家目录。
- 命令行上的 `--bin`、`--model`、`--contract` 覆盖预设；`--env` 与预设合并（命令行优先）；`--kind` 与预设的 kind 不同会报错。
- opencode 的档位（variant）写在模型后面：`deepseek/deepseek-flash#max`。am 在创建会话时就设好档位，起来后再通过 opencode 的 API 读回会话的模型确认；对不上就关掉这个 agent 并报 `variant_unconfirmed`，不会让它用错的档位干活。opencode 界面左下角在第一次提交前不显示档位，这不影响实际使用的档位；不要在界面里按 ctrl+t，那会在下次提交时把会话改成界面上选的档位。档位只支持 OpenCode 2。

### worker 合同（`--contract`）

给 worker 的固定约束（不推送、不打印密钥……）和统一的回报格式写在一个本机文件里，am 发给它的每个任务都会自动带上：第一次附全文，之后只附一行「合同仍然有效」的提醒；合同文件改了就再附一次全文。以 `/` 开头的斜杠命令不附。

- 合同从哪来：`am start --contract FILE`，或预设里的 `contract`，都没有时用环境变量 `$AM_CONTRACT`。`am router` 用最后这种方式把你的合同交给它派出的每个 worker（见 am router 一节），router 自己不带合同。
- 内容由你自己维护，仓库里没有默认内容；`am router` 默认用 `~/.config/agent-master/worker-contract.md`。
- 合同文件不见了，`am prompt` 会直接报错 `contract_missing`，不会悄悄不带合同就发出去。

### 卡住识别（`stalled`）

agent 看起来还在干活、其实不会再有进展的情况，am 报成 `stalled`，`detail` 说明原因。`am wait` 默认也在 `stalled` 时返回；同一次卡住只报一次，再次 `am wait` 会等到有新变化（恢复工作、做完、或者新的一次卡住）。

| 原因 | detail 开头 | 怎么识别（都不读屏） |
| --- | --- | --- |
| 用量上限 | `usage limit:` | Claude：对话记录里本轮最后一条是 `isApiErrorMessage` 且 `error: rate_limit`（如 5 小时上限）；Codex：本轮的 `task_complete` 带 `error.codex_error_info: usage_limit_exceeded`（这时 Codex 不触发 Stop hook，所以原来会一直显示 working）；opencode 2：最新一轮重试的错误是 `provider.quota` / `provider.rate-limit` |
| 内容过滤 | `content filter:` | Claude：API 错误消息带 `stop_reason: refusal`（Claude 自己接着说下去的不算）；Codex：本轮出现过 `<content_filter_guidance>`，最后以错误结束；opencode 2：`provider.content-filter` |
| 其它 API 错误 | `error:` | 同上，其它错误类型（例如模型满载、网络断开且重试用尽） |
| 长时间没有输出 | `no output for` | 在 working 状态下，对话记录（opencode 2 是会话的更新时间）超过 `stallAfterMinutes`（默认 15 分钟，在 am.json 里改）没有变化 |

- 因错误结束的一轮（前三种）已经回到输入框，`am prompt` 可以直接发「继续」；「长时间没有输出」时它可能还在跑很久的命令，`am prompt` 照样拒绝，可以 `am open` 看一眼或 `am interrupt`。
- Claude 的 API 错误要在本轮最后保留 20 秒以上才算（安全分类拦截后 Claude 可能自己接着做）；Codex 漏掉 Stop hook 但 `task_complete` 已写出时直接报 idle。
- dsh 和 OpenCode 1.x 目前识别不了这些原因，也不做「长时间没有输出」的判断。

### 恢复（`am resume`）

am 在 `~/.local/state/agent-master/agents/<name>.json`（遵循 `XDG_STATE_HOME`，可用 `AM_STATE_DIR` 换位置，文件权限 600：里面有 `--env` 的值）记下每个 agent 的 kind、启动参数（bin、model、env、原生参数、预设名、合同）和它自己的会话 ID。会话 ID 来自 hook 或 API，am 每次查看状态时同步（Codex 要等第一次 `am prompt` 后才有）。

```sh
am resume fix-login     # 关掉的（am stop）或丢掉的 agent，用原参数重新起来并接回原会话
am resume --all         # 重启机器或 tmux 之后：恢复所有随 tmux 丢掉的 agent，不碰你用 am stop 关的和自己退出的；
                        # 随后让扩展命令把它们旁边的东西也拉回来（watcher 的 feed loop）
am list --saved         # 看 am 记得哪些
```

- 各 kind 怎么接回会话：Claude `--resume <id>`（原参数里的 `--resume`、`--continue` 会去掉）；Codex `codex resume <id>`（用 `--bin` 换了启动器的同样适用）；opencode 2 让 am 的 runner 绑定已有会话（不再新建），并按记录的模型和档位校正；opencode 1 `--session <id>`。dsh 暂不支持。
- 恢复的 agent 已经收到过合同，之后只附提醒。
- 升级 agent 的 CLI 后要让 worker 用上新版本：`am stop <name>` 再 `am resume <name>`。
- 这个功能上线前就已经在跑的 agent 没有记录，恢复不了。

OpenCode 1.x / 2.x 会按 `opencode --version` 自动适配。2.x 使用独立的本机 `serve` 服务和绑定会话的 TUI，模型在创建会话时设置；`am stop` 或关闭 TUI 会一并退出该服务。2.x 的状态、权限、表单和回复通过 `/api` 读取，发送确认使用持久化的用户消息 ID，因此快速完成的回复也不会漏掉确认。

### dsh（dshcli）

`--kind dsh` 启动的是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的终端界面，由 [deepseek-harness-tui](https://github.com/Excalibur0w0/deepseek-harness-tui) 提供的 `dshcli` 命令启动。dsh 官方没有交互式终端界面（自带的是网页版、一次性的 headless 运行器、SDK 和 ACP 服务），所以要先装好 deepseek-harness-tui：

1. 按 [它的安装说明](https://github.com/Excalibur0w0/deepseek-harness-tui#安装) 走一遍：准备带 `node:ffi` 的官方 Node 26、构建 dsh、把 deepseek-harness-tui 装进 dsh 的 `tui` profile、配好 API key。
2. 把 `dshcli` 链接进 PATH 上的目录，例如 `ln -s ~/dsh/deepseek-harness-tui/bin/dshcli ~/.local/bin/dshcli`。
3. 先在终端里直接运行一次 `dshcli`，能看到输入框、问一句能回答，再交给 am。

```sh
am start helper --kind dsh                                 # 用 tui profile 里的默认模型
am start helper --kind dsh --model deepseek-official/deepseek-flash   # 换模型：<provider>/<model>
am start helper --kind dsh --env DSH_PERMISSION_MODE=read-only   # 沙箱改成只读，写文件都要批准
am start helper --kind dsh -- --patch ./my-overlay.yml     # -- 之后原样交给 dshcli，比如再叠一层自己的 patch
```

am 启动时只在命令行上加 `--patch` 叠加层，不改 `~/.dsh` 里的 profile：

- 上报插件 `packages/agent/dsh/reporter.js`：把状态写到 agent 所在的 tmux 窗格，每轮结束时把最终回复写到 `~/.cache/agent-master/dsh-replies/<会话 id>.txt`（`am read` 读的就是它）。
- 用了 `--model` 时再叠一层，替换 profile 里 `agent-default-model` 那一行的 config；`<provider>` 要是 profile 里配过的服务（`/connect` 连过的，或 `cordis.patch.yml` 里写的）。

叠加层文件按内容命名，放在 `~/.cache/agent-master/dsh-*.yml`。

在 dsh 里用 `/am` 派活：先运行 `am install`（写入 `~/.dsh/skills/am`），再确认 deepseek-harness-tui 是较新的版本（见上面入口表下的说明）。

启动出问题时：

- `dshcli` 不在 PATH 上，`am start` 会提前提示。
- 报 `dsh exited right after starting`：`dshcli` 自己启动失败了（比如找不到带 FFI 的 Node、dsh 仓库不在同级目录）。在终端里直接运行 `dshcli` 能看到具体原因，对照 deepseek-harness-tui README 的「遇到问题」处理。
- 报 `start_timeout`：界面没在时限内打开，用 `am open <name>` 看一下它停在哪里。

### 其它兼容 CLI（`--bin`）

`--bin PATH` 换掉 `--kind claude` / `--kind codex` 启动的可执行文件，参数、状态上报、回复读取、批准和中断仍按该 kind 的规则处理。适合包了一层 provider 网关、但命令行与 claude / codex 兼容的启动器：

```sh
am start gw --kind codex --bin my-codex-launcher      # 经网关启动的 Codex
am start gwc --kind claude --bin my-claude-launcher   # 经网关启动的 Claude Code
```

- `--bin` 可以是命令名（按 PATH 查找），也可以是相对于 `--cwd` 的路径；验证失败时 `am start` 会在建 pane 前报 `bin_not_found`。
- 包装器必须接受与对应 CLI 相同的参数。`opencode` 和 `dsh` 的启动命令不是单一的 agent CLI，不支持 `--bin`。
- 用 `--bin` 启动的 agent 在 `am list` 里仍显示原 kind（`codex` / `claude`）。Codex 的目录信任和 hooks 信任与普通 codex 共用 `~/.codex/config.toml`，第一次仍要在它的会话里确认一次。
- 包装器自己的前置条件不归 am 管：比如它依赖的本地网关要先运行起来。

### 状态从哪来

| | Claude Code | Codex | opencode | dsh |
| --- | --- | --- | --- | --- |
| 注入方式 | `--settings`（不改你的配置） | `-c hooks.*`（不改配置文件；首次要信任一次） | `--port` + `OPENCODE_SERVER_PASSWORD` | `--patch` 叠加 am 的上报插件 `packages/agent/dsh/reporter.js`（不改 profile） |
| working / blocked / idle | hook：UserPromptSubmit / PermissionRequest、AskUserQuestion / Stop | hook：UserPromptSubmit / PermissionRequest / Stop | 内置服务 API：`/session/status`、`/permission`、`/question` | 插件监听进程内事件：`tui/submit` / `approval/asked`、提问面板 / `agent/status`、`turn/end` |
| Esc 中断 | 无 hook：读对话记录里的 `[Request interrupted by user…]` | `Interrupt` hook | API | `turn/end` 的 `aborted` |
| 回复 | 对话记录 JSONL | 对话记录里的 `task_complete` | `GET /session/{id}/message` | 插件在每轮结束时写出的最终回复（dsh 的会话日志是 zstd 压缩的） |
| 批准 / 中断 | 按键 Enter / Esc | 按键 Enter / Esc | API | 按键 y / n / Esc |

hook（dsh 是插件）把状态写在 agent 所在 pane 的 `@am_*` 选项上（`tmux show-options -p`），所以没有常驻进程；对话记录只从本轮开始的偏移量往后读。

几个保证不误操作的细节：
- **启动**：agent 进程先停在 `tmux wait-for <通道>` 上，`am` 按 pane id 写好记录后发信号放行（信号先到也不会丢），hook 不可能先于记录运行；`am` 中途退出时，pane 60 秒后自行退出，不会启动一个没有记录的 agent。同名检查和建 pane 在一把全局启动锁里完成。
- **发送**：每个 agent 一把发送锁（tmux 内原子加锁，120 秒过期）；每次按键都是一条 tmux 内的 `if-shell`，锁不在自己手里就不发。「已收到」只看 `UserPromptSubmit` 原子自增的 `@am_seq`（opencode 看服务端的 busy 会话）；没确认就报 `prompt_stalled`，**从不重发**，避免同一个任务被执行两次。
- **不让弹窗吃掉按键**：am 启动的 Codex 关掉启动时的更新检查（`check_for_update_on_startup=false`），opencode 关掉自动更新（`OPENCODE_DISABLE_AUTOUPDATE=1`）。否则更新对话框会在任意时刻弹出，`am prompt` 的 Enter 会替你确认升级。
- **权限**：`PermissionRequest` 不带 `tool_use_id`，用「工具名 + 输入」的校验和与 `PostToolUse` 配对（Codex 给 Bash 输入额外加的 `description` 会先去掉），并行工具完成不会误清 blocked；`am approve` 只在仍是同一个请求时把状态改成 working。dsh 的审批自带 id，按 TUI 弹出的顺序逐个记录。
- **调试**：`am start ... --env AM_HOOK_LOG=/tmp/hooks.ndjson` 会把 hook 收到的原始输入逐条记下来。

### 首次使用会遇到的确认（hook 看不到，需要人到它的会话里点一次）

- Claude：目录信任（父目录信任过就不会问）
- Codex：目录信任（按 git 根目录记录），以及 am 的 hooks 信任（`Trust all and continue`，记录在 `~/.codex/config.toml` 的 `[hooks.state]`）
- dsh：没有确认框；`dshcli` 不在 PATH 上时 `am start` 会提前提示

`am start` 会提前提示；没确认时会超时报错。

### 已知限制

- **Claude 在模型开始输出前被 Esc**：它把 prompt 退回输入框，不写对话记录、不触发 hook，状态会停在 `working` 直到人再次提交。`am interrupt` 会等这一轮至少 3 秒再按 Esc，并在没确认时报 `interrupt_unconfirmed`；这种状态下 `am prompt` 会拒绝发送，不会把新内容拼进残留的输入。
- Codex 第一次提交前没有任何事件，`am start` 用固定 3 秒作为就绪判断；在此之前会先等两个信任确认都写进 `config.toml`，否则 prompt 的 Enter 会替你答掉确认框。opencode 的界面比 API 晚就绪，`am start` 在 API 就绪后再等 3 秒。
- Claude / Codex：两个**完全相同**的工具调用（同名同输入）并行等待批准时，先完成的那个会把 blocked 清掉；hook 里没有能区分它们的字段。
- opencode 的会话按「`am prompt` 确认收到时服务端正在跑的会话」绑定。人在它的界面里切换或新建会话后，`am read` 仍读绑定的那个，直到下一次 `am prompt`；还没收到过 `am prompt` 且空闲时报 `no_session`，不会去猜「最新的会话」（同一项目的其他 opencode 实例共享会话列表）。
- Codex 的目录信任：在 git 仓库里只认仓库根目录那一条（信任过父目录不算），`-c projects."<dir>".trust_level="trusted"` 也只在 git 仓库外生效（后出现的 `untrusted` 会撤销）。hook 信任按 Codex 源码的算法（`codex-rs` 的 `hook_hash`：规范化 hook 定义的 JSON 做 sha256）逐条核对 `[hooks.state]`，仓库搬家、hook 被禁用都会被识别。这依赖 Codex 0.160 的算法，Codex 改算法后 `am` 会一直等待信任，需要跟着更新。`config.toml` 用 TOML 解析器读取，解析失败按「未信任」处理。
- `stalled` 的识别依赖各家对话记录 / API 的内部格式（Claude 的 `isApiErrorMessage`、Codex 的 `task_complete.error` 和 `<content_filter_guidance>`、opencode 2 的 `retry` / `error`），它们改格式后要跟着更新；「长时间没有输出」只是超时推断，跑得很久又不写对话记录的命令也会被报出来。
- Codex 文档只说 SubagentStart/Stop 带 `agent_id`；如果它自己的子 agent 的其他事件不带，这些事件会影响父 agent 的状态。
- 读写依赖 Claude / Codex 对话记录的内部格式，升级后用 e2e 测试回归。
- dsh 的上报依赖 dsh 和 deepseek-harness-tui 尚未稳定的内部接口（`tui/submit`、`tuiChat.agent`、`session/event` 的事件类型），两者升级后用 `AM_E2E_KINDS=dsh` 的 e2e 回归。dsh 的提问面板只能人在它的会话里回答，`am approve` / `am deny` 会拒绝；审批只支持单次（没有 `--always`）。`--model` 会整体替换 profile 里 `agent-default-model` 那一行的 config。

## am router：常驻的派活会话

建在 am 之上的一层，参考 DeepSeek Super-agent 的 router–worker 设计：起一个常驻的 agent 会话，你只跟它说话；它把每个请求原样交给一个 worker（用 am 启动），在后台等 worker 做完，再把结果或需要你决定的事告诉你，开头一行 `Q: 简短标题` 标明对应你的哪个请求。它自己不看代码、不拆任务，也不替你批准。在办的事记在台账文件里，不靠 router 自己的上下文。

```sh
cd ~/code/my-app
am router start          # 常驻会话 am-router（tmux 会话名）；worker 默认在当前目录、默认用 claude
am open router           # 进去跟它说话；它派出的 worker 也在 am list 里，随时 am open 接管
am router restart        # 换一个新会话，接着台账干
am router restart --resume   # 重启进程，但接着用它现在这个会话
am router stop
```

| 参数 | 作用 |
| --- | --- |
| `[name]` | 会话名，默认 `router`；可以同时开多个 |
| `--kind` / `--model` | router 自己用的 agent 和模型（默认 claude）。它只派活，可以用便宜的模型 |
| `--project DIR` | worker 默认的工作目录（默认当前目录）；对话里也可以指定别的目录 |
| `--worker-kind` | worker 默认用的 agent（默认 claude）；本机有同名预设时用预设；对话里也可以指定别的预设或 kind |
| `--contract FILE` | worker 合同（默认 `~/.config/agent-master/worker-contract.md`，存在才用） |
| `-- 原生参数` | 传给 router 自己的 agent |

router 怎么知道自己的角色：`am router start` 在 `~/.local/state/agent-master/router/<name>/` 写入内容相同的 `CLAUDE.md` 和 `AGENTS.md`（正文是 `packages/router/ROUTER.md`），再用 `am start <name> --cwd` 在这个目录启动。规则以项目说明文件的形式存在，各家 agent 都会加载，上下文压缩后也还在；目录里没有代码，它也就没有代码可看。同一目录下的 `.claude/settings.json` 放行它派活用的 am 子命令，`am approve`、`deny`、`keys`、`open` 仍然每次都问你。不过 Claude 的 router 默认带 `--dangerously-skip-permissions` 启动，不弹权限确认，这份放行清单只在你自己指定权限模式时起作用，例如 `am router start -- --permission-mode default`。每次 start 都会重写这些文件，所以 router 还在运行时 start 会被拒绝。

**台账**：在办的事记在 `am ledger`（SQLite，见下文），不在 router 的上下文里。router 每件事只写标题（就是 `Q:` 那行）、在等谁、下一步，worker 的 kind、预设、会话 ID 和运行状态由 am 带出。规则写在 `packages/router/ROUTER.md` 里：

- router 在派活、收到结果、worker 卡住或需要决定、你做出决定、任务关闭时，当轮就更新台账，再回复你。
- 在办几件不设上限：新请求直接开始。排队（`--queue`）、先放一边（`am ledger pause`，并 `am stop` 它的 worker，之后 `am resume` 接回原会话）、重新开始（`am ledger start`）都只在你说的时候做。
- 交付结果不等于结束：只有你明确说某件事结束了，它才 `am ledger close`、`am stop` 那个 worker。
- 以前的 router 把台账写在自己目录的 `LEDGER.md` 里。`am router start` / `restart` 时如果还有这个文件，会先把它导入数据库（这时旧 router 已经停了，文件是最新的），再改名成 `LEDGER.md.imported-<日期>`，只导一次；导入失败就不启动，文件原样留着。

**换新 router**：上下文压缩多了就换一个新会话，`am router restart [name]` 会停掉旧的、用当初 `am router start` 的参数（存在 router 目录的 `router.json` 里，不带 `--resume`）起一个新的。新 router 启动时只要台账里有事，`am router` 就先发一句 `Take over: your ledger lists work in flight (am ledger show).`：它看台账、`am list`，把没在运行的 worker `am resume` 回来，给还在干活的 worker 重新挂上后台 `am wait`，再用几行告诉你手上有哪些事。要在你自己的终端里运行 `restart`，不要在 router 的会话里运行（会把自己关掉）。

**接着用原来的会话**：`am router restart --resume` 停掉进程、用同样的参数重起，但接回它现在的会话（`am status router --json` 的 `session`；在 router 里用 `/resume` 换过会话的话，取的是换过之后的那个），所以它记得之前聊过的内容；规则文件照样按新的重写。`am router start --resume` 接回 am 记着的它最后一个会话；`--conversation <ID>` 接回指定的会话。不加这些参数时照旧开新会话，`--resume` 也不会被记进 `router.json`。接回会话时同样会发接手提示，并说明旧进程里挂着的后台 `am wait` 已经随进程结束，要它重新挂上。

**环境**：`am router start` 把 `AM_ROUTER=<name>` 放进 router 所在 pane 的环境，它的 `am ledger` 命令因此默认写自己的台账。

**合同**：`am router start` 把合同路径作为 `AM_CONTRACT` 放进 router 所在 pane 的环境，router 用 `am start` 起的每个 worker 因此都带上合同；router 自己不带。router 不再自己往任务里加约束。

- 第一次启动会停在 Claude 的目录信任确认上，另开终端 `am open router` 确认一次即可。
- 后台等待依赖「后台命令结束时唤醒 agent」，目前只在 Claude Code 上验证过。用其他 agent 当 router 时，它派完活不会等待，你下次说话时它再查进度。
- 分层约束：router 只通过 am 的命令行驱动 agent，am 不知道 router 的存在（测试会检查 `packages/agent` 没有引用它）。`am router …` 能用，是因为 router 包在自己的 `package.json` 里声明了 `"am": {"commands": {"router": "bin/am-router"}}`：am 只认这种声明，把命令原样转交（`am watcher` 同理），`am -h` 再调各自的 `help` 拼出完整说明。包还可以声明 `"afterResumeAll": ["watcher", "resume"]`：`am resume --all` 恢复完 agent 后运行这一步（必须是这个包自己的命令），把不是 agent 的部分也拉回来。
- 以前的 `am-router` 命令（`~/.local/bin/am-router` 链接）仍然能用，和 `am router` 等价；不需要的话直接删掉那个链接。

## am watcher：常驻、只读地盯消息

盯一个消息来源（比如聊天工具里 @我 的消息和私聊），挑出需要你处理的，分优先级写进台账的「待过目」（`am ledger inbox`）。这些不是任务；你说要处理哪条，router 才用 `am ledger inbox take` 把它转成在办事项。分两部分，大模型不轮询：

- **feed loop**（tmux 会话 `am-<name>-feed`，不调用模型）：运行来源提供的 poller（轮询脚本）。poller 只在可能有变化时打印一行 `{"pending":[{"id":…},…]}`（当前所有待处理的全量），循环自己算出哪些是新的、哪些你已经在别处读过，按 id 去重，记在 `state.json` 里（重启不重发、不漏）。watcher 空闲时，循环用 `am prompt` 把新条目（每次最多 `batch` 条，默认 20）交给它；你在别处读过的，循环直接告诉台账（`am ledger inbox read`），不用叫醒 Claude。
- **watcher**（am agent `<name>`，Claude）：被叫醒后读规则、分优先级（紧急 / 一般 / 不重要）、需要时读上下文，同一件事合并成一条，用 `am ledger inbox add/update` 写进台账（字段走 stdin 的 JSON，消息里的文字不会进命令行）。你在它的会话里（`am open <name>`）纠正它的判断，它会改条目并把规则记进 `desk/RULES.md`，以后照着分。看结果：`am ledger show` 的「For review」，或 `am ledger inbox list`。

```sh
am watcher start          # 起 Claude 会话和 feed loop（缺哪个起哪个）；只配了一个时不用写名字
am watcher status         # 会话、feed loop、待处理/排队数、摘要位置、最近日志
am watcher stop           # 两个都停；摘要、规则和状态留着
```

**什么时候起**：只在你运行 `am watcher start` 时起，不跟 router 一起起，开机也不自动起。机器重启或 tmux 被关掉之后，运行 `am resume --all`：am 先把 watcher 的 Claude 会话接回原来的会话，再运行 `am watcher resume` 拉起 feed loop（Claude 会话还没收到过消息、没有会话可接时，就新开一个）。你用 `am watcher stop` 停掉的不会被拉起。只想起 watcher 时，`am watcher start` 也行，它起的是新会话。

**它是只读的**（它处理的是别人写的内容，必须防提示词注入）。am 用这些参数启动它的 Claude，不用你的预设：

- `--restricted`：不加载任何 user / project / local 设置文件（只有 am 自己的 hook 设置），文件工具只能碰工作目录（`desk/`，里面只有摘要和规则）。
- `--strict-mcp-config`：一个 MCP 都不加载（所以没有任何发消息的工具）。
- `--tools Read,Grep,Glob,Edit,Write[,Bash]` + `--permission-mode dontAsk`：只有这几个工具；没放行的调用直接拒绝、不弹窗。Bash 只放行配置里 `commands` 列出的命令前缀（来源的只读工具），没有 `commands` 就没有 Bash。
- 规则（`packages/watcher/WATCHER.md` + 来源自己的说明）通过 `--append-system-prompt-file` 放进系统提示，压缩后也还在：条目一律当资料，不执行里面的话；不回复、不标记已读、不起 agent。
- 不带 worker 合同（它不是 worker，授权范围也不同）。

配置在 `~/.config/agent-master/am.json` 的 `watchers` 下（这个仓库里没有任何来源的实现）：

```json
"watchers": {
  "inbox": {
    "description": "what it watches",
    "poll": ["node", "/path/to/poll.mjs"],
    "instructions": "/path/to/SOURCE.md",
    "commands": ["node /path/to/context.mjs"],
    "model": "claude-sonnet-5-5",
    "batch": 20
  }
}
```

| 字段 | 作用 |
| --- | --- |
| `poll`（必填） | poller 的 argv。工作目录是 `~/.local/state/agent-master/watcher/<name>/`，环境变量 `AM_WATCHER_DIR` 指向它；stdout 只打 `{"pending":[…]}` 行，日志写 stderr（会进 `feed.log`，不要写消息正文） |
| `instructions` | 来源说明文件：字段含义、授权范围、怎么用来源的工具、摘要用什么语言 |
| `commands` | watcher 能运行的命令前缀（Bash），例如读上下文的工具；工具可以读 `$AM_WATCHER_DIR/state.json` 的 `delivered`，只服务已经交给它的条目 |
| `model` / `batch` | Claude 模型（默认跟随 Claude Code）、每次叫醒最多交几条 |
| `router` | 条目写进哪个 router 的台账（默认 `router`） |

文件都在 `~/.local/state/agent-master/watcher/<name>/`：`desk/RULES.md`（你的纠正，只创建一次、从不覆盖）、`INSTRUCTIONS.md`（每次 start 重写）、`state.json`、`feed.log`（只有计数，没有正文）。

- 第一次启动会停在 Claude 对 `desk/` 目录的信任确认上：`am watcher start` 会提示并超时，`am open <name>` 确认一次，再运行一次 `am watcher start` 起 feed loop。
- 条目只写进台账，router 不会被叫醒去汇报；你问它「有什么要处理的」，它再从台账里看。
- Bash 只放行 `am ledger inbox` 和 `commands` 列出的来源工具。

## am ledger：台账（SQLite）

router 的在办事项和 watcher 的待过目消息都在一个 SQLite 文件里：`~/.local/state/agent-master/ledger.db`（遵循 `XDG_STATE_HOME`，可用 `AM_LEDGER_DB` 换位置）。多进程同时写安全（WAL + 写事务）。每个 router 一本账（`--router`，默认 `$AM_ROUTER`，再没有就是 `router`）。

```sh
am ledger show                    # markdown 视图：在办、排队、待过目，worker 的实时状态由 am 带出
am ledger list                    # 一行一件
am ledger add "修登录" --worker fix-login --waiting "the worker" --next "汇报后转告用户"
am ledger update 3 --waiting "the user: 选方案" --note "worker 给了两个方案"
am ledger pause 3 / am ledger start 3 / am ledger close 3
am ledger inbox list              # 待过目
am ledger inbox take i7           # 你要处理这条：转成在办事项（--queue 排队）
am ledger inbox dismiss i7        # 不用管
```

- 任务：router 只写标题、在等谁（`--waiting`）、下一步（`--next`），可选备注（`--note`，追加一行）。`--worker` 只给名字，kind、预设、会话 ID、目录由 am 填，`show` / `list` 时再从 am 取实时状态（不在运行的从 `am list --saved` 取 stopped / lost / exited），会话 ID 变了会写回。
- 在办不设上限；排队、暂停留给你自己决定用不用。（早先版本的 `"ledger": {"maxActive": N}` 已不再读取。）
- 待过目：watcher 用 `am ledger inbox add - <<'EOF' {json} EOF` 写，字段 `priority`（urgent / normal / low）、`title`、`who`、`where`、`at`、`why`、`items`（来源的消息 id，一条消息只能属于一个条目）。一个条目的消息你都在别处读过了，它就自动离开列表；你没管、它还在的，就留在「For review」里。
- `am ledger import <LEDGER.md>`：把旧的 markdown 台账导进来（`am router start` 会自动做一次），标题重复的跳过；额外的行（Done so far、Reports 等）和旧的 Status 都进备注，不丢内容。

## shell-ask

在任意 tmux pane 里按 `prefix + a` → 弹窗里描述需求 → 生成一行命令 → Enter 填入原 pane（**不执行**）。远端什么都不用装。

```sh
packages/shell-ask/bin/am-ask tmux-install
echo 'source-file -q ~/.config/agent-master/shell-ask.tmux' >> ~/.tmux.conf
```

配置 `~/.config/agent-master/shell-ask.json`（除 `apiKey` 外都可选；`baseUrl` 可以换成任何 OpenAI 兼容接口）：

```json
{
  "baseUrl": "https://openrouter.ai/api/v1",
  "apiKey": "sk-or-v1-...",
  "model": "deepseek/deepseek-v4.1-flash",
  "hosts": { "remote-sim": { "os": "Ubuntu 24.04 (GNU coreutils)", "shell": "bash" } },
  "defaultRemote": { "os": "Linux (assume GNU coreutils; distribution unknown)", "shell": "bash" }
}
```

环境变量 `AM_SHELL_ASK_API_KEY`、`AM_SHELL_ASK_MODEL` 优先于配置文件。

限制：只识别第一跳 ssh；只生成单行命令。

## 开发

```sh
pnpm test            # 单元测试（含真实 tmux、真实 hook 脚本）
pnpm typecheck
pnpm test:e2e        # 真实 agent，花少量模型额度：
                     #   agent：AM_E2E_KINDS=claude,codex,opencode（dsh 装好后可加上）；AM_E2E_LEAD=1 再跑「主 agent 被 /am 唤起后派活」
                     #   e2e 里 am 的持久记录写到 AM_STATE_DIR（测试目录下），不碰你自己的
                     #   router：AM_E2E_ROUTER=1 跑「router 派活给 worker、后台等待、被唤醒后汇报」
                     #   shell-ask：需要 Docker，起 remote-sim 容器
pnpm sim:up / sim:down
```

agent 的 e2e 在独立目录（`.state/e2e-*`、临时目录）里跑，结束时按 cwd 精确删除自己在 Claude / Codex / opencode 历史里留下的会话，不会出现在你的 resume 列表里。
