import { createHash, randomUUID } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, type SQL } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { events, goals, reports, runs, scheduleFires, schedules } from "./db/schema.js";

export type Report = typeof reports.$inferSelect;
export type ReportKind = "found" | "run" | "system";
export type ReportScope = { kind: "goal" | "channel"; id: string } | null;

export const bodyMaxChars = 4_000;
const titleMaxChars = 200;
/** An identical system report inside this window becomes a count on the earlier one. */
export const collapseMillis = 60 * 60_000;

const cut = (text: string, max: number) => (text.length > max ? text.slice(0, max - 1).trimEnd() + "…" : text);

/** A link with the parts that differ between copies of the same page removed, so one story is one item. */
function normalizeLink(link: string): string {
  try {
    const url = new URL(link.trim());
    url.hash = "";
    for (const key of [...url.searchParams.keys()])
      if (/^(utm_|fbclid$|gclid$)/i.test(key)) url.searchParams.delete(key);
    url.hostname = url.hostname.toLowerCase();
    return url.toString().replace(/\/$/, "");
  } catch {
    return link.trim().toLowerCase();
  }
}

const normalizeText = (text: string) => text.trim().toLowerCase().replace(/\s+/g, " ");

export function dedupeKey(item: { title: string; link?: string | null; date?: string | null }): string {
  if (item.link?.trim()) return `link:${normalizeLink(item.link)}`;
  return `title:${createHash("sha256")
    .update(`${normalizeText(item.title)}|${(item.date ?? "").slice(0, 10)}`)
    .digest("hex")}`;
}

/**
 * A feed item from a scheduled run. A second item with the same key in the same scope is dropped, and the caller
 * says so on the run; `written` is false then.
 */
export function writeFound(
  db: Db,
  input: {
    scope: { kind: "goal" | "channel"; id: string };
    runId?: string | null;
    title: string;
    summary: string;
    link?: string | null;
    date?: string | null;
  },
  now = new Date(),
): { written: boolean; id?: string } {
  const id = randomUUID();
  const inserted = db
    .insert(reports)
    .values({
      id,
      kind: "found",
      scopeKind: input.scope.kind,
      scopeId: input.scope.id,
      runId: input.runId ?? null,
      title: cut(input.title.trim(), titleMaxChars),
      body: cut(input.summary.trim(), bodyMaxChars),
      link: input.link?.trim() || null,
      occurredAt: input.date?.trim() || now.toISOString(),
      dedupeKey: dedupeKey(input),
    })
    .onConflictDoNothing()
    .run();
  return inserted.changes ? { written: true, id } : { written: false };
}

/** What a scheduled or goal run did, from its final reply. One per such run; never written for a conversation. */
export function writeRunReport(db: Db, runId: string, now = new Date()): Report | null {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run) return null;
  const fire = db.select().from(scheduleFires).where(eq(scheduleFires.runId, runId)).get();
  const schedule = fire && db.select().from(schedules).where(eq(schedules.id, fire.scheduleId)).get();
  if (!schedule) return null;
  const goal = db.select().from(goals).where(eq(goals.id, schedule.goalId)).get();
  if (!goal) return null;
  if (
    db
      .select({ id: reports.id })
      .from(reports)
      .where(and(eq(reports.kind, "run"), eq(reports.runId, runId)))
      .get()
  )
    return null;
  const reply = db
    .select()
    .from(events)
    .where(and(eq(events.runId, runId), eq(events.type, "text")))
    .orderBy(desc(events.seq))
    .limit(1)
    .get();
  const text = reply ? String((JSON.parse(reply.data) as { text?: unknown }).text ?? "").trim() : "";
  const row = {
    id: randomUUID(),
    kind: "run",
    scopeKind: "goal",
    scopeId: goal.id,
    runId,
    title: cut(`${goal.title}: ${run.status === "done" ? "run finished" : `run ${run.status}`}`, titleMaxChars),
    body: cut(text || "The run ended without a reply.", bodyMaxChars),
    link: null,
    occurredAt: run.endedAt ?? now.toISOString(),
    readAt: null,
    dedupeKey: null,
    template: null,
    subject: null,
    count: 1,
  };
  db.insert(reports).values(row).run();
  return row;
}

/**
 * The harness's own notices. Each is a fixed template filled with ids and names, never with text from a model or a
 * page, so a system report cannot carry planted instructions. `subject` is what two reports must share to count as
 * the same one.
 */
