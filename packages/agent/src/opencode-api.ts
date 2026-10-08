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

  constructor(url: string, password: string) {
    this.url = url.replace(/\/$/, "");
    this.password = password;
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
    return (text ? JSON.parse(text) : undefined) as T;
  }

  async ready(): Promise<boolean> {
    try {
      await this.request("GET", "/session/status");
      return true;
    } catch {
      return false;
    }
  }

  /** Sessions that are not idle, keyed by id (`busy`, `retry`, ...). */
  status(): Promise<Record<string, { type: string }>> {
    return this.request("GET", "/session/status");
  }

  permissions(): Promise<OpencodePermission[]> {
    return this.request("GET", "/permission");
  }

  questions(): Promise<Array<{ id: string; sessionID: string }>> {
    return this.request("GET", "/question");
  }

  sessions(): Promise<OpencodeSession[]> {
    return this.request("GET", "/session");
  }

  messages(sessionID: string): Promise<OpencodeMessage[]> {
    return this.request("GET", `/session/${sessionID}/message`);
  }

  replyPermission(id: string, reply: "once" | "always" | "reject"): Promise<unknown> {
    return this.request("POST", `/permission/${id}/reply`, { reply });
  }

  abort(sessionID: string): Promise<unknown> {
    return this.request("POST", `/session/${sessionID}/abort`);
  }
}
