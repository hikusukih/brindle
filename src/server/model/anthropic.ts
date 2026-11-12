import type { Message, ModelAdapter, ModelEvent, ModelRequest, StopReason, Usage } from "./adapter.js";
import { ModelError } from "./adapter.js";
import { httpError, networkError, parseJson, readSse } from "./sse.js";

export type AnthropicOptions = {
  model: string;
  apiKey: string;
  baseUrl?: string;
  maxTokens?: number;
  fetch?: typeof fetch;
};

type Block = { type: string; [key: string]: unknown };

// The Messages API takes the system prompt separately, and wants consecutive tool results in one user turn.
function toWire(messages: Message[]) {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const wire: { role: "user" | "assistant"; content: Block[] }[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    let role: "user" | "assistant" = "user";
    let content: Block[];
    if (m.role === "assistant") {
      role = "assistant";
      content = [
        ...(m.content ? [{ type: "text", text: m.content }] : []),
        ...(m.toolCalls ?? []).map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.arguments })),
      ];
    } else if (m.role === "tool") {
      content = [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }];
    } else {
      content = [{ type: "text", text: m.content }];
    }
    const last = wire.at(-1);
    if (last && last.role === role) last.content.push(...content);
    else wire.push({ role, content });
  }
  return { system, messages: wire };
}

function stopReason(reason: string | null | undefined): StopReason {
  if (reason === "tool_use") return "tool_use";
  if (reason === "max_tokens") return "length";
  return "end";
}

/** The Anthropic Messages API with streaming and tool use. */
export class AnthropicAdapter implements ModelAdapter {
  constructor(private readonly options: AnthropicOptions) {}

  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    const {
      model,
      apiKey,
      baseUrl = "https://api.anthropic.com",
      maxTokens = 4096,
      fetch: doFetch = fetch,
    } = this.options;
    const { signal } = request;
    if (signal?.aborted) throw new ModelError("aborted", "The request was aborted.");

    const { system, messages } = toWire(request.messages);
    let response: Response;
    try {
      response = await doFetch(`${baseUrl.replace(/\/$/, "")}/v1/messages`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          stream: true,
          ...(system && { system }),
          messages,
          ...(request.tools?.length && {
            tools: request.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
          }),
        }),
        signal,
      });
    } catch (error) {
      throw networkError(error, signal);
    }
    if (!response.ok) throw httpError(response.status, await response.text().catch(() => ""));
    if (!response.body) throw new ModelError("unavailable", "The model API sent no body.");

    const tools = new Map<number, { id: string; name: string; json: string }>();
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let stop: string | null | undefined;
    let finished = false;

    try {
      for await (const { data } of readSse(response.body, signal)) {
        const ev = parseJson(data) as {
          type: string;
          index?: number;
          message?: {
            usage?: {
              input_tokens?: number;
              output_tokens?: number;
              cache_creation_input_tokens?: number;
              cache_read_input_tokens?: number;
            };
          };
          content_block?: { type: string; id?: string; name?: string };
          delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
          usage?: { output_tokens?: number };
          error?: { type?: string; message?: string };
        };
        if (ev.type === "message_start") {
          const u = ev.message?.usage;
          // Anthropic's input_tokens leaves out cache writes and reads; Usage counts every input token.
          const created = u?.cache_creation_input_tokens ?? 0;
          const read = u?.cache_read_input_tokens;
          usage.inputTokens = (u?.input_tokens ?? 0) + created + (read ?? 0);
          usage.outputTokens = u?.output_tokens ?? 0;
          if (typeof read === "number") usage.cachedInputTokens = read;
        } else if (ev.type === "content_block_start" && ev.content_block?.type === "tool_use") {
          tools.set(ev.index ?? 0, { id: ev.content_block.id ?? "", name: ev.content_block.name ?? "", json: "" });
        } else if (ev.type === "content_block_delta") {
          if (ev.delta?.type === "text_delta" && ev.delta.text) yield { type: "text", text: ev.delta.text };
          if (ev.delta?.type === "input_json_delta") {
            const tool = tools.get(ev.index ?? 0);
            if (tool) tool.json += ev.delta.partial_json ?? "";
          }
        } else if (ev.type === "message_delta") {
          stop = ev.delta?.stop_reason ?? stop;
          if (ev.usage?.output_tokens !== undefined) usage.outputTokens = ev.usage.output_tokens;
        } else if (ev.type === "message_stop") {
          finished = true;
          break;
        } else if (ev.type === "error") {
          const kind =
            ev.error?.type === "overloaded_error"
              ? "unavailable"
              : ev.error?.type === "rate_limit_error"
                ? "rate_limit"
                : "unavailable";
          throw new ModelError(kind, ev.error?.message ?? "The model API reported an error.");
        }
      }
    } catch (error) {
      throw networkError(error, signal);
    }
    if (!finished) throw new ModelError("unavailable", "The model stream ended before it finished.");

    for (const [, tool] of [...tools].sort((a, b) => a[0] - b[0])) {
      let input: unknown = {};
      if (tool.json.trim()) {
        try {
          input = JSON.parse(tool.json);
        } catch {
          throw new ModelError("unavailable", `The model sent unparseable arguments for ${tool.name}.`);
        }
      }
      yield { type: "tool_call", call: { id: tool.id, name: tool.name, arguments: input as Record<string, unknown> } };
    }
    yield { type: "done", stop: tools.size ? "tool_use" : stopReason(stop), usage };
  }
}
