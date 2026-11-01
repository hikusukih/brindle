import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import {
  archiveChannel,
  ChannelError,
  createChannel,
  deleteChannel,
  renameChannel,
  restoreChannel,
} from "./channels.js";
import type { Db } from "./db/index.js";
import { goals, scopeStatements } from "./db/schema.js";
import {
  currentStatement,
  type GoalBrief,
  restoreStatement,
  statementVersions,
  writeStatement,
} from "./scope-statements.js";

export type Goal = typeof goals.$inferSelect;
export type GoalWithBrief = Goal & { brief: GoalBrief };

export class GoalError extends Error {
  constructor(
    readonly code: "not_found" | "archived" | "invalid_title" | "goal_channel",
    message: string,
  ) {
    super(message);
  }
}

function cleanTitle(title: unknown): string {
  const trimmed = typeof title === "string" ? title.trim() : "";
  if (!trimmed || trimmed.length > 120) throw new GoalError("invalid_title", "A goal title is 1 to 120 characters.");
  return trimmed;
}

function withBrief(db: Db, goal: Goal): GoalWithBrief {
  return { ...goal, brief: currentStatement(db, "goal", goal.id) as GoalBrief };
}

export function getGoal(db: Db, id: string): GoalWithBrief {
  const row = db.select().from(goals).where(eq(goals.id, id)).get();
  if (!row) throw new GoalError("not_found", "No such goal.");
  return withBrief(db, row);
}

/**
 * A goal owns its channel: renaming, archiving, restoring or deleting that channel on its own would leave the goal
 * out of step with it, so the channels API refuses and points to the goal instead.
 */
export function refuseGoalChannel(db: Db, channelId: string): void {
  const goal = db.select().from(goals).where(eq(goals.channelId, channelId)).get();
  if (goal) {
    throw new GoalError(
      "goal_channel",
      `This channel belongs to the goal "${goal.title}"; change it through the goal.`,
    );
  }
}

export function listGoals(db: Db, opts: { archived?: boolean } = {}): GoalWithBrief[] {
  return db
    .select()
    .from(goals)
    .orderBy(desc(goals.updatedAt))
    .all()
    .filter((g) => (g.status === "archived") === (opts.archived ?? false))
    .map((g) => withBrief(db, g));
}

/** Creates the goal, its channel (named for it) and the first version of the brief, all or nothing. */
export function createGoal(db: Db, input: { title?: unknown; brief?: unknown }, now = new Date()): GoalWithBrief {
  const title = cleanTitle(input.title);
  const brief = typeof input.brief === "string" ? input.brief : "";
  return db.transaction((tx) => {
    const channel = createChannel(tx as unknown as Db, title, now);
    const goal: Goal = {
      id: randomUUID(),
      title,
      status: "active",
      channelId: channel.id,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    tx.insert(goals).values(goal).run();
    // The brief is written by the user (here: the form they filled in), so it is confirmed.
    writeStatement(
      tx as unknown as Db,
      { scopeKind: "goal", scopeId: goal.id, text: brief, author: "user", confirmed: true },
      now,
    );
    return withBrief(tx as unknown as Db, goal);
  });
}

/** A changed brief is a new version; the title also renames the goal's channel. */
export function editGoal(
  db: Db,
  id: string,
  input: { title?: unknown; brief?: unknown },
  now = new Date(),
): GoalWithBrief {
  const goal = getGoal(db, id);
  if (goal.status === "archived") throw new GoalError("archived", "Restore the goal before changing it.");
  return db.transaction((tx) => {
    const t = tx as unknown as Db;
    if (input.title !== undefined) {
      const title = cleanTitle(input.title);
      renameChannel(t, goal.channelId, title, now);
      t.update(goals).set({ title, updatedAt: now.toISOString() }).where(eq(goals.id, id)).run();
    }
    if (typeof input.brief === "string" && input.brief.trim() !== goal.brief.text) {
      writeStatement(t, { scopeKind: "goal", scopeId: id, text: input.brief, author: "user", confirmed: true }, now);
      t.update(goals).set({ updatedAt: now.toISOString() }).where(eq(goals.id, id)).run();
    }
    return getGoal(t, id);
  });
}

export function briefHistory(db: Db, id: string): GoalBrief[] {
  getGoal(db, id);
  return statementVersions(db, "goal", id) as GoalBrief[];
}

export function restoreBrief(db: Db, id: string, version: number, now = new Date()): GoalWithBrief {
  const goal = getGoal(db, id);
  if (goal.status === "archived") throw new GoalError("archived", "Restore the goal before changing it.");
  restoreStatement(db, "goal", id, version, now);
  db.update(goals).set({ updatedAt: now.toISOString() }).where(eq(goals.id, id)).run();
  return getGoal(db, id);
}

function setStatus(db: Db, id: string, status: "active" | "archived", now: Date): GoalWithBrief {
  const goal = getGoal(db, id);
  db.transaction((tx) => {
    const t = tx as unknown as Db;
    if (status === "archived") archiveChannel(t, goal.channelId, now);
    else restoreChannel(t, goal.channelId, now);
    t.update(goals).set({ status, updatedAt: now.toISOString() }).where(eq(goals.id, id)).run();
  });
  return getGoal(db, id);
}

export const archiveGoal = (db: Db, id: string, now = new Date()) => setStatus(db, id, "archived", now);
export const restoreGoal = (db: Db, id: string, now = new Date()) => setStatus(db, id, "active", now);

/**
 * Removes the goal, its channel and that channel's runs, and every version of its brief. Artifacts its runs made
 * are not touched (they outlive what made them); schedules and the state document are removed by their own boxes.
 */
export function deleteGoal(db: Db, id: string): void {
  const goal = getGoal(db, id);
  db.transaction((tx) => {
    const t = tx as unknown as Db;
    t.delete(scopeStatements)
      .where(and(eq(scopeStatements.scopeKind, "goal"), eq(scopeStatements.scopeId, id)))
      .run();
    try {
      deleteChannel(t, goal.channelId);
    } catch (error) {
      if (!(error instanceof ChannelError)) throw error;
    }
    t.delete(goals).where(eq(goals.id, id)).run();
  });
}
