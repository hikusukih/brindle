import type { Message, ModelAdapter, ModelEvent, ModelRequest, StopReason, Usage } from "./adapter.js";
import { ModelError } from "./adapter.js";
import { httpError, networkError, parseJson, readSse } from "./sse.js";

export type OpenAiOptions = {
  /** Base URL up to and including the version path, such as `https://api.example.com/v1`. */
  baseUrl: string;
  model: string;
  apiKey?: string;
  fetch?: typeof fetch;
};

type Chunk = {
  choices?: {
    delta?: {
      content?: string | null;
      tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[];
    };
    finish_reason?: string | null;
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number } | null;
  } | null;
  /** llama.cpp's own report on its last chunk; cache_n is the prompt tokens it reused from the slot's cache. */
  timings?: { cache_n?: number } | null;
};

function toWire(messages: Message[]) {
  return messages.map((m) => {
    if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
    if (m.role === "assistant") {
      return {
        role: "assistant",
        content: m.content || null,
        ...(m.toolCalls?.length && {
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id,
            type: "function",
            function: { name: c.name, arguments: JSON.stringify(c.arguments) },
          })),
        }),
      };
    }
    return { role: m.role, content: m.content };
  });
}

function stopReason(finish: string | null | undefined): StopReason {
  if (finish === "tool_calls") return "tool_use";
  if (finish === "length") return "length";
  return "end";
}

/** OpenAI-compatible chat completions; also covers local servers that speak the same protocol. */
export class OpenAiAdapter implements ModelAdapter {
  constructor(private readonly options: OpenAiOptions) {}

  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    const { baseUrl, model, apiKey, fetch: doFetch = fetch } = this.options;
    const { signal } = request;
    if (signal?.aborted) throw new ModelError("aborted", "The request was aborted.");

    let response: Response;
    try {
      response = await doFetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(apiKey && { authorization: `Bearer ${apiKey}` }) },
        body: JSON.stringify({
          model,
          stream: true,
          stream_options: { include_usage: true },
          messages: toWire(request.messages),
          ...(request.tools?.length && {
            tools: request.tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }),
        }),
        signal,
      });
    } catch (error) {
      throw networkError(error, signal);
    }
    if (!response.ok) throw httpError(response.status, await response.text().catch(() => ""));
    if (!response.body) throw new ModelError("unavailable", "The model API sent no body.");

    // Tool calls arrive as fragments keyed by index; arguments are only valid JSON once complete.
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let finish: string | null | undefined;
    let usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let cacheN: number | undefined;
    let sawDone = false;

    try {
      for await (const message of readSse(response.body, signal)) {
        if (message.data === "[DONE]") {
          sawDone = true;
          break;
        }
        const chunk = parseJson(message.data) as Chunk;
        if (chunk.usage) {
          usage = { inputTokens: chunk.usage.prompt_tokens ?? 0, outputTokens: chunk.usage.completion_tokens ?? 0 };
          const cached = chunk.usage.prompt_tokens_details?.cached_tokens;
          if (typeof cached === "number") usage.cachedInputTokens = cached;
        }
        if (typeof chunk.timings?.cache_n === "number") cacheN = chunk.timings.cache_n;
        const choice = chunk.choices?.[0];
        if (!choice) continue;
        if (choice.delta?.content) yield { type: "text", text: choice.delta.content };
        for (const part of choice.delta?.tool_calls ?? []) {
          const entry = pending.get(part.index) ?? { id: "", name: "", args: "" };
          if (part.id) entry.id = part.id;
          if (part.function?.name) entry.name += part.function.name;
          if (part.function?.arguments) entry.args += part.function.arguments;
          pending.set(part.index, entry);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    } catch (error) {
      throw networkError(error, signal);
    }
    if (!sawDone && finish === undefined) {
      throw new ModelError("unavailable", "The model stream ended before it finished.");
    }

    for (const [, entry] of [...pending].sort((a, b) => a[0] - b[0])) {
      let args: unknown = {};
      if (entry.args.trim()) {
        try {
          args = JSON.parse(entry.args);
        } catch {
          throw new ModelError("unavailable", `The model sent unparseable arguments for ${entry.name}.`);
        }
      }
      yield { type: "tool_call", call: { id: entry.id, name: entry.name, arguments: args as Record<string, unknown> } };
    }
    // Older llama.cpp builds give the cache count only in their timings.
    if (usage.cachedInputTokens === undefined && cacheN !== undefined) usage.cachedInputTokens = cacheN;
    yield { type: "done", stop: pending.size ? "tool_use" : stopReason(finish), usage };
  }
}
