import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createChannel } from "../channels.js";
import { openDatabase } from "../db/index.js";
import { events, schedules } from "../db/schema.js";
import { archiveGoal, createGoal } from "../goals.js";
import { ScriptedModel } from "../model/scripted.js";
import { defaultLimits, RunEngine } from "../runs.js";
import { Scheduler } from "../scheduler.js";
import { ToolRegistry } from "./registry.js";
import { maxPerGoal, proposeScheduleTool } from "./schedule.js";

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

  it("refuses an archived goal and a goal that already has 5 schedules", async () => {
    const { db, goal, scheduler, tool, ctx } = setup();
    for (let i = 0; i < 4; i++) scheduler.createSchedule({ goalId: goal.id, cron: `0 ${i} * * *`, prompt: "p" });
    // The fifth is still allowed.
    expect(tool.precheck?.({ cron: "0 20 * * *", prompt: "x" }, ctx)).toBeNull();
    scheduler.createSchedule({ goalId: goal.id, cron: "0 4 * * *", prompt: "p" });
    expect(tool.precheck?.({ cron: "0 20 * * *", prompt: "x" }, ctx)).toMatch(/already has 5 schedules/);
    expect(await tool.execute({ cron: "0 20 * * *", prompt: "x" }, ctx)).toMatch(/^Error/);
    expect(db.select().from(schedules).all()).toHaveLength(5);
    db.delete(schedules).run();
    archiveGoal(db, goal.id);
    expect(tool.precheck?.({ cron: "0 20 * * *", prompt: "x" }, ctx)).toMatch(/archived/);
  });
});

describe("a sixth proposed schedule in a run", () => {
  it("is refused before any card is shown, and nothing is created", async () => {
    const { db, goal, scheduler } = setup();
    for (let i = 0; i < maxPerGoal; i++)
      scheduler.createSchedule({ goalId: goal.id, cron: `0 ${i} * * *`, prompt: "p" });
    const model = new ScriptedModel({
      turns: [
        {
          toolCalls: [
            { id: "c1", name: "propose_schedule", arguments: { cron: "0 20 * * *", prompt: "Evening check-in." } },
          ],
        },
        { text: ["This goal has as many schedules as it can have."] },
      ],
    });
    const engine = new RunEngine(
      db,
      model,
      defaultLimits,
      new ToolRegistry().register(proposeScheduleTool(db, scheduler)),
    );
    const run = engine.start(goal.channelId, "Also check in every evening.");
    await engine.whenSettled(run.id);
    const stored = db.select().from(events).where(eq(events.runId, run.id)).all();
    expect(stored.map((e) => e.type)).not.toContain("approval_request");
    expect(JSON.parse(stored.find((e) => e.type === "tool_result")?.data ?? "{}").result).toMatch(
      /already has 5 schedules/,
    );
    expect(engine.get(run.id).status).toBe("done");
    expect(db.select().from(schedules).all()).toHaveLength(maxPerGoal);
  });
});
