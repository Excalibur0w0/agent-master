// Client for the server built into the opencode TUI (`opencode --port N`),
// i.e. opencode's documented HTTP API, protected by OPENCODE_SERVER_PASSWORD.

export interface OpencodePermission {
  id: string;
  sessionID: string;
  permission: string;
  patterns?: string[];
}

export interface OpencodeSession {
  id: string;
  parentID?: string;
  title?: string;
  time: { created: number; updated: number };
}

export interface OpencodeMessage {
  info: { id: string; role: string; time?: { created?: number } };
  parts: Array<{ type: string; text?: string }>;
}

export class OpencodeApi {
  readonly url: string;
  readonly password: string;
  readonly session: string;
  readonly v2: boolean;

  constructor(url: string, password: string, session = "") {
    this.url = url.replace(/\/$/, "");
    this.password = password;
    this.session = session;
    this.v2 = this.url.endsWith("/api");
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      authorization: `Basic ${Buffer.from(`opencode:${this.password}`).toString("base64")}`,
    };
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${this.url}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) throw new Error(`opencode ${method} ${path}: HTTP ${response.status}`);
    const text = await response.text();
    const result = text ? JSON.parse(text) : undefined;
    return (this.v2 && result ? result.data : result) as T;
  }

  async ready(): Promise<boolean> {
    try {
      await this.status();
      return true;
    } catch {
      return false;
    }
  }

  /** Sessions that are not idle, keyed by id (`busy`, `retry`, ...). */
  async status(): Promise<Record<string, { type: string }>> {
    const states = await this.request<Record<string, { type: string }>>("GET", this.v2 ? "/session/active" : "/session/status");
    if (this.v2 && this.session) return states[this.session] ? { [this.session]: states[this.session] } : {};
    return states;
  }

  async permissions(): Promise<OpencodePermission[]> {
    if (this.v2) {
      const entries = await this.request<Array<{ id: string; sessionID: string; action: string; resources: string[] }>>("GET", `/session/${this.session}/permission`);
      return entries.map((p) => ({ id: p.id, sessionID: p.sessionID, permission: p.action, patterns: p.resources }));
    }
    return this.request("GET", "/permission");
  }

  questions(): Promise<Array<{ id: string; sessionID: string }>> {
    return this.request("GET", this.v2 ? `/session/${this.session}/form` : "/question");
  }

  sessions(): Promise<OpencodeSession[]> {
    return this.request("GET", "/session");
  }

  async messages(sessionID: string): Promise<OpencodeMessage[]> {
    if (this.v2) {
      const entries = await this.request<Array<{ id: string; type: string; content: OpencodeMessage["parts"] }>>("GET", `/session/${sessionID}/message?order=desc&limit=1&type=assistant`);
      return entries.map((m) => ({ info: { id: m.id, role: m.type }, parts: m.content }));
    }
    return this.request("GET", `/session/${sessionID}/message`);
  }

  async promptID(): Promise<string> {
    const entries = await this.request<Array<{ id: string }>>("GET", `/session/${this.session}/message?order=desc&limit=1&type=user`);
    return entries[0]?.id ?? "";
  }

  createSession(cwd: string, model?: string): Promise<OpencodeSession> {
    const slash = model?.indexOf("/") ?? -1;
    if (model && slash < 1) throw new Error("opencode model must use provider/model format");
    const [id, variant] = (model?.slice(slash + 1) ?? "").split("#");
    return this.request("POST", "/session", {
      location: { directory: cwd },
      ...(model ? { model: { providerID: model.slice(0, slash), id, ...(variant ? { variant } : {}) } } : {}),
    });
  }

  replyPermission(id: string, reply: "once" | "always" | "reject"): Promise<unknown> {
    return this.v2
      ? this.request("POST", `/session/${this.session}/permission/${id}/reply`, { decision: reply })
      : this.request("POST", `/permission/${id}/reply`, { reply });
  }

  abort(sessionID: string): Promise<unknown> {
    return this.request("POST", `/session/${sessionID}/${this.v2 ? "interrupt" : "abort"}`);
  }
}
