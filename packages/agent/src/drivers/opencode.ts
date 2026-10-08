import { randomBytes } from "node:crypto";
import { createServer } from "node:net";

import { OpencodeApi } from "../opencode-api.ts";
import { writeRecord, type AgentRecord } from "../registry.ts";
import { AmError, poll, sleep, type Driver } from "./types.ts";

// The API answers before the TUI has subscribed to input; keystrokes sent in
// that gap are dropped (and am never resends), so leave the TUI time to subscribe.
const TUI_SETTLE_MS = 3000;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => (typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port"))));
    });
  });
}

function api(record: AgentRecord): OpencodeApi {
  if (!record.url) throw new AmError("no_api", `${record.name} has no recorded opencode server address`);
  return new OpencodeApi(record.url, record.auth);
}

/**
 * The conversation this pane is in: the one its last accepted prompt went to,
 * else whatever this server is running right now. Other opencode instances in
 * the same project share the session list, so "latest" is never a fallback.
 */
async function paneSession(client: OpencodeApi, record: AgentRecord): Promise<string> {
  const session = record.session || Object.keys(await client.status())[0];
  if (!session) throw new AmError("no_session", `not sure yet which session ${record.name} is in (it has not received a task through am prompt)`);
  return session;
}

export const opencode: Driver = {
  kind: "opencode",
  // The server marks the session busy as soon as the TUI submits.
  acceptTimeoutMs: 4000,

  async preflight() {
    return [];
  },

  async launch({ model, args }) {
    const port = await freePort();
    const password = randomBytes(18).toString("base64url");
    return {
      command: ["opencode", "--port", String(port), ...(model ? ["-m", model] : []), ...args],
      // The "Update Available" dialog pops up at a random moment after start and
      // takes keystrokes: an am prompt's Enter would confirm a self-update instead.
      env: { OPENCODE_DISABLE_AUTOUPDATE: "1", OPENCODE_SERVER_PASSWORD: password },
      fields: { url: `http://127.0.0.1:${port}`, auth: password },
    };
  },

  async waitReady(_tmux, reload, deadline) {
    const ready = await poll(async () => {
      const record = await reload();
      if (record.paneDead) throw new AmError("exited", "opencode exited right after starting");
      return (await api(record).ready()) ? true : undefined;
    }, deadline);
    if (!ready) throw new AmError("start_timeout", "opencode's server did not become ready in time");
    await sleep(TUI_SETTLE_MS);
  },

  async status(record) {
    if (record.paneDead) return { state: "exited", detail: "" };
    const client = api(record);
    // `am start` may have given up before the server came up; recover once it answers.
    if (record.state === "starting" && (Date.now() - record.startedAt < TUI_SETTLE_MS * 2 || !(await client.ready()))) {
      return { state: "starting", detail: "" };
    }
    try {
      const [permissions, questions, status] = await Promise.all([client.permissions(), client.questions(), client.status()]);
      if (permissions.length) {
        const p = permissions[0];
        return { state: "blocked", detail: [p.permission, ...(p.patterns ?? [])].join(" ") };
      }
      if (questions.length) return { state: "blocked", detail: "question" };
      if (Object.values(status).some((s) => s.type !== "idle")) return { state: "working", detail: "" };
      return { state: "idle", detail: "" };
    } catch (error) {
      return { state: "unknown", detail: error instanceof Error ? error.message : String(error) };
    }
  },

  async promptMarker(record) {
    // Only signals that belong to this pane: the server's own status (in-memory,
    // per opencode process) and the session this pane is bound to. Other
    // instances in the same project share the session list, so "latest" is no evidence.
    const client = api(record);
    const status = Object.keys(await client.status()).sort().join(",");
    const bound = record.session ? (await client.sessions()).find((s) => s.id === record.session)?.time.updated ?? 0 : 0;
    return `${status}|${bound}`;
  },

  async afterAccepted(tmux, record, marker) {
    // The busy session seen while confirming the prompt is this server's own; bind to it.
    // Without that evidence keep the previous binding rather than guess.
    const busy = marker.split("|")[0].split(",").filter(Boolean)[0];
    if (busy) await writeRecord(tmux, record.paneId, { session: busy });
  },

  async readReply(record) {
    const client = api(record);
    const session = await paneSession(client, record);
    const assistant = (await client.messages(session)).filter((m) => m.info.role === "assistant");
    const last = assistant[assistant.length - 1];
    return (last?.parts ?? [])
      .filter((p) => p.type === "text" && p.text)
      .map((p) => p.text)
      .join("")
      .trim();
  },

  async approve(_tmux, record, scope) {
    const [pending] = await api(record).permissions();
    if (!pending) throw new AmError("not_blocked", `${record.name} has no pending permission request`);
    await api(record).replyPermission(pending.id, scope);
  },

  async deny(_tmux, record) {
    const [pending] = await api(record).permissions();
    if (!pending) throw new AmError("not_blocked", `${record.name} has no pending permission request`);
    await api(record).replyPermission(pending.id, "reject");
  },

  async interrupt(_tmux, record) {
    const client = api(record);
    const busy = Object.entries(await client.status()).filter(([, s]) => s.type !== "idle");
    await Promise.all(busy.map(([id]) => client.abort(id)));
  },
};
