import { parseQueryParams } from "@usebruno/common/utils";
import { z } from "zod";

/**
 * The parts of Bruno's in-memory request item (what `@usebruno/filestore` parses and stringifies)
 * that this server reads or writes. Parsed items carry more fields (uids, examples, ...); they pass
 * through untouched.
 */
interface BrunoKeyValue {
  name: string;
  value: string;
  enabled: boolean;
}

interface BrunoParam extends BrunoKeyValue {
  type: "query" | "path";
}

interface BrunoMultipartField {
  name: string;
  /** File fields hold a list of paths. */
  value: string | string[];
  type: "text" | "file";
  enabled: boolean;
}

export interface BrunoItem {
  type: string;
  name: string;
  seq: number;
  tags?: string[];
  request: {
    method: string;
    url: string;
    params?: BrunoParam[];
    headers?: BrunoKeyValue[];
    body: { mode: string; [field: string]: unknown };
    auth: { mode: string; [field: string]: unknown };
    script?: { req?: string | null; res?: string | null };
    vars?: { req?: BrunoKeyValue[]; res?: BrunoKeyValue[] };
    assertions?: BrunoKeyValue[];
    tests?: string | null;
    docs?: string | null;
  };
  settings: Record<string, unknown>;
}

const keyValue = z.object({
  name: z.string(),
  value: z.string(),
  enabled: z.boolean().optional().describe("Default true"),
});

const multipartField = z.union([
  z.object({ name: z.string(), type: z.literal("text").optional(), value: z.string(), enabled: z.boolean().optional() }),
  z.object({
    name: z.string(),
    type: z.literal("file"),
    paths: z.array(z.string()).min(1).describe("Absolute paths of the files to upload"),
    enabled: z.boolean().optional(),
  }),
]);

const body = z
  .union([
    z.object({ type: z.literal("none") }),
    z.object({ type: z.enum(["json", "text", "xml", "sparql"]), content: z.string() }),
    z.object({ type: z.literal("form-urlencoded"), fields: z.array(keyValue) }),
    z.object({ type: z.literal("multipart"), fields: z.array(multipartField) }),
  ])
  .describe("JSON content is text, so it may hold unquoted {{variables}}");

const auth = z
  .union([
    z.object({ type: z.enum(["inherit", "none"]) }),
    z.object({ type: z.literal("bearer"), token: z.string() }),
    z.object({ type: z.literal("basic"), username: z.string(), password: z.string() }),
    z.object({
      type: z.literal("apikey"),
      key: z.string(),
      value: z.string(),
      placement: z.enum(["header", "queryparams"]).optional().describe("Default header"),
    }),
  ])
  .describe("inherit = use the folder's or collection's auth (the default for new requests)");

/** Editable request fields. Every field is optional; on update, an omitted field keeps its current value. */
export const requestFields = {
  method: z.string().optional().describe("HTTP method; new requests default to GET"),
  url: z
    .string()
    .optional()
    .describe("Full URL including the query string, e.g. {{baseUrl}}/users/:id?verbose=true. Query params are taken from it."),
  pathParams: z
    .record(z.string(), z.string())
    .optional()
    .describe("Values for the :name segments of the URL path, e.g. {\"id\": \"42\"}"),
  headers: z.array(keyValue).optional().describe("Replaces all headers"),
  body: body.optional(),
  auth: auth.optional(),
  scripts: z
    .object({ preRequest: z.string().optional(), postResponse: z.string().optional() })
    .optional()
    .describe("JavaScript run before the request is sent / after the response arrives (Bruno's req, res, bru APIs)"),
  vars: z
    .object({
      preRequest: z.array(keyValue).optional(),
      postResponse: z.array(keyValue).optional().describe("value is an expression such as res.body.token"),
    })
    .optional(),
  assertions: z
    .array(keyValue)
    .optional()
    .describe("name is the expression, value the operator and operand, e.g. {name: \"res.status\", value: \"eq 200\"}"),
  tests: z.string().optional().describe("JavaScript tests, e.g. test(\"ok\", () => expect(res.status).to.equal(200))"),
  docs: z.string().optional().describe("Markdown documentation"),
  tags: z.array(z.string()).optional(),
};

const requestFieldsSchema = z.object(requestFields);
export type RequestFields = z.infer<typeof requestFieldsSchema>;
type KeyValue = z.infer<typeof keyValue>;

