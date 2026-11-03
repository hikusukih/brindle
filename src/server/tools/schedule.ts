import { eq } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { goals, schedules } from "../db/schema.js";
import type { Scheduler } from "../scheduler.js";
import type { Tool } from "./registry.js";

// A schedule that fires more often than this is almost certainly a mistake, and every fire is a model run.
const minGapMillis = 15 * 60_000;
const maxPerGoal = 10;

/**
 * `external`, on purpose: the approval card is how a schedule is "proposed and confirmed" (docs/design/goals.md), so
 * the agent never creates one by itself. The card shows the user's own words back as the next few dates and times in
 * their time zone, which is easier to check than a cron expression.
 *
 * The model turns plain words into the expression; this tool checks that it parses, that it is not more often than
 * every 15 minutes and that the run is in a goal's own channel. A cron expression cannot say "every other week", so
 * the description tells the model to say so rather than propose something that only looks like it.
 */
export function proposeScheduleTool(db: Db, scheduler: Scheduler): Tool {
  const goalOf = (channelId: string) => db.select().from(goals).where(eq(goals.channelId, channelId)).get();

  const problem = (args: Record<string, unknown>, channelId: string): string | null => {
    const goal = goalOf(channelId);
    if (!goal)
      return "Error: schedules belong to goals, and this channel is not a goal's. Suggest creating a goal first.";
    if (goal.status === "archived")
      return "Error: this goal is archived; the user must restore it before it can be scheduled.";
    const existing = db.select().from(schedules).where(eq(schedules.goalId, goal.id)).all().length;
    if (existing >= maxPerGoal) return `Error: this goal already has ${maxPerGoal} schedules, the most it can have.`;
    let next: Date[];
    try {
      next = scheduler.upcoming(String(args.cron), 5);
    } catch (error) {
      return `Error: ${(error as Error).message} Use five fields: minute hour day-of-month month day-of-week.`;
    }
    // The first gap alone can be a long one (":00 and :10" asked at :11), so look across several.
    const gaps = next.slice(1).map((d, i) => d.getTime() - (next[i] as Date).getTime());
    if (gaps.some((gap) => gap < minGapMillis))
      return "Error: that would fire more than once every 15 minutes. Propose a less frequent schedule.";
    return null;
  };

  const show = (d: Date) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: scheduler.timeZone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(d);

  return {
    name: "propose_schedule",
    description:
      "Propose a recurring schedule for this goal. The user sees it as a card and nothing is scheduled until they approve. " +
      "Turn their words into a five-field cron expression (minute hour day-of-month month day-of-week) read in the user's own time zone, " +
      'and a prompt saying what each run should do. Examples: "twice a day" is "0 8,20 * * *"; "weekdays at 6:30" is "30 6 * * 1-5"; ' +
      '"every Sunday at 9" is "0 9 * * 0". A schedule cannot skip alternate weeks, so for "every other Sunday" do not pretend: ' +
      "propose every Sunday and tell the user plainly that it will be weekly. Never more often than every 15 minutes. " +
      "If their words do not say a time, ask them instead of choosing one.",
    effect: "external",
    parameters: {
      type: "object",
      properties: {
        cron: { type: "string" },
        prompt: { type: "string" },
        missedPolicy: { type: "string", enum: ["catch_up_once", "skip"] },
      },
      required: ["cron", "prompt"],
    },
    precheck: (args, ctx) => problem(args, ctx.scope.id),
    describeCall(args) {
      try {
        const when = scheduler.upcoming(String(args.cron), 3).map(show).join("; ");
        return `Schedule "${String(args.prompt).slice(0, 120)}" (${String(args.cron)}). Next: ${when} (${scheduler.timeZone})`;
      } catch {
        return `Schedule "${String(args.prompt).slice(0, 120)}" (${String(args.cron)})`;
      }
    },
    async execute(args, ctx) {
      const refused = problem(args, ctx.scope.id);
      if (refused) return refused;
      const goal = goalOf(ctx.scope.id);
      if (!goal) return "Error: this channel is not a goal's.";
      const policy = args.missedPolicy === "skip" ? "skip" : "catch_up_once";
      const row = scheduler.createSchedule({
        goalId: goal.id,
        cron: String(args.cron),
        prompt: String(args.prompt),
        missedPolicy: policy,
      });
      return `Scheduled (${row.cron}). The next run is ${show(new Date(row.nextFireAt as string))} (${scheduler.timeZone}).`;
    },
  };
}
