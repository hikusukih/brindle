import { describe, expect, it } from "vitest";
import { AnthropicAdapter } from "./anthropic.js";
import { runAdapterContract } from "./contract.js";
import { httpFactory } from "./http-contract.js";

const make = (fetch: typeof globalThis.fetch) =>
  new AnthropicAdapter({ model: "test-model", apiKey: "sk-test-1234abcd1234abcd", fetch });

runAdapterContract("AnthropicAdapter", httpFactory(make, "anthropic"), {
  text: { inputTokens: 12, outputTokens: 3 },
  cachedText: { inputTokens: 12, outputTokens: 3, cachedInputTokens: 8 },
});

describe("AnthropicAdapter request", () => {
  it("lifts the system prompt and groups tool results into one user turn", async () => {
    let seen: RequestInit | undefined;
    const adapter = make(async (_url, init) => {
      seen = init;
      return new Response("", { status: 500 });
    });
    const stream = adapter.stream({
      messages: [
        { role: "system", content: "Be brief." },
        { role: "user", content: "go" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "c1", name: "t", arguments: {} },
            { id: "c2", name: "t", arguments: {} },
          ],
        },
        { role: "tool", toolCallId: "c1", content: "one" },
        { role: "tool", toolCallId: "c2", content: "two" },
      ],
    });
    await stream.next().catch(() => {});

    expect((seen?.headers as Record<string, string> | undefined)?.["x-api-key"]).toBe("sk-test-1234abcd1234abcd");
    const body = JSON.parse(String(seen?.body));
    expect(body.system).toBe("Be brief.");
    expect(body.messages).toHaveLength(3);
    expect(body.messages[2].content.map((b: { tool_use_id: string }) => b.tool_use_id)).toEqual(["c1", "c2"]);
  });
});
