import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

import { quoteArg, type Tmux } from "@agent-master/tmux";

import { AmError, DRIVERS, poll, sleep } from "./drivers/index.ts";
import { AgentNotFound, findRecord, listRecords, NAME_PATTERN, paneOptions, type AgentKind, type AgentRecord, type AgentState } from "./registry.ts";

export interface AgentView {
  name: string;
  kind: AgentKind;
  paneId: string;
  tmuxSession: string;
  state: AgentState;
  detail: string;
  cwd: string;
  startedAt: number;
}

const SETTLED: AgentState[] = ["idle", "blocked", "exited"];

/** Every agent gets its own detached tmux session, named after it. */
export function sessionName(agent: string): string {
  return `am-${agent}`;
}

export async function view(record: AgentRecord): Promise<AgentView> {
  const { state, detail } = await DRIVERS[record.kind].status(record);
  return { name: record.name, kind: record.kind, paneId: record.paneId, tmuxSession: record.tmuxSession, state, detail, cwd: record.cwd, startedAt: record.startedAt };
}

export async function listAgents(tmux: Tmux): Promise<AgentView[]> {
  return Promise.all((await listRecords(tmux)).map(view));
}

export async function getAgent(tmux: Tmux, target: string): Promise<AgentView> {
  return view(await findRecord(tmux, target));
}

export interface StartOptions {
  name: string;
  kind: AgentKind;
  cwd?: string;
  model?: string;
  args?: string[];
  /** Extra environment for the agent process. */
  env?: Record<string, string>;
  /** Default: its own session. `window`: a new window in the caller's session. */
  placement?: "session" | "window";
  timeoutMs?: number;
  /** Receives non-fatal warnings (e.g. a trust dialog the user must answer). */
  warn?: (message: string) => void;
}

async function openPane(tmux: Tmux, options: StartOptions, spawn: { cwd: string; env?: Record<string, string>; command: string[] }): Promise<string> {
  if (options.placement === "window" && process.env.TMUX) {
    return tmux.newWindow(await tmux.display(process.env.TMUX_PANE, "#{session_name}"), spawn.command, { ...spawn, windowName: sessionName(options.name) });
  }
  const session = sessionName(options.name);
  if (await tmux.hasSession(session)) throw new AmError("session_taken", `tmux 会话 ${session} 已存在（不是 am 管理的 agent），换个名字或先关掉它`);
  // Detached sessions default to 80x24; give the agent's UI room until someone attaches.
  return tmux.newSession(session, { width: 200, height: 50, ...spawn });
}

/** Brings the agent's session to the user: switches the current client, or tells how to attach. */
export async function openAgent(tmux: Tmux, target: string): Promise<string> {
  const record = await findRecord(tmux, target);
  if (process.env.TMUX) {
    await tmux.run(["switch-client", "-t", record.paneId]);
    return `已切换到 ${record.tmuxSession}（prefix + ( 或 prefix + s 切回）`;
  }
  return `tmux attach -t ${record.tmuxSession}`;
}

/** How long a launched pane waits for am to register it; then it exits (am died mid-start). */
const GATE_TIMEOUT_S = 60;

/**
 * Wraps the agent's argv so it only starts after `tmux wait-for -S <gate>`.
 * A signal sent before the wait begins is not lost (tmux marks the channel
 * woken), and if the signal never comes the pane exits instead of running
 * an unregistered agent.
 */
export function gatedCommand(tmuxBin: string, gate: string, argv: string[], timeoutS = GATE_TIMEOUT_S): string[] {
  const script = [
    'tm=$1 gate=$2; shift 2',
    '"$tm" wait-for "$gate" & w=$!',
    // On timeout kill the waiter and this shell itself: a killed tmux client can
    // exit 0, so its status alone must not decide whether the agent runs.
    `( sleep ${timeoutS}; kill "$w" $$ 2>/dev/null ) & k=$!`,
    'wait "$w" || exit 1',
    'kill "$k" 2>/dev/null',
    'exec "$@"',
  ].join("\n");
  return ["sh", "-c", script, "am-gate", tmuxBin, gate, ...argv];
}

