// End-to-end: a real tmux pane ssh'd into the Docker remote-sim, a real opencode
// call, and verification through side effects inside the container — never by
// reading the screen. Needs Docker and a working opencode model.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import { Tmux, foregroundProcess } from "@agent-master/tmux";

const execFileAsync = promisify(execFile);
const repoRoot = resolve(import.meta.dirname, "../../../..");
const simDir = join(repoRoot, "infra/remote-sim");
const sshConfig = join(simDir, ".state/ssh_config");
const container = "am-remote-sim";
const cli = resolve(import.meta.dirname, "../../src/cli.ts");
const nodeArgs = ["--disable-warning=ExperimentalWarning", cli];

const tmux = new Tmux({ socketName: `am-e2e-${process.pid}` });
const runId = `${Date.now()}`;
let env: NodeJS.ProcessEnv;
let workDir: string;

async function waitFor<T>(what: string, probe: () => Promise<T | undefined>, timeoutMs = 20_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

async function remoteRead(path: string): Promise<string | undefined> {
  const { stdout } = await execFileAsync("docker", ["exec", container, "cat", path]);
  return stdout;
}

/** Opens a local shell pane and ssh'es into remote-sim from it, like a user would. */
async function sshPane(session: string): Promise<string> {
  const pane = await tmux.newSession(session, { width: 200, height: 50, command: "sh" });
  await tmux.sendLiteral(pane, `ssh -F ${sshConfig} remote-sim`);
  await tmux.sendKeys(pane, "Enter");
  const { tty } = await tmux.paneInfo(pane);
  await waitFor("ssh in the foreground", async () => ((await foregroundProcess(tty))?.args.startsWith("ssh ") ? true : undefined));
  // The remote login shell exists once dev has a bash on some pts.
  await waitFor("remote login shell", async () => {
    const { stdout } = await execFileAsync("docker", ["exec", container, "pgrep", "-u", "dev", "-x", "bash"]);
    return stdout.trim() ? true : undefined;
  });
  await sleep(500);
  return pane;
}

before(async () => {
  execFileSync("sh", [join(simDir, "scripts/up.sh")], { stdio: "inherit" });
  execFileSync("docker", ["exec", container, "sh", "-c", "pkill -u dev -x bash || true"]);

  workDir = await mkdtemp(join(tmpdir(), "am-ask-e2e-"));
  const configFile = join(workDir, "shell-ask.json");
  await writeFile(configFile, JSON.stringify({ hosts: { "remote-sim": { os: "Ubuntu 24.04 (GNU coreutils)", shell: "bash" } } }));

  await tmux.newSession("bootstrap", { command: "sh" });
  env = { ...process.env, AM_SHELL_ASK_CONFIG: configFile, TMUX: `${await tmux.socketPath()},0,0` };
});

after(async () => {
  await tmux.killServer();
  execFileSync("docker", ["exec", container, "sh", "-c", `rm -f /tmp/shell-ask-e2e-${runId}-*`]);
});

test("run --insert types a remote-ready command but does not execute it", { timeout: 120_000 }, async () => {
  const pane = await sshPane("run");
  const file = `/tmp/shell-ask-e2e-${runId}-run.txt`;
  const request = `在 /tmp 下创建文件 ${file.slice(5)}，内容是 hello-${runId}`;

  const { stdout } = await execFileAsync(process.execPath, [...nodeArgs, "run", "--target", pane, "--request", request, "--insert", "--json"], { env });
  const result = JSON.parse(stdout);
  assert.equal(result.target.location, "ssh");
  assert.equal(result.target.host, "remote-sim");
  assert.match(result.target.os, /Ubuntu/);
  assert.ok(result.command && !result.command.includes("\n"));
  assert.doesNotMatch(result.command, /\bssh\b/, "the pane is already on the remote; no second hop");

  await sleep(1500);
  assert.equal(await remoteRead(file).catch(() => undefined), undefined, "the command must wait for the user's Enter");

  await tmux.sendKeys(pane, "Enter");
  const content = await waitFor("file created on the remote", () => remoteRead(file));
  assert.match(content, new RegExp(`hello-${runId}`));
});

test("popup: type a request, Enter inserts into the ssh pane", { timeout: 120_000 }, async () => {
  const pane = await sshPane("popup");
  const stateFile = join(workDir, "popup-state.ndjson");
  const quote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const popupCommand = [
    `AM_ASK_STATE_FILE=${quote(stateFile)}`,
    `AM_SHELL_ASK_CONFIG=${quote(env.AM_SHELL_ASK_CONFIG!)}`,
    quote(process.execPath),
    ...nodeArgs.map(quote),
    "popup",
    "--target",
    pane,
  ].join(" ");
  const popup = await tmux.newWindow("popup", `env ${popupCommand}`);

  const states = async () => (await readFile(stateFile, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  const waitState = (state: string, timeoutMs?: number) =>
    waitFor(`popup state ${state}`, async () => (await states()).find((s) => s.state === state), timeoutMs);

  await waitState("prompt");
  const file = `/tmp/shell-ask-e2e-${runId}-popup.txt`;
  await tmux.sendLiteral(popup, `把当前日期写入 ${file}`);
  await tmux.sendKeys(popup, "Enter");

  const settled = await waitFor(
    "popup to finish generating",
    async () => (await states()).find((s) => s.state === "ready" || s.state === "error"),
    90_000,
  );
  assert.equal(settled.state, "ready", JSON.stringify(settled));
  await tmux.sendKeys(popup, "Enter");
  const inserted = await waitState("inserted");
  assert.equal(inserted.paneId, pane);

  await sleep(1000);
  assert.equal(await remoteRead(file).catch(() => undefined), undefined, "inserting must not execute");
  await tmux.sendKeys(pane, "Enter");
  const content = await waitFor("file created by the popup's command", () => remoteRead(file));
  assert.match(content, /20\d\d/);
});
