import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { afterResumeAll, extensions, runAfterResumeAll } from "../src/extensions.ts";

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

test("after am resume --all, each extension's afterResumeAll step runs with AM_BIN, and a failure is reported", async () => {
  const packages = await mkdtemp(join(tmpdir(), "am-ext-"));
  const pkg = async (dir: string, am: unknown, script?: string) => {
    await mkdir(join(packages, dir, "bin"), { recursive: true });
    await writeFile(join(packages, dir, "package.json"), JSON.stringify({ am }));
    if (script) await writeFile(join(packages, dir, "bin", "run"), script, { mode: 0o755 });
  };
  await pkg("a", { commands: { fly: "bin/run" }, afterResumeAll: ["fly", "resume", "--quiet"] }, `#!/bin/sh\necho "fly $* via $AM_BIN"\n`);
  await pkg("b", { commands: { sink: "bin/run" }, afterResumeAll: ["sink", "resume"] }, `#!/bin/sh\necho "half done"\necho "no feed" >&2\nexit 3\n`);
  await pkg("c", { commands: { swim: "bin/run" }, afterResumeAll: ["start", "x"] }, `#!/bin/sh\necho never\n`);
  await pkg("d", { commands: { walk: "bin/run" } }, `#!/bin/sh\necho never\n`);
  assert.deepEqual(afterResumeAll(packages).map((s) => [s.command, ...s.args]), [["fly", "resume", "--quiet"], ["sink", "resume"]], "only a package's own command");
  assert.deepEqual(runAfterResumeAll("/path/am", packages), ["fly resume --quiet via /path/am", "half done", "am sink resume failed: no feed"]);
});
