import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { quoteArg, type Tmux } from "@agent-master/tmux";

import { config, contractPath, DEFAULT_STALL_AFTER_MINUTES, findProfile, loadConfig, profileLaunch } from "./config.ts";
import { AmError, DRIVERS, poll, sleep } from "./drivers/index.ts";
import type { StallReason, StatusView } from "./drivers/types.ts";
import { AgentNotFound, findRecord, listRecords, NAME_PATTERN, paneOptions, writeRecord, type AgentKind, type AgentRecord, type AgentState } from "./registry.ts";
import { listSaved, markExited, readSaved, removeSaved, savedStatus, syncSession, updateSaved, writeSaved, type SavedAgent, type SavedStatus } from "./saved.ts";

export interface AgentView {
  name: string;
  kind: AgentKind;
  paneId: string;
  tmuxSession: string;
  state: AgentState;
  detail: string;
  cwd: string;
  startedAt: number;
  /** The agent's own conversation id (what `am resume` reopens); empty until it reports one. */
  session: string;
  model: string;
  profile: string;
  /** Worker contract file attached to the prompts am sends it. */
  contract: string;
  /** Why it is `stalled`. */
  stall?: StallReason;
  stallId?: string;
}

const SETTLED: AgentState[] = ["idle", "blocked", "stalled", "exited"];

/** The stall threshold; a broken config must not break am list or am wait, so it falls back to the default. */
async function stallAfterMs(): Promise<number> {
  const minutes = await config().then((c) => c.stallAfterMinutes, () => DEFAULT_STALL_AFTER_MINUTES);
  return minutes * 60_000;
}

/** A working agent that has written nothing for `afterMs` is reported as stalled: no_output. */
export function noOutputStall(status: StatusView, now: number, afterMs: number): StatusView {
  if (status.state !== "working" || !status.activity || now - status.activity < afterMs) return status;
  const minutes = Math.floor((now - status.activity) / 60_000);
  return { state: "stalled", detail: `no output for ${minutes}m`, stall: "no_output", stallId: `no_output:${status.activity}` };
}

/** Every agent gets its own detached tmux session, named after it. */
export function sessionName(agent: string): string {
  return `am-${agent}`;
}

export async function view(record: AgentRecord): Promise<AgentView> {
  const status = noOutputStall(await DRIVERS[record.kind].status(record), Date.now(), await stallAfterMs());
  await syncSession(record);
  return {
    name: record.name,
    kind: record.kind,
    paneId: record.paneId,
    tmuxSession: record.tmuxSession,
    state: status.state,
    detail: status.detail,
    cwd: record.cwd,
    startedAt: record.startedAt,
    session: record.session,
    model: record.model,
    profile: record.profile,
    contract: record.contract,
    ...(status.stall ? { stall: status.stall, stallId: status.stallId } : {}),
  };
}

export async function listAgents(tmux: Tmux): Promise<AgentView[]> {
  const records = await listRecords(tmux);
  await markExited(await listSaved(), records, await serverId(tmux)).catch(() => {});
  return Promise.all(records.map(view));
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
  /** An argument-compatible wrapper that replaces the kind's own executable (`--bin`). */
  bin?: string;
  /** Extra environment for the agent process. */
  env?: Record<string, string>;
  /** Default: its own session. `window`: a new window in the caller's session. */
  placement?: "session" | "window";
  timeoutMs?: number;
  /** Receives non-fatal warnings (e.g. a trust dialog the user must answer). */
  warn?: (message: string) => void;
  /** Receives confirmations worth showing (e.g. a model variant read back from the agent). */
  note?: (message: string) => void;
  /** Recorded only: the profile these options came from (see resolveStart). */
  profile?: string;
  /** A worker contract file (absolute path) appended to the prompts am sends. */
  contract?: string;
  /** Reopen this conversation instead of starting a new one (am resume). */
  resume?: string;
  /** Hash of the contract version the resumed conversation already received in full. */
  contractSent?: string;
}

/** What `am start` was asked for, before a profile fills in the rest. */
export interface StartRequest extends Omit<StartOptions, "kind" | "profile" | "resume" | "contractSent"> {
  kind?: AgentKind;
  profile?: string;
}

