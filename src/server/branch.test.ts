import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { branchChannel, branchOf } from "./branch.js";
import { createChannel } from "./channels.js";
import { type Summarize, summaryCapTokens } from "./compaction.js";
import { openDatabase } from "./db/index.js";
import { summaries } from "./db/schema.js";
import { createGoal } from "./goals.js";
import { ScriptedModel } from "./model/scripted.js";
import { channelTranscript, defaultLimits, RunEngine } from "./runs.js";

async function setup() {
  const db = openDatabase(":memory:");
  const model = new ScriptedModel({ turns: Array.from({ length: 5 }, (_, i) => ({ text: [`reply ${i}`] })) });
  const engine = new RunEngine(db, model, defaultLimits);
  const source = createChannel(db, "Planning");
  const ids: string[] = [];
  for (const text of ["Plan the trip to Lisbon.", "Budget is 500 dollars.", "Now talk about the garden."]) {
    const run = engine.start(source.id, text);
    await engine.whenSettled(run.id);
    ids.push(run.id);
  }
  return { db, engine, source, ids };
}

const recording = (reply = "Seed: Lisbon trip, budget 500 dollars.") => {
  const calls: Parameters<Summarize>[0][] = [];
  const summarize: Summarize = async (input) => {
    calls.push(input);
    return { text: reply, tokensUsed: 10 };
  };
  return { calls, summarize };
};

describe("New channel from here", () => {
  it("seeds the new channel's summary at version 0, centered on the chosen run, and leaves the source whole", async () => {
    const { db, source, ids } = await setup();
    const { calls, summarize } = recording();
    const drafted: string[] = [];
    const channel = await branchChannel(db, source.id, ids[1] as string, {
      name: "Lisbon",
      summarize,
      draftPurpose: async (_id, seed) => void drafted.push(seed),
    });
    expect(channel.name).toBe("Lisbon");
    expect(branchOf(channel)).toMatchObject({
      fromChannelId: source.id,
      fromChannelName: "Planning",
      fromRunId: ids[1],
      seeded: true,
    });
    const [seed] = db.select().from(summaries).where(eq(summaries.channelId, channel.id)).all();
    expect(seed).toMatchObject({ version: 0, throughRunId: null, text: "Seed: Lisbon trip, budget 500 dollars." });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.focus).toContain(ids[1]);
    expect(JSON.stringify(calls[0]?.runs)).toContain("Budget is 500 dollars.");
    expect(JSON.stringify(calls[0]?.runs)).not.toContain("garden");
    expect(drafted).toEqual(["Seed: Lisbon trip, budget 500 dollars."]);
    expect(channelTranscript(db, source.id)).toHaveLength(3);
    expect(channelTranscript(db, channel.id)).toHaveLength(0);
    expect(db.select().from(summaries).where(eq(summaries.channelId, source.id)).all()).toHaveLength(0);
  });

  it("refreshes the source's summary first when runs finished since the last fold, without saving it", async () => {
    const { db, source, ids } = await setup();
    db.insert(summaries)
      .values({
        id: "s1",
        channelId: source.id,
        version: 1,
        throughRunId: ids[0] as string,
        text: "Old summary.",
        artifacts: "[]",
        tokensUsed: 1,
        createdAt: "2026-01-01T00:00:00Z",
      })
      .run();
    const texts = ["Refreshed summary.", "Seed text."];
    const calls: Parameters<Summarize>[0][] = [];
    const summarize: Summarize = async (input) => {
      calls.push(input);
      return { text: texts.shift() ?? "", tokensUsed: 1 };
    };
    const channel = await branchChannel(db, source.id, ids[0] as string, { summarize });
    expect(calls).toHaveLength(2);
    expect(calls[0]?.previous).toBe("Old summary.");
    expect(JSON.stringify(calls[0]?.runs)).toContain("garden");
    expect(JSON.stringify(calls[1]?.runs)).toContain("Refreshed summary.");
    expect(branchOf(channel)?.refreshed).toBe("Refreshed summary.");
    expect(db.select().from(summaries).where(eq(summaries.channelId, source.id)).all()).toHaveLength(1);
  });

  it("still creates the channel, empty and marked, when the seed call fails or is over its cap", async () => {
    const { db, source, ids } = await setup();
    const failing: Summarize = async () => {
      throw new Error("down");
    };
    const a = await branchChannel(db, source.id, ids[0] as string, { summarize: failing });
    expect(branchOf(a)?.seeded).toBe(false);
    const long: Summarize = async () => ({ text: "x".repeat(summaryCapTokens * 4 * 2), tokensUsed: 1 });
    const b = await branchChannel(db, source.id, ids[0] as string, { summarize: long });
    expect(branchOf(b)?.seeded).toBe(false);
    for (const c of [a, b])
      expect(db.select().from(summaries).where(eq(summaries.channelId, c.id)).all()).toHaveLength(0);
  });

  it("asks once to shorten an over-cap seed", async () => {
    const { db, source, ids } = await setup();
    const replies = ["x".repeat(summaryCapTokens * 4 + 40), "Short seed."];
    const summarize: Summarize = async () => ({ text: replies.shift() ?? "", tokensUsed: 1 });
    const c = await branchChannel(db, source.id, ids[0] as string, { summarize });
    expect(db.select().from(summaries).where(eq(summaries.channelId, c.id)).get()?.text).toBe("Short seed.");
  });

  it("makes an empty channel when no model is configured, and refuses an unfinished, foreign or goal-channel branch", async () => {
    const { db, source, ids } = await setup();
    const c = await branchChannel(db, source.id, ids[0] as string, {});
    expect(branchOf(c)).toMatchObject({ seeded: false });
    const other = createChannel(db, "Other");
    await expect(branchChannel(db, other.id, ids[0] as string, {})).rejects.toThrow(/No such run/);
    const goal = createGoal(db, { title: "G", brief: "b" });
    await expect(branchChannel(db, goal.channelId, "r", {})).rejects.toThrow(/goal/);
  });

  it("is offered by the API and returns the new channel", async () => {
    const { db, engine, source, ids } = await setup();
    const { summarize } = recording();
    const app = createApp({ db, engine, branching: summarize });
    const res = await app.request(`/api/channels/${source.id}/branch`, {
      method: "POST",
      body: JSON.stringify({ runId: ids[1], name: "Lisbon" }),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ name: "Lisbon" });
    const bad = await app.request(`/api/channels/${source.id}/branch`, { method: "POST", body: "{}" });
    expect(bad.status).toBe(400);
  });

  it("uses the seed as the new channel's summary when its first run starts", async () => {
    const { db, source, ids } = await setup();
    const { summarize } = recording("Seed: budget 500.");
    const channel = await branchChannel(db, source.id, ids[1] as string, { summarize });
    const model = new ScriptedModel({ turns: [{ text: ["ok"] }] });
    const engine = new RunEngine(db, model, defaultLimits);
    const run = engine.start(channel.id, "and the hotel?");
    await engine.whenSettled(run.id);
    expect(
      model.requests[0]?.messages.some((m) => m.role === "system" && m.content.includes("Seed: budget 500.")),
    ).toBe(true);
  });
});
