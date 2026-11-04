import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createChannel } from "./channels.js";
import { openDatabase } from "./db/index.js";
import { events, runs, schedules } from "./db/schema.js";
import { Scheduler, SchedulerError, type SchedulerHooks, type SchedulerOptions } from "./scheduler.js";

const at = (iso: string) => new Date(iso);
const daily = "30 6 * * *";

function setup(options: Partial<SchedulerOptions> = {}, existing?: ReturnType<typeof openDatabase>) {
  const db = existing ?? openDatabase(":memory:");
  const channel = createChannel(db, "Goal");
  const begun: string[] = [];
  const busy = new Set<string>();
  const hooks: SchedulerHooks = {
    prepareRun: () => {
      const id = `run-${db.select().from(runs).all().length + 1}`;
      db.insert(runs)
        .values({
          id,
          channelId: channel.id,
          status: "running",
          stopReason: null,
          startedAt: new Date().toISOString(),
          endedAt: null,
        })
        .run();
      return id;
    },
    beginRun: (id) => begun.push(id),
    goalBusy: (goalId) => busy.has(goalId),
  };
  const make = () => new Scheduler(db, hooks, { timeZone: "America/New_York", ...options });
  return { db, scheduler: make(), make, hooks, begun, busy };
}

const states = (s: Scheduler) => s.log().map((f) => `${f.dueAt.slice(0, 16)} ${f.state}`);

