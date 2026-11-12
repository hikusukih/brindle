import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Small facts about this install, such as when it first started.
export const appMeta = sqliteTable("app_meta", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

// Timestamps are ISO 8601 strings so they sort lexically and read cleanly in the database.
export const channels = sqliteTable("channels", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
  // Null while the channel is live; archiving hides it and makes it read-only, restoring clears it.
  archivedAt: text("archived_at"),
  // A model spec such as "openai:gpt-4o"; null means the server's default model.
  model: text("model"),
  // JSON for a channel made by "New channel from here": where it came from and whether the history was carried over (see branch.ts).
  branch: text("branch"),
});

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    // running | done | failed | cancelled | stopped; the run engine (P1.4) owns the transitions.
    status: text("status").notNull(),
    // The visible reason a run ended, such as which limit it hit.
    stopReason: text("stop_reason"),
    startedAt: text("started_at").notNull(),
    endedAt: text("ended_at"),
    // Tokens counted toward the run's token limit so far: uncached input plus output (see countedTokens in runs.ts).
    tokens: integer("tokens").notNull().default(0),
  },
  (t) => [index("runs_channel_idx").on(t.channelId, t.startedAt)],
);

// One row per step of a run. seq orders events within a run and lets a reconnecting SSE client resume after the last one it saw.
export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    // message | text | tool_call | tool_result | artifact | error
    type: text("type").notNull(),
    // JSON payload; its shape depends on type.
    data: text("data").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("events_run_seq_idx").on(t.runId, t.seq)],
);

// A goal's recurring task. goal_id is a plain id until the goals table exists (P4.3); the scheduler never looks inside it.
export const schedules = sqliteTable("schedules", {
  id: text("id").primaryKey(),
  goalId: text("goal_id").notNull(),
  // Five fields, read in the user's time zone.
  cron: text("cron").notNull(),
  prompt: text("prompt").notNull(),
  // channel in Phase 4; feed and digest arrive later as new values.
  destination: text("destination").notNull(),
  enabled: integer("enabled", { mode: "boolean" }).notNull(),
  nextFireAt: text("next_fire_at"),
  // catch_up_once | skip
  missedPolicy: text("missed_policy").notNull(),
  // Set when archiving the goal turned this schedule off, so restoring turns back on exactly those and not ones the user had off.
  suspendedByArchive: integer("suspended_by_archive", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
});

// Both the waiting list and the log of what fired. The unique index makes double-firing an occurrence impossible.
export const scheduleFires = sqliteTable(
  "schedule_fires",
  {
    id: text("id").primaryKey(),
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => schedules.id, { onDelete: "cascade" }),
    dueAt: text("due_at").notNull(),
    // waiting | started | missed | skipped_busy | skipped_disabled | failed_to_start
    state: text("state").notNull(),
    runId: text("run_id"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [uniqueIndex("schedule_fires_due_idx").on(t.scheduleId, t.dueAt)],
);

// An ongoing project with its own channel. The brief lives in scope_statements; the state document arrives with P4.4.
export const goals = sqliteTable("goals", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  // active | archived
  status: text("status").notNull(),
  // Deleting the channel deletes the goal, since a goal without its channel has nowhere to run.
  channelId: text("channel_id")
    .notNull()
    .references(() => channels.id, { onDelete: "cascade" }),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

// A channel's purpose statement and a goal's brief share this table: append-only versions, the highest is current.
export const scopeStatements = sqliteTable(
  "scope_statements",
  {
    id: text("id").primaryKey(),
    // channel | goal
    scopeKind: text("scope_kind").notNull(),
    scopeId: text("scope_id").notNull(),
    version: integer("version").notNull(),
    text: text("text").notNull(),
    // user | agent
    author: text("author").notNull(),
    confirmed: integer("confirmed", { mode: "boolean" }).notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("scope_statements_version_idx").on(t.scopeKind, t.scopeId, t.version)],
);

// Provenance is copied onto the row rather than linked, so an artifact outlives the channel and run that made it: no foreign keys here.
export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    // document | code | data | page | link
    kind: text("kind").notNull(),
    // channel | goal; goal-owned artifacts (state documents, Phase 4) are not offered for deletion with a channel.
    scope: text("scope").notNull(),
    // The scope's id when it is still live, kept so a channel's delete can find its own artifacts.
    scopeId: text("scope_id").notNull(),
    // The name the scope had when the artifact was made.
    scopeName: text("scope_name").notNull(),
    runId: text("run_id"),
    // Path relative to the artifacts directory.
    file: text("file").notNull(),
    mime: text("mime").notNull(),
    size: integer("size").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("artifacts_scope_idx").on(t.scope, t.scopeId), index("artifacts_created_idx").on(t.createdAt)],
);

// One row per model request: what assembly counted and, for the most recent runs of a channel, the exact messages sent.
export const contextReports = sqliteTable(
  "context_reports",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    step: integer("step").notNull(),
    // JSON ContextReport.
    report: text("report").notNull(),
    // JSON Message[]; set to null once the run falls out of the channel's most recent 20.
    messages: text("messages"),
    // JSON ToolDefinition[] sent with the request, kept and pruned with messages; null when none were sent.
    tools: text("tools"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    index("context_reports_channel_idx").on(t.channelId, t.createdAt),
    index("context_reports_run_idx").on(t.runId, t.step),
  ],
);

// Compaction output (docs/design/context.md): append-only versions per channel, the highest is current. The runs and
// events a summary covers are never touched.
export const summaries = sqliteTable(
  "summaries",
  {
    id: text("id").primaryKey(),
    channelId: text("channel_id")
      .notNull()
      .references(() => channels.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    // The last run folded into this summary; null for a summary that covers no runs of this channel.
    throughRunId: text("through_run_id"),
    text: text("text").notNull(),
    // JSON string[] of artifact ids the text refers to.
    artifacts: text("artifacts").notNull(),
    tokensUsed: integer("tokens_used").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [uniqueIndex("summaries_version_idx").on(t.channelId, t.version)],
);

// One store for everything that is not conversation: found items for the feed, accounts of scheduled runs, and the harness's own notices (docs/design/reports.md).
export const reports = sqliteTable(
  "reports",
  {
    id: text("id").primaryKey(),
    // found | run | system
    kind: text("kind").notNull(),
    // goal | channel; both null for an instance-wide notice.
    scopeKind: text("scope_kind"),
    scopeId: text("scope_id"),
    // The run that produced it, when there is one. Plain text: a report outlives a deleted run.
    runId: text("run_id"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    link: text("link"),
    occurredAt: text("occurred_at").notNull(),
    // Null until read.
    readAt: text("read_at"),
    // found only: the normalized link, or a hash of the normalized title and date.
    dedupeKey: text("dedupe_key"),
    // system only: the template name and what it is about, so an identical notice within the hour becomes a count.
    template: text("template"),
    subject: text("subject"),
    count: integer("count").notNull().default(1),
  },
  (t) => [
    uniqueIndex("reports_dedupe_idx").on(t.scopeKind, t.scopeId, t.dedupeKey),
    index("reports_scope_idx").on(t.scopeKind, t.scopeId, t.occurredAt),
    index("reports_kind_idx").on(t.kind, t.occurredAt),
  ],
);
