# agent-master

基于 tmux 的 agent 工具集（思路参考 [herdr](https://github.com/herdrdev/herdr)），pnpm monorepo。**全程不读屏幕**：状态来自 agent 的 hook、对话记录文件和官方 API。

```
packages/
  tmux/         @agent-master/tmux       tmux CLI 的类型化封装 + pane 前台进程识别
  agent/        @agent-master/agent      am：在 tmux 里启动、驱动、协同 claude / codex / opencode
  shell-ask/    @agent-master/shell-ask  一句话 → 一行 shell 命令，填入当前 pane（本机或 ssh 远端）
  bruno-mcp/    @agent-master/bruno-mcp  MCP：把请求写进 Bruno collection，在 Bruno 里点发送
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

不用 `.claude/skills/am` 是因为 opencode 也会读它，而且不认 `disable-model-invocation`。`am prompt` 遇到以 `/` 开头的内容会逐字输入第一行，因为粘贴进去的 `/xxx` 不会被当成斜杠命令。

```sh
am start reviewer --kind codex            # 开在独立的 tmux 会话 am-reviewer；就绪后返回
am prompt reviewer "review 一下未提交的改动，只列可执行的问题" --wait --timeout 600000
am read reviewer                          # 它这一轮的最终回复（读对话记录 / API，不读屏幕）
am stop reviewer
```

| 命令 | 作用 |
| --- | --- |
| `am start <name> --kind claude\|codex\|opencode [--cwd] [--model] [--env K=V] [--window] [-- 原生参数]` | 在独立会话 `am-<name>` 里启动（`--window` 改为当前会话的新窗口）、注入状态上报、等就绪 |
| `am open <name>` | 切到它的会话（tmux 外打印 `tmux attach` 命令）；也可以 `prefix + s` 选 |
| `am list` / `am status <name>` | 状态：`starting` `idle` `working` `blocked` `exited` `unknown`；`detail` 说明在等什么 |
| `am prompt <name> <text\|-> [--wait] [--timeout]` | 粘贴 + 回车，并确认对方收到；blocked / working 时拒绝 |
| `am wait <name> [--until idle,blocked]` | 等状态 |
| `am read <name>` | 最近一轮的最终回复 |
| `am approve <name> [--always]` / `am deny <name>` | 处理权限请求（`--always` 仅 opencode） |
| `am interrupt <name>` / `am keys <name> <key>...` / `am stop <name>` | 中断 / 原始按键 / 关闭 |

所有命令支持 `--json`。每个 agent 一个后台会话，`am list` 的 SESSION 列就是会话名；在会话里可以直接接管（输入、Esc、批准），`am stop` 会连同会话一起关掉。

### 状态从哪来

| | Claude Code | Codex | opencode |
| --- | --- | --- | --- |
| 注入方式 | `--settings`（不改你的配置） | `-c hooks.*`（不改配置文件；首次要信任一次） | `--port` + `OPENCODE_SERVER_PASSWORD` |
| working / blocked / idle | hook：UserPromptSubmit / PermissionRequest、AskUserQuestion / Stop | hook：UserPromptSubmit / PermissionRequest / Stop | 内置服务 API：`/session/status`、`/permission`、`/question` |
| Esc 中断 | 无 hook：读对话记录里的 `[Request interrupted by user…]` | `Interrupt` hook | API |
| 回复 | 对话记录 JSONL | 对话记录里的 `task_complete` | `GET /session/{id}/message` |
| 批准 / 中断 | 按键 Enter / Esc | 按键 Enter / Esc | API |

hook 把状态写在 agent 所在 pane 的 `@am_*` 选项上（`tmux show-options -p`），所以没有常驻进程；对话记录只从本轮开始的偏移量往后读。

几个保证不误操作的细节：
- **启动**：agent 进程先停在 `tmux wait-for <通道>` 上，`am` 按 pane id 写好记录后发信号放行（信号先到也不会丢），hook 不可能先于记录运行；`am` 中途退出时，pane 60 秒后自行退出，不会启动一个没有记录的 agent。同名检查和建 pane 在一把全局启动锁里完成。
- **发送**：每个 agent 一把发送锁（tmux 内原子加锁，120 秒过期）；每次按键都是一条 tmux 内的 `if-shell`，锁不在自己手里就不发。「已收到」只看 `UserPromptSubmit` 原子自增的 `@am_seq`（opencode 看服务端的 busy 会话）；没确认就报 `prompt_stalled`，**从不重发**，避免同一个任务被执行两次。
- **不让弹窗吃掉按键**：am 启动的 Codex 关掉启动时的更新检查（`check_for_update_on_startup=false`），opencode 关掉自动更新（`OPENCODE_DISABLE_AUTOUPDATE=1`）。否则更新对话框会在任意时刻弹出，`am prompt` 的 Enter 会替你确认升级。
- **权限**：`PermissionRequest` 不带 `tool_use_id`，用「工具名 + 输入」的校验和与 `PostToolUse` 配对（Codex 给 Bash 输入额外加的 `description` 会先去掉），并行工具完成不会误清 blocked；`am approve` 只在仍是同一个请求时把状态改成 working。
- **调试**：`am start ... --env AM_HOOK_LOG=/tmp/hooks.ndjson` 会把 hook 收到的原始输入逐条记下来。

### 首次使用会遇到的确认（hook 看不到，需要人到它的会话里点一次）

- Claude：目录信任（父目录信任过就不会问）
- Codex：目录信任（按 git 根目录记录），以及 am 的 hooks 信任（`Trust all and continue`，记录在 `~/.codex/config.toml` 的 `[hooks.state]`）

`am start` 会提前提示；没确认时会超时报错。

### 已知限制

- **Claude 在模型开始输出前被 Esc**：它把 prompt 退回输入框，不写对话记录、不触发 hook，状态会停在 `working` 直到人再次提交。`am interrupt` 会等这一轮至少 3 秒再按 Esc，并在没确认时报 `interrupt_unconfirmed`；这种状态下 `am prompt` 会拒绝发送，不会把新内容拼进残留的输入。
- Codex 第一次提交前没有任何事件，`am start` 用固定 3 秒作为就绪判断；在此之前会先等两个信任确认都写进 `config.toml`，否则 prompt 的 Enter 会替你答掉确认框。opencode 的界面比 API 晚就绪，`am start` 在 API 就绪后再等 3 秒。
- 两个**完全相同**的工具调用（同名同输入）并行等待批准时，先完成的那个会把 blocked 清掉；hook 里没有能区分它们的字段。
- opencode 的会话按「`am prompt` 确认收到时服务端正在跑的会话」绑定。人在它的界面里切换或新建会话后，`am read` 仍读绑定的那个，直到下一次 `am prompt`；还没收到过 `am prompt` 且空闲时报 `no_session`，不会去猜「最新的会话」（同一项目的其他 opencode 实例共享会话列表）。
- Codex 的目录信任：在 git 仓库里只认仓库根目录那一条（信任过父目录不算），`-c projects."<dir>".trust_level="trusted"` 也只在 git 仓库外生效（后出现的 `untrusted` 会撤销）。hook 信任按 Codex 源码的算法（`codex-rs` 的 `hook_hash`：规范化 hook 定义的 JSON 做 sha256）逐条核对 `[hooks.state]`，仓库搬家、hook 被禁用都会被识别。这依赖 Codex 0.160 的算法，Codex 改算法后 `am` 会一直等待信任，需要跟着更新。`config.toml` 用 TOML 解析器读取，解析失败按「未信任」处理。
- Codex 文档只说 SubagentStart/Stop 带 `agent_id`；如果它自己的子 agent 的其他事件不带，这些事件会影响父 agent 的状态。
- 读写依赖 Claude / Codex 对话记录的内部格式，升级后用 e2e 测试回归。

## shell-ask

在任意 tmux pane 里按 `prefix + a` → 弹窗里描述需求 → 生成一行命令 → Enter 填入原 pane（**不执行**）。远端什么都不用装。

```sh
packages/shell-ask/bin/am-ask tmux-install
echo 'source-file -q ~/.config/agent-master/shell-ask.tmux' >> ~/.tmux.conf
```

配置 `~/.config/agent-master/shell-ask.json`（全部可选）：

```json
{
  "model": "openrouter/deepseek/deepseek-v4.1-flash",
  "hosts": { "remote-sim": { "os": "Ubuntu 24.04 (GNU coreutils)", "shell": "bash" } },
  "defaultRemote": { "os": "Linux (assume GNU coreutils; distribution unknown)", "shell": "bash" }
}
```

限制：只识别第一跳 ssh；只生成单行命令；每次调用约 4–6 秒（opencode 冷启动）。

## bruno-mcp

给 agent 用的 MCP server（stdio）：让它在 [Bruno](https://www.usebruno.com/) 的 collection 里新建、修改请求。Bruno 的 collection 就是磁盘上的 `.yml` / `.bru` 文件，Bruno 会监听这些文件，所以写进去的请求立刻出现在 Bruno 侧边栏里，**由你在 Bruno 里发送**。这个 server 本身不发请求。

| 工具 | 作用 |
| --- | --- |
| `list_collections` | Bruno 打开的 collection（读 Bruno 的 `preferences.json` 和各 workspace 的 `workspace.yml`） |
| `get_collection` | 文件夹、请求（路径 / 名字 / method / URL）、collection 环境和 workspace 全局环境的变量（secret 只列名字） |
| `read_request` | 读一个请求，格式和下面两个工具的参数一致 |
| `create_request` | 新建 HTTP 请求；文件夹不存在会按 Bruno 的方式建好（带 `folder.yml` / `folder.bru`），seq 排在末尾 |
| `update_request` | 只改传入的字段，列表字段（headers、assertions…）整体替换；改名不改文件名 |

可写的字段：method、url（query 参数从 URL 解析，和 Bruno 一致）、path 参数、headers、body（none / json / text / xml / sparql / form-urlencoded / multipart）、auth（inherit / none / bearer / basic / apikey）、前后置脚本、vars、assertions、tests、docs、tags。其他 body / auth 类型（graphql、oauth2…）读出来标为 `editable: false`，修改别的字段时原样保留。GraphQL / gRPC / WebSocket 请求只列出来，不能改。

读写都用 `@usebruno/filestore`，也就是 Bruno 自己的序列化库，`.yml` 和 `.bru` 两种 collection 都支持，写出来的文件和在 Bruno 里新建的一样。路径限制在 collection 里面，跳过 Bruno 不加载的部分（`ignore` 配置、`node_modules`、`environments/`、`mocks/`、`.env`）。

接入（路径换成你的仓库位置）：

```sh
claude mcp add --scope user bruno -- /path/to/agent-master/packages/bruno-mcp/bin/am-bruno-mcp
```

```toml
# Codex：~/.codex/config.toml
[mcp_servers.bruno]
command = "/path/to/agent-master/packages/bruno-mcp/bin/am-bruno-mcp"
```

```json
// opencode：opencode.json
{ "mcp": { "bruno": { "type": "local", "command": ["/path/to/agent-master/packages/bruno-mcp/bin/am-bruno-mcp"] } } }
```

Bruno 的数据目录默认是 macOS `~/Library/Application Support/bruno`、Linux `~/.config/bruno`、Windows `%APPDATA%\bruno`，可以用 `AM_BRUNO_DATA_DIR` 覆盖（测试就是这么做的）。不在 Bruno 里打开的 collection 也能用，直接传它的绝对路径。

`@usebruno/filestore@0.12.0` 运行时要用 `nanoid`，但只把它声明成了 devDependency，根 `package.json` 用 `pnpm.packageExtensions` 补上；升级 filestore 时这里的版本号要一起改。

## 开发

```sh
pnpm test            # 单元测试（含真实 tmux、真实 hook 脚本）
pnpm typecheck
pnpm test:e2e        # 真实 agent，花少量模型额度：
                     #   agent：AM_E2E_KINDS=claude,codex,opencode；AM_E2E_LEAD=1 再跑「主 agent 被 /am 唤起后派活」
                     #   shell-ask：需要 Docker，起 remote-sim 容器
pnpm sim:up / sim:down
```

agent 的 e2e 在独立目录（`.state/e2e-*`、临时目录）里跑，结束时按 cwd 精确删除自己在 Claude / Codex / opencode 历史里留下的会话，不会出现在你的 resume 列表里。
