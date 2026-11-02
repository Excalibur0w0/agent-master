import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { renderHome } from "../src/home.ts";

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
});

test("every am command the router is told to run exists in am's usage", async () => {
  const am = resolve(import.meta.dirname, "../../agent/bin/am");
  const { stdout: usage } = await promisify(execFile)(am, ["help"]);
  const named = new Set([...(await guide()).matchAll(/`am ([a-z]+)/g)].map((m) => m[1]));
  const allowed = JSON.parse(renderHome("", { project: "/", workerKind: "claude" })[2].content).permissions.allow.map((rule: string) => rule.split(" ")[1].split(":")[0]);
  for (const command of new Set([...named, ...allowed])) assert.match(usage, new RegExp(`^  am ${command}\\b`, "m"), `am ${command}`);
});
