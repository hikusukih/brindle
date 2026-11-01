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
