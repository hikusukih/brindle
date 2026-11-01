import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { events, runs, scheduleFires, schedules } from "./db/schema.js";

// See docs/design/goals.md. Starting values, tuned from the log.
const hour = 60 * 60 * 1000;

export type Schedule = typeof schedules.$inferSelect;
export type Fire = typeof scheduleFires.$inferSelect;
export type MissedPolicy = "catch_up_once" | "skip";

export type SchedulerOptions = {
  /** The user's IANA time zone; every cron expression is read in it. */
  timeZone: string;
  pollMillis?: number;
  /** How late an occurrence may still run, whether it was missed or is waiting for room. */
  graceMillis?: number;
  /** Scheduled runs at once across the server. */
  maxConcurrent?: number;
};

export type SchedulerHooks = {
  /** Inside the transaction that marks a fire started: create the run's row and return its id. Nothing may run yet. */
  prepareRun(schedule: Schedule, fire: Fire): string;
  /** After that transaction commits: let the prepared run go. */
  beginRun(runId: string): void;
  /** True while the goal has a run going, scheduled or the user's, including one waiting on an approval. */
  goalBusy(goalId: string): boolean;
};

export class SchedulerError extends Error {}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly pollMillis: number;
  private readonly graceMillis: number;
  private readonly maxConcurrent: number;

  constructor(
    private readonly db: Db,
    private readonly hooks: SchedulerHooks,
    private readonly options: SchedulerOptions,
  ) {
    this.pollMillis = options.pollMillis ?? 30_000;
    this.graceMillis = options.graceMillis ?? 6 * hour;
    this.maxConcurrent = options.maxConcurrent ?? 2;
    // A bad zone would otherwise fail every schedule on every poll with an error that doesn't name it.
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: options.timeZone });
    } catch {
      throw new SchedulerError(`"${options.timeZone}" is not a time zone I know.`);
    }
  }

  createSchedule(
    args: { goalId: string; cron: string; prompt: string; missedPolicy?: MissedPolicy; enabled?: boolean },
    now = new Date(),
  ): Schedule {
    const next = this.after(args.cron, now);
    const row: Schedule = {
      id: randomUUID(),
      goalId: args.goalId,
      cron: args.cron,
      prompt: args.prompt,
      destination: "channel",
      enabled: args.enabled ?? true,
      nextFireAt: next.toISOString(),
      missedPolicy: args.missedPolicy ?? "catch_up_once",
      createdAt: now.toISOString(),
    };
    this.db.insert(schedules).values(row).run();
    return row;
  }

  /** The next occurrences of an expression in the user's zone, for showing before anything is created. */
  upcoming(cron: string, count: number, from = new Date()): Date[] {
    const found: Date[] = [];
    let at = from;
    for (let i = 0; i < count; i++) {
      at = this.after(cron, at);
      found.push(at);
    }
    return found;
  }

  get timeZone(): string {
    return this.options.timeZone;
  }

  /** Disabling stops new occurrences; enabling picks up from the next one after now, never from the time it was off. */
  setEnabled(scheduleId: string, enabled: boolean, now = new Date()) {
    const schedule = this.db.select().from(schedules).where(eq(schedules.id, scheduleId)).get();
    if (!schedule) throw new SchedulerError("No such schedule.");
    const nextFireAt = enabled ? this.after(schedule.cron, now).toISOString() : null;
    this.db.update(schedules).set({ enabled, nextFireAt }).where(eq(schedules.id, scheduleId)).run();
  }

  /** What fired, oldest first. */
  log(scheduleId?: string): Fire[] {
    const query = this.db.select().from(scheduleFires);
    return (scheduleId ? query.where(eq(scheduleFires.scheduleId, scheduleId)) : query)
      .orderBy(asc(scheduleFires.dueAt), asc(scheduleFires.createdAt))
      .all();
  }

  /**
   * Run once at startup, before the first poll. A fire left "started" whose run never wrote an event
   * crashed between commit and beginning; it is recorded, not retried, so the worst case is one missed run.
   */
  recover(now = new Date()): number {
    const started = this.db.select().from(scheduleFires).where(eq(scheduleFires.state, "started")).all();
    let failed = 0;
    for (const fire of started) {
      const began =
        fire.runId !== null &&
        this.db.select({ id: events.id }).from(events).where(eq(events.runId, fire.runId)).limit(1).get();
      if (began) continue;
      this.db
        .update(scheduleFires)
        .set({ state: "failed_to_start", updatedAt: now.toISOString() })
        .where(eq(scheduleFires.id, fire.id))
        .run();
      failed++;
    }
    this.tick(now);
    return failed;
  }

  start() {
    this.stop();
    // An exception escaping a timer ends the process; a failed poll is logged and the next one tries again.
    this.timer = setInterval(() => {
      try {
        this.tick();
      } catch (error) {
        console.error(`Scheduler poll failed: ${(error as Error).message}`);
      }
    }, this.pollMillis);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One poll: bring due occurrences in as fires, then start what there is room for. */
  tick(now = new Date()) {
    this.comeDue(now);
    this.startWaiting(now);
  }

  private after(cron: string, from: Date): Date {
    let next: Date | null;
    try {
      next = new Cron(cron, { timezone: this.options.timeZone, paused: true }).nextRun(from);
    } catch (error) {
      throw new SchedulerError(`"${cron}" is not a schedule I can read: ${(error as Error).message}`);
    }
    if (!next) throw new SchedulerError(`"${cron}" never comes due.`);
    return next;
  }

  private comeDue(now: Date) {
    const due = this.db.select().from(schedules).where(eq(schedules.enabled, true)).all();
    for (const schedule of due) {
      if (!schedule.nextFireAt || schedule.nextFireAt > now.toISOString()) continue;
      // One unreadable row must not stop the poll for the others, and an exception in a timer ends the process.
      try {
        this.comeDueOne(schedule, now);
      } catch (error) {
        console.error(`Schedule ${schedule.id} skipped this poll: ${(error as Error).message}`);
      }
    }
  }

  private comeDueOne(schedule: Schedule, now: Date) {
    const occurrences: Date[] = [];
    let at = new Date(schedule.nextFireAt as string);
    // Capped so a once-a-minute schedule on a host that slept for months can't spin.
    while (at <= now && occurrences.length < 10_000) {
      occurrences.push(at);
      at = this.after(schedule.cron, at);
    }
    if (at <= now) {
      console.warn(
        `Schedule ${schedule.id}: more than 10,000 occurrences were missed; the latest ones are not logged.`,
      );
    }
    const last = occurrences.at(-1) as Date;
    const onTime = occurrences.length === 1 && now.getTime() - last.getTime() <= 2 * this.pollMillis;
    const runsLast =
      onTime || (schedule.missedPolicy === "catch_up_once" && now.getTime() - last.getTime() <= this.graceMillis);
    const next = this.after(schedule.cron, now);
    const stamp = now.toISOString();

    this.db.transaction((tx) => {
      for (const occurrence of occurrences) {
        const isLast = occurrence === last;
        if (isLast && runsLast) {
          // At most one waiting fire per schedule: a newer one replaces an older that never got room.
          tx.update(scheduleFires)
            .set({ state: "skipped_busy", updatedAt: stamp })
            .where(and(eq(scheduleFires.scheduleId, schedule.id), eq(scheduleFires.state, "waiting")))
            .run();
        }
        tx.insert(scheduleFires)
          .values({
            id: randomUUID(),
            scheduleId: schedule.id,
            dueAt: occurrence.toISOString(),
            state: isLast && runsLast ? "waiting" : "missed",
            runId: null,
            createdAt: stamp,
            updatedAt: stamp,
          })
          .onConflictDoNothing()
          .run();
      }
      tx.update(schedules).set({ nextFireAt: next.toISOString() }).where(eq(schedules.id, schedule.id)).run();
    });
  }

  private startWaiting(now: Date) {
    const waiting = this.db
      .select()
      .from(scheduleFires)
      .where(eq(scheduleFires.state, "waiting"))
      .orderBy(asc(scheduleFires.dueAt))
      .all();
    let inFlight = this.scheduledRunning();
    const claimed = new Set<string>();
    for (const fire of waiting) {
      const stamp = now.toISOString();
      const schedule = this.db.select().from(schedules).where(eq(schedules.id, fire.scheduleId)).get();
      if (!schedule) continue;
      // Archiving a goal disables its schedules; a fire already waiting must not start a run for it afterward.
      if (!schedule.enabled) {
        this.mark(fire.id, "skipped_disabled", stamp);
        continue;
      }
      if (now.getTime() - new Date(fire.dueAt).getTime() > this.graceMillis) {
        this.mark(fire.id, "skipped_busy", stamp);
        continue;
      }
      if (inFlight >= this.maxConcurrent || claimed.has(schedule.goalId)) continue;
      let busy: boolean;
      try {
        busy = this.hooks.goalBusy(schedule.goalId);
      } catch (error) {
        // Can't tell, so leave it waiting; the grace window still bounds how long.
        console.error(`Fire ${fire.id} left waiting: ${(error as Error).message}`);
        continue;
      }
      if (busy) continue;
      let runId = "";
      try {
        this.db.transaction((tx) => {
          runId = this.hooks.prepareRun(schedule, fire);
          tx.update(scheduleFires)
            .set({ state: "started", runId, updatedAt: stamp })
            .where(eq(scheduleFires.id, fire.id))
            .run();
        });
      } catch (error) {
        // Recorded, not retried, as recover() does: a run that fails to prepare would fail again every poll.
        console.error(`Fire ${fire.id} failed to start: ${(error as Error).message}`);
        this.mark(fire.id, "failed_to_start", stamp);
        continue;
      }
      claimed.add(schedule.goalId);
      inFlight++;
      try {
        this.hooks.beginRun(runId);
      } catch (error) {
        // The run row exists but never began; recording it now saves waiting for recover() at the next restart.
        console.error(`Fire ${fire.id} failed to start: ${(error as Error).message}`);
        this.mark(fire.id, "failed_to_start", stamp);
        inFlight--;
      }
    }
  }

  /** Scheduled runs using compute: started fires whose run is going. One parked on an approval uses none and doesn't count. */
  private scheduledRunning(): number {
    const row = this.db
      .select({ n: sql<number>`count(*)` })
      .from(scheduleFires)
      .innerJoin(runs, eq(runs.id, scheduleFires.runId))
      .where(and(eq(scheduleFires.state, "started"), inArray(runs.status, ["running"])))
      .get();
    return row?.n ?? 0;
  }

  private mark(fireId: string, state: Fire["state"], stamp: string) {
    this.db.update(scheduleFires).set({ state, updatedAt: stamp }).where(eq(scheduleFires.id, fireId)).run();
  }
}
