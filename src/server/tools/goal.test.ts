import { describe, expect, it } from "vitest";
import { createChannel } from "../channels.js";
import { openDatabase } from "../db/index.js";
import { goals, schedules } from "../db/schema.js";
import { Scheduler } from "../scheduler.js";
import { currentStatement } from "../scope-statements.js";
import { proposeGoalTool } from "./goal.js";

function setup() {
  const db = openDatabase(":memory:");
  const scheduler = new Scheduler(
    db,
    { prepareRun: () => "r", beginRun: () => {}, goalBusy: () => false },
    { timeZone: "America/New_York" },
  );
  const tool = proposeGoalTool(db, scheduler);
  const channel = createChannel(db, "Chat");
  const ctx = {
    runId: "r",
    scope: { kind: "channel" as const, id: channel.id },
    signal: new AbortController().signal,
    log: () => {},
    emit: () => {},
  };
  return { db, tool, ctx };
}

const draft = {
  title: "Learn Rust",
  brief: "Finish the book.",
  schedule: { cron: "0 19 * * 1-5", prompt: "Tonight's lesson." },
};

describe("propose_goal", () => {
  it("is external, so the approval card is the confirmation, and shows what will be saved", () => {
    const { tool } = setup();
    expect(tool.effect).toBe("external");
    const card = tool.describeCall?.(draft) ?? "";
    expect(card).toContain("Learn Rust");
    expect(card).toContain("Finish the book.");
    expect(card).toContain("0 19 * * 1-5");
    expect(tool.describeCall?.({ title: "A", brief: "b" })).toContain("no schedule");
  });

  it("creates nothing before execute, then the goal, its channel and the schedule together", async () => {
    const { db, tool, ctx } = setup();
    expect(tool.precheck?.(draft, ctx)).toBeNull();
    expect(db.select().from(goals).all()).toEqual([]);
    const result = await tool.execute(draft, ctx);
    expect(result).toMatch(/^Created the goal "Learn Rust"/);
    const [goal] = db.select().from(goals).all();
    expect(currentStatement(db, "goal", goal?.id ?? "")).toMatchObject({ text: "Finish the book.", confirmed: true });
    expect(db.select().from(schedules).all()).toMatchObject([{ cron: "0 19 * * 1-5", goalId: goal?.id }]);
  });

  it("works without a schedule", async () => {
    const { db, tool, ctx } = setup();
    await tool.execute({ title: "Read", brief: "A book a month." }, ctx);
    expect(db.select().from(goals).all()).toHaveLength(1);
    expect(db.select().from(schedules).all()).toEqual([]);
  });

  it("sends a bad draft back before any card", () => {
    const { tool, ctx } = setup();
    expect(tool.precheck?.({ title: " ", brief: "x" }, ctx)).toMatch(/title/);
    expect(tool.precheck?.({ title: "A", brief: "" }, ctx)).toMatch(/brief/);
    expect(tool.precheck?.({ title: "A", brief: "x".repeat(2_001) }, ctx)).toMatch(/over/);
    expect(tool.precheck?.({ title: "A", brief: "x", schedule: { cron: "every day", prompt: "p" } }, ctx)).toMatch(
      /five fields/,
    );
    expect(tool.precheck?.({ title: "A", brief: "x", schedule: { cron: "*/5 * * * *", prompt: "p" } }, ctx)).toMatch(
      /15 minutes/,
    );
    expect(tool.precheck?.({ title: "A", brief: "x", schedule: { cron: "0 7 * * *" } }, ctx)).toMatch(/prompt/);
  });

  it("creates no goal if the schedule cannot be saved", async () => {
    const { db, tool, ctx } = setup();
    const result = await tool.execute({ ...draft, schedule: { cron: "not a cron", prompt: "p" } }, ctx);
    expect(result).toMatch(/^Error/);
    expect(db.select().from(goals).all()).toEqual([]);
  });
});
