import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createChannel, setChannelModel } from "./channels.js";
import { openDatabase } from "./db/index.js";
import { events } from "./db/schema.js";
import { type ScriptedFixture, ScriptedModel } from "./model/scripted.js";
import { defaultLimits, RunEngine, RunError, type RunLimits } from "./runs.js";
import { type Tool, ToolRegistry } from "./tools/registry.js";

const call = (id: string, name: string, args: Record<string, unknown> = {}) => ({ id, name, arguments: args });

function fakeTools(log: string[]) {
  const record = (name: string, effect: Tool["effect"], result = "done"): Tool => ({
    name,
    description: name,
    effect,
    parameters: { type: "object", properties: { x: { type: "string" } }, required: ["x"] },
    describeCall: (args) => `${name} with ${String(args.x)}`,
    execute: async (args) => {
      log.push(`${name}:${String(args.x)}`);
      return result;
    },
  });
  return new ToolRegistry()
    .register(record("lookup", "read", "found it"))
    .register(record("send_email", "external", "sent"))
    .register(record("huge", "read", "x".repeat(100_000)))
    .register({
      ...record("boom", "read"),
      execute: async () => {
        throw new Error("it broke");
      },
    });
}

function setup(fixture: ScriptedFixture, limits: Partial<RunLimits> = {}, file = ":memory:") {
  const db = openDatabase(file);
  const log: string[] = [];
  const model = new ScriptedModel(fixture);
  const engine = new RunEngine(db, model, { ...defaultLimits, ...limits }, fakeTools(log));
  const channel = createChannel(db, "Test");
  const stored = (runId: string) => db.select().from(events).where(eq(events.runId, runId)).orderBy(events.seq).all();
  const types = (runId: string) => stored(runId).map((e) => e.type);
  const data = (runId: string, type: string) =>
    stored(runId)
      .filter((e) => e.type === type)
      .map((e) => JSON.parse(e.data));
  return { db, engine, model, channel, log, types, data, app: createApp({ db, engine }) };
}

const waitUntil = async (fn: () => boolean) => {
  for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(fn()).toBe(true);
};

describe("tool calls in a run", () => {
  it("offers definitions, runs a read tool and feeds the result back", async () => {
    const { engine, model, channel, log, data } = setup({
      turns: [{ toolCalls: [call("c1", "lookup", { x: "q" })] }, { text: ["Got it."] }],
    });
    const run = engine.start(channel.id, "find q");
    await engine.whenSettled(run.id);
    expect(engine.get(run.id).status).toBe("done");
    expect(log).toEqual(["lookup:q"]);
    expect(model.requests[0]?.tools?.map((t) => t.name)).toContain("lookup");
    expect(model.requests[1]?.messages.at(-1)).toEqual({ role: "tool", toolCallId: "c1", content: "found it" });
    expect(data(run.id, "tool_result")[0]).toMatchObject({ result: "found it", isError: false, truncated: false });
  });

  it("turns unknown tools, bad arguments and throwing tools into error results and carries on", async () => {
    const { engine, channel, log, data } = setup({
      turns: [
        { toolCalls: [call("a", "nothing"), call("b", "lookup", {}), call("c", "boom", { x: "1" })] },
        { text: ["Recovered."] },
      ],
    });
    const run = engine.start(channel.id, "go");
    await engine.whenSettled(run.id);
    expect(engine.get(run.id).status).toBe("done");
    expect(log).toEqual([]);
    const results = data(run.id, "tool_result");
    expect(results.map((r) => r.isError)).toEqual([true, true, true]);
    expect(results[0].result).toMatch(/no tool named nothing/);
    expect(results[1].result).toMatch(/x is required/);
    expect(results[2].result).toBe("Error: it broke");
  });

  it("sends the model a cut copy of a huge result while the event keeps all of it", async () => {
    const { engine, model, channel, data } = setup({
      turns: [{ toolCalls: [call("c1", "huge", { x: "1" })] }, { text: ["ok"] }],
    });
    const run = engine.start(channel.id, "go");
    await engine.whenSettled(run.id);
    const sent = model.requests[1]?.messages.at(-1);
    expect(sent?.role === "tool" && sent.content.length).toBeLessThan(17_000);
    expect(sent?.role === "tool" && sent.content).toMatch(/characters omitted/);
    const [result] = data(run.id, "tool_result");
    expect(result.result.length).toBe(100_000);
    expect(result.truncated).toBe(true);
  });
});

