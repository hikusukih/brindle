import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createChannel } from "./channels.js";
import { openDatabase } from "./db/index.js";
import { events, runs } from "./db/schema.js";
import { type ModelAdapter, ModelError } from "./model/adapter.js";
import { type ScriptedFixture, ScriptedModel } from "./model/scripted.js";
import { defaultLimits, RunEngine, type RunLimits } from "./runs.js";

function setup(fixture: ScriptedFixture, limits: Partial<RunLimits> = {}, model?: ModelAdapter) {
  const db = openDatabase(":memory:");
  const scripted = new ScriptedModel(fixture);
  const engine = new RunEngine(db, model ?? scripted, { ...defaultLimits, ...limits });
  const channel = createChannel(db, "Test");
  const types = (runId: string) =>
    db
      .select()
      .from(events)
      .where(eq(events.runId, runId))
      .orderBy(events.seq)
      .all()
      .map((e) => e.type);
  return { db, engine, channel, scripted, types, app: createApp({ db, engine }) };
}

const call = (id: string) => ({ id, name: "nothing", arguments: {} });

describe("run engine", () => {
  it("persists the message and the reply, then marks the run done", async () => {
    const { engine, channel, types } = setup({ turns: [{ text: ["Hel", "lo."] }] });
    const run = engine.start(channel.id, "  hi ");
    await engine.whenSettled(run.id);

    expect(engine.get(run.id)).toMatchObject({ status: "done", stopReason: null });
    expect(types(run.id)).toEqual(["message", "text"]);
  });

  it("answers a tool call the registry doesn't know and carries on", async () => {
    const { engine, channel, types, scripted } = setup({ turns: [{ toolCalls: [call("c1")] }, { text: ["ok"] }] });
    const run = engine.start(channel.id, "go");
    await engine.whenSettled(run.id);

    expect(types(run.id)).toEqual(["message", "tool_call", "tool_result", "text"]);
    expect(scripted.requests[1]?.messages.at(-1)).toMatchObject({ role: "tool", toolCallId: "c1" });
  });

  it("sends earlier runs in the channel as history", async () => {
    const { engine, channel, scripted } = setup({ turns: [{ text: ["one"] }, { text: ["two"] }] });
    const first = engine.start(channel.id, "first");
    await engine.whenSettled(first.id);
    const second = engine.start(channel.id, "second");
    await engine.whenSettled(second.id);

    expect(scripted.requests[1]?.messages.slice(1).map((m) => m.content)).toEqual(["first", "one", "second"]);
  });

  it("ends a failed run with the error shown and lets the channel carry on", async () => {
    const { engine, channel, types } = setup({
      turns: [{ text: ["par"], fail: { kind: "unavailable", message: "backend down" } }, { text: ["back"] }],
    });
    const bad = engine.start(channel.id, "a");
    await engine.whenSettled(bad.id);
    expect(engine.get(bad.id)).toMatchObject({ status: "failed", stopReason: "backend down" });
    expect(types(bad.id)).toEqual(["message", "error"]);

    const good = engine.start(channel.id, "b");
    await engine.whenSettled(good.id);
    expect(engine.get(good.id).status).toBe("done");
  });

  it("refuses a second message while one is running, and empty or archived input", async () => {
    const { engine, channel, db } = setup({ turns: [{ text: ["x"] }] });
    const run = engine.start(channel.id, "a");
    expect(() => engine.start(channel.id, "b")).toThrow(/still working/);
    await engine.whenSettled(run.id);
    expect(() => engine.start(channel.id, "  ")).toThrow(/empty/);
    expect(() => engine.start("missing", "a")).toThrow(/No such channel/);
    const archived = createChannel(db, "Old");
    db.update((await import("./db/schema.js")).channels)
      .set({ archivedAt: "2026-01-01T00:00:00.000Z" })
      .run();
    expect(() => engine.start(archived.id, "a")).toThrow(/Restore/);
  });

  describe("limits", () => {
    it("stops at the step limit with a visible reason", async () => {
      const turns = Array.from({ length: 5 }, (_, i) => ({ toolCalls: [call(`c${i}`)] }));
      const { engine, channel, types } = setup({ turns }, { maxSteps: 2 });
      const run = engine.start(channel.id, "loop");
      await engine.whenSettled(run.id);

      expect(engine.get(run.id)).toMatchObject({ status: "stopped", stopReason: "step limit (2) reached" });
      expect(types(run.id).at(-1)).toBe("error");
    });

    it("stops at the token limit", async () => {
      const usage = { inputTokens: 60, outputTokens: 60 };
      const { engine, channel } = setup(
        { turns: [{ toolCalls: [call("c")], usage }, { text: ["no"] }] },
        { maxTokens: 100 },
      );
      const run = engine.start(channel.id, "x");
      await engine.whenSettled(run.id);
      expect(engine.get(run.id)).toMatchObject({ status: "stopped", stopReason: "token limit (100) reached" });
    });

    it("stops at the time limit and cancels the model call", async () => {
      const hang: ModelAdapter = {
        async *stream(req) {
          await new Promise((_, reject) =>
            req.signal?.addEventListener("abort", () => reject(new ModelError("aborted", "aborted", false))),
          );
          yield { type: "text", text: "" };
        },
      };
      const { engine, channel } = setup({ turns: [] }, { maxMillis: 20 }, hang);
      const run = engine.start(channel.id, "x");
      await engine.whenSettled(run.id);
      expect(engine.get(run.id)).toMatchObject({ status: "stopped", stopReason: "time limit (0.02s) reached" });
    });
  });

  it("cancels a running run and rejects cancelling a finished one", async () => {
    const hang: ModelAdapter = {
      async *stream(req) {
        await new Promise((_, reject) =>
          req.signal?.addEventListener("abort", () => reject(new ModelError("aborted", "aborted", false))),
        );
        yield { type: "text", text: "" };
      },
    };
    const { engine, channel } = setup({ turns: [] }, {}, hang);
    const run = engine.start(channel.id, "x");
    engine.cancel(run.id);
    await engine.whenSettled(run.id);
    expect(engine.get(run.id)).toMatchObject({ status: "cancelled", stopReason: "cancelled by you" });
    expect(() => engine.cancel(run.id)).toThrow(/already ended/);
  });

  it("marks runs a dead process left running as failed on startup", () => {
    const { db, engine, channel } = setup({ turns: [] });
    db.insert(runs)
      .values({ id: "r1", channelId: channel.id, status: "running", startedAt: "2026-01-01T00:00:00.000Z" })
      .run();
    expect(engine.recoverInterrupted()).toBe(1);
    expect(engine.get("r1")).toMatchObject({ status: "failed", stopReason: "server restarted" });
  });
});

