import { readdir, readFile } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, resolve } from "node:path";

import { type CollectionFormat, parseCollection, parseEnvironment, parseFolder, parseRequest } from "@usebruno/filestore";

import { openedCollections, type Workspace } from "./bruno-app.ts";
import type { BrunoItem } from "./request-spec.ts";

export interface Collection {
  name: string;
  path: string;
  format: CollectionFormat;
  /** Paths relative to the collection root that Bruno does not load. */
  ignore: string[];
  workspace?: Workspace;
}

/** Bruno always skips these, whatever the collection config says. */
const ALWAYS_IGNORED = ["node_modules", ".git"];

/** Reads the collection config the way Bruno does: opencollection.yml wins over bruno.json. */
export async function loadCollection(path: string, workspace?: Workspace): Promise<Collection> {
  let config: { name?: string; ignore?: string[] };
  let format: CollectionFormat;
  try {
    config = parseCollection(await readFile(join(path, "opencollection.yml"), "utf8"), { format: "yml" }).brunoConfig;
    format = "yml";
  } catch (ymlError) {
    if ((ymlError as NodeJS.ErrnoException).code !== "ENOENT") throw ymlError;
    try {
      config = JSON.parse(await readFile(join(path, "bruno.json"), "utf8"));
      format = "bru";
    } catch (jsonError) {
      if ((jsonError as NodeJS.ErrnoException).code !== "ENOENT") throw jsonError;
      throw new Error(`${path} is not a Bruno collection (it has neither opencollection.yml nor bruno.json)`);
    }
  }
  return { name: config.name ?? basename(path), path, format, ignore: config.ignore ?? [], workspace };
}

/** `ref` is a collection's absolute path, or the name of a collection open in Bruno. */
export async function resolveCollection(ref: string): Promise<Collection> {
  const opened = await openedCollections();
  if (isAbsolute(ref)) {
    const path = resolve(ref);
    return loadCollection(path, opened.find((entry) => entry.path === path)?.workspace);
  }
  const loaded = await Promise.all(
    opened.map((entry) => loadCollection(entry.path, entry.workspace).catch(() => undefined)),
  );
  const matches = loaded.filter((collection) => collection?.name === ref);
  if (matches.length === 1 && matches[0]) return matches[0];
  throw new Error(
    matches.length
      ? `Several open collections are named "${ref}"; pass the collection's path instead`
      : `No collection named "${ref}" is open in Bruno; pass the collection's absolute path, or call list_collections`,
  );
}

const INVALID_CHARACTERS = /[<>:"/\\|?*\x00-\x1F]/g;
const RESERVED_DEVICE_NAMES = /^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])$/i;

/** Bruno's rule for turning a request name into a file name (`sanitizeName` in @usebruno/common). */
export function sanitizeName(name: string): string {
  return name
    .replace(INVALID_CHARACTERS, "-")
    .replace(/^[\s-]+/, "")
    .replace(/[.\s]+$/, "");
}

