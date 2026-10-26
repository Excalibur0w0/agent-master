// DeepSeek Harness (dsh) plugin for agent-master. `am start --kind dsh` loads it
// into the dsh TUI with --patch; it records the agent's lifecycle on its tmux
// pane as @am_* options, the way hooks/claude.sh does for Claude Code, and keeps
// each turn's final reply in a file because dsh stores sessions compressed.
//
// Plain JavaScript: dsh loads plugins with its own Node, without a TypeScript loader.
import { execFile } from "node:child_process";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const name = "am-reporter";

/** tmux drops a trailing ";" from an argument unless it is escaped. */
const tmuxArg = (value) => (value.endsWith(";") ? `${value.slice(0, -1)}\\;` : value);

const oneLine = (value) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 200);

/** The text parts of a model message. */
function messageText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

/** What `am status` shows after a turn: empty when it simply completed. */
function endDetail(reason) {
  switch (reason?.kind) {
    case "completed":
    case undefined:
      return "";
    case "aborted":
      return "interrupted";
    case "error":
      return oneLine(`error: ${reason.error?.message ?? ""}`);
    default:
      return reason.kind;
  }
}

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {{ replyDir?: string }} config - where turn replies are written.
 */
export function apply(ctx, config = {}) {
  const pane = process.env.TMUX_PANE;
  if (!pane || !config.replyDir) return;

  /** The Agent the TUI is talking to; /new replaces it. */
  const current = () => ctx.get("tuiChat")?.agent;
  let bound;
  let running = false;
  let detail = "";
  let reply = "";
  let replyPath = "";
  /** Approvals and questions in the order the TUI shows them, one panel at a time. */
  const waits = [];
  let questions = 0;

  // tmux writes run one at a time so the pane never sees them out of order.
  let queue = Promise.resolve();
  const tmux = (...commands) => {
    const argv = commands.flatMap((command, index) => (index ? [";", ...command] : command));
    queue = queue.then(() => new Promise((resolve) => execFile("tmux", argv, () => resolve())));
  };
  const set = (option, value) => ["set-option", "-p", "-t", pane, option, tmuxArg(String(value))];

  /** Writes the whole state at once; `event` names what moved it, like a hook event. */
  const publish = (event) => {
    const wait = waits[0];
    tmux(
      set("@am_event", event),
      set("@am_state", wait ? "blocked" : running ? "working" : "idle"),
      set("@am_detail", wait ? wait.detail : running ? "" : detail),
      set("@am_pending", wait ? wait.id : ""),
      set("@am_ts", Math.floor(Date.now() / 1000)),
    );
  };

  const writeReply = (text) => {
    if (!replyPath) return;
    try {
      mkdirSync(config.replyDir, { recursive: true });
      writeFileSync(`${replyPath}.tmp`, text);
      renameSync(`${replyPath}.tmp`, replyPath);
    } catch {
      // A missing reply only affects `am read`; never disturb the agent.
    }
  };

  /** Follows the TUI to its current Agent and records where its replies go. */
  const bind = () => {
    const agent = current();
    if (agent === undefined || agent === bound) return agent;
    bound = agent;
    replyPath = join(config.replyDir, `${agent.session.id}.txt`);
    reply = "";
    tmux(set("@am_session", agent.session.id), set("@am_transcript", replyPath));
    return agent;
  };

  const settle = (id, event) => {
    const index = waits.findIndex((wait) => wait.id === id);
    if (index === -1) return;
    waits.splice(index, 1);
    publish(event);
  };

  // Ready once the TUI has its Agent and owns the terminal: input typed earlier is lost.
  ctx.effect(() => {
    const timer = setInterval(() => {
      if (ctx.get("tuiConsole")?.isOpen !== true || bind() === undefined) return;
      clearInterval(timer);
      publish("SessionStart");
    }, 100);
    return () => clearInterval(timer);
  }, "am reporter readiness");

  // The TUI took a line. @am_seq only ever moves here, so `am prompt` can tell its
  // prompt was accepted. An idle "/" line is a TUI command, not a turn.
  ctx.on("tui/submit", (line) => {
    bind();
    detail = "";
    if (running || !String(line).trimStart().startsWith("/")) running = true;
    tmux(["set-option", "-p", "-F", "-t", pane, "@am_seq", "#{e|+:#{@am_seq},1}"]);
    publish("UserPromptSubmit");
  });

  ctx.on("agent/status", ({ agent, status }) => {
    if (agent !== bind()) return;
    running = status === "running";
    publish(running ? "Running" : "Idle");
  });

  ctx.on("session/event", (session, event) => {
    // The TUI answers approvals for every Agent, delegated children included.
    if (event.type === "approval/asked") {
      waits.push({ id: event.data.id, detail: oneLine(`${event.data.toolName}: ${event.data.reason ?? ""}`) });
      publish("PermissionRequest");
      return;
    }
    if (event.type === "approval/decided") {
      settle(event.data.id, "PermissionDecided");
      return;
    }
    const agent = bind();
    if (agent === undefined || session !== agent.session) return;
    if (event.type === "turn/start") {
      running = true;
      reply = "";
      writeReply("");
    } else if (event.type === "assistant/message") {
      const text = messageText(event.data.message);
      if (text.trim()) reply = text;
    } else if (event.type === "turn/end") {
      running = false;
      detail = endDetail(event.data.reason);
      // The reply is on disk before the state says idle, so `am read` after `am wait` sees it.
      writeReply(reply);
      publish("Stop");
    }
  });

  // Questions leave no session event; wrap the TUI's answer to see them open and close.
  ctx.on(
    "user-questions/request",
    async (_request, next) => {
      const wait = { id: `question-${++questions}`, detail: "question" };
      waits.push(wait);
      publish("Question");
      try {
        return await next();
      } finally {
        settle(wait.id, "QuestionAnswered");
      }
    },
    { prepend: true },
  );
}
