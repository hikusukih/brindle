import { serveStatic } from "@hono/node-server/serve-static";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import { type ArtifactKind, type ArtifactStore, artifactKinds } from "./artifacts.js";
import { requireToken } from "./auth.js";
import { branchChannel } from "./branch.js";
import {
  archiveChannel,
  ChannelError,
  createChannel,
  deleteChannel,
  getChannel,
  listChannels,
  renameChannel,
  restoreChannel,
  setChannelModel,
} from "./channels.js";
import type { Summarize } from "./compaction.js";
import { runContext } from "./context.js";
import type { Db } from "./db/index.js";
import { appMeta } from "./db/schema.js";
import { acceptNudge, dismissNudge } from "./drift.js";
import type { GoalDrafter } from "./goal-draft.js";
import {
  archiveGoal,
  briefHistory,
  cancelGoalRuns,
  createGoal,
  deleteGoal,
  editGoal,
  GoalError,
  getGoal,
  goalIdsByChannel,
  listGoals,
  refuseGoalChannel,
  restoreBrief,
  restoreGoal,
} from "./goals.js";
import type { ModelRegistry } from "./model/config.js";
import { ModelSettingsError, type ModelSettingsView } from "./model/settings.js";
import type { PurposeDrafter } from "./purpose.js";
import { channelTranscript, type RunEngine, RunError, type RunEvent } from "./runs.js";
import type { Scheduler } from "./scheduler.js";
import {
  currentStatement,
  restoreStatement,
  ScopeStatementError,
  statementVersions,
  writeStatement,
} from "./scope-statements.js";
import { setSetting } from "./settings.js";
import { getTimeZone, setTimeZone, TimeZoneError } from "./time-zone.js";

export type Greeting = {
  message: string;
  since: string;
};

type AppOptions = {
  db: Db;
  // Absent until a real adapter is configured; starting a run then answers 503.
  engine?: RunEngine;
  // The per-model numbers the Settings screen shows and edits; absent, the screen shows none.
  modelSettings?: {
    list: () => Promise<ModelSettingsView[]>;
    update: (spec: string, patch: Record<string, unknown>) => Promise<void>;
  };
  // What channels may be set to use; absent, setting a channel's model is refused.
  models?: Pick<ModelRegistry, "validate" | "list" | "setDefault"> & {
    defaultSpec?: string;
    // The numbers a channel's model runs under, for the channel view; absent, the view shows none.
    settings?: (spec: string | null) => {
      model: string;
      contextWindow: number;
      maxSteps: number;
      maxTokens: number;
      maxMillis: number;
    };
  };
  // Drafts purpose statements; absent, the user can still write one but cannot ask for a draft.
  purpose?: PurposeDrafter;
  // Writes a branched channel's seed summary ("New channel from here"); absent, the channel is made empty with a note.
  branching?: Summarize;
  // Drafts a goal from pasted words for the Goals screen; absent, the user fills the form by hand.
  goalDrafter?: GoalDrafter;
  // Where artifacts live; absent, channel deletes cannot remove any.
  artifacts?: ArtifactStore;
  // Absent until the scheduler is built at startup (P4.12); goal archive, restore and delete then leave schedules alone.
  scheduler?: Scheduler;
  // Called after the user's time zone changes, so the scheduler (P4.12) can move its next fires.
  onTimeZoneChange?: (timeZone: string) => void;
  // Built client to serve; absent in development, where Vite serves it.
  clientRoot?: string;
  // SHA-256 of the login token. Absent only in tests; main.ts always passes it.
  authHash?: Buffer;
};