/**
 * Merges a profile from the user's am.json under the request: explicit options
 * win, env is merged, native args are the profile's followed by the request's.
 * Without --contract or a profile's, $AM_CONTRACT names the worker contract.
 */
export async function resolveStart(request: StartRequest, cfgPath?: string): Promise<StartOptions> {
  const { profile: profileName, kind, ...rest } = request;
  const launch = profileName ? profileLaunch(findProfile(await loadConfig(cfgPath), profileName)) : undefined;
  if (launch && kind && kind !== launch.kind) throw new AmError("usage", `--kind ${kind} conflicts with profile ${profileName} (kind ${launch.kind})`);
  const resolvedKind = kind ?? launch?.kind;
  if (!resolvedKind) throw new AmError("usage", "pass --kind or --profile");
  const contract = rest.contract ?? launch?.contract ?? (process.env.AM_CONTRACT || undefined);
  return {
    ...rest,
    kind: resolvedKind,
    profile: profileName,
    bin: rest.bin ?? launch?.bin,
    model: rest.model ?? launch?.model,
    env: { ...launch?.env, ...rest.env },
    args: [...(launch?.args ?? []), ...(rest.args ?? [])],
    contract: contract ? contractPath(contract) : undefined,
  };
}

async function openPane(tmux: Tmux, options: StartOptions, spawn: { cwd: string; env?: Record<string, string>; command: string[] }): Promise<string> {
  if (options.placement === "window" && process.env.TMUX) {
    return tmux.newWindow(await tmux.display(process.env.TMUX_PANE, "#{session_name}"), spawn.command, { ...spawn, windowName: sessionName(options.name) });
  }
  const session = sessionName(options.name);
  if (await tmux.hasSession(session)) throw new AmError("session_taken", `tmux session ${session} already exists and is not an am agent; pick another name or close it first`);
  // Detached sessions default to 80x24; give the agent's UI room until someone attaches.
  return tmux.newSession(session, { width: 200, height: 50, ...spawn });
}

