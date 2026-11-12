import { describe, expect, it } from "vitest";
import { runAdapterContract } from "./contract.js";
import { httpFactory } from "./http-contract.js";
import { OpenAiAdapter } from "./openai.js";

const make = (fetch: typeof globalThis.fetch) =>
  new OpenAiAdapter({
    baseUrl: "https://llm.example.com/v1",
    model: "test-model",
    apiKey: "sk-test-1234abcd1234abcd",
    fetch,
  });

runAdapterContract("OpenAiAdapter", httpFactory(make, "openai"), {
  text: { inputTokens: 12, outputTokens: 3 },
  cachedText: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 8 },
});

describe("OpenAiAdapter request", () => {
  it("sends the key, tools and prior tool results in the wire format", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const adapter = make(async (url, init) => {
      seen = { url: String(url), init: init as RequestInit };
      return new Response("data: [DONE]\n\n", { status: 200 });
    });
    const stream = adapter.stream({
      messages: [
        { role: "user", content: "go" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "t", arguments: { a: 1 } }] },
        { role: "tool", toolCallId: "c1", content: "ok" },
      ],
      tools: [{ name: "t", description: "d", parameters: { type: "object" } }],
    });
    await stream.next().catch(() => {});

    expect(seen?.url).toBe("https://llm.example.com/v1/chat/completions");
    expect((seen?.init.headers as Record<string, string> | undefined)?.authorization).toBe(
      "Bearer sk-test-1234abcd1234abcd",
    );
    const body = JSON.parse(String(seen?.init.body));
    expect(body.tools[0].function.name).toBe("t");
    expect(body.messages[1].tool_calls[0].function.arguments).toBe('{"a":1}');
    expect(body.messages[2]).toEqual({ role: "tool", tool_call_id: "c1", content: "ok" });
  });
});

describe("OpenAiAdapter cached input", () => {
  const sse = (lines: string[]) => async () =>
    new Response(lines.map((l) => `data: ${l}\n\n`).join(""), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  const usageOf = async (fetch: typeof globalThis.fetch) => {
    for await (const e of make(fetch).stream({ messages: [{ role: "user", content: "hi" }] }))
      if (e.type === "done") return e.usage;
  };

  it("takes llama.cpp's timings.cache_n when the usage report has no cached count", async () => {
    const usage = await usageOf(
      sse([
        '{"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"timings":{"cache_n":40,"prompt_n":10}}',
        '{"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":1}}',
        "[DONE]",
      ]),
    );
    expect(usage).toEqual({ inputTokens: 50, outputTokens: 1, cachedInputTokens: 40 });
  });

  it("prefers the usage report's cached_tokens over the timings", async () => {
    const usage = await usageOf(
      sse([
        '{"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}],"timings":{"cache_n":40}}',
        '{"choices":[],"usage":{"prompt_tokens":50,"completion_tokens":1,"prompt_tokens_details":{"cached_tokens":30}}}',
        "[DONE]",
      ]),
    );
    expect(usage?.cachedInputTokens).toBe(30);
  });
});