export function createApp({
  db,
  engine,
  models,
  modelSettings,
  artifacts,
  purpose,
  branching,
  goalDrafter,
  scheduler,
  onTimeZoneChange,
  clientRoot,
  authHash,
}: AppOptions) {
  const app = new Hono();

  if (authHash) app.use("/api/*", requireToken(authHash));
  app.get("/api/health", (c) => c.json({ ok: true }));
  // Lets the login form check a token without loading anything else.
  app.get("/api/session", (c) => c.body(null, 204));

  app.get("/api/greeting", (c) => {
    const row = db.select().from(appMeta).where(eq(appMeta.key, "first_started_at")).get();
    const greeting: Greeting = {
      message: "Hello from Brindle.",
      since: row?.value ?? new Date().toISOString(),
    };
    return c.json(greeting);
  });

  // The user's time zone. The browser sends its own once, with onlyIfUnset, the first time the app opens.
  app.get("/api/settings/time-zone", (c) => c.json({ timeZone: getTimeZone(db) }));
  app.put("/api/settings/time-zone", async (c) => {
    const input = (await c.req.json().catch(() => ({}))) as { timeZone?: unknown; onlyIfUnset?: unknown };
    const before = getTimeZone(db);
    const timeZone = setTimeZone(db, input.timeZone, { onlyIfUnset: input.onlyIfUnset === true });
    if (timeZone !== before) onTimeZoneChange?.(timeZone);
    return c.json({ timeZone });
  });

  app.onError((err, c) => {
    if (err instanceof TimeZoneError) return c.json({ error: "invalid_time_zone", message: err.message }, 400);
    if (err instanceof ChannelError) {
      const status =
        err.code === "not_found"
          ? 404
          : err.code === "archived" || err.code === "goal_channel" || err.code === "run_unfinished"
            ? 409
            : 400;
      return c.json({ error: err.code, message: err.message }, status);
    }
    if (err instanceof GoalError || err instanceof ScopeStatementError) {
      const status =
        err.code === "not_found" ? 404 : err.code === "archived" || err.code === "goal_channel" ? 409 : 400;
      return c.json({ error: err.code, message: err.message }, status);
    }
    if (err instanceof RunError) {
      const status =
        err.code === "not_found"
          ? 404
          : err.code === "invalid_text" || err.code === "invalid_decision"
            ? 400
            : err.code === "no_model"
              ? 503
              : 409;
      return c.json({ error: err.code, message: err.message }, status);
    }
    if (err instanceof HTTPException) return err.getResponse();
    throw err;
  });

  const needEngine = () => {
    if (!engine) throw new HTTPException(503, { message: "No model is configured." });
    return engine;
  };

  app.get("/api/channels/:id/runs", (c) => c.json(channelTranscript(db, c.req.param("id"))));
  app.post("/api/channels/:id/runs", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { text?: unknown };
    return c.json(needEngine().start(c.req.param("id"), body.text), 201);
  });
  // What each request of the run sent: layer sizes always, the exact messages for a channel's 20 newest runs.
  app.get("/api/runs/:id/context", (c) => c.json(runContext(db, c.req.param("id"))));
  app.get("/api/runs/:id", (c) => c.json(needEngine().get(c.req.param("id"))));
  app.post("/api/runs/:id/approvals/:callId", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { decision?: unknown; edits?: unknown };
    return c.json(needEngine().decide(c.req.param("id"), c.req.param("callId"), body.decision, body.edits));
  });
  app.post("/api/runs/:id/cancel", (c) => c.json(needEngine().cancel(c.req.param("id"))));

  // Replays stored events, then follows the live run. A reconnecting client sends Last-Event-ID (the last seq it saw).
  app.get("/api/runs/:id/events", (c) => {
    const runEngine = needEngine();
    const after = Number(c.req.header("last-event-id") ?? c.req.query("after") ?? 0) || 0;
    const queue: (RunEvent | null)[] = [];
    let wake: (() => void) | undefined;
    const { backlog, done, unsubscribe } = runEngine.subscribe(c.req.param("id"), after, (e) => {
      queue.push(e);
      wake?.();
    });
    return streamSSE(c, async (stream) => {
      stream.onAbort(unsubscribe);
      const send = (e: RunEvent) => stream.writeSSE({ id: String(e.seq), event: e.type, data: e.data });
      for (const e of backlog) await send(e);
      let finished = done;
      while (!finished) {
        while (queue.length) {
          const e = queue.shift();
          if (e) await send(e);
          else finished = true;
        }
        if (!finished) await new Promise<void>((resolve) => (wake = resolve));
      }
      unsubscribe();
      await stream.writeSSE({
        event: "end",
        data: JSON.stringify({ status: runEngine.get(c.req.param("id")).status }),
      });
    });
  });

  const nameFrom = async (c: Context) => {
    const body = await c.req.json().catch(() => ({}));
    return (body as { name?: unknown }).name;
  };

  app.get("/api/channels", (c) => {
    const owners = goalIdsByChannel(db);
    const list = listChannels(db, { archived: c.req.query("archived") === "true" });
    return c.json(list.map((ch) => ({ ...ch, goalId: owners.get(ch.id) ?? null })));
  });
  app.post("/api/channels", async (c) => c.json(createChannel(db, await nameFrom(c)), 201));
  app.patch("/api/channels/:id", async (c) => {
    refuseGoalChannel(db, c.req.param("id"));
    return c.json(renameChannel(db, c.req.param("id"), await nameFrom(c)));
  });
  // No key and no endpoint ever leave the server: only the spec, its provider and whether a key is present.
  app.get("/api/models", (c) => c.json({ default: models?.defaultSpec ?? null, models: models?.list() ?? [] }));
  app.get("/api/channels/:id/model-settings", (c) => {
    const channel = getChannel(db, c.req.param("id"));
    const s = models?.settings?.(channel.model);
    if (!s) return c.json(null);
    return c.json({
      model: s.model,
      contextWindow: s.contextWindow,
      maxSteps: s.maxSteps,
      maxTokens: s.maxTokens,
      maxMillis: s.maxMillis,
    });
  });
  app.get("/api/settings/model-settings", async (c) => c.json((await modelSettings?.list()) ?? []));
  app.put("/api/settings/model-settings", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { model?: unknown; settings?: unknown };
    if (!modelSettings) throw new HTTPException(400, { message: "No models can be set up on this server." });
    if (typeof body.model !== "string" || !models?.list().some((m) => m.spec === body.model))
      throw new HTTPException(400, { message: "model must be one of the configured models." });
    if (typeof body.settings !== "object" || body.settings === null || Array.isArray(body.settings))
      throw new HTTPException(400, { message: "settings must be an object." });
    try {
      await modelSettings.update(body.model, body.settings as Record<string, unknown>);
    } catch (error) {
      if (error instanceof ModelSettingsError) throw new HTTPException(400, { message: error.message });
      throw error;
    }
    return c.json((await modelSettings.list()).find((m) => m.spec === body.model));
  });
  app.put("/api/settings/default-model", async (c) => {
    const { model } = (await c.req.json().catch(() => ({}))) as { model?: unknown };
    if (!models) throw new HTTPException(400, { message: "No models can be chosen on this server." });
    if (typeof model !== "string") throw new HTTPException(400, { message: "model must be a string." });
    try {
      models.setDefault(model);
    } catch (error) {
      throw new HTTPException(400, { message: (error as Error).message });
    }
    setSetting(db, "default_model", model);
    return c.json({ default: models.defaultSpec ?? null });
  });
  app.post("/api/channels/:id/branch", async (c) => {
    const { runId, name } = (await c.req.json().catch(() => ({}))) as { runId?: unknown; name?: unknown };
    if (typeof runId !== "string") throw new HTTPException(400, { message: "runId must be a string." });
    return c.json(
      await branchChannel(db, c.req.param("id"), runId, {
        name,
        summarize: branching,
        draftPurpose: purpose ? (id, seed) => purpose.draftFromSeed(id, seed) : undefined,
      }),
      201,
    );
  });
  // The drift nudge's two buttons. Accept is "New channel from here" on the latest run, named for the topic.
  app.post("/api/channels/:id/nudges/:checkId/accept", async (c) =>
    c.json(
      await acceptNudge(db, c.req.param("id"), c.req.param("checkId"), {
        summarize: branching,
        draftPurpose: purpose ? (id, seed, focus) => purpose.draftFromSeed(id, seed, focus) : undefined,
      }),
      201,
    ),
  );
  app.post("/api/channels/:id/nudges/:checkId/dismiss", (c) => {
    dismissNudge(db, c.req.param("id"), c.req.param("checkId"));
    return c.json({ dismissed: true });
  });
  app.post("/api/channels/:id/model", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { model?: unknown };
    const validate =
      models?.validate ??
      (() => {
        throw new Error("No models can be chosen on this server.");
      });
    return c.json(setChannelModel(db, c.req.param("id"), body.model, validate));
  });
  app.post("/api/channels/:id/archive", (c) => {
    refuseGoalChannel(db, c.req.param("id"));
    return c.json(archiveChannel(db, c.req.param("id")));
  });
  app.post("/api/channels/:id/restore", (c) => {
    refuseGoalChannel(db, c.req.param("id"));
    return c.json(restoreChannel(db, c.req.param("id")));
  });
  // A channel's purpose statement. A goal's channel has its brief instead, edited through the goal.
  const purposeOf = (id: string) => {
    getChannel(db, id);
    refuseGoalChannel(db, id);
    return { current: currentStatement(db, "channel", id) ?? null, versions: statementVersions(db, "channel", id) };
  };
  app.get("/api/channels/:id/purpose", (c) => c.json(purposeOf(c.req.param("id"))));
  app.put("/api/channels/:id/purpose", async (c) => {
    const id = c.req.param("id");
    purposeOf(id);
    const { text } = (await c.req.json().catch(() => ({}))) as { text?: unknown };
    if (typeof text !== "string") throw new HTTPException(400, { message: "text must be a string." });
    writeStatement(db, { scopeKind: "channel", scopeId: id, text, author: "user", confirmed: true });
    return c.json(purposeOf(id));
  });
  app.post("/api/channels/:id/purpose/draft", async (c) => {
    const id = c.req.param("id");
    purposeOf(id);
    if (!purpose) throw new HTTPException(503, { message: "No model is configured to draft with." });
    try {
      await purpose.draft(id);
    } catch (error) {
      throw new HTTPException(409, { message: `Couldn't draft one: ${(error as Error).message}` });
    }
    return c.json(purposeOf(id));
  });
  app.post("/api/channels/:id/purpose/versions/:version/restore", (c) => {
    const id = c.req.param("id");
    purposeOf(id);
    restoreStatement(db, "channel", id, Number(c.req.param("version")));
    return c.json(purposeOf(id));
  });
  app.get("/api/artifacts", (c) => {
    const kind = c.req.query("kind");
    const scope = c.req.query("scope");
    if (kind && !artifactKinds.includes(kind as ArtifactKind))
      throw new HTTPException(400, { message: "Unknown kind." });
    if (scope && scope !== "channel" && scope !== "goal") throw new HTTPException(400, { message: "Unknown scope." });
    return c.json(artifacts?.list({ kind, scope }) ?? []);
  });
  // A model wrote this file, perhaps from fetched web text, so it is never served in a way that can run script on
  // this origin: sandboxed, not sniffed, and downloaded rather than shown unless it is plain text or Markdown.
  app.get("/api/artifacts/:id/file", (c) => {
    const artifact = artifacts?.get(c.req.param("id"));
    const bytes = artifact && artifacts?.bytes(artifact);
    if (!artifact || !bytes) throw new HTTPException(404, { message: "No such artifact." });
    const shownAsText = artifact.mime === "text/plain" || artifact.mime === "text/markdown";
    const download = `attachment; filename="${
      artifact.file
        .split("/")
        .pop()
        ?.replace(/[^\w.-]/g, "_") ?? "artifact"
    }"`;
    return c.body(new Uint8Array(bytes), 200, {
      // Text and Markdown go out as text/plain so no browser treats them as markup.
      "content-type": shownAsText ? "text/plain; charset=utf-8" : `${artifact.mime}; charset=utf-8`,
      "content-security-policy": "sandbox",
      "x-content-type-options": "nosniff",
      ...(shownAsText ? {} : { "content-disposition": download }),
    });
  });
  app.get("/api/channels/:id/artifacts", (c) => {
    const id = c.req.param("id");
    getChannel(db, id);
    return c.json(artifacts?.forChannel(id) ?? []);
  });
  // The body may list artifact ids to delete with the channel; with none, every artifact is kept.
  app.delete("/api/channels/:id", async (c) => {
    const id = c.req.param("id");
    getChannel(db, id);
    refuseGoalChannel(db, id);
    const body = (await c.req.json().catch(() => null)) as { deleteArtifacts?: unknown } | null;
    const ids = body?.deleteArtifacts;
    if (ids !== undefined && (!Array.isArray(ids) || ids.some((x) => typeof x !== "string"))) {
      throw new HTTPException(400, { message: "deleteArtifacts is a list of artifact ids." });
    }
    if (ids?.length) artifacts?.deleteForChannel(id, ids as string[]);
    deleteChannel(db, id);
    return c.body(null, 204);
  });

  const body = async (c: Context) => (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
  app.get("/api/goals", (c) => c.json(listGoals(db, { archived: c.req.query("archived") === "true" })));
  // The client hides the schedule fields when there is no scheduler, so a user is never offered what POST /api/goals would refuse.
  app.get("/api/goals/options", (c) => c.json({ schedulesAvailable: Boolean(scheduler) }));
  // Only drafts: nothing is created until the form is confirmed with POST /api/goals.
  app.post("/api/goals/draft", async (c) => {
    if (!goalDrafter) throw new HTTPException(503, { message: "No model is configured to draft with." });
    const { text } = await body(c);
    if (typeof text !== "string") throw new HTTPException(400, { message: "text must be a string." });
    try {
      return c.json(await goalDrafter.draft(text));
    } catch (error) {
      throw new HTTPException(409, { message: `Couldn't draft a goal: ${(error as Error).message}` });
    }
  });
  app.post("/api/goals", async (c) => {
    const input = await body(c);
    const schedule = input.schedule as { cron?: unknown; prompt?: unknown } | undefined | null;
    if (schedule) {
      if (!scheduler) throw new HTTPException(503, { message: "Schedules aren't available yet." });
      if (typeof schedule.cron !== "string" || typeof schedule.prompt !== "string" || !schedule.prompt.trim())
        throw new HTTPException(400, { message: "A schedule needs a cron expression and a prompt." });
      // Checked before the goal exists, so a bad expression leaves nothing behind.
      try {
        scheduler.upcoming(schedule.cron, 1);
      } catch (error) {
        throw new HTTPException(400, { message: (error as Error).message });
      }
    }
    const goal = createGoal(db, input);
    if (schedule)
      scheduler?.createSchedule({
        goalId: goal.id,
        cron: String(schedule.cron),
        prompt: String(schedule.prompt).trim(),
      });
    return c.json(goal, 201);
  });
  app.get("/api/goals/:id", (c) => c.json(getGoal(db, c.req.param("id"))));
  app.patch("/api/goals/:id", async (c) => c.json(editGoal(db, c.req.param("id"), await body(c))));
  app.get("/api/goals/:id/brief-versions", (c) => c.json(briefHistory(db, c.req.param("id"))));
  app.post("/api/goals/:id/brief-versions/:version/restore", (c) =>
    c.json(restoreBrief(db, c.req.param("id"), Number(c.req.param("version")))),
  );
  // A run going in the goal's channel is cancelled first, so it cannot write to a goal that is being archived or removed.
  app.post("/api/goals/:id/archive", async (c) => {
    const id = c.req.param("id");
    if (engine) await cancelGoalRuns(db, engine, id);
    return c.json(archiveGoal(db, id, new Date(), scheduler));
  });
  app.post("/api/goals/:id/restore", (c) => c.json(restoreGoal(db, c.req.param("id"), new Date(), scheduler)));
  // The body may list artifact ids to delete with the goal's channel, as for a channel; with none, every artifact is kept.
  app.delete("/api/goals/:id", async (c) => {
    const id = c.req.param("id");
    const goal = getGoal(db, id);
    const body = (await c.req.json().catch(() => null)) as { deleteArtifacts?: unknown } | null;
    const ids = body?.deleteArtifacts;
    if (ids !== undefined && (!Array.isArray(ids) || ids.some((x) => typeof x !== "string"))) {
      throw new HTTPException(400, { message: "deleteArtifacts is a list of artifact ids." });
    }
    if (engine) await cancelGoalRuns(db, engine, id);
    if (ids?.length) artifacts?.deleteForChannel(goal.channelId, ids as string[]);
    deleteGoal(db, id, scheduler);
    return c.body(null, 204);
  });

  if (clientRoot) {
    app.use("/*", serveStatic({ root: clientRoot }));
    // Unknown paths fall back to the app shell so client-side routes survive a reload.
    app.get("*", serveStatic({ root: clientRoot, path: "index.html" }));
  }

  return app;
}

export function recordFirstStart(db: Db, now = new Date()) {
  db.insert(appMeta).values({ key: "first_started_at", value: now.toISOString() }).onConflictDoNothing().run();
}
