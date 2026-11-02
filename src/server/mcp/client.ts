import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export type McpToolInfo = { name: string; description: string; inputSchema: Record<string, unknown> };

export type McpServerSpec = {
  command: string;
  args?: string[];
  /** Names of environment variables to pass on; the child gets nothing else of ours except PATH and HOME. */
  env?: string[];
};

const protocolVersion = "2025-06-18";
const requestTimeoutMs = 30_000;

/** A minimal MCP client over stdio: newline-delimited JSON-RPC, tools only. */
export class McpClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();

  constructor(
    readonly name: string,
    private readonly spec: McpServerSpec,
    private readonly parentEnv: Record<string, string | undefined> = process.env,
  ) {}

  async connect(): Promise<void> {
    const env: Record<string, string> = {};
    for (const key of ["PATH", "HOME", ...(this.spec.env ?? [])]) {
      const value = this.parentEnv[key];
      if (value !== undefined) env[key] = value;
    }
    const child = spawn(this.spec.command, this.spec.args ?? [], { env, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    child.stderr.resume();
    const failAll = (error: Error) => {
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(error);
        this.pending.delete(id);
      }
    };
    child.on("error", (err) => failAll(new Error(`MCP server "${this.name}" could not start: ${err.message}`)));
    child.on("exit", () => failAll(new Error(`MCP server "${this.name}" exited.`)));
    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));

    await this.request("initialize", {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: "brindle", version: "0.0.0" },
    });
    this.notify("notifications/initialized");
  }

  private onLine(line: string) {
    let msg: { id?: unknown; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    // Server-initiated requests (sampling, roots) are not supported: they have a method and no pending id of ours.
    if (typeof msg.id !== "number") return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(String(msg.error.message ?? "MCP error").slice(0, 300)));
    else p.resolve(msg.result);
  }

  private send(message: object) {
    this.child?.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private notify(method: string) {
    this.send({ jsonrpc: "2.0", method });
  }

  private request(method: string, params: object, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP server "${this.name}" did not answer ${method} in time.`));
      }, requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      signal?.addEventListener(
        "abort",
        () => {
          if (!this.pending.delete(id)) return;
          clearTimeout(timer);
          this.notify("notifications/cancelled");
          reject(signal.reason);
        },
        { once: true },
      );
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async listTools(): Promise<McpToolInfo[]> {
    const tools: McpToolInfo[] = [];
    let cursor: string | undefined;
    do {
      const page = (await this.request("tools/list", cursor ? { cursor } : {})) as {
        tools?: { name?: unknown; description?: unknown; inputSchema?: unknown }[];
        nextCursor?: string;
      };
      for (const t of page.tools ?? []) {
        if (typeof t.name !== "string") continue;
        tools.push({
          name: t.name,
          description: typeof t.description === "string" ? t.description : t.name,
          inputSchema:
            t.inputSchema && typeof t.inputSchema === "object"
              ? (t.inputSchema as Record<string, unknown>)
              : { type: "object", properties: {} },
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return tools;
  }

  /** Text content comes back as the result; a tool-reported error is thrown so the run records it as one. */
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const res = (await this.request("tools/call", { name, arguments: args }, signal)) as {
      content?: { type?: string; text?: string }[];
      isError?: boolean;
    };
    const text = (res.content ?? [])
      .map((c) => (c.type === "text" ? String(c.text ?? "") : `[${c.type ?? "unknown"} content not shown]`))
      .join("\n");
    if (res.isError) throw new Error(text || "The tool reported an error.");
    return text;
  }

  close() {
    this.child?.kill();
  }
}
