import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseFolder, parseRequest } from "@usebruno/filestore";

const BIN = fileURLToPath(new URL("../bin/am-bruno-mcp", import.meta.url));

let root: string;
let shop: string;
let legacy: string;
let client: Client;
let stderr = "";

async function put(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function ymlRequest(name: string, seq: number, method: string, url: string): string {
  return `info:\n  name: ${name}\n  type: http\n  seq: ${seq}\n\nhttp:\n  method: ${method}\n  url: ${JSON.stringify(url)}\n  auth: inherit\n`;
}

/** A Bruno data dir with one workspace collection (yml) and one collection from before workspaces (bru). */
async function makeFixture(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), "am-bruno-mcp-"));
  const dataDir = join(root, "data");
  const workspace = join(root, "workspace");
  shop = join(root, "shop");
  legacy = join(root, "legacy");

  await put(
    join(dataDir, "preferences.json"),
    JSON.stringify({ preferences: { general: { defaultWorkspacePath: workspace } }, lastOpenedCollections: [legacy] }),
  );
  await put(join(workspace, "workspace.yml"), "info:\n  name: Team\n  type: workspace\ncollections:\n  - name: Shop\n    path: ../shop\n");
  await put(join(workspace, "environments", "global.yml"), "name: global\nvariables:\n  - name: tenant\n    value: acme\n");

  await put(
    join(shop, "opencollection.yml"),
    "opencollection: 1.0.0\n\ninfo:\n  name: Shop\nextensions:\n  bruno:\n    ignore:\n      - node_modules\n      - .git\n      - drafts\n",
  );
  await put(join(shop, "List products.yml"), ymlRequest("List products", 1, "GET", "{{baseUrl}}/products"));
  await put(join(shop, "admin", "folder.yml"), "info:\n  name: admin\n  type: folder\n  seq: 2\n\nrequest:\n  auth: inherit\n");
  await put(join(shop, "admin", "Delete product.yml"), ymlRequest("Delete product", 1, "DELETE", "{{baseUrl}}/products/:id"));
  await put(join(shop, "drafts", "Draft.yml"), ymlRequest("Draft", 1, "GET", "https://x"));
  await put(join(shop, "environments", "dev.yml"), "name: dev\nvariables:\n  - name: baseUrl\n    value: http://localhost:3000\n  - secret: true\n    name: token\n");

  await put(join(legacy, "bruno.json"), JSON.stringify({ version: "1", name: "Legacy", type: "collection", ignore: [] }));
  await put(join(legacy, "broken.bru"), "meta {\n  name: broken\n");

  const transport = new StdioClientTransport({ command: BIN, env: { AM_BRUNO_DATA_DIR: dataDir }, stderr: "pipe" });
  transport.stderr?.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  client = new Client({ name: "test", version: "0" });
  await client.connect(transport);
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<any> {
  const response = await client.callTool({ name, arguments: args });
  const text = (response.content as { type: string; text: string }[])[0].text;
  if (response.isError) throw new Error(text);
  return JSON.parse(text);
}

before(makeFixture);
after(() => client?.close());

test("lists its tools", async () => {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), [
    "create_request",
    "get_collection",
    "list_collections",
    "read_request",
    "update_request",
  ]);
  const create = tools.find((tool) => tool.name === "create_request");
  assert.deepEqual((create?.inputSchema.required as string[]).sort(), ["collection", "name", "url"]);
});

test("finds collections from Bruno's workspaces and its older collection list", async () => {
  assert.deepEqual(await call("list_collections"), [
    { name: "Shop", path: shop, format: "yml", workspace: "Team" },
    { name: "Legacy", path: legacy, format: "bru" },
  ]);
});

