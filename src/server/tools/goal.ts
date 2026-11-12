import type { Db } from "../db/index.js";
import { createGoal, deleteGoal } from "../goals.js";
import type { Scheduler } from "../scheduler.js";
import { briefMaxChars } from "../scope-statements.js";
import type { Tool } from "./registry.js";
import { cronProblem } from "./schedule.js";

const maxTitleChars = 120;

type Draft = { title: string; brief: string; schedule?: { cron: string; prompt: string } };

function readDraft(args: Record<string, unknown>): Draft | string {
  const title = typeof args.title === "string" ? args.title.trim() : "";
  if (!title || title.length > maxTitleChars) return `Error: a goal title is 1 to ${maxTitleChars} characters.`;
  const brief = typeof args.brief === "string" ? args.brief.trim() : "";
  if (!brief) return "Error: a goal needs a brief: what it is and what success looks like.";
  if (brief.length > briefMaxChars) return `Error: the brief is over ${briefMaxChars} characters; shorten it.`;
  const s = args.schedule;
  if (s === undefined || s === null) return { title, brief };
  const { cron, prompt } = (s ?? {}) as { cron?: unknown; prompt?: unknown };
  if (typeof cron !== "string" || typeof prompt !== "string" || !prompt.trim())
    return "Error: a schedule needs a cron expression and a prompt saying what each run should do.";
  return { title, brief, schedule: { cron, prompt: prompt.trim() } };
}

/**
 * `external`, on purpose: the approval card is how a goal is "proposed and confirmed" (docs/design/goals.md), so the
 * agent never creates one by itself. The card shows exactly the title, brief and schedule that will be saved, and
 * approving it creates the goal, its channel and the schedule together or not at all. To change the draft, the user
 * declines and says what to change, or edits the goal afterwards; the saved brief is the text they approved.
 */
export function proposeGoalTool(db: Db, scheduler: Scheduler): Tool {
  const check = (args: Record<string, unknown>): string | null => {
    const draft = readDraft(args);
    if (typeof draft === "string") return draft;
    return draft.schedule ? cronProblem(scheduler, draft.schedule.cron) : null;
  };
  return {
    name: "propose_goal",
    description:
      "Propose a goal for what the user keeps coming back to: a title, a brief (what it is and what success looks like, in the user's terms) and, if they want it to run on its own, one schedule (a five-field cron expression read in the user's time zone, and a prompt saying what each run should do). " +
      "The user sees a card and nothing is created until they approve it. Propose only after the user has shown they want something ongoing, and say in your reply what you proposed.",
    effect: "external",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        brief: { type: "string" },
        schedule: {
          type: "object",
          properties: { cron: { type: "string" }, prompt: { type: "string" } },
          required: ["cron", "prompt"],
        },
      },
      required: ["title", "brief"],
    },
    precheck: (args) => check(args),
    revise(args, edits) {
      const next: Record<string, unknown> = { ...args };
      for (const key of ["title", "brief"] as const) if (key in edits) next[key] = edits[key];
      // An absent or empty schedule removes it; the card's schedule fields are blank when there is none.
      if ("schedule" in edits) {
        const e = edits.schedule as { cron?: unknown; prompt?: unknown } | null;
        if (!e || (typeof e.cron === "string" && !e.cron.trim())) delete next.schedule;
        else next.schedule = e;
      }
      const problem = check(next);
      return problem ? { error: problem.replace(/^Error: /, "") } : { args: next };
    },
    describeCall(args) {
      const draft = readDraft(args);
      if (typeof draft === "string") return "Create a goal";
      const when = draft.schedule
        ? `; runs ${draft.schedule.cron} (${scheduler.timeZone}): ${draft.schedule.prompt.slice(0, 120)}`
        : "; no schedule";
      return `Create the goal "${draft.title}": ${draft.brief.slice(0, 300)}${when}`;
    },
    async execute(args) {
      const refused = check(args);
      if (refused) return refused;
      const draft = readDraft(args) as Draft;
      const goal = createGoal(db, { title: draft.title, brief: draft.brief });
      if (draft.schedule) {
        try {
          scheduler.createSchedule({ goalId: goal.id, cron: draft.schedule.cron, prompt: draft.schedule.prompt });
        } catch (error) {
          // All or nothing: a goal without the schedule the user approved would be a different goal.
          deleteGoal(db, goal.id, scheduler);
          return `Error: the goal was not created: ${(error as Error).message}`;
        }
      }
      // Says what was saved, in full: the user may have edited the draft on the card, and the model must not go on
      // describing the draft it proposed.
      const when = draft.schedule ? `schedule ${draft.schedule.cron}: ${draft.schedule.prompt}` : "no schedule";
      return `Created the goal "${goal.title}" (${goal.id}). Its channel has the same name. Saved brief: ${draft.brief.replace(/[.\s]+$/, "")}. Saved ${when.replace(/[.\s]+$/, "")}.`;
    },
  };
}
