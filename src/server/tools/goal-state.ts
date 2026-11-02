import type { GoalStateAccess } from "../goal-state.js";
import type { Tool } from "./registry.js";

const noGoal = "This channel is not a goal's channel, so there is no state document.";

/** `read`: the goal's current state document and its version number, which an update must quote. */
export function getGoalStateTool(access: GoalStateAccess): Tool {
  return {
    name: "get_goal_state",
    description:
      "Read this goal's state document (its working memory) and its version number. Quote the version when you update it.",
    effect: "read",
    parameters: { type: "object", properties: {} },
    async execute(_args, ctx) {
      const goal = access.forChannel(ctx.scope.id);
      if (!goal) return noGoal;
      const s = access.read(goal.id);
      return s.version === 0 ? "The state document is empty (version 0)." : `Version ${s.version}\n\n${s.text}`;
    },
  };
}

/**
 * `local`: it writes, but only this goal's own document, and every change is a version the user can read
 * and restore. Exact-string edits are the default because rewriting a long document is slow on a small host.
 */
export function updateGoalStateTool(access: GoalStateAccess): Tool {
  return {
    name: "update_goal_state",
    description:
      "Change this goal's state document, its working memory (curriculum and progress, items already reported, and so on). Give the version you read and either edits (each {old, new}, where old must appear exactly once) or replace (the whole new text, for the first write or to condense), and a one-line note of what changed.",
    effect: "local",
    parameters: {
      type: "object",
      properties: {
        version: { type: "integer" },
        edits: {
          type: "array",
          items: {
            type: "object",
            properties: { old: { type: "string" }, new: { type: "string" } },
            required: ["old", "new"],
          },
        },
        replace: { type: "string" },
        note: { type: "string" },
      },
      required: ["version", "note"],
    },
    describeCall: (args) => `Update the goal's state: ${String(args.note)}`,
    async execute(args, ctx) {
      const goal = access.forChannel(ctx.scope.id);
      if (!goal) return noGoal;
      const result = access.update(goal.id, {
        version: args.version as number,
        edits: args.edits as { old: string; new: string }[] | undefined,
        replace: args.replace as string | undefined,
        note: String(args.note),
        runId: ctx.runId,
      });
      if (result.ok) return `Updated the state document to version ${result.version}.`;
      return result.current
        ? `${result.error}\n\nThe current document is version ${result.current.version}:\n\n${result.current.text}`
        : result.error;
    },
  };
}
