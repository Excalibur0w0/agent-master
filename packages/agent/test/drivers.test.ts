import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { claude, claudeHookSettings } from "../src/drivers/claude.ts";
import { codex, codexDirectoryTrusted, codexHookArgs, codexHookHash, codexHooksTrusted, trustOverrides } from "../src/drivers/codex.ts";
import { shellCommand } from "../src/drivers/types.ts";
import { opencode } from "../src/drivers/opencode.ts";
import type { AgentRecord } from "../src/registry.ts";

function record(overrides: Partial<AgentRecord>): AgentRecord {
  return {
    paneId: "%1",
    tmuxSession: "am-a",
    name: "a",
    kind: "claude",
    cwd: "/tmp",
    startedAt: 0,
    paneDead: false,
    state: "idle",
    detail: "",
    event: "",
    updatedAt: 0,
    session: "",
    transcript: "",
    turn: "",
    offset: 0,
    seq: 0,
    pending: "",
    url: "",
    auth: "",
    trustOverride: "",
    ...overrides,
  };
}

test("claude settings register the hook with matchers where needed", () => {
  const { hooks } = claudeHookSettings("/x/claude.sh") as { hooks: Record<string, any[]> };
  assert.equal(hooks.PreToolUse[0].matcher, "AskUserQuestion|ExitPlanMode");
  assert.equal(hooks.Notification[0].matcher, "idle_prompt");
  assert.equal(hooks.Stop[0].matcher, undefined);
  assert.equal(hooks.Stop[0].hooks[0].command, "/x/claude.sh");
});

test("claude status turns a stuck working state into idle once the transcript shows an interrupt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "am-driver-"));
  const transcript = join(dir, "t.jsonl");
  await writeFile(transcript, `${JSON.stringify({ type: "user", promptId: "p1", message: { content: [{ type: "text", text: "[Request interrupted by user]" }] } })}\n`);
  assert.deepEqual(await claude.status(record({ state: "working", transcript, turn: "p1" })), { state: "idle", detail: "interrupted" });
  assert.deepEqual(await claude.status(record({ state: "blocked", detail: "Bash", transcript, turn: "p1" })), { state: "idle", detail: "interrupted" });
  assert.deepEqual(await claude.status(record({ state: "working", transcript, turn: "p2" })), { state: "working", detail: "" });
  assert.deepEqual(await claude.status(record({ state: "working", paneDead: true })), { state: "exited", detail: "" });
});

test("codex hooks are injected with -c and trust is read from config.toml", async () => {
  const args = codexHookArgs("/x/codex.sh");
  assert.equal(args[0], "-c");
  assert.equal(args[1], 'hooks.SessionStart=[{hooks=[{type="command",command="/x/codex.sh"}]}]');
  assert.ok(args.includes('hooks.Interrupt=[{hooks=[{type="command",command="/x/codex.sh"}]}]'));

});

