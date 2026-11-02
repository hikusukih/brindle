import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { openDatabase } from "./db/index.js";
import { goalStates } from "./db/schema.js";
import {
  applyAgentUpdate,
  currentState,
  goalStateAccess,
  restoreState,
  saveUserState,
  stateMaxChars,
  stateVersions,
} from "./goal-state.js";
import { archiveGoal, createGoal, deleteGoal } from "./goals.js";
import { getGoalStateTool, updateGoalStateTool } from "./tools/goal-state.js";
import { ToolRegistry, validateArguments } from "./tools/registry.js";

const setup = () => {
  const db = openDatabase(":memory:");
  const goal = createGoal(db, { title: "Learn Rust", brief: "Work through the book." });
  return { db, goal };
};

describe("the state document", () => {
  it("starts empty and the agent's first write is a whole replacement", () => {
    const { db, goal } = setup();
    expect(currentState(db, goal.id)).toBeUndefined();
    const r = applyAgentUpdate(db, goal.id, {
      version: 0,
      replace: "# Curriculum\n- ch1\n- ch2",
      note: "first draft",
      runId: "r1",
    });
    expect(r).toEqual({ ok: true, version: 1 });
    expect(currentState(db, goal.id)).toMatchObject({ author: "agent", runId: "r1", note: "first draft", version: 1 });
  });

  it("applies exact-string edits together, each matching once", () => {
    const { db, goal } = setup();
    applyAgentUpdate(db, goal.id, { version: 0, replace: "a: todo\nb: todo\nc: todo", note: "x" });
    const ok = applyAgentUpdate(db, goal.id, {
      version: 1,
      edits: [
        { old: "a: todo", new: "a: done" },
        { old: "c: todo", new: "c: done" },
      ],
      note: "did a and c",
    });
    expect(ok).toEqual({ ok: true, version: 2 });
    expect(currentState(db, goal.id)?.text).toBe("a: done\nb: todo\nc: done");

    const none = applyAgentUpdate(db, goal.id, { version: 2, edits: [{ old: "zzz", new: "y" }], note: "x" });
    expect(none).toMatchObject({ ok: false, error: expect.stringContaining("Edit 1 does not apply") });
    const twice = applyAgentUpdate(db, goal.id, {
      version: 2,
      edits: [
        { old: "todo", new: "x" },
        { old: "a: done", new: "q" },
      ],
      note: "x",
    });
    expect(twice).toMatchObject({ ok: true });
    // All or nothing: one bad pair leaves the document alone.
    const before = currentState(db, goal.id)?.version;
    const mixed = applyAgentUpdate(db, goal.id, {
      version: before ?? 0,
      edits: [
        { old: "x", new: "y" },
        { old: "nope", new: "z" },
      ],
      note: "x",
    });
    expect(mixed.ok).toBe(false);
    expect(currentState(db, goal.id)?.version).toBe(before);
  });

  it("refuses ambiguous and overlapping edits and empty arguments", () => {
    const { db, goal } = setup();
    applyAgentUpdate(db, goal.id, { version: 0, replace: "aa bb aa", note: "x" });
    expect(applyAgentUpdate(db, goal.id, { version: 1, edits: [{ old: "aa", new: "z" }], note: "x" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("more than once"),
    });
    expect(
      applyAgentUpdate(db, goal.id, {
        version: 1,
        edits: [
          { old: "aa bb", new: "z" },
          { old: "bb aa", new: "y" },
        ],
        note: "x",
      }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("overlap") });
    expect(applyAgentUpdate(db, goal.id, { version: 1, note: "x" }).ok).toBe(false);
    expect(applyAgentUpdate(db, goal.id, { version: 1, edits: [], replace: "q", note: "x" }).ok).toBe(false);
  });

  it("keeps the user's edit when the agent's edits still apply, and returns the current text when they don't", () => {
    const { db, goal } = setup();
    applyAgentUpdate(db, goal.id, { version: 0, replace: "one\ntwo\nthree", note: "x" });
    saveUserState(db, goal.id, { text: "ONE\ntwo\nthree", baseVersion: 1 });
    // The agent read version 1 and edits a line the user did not touch.
    const merged = applyAgentUpdate(db, goal.id, { version: 1, edits: [{ old: "three", new: "3" }], note: "x" });
    expect(merged).toEqual({ ok: true, version: 3 });
    expect(currentState(db, goal.id)?.text).toBe("ONE\ntwo\n3");
    // Now it edits the line the user changed.
    const clash = applyAgentUpdate(db, goal.id, { version: 1, edits: [{ old: "one", new: "1" }], note: "x" });
    expect(clash).toMatchObject({ ok: false, current: { version: 3, text: "ONE\ntwo\n3" } });
    // A stale whole replacement is refused outright.
    const stale = applyAgentUpdate(db, goal.id, { version: 1, replace: "new", note: "x" });
    expect(stale).toMatchObject({ ok: false, current: { version: 3 } });
  });

  it("refuses a write over the cap, from the agent and from the user", () => {
    const { db, goal } = setup();
    const big = "x".repeat(stateMaxChars + 1);
    expect(applyAgentUpdate(db, goal.id, { version: 0, replace: big, note: "x" })).toMatchObject({
      ok: false,
      error: expect.stringContaining("Condense"),
    });
    expect(() => saveUserState(db, goal.id, { text: big })).toThrow(/most it can hold/);
    expect(stateVersions(db, goal.id)).toHaveLength(0);
  });

  it("refuses a user save over a newer version, restores as a new version, and refuses writes when archived", () => {
    const { db, goal } = setup();
    saveUserState(db, goal.id, { text: "v1" });
    applyAgentUpdate(db, goal.id, { version: 1, replace: "v2", note: "x" });
    expect(() => saveUserState(db, goal.id, { text: "mine", baseVersion: 1 })).toThrow(
      /changed while you were editing/,
    );
    const back = restoreState(db, goal.id, 1);
    expect(back).toMatchObject({ version: 3, text: "v1", author: "user", note: "restored version 1" });
    expect(stateVersions(db, goal.id).map((v) => v.text)).toEqual(["v1", "v2", "v1"]);
    expect(() => restoreState(db, goal.id, 9)).toThrow(/No such version/);
    archiveGoal(db, goal.id);
    expect(() => saveUserState(db, goal.id, { text: "q" })).toThrow(/Restore the goal/);
  });

  it("is deleted with the goal", () => {
    const { db, goal } = setup();
    saveUserState(db, goal.id, { text: "v1" });
    deleteGoal(db, goal.id);
    expect(db.select().from(goalStates).all()).toHaveLength(0);
  });
});

describe("the state tools", () => {
  const ctx = (channelId: string) => ({
    runId: "r9",
    scope: { kind: "channel" as const, id: channelId },
    signal: new AbortController().signal,
    log: () => {},
    emit: () => {},
  });

  it("read and write the goal that owns the channel, and say so in a plain channel", async () => {
    const { db, goal } = setup();
    const access = goalStateAccess(db);
    const get = getGoalStateTool(access);
    const update = updateGoalStateTool(access);
    expect(get.effect).toBe("read");
    expect(update.effect).toBe("local");
    expect(await get.execute({}, ctx(goal.channelId))).toMatch(/empty \(version 0\)/);
    expect(await update.execute({ version: 0, replace: "plan", note: "start" }, ctx(goal.channelId))).toMatch(
      /version 1/,
    );
    expect(await get.execute({}, ctx(goal.channelId))).toBe("Version 1\n\nplan");
    expect(currentState(db, goal.id)).toMatchObject({ runId: "r9", author: "agent" });
    expect(await update.execute({ version: 0, replace: "x", note: "n" }, ctx(goal.channelId))).toMatch(
      /current document is version 1/,
    );
    expect(await get.execute({}, ctx("some-other-channel"))).toMatch(/not a goal's channel/);
  });

  it("validates arguments before executing", () => {
    const update = updateGoalStateTool(goalStateAccess(openDatabase(":memory:")));
    expect(validateArguments(update, { version: 1, note: "n", edits: [{ old: "a" }] })).toMatch(/new is required/);
    expect(validateArguments(update, { version: 1, note: "n", replace: "x" })).toBeNull();
    expect(new ToolRegistry().register(update).size).toBe(1);
  });
});

describe("the state API", () => {
  it("reads, saves, lists history and restores", async () => {
    const { db, goal } = setup();
    const app = createApp({ db });
    const send = (path: string, method: string, body?: unknown) =>
      app.request(path, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
      });
    expect(await (await send(`/api/goals/${goal.id}/state`, "GET")).json()).toEqual({ version: 0, text: "" });
    expect((await send(`/api/goals/${goal.id}/state`, "PUT", { text: "hello", baseVersion: 0 })).status).toBe(200);
    expect((await send(`/api/goals/${goal.id}/state`, "PUT", { text: "again", baseVersion: 0 })).status).toBe(409);
    expect((await send(`/api/goals/${goal.id}/state`, "PUT", { text: 3 })).status).toBe(400);
    expect((await send(`/api/goals/${goal.id}/state`, "PUT", { text: "x".repeat(stateMaxChars + 1) })).status).toBe(
      400,
    );
    expect((await send("/api/goals/nope/state", "GET")).status).toBe(404);
    const versions = (await (await send(`/api/goals/${goal.id}/state/versions`, "GET")).json()) as unknown[];
    expect(versions).toHaveLength(1);
    expect((await send(`/api/goals/${goal.id}/state/versions/1/restore`, "POST")).status).toBe(200);
    expect((await send(`/api/goals/${goal.id}/state/versions/7/restore`, "POST")).status).toBe(404);
  });
});
