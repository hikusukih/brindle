import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { branchOf } from "./branch.js";
import { createChannel, getChannel } from "./channels.js";
import type { Summarize } from "./compaction.js";
import { openDatabase } from "./db/index.js";
import { driftChecks, events, runs } from "./db/schema.js";
import { acceptNudge, DriftChecker, dismissNudge, openNudge, parseVerdict, runsBetweenChecks } from "./drift.js";
import { createGoal } from "./goals.js";
import { ScriptedModel } from "./model/scripted.js";
import { defaultLimits, RunEngine } from "./runs.js";
import { writeStatement } from "./scope-statements.js";

const on = '{"onTopic": true}';
const off = (topic: string) => JSON.stringify({ onTopic: false, topic });

/** A channel about gardening with a user-written purpose statement, a scripted reply per run and a scripted classifier. */
function setup(verdicts: string[]) {
  const db = openDatabase(":memory:");
  const replies = new ScriptedModel({ turns: Array.from({ length: 60 }, () => ({ text: ["Sure."] })) });
  const engine = new RunEngine(db, replies, defaultLimits);
  const channel = createChannel(db, "Garden");
  writeStatement(db, {
    scopeKind: "channel",
    scopeId: channel.id,
    text: "Planning the vegetable garden.",
    author: "user",
    confirmed: true,
  });
  const classifier = new ScriptedModel({ turns: verdicts.map((v) => ({ text: [v] })) });
  const drift = new DriftChecker(db, () => ({ model: classifier, millis: 60_000 }));
  const send = async (text: string, channelId = channel.id) => {
    const run = engine.start(channelId, text);
    await engine.whenSettled(run.id);
    return drift.afterRun(channelId);
  };
  const sendMany = async (n: number, text: string) => {
    for (let i = 0; i < n; i++) await send(`${text} ${i + 1}`);
  };
  const nudges = () =>
    db
      .select()
      .from(events)
      .all()
      .filter((e) => e.type === "nudge");
  const checks = () => db.select().from(driftChecks).all();
  return { db, engine, channel, classifier, drift, send, sendMany, nudges, checks };
}

