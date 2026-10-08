import assert from "node:assert/strict";
import { test } from "node:test";

import { matchHostProfile, parseSshArgs, type TargetContext } from "../src/context.ts";
import { extractCommand } from "../src/extract.ts";
import { parseOpencodeEvents } from "../src/generate.ts";
import { buildPrompt } from "../src/prompt.ts";

test("parseSshArgs handles the common ways people type ssh", () => {
  assert.deepEqual(parseSshArgs("ssh dev@box"), { host: "box", user: "dev", port: undefined });
  assert.deepEqual(parseSshArgs("ssh -p 2222 -i ~/.ssh/k dev@127.0.0.1"), { host: "127.0.0.1", user: "dev", port: 2222 });
  assert.deepEqual(parseSshArgs("ssh -tp2222 -l ops box ls"), { host: "box", user: "ops", port: 2222 });
  assert.deepEqual(parseSshArgs("/usr/bin/ssh -F /tmp/cfg remote-sim"), { host: "remote-sim", user: undefined, port: undefined });
  assert.deepEqual(parseSshArgs("ssh -o Port=2200 -o User=me -J jump box"), { host: "box", user: "me", port: 2200 });
  assert.deepEqual(parseSshArgs("ssh ssh://root@h.example:2022"), { host: "h.example", user: "root", port: 2022 });
  assert.equal(parseSshArgs("-zsh"), undefined);
  assert.equal(parseSshArgs("sshd: dev@pts/0"), undefined);
  assert.equal(parseSshArgs("ssh -v"), undefined);
});

test("matchHostProfile prefers exact keys over globs", () => {
  const hosts = { "*.corp.example": { os: "CentOS 7" }, "bastion.corp.example": { os: "JumpServer" } };
  assert.equal(matchHostProfile("bastion.corp.example", hosts)?.os, "JumpServer");
  assert.equal(matchHostProfile("db1.CORP.example", hosts)?.os, "CentOS 7");
  assert.equal(matchHostProfile("example.org", hosts), undefined);
});

test("extractCommand keeps one clean line", () => {
  assert.deepEqual(extractCommand("```bash\n$ ls -la\n```\n"), { ok: true, command: "ls -la" });
  assert.deepEqual(extractCommand("\x1b[1mdf -h\x1b[0m"), { ok: true, command: "df -h" });
  assert.deepEqual(extractCommand("echo a\x07b\x1b]0;title\x07"), { ok: true, command: "echo ab" });
  assert.equal(extractCommand("cd /tmp\nrm -rf x").ok, false);
  assert.deepEqual(extractCommand("  \n\n"), { ok: false, reason: "empty", text: "  \n\n" });
});

test("parseOpencodeEvents joins text parts and surfaces errors", () => {
  const ok = parseOpencodeEvents(
    [
      '{"type":"step_start","sessionID":"ses_1"}',
      '{"type":"text","sessionID":"ses_1","part":{"text":"ls "}}',
      "not json",
      '{"type":"text","sessionID":"ses_1","part":{"text":"-la"}}',
    ].join("\n"),
  );
  assert.equal(ok.text, "ls -la");
  assert.equal(ok.sessionId, "ses_1");
  assert.equal(ok.eventCount, 3);

  const failed = parseOpencodeEvents('{"type":"error","error":{"name":"APIError","data":{"message":"invalid key"}}}');
  assert.equal(failed.error, "invalid key");
});

test("buildPrompt describes the remote target", () => {
  const target: TargetContext = {
    paneId: "%1",
    location: "ssh",
    label: "dev@remote-sim",
    host: "remote-sim",
    os: "Ubuntu 24.04",
    shell: "bash",
    foreground: "ssh remote-sim",
    foregroundIsShell: true,
  };
  const prompt = buildPrompt(target, "  看磁盘  ");
  assert.match(prompt, /already logged in to remote host "remote-sim"; the command runs there directly/);
  assert.match(prompt, /os: Ubuntu 24.04\nshell: bash\ncwd: unknown/);
  assert.match(prompt, /<request>\n看磁盘\n<\/request>/);
});