describe("scheduler", () => {
  it("reads cron in the user's time zone, on both sides of a daylight saving change", () => {
    const { scheduler } = setup({ maxConcurrent: 10 });
    const s = scheduler.createSchedule({ goalId: "g", cron: daily, prompt: "go" }, at("2026-10-30T12:00:00Z"));
    for (const day of ["2026-10-31", "2026-11-01", "2026-11-02"]) {
      scheduler.tick(at(`${day}T23:00:00Z`));
    }
    expect(s.nextFireAt).toBe("2026-10-31T10:30:00.000Z");
    expect(scheduler.log().map((f) => f.dueAt)).toEqual([
      "2026-10-31T10:30:00.000Z",
      "2026-11-01T11:30:00.000Z",
      "2026-11-02T11:30:00.000Z",
    ]);
  });

  it("logs an occurrence that is already due when the zone changes, then moves the next one", () => {
    const { db, scheduler } = setup({ maxConcurrent: 10 });
    const s = scheduler.createSchedule({ goalId: "g", cron: daily, prompt: "go" }, at("2026-10-27T12:00:00Z"));
    scheduler.setTimeZone("Asia/Tokyo", at("2026-10-28T10:30:05Z"));
    expect(scheduler.log().map((f) => f.dueAt)).toEqual(["2026-10-28T10:30:00.000Z"]);
    const row = db.select().from(schedules).where(eq(schedules.id, s.id)).get();
    expect((row?.nextFireAt ?? "") > "2026-10-28T10:30:05Z").toBe(true);
  });

  it("starts an occurrence once, however often it polls and however often it restarts", () => {
    const { db, scheduler, make, begun } = setup();
    scheduler.createSchedule({ goalId: "g", cron: daily, prompt: "go" }, at("2026-10-27T12:00:00Z"));
    scheduler.tick(at("2026-10-28T10:30:05Z"));
    scheduler.tick(at("2026-10-28T10:30:35Z"));
    // The run got going before the restart.
    db.insert(events).values({ id: "e", runId: "run-1", seq: 1, type: "message", data: "{}", createdAt: "x" }).run();
    make().recover(at("2026-10-28T10:31:00Z"));
    make().tick(at("2026-10-28T10:31:30Z"));
    expect(begun).toHaveLength(1);
    expect(states(scheduler)).toEqual(["2026-10-28T10:30 started"]);
  });

  it("catches up once after downtime when the last miss is inside the grace window, and logs the rest", () => {
    const { scheduler, begun } = setup();
    scheduler.createSchedule({ goalId: "g", cron: daily, prompt: "go" }, at("2026-10-20T12:00:00Z"));
    scheduler.tick(at("2026-10-28T13:00:00Z")); // 09:00 local
    expect(begun).toHaveLength(1);
    const log = states(scheduler);
    expect(log.filter((l) => l.endsWith("missed"))).toHaveLength(7);
    expect(log.at(-1)).toBe("2026-10-28T10:30 started");
  });

  it("runs nothing after downtime when the last miss is past the grace window", () => {
    const { scheduler, begun } = setup();
    scheduler.createSchedule({ goalId: "g", cron: daily, prompt: "go" }, at("2026-10-27T12:00:00Z"));
    scheduler.tick(at("2026-10-29T00:00:00Z")); // 20:00 local
    expect(begun).toHaveLength(0);
    expect(states(scheduler)).toEqual(["2026-10-28T10:30 missed"]);
  });

  it("the skip policy runs no catch-up", () => {
    const { scheduler, begun } = setup();
    scheduler.createSchedule(
      { goalId: "g", cron: daily, prompt: "go", missedPolicy: "skip" },
      at("2026-10-27T12:00:00Z"),
    );
    scheduler.tick(at("2026-10-28T13:00:00Z"));
    expect(begun).toHaveLength(0);
    expect(states(scheduler)).toEqual(["2026-10-28T10:30 missed"]);
  });

  it("a fire waits for room, then starts; once past the grace window it is skipped", () => {
    const { db, scheduler, begun } = setup({ maxConcurrent: 1 });
    scheduler.createSchedule({ goalId: "a", cron: daily, prompt: "go" }, at("2026-10-27T12:00:00Z"));
    scheduler.createSchedule({ goalId: "b", cron: daily, prompt: "go" }, at("2026-10-27T12:00:00Z"));
    scheduler.tick(at("2026-10-28T10:30:05Z"));
    expect(begun).toHaveLength(1);
    expect(states(scheduler).sort()).toEqual(["2026-10-28T10:30 started", "2026-10-28T10:30 waiting"]);

    db.update(runs)
      .set({ status: "done" })
      .where(eq(runs.id, begun[0] as string))
      .run();
    scheduler.tick(at("2026-10-28T10:31:00Z"));
    expect(begun).toHaveLength(2);

    // A third goal's fire never gets room and ages out.
    scheduler.createSchedule({ goalId: "c", cron: "0 7 * * *", prompt: "go" }, at("2026-10-28T11:00:00Z"));
    scheduler.tick(at("2026-10-28T11:00:01Z"));
    scheduler.tick(at("2026-10-28T11:00:02Z"));
    expect(states(scheduler).filter((l) => l.endsWith("waiting"))).toEqual([]);
  });

  it("a run parked on an approval does not use up room", () => {
    const { db, scheduler, begun } = setup({ maxConcurrent: 1 });
    scheduler.createSchedule({ goalId: "a", cron: daily, prompt: "go" }, at("2026-10-27T12:00:00Z"));
    scheduler.createSchedule({ goalId: "b", cron: daily, prompt: "go" }, at("2026-10-27T12:00:00Z"));
    scheduler.tick(at("2026-10-28T10:30:05Z"));
    db.update(runs)
      .set({ status: "waiting" })
      .where(eq(runs.id, begun[0] as string))
      .run();
    scheduler.tick(at("2026-10-28T10:30:40Z"));
    expect(begun).toHaveLength(2);
  });

  it("never starts two runs for one goal, and a newer occurrence replaces an older waiting one", () => {
    const { scheduler, begun, busy } = setup();
    scheduler.createSchedule({ goalId: "g", cron: "0 * * * *", prompt: "go" }, at("2026-10-28T08:30:00Z"));
    busy.add("g");
    scheduler.tick(at("2026-10-28T09:00:05Z"));
    scheduler.tick(at("2026-10-28T10:00:05Z"));
    expect(begun).toHaveLength(0);
    expect(states(scheduler)).toEqual(["2026-10-28T09:00 skipped_busy", "2026-10-28T10:00 waiting"]);
    busy.delete("g");
    scheduler.tick(at("2026-10-28T10:00:35Z"));
    expect(begun).toHaveLength(1);
  });

  it("a waiting fire survives a restart", () => {
    const { db, scheduler, make, begun, busy } = setup();
    scheduler.createSchedule({ goalId: "g", cron: daily, prompt: "go" }, at("2026-10-27T12:00:00Z"));
    busy.add("g");
    scheduler.tick(at("2026-10-28T10:30:05Z"));
    busy.clear();
    const restarted = make();
    restarted.recover(at("2026-10-28T10:45:00Z"));
    expect(begun).toHaveLength(1);
    expect(db.select().from(runs).all()).toHaveLength(1);
  });

  it("records a fire whose run never began as failed_to_start, and does not retry it", () => {
    const { scheduler, make, begun } = setup();
    scheduler.createSchedule({ goalId: "g", cron: daily, prompt: "go" }, at("2026-10-27T12:00:00Z"));
    scheduler.tick(at("2026-10-28T10:30:05Z"));
    expect(make().recover(at("2026-10-28T10:31:00Z"))).toBe(1);
    expect(states(scheduler)).toEqual(["2026-10-28T10:30 failed_to_start"]);
    expect(begun).toHaveLength(1);

    // A run that wrote events did begin; the run engine marks it interrupted.
    const { db: db2, scheduler: s2, make: make2 } = setup();
    s2.createSchedule({ goalId: "g", cron: daily, prompt: "go" }, at("2026-10-27T12:00:00Z"));
    s2.tick(at("2026-10-28T10:30:05Z"));
    db2.insert(events).values({ id: "e", runId: "run-1", seq: 1, type: "message", data: "{}", createdAt: "x" }).run();
    expect(make2().recover(at("2026-10-28T10:31:00Z"))).toBe(0);
  });

  it("disabling stops occurrences; enabling resumes from the next one", () => {
    const { scheduler, begun } = setup();
    const s = scheduler.createSchedule({ goalId: "g", cron: daily, prompt: "go" }, at("2026-10-27T12:00:00Z"));
    scheduler.setEnabled(s.id, false);
    scheduler.tick(at("2026-10-28T10:30:05Z"));
    expect(begun).toHaveLength(0);
    scheduler.setEnabled(s.id, true, at("2026-10-28T12:00:00Z"));
    scheduler.tick(at("2026-10-29T10:30:05Z"));
    expect(states(scheduler)).toEqual(["2026-10-29T10:30 started"]);
  });

  it("a waiting fire for a schedule that was disabled meanwhile never starts", () => {
    const { scheduler, begun, busy } = setup();
    const s = scheduler.createSchedule({ goalId: "g", cron: daily, prompt: "go" }, at("2026-10-27T12:00:00Z"));
    busy.add("g");
    scheduler.tick(at("2026-10-28T10:30:05Z"));
    expect(states(scheduler)).toEqual(["2026-10-28T10:30 waiting"]);
    scheduler.setEnabled(s.id, false);
    busy.clear();
    scheduler.tick(at("2026-10-28T11:00:00Z"));
    expect(begun).toHaveLength(0);
    expect(states(scheduler)).toEqual(["2026-10-28T10:30 skipped_disabled"]);
  });

  it("one schedule with an unreadable cron expression does not stop the others or the poll", () => {
    const { db, scheduler, begun } = setup();
    scheduler.createSchedule({ goalId: "bad", cron: daily, prompt: "go" }, at("2026-10-27T12:00:00Z"));
    scheduler.createSchedule({ goalId: "good", cron: daily, prompt: "go" }, at("2026-10-27T12:00:00Z"));
    db.update(schedules).set({ cron: "not a cron" }).where(eq(schedules.goalId, "bad")).run();
    expect(() => scheduler.tick(at("2026-10-28T10:30:05Z"))).not.toThrow();
    expect(begun).toHaveLength(1);
  });

  it("refuses a time zone it doesn't know when it is built", () => {
    expect(() => setup({ timeZone: "Mars/Olympus_Mons" })).toThrow(SchedulerError);
  });

  it("a hook that throws does not escape the poll; a run that fails to prepare or begin is recorded, not retried", () => {
    const { db, scheduler, hooks, begun } = setup();
    scheduler.createSchedule({ goalId: "g", cron: daily, prompt: "go" }, at("2026-10-27T12:00:00Z"));
    const failing = (hook: keyof SchedulerHooks) => {
      const thrower = () => {
        throw new Error(hook);
      };
      return new Scheduler(db, { ...hooks, [hook]: thrower }, { timeZone: "America/New_York" });
    };
    // goalBusy throwing leaves the fire waiting.
    expect(() => failing("goalBusy").tick(at("2026-10-28T10:30:05Z"))).not.toThrow();
    expect(states(scheduler)).toEqual(["2026-10-28T10:30 waiting"]);
    // prepareRun throwing records it and doesn't retry.
    expect(() => failing("prepareRun").tick(at("2026-10-28T10:30:35Z"))).not.toThrow();
    expect(states(scheduler)).toEqual(["2026-10-28T10:30 failed_to_start"]);
    scheduler.tick(at("2026-10-28T10:31:05Z"));
    expect(begun).toHaveLength(0);
    // beginRun throwing records the next day's fire the same way.
    expect(() => failing("beginRun").tick(at("2026-10-29T10:30:05Z"))).not.toThrow();
    expect(states(scheduler)).toEqual(["2026-10-28T10:30 failed_to_start", "2026-10-29T10:30 failed_to_start"]);
  });

  it("refuses an expression it can't read", () => {
    const { scheduler } = setup();
    expect(() => scheduler.createSchedule({ goalId: "g", cron: "every day", prompt: "go" })).toThrow(SchedulerError);
  });
});
