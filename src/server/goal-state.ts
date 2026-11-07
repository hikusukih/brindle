import { randomUUID } from "node:crypto";
import { asc, desc, eq } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { goalStates, goals } from "./db/schema.js";
import { GoalError, getGoal } from "./goals.js";

export type GoalState = typeof goalStates.$inferSelect;

/** The goals note caps the state at 3,000 tokens; at four characters a token that is this many. */
export const stateMaxChars = 12_000;

export class GoalStateError extends Error {
  constructor(
    readonly code: "too_long" | "conflict" | "no_such_version",
    message: string,
  ) {
    super(message);
  }
}

export function stateVersions(db: Db, goalId: string): GoalState[] {
  getGoal(db, goalId);
  return db.select().from(goalStates).where(eq(goalStates.goalId, goalId)).orderBy(asc(goalStates.version)).all();
}

/** Undefined until the first write. */
export function currentState(db: Db, goalId: string): GoalState | undefined {
  return db
    .select()
    .from(goalStates)
    .where(eq(goalStates.goalId, goalId))
    .orderBy(desc(goalStates.version))
    .limit(1)
    .get();
}

function append(
  db: Db,
  goalId: string,
  text: string,
  by: { author: "user" | "agent"; runId?: string; note: string },
  now: Date,
): GoalState {
  if (text.length > stateMaxChars) {
    throw new GoalStateError(
      "too_long",
      `The state document would be ${text.length} characters; the most it can hold is ${stateMaxChars}. Condense it first.`,
    );
  }
  const row: GoalState = {
    id: randomUUID(),
    goalId,
    version: (currentState(db, goalId)?.version ?? 0) + 1,
    text,
    author: by.author,
    runId: by.runId ?? null,
    note: by.note.trim().split("\n")[0]?.slice(0, 200) ?? "",
    createdAt: now.toISOString(),
  };
  db.insert(goalStates).values(row).run();
  return row;
}

function writable(db: Db, goalId: string) {
  const goal = getGoal(db, goalId);
  if (goal.status === "archived") throw new GoalError("archived", "Restore the goal before changing it.");
}

/**
 * The user's save from the page. With baseVersion given, a save over a newer version is refused, so
 * an edit made while the agent was updating the document is never silently overwritten.
 */
export function saveUserState(
  db: Db,
  goalId: string,
  input: { text: string; baseVersion?: number },
  now = new Date(),
): GoalState {
  writable(db, goalId);
  const current = currentState(db, goalId);
  if (input.baseVersion !== undefined && input.baseVersion !== (current?.version ?? 0)) {
    throw new GoalStateError(
      "conflict",
      "The document changed while you were editing. Reload it and apply your edit again.",
    );
  }
  return append(db, goalId, input.text, { author: "user", note: "edited by you" }, now);
}

/** Restoring writes an earlier version again as a new one, so history only grows. */
export function restoreState(db: Db, goalId: string, version: number, now = new Date()): GoalState {
  writable(db, goalId);
  const old = stateVersions(db, goalId).find((v) => v.version === version);
  if (!old) throw new GoalStateError("no_such_version", "No such version.");
  return append(db, goalId, old.text, { author: "user", note: `restored version ${version}` }, now);
}

export type AgentUpdate = {
  /** The version the agent read; 0 when there is none yet. */
  version: number;
  edits?: { old: string; new: string }[];
  replace?: string;
  note: string;
  runId?: string;
};

export type AgentResult =
  | { ok: true; version: number }
  | { ok: false; error: string; current?: { version: number; text: string } };

/**
 * The agent's write, as the goals note settles it: exact-string edits that must each match once, applied
 * together or not at all, or a whole replacement. Both carry the version read. If the document has moved
 * on, edits are tried against the current text and apply only if every pair still matches once; a
 * replacement is refused. A refusal carries the current content so the agent can reconcile.
 */
export function applyAgentUpdate(db: Db, goalId: string, update: AgentUpdate, now = new Date()): AgentResult {
  writable(db, goalId);
  const current = currentState(db, goalId);
  const have = current?.version ?? 0;
  const snapshot = current ? { version: current.version, text: current.text } : undefined;
  const stale = update.version !== have;
  const refuse = (error: string): AgentResult => ({ ok: false, error, current: snapshot });

  if ((update.edits === undefined) === (update.replace === undefined)) {
    return { ok: false, error: "Give either edits or replace, not both and not neither." };
  }
  let text: string;
  if (update.replace !== undefined) {
    if (stale) return refuse(`The document is at version ${have}, not ${update.version}. Read it and write again.`);
    text = update.replace;
  } else {
    const base = current?.text ?? "";
    const found: { at: number; len: number; to: string }[] = [];
    for (const [i, e] of (update.edits ?? []).entries()) {
      if (!e.old)
        return { ok: false, error: `Edit ${i + 1} has an empty "old"; use replace to write a whole document.` };
      const at = base.indexOf(e.old);
      if (at < 0)
        return refuse(
          `Edit ${i + 1} does not apply: its "old" text${stale ? ` (the document has changed since version ${update.version})` : ""} is not in the document.`,
        );
      if (base.indexOf(e.old, at + 1) >= 0)
        return refuse(
          `Edit ${i + 1} is ambiguous: its "old" text appears more than once. Include more surrounding text.`,
        );
      found.push({ at, len: e.old.length, to: e.new });
    }
    found.sort((a, b) => a.at - b.at);
    for (let i = 1; i < found.length; i++) {
      const prev = found[i - 1];
      const next = found[i];
      if (prev && next && next.at < prev.at + prev.len) return refuse("Two edits overlap. Merge them into one.");
    }
    text = base;
    for (const f of [...found].reverse()) text = text.slice(0, f.at) + f.to + text.slice(f.at + f.len);
  }
  try {
    const row = append(db, goalId, text, { author: "agent", runId: update.runId, note: update.note }, now);
    return { ok: true, version: row.version };
  } catch (e) {
    if (e instanceof GoalStateError) return refuse(e.message);
    throw e;
  }
}

/** What a tool may do with state, so it never holds the database. */
export type GoalStateAccess = {
  forChannel(channelId: string): { id: string; title: string } | undefined;
  read(goalId: string): { version: number; text: string };
  update(goalId: string, update: AgentUpdate): AgentResult;
};

export function goalStateAccess(db: Db): GoalStateAccess {
  return {
    forChannel: (channelId) => {
      const g = db.select().from(goals).where(eq(goals.channelId, channelId)).get();
      return g && g.status === "active" ? { id: g.id, title: g.title } : undefined;
    },
    read: (goalId) => {
      const s = currentState(db, goalId);
      return { version: s?.version ?? 0, text: s?.text ?? "" };
    },
    update: (goalId, update) => applyAgentUpdate(db, goalId, update),
  };
}
