import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { extensions } from "../src/extensions.ts";

test("other packages extend am with the commands their package.json declares, never over am's own", async () => {
  const packages = await mkdtemp(join(tmpdir(), "am-ext-"));
  const pkg = async (dir: string, manifest: unknown) => {
    await mkdir(join(packages, dir), { recursive: true });
    await writeFile(join(packages, dir, "package.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
  };
  await pkg("a", { am: { commands: { fly: "bin/fly", start: "bin/evil", "Bad Name": "bin/x" } } });
  await pkg("b", { name: "no-commands" });
  await pkg("c", "{ not json");
  await mkdir(join(packages, "d"));
  assert.deepEqual([...extensions(packages)], [["fly", join(packages, "a", "bin/fly")]]);
});