/** Serializes name checks and registration across concurrent `am start` calls. */
const START_LOCK = "am-start";

function tmuxPath(tmux: Tmux): string {
  if (tmux.bin.includes("/")) return tmux.bin;
  try {
    return execFileSync("sh", ["-c", `command -v ${tmux.bin}`], { encoding: "utf8" }).trim() || tmux.bin;
  } catch {
    return tmux.bin;
  }
}

export async function startAgent(tmux: Tmux, options: StartOptions): Promise<AgentView> {
  const { name, kind } = options;
  if (!NAME_PATTERN.test(name)) throw new AmError("bad_name", `名字需要匹配 ${NAME_PATTERN}`);

  const driver = DRIVERS[kind];
  const cwd = resolve(options.cwd ?? process.cwd());
  for (const warning of await driver.preflight(cwd, options.args ?? [])) options.warn?.(warning);
  const plan = await driver.launch({ cwd, model: options.model, args: options.args ?? [] });

  const gate = `am-go-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Without a running server there is nothing to lock against (and wait-for cannot start one).
  const locked = await tmux.run(["wait-for", "-L", START_LOCK]).then(
    () => true,
    () => false,
  );
  let paneId: string;
  let startedAt: number;
  try {
    if ((await listRecords(tmux)).some((r) => r.name === name)) throw new AmError("name_taken", `已经有一个叫 ${name} 的 agent`);
    const command = gatedCommand(tmuxPath(tmux), gate, plan.command);
    paneId = await openPane(tmux, options, { cwd, env: { ...options.env, ...plan.env }, command });
    // Measured from here: the agent itself starts once the gate opens below.
    startedAt = Date.now();
    try {
      await tmux.setPaneOptions(paneId, paneOptions({ name, kind, cwd, startedAt, state: "starting", ...plan.fields }));
    } catch (error) {
      await tmux.killPane(paneId).catch(() => {});
      throw error;
    }
  } finally {
    if (locked) await tmux.run(["wait-for", "-U", START_LOCK]).catch(() => {});
  }
  // Registered: let the agent run.
  await tmux.run(["wait-for", "-S", gate]);

  const reload = () =>
    findRecord(tmux, paneId).catch((error) => {
      // Agents run as the pane's command, so a vanished pane means the agent exited.
      if (error instanceof AgentNotFound) throw new AmError("exited", `${name} 启动后退出了（pane ${paneId} 已关闭）`);
      throw error;
    });
  await driver.waitReady(tmux, reload, startedAt + (options.timeoutMs ?? 60_000));
  // claude reports readiness from its own hook; the others are ready once waitReady returns,
  // unless a hook already reported something (e.g. a prompt passed on the command line).
  if (kind !== "claude") {
    await tmux.run(["if-shell", "-F", "-t", paneId, "#{&&:#{==:#{@am_state},starting},#{==:#{@am_event},}}", `set-option -p -t ${paneId} @am_state idle`]);
  }
  return view(await reload());
}

export async function waitAgent(tmux: Tmux, target: string, until: AgentState[] = SETTLED, timeoutMs = 0): Promise<AgentView> {
  const deadline = timeoutMs ? Date.now() + timeoutMs : 0;
  const result = await poll(async () => {
    const current = await getAgent(tmux, target).catch((error) => {
      if (error?.name === "AgentNotFound") return { state: "exited" } as AgentView;
      throw error;
    });
    if (until.includes(current.state) || current.state === "exited") return current;
    return undefined;
  }, deadline);
  if (!result) throw new AmError("timeout", `等待 ${target} 超时（${timeoutMs}ms）`);
  return result;
}

export interface PromptOptions {
  wait?: boolean;
  timeoutMs?: number;
}

/** A send lock older than this is considered abandoned (its holder crashed). */
const LOCK_TTL_S = 120;

/**
 * Pane-level lock so two `am prompt` calls cannot interleave their keystrokes.
 * The check-and-set runs inside the tmux server, which executes commands one at a time.
 */
export async function acquireSendLock(tmux: Tmux, paneId: string, name: string): Promise<string> {
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = Math.floor(Date.now() / 1000);
  await tmux.run([
    "if-shell", "-F", "-t", paneId,
    `#{||:#{==:#{@am_lock},},#{e|<:#{@am_lock_ts},${now - LOCK_TTL_S}}}`,
    `set-option -p -t ${paneId} @am_lock ${token} ; set-option -p -t ${paneId} @am_lock_ts ${now}`,
  ]);
  if ((await tmux.display(paneId, "#{@am_lock}")) !== token) throw new AmError("agent_busy", `另一个 am prompt 正在给 ${name} 发送`);
  return token;
}

