import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { LEDGER_TEMPLATE, ledgerHasTasks, renderHome } from "../src/home.ts";

const guide = () => readFile(resolve(import.meta.dirname, "../ROUTER.md"), "utf8");

test("the router's home holds the same instructions for every agent kind, and its am permissions", async () => {
  const files = Object.fromEntries(renderHome(await guide(), { project: "/work/app", workerKind: "codex" }).map((f) => [f.path, f.content]));
  assert.deepEqual(Object.keys(files), ["CLAUDE.md", "AGENTS.md", ".claude/settings.json"]);
  assert.equal(files["CLAUDE.md"], files["AGENTS.md"]);
  assert.match(files["AGENTS.md"], /Default project: `\/work\/app`/);
  assert.match(files["AGENTS.md"], /Default worker kind: `codex`/);
  assert.doesNotMatch(files["AGENTS.md"], /\{\{/);

  const { allow } = JSON.parse(files[".claude/settings.json"]).permissions;
  assert.ok(allow.includes("Bash(am prompt:*)") && allow.includes("Bash(am wait:*)"));
  // Decisions that belong to the user still ask them.
  for (const command of ["approve", "deny", "keys", "open"]) assert.ok(!allow.includes(`Bash(am ${command}:*)`), command);
  // Its ledger is the one file it edits.
  assert.ok(allow.includes("Edit(./LEDGER.md)") && allow.includes("Write(./LEDGER.md)"));
  assert.match(files["AGENTS.md"], /worker contract travels by itself\*\* \(`none configured`\)/);
});

test("the ledger counts as having tasks only for a task heading outside comments", async () => {
  const dir = await mkdtemp(join(tmpdir(), "am-ledger-"));
  assert.equal(await ledgerHasTasks(dir), false, "no ledger yet");
  await writeFile(join(dir, "LEDGER.md"), LEDGER_TEMPLATE);
  assert.equal(await ledgerHasTasks(dir), false);
  await writeFile(join(dir, "LEDGER.md"), `${LEDGER_TEMPLATE}<!--\n### an example\n-->\n`);
  assert.equal(await ledgerHasTasks(dir), false);
  await writeFile(join(dir, "LEDGER.md"), LEDGER_TEMPLATE.replace("## Queued", "## Queued\n\n### 查日志\n- Status: paused"));
  assert.equal(await ledgerHasTasks(dir), true);
});

test("every am command the router is told to run exists in am's usage", async () => {
  const am = resolve(import.meta.dirname, "../../agent/bin/am");
  const { stdout: usage } = await promisify(execFile)(am, ["help"]);
  const named = new Set([...(await guide()).matchAll(/`am ([a-z]+)/g)].map((m) => m[1]));
  const allowed = JSON.parse(renderHome("", { project: "/", workerKind: "claude" })[2].content)
    .permissions.allow.filter((rule: string) => rule.startsWith("Bash("))
    .map((rule: string) => rule.split(" ")[1].split(":")[0]);
  for (const command of new Set([...named, ...allowed])) assert.match(usage, new RegExp(`^  am ${command}\\b`, "m"), `am ${command}`);
});