describe("the drift nudge", () => {
  it("checks every fourth finished run, and twenty on-topic runs produce no nudge", async () => {
    const { sendMany, nudges, checks, classifier } = setup(Array.from({ length: 5 }, () => on));
    await sendMany(3, "Tomatoes or peppers?");
    expect(checks()).toHaveLength(0);
    await sendMany(17, "When do I plant beans?");
    expect(checks()).toHaveLength(20 / runsBetweenChecks);
    expect(nudges()).toHaveLength(0);
    // Each check compared the purpose statement with the latest three user messages, as material.
    const asked = classifier.requests.at(-1)?.messages.at(-1)?.content ?? "";
    expect(asked).toContain("Planning the vegetable garden.");
    expect(asked).toContain("When do I plant beans? 17");
    expect(asked).not.toContain("When do I plant beans? 14");
  });

  it("a switch to an unrelated topic produces exactly one nudge, after two off-topic checks in a row", async () => {
    const { sendMany, nudges, checks, db, channel } = setup([on, off("Car repairs"), off("Car repairs")]);
    await sendMany(4, "Which beans?");
    await sendMany(4, "My car makes a noise");
    expect(nudges()).toHaveLength(0);
    await sendMany(4, "The brakes squeal");
    expect(nudges()).toHaveLength(1);
    expect(JSON.parse(nudges()[0]?.data ?? "{}")).toMatchObject({ topic: "Car repairs" });
    // While the nudge waits for an answer, no more checks run, so nothing piles up.
    await sendMany(8, "Still the car");
    expect(nudges()).toHaveLength(1);
    expect(checks()).toHaveLength(3);
    expect(openNudge(db, channel.id)?.topic).toBe("Car repairs");
  });

  it("dismiss silences it until the purpose statement changes", async () => {
    const { sendMany, nudges, checks, db, channel } = setup([
      off("Car repairs"),
      off("Car repairs"),
      off("Car repairs"),
      off("Car repairs"),
    ]);
    await sendMany(8, "My car");
    const nudge = openNudge(db, channel.id);
    expect(nudge).not.toBeNull();
    dismissNudge(db, channel.id, nudge?.checkId ?? "");
    expect(openNudge(db, channel.id)).toBeNull();
    await sendMany(8, "Car again");
    expect(checks()).toHaveLength(2);
    expect(nudges()).toHaveLength(1);

    writeStatement(db, {
      scopeKind: "channel",
      scopeId: channel.id,
      text: "Garden and car.",
      author: "user",
      confirmed: true,
    });
    await sendMany(8, "Car once more");
    expect(checks()).toHaveLength(4);
    expect(nudges()).toHaveLength(2);
  });

  it("accept creates a channel for the topic from the latest run and leaves the source's runs unchanged", async () => {
    const { sendMany, db, channel } = setup([off("Car repairs"), off("Car repairs")]);
    await sendMany(8, "My car");
    const before = db.select().from(runs).where(eq(runs.channelId, channel.id)).all();
    const beforeEvents = db
      .select()
      .from(events)
      .all()
      .filter((e) => e.type !== "nudge_answer").length;
    const focuses: (string | undefined)[] = [];
    const summarize: Summarize = async (input) => {
      focuses.push(input.focus);
      return { text: "The user's car makes a noise.", tokensUsed: 5 };
    };
    const drafted: string[] = [];
    const nudge = openNudge(db, channel.id);

    const made = await acceptNudge(db, channel.id, nudge?.checkId ?? "", {
      summarize,
      draftPurpose: async (_id, _seed, focus) => void drafted.push(focus),
    });

    expect(made.name).toBe("Car repairs");
    const latest = before.sort((a, b) => a.startedAt.localeCompare(b.startedAt)).at(-1);
    expect(branchOf(getChannel(db, made.id))).toMatchObject({ fromRunId: latest?.id, seeded: true });
    expect(focuses.at(-1)).toBe("Car repairs");
    expect(drafted).toEqual(["Car repairs"]);
    // Nothing is moved: the source has every run and event it had, plus one line linking to the new channel.
    expect(db.select().from(runs).where(eq(runs.channelId, channel.id)).all()).toHaveLength(before.length);
    const all = db.select().from(events).all();
    expect(all.filter((e) => e.type !== "nudge_answer")).toHaveLength(beforeEvents);
    const answer = all.find((e) => e.type === "nudge_answer");
    expect(JSON.parse(answer?.data ?? "{}")).toMatchObject({ answer: "accepted", channelId: made.id });
    await expect(acceptNudge(db, channel.id, nudge?.checkId ?? "", {})).rejects.toThrow(/no longer open/);
  });

  it("does not check a goal's channel, which can't be branched, or a channel with no purpose statement", async () => {
    const { db, engine, drift, checks, classifier } = setup([]);
    const goal = createGoal(db, { title: "Run a 5k", brief: "Train for a 5k." });
    const plain = createChannel(db, "No purpose yet");
    for (const id of [goal.channelId, plain.id]) {
      for (let i = 0; i < 4; i++) {
        const run = engine.start(id, `message ${i}`);
        await engine.whenSettled(run.id);
        await drift.afterRun(id);
      }
    }
    expect(checks()).toHaveLength(0);
    expect(classifier.requests).toHaveLength(0);
  });

  it("records nothing when the classifier's answer is not the JSON asked for", async () => {
    const { sendMany, checks, nudges } = setup(["Sounds off topic to me.", "Sure!"]);
    await sendMany(8, "My car");
    expect(checks()).toHaveLength(0);
    expect(nudges()).toHaveLength(0);
  });

  it("answers the two buttons over the API", async () => {
    const { sendMany, db, engine, channel } = setup([off("Car repairs"), off("Car repairs")]);
    await sendMany(8, "My car");
    const app = createApp({ db, engine });
    const nudge = openNudge(db, channel.id);
    const accepted = await app.request(`/api/channels/${channel.id}/nudges/${nudge?.checkId}/accept`, {
      method: "POST",
    });
    expect(accepted.status).toBe(201);
    expect(((await accepted.json()) as { name: string }).name).toBe("Car repairs");
    const again = await app.request(`/api/channels/${channel.id}/nudges/${nudge?.checkId}/dismiss`, {
      method: "POST",
    });
    expect(again.status).toBe(404);
  });
});

describe("parseVerdict", () => {
  it("reads on topic, and off topic with a short name", () => {
    expect(parseVerdict(on)).toEqual({ onTopic: true, topic: null });
    expect(parseVerdict('Here: {"onTopic": false, "topic": "  Car   repairs "}')).toEqual({
      onTopic: false,
      topic: "Car repairs",
    });
  });

  it("gives no verdict for anything else, so it can't produce a nudge", () => {
    expect(parseVerdict("off topic")).toBeNull();
    expect(parseVerdict('{"onTopic": false}')).toBeNull();
    expect(parseVerdict('{"onTopic": "no"}')).toBeNull();
  });
});
