import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createChannel } from "../../channels.js";
import { modelSummarizer } from "../../compaction.js";
import { runContext } from "../../context.js";
import { openDatabase } from "../../db/index.js";
import { defaultLimits, RunEngine } from "../../runs.js";
import { ModelError, type ModelEvent } from "../adapter.js";
import { OpenAiAdapter } from "../openai.js";
import { applyServerWindows, ModelSettingsError, ModelSettingsStore, serverContextWindow } from "../settings.js";
import { FakeLlamaServer } from "./fake-llama.js";

/**
 * The model boundary: the same cases against any OpenAI-compatible server named by BRINDLE_BOUNDARY_URL (the base URL up
 * to and including /v1), or against the fake llama.cpp server in this folder, which is the default so CI runs them on
 * every PR. Cases that need the fake's controls (a stall, exact token counts) are skipped against a real server.
 * Against a real server the suite also prints a report of read speed, reply speed and cache reuse per case.
 */
const realUrl = process.env.BRINDLE_BOUNDARY_URL;
const fake = realUrl ? undefined : new FakeLlamaServer({ nCtx: 8_000 });
let baseUrl = realUrl ?? "";
let nCtx = 0;
const report: string[] = [];

const adapter = () => new OpenAiAdapter({ baseUrl, model: "boundary" });
const onlyFake = fake ? it : it.skip;

