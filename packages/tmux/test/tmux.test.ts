import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import { Tmux, foregroundProcess, parsePsOutput } from "../src/index.ts";

const tmux = new Tmux({ socketName: `am-tmux-test-${process.pid}` });
after(() => tmux.killServer());

async function waitFor<T>(probe: () => Promise<T | undefined>, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error("timed out");
    await sleep(100);
  }
}

test("parsePsOutput keeps full args and negative tpgid", () => {
  const rows = parsePsOutput(" 101  101  202 -zsh\n 202  202  202 ssh -p 2222 dev@localhost\n 303 303 -1 launchd\n");
  assert.deepEqual(rows[1], { pid: 202, pgid: 202, tpgid: 202, args: "ssh -p 2222 dev@localhost" });
  assert.equal(rows[2].tpgid, -1);
});

test("sendLiteral types text without pressing Enter", async () => {
  const dir = await mkdtemp(join(tmpdir(), "am-tmux-"));
  const pane = await tmux.newSession("literal", { cwd: dir, command: "sh" });
  await tmux.sendLiteral(pane, "echo 'a b;c' > out.txt");
  await sleep(300);
  await assert.rejects(readFile(join(dir, "out.txt")), "nothing may run before Enter");
  await tmux.sendKeys(pane, "Enter");
  const content = await waitFor(() => readFile(join(dir, "out.txt"), "utf8"));
  assert.equal(content, "a b;c\n");
});

test("arguments ending in ';' reach tmux literally instead of splitting the command", async () => {
  const dir = await mkdtemp(join(tmpdir(), "am-tmux-"));
  const pane = await tmux.newSession("semi", { cwd: dir, command: ["sh", "-c", "cat > out.txt"] });
  await tmux.sendLiteral(pane, "echo hi;");
  await tmux.sendLiteral(pane, ";");
  await tmux.sendKeys(pane, "Enter", "C-d");
  assert.equal(await waitFor(() => readFile(join(dir, "out.txt"), "utf8")), "echo hi;;\n");
});

test("pane options round-trip through listPanes", async () => {
  const pane = await tmux.newSession("opts", { command: "sh" });
  await tmux.setPaneOptions(pane, { "@am_name": "reviewer", "@am_note": "a b;c", "@am_tail": "ends;" });
  const rows = await tmux.listPanes("#{pane_id}\t#{@am_name}\t#{@am_note}\t#{@am_tail}");
  assert.ok(rows.includes(`${pane}\treviewer\ta b;c\tends;`), rows.join("\n"));
});

test("splitWindow runs argv directly with env and cwd", async () => {
  const dir = await mkdtemp(join(tmpdir(), "am-tmux-"));
  const base = await tmux.newSession("split", { command: "sh" });
  const pane = await tmux.splitWindow(base, {
    cwd: dir,
    env: { AM_TEST: "x y'z" },
    command: ["sh", "-c", 'printf "%s|%s" "$AM_TEST" "$PWD" > out.txt; sleep 5'],
  });
  assert.match(pane, /^%\d+$/);
  const content = await waitFor(() => readFile(join(dir, "out.txt"), "utf8"));
  assert.equal(content.split("|")[0], "x y'z");
});

test("paste delivers multi-line text without pressing Enter afterwards", async () => {
  const dir = await mkdtemp(join(tmpdir(), "am-tmux-"));
  const pane = await tmux.newSession("paste", { cwd: dir, command: ["sh", "-c", "cat > out.txt"] });
  await tmux.paste(pane, "line 1\nline 2 'quoted' $HOME\n");
  await tmux.sendKeys(pane, "C-d");
  const content = await waitFor(async () => {
    const text = await readFile(join(dir, "out.txt"), "utf8");
    return text.includes("line 2") ? text : undefined;
  });
  assert.equal(content, "line 1\nline 2 'quoted' $HOME\n");
});

test("foregroundProcess follows the program the user is typing into", async () => {
  const pane = await tmux.newSession("fg", { command: "sh" });
  const { tty } = await tmux.paneInfo(pane);
  const shell = await waitFor(() => foregroundProcess(tty));
  assert.match(shell.args, /\bsh\b/);

  await tmux.sendLiteral(pane, "sleep 30");
  await tmux.sendKeys(pane, "Enter");
  const fg = await waitFor(async () => {
    const p = await foregroundProcess(tty);
    return p?.args.startsWith("sleep") ? p : undefined;
  });
  assert.equal(fg.args, "sleep 30");
});
