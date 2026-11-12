import { readFileSync } from "node:fs";
import type { ModelAdapter } from "./adapter.js";
import type { AdapterFactory, ContractBehavior } from "./contract.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}.sse`, import.meta.url), "utf8");

/** Stands in for the network: serves a recorded stream, an HTTP failure, or a stream that dies partway. */
export function fakeFetch(behavior: ContractBehavior, prefix: "openai" | "anthropic"): typeof fetch {
  return async () => {
    if (behavior.kind === "fail") {
      const status = { rate_limit: 429, unavailable: 503, auth: 401 }[behavior.error];
      return new Response('{"error":"scripted failure"}', { status });
    }
    const name = behavior.kind === "tool_call" ? "tool-call" : behavior.kind === "cached_text" ? "cached-text" : "text";
    let text = fixture(`${prefix}-${name}`);
    if (behavior.kind === "fail_midstream") text = text.slice(0, text.indexOf("\n\n", text.indexOf("Hel")) + 2);
    const bytes = new TextEncoder().encode(text);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        if (behavior.kind === "fail_midstream") controller.error(new Error("connection dropped"));
        else controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
}

export function httpFactory(
  make: (fetch: typeof globalThis.fetch) => ModelAdapter,
  prefix: "openai" | "anthropic",
): AdapterFactory {
  return (behavior) => make(fakeFetch(behavior, prefix));
}
