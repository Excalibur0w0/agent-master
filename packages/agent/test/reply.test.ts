import assert from "node:assert/strict";
import { test } from "node:test";

import { settledReply } from "../src/agent.ts";

test("a reply read as the turn ends is read again until the agent has written it", async () => {
  const replies = ["", "", "done"];
  let reads = 0;
  assert.equal(await settledReply(async () => replies[reads++], 2000, 10), "done");
  assert.equal(reads, 3);
});

test("a turn that ended without a reply gives up after the settle time", async () => {
  let reads = 0;
  const started = Date.now();
  assert.equal(await settledReply(async () => (reads++, ""), 100, 10), "");
  assert.ok(Date.now() - started >= 100 && reads > 1);
});

test("a reply that is there at once is not read twice", async () => {
  let reads = 0;
  assert.equal(await settledReply(async () => (reads++, "pong"), 2000, 10), "pong");
  assert.equal(reads, 1);
});

test("an error reading the reply is not retried", async () => {
  let reads = 0;
  await assert.rejects(settledReply(async () => (reads++, Promise.reject(new Error("too big"))), 2000, 10), /too big/);
  assert.equal(reads, 1);
});
