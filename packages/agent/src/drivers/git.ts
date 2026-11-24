import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

export interface GitRoots {
  /** The root of the working tree `cwd` is in. */
  top: string;
  /** The repository's root: the same, except in a linked worktree, where it is the main working tree's. */
  main: string;
}

/** Where `cwd` is in git; undefined outside it. */
export async function gitRoots(cwd: string): Promise<GitRoots | undefined> {
  const [top, gitDir, commonDir] = await new Promise<string[]>((done) =>
    execFile("git", ["-C", cwd, "rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"], (error, stdout) => done(error ? [] : stdout.split("\n"))),
  );
  if (!top) return undefined;
  // Either may be relative to cwd.
  const real = (path: string) => realpath(resolve(cwd, path)).catch(() => resolve(cwd, path));
  const common = await real(commonDir);
  return { top, main: (await real(gitDir)) !== common && basename(common) === ".git" ? dirname(common) : top };
}