export async function releaseSendLock(tmux: Tmux, paneId: string, token: string): Promise<void> {
  await tmux.run(["if-shell", "-F", "-t", paneId, `#{==:#{@am_lock},${token}}`, `set-option -p -t ${paneId} @am_lock ''`]).catch(() => {});
}

function assertIdle(record: AgentRecord, current: AgentView): void {
  if (current.state === "blocked") throw new AmError("agent_blocked", `${record.name} 正在等待确认（${current.detail}），先处理：am approve / am deny`);
  if (current.state === "working") throw new AmError("agent_busy", `${record.name} 还在工作，先 am wait ${record.name}`);
  if (current.state !== "idle") throw new AmError("agent_not_ready", `${record.name} 当前状态是 ${current.state}，不能发送`);
}

/**
 * Types `text` into the agent as one paste plus Enter, then confirms the agent
 * accepted it (its prompt marker changes) before optionally waiting for it to settle.
 */
export async function promptAgent(tmux: Tmux, target: string, text: string, options: PromptOptions = {}): Promise<AgentView> {
  const found = await findRecord(tmux, target);
  assertIdle(found, await view(found));

  const token = await acquireSendLock(tmux, found.paneId, found.name);
  const started = Date.now();
  try {
    // Re-check under the lock: another prompt may have been accepted meanwhile.
    const record = await findRecord(tmux, found.paneId);
    assertIdle(record, await view(record));
    await submitPrompt(tmux, record, text, token);
  } finally {
    await releaseSendLock(tmux, found.paneId, token);
  }

  if (!options.wait) return getAgent(tmux, found.paneId);
  const remaining = options.timeoutMs ? Math.max(1, options.timeoutMs - (Date.now() - started)) : 0;
  return waitAgent(tmux, found.paneId, SETTLED, remaining);
}

const LOCK_LOST = "__am_lock_lost__";

/**
 * Runs `command` inside the tmux server only while this caller still holds the
 * send lock: the check and the keystrokes are one atomic step.
 */
export async function whileLocked(tmux: Tmux, paneId: string, token: string, command: string): Promise<void> {
  const out = await tmux.run(["if-shell", "-F", "-t", paneId, `#{==:#{@am_lock},${token}}`, command, `display-message -p ${LOCK_LOST}`]);
  if (out.includes(LOCK_LOST)) throw new AmError("lock_lost", "发送时失去了发送锁（另一个 am prompt 接手了），已停止");
}

