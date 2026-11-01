import { describe, expect, it } from "vitest";
import { createChannel } from "../channels.js";
import { openDatabase } from "../db/index.js";
import { schedules } from "../db/schema.js";
import { archiveGoal, createGoal } from "../goals.js";
import { Scheduler } from "../scheduler.js";
import { proposeScheduleTool } from "./schedule.js";

function setup() {
  const db = openDatabase(":memory:");
  const scheduler = new Scheduler(
    db,
    { prepareRun: () => "r", beginRun: () => {}, goalBusy: () => false },
    { timeZone: "America/New_York" },
  );
  const goal = createGoal(db, { title: "Brief", brief: "Every morning." });
  const tool = proposeScheduleTool(db, scheduler);
  const scope = { kind: "channel" as const, id: goal.channelId };
  const ctx = { runId: "r", scope, signal: new AbortController().signal, log: () => {}, emit: () => {} };
  return { db, scheduler, goal, tool, scope, ctx };
}

describe("propose_schedule", () => {
  it("is external, so the approval card is the confirmation", () => {
    expect(setup().tool.effect).toBe("external");
  });

  it("shows the next occurrences in the user's zone on the card, and creates the schedule on execute", async () => {
    const { db, tool, ctx } = setup();
    const args = { cron: "30 6 * * 1-5", prompt: "Write the morning brief." };
    expect(tool.precheck?.(args, ctx)).toBeNull();
    const card = tool.describeCall?.(args) ?? "";
    expect(card).toContain("30 6 * * 1-5");
    expect(card).toContain("6:30 AM");
    expect(card).toContain("America/New_York");
    expect(db.select().from(schedules).all()).toEqual([]);

    const result = await tool.execute(args, ctx);
    expect(result).toMatch(/^Scheduled/);
    expect(db.select().from(schedules).all()).toMatchObject([{ cron: "30 6 * * 1-5", missedPolicy: "catch_up_once" }]);
  });

  it("sends a bad expression, a too-frequent one and a wrong channel back before any card", () => {
    const { db, tool, ctx, scope } = setup();
    expect(tool.precheck?.({ cron: "every day", prompt: "x" }, ctx)).toMatch(/five fields/);
    expect(tool.precheck?.({ cron: "*/5 * * * *", prompt: "x" }, ctx)).toMatch(/15 minutes/);
    expect(tool.precheck?.({ cron: "0,10 * * * *", prompt: "x" }, ctx)).toMatch(/15 minutes/);
    expect(tool.precheck?.({ cron: "0,30 * * * *", prompt: "x" }, ctx)).toBeNull();
    const plain = createChannel(db, "Chat");
    expect(tool.precheck?.({ cron: "0 7 * * *", prompt: "x" }, { scope: { ...scope, id: plain.id } })).toMatch(
      /not a goal's/,
    );
  });

  it("refuses an archived goal and a goal that already has 10 schedules", async () => {
    const { db, goal, scheduler, tool, ctx } = setup();
    for (let i = 0; i < 10; i++) scheduler.createSchedule({ goalId: goal.id, cron: `0 ${i} * * *`, prompt: "p" });
    expect(tool.precheck?.({ cron: "0 20 * * *", prompt: "x" }, ctx)).toMatch(/already has 10/);
    expect(await tool.execute({ cron: "0 20 * * *", prompt: "x" }, ctx)).toMatch(/^Error/);
    expect(db.select().from(schedules).all()).toHaveLength(10);
    db.delete(schedules).run();
    archiveGoal(db, goal.id);
    expect(tool.precheck?.({ cron: "0 20 * * *", prompt: "x" }, ctx)).toMatch(/archived/);
  });
});
