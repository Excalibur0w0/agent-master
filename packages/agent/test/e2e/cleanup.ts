import { execFile } from "node:child_process";
import { open, readdir, readFile, rm, rmdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Codex threads started in one of `dirs` since `since`, from each rollout's session_meta line. */
async function codexThreads(dirs: string[], since: number): Promise<string[]> {
  const root = join(homedir(), ".codex", "sessions");
  const ids: string[] = [];
  for (const file of await readdir(root, { recursive: true }).catch(() => [])) {
    const path = join(root, file);
    if (!file.endsWith(".jsonl")) continue;
    try {
      if ((await stat(path)).mtimeMs < since) continue;
      const handle = await open(path);
      try {
        for await (const line of handle.readLines()) {
          const meta = JSON.parse(line);
          if (meta.type === "session_meta" && dirs.includes(meta.payload?.cwd)) ids.push(meta.payload.id);
          break;
        }
      } finally {
        await handle.close();
      }
    } catch {
      // Being written or not a rollout: not ours to judge.
    }
  }
  return ids;
}

/** dsh sessions started in one of `dirs` since `since`, from its session index. */
async function dshSessions(dsh: string, dirs: string[], since: number): Promise<string[]> {
  const index = join(dsh, "storages", "session_projcache", "sessions");
  const ids: string[] = [];
  for (const file of await readdir(index).catch(() => [])) {
    if (!file.endsWith(".json")) continue;
    try {
      const { cwd, createdAt } = JSON.parse(await readFile(join(index, file), "utf8")).record.identity;
      if (dirs.includes(cwd) && createdAt >= since) ids.push(file.slice(0, -".json".length));
    } catch {
      // Not a session record we can read: leave it alone.
    }
  }
  return ids;
}

/** Removes a dsh session's log (under its project folder), index entry and am's reply file. */
async function forgetDshSession(dsh: string, id: string): Promise<void> {
  const sessions = join(dsh, "sessions");
  for (const project of await readdir(sessions).catch(() => [])) {
    await rm(join(sessions, project, id), { recursive: true, force: true });
    await rmdir(join(sessions, project)).catch(() => {});
  }
  await rm(join(dsh, "storages", "session_projcache", "sessions", `${id}.json`), { force: true });
  await rm(join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "agent-master", "dsh-replies", `${id}.txt`), { force: true });
}

/**
 * Deletes the sessions e2e agents left in each agent's own history since the
 * test started, so they never show up in the user's resume lists, then the
 * test's work dirs. Only sessions whose cwd is one of `dirs` are touched.
 */
export async function forgetTestSessions(dirs: string[], since: number): Promise<void> {
  for (const dir of dirs) if (!/e2e/.test(dir)) throw new Error(`refusing to clean a non-e2e dir: ${dir}`);
  for (const id of await codexThreads(dirs, since)) await run("codex", ["delete", "--force", id]).catch(() => {});
  const dsh = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  for (const id of await dshSessions(dsh, dirs, since)) await forgetDshSession(dsh, id);
  for (const dir of dirs) {
    // Claude keeps one folder per cwd, named after the path.
    await rm(join(homedir(), ".claude", "projects", dir.replace(/[^A-Za-z0-9]/g, "-")), { recursive: true, force: true });
    // opencode resolves the project from $PWD, and a project's list spans other dirs.
    const options = { cwd: dir, env: { ...process.env, PWD: dir } };
    const { stdout } = await run("opencode", ["session", "list", "--format", "json"], options).catch(() => ({ stdout: "" }));
    for (const session of JSON.parse(stdout.trim() || "[]") as { id: string; directory: string }[]) {
      if (session.directory === dir) await run("opencode", ["session", "delete", session.id], options).catch(() => {});
    }
    await rm(dir, { recursive: true, force: true });
  }
}