async function submitPrompt(tmux: Tmux, record: AgentRecord, text: string, token: string): Promise<void> {
  const driver = DRIVERS[record.kind];
  const pane = record.paneId;
  const before = await driver.promptMarker(record);
  let after = before;
  const accepted = async (window: number) =>
    poll(async () => {
      after = await driver.promptMarker(await findRecord(tmux, pane));
      return after !== before ? true : undefined;
    }, Date.now() + window);

  const paste = async (body: string) => {
    const buffer = `am-${process.pid}-${Date.now()}`;
    await tmux.runWithInput(["load-buffer", "-b", buffer, "-"], body);
    await whileLocked(tmux, pane, token, `paste-buffer -p -d -b ${buffer} -t ${pane}`).catch(async (error) => {
      await tmux.run(["delete-buffer", "-b", buffer]).catch(() => {});
      throw error;
    });
  };

  if (text.startsWith("/")) {
    // A pasted "/cmd" is plain text to the agent; slash commands must be typed.
    const [first, ...rest] = text.split("\n");
    await whileLocked(tmux, pane, token, `send-keys -t ${pane} -l -- ${quoteArg(first)}`);
    if (rest.length) await paste(`\n${rest.join("\n")}`);
  } else {
    await paste(text);
  }
  await sleep(300);
  await whileLocked(tmux, pane, token, `send-keys -t ${pane} Enter`);

  // No automatic resend: without proof the text never reached the input box,
  // typing it again could duplicate it or land its Enter on a dialog.
  if (!(await accepted(driver.acceptTimeoutMs))) {
    throw new AmError("prompt_stalled", `${record.name} 没有确认收到 prompt，用 am open ${record.name} 看一下，别直接重发`);
  }
  await driver.afterAccepted?.(tmux, record, after);
}

export async function readReply(tmux: Tmux, target: string): Promise<string> {
  const record = await findRecord(tmux, target);
  return DRIVERS[record.kind].readReply(record);
}

export async function approveAgent(tmux: Tmux, target: string, scope: "once" | "always" = "once"): Promise<void> {
  const record = await findRecord(tmux, target);
  if ((await view(record)).state !== "blocked") throw new AmError("not_blocked", `${record.name} 没有在等待确认`);
  await DRIVERS[record.kind].approve(tmux, record, scope);
  if (record.kind !== "opencode" && /^[A-Za-z0-9_-]*$/.test(record.pending)) {
    // No hook fires on approval (the next one is PostToolUse, after the tool
    // finishes), so record the resumed work ourselves, but only while the same
    // request is still pending. The check-and-set runs inside the tmux server,
    // so a hook that already moved on is never overwritten.
    await tmux.run([
      "if-shell", "-F", "-t", record.paneId,
      `#{&&:#{==:#{@am_state},blocked},#{==:#{@am_pending},${record.pending}}}`,
      `set-option -p -t ${record.paneId} @am_state working ; set-option -p -t ${record.paneId} @am_pending ''`,
    ]);
  }
}

export async function denyAgent(tmux: Tmux, target: string): Promise<void> {
  const record = await findRecord(tmux, target);
  if ((await view(record)).state !== "blocked") throw new AmError("not_blocked", `${record.name} 没有在等待确认`);
  await DRIVERS[record.kind].deny(tmux, record);
}

export async function interruptAgent(tmux: Tmux, target: string): Promise<AgentView> {
  const record = await findRecord(tmux, target);
  if ((await view(record)).state !== "working") throw new AmError("not_working", `${record.name} 没有在工作`);
  await DRIVERS[record.kind].interrupt(tmux, record);
  const settled = await poll(async () => {
    const current = await getAgent(tmux, record.paneId);
    return current.state !== "working" ? current : undefined;
  }, Date.now() + 8000);
  if (!settled) {
    throw new AmError(
      "interrupt_unconfirmed",
      `${record.name} 没有确认中断。若是在模型开始输出前取消的，prompt 会被退回输入框且不留任何记录；用 am open ${record.name} 看一下`,
    );
  }
  return settled;
}

export async function sendKeys(tmux: Tmux, target: string, keys: string[]): Promise<void> {
  const record = await findRecord(tmux, target);
  await tmux.sendKeys(record.paneId, ...keys);
}

export async function stopAgent(tmux: Tmux, target: string): Promise<void> {
  const record = await findRecord(tmux, target);
  await tmux.killPane(record.paneId);
}
