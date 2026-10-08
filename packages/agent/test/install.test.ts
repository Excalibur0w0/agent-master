import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { test } from "node:test";

import { OPENCODE_PROJECT_CONFIG, opencodeDeniesAm, projectRoots, renderTargets } from "../src/install.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const guide = () => readFile(resolve(import.meta.dirname, "../skills/am/GUIDE.md"), "utf8");

function frontmatter(content: string): Record<string, string> {
  const block = /^---\n([\s\S]*?)\n---\n/.exec(content)?.[1] ?? "";
  return Object.fromEntries(block.split("\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1).trim()]));
}

test("every target is explicit-only, in the format that agent understands", async () => {
  const [claude, codexSkill, codexPolicy, opencode] = renderTargets(await guide(), { claude: "/c", codex: "/x", opencode: "/o" });

  assert.equal(claude.path, "/c/commands/am.md");
  assert.equal(frontmatter(claude.content)["disable-model-invocation"], "true");
  assert.match(claude.content, /Their request: \$ARGUMENTS/);

  assert.equal(codexSkill.path, "/x/am/SKILL.md");
  assert.deepEqual(Object.keys(frontmatter(codexSkill.content)), ["name", "description"], "Codex rejects other frontmatter keys");
  assert.equal(codexPolicy.path, "/x/am/agents/openai.yaml");
  assert.match(codexPolicy.content, /allow_implicit_invocation: false/);

  assert.equal(opencode.path, "/o/commands/am.md");
  assert.match(opencode.content, /\$ARGUMENTS/);

  for (const file of [claude, codexSkill, opencode]) {
    assert.doesNotMatch(file.content, /\{\{REQUEST\}\}/);
    // The description contains ": ", which strict YAML rejects in a plain scalar.
    assert.match(frontmatter(file.content).description, /^".*"$/);
  }
});

test("an existing opencode.json only counts when it really denies the am skill", () => {
  assert.equal(opencodeDeniesAm(OPENCODE_PROJECT_CONFIG), true);
  assert.equal(opencodeDeniesAm('{"permission":{"skill":"deny"}}'), true);
  assert.equal(opencodeDeniesAm('{"command":{"am":{}}}'), false, 'merely mentioning "am" is not enough');
  assert.equal(opencodeDeniesAm('{"permission":{"skill":{"am":"allow"}}}'), false);
  assert.equal(opencodeDeniesAm("// jsonc\n{}"), false, "unparseable means: ask the user to check");
  // Last matching rule wins, at both levels.
  assert.equal(opencodeDeniesAm('{"permission":{"skill":{"am":"deny","*":"allow"}}}'), false);
  assert.equal(opencodeDeniesAm('{"permission":{"skill":{"*":"allow","a?":"deny"}}}'), true);
  assert.equal(opencodeDeniesAm('{"permission":{"skill":{"am":"deny"},"*":"allow"}}'), false);
  assert.equal(opencodeDeniesAm('{"permission":{"*":"allow","skill":{"am":"deny"}}}'), true);
  // OpenCode's trailing " *" also matches the bare name.
  assert.equal(opencodeDeniesAm('{"permission":{"skill":{"am":"deny","am *":"allow"}}}'), false);
});

test("the repo's project entry points are in sync with the generator", async () => {
  for (const file of renderTargets(await guide(), projectRoots(repoRoot))) {
    assert.equal(await readFile(file.path, "utf8"), file.content, `${file.path} is stale: run am install --project .`);
  }
  assert.equal(await readFile(join(repoRoot, "opencode.json"), "utf8"), OPENCODE_PROJECT_CONFIG);
});
