import assert from "node:assert/strict";
import { test } from "node:test";

import { parseRequest, stringifyRequest } from "@usebruno/filestore";

import { applyRequestFields, type BrunoItem, describeRequest, newHttpItem, type RequestFields } from "../src/request-spec.ts";

const FORMATS = ["yml", "bru"] as const;

function roundTrip(item: BrunoItem, format: "yml" | "bru"): BrunoItem {
  return parseRequest(stringifyRequest(item, { format }), { format });
}

const everything: RequestFields = {
  method: "post",
  url: "{{baseUrl}}/users/:id/posts?draft=true&q={{term}}",
  pathParams: { id: "42" },
  headers: [
    { name: "Accept", value: "application/json" },
    { name: "X-Debug", value: "1", enabled: false },
  ],
  body: { type: "json", content: '{\n  "title": "{{title}}",\n  "count": {{count}}\n}' },
  auth: { type: "bearer", token: "{{token}}" },
  scripts: { preRequest: "req.setHeader('X-Time', Date.now())", postResponse: "bru.setVar('id', res.body.id)" },
  vars: { preRequest: [{ name: "count", value: "3" }], postResponse: [{ name: "postId", value: "res.body.id" }] },
  assertions: [{ name: "res.status", value: "eq 201" }],
  tests: 'test("created", () => expect(res.status).to.equal(201));',
  docs: "# Create a post",
  tags: ["smoke"],
};

for (const format of FORMATS) {
  test(`every field survives a write and read (${format})`, () => {
    const item = newHttpItem("Create post", 3);
    applyRequestFields(item, everything);
    const read = roundTrip(item, format);

    assert.equal(read.seq, 3);
    assert.deepEqual(describeRequest(read), {
      name: "Create post",
      type: "http-request",
      method: "POST",
      url: "{{baseUrl}}/users/:id/posts?draft=true&q={{term}}",
      pathParams: { id: "42" },
      headers: [
        { name: "Accept", value: "application/json", enabled: true },
        { name: "X-Debug", value: "1", enabled: false },
      ],
      body: { type: "json", content: '{\n  "title": "{{title}}",\n  "count": {{count}}\n}' },
      auth: { type: "bearer", token: "{{token}}" },
      scripts: { preRequest: "req.setHeader('X-Time', Date.now())", postResponse: "bru.setVar('id', res.body.id)" },
      vars: {
        preRequest: [{ name: "count", value: "3", enabled: true }],
        postResponse: [{ name: "postId", value: "res.body.id", enabled: true }],
      },
      assertions: [{ name: "res.status", value: "eq 201", enabled: true }],
      tests: 'test("created", () => expect(res.status).to.equal(201));',
      docs: "# Create a post",
      tags: ["smoke"],
    });
    assert.deepEqual(
      read.request.params?.map(({ name, value, type, enabled }) => ({ name, value, type, enabled })),
      [
        { name: "draft", value: "true", type: "query", enabled: true },
        { name: "q", value: "{{term}}", type: "query", enabled: true },
        { name: "id", value: "42", type: "path", enabled: true },
      ],
    );
  });

  test(`form, multipart, basic and api key round-trip (${format})`, () => {
    const cases: [RequestFields["body"], RequestFields["auth"]][] = [
      [{ type: "form-urlencoded", fields: [{ name: "a", value: "1" }] }, { type: "basic", username: "u", password: "{{pw}}" }],
      [
        {
          type: "multipart",
          fields: [
            { name: "file", type: "file", paths: ["/tmp/a.png"] },
            { name: "note", value: "hi" },
          ],
        },
        { type: "apikey", key: "X-Key", value: "{{key}}" },
      ],
    ];
    const expected = [
      [
        { type: "form-urlencoded", fields: [{ name: "a", value: "1", enabled: true }] },
        { type: "basic", username: "u", password: "{{pw}}" },
      ],
      [
        {
          type: "multipart",
          fields: [
            { name: "file", type: "file", paths: ["/tmp/a.png"], enabled: true },
            { name: "note", type: "text", value: "hi", enabled: true },
          ],
        },
        { type: "apikey", key: "X-Key", value: "{{key}}", placement: "header" },
      ],
    ];
    cases.forEach(([body, auth], index) => {
      const item = newHttpItem("r", 1);
      applyRequestFields(item, { url: "https://example.com", body, auth });
      const view = describeRequest(roundTrip(item, format));
      assert.deepEqual([view.body, view.auth], expected[index]);
    });
  });
}

test("a new item writes Bruno's default settings", () => {
  const text = stringifyRequest(newHttpItem("r", 1), { format: "yml" });
  assert.match(text, /forwardAuthorizationHeader: false/);
  assert.match(text, /auth: inherit/);
});

test("changing the URL re-derives params but keeps disabled query params and path values", () => {
  const item = newHttpItem("r", 1);
  applyRequestFields(item, { url: "https://x/users/:id?a=1&b=2", pathParams: { id: "7" } });
  item.request.params = item.request.params?.map((param) => (param.name === "b" ? { ...param, enabled: false } : param));
  item.request.url = "https://x/users/:id?a=1";

  applyRequestFields(item, { url: "https://x/users/:id/items/:item?a=5" });
  assert.deepEqual(
    item.request.params?.map(({ name, value, type, enabled }) => [name, value, type, enabled]),
    [
      ["a", "5", "query", true],
      ["b", "2", "query", false],
      ["id", "7", "path", true],
      ["item", "", "path", true],
    ],
  );
});

test("a ? inside a variable does not start the query string", () => {
  const item = newHttpItem("r", 1);
  applyRequestFields(item, { url: "{{host?x}}/a?b=1" });
  assert.deepEqual(item.request.params?.map((param) => param.name), ["b"]);
});

test("path params must exist in the URL", () => {
  const item = newHttpItem("r", 1);
  assert.throws(() => applyRequestFields(item, { url: "https://x/users", pathParams: { id: "1" } }), /no path parameter :id/);
  applyRequestFields(item, { url: "https://x/users/:id" });
  assert.throws(() => applyRequestFields(item, { pathParams: { other: "1" } }), /no path parameter :other/);
  applyRequestFields(item, { pathParams: { id: "9" } });
  assert.equal(describeRequest(item).pathParams.id, "9");
});

test("omitted fields are left alone and scripts merge per phase", () => {
  const item = newHttpItem("r", 1);
  applyRequestFields(item, everything);
  applyRequestFields(item, { method: "PUT", scripts: { postResponse: "" } });
  const view = describeRequest(item);
  assert.equal(view.method, "PUT");
  assert.equal(view.url, everything.url);
  assert.deepEqual(view.scripts, { preRequest: "req.setHeader('X-Time', Date.now())", postResponse: "" });
  assert.equal(view.headers.length, 2);
});

test("body and auth types this server cannot write are reported as not editable", () => {
  const item = newHttpItem("r", 1);
  item.request.body.mode = "graphql";
  item.request.auth = { mode: "oauth2", oauth2: {} };
  const view = describeRequest(item);
  assert.deepEqual(view.body, { type: "graphql", editable: false });
  assert.deepEqual(view.auth, { type: "oauth2", editable: false });
});
