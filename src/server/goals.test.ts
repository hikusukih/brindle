import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { getChannel, listChannels } from "./channels.js";
import { openDatabase } from "./db/index.js";
import { runs, schedules } from "./db/schema.js";
import {
  archiveGoal,
  briefHistory,
  cancelGoalRuns,
  createGoal,
  deleteGoal,
  editGoal,
  GoalError,
  getGoal,
  listGoals,
  restoreBrief,
  restoreGoal,
} from "./goals.js";
import { ScriptedModel } from "./model/scripted.js";
import { RunEngine } from "./runs.js";
import { Scheduler } from "./scheduler.js";
import { currentStatement, type StatementWrite, writeStatement } from "./scope-statements.js";

const setup = () => openDatabase(":memory:");

describe("goals", () => {
  it("creates a goal with its channel and a confirmed first brief", () => {
    const db = setup();
    const goal = createGoal(db, { title: " Learn Rust ", brief: "Work through the book, twice a week." });
    expect(goal).toMatchObject({ title: "Learn Rust", status: "active" });
    expect(getChannel(db, goal.channelId).name).toBe("Learn Rust");
    expect(goal.brief).toMatchObject({ kind: "goal_brief", version: 1, author: "user", confirmed: true });
  });

  it("refuses a blank title or brief and creates nothing", () => {
    const db = setup();
    expect(() => createGoal(db, { title: "", brief: "x" })).toThrow(GoalError);
    expect(() => createGoal(db, { title: "T", brief: "  " })).toThrow();
    expect(() => createGoal(db, { title: "T", brief: "x".repeat(2_001) })).toThrow();
    expect(listGoals(db)).toEqual([]);
    expect(listChannels(db)).toEqual([]);
  });

  it("an edit to the brief is a new version; the title renames the channel; an unchanged brief adds nothing", () => {
    const db = setup();
    const goal = createGoal(db, { title: "A", brief: "one" });
    editGoal(db, goal.id, { brief: "one" });
    expect(briefHistory(db, goal.id)).toHaveLength(1);
    const edited = editGoal(db, goal.id, { title: "B", brief: "two" });
    expect(edited.brief).toMatchObject({ version: 2, text: "two" });
    expect(getChannel(db, goal.channelId).name).toBe("B");
  });

  it("restoring a version writes it again as a new one", () => {
    const db = setup();
    const goal = createGoal(db, { title: "A", brief: "one" });
    editGoal(db, goal.id, { brief: "two" });
    const restored = restoreBrief(db, goal.id, 1);
    expect(restored.brief).toMatchObject({ version: 3, text: "one" });
    expect(briefHistory(db, goal.id).map((b) => b.text)).toEqual(["one", "two", "one"]);
  });

  it("archives with its channel, refuses edits while archived, and restores", () => {
    const db = setup();
    const goal = createGoal(db, { title: "A", brief: "one" });
    archiveGoal(db, goal.id);
    expect(getChannel(db, goal.channelId).archivedAt).not.toBeNull();
    expect(listGoals(db)).toEqual([]);
    expect(listGoals(db, { archived: true })).toHaveLength(1);
    expect(() => editGoal(db, goal.id, { brief: "x" })).toThrow(GoalError);
    restoreGoal(db, goal.id);
    expect(getChannel(db, goal.channelId).archivedAt).toBeNull();
    expect(getGoal(db, goal.id).status).toBe("active");
  });

  it("deleting removes the goal, its channel and every brief version", () => {
    const db = setup();
    const goal = createGoal(db, { title: "A", brief: "one" });
    deleteGoal(db, goal.id);
    expect(listGoals(db)).toEqual([]);
    expect(listChannels(db)).toEqual([]);
    expect(currentStatement(db, "goal", goal.id)).toBeUndefined();
  });

  it("an agent's draft cannot save a goal brief", () => {
    const db = setup();
    // @ts-expect-error a goal brief takes only the user's confirmed text
    const draft: StatementWrite = { scopeKind: "goal", scopeId: "g", text: "t", author: "agent", confirmed: false };
    void draft;
    const statement = writeStatement(db, {
      scopeKind: "channel",
      scopeId: "c",
      text: "t",
      author: "agent",
      confirmed: false,
    });
    expect(statement).toMatchObject({ kind: "purpose", confirmed: false });
  });

  it("serves goals over the API", async () => {
    const db = setup();
    const app = createApp({ db });
    const post = (path: string, body?: unknown, method = "POST") =>
      app.request(path, {
        method,
        body: body ? JSON.stringify(body) : undefined,
        headers: { "content-type": "application/json" },
      });
    const created = (await (await post("/api/goals", { title: "Rust", brief: "learn" })).json()) as { id: string };
    expect((await post("/api/goals", { title: "", brief: "x" })).status).toBe(400);
    expect((await post(`/api/goals/${created.id}`, { brief: "learn more" }, "PATCH")).status).toBe(200);
    expect(((await (await app.request(`/api/goals/${created.id}/brief-versions`)).json()) as unknown[]).length).toBe(2);
    expect((await post(`/api/goals/${created.id}/archive`)).status).toBe(200);
    expect((await post(`/api/goals/${created.id}`, { brief: "x" }, "PATCH")).status).toBe(409);
    expect((await app.request("/api/goals/nope")).status).toBe(404);
    expect((await app.request(`/api/goals/${created.id}`, { method: "DELETE" })).status).toBe(204);
  });

  it("the channels API leaves a goal's channel to the goal", async () => {
    const db = setup();
    const app = createApp({ db });
    const goal = createGoal(db, { title: "Rust", brief: "learn" });
    const send = (path: string, method: string, body?: unknown) =>
      app.request(path, {
        method,
        body: body ? JSON.stringify(body) : undefined,
        headers: { "content-type": "application/json" },
      });
    const channel = `/api/channels/${goal.channelId}`;
    for (const res of [
      await send(channel, "PATCH", { name: "Other" }),
      await send(`${channel}/archive`, "POST"),
      await send(`${channel}/restore`, "POST"),
      await send(channel, "DELETE"),
    ]) {
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe("goal_channel");
    }
    expect(getChannel(db, goal.channelId)).toMatchObject({ name: "Rust", archivedAt: null });
    expect(getGoal(db, goal.id).status).toBe("active");
  });

  it("deleting a goal leaves a channel's statements with the same id alone", () => {
    const db = setup();
    const goal = createGoal(db, { title: "A", brief: "one" });
    writeStatement(db, { scopeKind: "channel", scopeId: goal.id, text: "kept", author: "user", confirmed: true });
    deleteGoal(db, goal.id);
    expect(currentStatement(db, "channel", goal.id)).toMatchObject({ text: "kept" });
  });
});

