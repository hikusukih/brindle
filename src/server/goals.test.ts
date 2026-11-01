import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { getChannel, listChannels } from "./channels.js";
import { openDatabase } from "./db/index.js";
import {
  archiveGoal,
  briefHistory,
  createGoal,
  deleteGoal,
  editGoal,
  GoalError,
  getGoal,
  listGoals,
  restoreBrief,
  restoreGoal,
} from "./goals.js";
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