test("describes a collection, skipping ignored folders", async () => {
  const collection = await call("get_collection", { collection: "Shop" });
  assert.deepEqual(collection.folders, [{ path: "admin", name: "admin" }]);
  assert.deepEqual(collection.requests, [
    { path: "List products.yml", name: "List products", method: "GET", url: "{{baseUrl}}/products" },
    { path: "admin/Delete product.yml", name: "Delete product", method: "DELETE", url: "{{baseUrl}}/products/:id" },
  ]);
  assert.deepEqual(collection.environments, [
    {
      name: "dev",
      variables: [
        { name: "baseUrl", value: "http://localhost:3000", enabled: true, secret: false },
        { name: "token", enabled: true, secret: true },
      ],
    },
  ]);
  assert.deepEqual(collection.globalEnvironments, [
    { name: "global", variables: [{ name: "tenant", value: "acme", enabled: true, secret: false }] },
  ]);
});

test("creates a request, and the folders it needs, where Bruno would", async () => {
  const created = await call("create_request", {
    collection: shop,
    folder: "admin/reports",
    name: "Sales: monthly",
    method: "post",
    url: "{{baseUrl}}/reports?month=1",
    body: { type: "json", content: '{"tenant": "{{tenant}}"}' },
  });
  assert.equal(created.path, "admin/reports/Sales- monthly.yml");
  assert.equal(created.file, join(shop, "admin", "reports", "Sales- monthly.yml"));
  assert.equal(created.request.name, "Sales: monthly");
  assert.equal(created.request.method, "POST");

  const folder = parseFolder(await readFile(join(shop, "admin", "reports", "folder.yml"), "utf8"), { format: "yml" });
  assert.deepEqual(folder.meta, { name: "reports", seq: 2 });

  const onDisk = parseRequest(await readFile(created.file, "utf8"), { format: "yml" });
  assert.equal(onDisk.seq, 1);
  assert.equal(onDisk.request.body.json, '{"tenant": "{{tenant}}"}');

  const second = await call("create_request", { collection: shop, folder: "admin", name: "Restore", url: "https://x" });
  assert.equal(parseRequest(await readFile(second.file, "utf8"), { format: "yml" }).seq, 3);

  await assert.rejects(
    call("create_request", { collection: shop, folder: "admin/reports", name: "Sales: monthly", url: "https://y" }),
    /already exists; use update_request/,
  );
});

test("updates only the fields passed", async () => {
  const updated = await call("update_request", {
    collection: "Shop",
    path: "admin/Delete product.yml",
    pathParams: { id: "{{productId}}" },
    headers: [{ name: "X-Reason", value: "test" }],
  });
  assert.equal(updated.request.method, "DELETE");
  assert.equal(updated.request.url, "{{baseUrl}}/products/:id");
  assert.deepEqual(updated.request.pathParams, { id: "{{productId}}" });
  assert.deepEqual(updated.request.headers, [{ name: "X-Reason", value: "test", enabled: true }]);

  const read = await call("read_request", { collection: shop, path: "admin/Delete product.yml" });
  assert.deepEqual(read.request, updated.request);
});

test("refuses paths outside the collection's requests", async () => {
  await assert.rejects(call("read_request", { collection: shop, path: "../legacy/bruno.json" }), /not allowed/);
  await assert.rejects(call("read_request", { collection: shop, path: "drafts/Draft.yml" }), /not part of the collection/);
  await assert.rejects(call("read_request", { collection: shop, path: "environments/dev.yml" }), /not part of the collection/);
  await assert.rejects(call("create_request", { collection: shop, folder: "..", name: "x", url: "https://x" }), /not allowed/);
  await assert.rejects(call("get_collection", { collection: "Nope" }), /No collection named "Nope"/);
});

test("writes .bru collections and keeps library logging off the protocol stream", async () => {
  const created = await call("create_request", { collection: legacy, name: "Ping", url: "https://example.com/ping" });
  assert.equal(created.path, "Ping.bru");
  assert.match(await readFile(created.file, "utf8"), /get \{\n {2}url: https:\/\/example.com\/ping/);

  const collection = await call("get_collection", { collection: legacy });
  assert.deepEqual(collection.requests, [{ path: "Ping.bru", name: "Ping", method: "GET", url: "https://example.com/ping" }]);
  assert.equal(collection.unreadable[0].path, "broken.bru");
  assert.match(stderr, /parseBruRequest error/);
});
