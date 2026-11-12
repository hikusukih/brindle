import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createChannel } from "./channels.js";
import { openDatabase } from "./db/index.js";
import { events, runs } from "./db/schema.js";
import { createGoal } from "./goals.js";
import { type ModelAdapter, ModelError, type ModelEvent, type ModelRequest } from "./model/adapter.js";
import { listReports, reportRunEnded } from "./reports.js";
import { defaultLimits, RunEngine, type RunLimits } from "./runs.js";
import { Scheduler, type SchedulerOptions } from "./scheduler.js";
import { type ToolContext, ToolRegistry } from "./tools/registry.js";

// The goals note's "Waiting for room" and unattended-approval scenarios, run against the real engine and the
// scheduler wired the way the server wires them. The scheduler's own arithmetic is in scheduler.test.ts.

const at = (iso: string) => new Date(iso);
// 06:30 in New York is 10:30 UTC on these dates (daylight time).
const daily = "30 6 * * *";
const created = at("2026-10-27T12:00:00Z");
const due = at("2026-10-28T10:30:05Z");

/**
 * A model that answers "ask" with a call to the external `send` tool and anything else with text. While `hold`
 * is set, each request waits for release(), so a test can keep a run busy for as long as it likes.
 */
class GateModel implements ModelAdapter {
  readonly requests: ModelRequest[] = [];
  hold = false;
  private waiting: (() => void)[] = [];

  release() {
    for (const go of this.waiting.splice(0)) go();
  }

  async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    this.requests.push(request);
    if (this.hold) {
      await new Promise<void>((resolve, reject) => {
        this.waiting.push(resolve);
        request.signal?.addEventListener("abort", () => reject(new ModelError("aborted", "aborted", false)));
      });
    }
    const last = request.messages.at(-1);
    if (last?.role === "user" && last.content.includes("ask")) {
      yield { type: "tool_call", call: { id: `send-${this.requests.length}`, name: "send", arguments: {} } };
      yield { type: "done", stop: "tool_use", usage: { inputTokens: 0, outputTokens: 0 } };
      return;
    }
    yield { type: "text", text: "done" };
    yield { type: "done", stop: "end", usage: { inputTokens: 0, outputTokens: 0 } };
  }
}

async function waitUntil(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(check()).toBe(true);
}

function setup(
  options: {
    limits?: Partial<RunLimits>;
    scheduler?: Partial<SchedulerOptions>;
    db?: ReturnType<typeof openDatabase>;
  } = {},
) {
  const db = options.db ?? openDatabase(":memory:");
  const model = new GateModel();
  const scopes: ToolContext["scope"][] = [];
  const tools = new ToolRegistry().register({
    name: "send",
    description: "Send something.",
    effect: "external",
    parameters: { type: "object", properties: {} },
    execute: async (_args, ctx) => {
      scopes.push(ctx.scope);
      return "sent";
    },
  });
  const engine = new RunEngine(db, model, { ...defaultLimits, ...options.limits }, tools);
  const scheduler = new Scheduler(db, engine.schedulerHooks(), {
    timeZone: "America/New_York",
    ...options.scheduler,
  });
  const goal = (title: string, prompt = "go", cron = daily) => {
    const g = createGoal(db, { title, brief: "Keep at it." });
    const schedule = scheduler.createSchedule({ goalId: g.id, cron, prompt }, created);
    return { ...g, schedule };
  };
  const startedRuns = () => scheduler.log().flatMap((f) => (f.state === "started" && f.runId ? [f.runId] : []));
  const status = (runId: string) => engine.get(runId).status;
  return { db, model, engine, scheduler, goal, scopes, startedRuns, status };
}

