import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { Tmux } from "@agent-master/tmux";

import { poll } from "../src/drivers/types.ts";
// @ts-expect-error -- plain JavaScript plugin loaded by dsh, without types.
import { apply } from "../dsh/reporter.js";

const tmux = new Tmux({ socketName: `am-dsh-reporter-test-${process.pid}` });
after(() => tmux.killServer());

type Listener = (...args: any[]) => any;

/** The slice of a Cordis context the reporter uses, driven by the test. */
function fakeContext(services: Record<string, unknown>) {
  const listeners = new Map<string, Listener[]>();
  const disposers: Array<() => void> = [];
  return {
    ctx: {
      get: (name: string) => services[name],
      on: (name: string, listener: Listener) => void listeners.set(name, [...(listeners.get(name) ?? []), listener]),
      effect: (setup: () => () => void) => void disposers.push(setup()),
    },
    emit: (name: string, ...args: unknown[]) => listeners.get(name)?.map((listener) => listener(...args)),
    dispose: () => disposers.forEach((dispose) => dispose()),
  };
}

const agent = (id: string) => ({ session: { id } });

let pane: string;
before(async () => {
  pane = await tmux.newSession("dsh", { command: "sh" });
  // The reporter talks to tmux like a process running in that pane.
  process.env.TMUX = `${await tmux.socketPath()},0,0`;
  process.env.TMUX_PANE = pane;
});

async function until(expected: Record<string, string>): Promise<void> {
  const keys = Object.keys(expected);
  const read = async () => Object.fromEntries(await Promise.all(keys.map(async (k) => [k, await tmux.display(pane, `#{${k}}`)])));
  const seen = await poll(async () => {
    const current = await read();
    return keys.every((k) => current[k] === expected[k]) ? current : undefined;
  }, Date.now() + 3000, 20);
  assert.deepEqual(seen ?? (await read()), expected);
}

test("the reporter mirrors the dsh TUI's lifecycle onto its tmux pane", async () => {
  const replyDir = await mkdtemp(join(tmpdir(), "am-dsh-replies-"));
  const first = agent("session-a");
  const services: Record<string, any> = {
    tuiConsole: { isOpen: false },
    tuiChat: { agent: first, cwd: "/w", slash() {} },
    tuiCommands: { list: () => [{ name: "session" }, { name: "exit", aliases: ["quit"] }] },
    skills: { get: async (name: string) => (name === "am" ? { invocation: { userInvocable: true } } : name === "hidden" ? { invocation: { userInvocable: false } } : undefined) },
  };
  const { ctx, emit, dispose } = fakeContext(services);
  apply(ctx, { replyDir });
  try {
    // Ready only once the TUI owns the terminal.
    services.tuiConsole.isOpen = true;
    const replyFile = join(replyDir, "session-a.txt");
    await until({ "@am_event": "SessionStart", "@am_state": "idle", "@am_session": "session-a", "@am_transcript": replyFile });

    emit("tui/submit", "do it;");
    await until({ "@am_seq": "1", "@am_state": "working", "@am_event": "UserPromptSubmit" });
    emit("session/event", first.session, { type: "turn/start", data: { turn: 1 } });
    emit("session/event", first.session, { type: "assistant/message", data: { message: { content: [{ type: "text", text: "looking" }] } } });

    // Approvals block, for delegated children too, and clear by id.
    emit("session/event", { id: "child" }, { type: "approval/asked", data: { id: "ap-1", toolName: "bash", reason: "write\noutside;" } });
    await until({ "@am_state": "blocked", "@am_pending": "ap-1", "@am_detail": "bash: write outside;" });
    emit("session/event", { id: "child" }, { type: "approval/decided", data: { id: "ap-1", outcome: "allowed-once" } });
    await until({ "@am_state": "working", "@am_pending": "" });

    // A question stays open until the TUI's answer resolves.
    let answer!: (value: unknown) => void;
    const answered = emit("user-questions/request", {}, () => new Promise((resolve) => (answer = resolve)))![0];
    await until({ "@am_state": "blocked", "@am_pending": "question-1", "@am_detail": "question" });
    answer({ answers: [] });
    await answered;
    await until({ "@am_state": "working", "@am_pending": "" });

    // Another Agent's turn does not end this one.
    emit("session/event", { id: "other" }, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
    emit("session/event", first.session, { type: "assistant/message", data: { message: { content: [{ type: "thinking", text: "x" }, { type: "text", text: "pong" }] } } });
    emit("session/event", first.session, { type: "turn/end", data: { turn: 1, reason: { kind: "completed" } } });
    await until({ "@am_state": "idle", "@am_event": "Stop", "@am_detail": "" });
    assert.equal(await readFile(replyFile, "utf8"), "pong");

    // An idle "/" line is a TUI command, or nothing: accepted, but no turn starts.
    for (const [index, line] of ["/session", "/quit now", "/nosuch x", "/hidden"].entries()) {
      emit("tui/submit", line);
      await until({ "@am_seq": String(2 + index), "@am_state": "idle" });
    }
    // Unless it names a user-invocable skill: the TUI sends it, and dsh injects the skill.
    emit("tui/submit", "/am ask codex");
    await until({ "@am_seq": "6", "@am_state": "working" });
    emit("session/event", first.session, { type: "turn/end", data: { turn: 2, reason: { kind: "completed" } } });
    await until({ "@am_state": "idle" });
    // A TUI without that routing runs every idle "/" line as a command.
    const { slash } = services.tuiChat;
    delete services.tuiChat.slash;
    emit("tui/submit", "/am ask codex");
    await until({ "@am_seq": "7", "@am_state": "idle" });
    services.tuiChat.slash = slash;

    emit("tui/submit", "long task");
    emit("session/event", first.session, { type: "turn/start", data: { turn: 3 } });
    assert.equal(await readFile(replyFile, "utf8"), "", "a new turn has no reply yet");
    emit("session/event", first.session, { type: "turn/end", data: { turn: 3, reason: { kind: "aborted", reason: { kind: "user" } } } });
    await until({ "@am_state": "idle", "@am_detail": "interrupted" });

    // /new: the TUI moved to another Agent, and its replies go to another file.
    const second = agent("session-b");
    services.tuiChat.agent = second;
    emit("tui/submit", "again");
    await until({ "@am_session": "session-b", "@am_transcript": join(replyDir, "session-b.txt"), "@am_seq": "9" });
    emit("agent/status", { agent: first, status: "idle" });
    emit("agent/status", { agent: second, status: "running" });
    await until({ "@am_state": "working", "@am_event": "Running" });
  } finally {
    dispose();
  }
});