describe("run routes", () => {
  it("starts a run, streams its events over SSE and ends the stream", async () => {
    const { app, engine, channel } = setup({ turns: [{ text: ["Hi"] }] });
    const res = await app.request(`/api/channels/${channel.id}/runs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "hello" }),
    });
    expect(res.status).toBe(201);
    const run = (await res.json()) as { id: string };

    const stream = await app.request(`/api/runs/${run.id}/events`);
    const body = await stream.text();
    expect(stream.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain("event: message");
    expect(body).toContain("event: text");
    expect(body).toMatch(/event: end\ndata: {"status":"done"}/);

    await engine.whenSettled(run.id);
    const resumed = await (
      await app.request(`/api/runs/${run.id}/events`, { headers: { "last-event-id": "1" } })
    ).text();
    expect(resumed).not.toContain("event: message");
    expect(resumed).toContain("event: text");
  });

  it("answers 400, 404, 409 and 503 where they apply", async () => {
    const { app, channel } = setup({ turns: [] });
    const post = (path: string, body: unknown) =>
      app.request(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post(`/api/channels/${channel.id}/runs`, { text: "" })).status).toBe(400);
    expect((await post("/api/channels/nope/runs", { text: "a" })).status).toBe(404);
    expect((await post("/api/runs/nope/cancel", {})).status).toBe(404);

    const bare = createApp({ db: openDatabase(":memory:") });
    expect((await bare.request("/api/channels/x/runs", { method: "POST" })).status).toBe(503);
  });
});

describe("GET /api/channels/:id/runs", () => {
  it("returns the channel's runs oldest first with their events, and 404 for an unknown channel", async () => {
    const { engine, channel, app } = setup({ turns: [{ text: ["one"] }, { text: ["two"] }] });
    for (const text of ["first", "second"]) {
      const run = engine.start(channel.id, text);
      await engine.whenSettled(run.id);
    }

    const res = await app.request(`/api/channels/${channel.id}/runs`);
    const body = (await res.json()) as { status: string; events: { type: string; data: string }[] }[];
    expect(body.map((r) => r.events.map((e) => e.type))).toEqual([
      ["message", "text"],
      ["message", "text"],
    ]);
    expect(JSON.parse(body[1]?.events[0]?.data ?? "null")).toEqual({ text: "second" });

    expect((await app.request("/api/channels/nope/runs")).status).toBe(404);
  });
});
