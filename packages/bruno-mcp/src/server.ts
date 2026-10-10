import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { openedCollections } from "./bruno-app.ts";
import { absolutePath, type Collection, loadCollection, readEnvironments, resolveCollection, scanCollection } from "./collection.ts";
import { type BrunoItem, describeRequest, requestFields } from "./request-spec.ts";
import { createRequest, readRequest, updateRequest } from "./requests.ts";

// stdout carries the MCP protocol, and @usebruno/filestore logs parse errors with console.log.
console.log = console.error;
console.info = console.error;
console.debug = console.error;

const INSTRUCTIONS = `Writes HTTP requests into Bruno collections on disk. The Bruno app watches its collections, so a request created or updated here appears in Bruno right away, and the user sends it from Bruno; this server never sends requests.
Start with list_collections, then get_collection to see the existing folders, requests and environment variables. Prefer {{variable}} placeholders for values an environment already defines (base URLs, tokens).`;

const collectionParam = z.string().describe("The collection's absolute path (from list_collections), or its name");
const requestPathParam = z.string().describe("Request file path relative to the collection root, as listed by get_collection");

function result(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] };
}

function requestResult(collection: Collection, { path, item }: { path: string; item: BrunoItem }) {
  return result({ path, file: absolutePath(collection, path), request: describeRequest(item) });
}

const server = new McpServer({ name: "bruno", version: "0.1.0" }, { instructions: INSTRUCTIONS });

server.registerTool(
  "list_collections",
  {
    description: "List the collections open in the Bruno app (across its workspaces) with their paths.",
    annotations: { readOnlyHint: true },
  },
  async () => {
    const collections = await Promise.all(
      (await openedCollections()).map(async ({ path, workspace }) => {
        try {
          const collection = await loadCollection(path, workspace);
          return { name: collection.name, path, format: collection.format, workspace: workspace?.name };
        } catch (error) {
          return { path, workspace: workspace?.name, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    );
    return result(collections);
  },
);

server.registerTool(
  "get_collection",
  {
    description:
      "Show a collection's folders, requests (path, name, method, URL) and environment variables, including the workspace's global environments.",
    inputSchema: { collection: collectionParam },
    annotations: { readOnlyHint: true },
  },
  async ({ collection: ref }) => {
    const collection = await resolveCollection(ref);
    const contents = await scanCollection(collection);
    return result({
      name: collection.name,
      path: collection.path,
      format: collection.format,
      workspace: collection.workspace?.name,
      folders: contents.folders.map(({ path, name }) => ({ path, name })),
      requests: contents.requests.map(({ path, name, type, method, url }) =>
        type === "http-request" ? { path, name, method, url } : { path, name, type },
      ),
      environments: await readEnvironments(collection.path, collection.format),
      globalEnvironments: collection.workspace ? await readEnvironments(collection.workspace.path, "yml") : [],
      ...(contents.unreadable.length ? { unreadable: contents.unreadable } : {}),
    });
  },
);

server.registerTool(
  "read_request",
  {
    description: "Read one request in the same shape create_request and update_request take.",
    inputSchema: { collection: collectionParam, path: requestPathParam },
    annotations: { readOnlyHint: true },
  },
  async ({ collection: ref, path }) => {
    const collection = await resolveCollection(ref);
    return requestResult(collection, await readRequest(collection, path));
  },
);

server.registerTool(
  "create_request",
  {
    description:
      "Create an HTTP request in a collection. Missing folders are created. It shows up in the Bruno app immediately; the user sends it from there.",
    inputSchema: {
      collection: collectionParam,
      folder: z.string().optional().describe("Folder path relative to the collection root, e.g. users/admin; default the root"),
      name: z.string().describe("Request name as shown in Bruno; the file name is derived from it"),
      ...requestFields,
      url: z.string().describe(requestFields.url.description ?? ""),
    },
    annotations: { destructiveHint: false },
  },
  async ({ collection: ref, folder, name, ...fields }) => {
    const collection = await resolveCollection(ref);
    return requestResult(collection, await createRequest(collection, { folder, name, fields }));
  },
);

server.registerTool(
  "update_request",
  {
    description:
      "Change an existing HTTP request. Only the fields passed are changed; list fields (headers, assertions, ...) are replaced as a whole. Renaming keeps the file name.",
    inputSchema: {
      collection: collectionParam,
      path: requestPathParam,
      name: z.string().optional().describe("New name as shown in Bruno"),
      ...requestFields,
    },
    annotations: { destructiveHint: true, idempotentHint: true },
  },
  async ({ collection: ref, path, name, ...fields }) => {
    const collection = await resolveCollection(ref);
    return requestResult(collection, await updateRequest(collection, path, { name, fields }));
  },
);

await server.connect(new StdioServerTransport());