describe("goals and their schedules and runs", () => {
  const hooks = { prepareRun: () => "r", beginRun: () => {}, goalBusy: () => false };
  const build = () => {
    const db = openDatabase(":memory:");
    const scheduler = new Scheduler(db, hooks, { timeZone: "America/New_York" });
    const goal = createGoal(db, { title: "Briefing", brief: "Every morning." });
    return { db, scheduler, goal };
  };
  const now = new Date("2026-03-02T12:00:00.000Z");

  it("archiving turns off enabled schedules and restoring brings back exactly those", () => {
    const { db, scheduler, goal } = build();
    const on = scheduler.createSchedule({ goalId: goal.id, cron: "30 6 * * *", prompt: "brief" }, now);
    const off = scheduler.createSchedule({ goalId: goal.id, cron: "0 9 * * 1", prompt: "weekly", enabled: false }, now);
    archiveGoal(db, goal.id, now, scheduler);
    const archived = db.select().from(schedules).all();
    expect(archived.find((s) => s.id === on.id)).toMatchObject({
      enabled: false,
      nextFireAt: null,
      suspendedByArchive: true,
    });

    restoreGoal(db, goal.id, new Date("2026-03-09T12:00:00.000Z"), scheduler);
    const rows = db.select().from(schedules).all();
    const back = rows.find((s) => s.id === on.id);
    expect(back).toMatchObject({ enabled: true, suspendedByArchive: false });
    // Resumes from the next occurrence after the restore, not the time it was off.
    expect(back?.nextFireAt && back.nextFireAt > "2026-03-09T12:00:00.000Z").toBe(true);
    expect(rows.find((s) => s.id === off.id)).toMatchObject({ enabled: false, suspendedByArchive: false });
  });

  it("a fire already waiting when the goal is archived does not start a run", () => {
    const db = openDatabase(":memory:");
    const scheduler = new Scheduler(db, { ...hooks, goalBusy: () => true }, { timeZone: "America/New_York" });
    const goal = createGoal(db, { title: "Briefing", brief: "Every morning." });
    scheduler.createSchedule({ goalId: goal.id, cron: "30 6 * * *", prompt: "brief" }, now);
    scheduler.tick(new Date("2026-03-03T11:31:00.000Z"));
    archiveGoal(db, goal.id, now, scheduler);
    scheduler.tick(new Date("2026-03-03T11:32:00.000Z"));
    expect(scheduler.log().map((f) => f.state)).toEqual(["skipped_disabled"]);
  });

  it("deleting removes the goal's schedules and fire log, and only its own", () => {
    const { db, scheduler, goal } = build();
    const other = createGoal(db, { title: "Other", brief: "Keep." });
    scheduler.createSchedule({ goalId: goal.id, cron: "30 6 * * *", prompt: "brief" }, now);
    scheduler.createSchedule({ goalId: other.id, cron: "30 7 * * *", prompt: "other" }, now);
    scheduler.tick(new Date("2026-03-03T11:31:00.000Z"));
    scheduler.tick(new Date("2026-03-03T12:31:00.000Z"));
    expect(scheduler.log().length).toBeGreaterThan(0);
    deleteGoal(db, goal.id, scheduler);
    expect(
      db
        .select()
        .from(schedules)
        .all()
        .map((s) => s.goalId),
    ).toEqual([other.id]);
    const left = new Set(scheduler.log().map((f) => f.scheduleId));
    expect([...left]).toEqual(
      db
        .select()
        .from(schedules)
        .all()
        .map((s) => s.id),
    );
  });

  it("cancels a run going in the goal's channel before archiving or deleting", async () => {
    const { db, goal } = build();
    const engine = new RunEngine(db, new ScriptedModel({ turns: [] }));
    const park = (id: string) =>
      db
        .insert(runs)
        .values({
          id,
          channelId: goal.channelId,
          status: "waiting",
          stopReason: null,
          startedAt: now.toISOString(),
          endedAt: null,
        })
        .run();
    park("parked-1");
    await cancelGoalRuns(db, engine, goal.id);
    expect(engine.get("parked-1").status).toBe("cancelled");

    const app = createApp({ db, engine });
    park("parked-2");
    expect((await app.request(`/api/goals/${goal.id}/archive`, { method: "POST" })).status).toBe(200);
    expect(engine.get("parked-2").status).toBe("cancelled");
    park("parked-3");
    await app.request(`/api/goals/${goal.id}/restore`, { method: "POST" });
    expect((await app.request(`/api/goals/${goal.id}`, { method: "DELETE" })).status).toBe(204);
    expect(db.select().from(runs).all()).toEqual([]);
  });
});
