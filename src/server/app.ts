import { serveStatic } from "@hono/node-server/serve-static";
import { eq } from "drizzle-orm";
import { type Context, Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { streamSSE } from "hono/streaming";
import type { ArtifactStore } from "./artifacts.js";
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
import { runContext } from "./context.js";
import type { Db } from "./db/index.js";
import { appMeta } from "./db/schema.js";
import {
  archiveGoal,
  briefHistory,
  createGoal,
  deleteGoal,
  editGoal,
  GoalError,
  getGoal,
  listGoals,
  refuseGoalChannel,
  restoreBrief,
  restoreGoal,
} from "./goals.js";
import { channelTranscript, type RunEngine, RunError, type RunEvent } from "./runs.js";
import { ScopeStatementError } from "./scope-statements.js";

export type Greeting = {
  message: string;
  since: string;
};

type AppOptions = {
  db: Db;
  // Absent until a real adapter is configured; starting a run then answers 503.
  engine?: RunEngine;
  // What channels may be set to use; absent, setting a channel's model is refused.
  models?: { defaultSpec?: string; validate: (spec: string) => void };
  // Where artifacts live; absent, channel deletes cannot remove any.
  artifacts?: ArtifactStore;
  // Built client to serve; absent in development, where Vite serves it.
  clientRoot?: string;
};

export function createApp({ db, engine, models, artifacts, clientRoot }: AppOptions) {
  const app = new Hono();

  app.get("/api/greeting", (c) => {
    const row = db.select().from(appMeta).where(eq(appMeta.key, "first_started_at")).get();
    const greeting: Greeting = {
      message: "Hello from Brindle.",
      since: row?.value ?? new Date().toISOString(),
    };
    return c.json(greeting);
  });

  app.onError((err, c) => {
    if (err instanceof ChannelError) {
      const status = err.code === "not_found" ? 404 : err.code === "archived" ? 409 : 400;
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
    const body = (await c.req.json().catch(() => ({}))) as { decision?: unknown };
    return c.json(needEngine().decide(c.req.param("id"), c.req.param("callId"), body.decision));
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

  app.get("/api/channels", (c) => c.json(listChannels(db, { archived: c.req.query("archived") === "true" })));
  app.post("/api/channels", async (c) => c.json(createChannel(db, await nameFrom(c)), 201));
  app.patch("/api/channels/:id", async (c) => {
    refuseGoalChannel(db, c.req.param("id"));
    return c.json(renameChannel(db, c.req.param("id"), await nameFrom(c)));
  });
  app.get("/api/models", (c) => c.json({ default: models?.defaultSpec ?? null }));
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
  app.post("/api/goals", async (c) => c.json(createGoal(db, await body(c)), 201));
  app.get("/api/goals/:id", (c) => c.json(getGoal(db, c.req.param("id"))));
  app.patch("/api/goals/:id", async (c) => c.json(editGoal(db, c.req.param("id"), await body(c))));
  app.get("/api/goals/:id/brief-versions", (c) => c.json(briefHistory(db, c.req.param("id"))));
  app.post("/api/goals/:id/brief-versions/:version/restore", (c) =>
    c.json(restoreBrief(db, c.req.param("id"), Number(c.req.param("version")))),
  );
  app.post("/api/goals/:id/archive", (c) => c.json(archiveGoal(db, c.req.param("id"))));
  app.post("/api/goals/:id/restore", (c) => c.json(restoreGoal(db, c.req.param("id"))));
  app.delete("/api/goals/:id", (c) => {
    deleteGoal(db, c.req.param("id"));
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
