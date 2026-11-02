import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";

// The router sits on top of am and drives it through its command line; am must not know the router exists.
test("the am package does not depend on the router", async () => {
  const agent = resolve(import.meta.dirname, "../../agent");
  const offenders: string[] = [];
  for (const file of await readdir(agent, { recursive: true })) {
    if (file.split("/").includes("node_modules") || !/\.(ts|js|sh|md|json)$/.test(file)) continue;
    if (/@agent-master\/router|packages\/router|am-router/.test(await readFile(join(agent, file), "utf8"))) offenders.push(file);
  }
  assert.deepEqual(offenders, []);
});
