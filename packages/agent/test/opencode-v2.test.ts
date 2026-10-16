import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";

import { OpencodeApi } from "../src/opencode-api.ts";

test("v2 API unwraps responses and uses session-scoped state, permissions and messages", async () => {
  const posts: string[] = [];
  const routes: Record<string, unknown> = {
    "GET /api/session/active": { data: { ses_mine: { type: "running" }, ses_other: { type: "running" } } },
    "GET /api/session/ses_mine/permission": { data: [{ id: "per_1", sessionID: "ses_mine", action: "shell", resources: ["echo hello"] }] },
    "GET /api/session/ses_mine/form": { data: [] },
    "GET /api/session/ses_mine/message?order=desc&limit=1&type=assistant": { data: [
      { id: "m1", type: "assistant", content: [{ type: "reasoning", text: "private" }, { type: "text", text: "hello" }] },
    ] },
    "GET /api/session/ses_mine/message?order=desc&limit=1&type=user": { data: [{ id: "u1", type: "user", text: "hi" }] },
    "POST /api/session/ses_mine/permission/per_1/reply": null,
    "POST /api/session/ses_mine/interrupt": { data: { interrupted: true } },
  };
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => body += chunk);
    req.on("end", () => {
      const key = `${req.method} ${req.url}`;
      if (!(key in routes)) return void res.writeHead(404).end();
      if (req.method === "POST") posts.push(`${req.url} ${body}`);
      res.writeHead(routes[key] === null ? 204 : 200, { "content-type": "application/json" }).end(JSON.stringify(routes[key]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const client = new OpencodeApi(`http://127.0.0.1:${port}/api`, "pw", "ses_mine");
    assert.equal(await client.ready(), true);
    assert.deepEqual(await client.status(), { ses_mine: { type: "running" } });
    assert.deepEqual(await client.permissions(), [{ id: "per_1", sessionID: "ses_mine", permission: "shell", patterns: ["echo hello"] }]);
    assert.deepEqual(await client.questions(), []);
    assert.deepEqual((await client.messages("ses_mine"))[0].parts, [{ type: "reasoning", text: "private" }, { type: "text", text: "hello" }]);
    assert.equal(await client.promptID(), "u1");
    await client.replyPermission("per_1", "once");
    await client.abort("ses_mine");
    assert.deepEqual(posts, ['/api/session/ses_mine/permission/per_1/reply {"decision":"once"}', '/api/session/ses_mine/interrupt ']);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