const templates = {
  schedule_failed: (a: { goal?: string; due?: string }) => ({
    title: "A scheduled run did not start",
    body: `The schedule for the goal "${a.goal ?? "unknown"}" did not start its run due at ${a.due ?? "an unknown time"}. It is not retried; the next occurrence runs as usual.`,
  }),
  schedule_missed: (a: { goal?: string; due?: string }) => ({
    title: "A scheduled run was missed",
    body: `The schedule for the goal "${a.goal ?? "unknown"}" did not run at ${a.due ?? "an unknown time"} because the server was off, too busy or too late to catch up.`,
  }),
  run_limit: (a: { goal?: string; limit?: string }) => ({
    title: "A run stopped on a limit",
    body: `A run${a.goal ? ` for the goal "${a.goal}"` : ""} stopped: ${a.limit ?? "a limit was reached"}. Its work so far is kept in the transcript.`,
  }),
  credential_problem: (a: { handle?: string; goal?: string }) => ({
    title: "A credential is missing or was refused",
    body: `The credential "${a.handle ?? "unknown"}"${a.goal ? ` needed by the goal "${a.goal}"` : ""} is missing or was refused. Add or replace it in the vault.`,
  }),
} as const;
export type SystemTemplate = keyof typeof templates;

export function writeSystemReport(
  db: Db,
  input: {
    template: SystemTemplate;
    subject: string;
    scope: ReportScope;
    runId?: string | null;
    args?: Record<string, string>;
    times?: number;
  },
  now = new Date(),
): Report {
  const times = Math.max(1, input.times ?? 1);
  const since = new Date(now.getTime() - collapseMillis).toISOString();
  const same = db
    .select()
    .from(reports)
    .where(
      and(
        eq(reports.kind, "system"),
        eq(reports.template, input.template),
        eq(reports.subject, input.subject),
        gte(reports.occurredAt, since),
      ),
    )
    .orderBy(desc(reports.occurredAt))
    .limit(1)
    .get();
  if (same) {
    const count = same.count + times;
    db.update(reports).set({ count }).where(eq(reports.id, same.id)).run();
    return { ...same, count };
  }
  const text = templates[input.template](input.args ?? {});
  const row: Report = {
    id: randomUUID(),
    kind: "system",
    scopeKind: input.scope?.kind ?? null,
    scopeId: input.scope?.id ?? null,
    runId: input.runId ?? null,
    title: text.title,
    body: cut(text.body, bodyMaxChars),
    link: null,
    occurredAt: now.toISOString(),
    readAt: null,
    dedupeKey: null,
    template: input.template,
    subject: input.subject,
    count: times,
  };
  db.insert(reports).values(row).run();
  return row;
}

/** Called when any run ends: a run that stopped on a limit or failed writes a system report, and a scheduled run also writes its account. */
export function reportRunEnded(db: Db, runId: string, now = new Date()): void {
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  if (!run || run.status === "cancelled" || run.status === "running" || run.status === "waiting") return;
  const goal = db.select().from(goals).where(eq(goals.channelId, run.channelId)).get();
  const scope: ReportScope = goal ? { kind: "goal", id: goal.id } : { kind: "channel", id: run.channelId };
  if (run.status === "stopped") {
    writeSystemReport(
      db,
      {
        template: "run_limit",
        subject: scope ? `${scope.kind}:${scope.id}` : "none",
        scope,
        runId,
        args: { goal: goal?.title ?? "", limit: run.stopReason ?? "" },
      },
      now,
    );
  }
  writeRunReport(db, runId, now);
}

export type ReportFilter = {
  kind?: ReportKind;
  scope?: { kind: "goal" | "channel"; id: string };
  /** Several goals at once, such as a channel's own and those linked to it. */
  goalIds?: string[];
  unread?: boolean;
  limit?: number;
};

function where(f: ReportFilter): SQL | undefined {
  const parts: (SQL | undefined)[] = [];
  if (f.kind) parts.push(eq(reports.kind, f.kind));
  if (f.scope) parts.push(and(eq(reports.scopeKind, f.scope.kind), eq(reports.scopeId, f.scope.id)));
  if (f.goalIds) parts.push(and(eq(reports.scopeKind, "goal"), inArray(reports.scopeId, f.goalIds)));
  if (f.unread) parts.push(isNull(reports.readAt));
  return and(...parts.filter((p): p is SQL => !!p));
}

/** Newest first. */
export function listReports(db: Db, f: ReportFilter = {}): Report[] {
  return db
    .select()
    .from(reports)
    .where(where(f))
    .orderBy(desc(reports.occurredAt), desc(reports.id))
    .limit(Math.min(Math.max(f.limit ?? 50, 1), 200))
    .all();
}

export function markRead(db: Db, id: string, now = new Date()): Report | null {
  db.update(reports)
    .set({ readAt: now.toISOString() })
    .where(and(eq(reports.id, id), isNull(reports.readAt)))
    .run();
  return db.select().from(reports).where(eq(reports.id, id)).get() ?? null;
}

/** Marks everything the filter matches that is still unread; returns how many changed. */
export function markAllRead(db: Db, f: Omit<ReportFilter, "unread" | "limit"> = {}, now = new Date()): number {
  const rows = db
    .select({ id: reports.id })
    .from(reports)
    .where(and(where({ ...f, unread: true })))
    .all();
  if (!rows.length) return 0;
  db.update(reports)
    .set({ readAt: now.toISOString() })
    .where(
      inArray(
        reports.id,
        rows.map((r) => r.id),
      ),
    )
    .run();
  return rows.length;
}
