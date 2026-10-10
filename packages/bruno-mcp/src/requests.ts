import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { stringifyFolder, stringifyRequest } from "@usebruno/filestore";

import {
  absolutePath,
  type Collection,
  folderFileName,
  isRequestFile,
  isValidName,
  nextSeq,
  readItem,
  relativePath,
  sanitizeName,
} from "./collection.ts";
import { applyRequestFields, type BrunoItem, newHttpItem, type RequestFields } from "./request-spec.ts";

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function requestPath(collection: Collection, path: string): string {
  const normalized = relativePath(collection, path);
  if (!isRequestFile(collection, normalized)) {
    throw new Error(`${path} is not a request file; request files end in .${collection.format}`);
  }
  return normalized;
}

/** Creates each missing folder along `folder` the way Bruno's "New Folder" does, with its folder file. */
async function ensureFolder(collection: Collection, folder: string): Promise<void> {
  let current = "";
  for (const segment of folder.split("/").filter(Boolean)) {
    const parent = current;
    current = current ? `${current}/${segment}` : segment;
    const dir = absolutePath(collection, current);
    if (await exists(dir)) continue;

    if (!isValidName(segment)) throw new Error(`"${segment}" is not a valid folder name`);
    const seq = await nextSeq(collection, parent);
    await mkdir(dir);
    const folderData = { meta: { name: segment, seq }, request: { auth: { mode: "inherit" } } };
    await writeFile(join(dir, folderFileName(collection)), stringifyFolder(folderData, { format: collection.format }));
  }
}

export async function readRequest(collection: Collection, path: string): Promise<{ path: string; item: BrunoItem }> {
  const normalized = requestPath(collection, path);
  return { path: normalized, item: await readItem(collection, normalized) };
}

export async function createRequest(
  collection: Collection,
  options: { folder?: string; name: string; fields: RequestFields },
): Promise<{ path: string; item: BrunoItem }> {
  const fileName = sanitizeName(options.name);
  if (!isValidName(fileName)) throw new Error(`"${options.name}" cannot be used as a request name`);

  const folder = relativePath(collection, options.folder ?? "");
  const path = relativePath(collection, folder ? `${folder}/${fileName}.${collection.format}` : `${fileName}.${collection.format}`);
  if (await exists(absolutePath(collection, path))) {
    throw new Error(`${path} already exists; use update_request to change it, or pick another name`);
  }

  await ensureFolder(collection, folder);
  const item = newHttpItem(options.name, await nextSeq(collection, folder));
  applyRequestFields(item, options.fields);
  // "wx": never overwrite a file that appeared since the check above.
  await writeFile(absolutePath(collection, path), stringifyRequest(item, { format: collection.format }), { flag: "wx" });
  return readRequest(collection, path);
}

export async function updateRequest(
  collection: Collection,
  path: string,
  options: { name?: string; fields: RequestFields },
): Promise<{ path: string; item: BrunoItem }> {
  const { path: normalized, item } = await readRequest(collection, path);
  if (item.type !== "http-request") throw new Error(`${normalized} is a ${item.type}; only HTTP requests can be edited`);

  if (options.name !== undefined) item.name = options.name;
  applyRequestFields(item, options.fields);
  await writeFile(absolutePath(collection, normalized), stringifyRequest(item, { format: collection.format }));
  return readRequest(collection, normalized);
}