async function collect(stream: AsyncIterable<ModelEvent>) {
  const events: ModelEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

/** A run engine over the adapter whose window is `window`, as if the user had configured that number. */
function engineFor(window: number, extra: Partial<typeof defaultLimits> = {}) {
  const db = openDatabase(":memory:");
  const engine = new RunEngine(db, adapter(), { ...defaultLimits, contextWindow: window, ...extra });
  return { db, engine, channel: createChannel(db, "Boundary") };
}

beforeAll(async () => {
  if (fake) baseUrl = `${await fake.start()}/v1`;
  const window = await serverContextWindow(baseUrl);
  if (!window) throw new Error(`The server at ${baseUrl} did not report a context size at /props.`);
  nCtx = window;
});

afterAll(async () => {
  await fake?.stop();
  if (realUrl) console.log(`Boundary report for ${realUrl}\n${report.join("\n")}`);
});

describe("model boundary", () => {
  it("reads the window from the server, and refuses a configured one that is larger", async () => {
    const store = new ModelSettingsStore({ "openai:boundary": { contextWindow: nCtx } });
    await applyServerWindows(store, ["openai:boundary"], baseUrl);
    expect(store.forSpec("openai:boundary").contextWindow).toBe(nCtx);
    const tooBig = new ModelSettingsStore({ "openai:boundary": { contextWindow: nCtx + 1 } });
    await expect(applyServerWindows(tooBig, ["openai:boundary"], baseUrl)).rejects.toBeInstanceOf(ModelSettingsError);
  });

  it("never sends a request it estimates is over the window", async () => {
    // Words of one letter cost about half a token each by the estimate, so this is well over a window of nCtx.
    const { engine, channel } = engineFor(nCtx);
    const run = engine.start(channel.id, "a ".repeat(nCtx * 4));
    await engine.whenSettled(run.id);
    expect(engine.get(run.id).status).toBe("stopped");
    expect(fake?.seen ?? []).toHaveLength(0);
  });

  it("turns the server's length rejection into its own error when the configured window was too generous", async () => {
    // The estimate (half a token a word) says this fits a huge window; the server counts a token a word and refuses.
    const { engine, channel } = engineFor(nCtx * 100);
    const run = engine.start(channel.id, "a ".repeat(nCtx * 3));
    await engine.whenSettled(run.id);
    const done = engine.get(run.id);
    expect(done.status).toBe("failed");
    expect(done.stopReason).toMatch(/too long for the model/);
    expect(done.stopReason).not.toMatch(/exceed_context_size/);
    expect(fake?.seen.at(-1)?.refused ?? true).toBe(true);
  });

  it("reports the server's own token counts", async () => {
    const started = Date.now();
    let firstText: number | undefined;
    const events: ModelEvent[] = [];
    for await (const e of adapter().stream({ messages: [{ role: "user", content: "one two three four five six" }] })) {
      if (e.type === "text") firstText ??= Date.now();
      events.push(e);
    }
    const done = events.at(-1);
    expect(done?.type).toBe("done");
    if (done?.type !== "done") return;
    expect(done.usage.inputTokens).toBeGreaterThan(0);
    expect(done.usage.outputTokens).toBeGreaterThan(0);
    // The fake counts a token a word plus one per message, so its number is exact; a real tokenizer's is only positive.
    if (fake) expect(done.usage.inputTokens).toBe(fake.seen.at(-1)?.promptTokens);
    const total = Date.now() - started;
    const wait = (firstText ?? started + total) - started;
    report.push(
      `token counts: read ${Math.round((done.usage.inputTokens / Math.max(wait, 1)) * 1000)} tokens/s, reply ${Math.round((done.usage.outputTokens / Math.max(total - wait, 1)) * 1000)} tokens/s`,
    );
  });

  it("round-trips a streamed tool call", async () => {
    const tools = [
      {
        name: "lookup",
        description: "Look something up.",
        parameters: { type: "object", properties: { query: { type: "string" } } },
      },
    ];
    const first = await collect(
      adapter().stream({ messages: [{ role: "user", content: "Please call the tool for zebra." }], tools }),
    );
    const call = first.find((e) => e.type === "tool_call");
    expect(call?.type === "tool_call" && call.call.name).toBe("lookup");
    expect(call?.type === "tool_call" && call.call.arguments).toEqual({ query: "zebra" });
    expect(first.at(-1)).toMatchObject({ type: "done", stop: "tool_use" });
    if (call?.type !== "tool_call") return;
    const second = await collect(
      adapter().stream({
        messages: [
          { role: "user", content: "Please call the tool for zebra." },
          { role: "assistant", content: "", toolCalls: [call.call] },
          { role: "tool", toolCallId: call.call.id, content: "Zebras are striped." },
        ],
        tools,
      }),
    );
    expect(second.some((e) => e.type === "text")).toBe(true);
    expect(second.at(-1)).toMatchObject({ type: "done", stop: "end" });
  });

  it("sends a follow-up that extends the previous request, which the server reads from its cache", async () => {
    const { db, engine, channel } = engineFor(nCtx);
    const first = engine.start(channel.id, "first question about zebras");
    await engine.whenSettled(first.id);
    const second = engine.start(channel.id, "second question about stripes");
    await engine.whenSettled(second.id);
    expect(engine.get(second.id).status).toBe("done");
    // No planned break: Brindle itself says the start of the prompt is unchanged.
    expect(runContext(db, second.id)[0]?.report.breaks).toEqual([]);
    if (fake) {
      const [a, b] = fake.seen.slice(-2);
      expect(b?.cachedTokens).toBeGreaterThanOrEqual(a?.promptTokens ?? Number.POSITIVE_INFINITY);
    }
  });

  onlyFake("ends a run cleanly when the model stalls past the run's time limit", async () => {
    const stalled = fake as FakeLlamaServer;
    for (const mode of ["first", "mid"] as const) {
      stalled.stall = mode;
      const { engine, channel } = engineFor(nCtx, { maxMillis: 300 });
      const run = engine.start(channel.id, "hello there");
      await engine.whenSettled(run.id);
      expect(engine.get(run.id)).toMatchObject({ status: "stopped" });
      expect(engine.get(run.id).stopReason).toMatch(/time limit/);
    }
    stalled.stall = null;
  });

  onlyFake("ends a stalled housekeeping call within its own limit", async () => {
    const stalled = fake as FakeLlamaServer;
    stalled.stall = "first";
    const summarize = modelSummarizer(adapter());
    const started = Date.now();
    const result = summarize({
      previous: null,
      runs: [{ id: "r", messages: [{ role: "user", content: "hi" }] }],
      signal: AbortSignal.timeout(300),
    });
    await expect(result).rejects.toBeInstanceOf(ModelError);
    await expect(result).rejects.toMatchObject({ kind: "aborted" });
    expect(Date.now() - started).toBeLessThan(3_000);
    stalled.stall = null;
  });
});
