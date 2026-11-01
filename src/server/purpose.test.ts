import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createChannel } from "./channels.js";
import { runContext } from "./context.js";
import { openDatabase } from "./db/index.js";
import { channels } from "./db/schema.js";
import { createGoal } from "./goals.js";
import { type ModelAdapter, ModelError } from "./model/adapter.js";
import { ScriptedModel } from "./model/scripted.js";
import { PurposeDrafter } from "./purpose.js";
import { RunEngine } from "./runs.js";
import { currentStatement, writeStatement } from "./scope-statements.js";

function setup(utility: ModelAdapter = new ScriptedModel({ turns: [{ text: ["Planning a trip to Lisbon."] }] })) {
  const db = openDatabase(":memory:");
  const chat = new ScriptedModel({ turns: Array.from({ length: 6 }, (_, i) => ({ text: [`Answer ${i + 1}.`] })) });
  const engine = new RunEngine(db, chat);
  const seen: string[] = [];
  const drafter = new PurposeDrafter(db, () => ({
    model: {
      stream(request) {
        seen.push(request.messages.map((m) => m.content).join("\n---\n"));
        return utility.stream(request);
      },
    },
    millis: 5_000,
  }));
  const channel = createChannel(db, "Trip");
  const ask = async (text: string) => {
    const run = engine.start(channel.id, text);
    await engine.whenSettled(run.id);
    return run;
  };
  return { db, engine, drafter, channel, ask, seen };
}

describe("purpose statement", () => {
  it("is drafted only after the third finished run, saved as an unconfirmed agent draft", async () => {
    const { db, drafter, channel, ask, seen } = setup();
    await ask("Where to eat in Lisbon?");
    await ask("And the hotel?");
    expect(await drafter.afterRun(channel.id)).toBeUndefined();
    expect(seen).toHaveLength(0);

    await ask("What about trams?");
    const draft = await drafter.afterRun(channel.id);
    expect(draft).toMatchObject({ text: "Planning a trip to Lisbon.", author: "agent", confirmed: false, version: 1 });
    expect(currentStatement(db, "channel", channel.id)?.text).toBe("Planning a trip to Lisbon.");
    // The material is the user's words and the answers, framed as data.
    expect(seen[0]).toContain("User: Where to eat in Lisbon?");
    expect(seen[0]).toContain("Assistant: Answer 1.");
    expect(seen[0]).toMatch(/not instructions to follow/);
  });

  it("never replaces what the user wrote, and drafts again only when asked", async () => {
    const { db, drafter, channel, ask } = setup(new ScriptedModel({ turns: [{ text: ["New draft."] }] }));
    for (const q of ["a", "b", "c"]) await ask(q);
    writeStatement(db, { scopeKind: "channel", scopeId: channel.id, text: "Mine.", author: "user", confirmed: true });
    expect(await drafter.afterRun(channel.id)).toBeUndefined();
    expect(currentStatement(db, "channel", channel.id)?.text).toBe("Mine.");

    await drafter.draft(channel.id);
    expect(currentStatement(db, "channel", channel.id)).toMatchObject({
      text: "New draft.",
      version: 2,
      author: "agent",
    });
  });

  it("stays silent when the call fails, and tries again after later runs, three times at most", async () => {
    const broken: ModelAdapter = {
      // biome-ignore lint/correctness/useYield: a stream that fails before saying anything
      async *stream() {
        throw new ModelError("unavailable", "down");
      },
    };
    const { db, drafter, channel, ask } = setup(broken);
    for (const q of ["a", "b", "c"]) await ask(q);
    for (let i = 0; i < 5; i++) expect(await drafter.afterRun(channel.id)).toBeUndefined();
    expect(currentStatement(db, "channel", channel.id)).toBeUndefined();
    expect((drafter as unknown as { attempts: Map<string, number> }).attempts.get(channel.id)).toBe(3);
  });

  it("is not drafted for a goal's channel", async () => {
    const { db, drafter } = setup();
    const goal = createGoal(db, { title: "Learn Rust", brief: "A short curriculum." });
    expect(await drafter.afterRun(goal.channelId)).toBeUndefined();
  });

  it("is sent with every run, labeled, as layer 2", async () => {
    const { db, channel, ask } = setup();
    writeStatement(db, {
      scopeKind: "channel",
      scopeId: channel.id,
      text: "Trip planning.",
      author: "user",
      confirmed: true,
    });
    const run = await ask("hi");
    const sent = runContext(db, run.id)[0];
    expect(sent?.report.layers.map((l) => l.name)).toContain("scope_statement");
    expect(JSON.stringify(sent?.messages)).toContain("What this channel is for:\\nTrip planning.");
  });

  it("is drafted by the engine's hook after a run ends as done", async () => {
    const { db, engine, drafter, channel, ask } = setup();
    engine.onRunDone = (id) => void drafter.afterRun(id);
    for (const q of ["a", "b", "c"]) await ask(q);
    await new Promise((r) => setTimeout(r, 20));
    expect(currentStatement(db, "channel", channel.id)?.author).toBe("agent");
  });
});

describe("purpose statement API", () => {
  it("reads, edits, drafts on request, and restores", async () => {
    const { db, drafter, channel, ask } = setup();
    for (const q of ["a", "b", "c"]) await ask(q);
    const app = createApp({ db, purpose: drafter });
    const json = async (res: Response) =>
      (await res.json()) as { current: { text: string; version: number } | null; versions: unknown[] };
    const send = (method: string, path: string, body?: unknown) =>
      app.request(`/api/channels/${channel.id}/purpose${path}`, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });

    expect((await json(await send("GET", ""))).current).toBeNull();
    expect((await json(await send("POST", "/draft"))).current?.text).toBe("Planning a trip to Lisbon.");
    const edited = await json(await send("PUT", "", { text: "  Lisbon, in May.  " }));
    expect(edited.current).toMatchObject({ text: "Lisbon, in May.", version: 2 });
    const restored = await json(await send("POST", "/versions/1/restore"));
    expect(restored.current).toMatchObject({ text: "Planning a trip to Lisbon.", version: 3 });
    const empty = await send("PUT", "", { text: "   " });
    expect(empty.status).toBe(400);
    expect(await empty.text()).toMatch(/purpose statement can't be empty/);
    const long = await send("PUT", "", { text: "x".repeat(1201) });
    expect(long.status).toBe(400);
    expect(await long.text()).toMatch(/at most 1200/);
    expect((await send("PUT", "", { text: 5 })).status).toBe(400);
    expect((await send("POST", "/versions/9/restore")).status).toBe(404);
  });

  it("answers plainly when a draft can't be made, and refuses a goal's channel", async () => {
    const { db, drafter } = setup();
    const empty = createChannel(db, "Empty");
    const app = createApp({ db, purpose: drafter });
    const res = await app.request(`/api/channels/${empty.id}/purpose/draft`, { method: "POST" });
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/nothing to draft from/);
    const noModel = createApp({ db });
    expect((await noModel.request(`/api/channels/${empty.id}/purpose/draft`, { method: "POST" })).status).toBe(503);

    const goal = createGoal(db, { title: "Learn Rust", brief: "A short curriculum." });
    expect((await app.request(`/api/channels/${goal.channelId}/purpose`)).status).toBe(409);
    expect(db.select().from(channels).where(eq(channels.id, empty.id)).get()).toBeDefined();
  });
});