/** Brings the agent's session to the user: switches the current client, or tells how to attach. */
export async function openAgent(tmux: Tmux, target: string): Promise<string> {
  const record = await findRecord(tmux, target);
  if (process.env.TMUX) {
    await tmux.run(["switch-client", "-t", record.paneId]);
    return `switched to ${record.tmuxSession} (prefix + ( or prefix + s to go back)`;
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

/** Whether `--bin` names an executable: a path relative to cwd, or a command on PATH. */
function executable(bin: string, cwd: string): boolean {
  try {
    execFileSync("/bin/sh", ["-c", 'command -v "$1" >/dev/null 2>&1', "sh", bin], { cwd, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Identifies a tmux server across restarts: its socket, pid and start time. */
async function serverId(tmux: Tmux, paneId?: string): Promise<string | undefined> {
  const format = "#{socket_path}:#{pid}:#{start_time}";
  if (paneId) return tmux.display(paneId, format).catch(() => undefined);
  return (await tmux.listPanes(format))[0];
}

export async function startAgent(tmux: Tmux, options: StartOptions): Promise<AgentView> {
  const { name, kind } = options;
  if (!NAME_PATTERN.test(name)) throw new AmError("bad_name", `name must match ${NAME_PATTERN}`);
  if (options.contract) {
    await access(options.contract).catch(() => {
      throw new AmError("contract_not_found", `worker contract not found: ${options.contract}`);
    });
  }

  const driver = DRIVERS[kind];
  const cwd = resolve(options.cwd ?? process.cwd());
  if (options.bin) {
    // A wrapper must take the same arguments as the CLI the driver knows how to
    // drive; drivers whose launch command is not that CLI cannot offer this.
    if (!driver.binCompatible) throw new AmError("unsupported", `--bin is not supported for ${kind}; it replaces the CLI of claude or codex`);
    if (!executable(options.bin, cwd)) throw new AmError("bin_not_found", `--bin ${options.bin} is not an executable file or a command on PATH`);
  }
  for (const warning of await driver.preflight(cwd, options.args ?? [])) options.warn?.(warning);
  const launchOptions = { cwd, model: options.model, args: options.args ?? [], bin: options.bin, resume: options.resume };
  const plan = await driver.launch(launchOptions);

  const gate = `am-go-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // Without a running server there is nothing to lock against (and wait-for cannot start one).
  const locked = await tmux.run(["wait-for", "-L", START_LOCK]).then(
    () => true,
    () => false,
  );
  let paneId: string;
  let startedAt: number;
  try {
    if ((await listRecords(tmux)).some((r) => r.name === name)) throw new AmError("name_taken", `an agent named ${name} already exists`);
    const command = gatedCommand(tmuxPath(tmux), gate, plan.command);
    paneId = await openPane(tmux, options, { cwd, env: { ...options.env, ...plan.env }, command });
    // Measured from here: the agent itself starts once the gate opens below.
    startedAt = Date.now();
    try {
      await tmux.setPaneOptions(
        paneId,
        paneOptions({
          name, kind, cwd, startedAt, state: "starting",
          model: options.model, profile: options.profile, contract: options.contract, contractSent: options.contractSent,
          ...plan.fields,
        }),
      );
    } catch (error) {
      await tmux.killPane(paneId).catch(() => {});
      throw error;
    }
    // Remembered from here on, so am resume can bring it back after tmux or the machine restarts.
    // Failing to remember costs only that, so it never stops the start.
    try {
      await writeSaved({
        name, kind, cwd,
        ...(options.bin ? { bin: options.bin } : {}),
        ...(options.model ? { model: options.model } : {}),
        env: { ...options.env },
        args: options.args ?? [],
        ...(options.profile ? { profile: options.profile } : {}),
        ...(options.contract ? { contract: options.contract } : {}),
        placement: options.placement ?? "session",
        session: plan.fields?.session ?? "",
        contractSent: options.contractSent ?? "",
        startedAt,
        server: (await serverId(tmux, paneId)) ?? "",
      });
    } catch (error) {
      options.warn?.(`could not record ${name} for am resume: ${error instanceof Error ? error.message : String(error)}`);
    }
  } finally {
    if (locked) await tmux.run(["wait-for", "-U", START_LOCK]).catch(() => {});
  }
  // Registered: let the agent run.
  await tmux.run(["wait-for", "-S", gate]);

  const reload = () =>
    findRecord(tmux, paneId).catch((error) => {
      // Agents run as the pane's command, so a vanished pane means the agent exited.
      if (error instanceof AgentNotFound) throw new AmError("exited", `${name} exited right after starting (pane ${paneId} is closed)`);
      throw error;
    });
  await driver.waitReady(tmux, reload, startedAt + (options.timeoutMs ?? 60_000));
  // claude reports readiness from its own hook; the others are ready once waitReady returns,
  // unless a hook already reported something (e.g. a prompt passed on the command line).
  if (kind !== "claude") {
    await tmux.run(["if-shell", "-F", "-t", paneId, "#{&&:#{==:#{@am_state},starting},#{==:#{@am_event},}}", `set-option -p -t ${paneId} @am_state idle`]);
  }
  if (driver.confirmLaunch) {
    try {
      const confirmed = await driver.confirmLaunch(await reload(), launchOptions);
      if (confirmed) options.note?.(confirmed);
    } catch (error) {
      // Running on settings it was not asked for is worse than not running.
      await updateSaved(name, startedAt, { stoppedAt: Date.now() }).catch(() => {});
      await tmux.killPane(paneId).catch(() => {});
      throw error;
    }
  }
  return view(await reload());
}

export interface ResumeOptions {
  placement?: "session" | "window";
  timeoutMs?: number;
  warn?: (message: string) => void;
  note?: (message: string) => void;
}

/** Starts a remembered agent again on its last conversation, with the options it was first started with. */
export async function resumeAgent(tmux: Tmux, name: string, options: ResumeOptions = {}): Promise<AgentView> {
  const saved = await readSaved(name);
  if (!saved) throw new AmError("not_found", `am has no record of ${name} (see am list --saved)`);
  if ((await listRecords(tmux)).some((r) => r.name === name)) throw new AmError("running", `${name} is running; to restart it on its conversation, am stop ${name} first`);
  if (!saved.session) throw new AmError("no_session", `${name} never reported a conversation id (it had no prompt yet), so there is nothing to resume; start it again with am start`);
  return startAgent(tmux, {
    name,
    kind: saved.kind,
    cwd: saved.cwd,
    bin: saved.bin,
    model: saved.model,
    env: saved.env,
    args: saved.args,
    profile: saved.profile,
    contract: saved.contract,
    placement: options.placement ?? "session",
    timeoutMs: options.timeoutMs,
    warn: options.warn,
    note: options.note,
    resume: saved.session,
    contractSent: saved.contractSent,
  });
}

export interface SavedView extends SavedAgent {
  status: SavedStatus;
}

/** Every agent am remembers, with whether it runs, was stopped, exited, or was lost with its tmux server. */
export async function savedAgents(tmux: Tmux): Promise<SavedView[]> {
  const [live, server] = await Promise.all([listRecords(tmux), serverId(tmux)]);
  await markExited(await listSaved(), live, server);
  return (await listSaved()).map((agent) => ({ ...agent, status: savedStatus(agent, live, server) }));
}

/** Resumes every agent lost with its tmux server (machine restart, tmux crash); never ones closed on purpose. */
export async function resumeLost(tmux: Tmux, options: ResumeOptions = {}): Promise<Array<{ name: string; agent?: AgentView; error?: string }>> {
  const results: Array<{ name: string; agent?: AgentView; error?: string }> = [];
  for (const agent of await savedAgents(tmux)) {
    if (agent.status !== "lost") continue;
    try {
      results.push({ name: agent.name, agent: await resumeAgent(tmux, agent.name, options) });
    } catch (error) {
      results.push({ name: agent.name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return results;
}

export async function forgetAgent(name: string): Promise<void> {
  if (!(await removeSaved(name))) throw new AmError("not_found", `am has no record of ${name}`);
}

/**
 * Waits until the agent reaches one of `until` (or exits). A stall is reported
 * once: an `am wait` that returns it marks it seen, and later waits sleep
 * through that same stall until something new happens.
 */
export async function waitAgent(tmux: Tmux, target: string, until: AgentState[] = SETTLED, timeoutMs = 0): Promise<AgentView> {
  const deadline = timeoutMs ? Date.now() + timeoutMs : 0;
  const result = await poll(async () => {
    const record = await findRecord(tmux, target).catch((error) => {
      if (error?.name === "AgentNotFound") return undefined;
      throw error;
    });
    if (!record) return { state: "exited" } as AgentView;
    const current = await view(record);
    if (current.state === "stalled" && current.stallId && current.stallId === record.stallSeen) return undefined;
    if (until.includes(current.state) || current.state === "exited") {
      if (current.state === "stalled" && current.stallId) await writeRecord(tmux, record.paneId, { stallSeen: current.stallId });
      return current;
    }
    return undefined;
  }, deadline);
  if (!result) throw new AmError("timeout", `timed out waiting for ${target} (${timeoutMs}ms)`);
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
  if ((await tmux.display(paneId, "#{@am_lock}")) !== token) throw new AmError("agent_busy", `another am prompt is sending to ${name}`);
  return token;
}

export async function releaseSendLock(tmux: Tmux, paneId: string, token: string): Promise<void> {
  await tmux.run(["if-shell", "-F", "-t", paneId, `#{==:#{@am_lock},${token}}`, `set-option -p -t ${paneId} @am_lock ''`]).catch(() => {});
}

function assertIdle(record: AgentRecord, current: AgentView): void {
  if (current.state === "blocked") throw new AmError("agent_blocked", `${record.name} is waiting for a decision (${current.detail}); handle it first: am approve / am deny`);
  if (current.state === "working") throw new AmError("agent_busy", `${record.name} is still working; run am wait ${record.name} first`);
  // A turn that failed (usage limit, filter, error) has ended: the agent takes input again.
  if (current.state === "stalled" && current.stall !== "no_output") return;
  if (current.state === "stalled") throw new AmError("agent_busy", `${record.name} is still in a turn that has written nothing for a while (${current.detail}); look at it with am open ${record.name}, or am interrupt it`);
  if (current.state !== "idle") throw new AmError("agent_not_ready", `${record.name} is ${current.state} and cannot take a prompt`);
}

export interface Contract {
  path: string;
  content: string;
  hash: string;
}

export async function readContract(record: Pick<AgentRecord, "name" | "contract">): Promise<Contract | undefined> {
  if (!record.contract) return undefined;
  const content = await readFile(record.contract, "utf8").catch(() => {
    throw new AmError("contract_missing", `${record.name}'s worker contract ${record.contract} is gone; put it back (am will not send without it)`);
  });
  return { path: record.contract, content: content.trim(), hash: createHash("sha256").update(content).digest("hex").slice(0, 16) };
}

/**
 * The worker contract rides along with every task: in full the first time
 * (and whenever the file changed), as a one-line reminder after that. Slash
 * commands go as they are: they are commands to the agent's UI, not tasks.
 */
export function withContract(text: string, contract: Contract | undefined, sentHash: string): string {
  if (!contract || text.startsWith("/")) return text;
  if (contract.hash === sentHash) return `${text}\n\n(The worker contract in ${contract.path} still applies.)`;
  return `${text}\n\n---\nWorker contract (${contract.path}). It applies to this task and to every later message in this session:\n\n${contract.content}\n`;
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
    const contract = await readContract(record);
    await submitPrompt(tmux, record, withContract(text, contract, record.contractSent), token);
    if (contract && !text.startsWith("/") && contract.hash !== record.contractSent) {
      await writeRecord(tmux, record.paneId, { contractSent: contract.hash });
      await updateSaved(record.name, record.startedAt, { contractSent: contract.hash }).catch(() => {});
    }
    // Codex reports its conversation id only with the first prompt.
    await syncSession(await findRecord(tmux, found.paneId)).catch(() => {});
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
  if (out.includes(LOCK_LOST)) throw new AmError("lock_lost", "lost the send lock while sending (another am prompt took over); stopped");
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
    throw new AmError("prompt_stalled", `${record.name} did not confirm receiving the prompt; check it with am open ${record.name} instead of resending`);
  }
  await driver.afterAccepted?.(tmux, record, after);
}

export async function readReply(tmux: Tmux, target: string): Promise<string> {
  const record = await findRecord(tmux, target);
  return DRIVERS[record.kind].readReply(record);
}

export async function approveAgent(tmux: Tmux, target: string, scope: "once" | "always" = "once"): Promise<void> {
  const record = await findRecord(tmux, target);
  if ((await view(record)).state !== "blocked") throw new AmError("not_blocked", `${record.name} is not waiting for a decision`);
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
  if ((await view(record)).state !== "blocked") throw new AmError("not_blocked", `${record.name} is not waiting for a decision`);
  await DRIVERS[record.kind].deny(tmux, record);
}

export async function interruptAgent(tmux: Tmux, target: string): Promise<AgentView> {
  const record = await findRecord(tmux, target);
  const current = await view(record);
  if (current.state !== "working" && current.stall !== "no_output") throw new AmError("not_working", `${record.name} is not working`);
  await DRIVERS[record.kind].interrupt(tmux, record);
  const settled = await poll(async () => {
    const current = await getAgent(tmux, record.paneId);
    return current.state !== "working" ? current : undefined;
  }, Date.now() + 8000);
  if (!settled) {
    throw new AmError(
      "interrupt_unconfirmed",
      `${record.name} did not confirm the interrupt. If it was cancelled before the model started replying, the prompt went back to the input box without leaving any record; check it with am open ${record.name}`,
    );
  }
  return settled;
}

export async function sendKeys(tmux: Tmux, target: string, keys: string[]): Promise<void> {
  const record = await findRecord(tmux, target);
  await tmux.sendKeys(record.paneId, ...keys);
}

/** Closes the agent; am still remembers it (am resume <name> reopens its conversation, am forget <name> drops it). */
export async function stopAgent(tmux: Tmux, target: string): Promise<void> {
  const record = await findRecord(tmux, target);
  await updateSaved(record.name, record.startedAt, { stoppedAt: Date.now() }).catch(() => {});
  await tmux.killPane(record.paneId);
}
