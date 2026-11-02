import { randomUUID } from "node:crypto";
import { and, asc, desc, eq } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { goals, scopeStatements } from "./db/schema.js";

// See docs/design/context.md: a purpose statement and a goal brief are one table and two kinds.
type Stored = typeof scopeStatements.$inferSelect;
export type PurposeStatement = Stored & { kind: "purpose" };
export type GoalBrief = Stored & { kind: "goal_brief" };
export type ScopeStatement = PurposeStatement | GoalBrief;

/** Characters in a brief: the context note's 500-token cap at four characters a token. */
export const briefMaxChars = 2_000;

/**
 * What may be written. The types are the rule: a goal brief only ever gets a user's confirmed text, so an
 * agent's draft has no way to save one; a purpose statement may be drafted by the agent.
 */
export type StatementWrite =
  | { scopeKind: "goal"; scopeId: string; text: string; author: "user"; confirmed: true }
  | { scopeKind: "channel"; scopeId: string; text: string; author: "user" | "agent"; confirmed: boolean };

export class ScopeStatementError extends Error {
  constructor(
    readonly code: "invalid_text" | "not_found",
    message: string,
  ) {
    super(message);
  }
}

function tag(row: Stored): ScopeStatement {
  return row.scopeKind === "goal" ? { ...row, kind: "goal_brief" } : { ...row, kind: "purpose" };
}

export function statementVersions(db: Db, scopeKind: "channel" | "goal", scopeId: string): ScopeStatement[] {
  return db
    .select()
    .from(scopeStatements)
    .where(and(eq(scopeStatements.scopeKind, scopeKind), eq(scopeStatements.scopeId, scopeId)))
    .orderBy(asc(scopeStatements.version))
    .all()
    .map(tag);
}

export function currentStatement(db: Db, scopeKind: "channel" | "goal", scopeId: string): ScopeStatement | undefined {
  const row = db
    .select()
    .from(scopeStatements)
    .where(and(eq(scopeStatements.scopeKind, scopeKind), eq(scopeStatements.scopeId, scopeId)))
    .orderBy(desc(scopeStatements.version))
    .get();
  return row && tag(row);
}

const channelMaxChars = 1200;

export function writeStatement(db: Db, write: StatementWrite, now = new Date()): ScopeStatement {
  const text = write.text.trim();
  if (!text)
    throw new ScopeStatementError(
      "invalid_text",
      `A ${write.scopeKind === "goal" ? "brief" : "purpose statement"} can't be empty.`,
    );
  if (write.scopeKind === "goal" && text.length > briefMaxChars)
    throw new ScopeStatementError("invalid_text", `A brief is at most ${briefMaxChars} characters.`);
  // 300 tokens at about four characters each, the cap docs/design/context.md gives a purpose statement; drafts are held to it in purpose.ts.
  if (write.scopeKind === "channel" && text.length > channelMaxChars)
    throw new ScopeStatementError("invalid_text", `A purpose statement is at most ${channelMaxChars} characters.`);
  const row: Stored = {
    id: randomUUID(),
    scopeKind: write.scopeKind,
    scopeId: write.scopeId,
    version: (currentStatement(db, write.scopeKind, write.scopeId)?.version ?? 0) + 1,
    text,
    author: write.author,
    confirmed: write.confirmed,
    createdAt: now.toISOString(),
  };
  db.insert(scopeStatements).values(row).run();
  return tag(row);
}

/** Restoring writes an earlier version again as a new one, so history only grows. */
export function restoreStatement(
  db: Db,
  scopeKind: "channel" | "goal",
  scopeId: string,
  version: number,
  now = new Date(),
) {
  const old = statementVersions(db, scopeKind, scopeId).find((c) => c.version === version);
  if (!old) throw new ScopeStatementError("not_found", "No such version.");
  // A restore is the user's act, so it is confirmed whoever wrote the old text.
  return writeStatement(
    db,
    { scopeKind, scopeId, text: old.text, author: "user", confirmed: true } as StatementWrite,
    now,
  );
}

/**
 * The statement a channel's runs are sent with in layer 2: a goal channel's brief, or an ordinary channel's current
 * purpose statement. A draft the user hasn't touched is sent too; it is only ever shown as a draft in the UI.
 */
export function scopeStatementFor(
  db: Db,
  channelId: string,
): { kind: "purpose" | "goal_brief"; text: string } | undefined {
  const goal = db.select({ id: goals.id }).from(goals).where(eq(goals.channelId, channelId)).get();
  const current = goal ? currentStatement(db, "goal", goal.id) : currentStatement(db, "channel", channelId);
  return current ? { kind: current.kind === "goal_brief" ? "goal_brief" : "purpose", text: current.text } : undefined;
}