/** Bruno's rule for file and folder names (`validateName` in @usebruno/common). */
export function isValidName(name: string): boolean {
  if (!name || name.length > 255 || RESERVED_DEVICE_NAMES.test(name)) return false;
  return (
    /^[^\s\-<>:"/\\|?*\x00-\x1F]/.test(name) &&
    /^[^<>:"/\\|?*\x00-\x1F]*$/.test(name) &&
    /[^.\s<>:"/\\|?*\x00-\x1F]$/.test(name)
  );
}

/**
 * Normalizes a path relative to the collection root to `a/b/c` and rejects anything that leaves the
 * collection, or points into a part Bruno does not load as requests.
 */
export function relativePath(collection: Collection, path: string): string {
  if (isAbsolute(path)) {
    const inside = relative(collection.path, path);
    if (inside.startsWith("..") || isAbsolute(inside)) throw new Error(`${path} is outside the collection`);
    path = inside;
  }
  const segments = path.split(/[\\/]+/).filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) throw new Error(`${path}: ".." is not allowed`);
  const normalized = segments.join("/");
  if (normalized && isExcluded(collection, normalized)) {
    throw new Error(`${normalized} is not part of the collection's requests (ignored, or an environments/mocks folder)`);
  }
  return normalized;
}

export function absolutePath(collection: Collection, relativeToRoot: string): string {
  return join(collection.path, ...relativeToRoot.split("/").filter(Boolean));
}

/** Mirrors the collection watcher in Bruno's main process. */
function isExcluded(collection: Collection, path: string): boolean {
  const segments = path.split("/");
  const name = segments[segments.length - 1];
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (segments.some((segment) => ALWAYS_IGNORED.includes(segment))) return true;
  if (segments[0] === "mocks" || segments[0] === "environments") return true;
  return collection.ignore.some((pattern) => {
    const normalized = pattern.replace(/\\/g, "/");
    return normalized !== "" && (path === normalized || path.startsWith(`${normalized}/`));
  });
}

export function folderFileName(collection: Collection): string {
  return `folder.${collection.format}`;
}

export function isRequestFile(collection: Collection, path: string): boolean {
  if (extname(path) !== `.${collection.format}`) return false;
  const name = path.split("/").pop();
  if (name === folderFileName(collection)) return false;
  return !(path === "opencollection.yml" || path === "collection.bru");
}

export async function readItem(collection: Collection, path: string): Promise<BrunoItem> {
  return parseRequest(await readFile(absolutePath(collection, path), "utf8"), { format: collection.format });
}

async function readFolderMeta(collection: Collection, folder: string): Promise<{ name?: string; seq?: number }> {
  try {
    const file = await readFile(join(absolutePath(collection, folder), folderFileName(collection)), "utf8");
    return parseFolder(file, { format: collection.format }).meta ?? {};
  } catch {
    return {};
  }
}

export interface FolderSummary {
  path: string;
  name: string;
}

export interface RequestSummary {
  path: string;
  name: string;
  type: string;
  method?: string;
  url?: string;
}

type Child =
  | ({ kind: "folder"; seq?: number } & FolderSummary)
  | ({ kind: "request"; seq?: number } & RequestSummary)
  | { kind: "unreadable"; seq?: undefined; path: string; error: string };

function childPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** The folders and request files directly inside `folder`, in the order Bruno shows them. */
async function readChildren(collection: Collection, folder: string): Promise<Child[]> {
  const children: Child[] = [];
  for (const entry of await readdir(absolutePath(collection, folder), { withFileTypes: true })) {
    const path = childPath(folder, entry.name);
    if (isExcluded(collection, path)) continue;
    if (entry.isDirectory()) {
      const meta = await readFolderMeta(collection, path);
      children.push({ kind: "folder", path, name: meta.name ?? entry.name, seq: meta.seq });
    } else if (entry.isFile() && isRequestFile(collection, path)) {
      try {
        const { name, type, request, seq } = await readItem(collection, path);
        children.push({ kind: "request", path, name, type, method: request?.method, url: request?.url, seq });
      } catch (error) {
        children.push({ kind: "unreadable", path, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  const position = (child: Child) => (typeof child.seq === "number" && Number.isFinite(child.seq) ? child.seq : Infinity);
  return children.sort((a, b) => position(a) - position(b) || a.path.localeCompare(b.path));
}

export interface CollectionContents {
  folders: FolderSummary[];
  requests: RequestSummary[];
  unreadable: { path: string; error: string }[];
}

/** Every folder and request in the collection, depth first in the order Bruno's sidebar shows them. */
export async function scanCollection(collection: Collection): Promise<CollectionContents> {
  const contents: CollectionContents = { folders: [], requests: [], unreadable: [] };
  const walk = async (folder: string): Promise<void> => {
    for (const child of await readChildren(collection, folder)) {
      if (child.kind === "folder") {
        contents.folders.push({ path: child.path, name: child.name });
        await walk(child.path);
      } else if (child.kind === "request") {
        const { path, name, type, method, url } = child;
        contents.requests.push({ path, name, type, method, url });
      } else {
        contents.unreadable.push({ path: child.path, error: child.error });
      }
    }
  };
  await walk("");
  return contents;
}

/** The position after the last request or folder in `folder`, which is where Bruno appends new items. */
export async function nextSeq(collection: Collection, folder: string): Promise<number> {
  const positions = (await readChildren(collection, folder))
    .map((child) => child.seq)
    .filter((seq): seq is number => typeof seq === "number" && Number.isFinite(seq));
  return Math.max(0, ...positions) + 1;
}

export interface EnvironmentSummary {
  name: string;
  /** Secret values are kept out of the file by Bruno, so only their names are listed. */
  variables: { name: string; value?: string; enabled: boolean; secret: boolean }[];
}

interface ParsedEnvironment {
  name?: string;
  variables?: { name: string; value?: unknown; enabled?: boolean; secret?: boolean }[];
}

/** Environments stored as `environments/*.<format>` under `dir` (a collection, or a workspace for global ones). */
export async function readEnvironments(dir: string, format: CollectionFormat): Promise<EnvironmentSummary[]> {
  const envDir = join(dir, "environments");
  let names: string[];
  try {
    names = (await readdir(envDir)).filter((name) => extname(name) === `.${format}`).sort();
  } catch {
    return [];
  }
  const environments: EnvironmentSummary[] = [];
  for (const file of names) {
    try {
      const parsed = parseEnvironment(await readFile(join(envDir, file), "utf8"), { format }) as ParsedEnvironment;
      environments.push({
        // .bru environments carry no name; Bruno uses the file name.
        name: parsed.name ?? basename(file, extname(file)),
        variables: (parsed.variables ?? []).map(({ name, value, enabled, secret }) => ({
          name,
          ...(secret ? {} : { value: typeof value === "string" ? value : JSON.stringify(value) }),
          enabled: enabled !== false,
          secret: secret === true,
        })),
      });
    } catch {
      // A broken environment file must not hide the rest; Bruno reports it in its own UI.
    }
  }
  return environments;
}
