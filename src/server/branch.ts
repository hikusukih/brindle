import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { ChannelError, getChannel } from "./channels.js";
import { type Foldable, type StoredSummary, type Summarize, summarizeWithinCap } from "./compaction.js";
import type { ContextReport } from "./context.js";
import type { Db } from "./db/index.js";
import { artifacts, channels, contextReports, events, goals, runs, summaries } from "./db/schema.js";
import { closeCalls, messagesFromEvents } from "./runs.js";

/** What a branched channel remembers about where it came from; shown as its transcript's first line and in the debug view. */
export type BranchInfo = {
  fromChannelId: string;
  fromChannelName: string;
  fromRunId: string;
  /** The run's place in the source channel, counted from 1, so the note can say which run it was. */
  fromRunNumber?: number;
  /** False when the seed call failed: the channel is empty and says so. */
  seeded: boolean;
  /** The source's summary as refreshed for this seed, kept for the debug view only; null when no run had finished since the last fold. */
  refreshed: string | null;
};

export function branchOf(channel: { branch: string | null }): BranchInfo | null {
  return channel.branch ? (JSON.parse(channel.branch) as BranchInfo) : null;
}

/** The summary version the chosen run used, from its last context report; a run from before reports existed gets the latest version folded through an earlier run. */
function summaryUsedBy(db: Db, channelId: string, run: { id: string; startedAt: string }): StoredSummary | null {
  const report = db
    .select({ report: contextReports.report })
    .from(contextReports)
    .where(eq(contextReports.runId, run.id))
    .orderBy(desc(contextReports.step))
    .limit(1)
    .get();
  const all = db
    .select()
    .from(summaries)
    .where(eq(summaries.channelId, channelId))
    .orderBy(desc(summaries.version))
    .all();
  if (report) {
    const version = (JSON.parse(report.report) as ContextReport).summaryVersion ?? 0;
    return all.find((s) => s.version === version) ?? null;
  }
  const startedAt = new Map(
    db
      .select({ id: runs.id, startedAt: runs.startedAt })
      .from(runs)
      .where(eq(runs.channelId, channelId))
      .all()
      .map((r) => [r.id, r.startedAt]),
  );
  return all.find((s) => s.throughRunId && (startedAt.get(s.throughRunId) ?? "") < run.startedAt) ?? null;
}

function foldable(db: Db, runIds: string[]): Foldable[] {
  if (!runIds.length) return [];
  const rows = db.select().from(events).where(inArray(events.runId, runIds)).orderBy(asc(events.seq)).all();
  return runIds.map((id) => ({ id, messages: closeCalls(messagesFromEvents(rows.filter((e) => e.runId === id))) }));
}

const defaultName = (source: string) => `From ${source}`.slice(0, 120);

/**
 * "New channel from here": makes a channel seeded from the summary the chosen run used, the run itself and a
 * refreshed summary of the source, which is left unchanged (the refresh is not saved as a version, so the source's
 * recent runs are not folded early). A failed seed still creates the channel, empty, and says so. The purpose
 * statement is drafted from the seed afterward, silently.
 */
export async function branchChannel(
  db: Db,
  sourceId: string,
  runId: string,
  options: {
    name?: unknown;
    summarize?: Summarize;
    draftPurpose?: (channelId: string, seed: string) => Promise<unknown>;
    signal?: AbortSignal;
    now?: Date;
  },
) {
  const source = getChannel(db, sourceId);
  if (source.archivedAt) throw new ChannelError("archived", "Restore the channel before branching it.");
  if (db.select().from(goals).where(eq(goals.channelId, sourceId)).get())
    throw new ChannelError("goal_channel", "A goal's channel can't be branched.");
  const run = db
    .select()
    .from(runs)
    .where(and(eq(runs.id, runId), eq(runs.channelId, sourceId)))
    .get();
  if (!run) throw new ChannelError("not_found", "No such run in this channel.");
  if (run.status !== "done") throw new ChannelError("run_unfinished", "Only a finished run can be branched from.");

  const name = typeof options.name === "string" && options.name.trim() ? options.name.trim() : defaultName(source.name);
  if (name.length > 120) throw new ChannelError("invalid_name", "A channel name is 1 to 120 characters.");

  let seed: { text: string; tokensUsed: number } | null = null;
  let refreshed: string | null = null;
  if (options.summarize) {
    try {
      const used = summaryUsedBy(db, sourceId, run);
      const latest = db
        .select()
        .from(summaries)
        .where(eq(summaries.channelId, sourceId))
        .orderBy(desc(summaries.version))
        .limit(1)
        .get();
      // Runs that finished after the last fold: bounded, since compaction keeps them under one window.
      const all = db
        .select()
        .from(runs)
        .where(and(eq(runs.channelId, sourceId), eq(runs.status, "done")))
        .orderBy(asc(runs.startedAt))
        .all();
      const from = latest?.throughRunId ? all.findIndex((r) => r.id === latest.throughRunId) + 1 : 0;
      const since = all.slice(from).filter((r) => r.id !== run.id);
      // With no fold yet every other finished run counts, so a channel below its first fold still carries them over.
      if (since.length) {
        refreshed = (
          await summarizeWithinCap(options.summarize, {
            previous: latest?.text ?? null,
            runs: foldable(
              db,
              since.map((r) => r.id),
            ),
            signal: options.signal,
          })
        ).text;
      }
      const latestText = refreshed ?? latest?.text ?? null;
      const material: Foldable[] = foldable(db, [run.id]);
      if (latestText && latestText !== used?.text) {
        material.push({
          id: "refresh",
          messages: [{ role: "system", content: `Newer summary of the whole source conversation:\n${latestText}` }],
        });
      }
      seed = await summarizeWithinCap(options.summarize, {
        previous: used?.text ?? null,
        runs: material,
        focus: `the topic of run ${run.id}`,
        signal: options.signal,
      });
    } catch {
      seed = null;
      refreshed = null;
    }
  }

  const stamp = (options.now ?? new Date()).toISOString();
  const id = randomUUID();
  const branch: BranchInfo = {
    fromChannelId: source.id,
    fromChannelName: source.name,
    fromRunId: run.id,
    fromRunNumber:
      db
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.channelId, sourceId))
        .orderBy(asc(runs.startedAt))
        .all()
        .findIndex((r) => r.id === run.id) + 1,
    seeded: seed !== null,
    refreshed,
  };
  db.insert(channels)
    .values({
      id,
      name,
      createdAt: stamp,
      updatedAt: stamp,
      archivedAt: null,
      model: null,
      branch: JSON.stringify(branch),
    })
    .run();
  if (seed) {
    const refs = db
      .select({ id: artifacts.id })
      .from(artifacts)
      .all()
      .map((a) => a.id)
      .filter((a) => seed.text.includes(a));
    db.insert(summaries)
      .values({
        id: randomUUID(),
        channelId: id,
        version: 0,
        throughRunId: null,
        text: seed.text,
        artifacts: JSON.stringify(refs),
        tokensUsed: seed.tokensUsed,
        createdAt: stamp,
      })
      .run();
    // Off the user's path and silent on failure, like any drafted purpose statement.
    void options.draftPurpose?.(id, seed.text).catch(() => {});
  }
  return getChannel(db, id);
}