/** The same item Bruno's "New Request" dialog creates, before the user fills it in. */
export function newHttpItem(name: string, seq: number): BrunoItem {
  return {
    type: "http-request",
    name,
    seq,
    tags: [],
    request: {
      method: "GET",
      url: "",
      params: [],
      headers: [],
      body: { mode: "none", json: null, text: null, xml: null, sparql: null, multipartForm: [], formUrlEncoded: [], file: [] },
      auth: { mode: "inherit" },
      script: {},
      vars: { req: [], res: [] },
      assertions: [],
      tests: "",
      docs: "",
    },
    // The yml writer fills in defaults for missing settings, and its default for
    // forwardAuthorizationHeader is true; Bruno's own default is false.
    settings: { encodeUrl: true, forwardAuthorizationHeader: false },
  };
}

function toBrunoKeyValue({ name, value, enabled }: KeyValue): BrunoKeyValue {
  return { name, value, enabled: enabled ?? true };
}

function fromBrunoKeyValue({ name, value, enabled }: BrunoKeyValue): Required<KeyValue> {
  return { name, value: value ?? "", enabled: enabled !== false };
}

/** Splits at the first `char` outside `{{...}}`, so a variable such as `{{a?b}}` cannot end the URL path. */
function splitOnFirst(text: string, char: string): [string, string | undefined] {
  const masked = text.replace(/\{\{.*?\}\}/g, (match) => "_".repeat(match.length));
  const index = masked.indexOf(char);
  return index === -1 ? [text, undefined] : [text.slice(0, index), text.slice(index + 1)];
}

function pathParamNames(urlWithoutQuery: string): string[] {
  const names = urlWithoutQuery
    .split("/")
    .filter((segment) => segment.startsWith(":") && segment.length > 1)
    .map((segment) => segment.slice(1));
  return [...new Set(names)];
}

/**
 * Bruno sends the query string straight from the URL and keeps a copy in `params` for its table;
 * path params live only in `params`. Disabled query params exist only in the table, so they are kept.
 */
function setUrl(item: BrunoItem, url: string, pathValues: Record<string, string> = {}): void {
  const [withoutQuery, query] = splitOnFirst(url, "?");
  const current = item.request.params ?? [];

  const queryParams: BrunoParam[] = parseQueryParams(query ?? "").map((param) => ({
    name: param.name,
    value: param.value ?? "",
    enabled: true,
    type: "query",
  }));
  const enabledNames = new Set(queryParams.map((param) => param.name));
  const disabledQueryParams = current.filter(
    (param) => param.type === "query" && param.enabled === false && !enabledNames.has(param.name),
  );

  const names = pathParamNames(withoutQuery);
  const unknown = Object.keys(pathValues).filter((name) => !names.includes(name));
  if (unknown.length) throw new Error(`The URL has no path parameter ${unknown.map((name) => `:${name}`).join(", ")}`);
  const pathParams: BrunoParam[] = names.map((name) => ({
    name,
    value: pathValues[name] ?? current.find((param) => param.type === "path" && param.name === name)?.value ?? "",
    enabled: true,
    type: "path",
  }));

  item.request.url = url;
  item.request.params = [...queryParams, ...disabledQueryParams, ...pathParams];
}

function setBody(item: BrunoItem, spec: NonNullable<RequestFields["body"]>): void {
  const target = item.request.body;
  switch (spec.type) {
    case "none":
      target.mode = "none";
      return;
    case "form-urlencoded":
      target.mode = "formUrlEncoded";
      target.formUrlEncoded = spec.fields.map(toBrunoKeyValue);
      return;
    case "multipart":
      target.mode = "multipartForm";
      target.multipartForm = spec.fields.map(
        (field): BrunoMultipartField =>
          field.type === "file"
            ? { name: field.name, value: field.paths, type: "file", enabled: field.enabled ?? true }
            : { name: field.name, value: field.value, type: "text", enabled: field.enabled ?? true },
      );
      return;
    default:
      target.mode = spec.type;
      target[spec.type] = spec.content;
  }
}

