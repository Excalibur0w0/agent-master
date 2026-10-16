// Own both the v2 API server and its TUI for the lifetime of one tmux pane.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { OpencodeApi } from "./opencode-api.ts";
import { poll } from "./drivers/types.ts";

const [url, model, ...args] = process.argv.slice(2);
const password = process.env.OPENCODE_SERVER_PASSWORD;
if (!url || !password || !process.env.TMUX_PANE) throw new Error("missing am OpenCode launch context");

const server = spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", new URL(url).port], {
  stdio: ["ignore", "ignore", "inherit"],
});
let tui: ChildProcess | undefined;
let stopping = false;
function stop(code: number) {
  if (stopping) return;
  stopping = true;
  tui?.kill("SIGTERM");
  server.kill("SIGTERM");
  // A broken child must not leave an orphaned per-pane service behind.
  setTimeout(() => {
    tui?.kill("SIGKILL");
    server.kill("SIGKILL");
    process.exit(code);
  }, 1000);
}
for (const signal of ["SIGHUP", "SIGINT", "SIGTERM"] as const) process.on(signal, () => stop(0));
server.on("error", (error) => { console.error(error.message); stop(1); });
server.on("exit", (code) => stop(code ?? 1));

try {
  const api = new OpencodeApi(url, password);
  if (!(await poll(async () => await api.ready() || undefined, Date.now() + 45_000))) throw new Error("OpenCode 2 server did not become ready");
  if (stopping) throw new Error("OpenCode 2 server exited during startup");
  const session = await api.createSession(process.cwd(), model || undefined);
  const write = spawnSync("tmux", ["set-option", "-p", "-t", process.env.TMUX_PANE, "@am_session", session.id], { encoding: "utf8" });
  if (write.status !== 0) throw new Error(write.stderr || "could not bind OpenCode session to pane");
  tui = spawn("opencode", ["--server", url.replace(/\/api$/, ""), "--session", session.id, ...args], { stdio: "inherit" });
  tui.on("error", (error) => { console.error(error.message); stop(1); });
  tui.on("exit", (code) => stop(code ?? 0));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  stop(1);
}