describe("approvals", () => {
  const external = { turns: [{ toolCalls: [call("e1", "send_email", { x: "hi" })] }, { text: ["Sent."] }] };

  it("never runs an external tool before approval, then runs the stored arguments", async () => {
    const { engine, channel, log, types, data } = setup(external);
    const run = engine.start(channel.id, "mail");
    await waitUntil(() => engine.get(run.id).status === "waiting");
    expect(log).toEqual([]);
    expect(data(run.id, "approval_request")[0]).toMatchObject({
      callId: "e1",
      tool: "send_email",
      arguments: { x: "hi" },
      reason: "send_email with hi",
    });

    engine.decide(run.id, "e1", "approve");
    await engine.whenSettled(run.id);
    expect(log).toEqual(["send_email:hi"]);
    expect(engine.get(run.id).status).toBe("done");
    expect(types(run.id)).toEqual([
      "message",
      "tool_call",
      "approval_request",
      "approval_decision",
      "tool_result",
      "text",
    ]);
  });

  it("tells the model about a decline and does not run the tool", async () => {
    const { engine, model, channel, log } = setup(external);
    const run = engine.start(channel.id, "mail");
    await waitUntil(() => engine.get(run.id).status === "waiting");
    engine.decide(run.id, "e1", "decline");
    await engine.whenSettled(run.id);
    expect(log).toEqual([]);
    expect(model.requests[1]?.messages.at(-1)).toEqual({
      role: "tool",
      toolCallId: "e1",
      content: "The user declined this action.",
    });
    expect(engine.get(run.id).status).toBe("done");
  });

  it("keeps the channel busy while waiting, and cancel ends a waiting run", async () => {
    const { engine, channel } = setup(external);
    const run = engine.start(channel.id, "mail");
    await waitUntil(() => engine.get(run.id).status === "waiting");
    expect(() => engine.start(channel.id, "again")).toThrow(/still working/);
    engine.cancel(run.id);
    await engine.whenSettled(run.id);
    expect(engine.get(run.id).status).toBe("cancelled");
  });

  it("ends as 'approval not given' when nobody answers in time", async () => {
    const { engine, channel, log } = setup(external, { approvalMillis: 20 });
    const run = engine.start(channel.id, "mail");
    await engine.whenSettled(run.id);
    expect(engine.get(run.id)).toMatchObject({ status: "stopped", stopReason: "approval not given" });
    expect(log).toEqual([]);
  });

  it("does not count the wait against the time limit", async () => {
    const { engine, channel, log } = setup(external, { maxMillis: 60 });
    const run = engine.start(channel.id, "mail");
    await waitUntil(() => engine.get(run.id).status === "waiting");
    await new Promise((r) => setTimeout(r, 150));
    engine.decide(run.id, "e1", "approve");
    await engine.whenSettled(run.id);
    expect(engine.get(run.id).status).toBe("done");
    expect(log).toEqual(["send_email:hi"]);
  });

  it("puts every external call of a turn to the user together and runs them in order", async () => {
    const { engine, channel, log, types } = setup({
      turns: [
        {
          toolCalls: [
            call("e1", "send_email", { x: "one" }),
            call("r1", "lookup", { x: "mid" }),
            call("e2", "send_email", { x: "two" }),
          ],
        },
        { text: ["Done."] },
      ],
    });
    const run = engine.start(channel.id, "mail");
    await waitUntil(() => types(run.id).filter((t) => t === "approval_request").length === 2);
    // Answered out of order: the second card first.
    engine.decide(run.id, "e2", "approve");
    expect(log).toEqual([]);
    engine.decide(run.id, "e1", "decline");
    await engine.whenSettled(run.id);
    expect(log).toEqual(["lookup:mid", "send_email:two"]);
  });

  it("rejects unknown calls, repeat answers, bad decisions and ended runs", async () => {
    const { engine, channel } = setup(external);
    const run = engine.start(channel.id, "mail");
    await waitUntil(() => engine.get(run.id).status === "waiting");
    expect(() => engine.decide(run.id, "nope", "approve")).toThrow(/No such approval/);
    expect(() => engine.decide(run.id, "e1", "maybe")).toThrow(/approve/);
    engine.decide(run.id, "e1", "approve");
    expect(() => engine.decide(run.id, "e1", "approve")).toThrow(/already decided/);
    await engine.whenSettled(run.id);
    expect(() => engine.decide(run.id, "e1", "approve")).toThrow(/already ended/);
  });

  it("is reachable over HTTP", async () => {
    const { engine, channel, app, log } = setup(external);
    const run = engine.start(channel.id, "mail");
    await waitUntil(() => engine.get(run.id).status === "waiting");
    const res = await app.request(`/api/runs/${run.id}/approvals/e1`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision: "approve" }),
    });
    expect(res.status).toBe(200);
    await engine.whenSettled(run.id);
    expect(log).toEqual(["send_email:hi"]);
    const bad = await app.request(`/api/runs/${run.id}/approvals/e1`, { method: "POST", body: "{}" });
    expect(bad.status).toBe(400);
  });

  it("survives a restart: the waiting run resumes on the decision with its history intact", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "brindle-tools-")), "t.sqlite");
    const before = setup(
      {
        turns: [
          {
            text: ["Let me send that."],
            toolCalls: [call("e1", "send_email", { x: "hi" })],
            usage: { inputTokens: 5, outputTokens: 5 },
          },
        ],
      },
      {},
      file,
    );
    const run = before.engine.start(before.channel.id, "mail");
    await waitUntil(() => before.engine.get(run.id).status === "waiting");

    // A new process over the same file; the old loop is simply gone.
    const db = openDatabase(file);
    const log: string[] = [];
    const model = new ScriptedModel({ turns: [{ text: ["Sent after restart."] }] });
    const engine = new RunEngine(db, model, defaultLimits, fakeTools(log));
    expect(engine.recoverInterrupted()).toBe(0);
    expect(engine.get(run.id).status).toBe("waiting");

    engine.decide(run.id, "e1", "approve");
    await engine.whenSettled(run.id);
    expect(engine.get(run.id).status).toBe("done");
    expect(log).toEqual(["send_email:hi"]);
    expect(model.requests[0]?.messages.slice(1)).toEqual([
      { role: "user", content: "mail" },
      { role: "assistant", content: "Let me send that.", toolCalls: [call("e1", "send_email", { x: "hi" })] },
      { role: "tool", toolCallId: "e1", content: "sent" },
    ]);
  });

  it("resumes after a restart on the channel's own model, and refuses while that model is missing", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "brindle-tools-")), "t.sqlite");
    const before = setup(external, {}, file);
    setChannelModel(before.db, before.channel.id, "openai:chosen", () => {});
    const run = before.engine.start(before.channel.id, "mail");
    await waitUntil(() => before.engine.get(run.id).status === "waiting");

    const db = openDatabase(file);
    const chosen = new ScriptedModel({ turns: [{ text: ["Sent."] }] });
    let configured = false;
    const asked: (string | null)[] = [];
    const engine = new RunEngine(
      db,
      (spec) => {
        asked.push(spec);
        if (!configured) throw new Error("Set OPENAI_API_KEY to use an OpenAI-compatible model.");
        return chosen;
      },
      defaultLimits,
      fakeTools([]),
    );
    expect(() => engine.decide(run.id, "e1", "approve")).toThrow(RunError);
    // The card stays answerable once the model is configured again.
    configured = true;
    engine.decide(run.id, "e1", "approve");
    await engine.whenSettled(run.id);
    expect(engine.get(run.id).status).toBe("done");
    expect(asked).toEqual(["openai:chosen", "openai:chosen"]);
    expect(chosen.requests).toHaveLength(1);
  });

  it("lets a waiting run be cancelled after a restart", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "brindle-tools-")), "t.sqlite");
    const before = setup(external, {}, file);
    const run = before.engine.start(before.channel.id, "mail");
    await waitUntil(() => before.engine.get(run.id).status === "waiting");
    const engine = new RunEngine(openDatabase(file), new ScriptedModel({ turns: [] }), defaultLimits, fakeTools([]));
    engine.cancel(run.id);
    expect(engine.get(run.id).status).toBe("cancelled");
  });
});