describe("scheduled runs", () => {
  it("a fire becomes a goal-scoped run in the goal's channel with the task prompt as its message", async () => {
    const { db, engine, scheduler, goal, startedRuns } = setup();
    const g = goal("Morning brief", "Write today's brief.");
    scheduler.tick(due);
    const [runId] = startedRuns();
    await engine.whenSettled(runId as string);

    expect(engine.get(runId as string)).toMatchObject({
      channelId: g.channelId,
      goalId: g.id,
      trigger: "schedule",
      status: "done",
    });
    const first = db
      .select()
      .from(events)
      .where(eq(events.runId, runId as string))
      .orderBy(events.seq)
      .get();
    expect(first).toMatchObject({ type: "message", data: JSON.stringify({ text: "Write today's brief." }) });
  });

  it("tools in a scheduled run see the goal as the scope; tools in the user's runs see the channel", async () => {
    const { engine, scheduler, goal, scopes, startedRuns } = setup();
    const g = goal("Watcher", "ask");
    scheduler.tick(due);
    const [runId] = startedRuns();
    await waitUntil(() => engine.get(runId as string).status === "waiting");
    engine.decide(runId as string, "send-1", "approve");
    await engine.whenSettled(runId as string);

    const mine = engine.start(g.channelId, "ask");
    await waitUntil(() => engine.get(mine.id).status === "waiting");
    engine.decide(mine.id, "send-3", "approve");
    await engine.whenSettled(mine.id);
    expect(scopes).toEqual([
      { kind: "goal", id: g.id },
      { kind: "channel", id: g.channelId },
    ]);
  });

  it("with the overall cap full, a due fire waits and starts when a run ends; past its window it is skipped", async () => {
    const { model, engine, scheduler, goal, startedRuns, status } = setup({ scheduler: { maxConcurrent: 1 } });
    model.hold = true;
    goal("A");
    goal("B");
    scheduler.tick(due);
    expect(startedRuns()).toHaveLength(1);
    expect(scheduler.log().filter((f) => f.state === "waiting")).toHaveLength(1);

    const [first] = startedRuns();
    model.release();
    await engine.whenSettled(first as string);
    scheduler.tick(at("2026-10-28T10:31:00Z"));
    expect(startedRuns()).toHaveLength(2);
    expect(status(startedRuns()[1] as string)).toBe("running");

    // A third goal whose fire never gets room ages out after the 6-hour window.
    const late = goal("C", "go", "0 7 * * *");
    scheduler.tick(at("2026-10-28T11:00:05Z"));
    scheduler.tick(at("2026-10-28T17:00:06Z"));
    expect(scheduler.log(late.schedule.id).map((f) => f.state)).toEqual(["skipped_busy"]);
    model.hold = false;
    model.release();
  });

  it("two goals' runs parked on approvals leave room for a third goal's fire", async () => {
    const { engine, scheduler, goal, startedRuns, status } = setup();
    goal("A", "ask");
    goal("B", "ask");
    scheduler.tick(due);
    const parked = startedRuns();
    expect(parked).toHaveLength(2);
    await waitUntil(() => parked.every((id) => status(id) === "waiting"));

    goal("C", "go", "0 7 * * *");
    scheduler.tick(at("2026-10-28T11:00:05Z"));
    expect(startedRuns()).toHaveLength(3);
    for (const id of parked) engine.cancel(id);
  });

  it("a goal never has two runs at once, counting the user's run in its channel", async () => {
    const { model, engine, scheduler, goal, startedRuns } = setup();
    const g = goal("Rust");
    model.hold = true;
    const mine = engine.start(g.channelId, "a question of my own");
    scheduler.tick(due);
    expect(startedRuns()).toEqual([]);
    expect(scheduler.log().map((f) => f.state)).toEqual(["waiting"]);

    model.release();
    await engine.whenSettled(mine.id);
    scheduler.tick(at("2026-10-28T10:31:00Z"));
    expect(startedRuns()).toHaveLength(1);

    // And the other way round: while the scheduled run is going, the user's message in that channel is refused.
    expect(() => engine.start(g.channelId, "another")).toThrow(/still working/);
    model.hold = false;
    model.release();
  });

  it("a newer occurrence replaces an older one still waiting on a busy goal", async () => {
    const { model, engine, scheduler, goal } = setup();
    const g = goal("Hourly", "go", "0 * * * *");
    model.hold = true;
    const mine = engine.start(g.channelId, "busy");
    scheduler.tick(at("2026-10-28T10:00:05Z"));
    scheduler.tick(at("2026-10-28T11:00:05Z"));
    // The schedule was made the day before, so the earlier hours are logged as missed.
    const states = scheduler.log(g.schedule.id).flatMap((f) => (f.state === "missed" ? [] : [f.state]));
    expect(states).toEqual(["skipped_busy", "waiting"]);
    model.hold = false;
    model.release();
    await engine.whenSettled(mine.id);
  });

  it("the user's message in another channel starts at once with the cap full", async () => {
    const { db, model, engine, scheduler, goal, startedRuns } = setup({ scheduler: { maxConcurrent: 1 } });
    model.hold = true;
    goal("A");
    scheduler.tick(due);
    expect(startedRuns()).toHaveLength(1);
    const other = createChannel(db, "Elsewhere");
    const mine = engine.start(other.id, "hello");
    expect(mine.status).toBe("running");
    model.hold = false;
    model.release();
    await engine.whenSettled(mine.id);
    expect(engine.get(mine.id).status).toBe("done");
  });

  it("a scheduled run's unanswered approval ends as 'approval not given' on the shorter timeout", async () => {
    const { engine, scheduler, goal, startedRuns } = setup({
      limits: { scheduledApprovalMillis: 20, approvalMillis: 60_000 },
    });
    const g = goal("Watcher", "ask");
    scheduler.tick(due);
    const [runId] = startedRuns();
    await engine.whenSettled(runId as string);
    expect(engine.get(runId as string)).toMatchObject({ status: "stopped", stopReason: "approval not given" });

    // The user's own run in the same channel keeps the longer one.
    const mine = engine.start(g.channelId, "ask");
    await waitUntil(() => engine.get(mine.id).status === "waiting");
    await new Promise((r) => setTimeout(r, 60));
    expect(engine.get(mine.id).status).toBe("waiting");
    engine.cancel(mine.id);
  });

  it("the default timeout for a scheduled run is 12 hours", () => {
    expect(defaultLimits.scheduledApprovalMillis).toBe(12 * 60 * 60 * 1000);
  });

  it("after a restart, a scheduled run still waiting on an approval times out from when it asked", async () => {
    // What a previous process left behind: a scheduled run parked on a card, with no loop to time it out.
    const { db, engine, goal, status } = setup({ limits: { scheduledApprovalMillis: 60_000 } });
    const g = goal("Watcher");
    const asked = (offset: number, trigger: "user" | "schedule") => {
      const id = `${trigger}-run`;
      db.insert(runs)
        .values({ id, channelId: g.channelId, status: "waiting", startedAt: "x", goalId: g.id, trigger })
        .run();
      db.insert(events)
        .values({
          id: `${id}-ask`,
          runId: id,
          seq: 1,
          type: "approval_request",
          data: JSON.stringify({ callId: "c1", tool: "send", arguments: {}, step: 1, tokens: 0, spentMillis: 0 }),
          createdAt: new Date(Date.now() - offset).toISOString(),
        })
        .run();
      return id;
    };
    // Asked 59.98 seconds ago against a 60-second timeout: the remainder, not a fresh minute, is left.
    const scheduled = asked(59_980, "schedule");
    // The same age against the user's 24 hours leaves it waiting.
    const mine = asked(59_980, "user");
    expect(engine.watchWaiting()).toBe(2);
    await waitUntil(() => status(scheduled) === "stopped");
    expect(engine.get(scheduled).stopReason).toBe("approval not given");
    expect(status(mine)).toBe("waiting");
  });

  it("a restart between preparing a run and beginning it records failed_to_start and starts nothing twice", () => {
    const first = setup();
    const g = first.goal("Brief");
    // The crash: the fire is marked started and its run's row committed, but beginRun never happens.
    const hooks = first.engine.schedulerHooks();
    const crashing = new Scheduler(first.db, { ...hooks, beginRun: () => {} }, { timeZone: "America/New_York" });
    crashing.tick(due);
    const [runId] = first.startedRuns();

    // Startup, in the server's order: the engine's recovery, then the scheduler's.
    const second = setup({ db: first.db });
    second.engine.recoverInterrupted();
    second.scheduler.recover(at("2026-10-28T10:31:00Z"));
    expect(second.scheduler.log(g.schedule.id).map((f) => f.state)).toEqual(["failed_to_start"]);
    expect(second.engine.get(runId as string).status).toBe("failed");
    expect(first.db.select().from(runs).all()).toHaveLength(1);
  });

  it("a fire with no model configured fails to start and is not retried", () => {
    const db = openDatabase(":memory:");
    const engine = new RunEngine(db, () => {
      throw new Error("No model is configured.");
    });
    const scheduler = new Scheduler(db, engine.schedulerHooks(), { timeZone: "America/New_York" });
    const g = createGoal(db, { title: "Brief", brief: "Keep at it." });
    scheduler.createSchedule({ goalId: g.id, cron: daily, prompt: "go" }, created);
    scheduler.tick(due);
    scheduler.tick(at("2026-10-28T10:31:00Z"));
    expect(scheduler.log().map((f) => f.state)).toEqual(["failed_to_start"]);
    expect(db.select().from(runs).all()).toEqual([]);
  });

  // The reports store landed apart from this wiring; this holds the two together the way main.ts wires them.
  it("a scheduled run that ends leaves a run report on its goal", async () => {
    const { db, engine, scheduler, goal, startedRuns } = setup();
    engine.onRunEnded = (runId) => reportRunEnded(db, runId);
    const g = goal("Morning brief", "Write today's brief.");
    scheduler.tick(due);
    const [runId] = startedRuns();
    await engine.whenSettled(runId as string);

    expect(listReports(db, { kind: "run", scope: { kind: "goal", id: g.id } })).toMatchObject([
      { runId, title: "Morning brief: run finished", body: "done" },
    ]);
  });
});