test("codex hook trust is verified with Codex's own hash, per section", async () => {
  // Computed independently (sha256 of the sorted, compact hook JSON, as in codex-rs
  // hook_hash); the same computation reproduced all seven hashes Codex 0.160 wrote for am.
  const cmd = "/Users/me/agent-master/packages/agent/hooks/codex.sh";
  assert.equal(codexHookHash("Stop", cmd), "sha256:928d8c2051f297cfbbfaad3ae44a24ffa54f33246661ca228849ca9a53b7c09a");

  const events = ["SessionStart", "UserPromptSubmit", "PermissionRequest", "PostToolUse", "Stop", "Interrupt", "SessionEnd"];
  const snake = (e: string) => e.replace(/[A-Z]/g, (c, i) => `${i ? "_" : ""}${c.toLowerCase()}`);
  const section = (e: string, body: string) => `[hooks.state."/<session-flags>/config.toml:${snake(e)}:0:0"]\n${body}\n`;
  const trusted = (command: string) => events.map((e) => section(e, `trusted_hash = "${codexHookHash(e, command)}"`)).join("\n");

  assert.equal(await codexHooksTrusted(trusted(cmd), cmd), true);
  assert.equal(await codexHooksTrusted(trusted("/old/place/codex.sh"), cmd), false, "trusted for another command (repo moved)");
  assert.equal(await codexHooksTrusted(trusted(cmd).replace('trusted_hash = "sha256:', 'enabled = false\ntrusted_hash = "sha256:'), cmd), false, "disabled");
  // A section without its own hash must not borrow the next section's.
  const missing = trusted(cmd).replace(/trusted_hash = "[^"]*"\n/, "");
  assert.equal(await codexHooksTrusted(missing, cmd), false);
  assert.equal(await codexHooksTrusted("", cmd), false);
  // Real TOML, not line patterns: quoted keys and indented tables count, strings do not.
  assert.equal(await codexHooksTrusted(trusted(cmd).replace('trusted_hash = "sha256:', '"enabled" = false\ntrusted_hash = "sha256:'), cmd), false);
  assert.equal(await codexHooksTrusted(trusted(cmd).replace(/^\[/gm, "  ["), cmd), true);
  const fake = `notes = """\n${trusted(cmd)}"""\n`;
  assert.equal(await codexHooksTrusted(fake, cmd), false, "a section quoted inside a string is not trust");
  assert.equal(await codexHooksTrusted("[[[broken", cmd), false);
});

test("agents start without update dialogs that would take am's keystrokes", async () => {
  const c = await codex.launch({ cwd: "/tmp", args: [] });
  assert.ok(c.command.join(" ").includes("-c check_for_update_on_startup=false"));
  const o = await opencode.launch({ cwd: "/tmp", args: [] });
  assert.equal(o.env?.OPENCODE_DISABLE_AUTOUPDATE, "1");
});

test("hook commands are shell-quoted only when the path needs it", () => {
  assert.equal(shellCommand("/Users/me/agent-master/packages/agent/hooks/codex.sh"), "/Users/me/agent-master/packages/agent/hooks/codex.sh");
  assert.equal(shellCommand("/Users/me/my repo/hooks/claude.sh"), "'/Users/me/my repo/hooks/claude.sh'");
  assert.equal(shellCommand("/x/it's;$(rm)/h.sh"), "'/x/it'\\''s;$(rm)/h.sh'");
  assert.equal(codexHookArgs("/a b/codex.sh")[1], 'hooks.SessionStart=[{hooks=[{type="command",command="\'/a b/codex.sh\'"}]}]');
});

test("codex directory trust covers subdirectories of a trusted project", () => {
  const config = '[projects."/work/repo"]\ntrust_level = "trusted"\n\n[projects."/work/other"]\ntrust_level = "untrusted"\n';
  assert.equal(codexDirectoryTrusted(config, "/work/repo"), true);
  assert.equal(codexDirectoryTrusted(config, "/work/repo/packages/a"), true);
  assert.equal(codexDirectoryTrusted(config, "/work/other"), false);
  assert.equal(codexDirectoryTrusted(config, "/elsewhere"), false);
  // A -c override counts outside git, but Codex ignores it inside a repo.
  assert.equal(codexDirectoryTrusted("", "/tmp/x", undefined, { "/tmp/x": "trusted" }), true);
  assert.equal(codexDirectoryTrusted("", "/repo/sub", "/repo", { "/repo": "trusted" }), false);
  assert.deepEqual(trustOverrides(["-m", "m", "-c", 'projects."/tmp/x".trust_level="trusted"', "--config=projects.\"/y\".trust_level=\"trusted\"", "-c", "model=x"]), {
    "/tmp/x": "trusted",
    "/y": "trusted",
  });
  // The last override for a directory wins, and "untrusted" revokes.
  const revoked = trustOverrides(["-c", 'projects."/tmp/x".trust_level="trusted"', "-c", 'projects."/tmp/x".trust_level="untrusted"']);
  assert.deepEqual(revoked, { "/tmp/x": "untrusted" });
  assert.equal(codexDirectoryTrusted('[projects."/tmp"]\ntrust_level = "trusted"\n', "/tmp/x", undefined, revoked), false);
  // In a git repo only the repo root counts, not a trusted parent.
  assert.equal(codexDirectoryTrusted(config, "/work/repo/sub/git-project/src", "/work/repo/sub/git-project"), false);
  assert.equal(codexDirectoryTrusted(config, "/work/repo/src", "/work/repo"), true);
});

/** A fake opencode server: routes return canned JSON and record POSTs. */
async function fakeOpencode(routes: Record<string, unknown>): Promise<{ url: string; posts: string[]; server: Server }> {
  const posts: string[] = [];
  const server = createServer((req, res) => {
    if (req.headers.authorization !== `Basic ${Buffer.from("opencode:pw").toString("base64")}`) {
      res.writeHead(401).end();
      return;
    }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.method === "POST") posts.push(`${req.url} ${body}`);
      const key = `${req.method} ${req.url}`;
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(routes[key] ?? true));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return { url: `http://127.0.0.1:${address.port}`, posts, server };
}

test("opencode status, reply, approve and interrupt go through its HTTP API", async () => {
  const { url, posts, server } = await fakeOpencode({
    "GET /permission": [{ id: "per_1", sessionID: "ses_b", permission: "bash", patterns: ["touch x"] }],
    "GET /question": [],
    "GET /session/status": { ses_b: { type: "busy" } },
    "GET /session": [
      { id: "ses_a", time: { created: 1, updated: 5 } },
      { id: "ses_b", time: { created: 2, updated: 9 } },
      { id: "ses_child", parentID: "ses_b", time: { created: 3, updated: 99 } },
    ],
    "GET /session/ses_b/message": [
      { info: { id: "m1", role: "user" }, parts: [{ type: "text", text: "q" }] },
      { info: { id: "m2", role: "assistant" }, parts: [{ type: "reasoning", text: "hmm" }, { type: "text", text: "pong" }] },
    ],
  });
  try {
    const rec = record({ kind: "opencode", url, auth: "pw" });
    assert.deepEqual(await opencode.status(rec), { state: "blocked", detail: "bash touch x" });
    assert.equal(await opencode.readReply(rec), "pong", "unbound: the session this server is busy with, last assistant text parts");
    await opencode.approve(undefined as never, rec, "once");
    await opencode.interrupt(undefined as never, rec);
    assert.deepEqual(posts, ['/permission/per_1/reply {"reply":"once"}', "/session/ses_b/abort "]);
    assert.equal((await opencode.status(record({ kind: "opencode", url, auth: "wrong" }))).state, "unknown");
  } finally {
    server.close();
  }
});

test("opencode reads only the pane's own session, never another instance's latest", async () => {
  const now = Date.now();
  const quiet = await fakeOpencode({
    "GET /session/status": {},
    "GET /session": [
      { id: "ses_mine", time: { created: 1, updated: now - 60_000 } },
      { id: "ses_other_instance", time: { created: 2, updated: now - 30_000 } },
    ],
    "GET /session/ses_mine/message": [{ info: { id: "m", role: "assistant" }, parts: [{ type: "text", text: "mine" }] }],
    "GET /session/ses_other_instance/message": [{ info: { id: "o", role: "assistant" }, parts: [{ type: "text", text: "other" }] }],
  });
  try {
    const rec = record({ kind: "opencode", url: quiet.url, auth: "pw", state: "idle" });
    assert.equal(await opencode.readReply({ ...rec, session: "ses_mine" }), "mine");
    await assert.rejects(opencode.readReply(rec), /还不确定/, "unbound and idle: refuse instead of reading the latest session");
    // The busy session captured while confirming a prompt becomes the binding.
    const written: Record<string, string>[] = [];
    const tmuxStub = { setPaneOptions: async (_pane: string, options: Record<string, string>) => void written.push(options) };
    await opencode.afterAccepted!(tmuxStub as never, rec, "ses_mine|0");
    await opencode.afterAccepted!(tmuxStub as never, rec, "|0");
    assert.deepEqual(written, [{ "@am_session": "ses_mine" }], "no busy session seen: keep the old binding");
  } finally {
    quiet.server.close();
  }
});
