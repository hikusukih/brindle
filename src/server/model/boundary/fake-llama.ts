import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

type WireMessage = { role: string; content?: string | null; tool_calls?: unknown; tool_call_id?: string };
type WireBody = { messages?: WireMessage[]; tools?: unknown[]; stream?: boolean };

export type FakeLlamaOptions = {
  /** Tokens one slot can hold; the server's `/props` says so and a longer prompt is refused. */
  nCtx: number;
};

export type Seen = {
  promptTokens: number;
  /** Tokens shared with the previous prompt, counted from the start: what llama.cpp's prompt cache would reuse. */
  cachedTokens: number;
  completionTokens: number;
  refused: boolean;
};

/** One token per word, plus a token for each message's role and for each tool definition's text, so counts are exact and checkable. */
export function tokenize(body: WireBody): string[] {
  const tokens: string[] = [];
  for (const m of body.messages ?? []) {
    tokens.push(`<${m.role}>`);
    if (m.content) tokens.push(...m.content.split(/\s+/).filter(Boolean));
    if (m.tool_calls) tokens.push(...JSON.stringify(m.tool_calls).split(/\s+/));
  }
  if (body.tools?.length) tokens.push(...JSON.stringify(body.tools).split(/\s+/));
  return tokens;
}

/**
 * Stands in for llama.cpp's server in CI: chat completions as a stream, `/props`, a refusal of a prompt over its window
 * in llama.cpp's words, cached tokens as the longest shared prefix with the previous prompt, and a stall switch.
 * Replies are scripted by the last user message: "call the tool" streams a tool call in fragments; anything else is echoed.
 */
export class FakeLlamaServer {
  readonly seen: Seen[] = [];
  /** "first": accept the request and never answer. "mid": send some text, then stop. */
  stall: "first" | "mid" | null = null;
  private previous: string[] = [];
  private server: Server | undefined;
  private open = new Set<ServerResponse>();

  constructor(readonly options: FakeLlamaOptions) {}

  async start(): Promise<string> {
    const server = createServer((req, res) => void this.handle(req, res));
    this.server = server;
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    return `http://127.0.0.1:${port}`;
  }

  async stop(): Promise<void> {
    for (const res of this.open) res.destroy();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse) {
    if (req.method === "GET" && req.url === "/props") {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ default_generation_settings: { n_ctx: this.options.nCtx } }));
      return;
    }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.statusCode = 404;
      res.end("{}");
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw) as WireBody;
    const prompt = tokenize(body);
    if (prompt.length > this.options.nCtx) {
      this.seen.push({ promptTokens: prompt.length, cachedTokens: 0, completionTokens: 0, refused: true });
      res.statusCode = 400;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          error: {
            code: 400,
            message: "the request exceeds the available context size, try increasing it",
            type: "exceed_context_size_error",
            n_prompt_tokens: prompt.length,
            n_ctx: this.options.nCtx,
          },
        }),
      );
      return;
    }
    let cached = 0;
    while (cached < prompt.length && cached < this.previous.length && prompt[cached] === this.previous[cached])
      cached++;
    this.previous = prompt;

    res.statusCode = 200;
    res.setHeader("content-type", "text/event-stream");
    this.open.add(res);
    res.on("close", () => this.open.delete(res));
    const send = (data: unknown) => res.write(`data: ${typeof data === "string" ? data : JSON.stringify(data)}\n\n`);
    if (this.stall === "first") {
      this.seen.push({ promptTokens: prompt.length, cachedTokens: cached, completionTokens: 0, refused: false });
      return;
    }
    const last = body.messages?.[body.messages.length - 1];
    const wantsTool = last?.role === "user" && /call the tool/i.test(last.content ?? "") && !!body.tools?.length;
    let completion = 0;
    if (wantsTool) {
      const name = (body.tools?.[0] as { function?: { name?: string } })?.function?.name ?? "tool";
      const fragments = ['{"que', 'ry": "ze', 'bra"}'];
      send({
        choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name, arguments: "" } }] } }],
      });
      for (const f of fragments)
        send({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: f } }] } }] });
      send({ choices: [{ delta: {}, finish_reason: "tool_calls" }] });
      completion = fragments.length + 1;
    } else {
      const reply =
        last?.role === "tool"
          ? "The tool said done."
          : `Echo: ${(last?.content ?? "").split(/\s+/).slice(0, 8).join(" ")}`;
      const words = reply.split(" ");
      for (const [i, w] of words.entries()) {
        send({ choices: [{ delta: { content: `${i ? " " : ""}${w}` } }] });
        if (this.stall === "mid" && i === 0) {
          this.seen.push({ promptTokens: prompt.length, cachedTokens: cached, completionTokens: 1, refused: false });
          return;
        }
      }
      send({ choices: [{ delta: {}, finish_reason: "stop" }] });
      completion = words.length;
    }
    send({
      choices: [],
      usage: {
        prompt_tokens: prompt.length,
        completion_tokens: completion,
        prompt_tokens_details: { cached_tokens: cached },
      },
    });
    send("[DONE]");
    res.end();
    this.seen.push({ promptTokens: prompt.length, cachedTokens: cached, completionTokens: completion, refused: false });
  }
}
