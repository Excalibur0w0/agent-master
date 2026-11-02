import { lstat, mkdir, readlink, symlink, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/am-router", import.meta.url));
const binLink = () => join(homedir(), ".local", "bin", "am-router");

export async function installGlobal(): Promise<string[]> {
  const link = binLink();
  if (!(await lstat(link).then(() => true, () => false))) {
    await mkdir(dirname(link), { recursive: true });
    await symlink(BIN, link);
    return [`linked ${link} → ${BIN}`];
  }
  return [(await readlink(link).catch(() => undefined)) === BIN ? `already linked: ${link}` : `skipped ${link} (taken by another file)`];
}

export async function uninstallGlobal(): Promise<string[]> {
  const link = binLink();
  if ((await readlink(link).catch(() => undefined)) !== BIN) return [];
  await unlink(link);
  return [`removed ${link}`];
}
