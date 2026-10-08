import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { Tmux } from "@agent-master/tmux";

import { renderTmuxConfig } from "../src/tmux-config.ts";

const tmux = new Tmux({ socketName: `am-ask-config-${process.pid}` });
after(() => tmux.killServer());

test("the generated binding keeps paths literal when tmux loads it", async () => {
  const odd = `/opt/it's "odd"/$HOME;dir`;
  const config = renderTmuxConfig({ key: "M-a", node: `${odd}/node`, cli: `${odd}/cli.ts`, opencode: `${odd}/opencode` });
  const file = join(await mkdtemp(join(tmpdir(), "am-ask-")), "shell-ask.tmux");
  await writeFile(file, config);

  await tmux.newSession("cfg", { command: "sh" });
  await tmux.run(["source-file", file]);
  const binding = await tmux.run(["list-keys", "-T", "prefix", "M-a"]);
  assert.ok(binding.includes("$HOME;dir"), `no $VAR expansion: ${binding}`);
  assert.ok(binding.includes(`it'\\\\''s`) || binding.includes("it'"), binding);
});

test("key names are validated so they cannot inject tmux commands", () => {
  const options = { node: "/n", cli: "/c", opencode: "/o" };
  assert.doesNotThrow(() => renderTmuxConfig({ ...options, key: "a" }));
  assert.doesNotThrow(() => renderTmuxConfig({ ...options, key: "C-x" }));
  assert.throws(() => renderTmuxConfig({ ...options, key: "a ; kill-server" }));
  assert.throws(() => renderTmuxConfig({ ...options, key: "" }));
});