function setAuth(item: BrunoItem, spec: NonNullable<RequestFields["auth"]>): void {
  const target = item.request.auth;
  target.mode = spec.type;
  switch (spec.type) {
    case "bearer":
      target.bearer = { token: spec.token };
      return;
    case "basic":
      target.basic = { username: spec.username, password: spec.password };
      return;
    case "apikey":
      target.apikey = { key: spec.key, value: spec.value, placement: spec.placement ?? "header" };
      return;
  }
}

export function applyRequestFields(item: BrunoItem, fields: RequestFields): void {
  const request = item.request;
  if (fields.method !== undefined) request.method = fields.method.toUpperCase();

  // Hand-written files may lack the params table entries for their URL, so path values are
  // matched against the URL rather than the table.
  if (fields.url !== undefined || fields.pathParams !== undefined) setUrl(item, fields.url ?? request.url, fields.pathParams);

  if (fields.headers !== undefined) request.headers = fields.headers.map(toBrunoKeyValue);
  if (fields.body !== undefined) setBody(item, fields.body);
  if (fields.auth !== undefined) setAuth(item, fields.auth);

  if (fields.scripts !== undefined) {
    request.script = { ...request.script };
    if (fields.scripts.preRequest !== undefined) request.script.req = fields.scripts.preRequest;
    if (fields.scripts.postResponse !== undefined) request.script.res = fields.scripts.postResponse;
  }
  if (fields.vars !== undefined) {
    request.vars = { ...request.vars };
    if (fields.vars.preRequest !== undefined) request.vars.req = fields.vars.preRequest.map(toBrunoKeyValue);
    if (fields.vars.postResponse !== undefined) request.vars.res = fields.vars.postResponse.map(toBrunoKeyValue);
  }

  if (fields.assertions !== undefined) request.assertions = fields.assertions.map(toBrunoKeyValue);
  if (fields.tests !== undefined) request.tests = fields.tests;
  if (fields.docs !== undefined) request.docs = fields.docs;
  if (fields.tags !== undefined) item.tags = fields.tags;
}

const TEXT_BODY_MODES = ["json", "text", "xml", "sparql"] as const;

function describeBody(body: BrunoItem["request"]["body"]): unknown {
  const mode = body.mode;
  if (mode === "none") return { type: "none" };
  if ((TEXT_BODY_MODES as readonly string[]).includes(mode)) return { type: mode, content: body[mode] ?? "" };
  if (mode === "formUrlEncoded") {
    return { type: "form-urlencoded", fields: ((body.formUrlEncoded ?? []) as BrunoKeyValue[]).map(fromBrunoKeyValue) };
  }
  if (mode === "multipartForm") {
    const fields = (body.multipartForm ?? []) as BrunoMultipartField[];
    return {
      type: "multipart",
      fields: fields.map(({ name, value, type, enabled }) =>
        type === "file"
          ? { name, type, paths: Array.isArray(value) ? value : [value], enabled: enabled !== false }
          : { name, type: "text", value, enabled: enabled !== false },
      ),
    };
  }
  return { type: mode, editable: false };
}

function describeAuth(auth: BrunoItem["request"]["auth"]): unknown {
  switch (auth.mode) {
    case "inherit":
    case "none":
      return { type: auth.mode };
    case "bearer":
    case "basic":
    case "apikey":
      return { type: auth.mode, ...(auth[auth.mode] as object) };
    default:
      return { type: auth.mode, editable: false };
  }
}

/**
 * A request in the same shape as the tool input, so it can be edited and passed back.
 * Body and auth types this server cannot write are reported with `editable: false`.
 */
export function describeRequest(item: BrunoItem) {
  const request = item.request;
  return {
    name: item.name,
    type: item.type,
    method: request.method,
    url: request.url,
    pathParams: Object.fromEntries(
      (request.params ?? []).filter((param) => param.type === "path").map((param) => [param.name, param.value ?? ""]),
    ),
    headers: (request.headers ?? []).map(fromBrunoKeyValue),
    body: describeBody(request.body),
    auth: describeAuth(request.auth),
    scripts: { preRequest: request.script?.req ?? "", postResponse: request.script?.res ?? "" },
    vars: {
      preRequest: (request.vars?.req ?? []).map(fromBrunoKeyValue),
      postResponse: (request.vars?.res ?? []).map(fromBrunoKeyValue),
    },
    assertions: (request.assertions ?? []).map(fromBrunoKeyValue),
    tests: request.tests ?? "",
    docs: request.docs ?? "",
    tags: item.tags ?? [],
  };
}
