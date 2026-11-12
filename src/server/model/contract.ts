import { describe, expect, it } from "vitest";
import {
  type ModelAdapter,
  ModelError,
  type ModelEvent,
  type ModelRequest,
  type ToolCall,
  type Usage,
} from "./adapter.js";

// What the suite needs an adapter to do. A real adapter builds these from recorded
// fixtures so CI needs no key; the scripted model builds them from a script.
export type ContractBehavior =
  | { kind: "text"; chunks: string[] }
  // The same reply from a server that says how much of the prompt it served from its cache.
  | { kind: "cached_text"; chunks: string[] }
  | { kind: "tool_call"; call: ToolCall }
  | { kind: "fail"; error: "rate_limit" | "unavailable" | "auth" }
  | { kind: "fail_midstream"; chunks: string[] };

export type AdapterFactory = (behavior: ContractBehavior) => ModelAdapter;

/**
 * The usage an adapter's fixtures should come out as: `text` from a server that reports no cached count (so the field
 * is left empty), `cachedText` from one that does. The run token limit relies on the difference (docs/decisions.md).
 */
export type ExpectedUsage = { text: Usage; cachedText: Usage };

const request: ModelRequest = {
  messages: [{ role: "user", content: "Say hello." }],
  tools: [
    {
      name: "web_fetch",
      description: "Fetch a page.",
      parameters: { type: "object", properties: { url: { type: "string" } } },
    },
  ],
};

async function collect(stream: AsyncIterable<ModelEvent>): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of stream) events.push(event);
  return events;
}

async function collectError(stream: AsyncIterable<ModelEvent>): Promise<unknown> {
  try {
    await collect(stream);
  } catch (error) {
    return error;
  }
  return undefined;
}

/** Every adapter must pass this. Call it from the adapter's own test file. */
export function runAdapterContract(name: string, make: AdapterFactory, usage: ExpectedUsage) {
  describe(`model adapter contract: ${name}`, () => {
    it("streams text in order and ends with exactly one done event", async () => {
      const events = await collect(make({ kind: "text", chunks: ["Hel", "lo."] }).stream(request));

      const text = events.flatMap((e) => (e.type === "text" ? [e.text] : []));
      expect(text.join("")).toBe("Hello.");
      expect(events.filter((e) => e.type === "done")).toHaveLength(1);
      const last = events.at(-1);
      expect(last).toMatchObject({ type: "done", stop: "end" });
    });

    it("reports a tool call with parsed arguments and stops for tool use", async () => {
      const call: ToolCall = {
        id: "call-1",
        name: "web_fetch",
        arguments: { url: "https://example.com/" },
      };
      const events = await collect(make({ kind: "tool_call", call }).stream(request));

      expect(events.filter((e) => e.type === "tool_call")).toEqual([{ type: "tool_call", call }]);
      expect(events.at(-1)).toMatchObject({ type: "done", stop: "tool_use" });
    });

    it("reports token usage on done", async () => {
      const events = await collect(make({ kind: "text", chunks: ["Hi."] }).stream(request));

      const done = events.at(-1);
      expect(done?.type).toBe("done");
      if (done?.type === "done") {
        expect(done.usage.inputTokens).toBeGreaterThanOrEqual(0);
        expect(done.usage.outputTokens).toBeGreaterThanOrEqual(0);
        expect(done.usage).toEqual(usage.text);
        expect(done.usage.cachedInputTokens).toBeUndefined();
      }
    });

    it("reports the cached part of the input when the server gives one", async () => {
      const events = await collect(make({ kind: "cached_text", chunks: ["Hi."] }).stream(request));

      const done = events.at(-1);
      expect(done?.type).toBe("done");
      if (done?.type === "done") {
        expect(done.usage).toEqual(usage.cachedText);
        expect(done.usage.cachedInputTokens).toBeGreaterThanOrEqual(0);
        expect(done.usage.cachedInputTokens).toBeLessThanOrEqual(done.usage.inputTokens);
      }
    });

    it.each([
      ["rate_limit", true],
      ["unavailable", true],
      ["auth", false],
    ] as const)("fails with a ModelError of kind %s (retryable: %s)", async (error, retryable) => {
      const thrown = await collectError(make({ kind: "fail", error }).stream(request));

      expect(thrown).toBeInstanceOf(ModelError);
      expect(thrown).toMatchObject({ kind: error, retryable });
    });

    it("throws after partial output rather than ending with a done event", async () => {
      const events: ModelEvent[] = [];
      let thrown: unknown;
      try {
        for await (const e of make({ kind: "fail_midstream", chunks: ["Par"] }).stream(request)) {
          events.push(e);
        }
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(ModelError);
      expect(events.some((e) => e.type === "done")).toBe(false);
    });

    it("ends with an aborted ModelError when the signal is already aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      const adapter = make({ kind: "text", chunks: ["never seen"] });

      const thrown = await collectError(adapter.stream({ ...request, signal: controller.signal }));

      expect(thrown).toMatchObject({ kind: "aborted" });
    });
  });
}
