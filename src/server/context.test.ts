import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createChannel } from "./channels.js";
import {
  assembleContext,
  ContextOverflow,
  keptPrompts,
  type PastRun,
  type PreviousRequest,
  runContext,
} from "./context.js";
import { openDatabase } from "./db/index.js";
import type { Message } from "./model/adapter.js";
import { ScriptedModel } from "./model/scripted.js";
import { defaultLimits, RunEngine } from "./runs.js";
import { ToolRegistry } from "./tools/registry.js";

const run = (id: string, words: number): { id: string; messages: Message[] } => ({
  id,
  messages: [
    { role: "user", content: `question ${id}` },
    { role: "assistant", content: "x".repeat(words * 4) },
  ],
});

describe("assembleContext", () => {
  it("orders instructions, scope statement, summary, past runs, then the current run", () => {
    const { messages, report } = assembleContext({
      past: [run("r1", 10)],
      current: [{ role: "user", content: "now" }],
      scopeStatement: { kind: "purpose", text: "Purpose: Rust" },
      summary: "Earlier facts",
    });
    expect(messages.map((m) => m.role)).toEqual(["system", "system", "system", "user", "assistant", "user"]);
    expect(messages[1]?.content).toBe("Purpose: Rust");
    expect(messages[2]?.content).toContain("Earlier facts");
    expect(messages.at(-1)?.content).toBe("now");
    expect(report.layers.map((l) => l.name)).toEqual([
      "instructions",
      "scope_statement",
      "summary",
      "recent_runs",
      "current_run",
    ]);
  });

  it("never exceeds its budget: drops whole oldest runs down to 40% and says so", () => {
    const past = Array.from({ length: 10 }, (_, i) => run(`r${i}`, 500));
    const { messages, report } = assembleContext({ past, current: [{ role: "user", content: "hi" }], window: 8_000 });
    const tokens = report.layers.reduce((n, l) => n + (l.name === "recent_runs" ? l.tokens : 0), 0);
    expect(report.runsDropped).toBeGreaterThan(0);
    expect(report.runsIncluded + report.runsDropped).toBe(10);
    expect(report.breaks).toContain("emergency_drop");
    expect(report.overflow[0]?.layer).toBe("recent_runs");
    // The newest runs survive, and each kept run is whole.
    expect(report.lastRunId).toBe("r9");
    expect(messages.filter((m) => m.role === "user")).toHaveLength(report.runsIncluded + 1);
    expect(tokens).toBeLessThan(report.budget);
  });

  it("is byte-stable: the same inputs plus one new message keep the earlier request as a prefix", () => {
    const past = [run("r1", 20)];
    const a = assembleContext({ past, current: [{ role: "user", content: "q" }] }).messages;
    const b = assembleContext({
      past,
      current: [
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
      ],
    }).messages;
    expect(JSON.stringify(b).startsWith(JSON.stringify(a).slice(0, -1))).toBe(true);
  });

  it("drops in chunks: after a drop, later messages keep the same start until history outgrows its share again", () => {
    const past: PastRun[] = [];
    let previous: PreviousRequest | null = null;
    const log: { first: string | null; dropped: boolean }[] = [];
    for (let i = 0; i < 30; i++) {
      past.push(run(`r${i}`, 500));
      const { report } = assembleContext({ past, current: [{ role: "user", content: "hi" }], window: 8_000, previous });
      log.push({ first: report.firstRunId, dropped: report.breaks.includes("emergency_drop") });
      previous = report;
    }
    const drops = log.filter((l) => l.dropped).length;
    // Each drop goes down to 40%, so it takes several messages to fill the share again.
    expect(drops).toBeGreaterThan(0);
    expect(drops).toBeLessThan(log.length / 3);
    for (let i = 1; i < log.length; i++) {
      if (!log[i]?.dropped) expect(log[i]?.first).toBe(log[i - 1]?.first);
    }
  });

  it("records a change of model, tool set or instructions as a planned break", () => {
    const base = { past: [run("r1", 10)], current: [{ role: "user" as const, content: "hi" }] };
    const first = assembleContext({ ...base, model: "a", toolSet: "t1" }).report;
    expect(assembleContext({ ...base, model: "a", toolSet: "t1", previous: first }).report.breaks).toEqual([]);
    expect(assembleContext({ ...base, model: "b", toolSet: "t2", previous: first }).report.breaks).toEqual([
      "model_change",
      "tool_set_change",
    ]);
    expect(
      assembleContext({ ...base, model: "a", toolSet: "t1", previous: { ...first, instructions: "old" } }).report
        .breaks,
    ).toEqual(["instructions_change"]);
    // A report stored before these fields existed is not counted as a break.
    const legacy = { firstRunId: "r1" };
    expect(assembleContext({ ...base, model: "a", toolSet: "t1", previous: legacy }).report.breaks).toEqual([]);
  });

  it("refuses to send a request over the window", () => {
    const big: Message[] = [{ role: "user", content: "x".repeat(200_000) }];
    expect(() => assembleContext({ past: [], current: big, window: 8_000 })).toThrow(ContextOverflow);
  });
});

describe("the run engine and context", () => {
  function setup(limits: Partial<typeof defaultLimits> = {}, turns = 1) {
    const db = openDatabase(":memory:");
    const model = new ScriptedModel({ turns: Array.from({ length: turns }, () => ({ text: ["ok"] })) });
    const engine = new RunEngine(db, model, { ...defaultLimits, ...limits });
    return { db, model, engine, channel: createChannel(db, "C"), app: createApp({ db, engine }) };
  }

  it("stores a report for each request and serves it", async () => {
    const { db, engine, channel, app } = setup();
    const r = engine.start(channel.id, "hello");
    await engine.whenSettled(r.id);
    const stored = runContext(db, r.id);
    expect(stored).toHaveLength(1);
    expect(stored[0]?.messages?.at(-1)).toEqual({ role: "user", content: "hello" });
    const res = await app.request(`/api/runs/${r.id}/context`);
    expect(((await res.json()) as unknown[]).length).toBe(1);
  });

  it("ends a run that cannot fit with a visible reason and sends nothing", async () => {
    const { db, model, engine, channel } = setup({ contextWindow: 5_000 });
    const r = engine.start(channel.id, "x".repeat(40_000));
    await engine.whenSettled(r.id);
    expect(engine.get(r.id)).toMatchObject({
      status: "stopped",
      stopReason: "this run ran out of room in the model's window",
    });
    expect(model.requests).toHaveLength(0);
    expect(runContext(db, r.id)[0]?.report.overflow[0]?.layer).toBe("current_run");
  });

  it("records an overflow at the step it happened, with nothing sent", async () => {
    const db = openDatabase(":memory:");
    const tools = new ToolRegistry().register({
      name: "huge",
      description: "huge",
      effect: "read",
      parameters: { type: "object", properties: {} },
      execute: async () => "x".repeat(100_000),
    });
    const model = new ScriptedModel({ turns: [{ toolCalls: [{ id: "c1", name: "huge", arguments: {} }] }] });
    const engine = new RunEngine(db, model, { ...defaultLimits, contextWindow: 5_000 }, tools);
    const r = engine.start(createChannel(db, "C").id, "go");
    await engine.whenSettled(r.id);
    expect(engine.get(r.id)?.stopReason).toBe("this run ran out of room in the model's window");
    const stored = runContext(db, r.id);
    expect(stored.map((s) => s.step)).toEqual([1, 2]);
    expect(stored[0]?.tools?.map((t) => t.name)).toEqual(["huge"]);
    expect(stored[1]).toMatchObject({ messages: null, tools: null });
    expect(stored[1]?.report.overflow[0]?.layer).toBe("current_run");
  });

  it("carries the start of history from one run to the next, so a drop is not repeated every message", async () => {
    const turns = 25;
    const db = openDatabase(":memory:");
    const model = new ScriptedModel({ turns: Array.from({ length: turns }, () => ({ text: ["y".repeat(2_000)] })) });
    const engine = new RunEngine(db, model, { ...defaultLimits, contextWindow: 8_000 });
    const channel = createChannel(db, "C");
    const breaks: string[][] = [];
    for (let i = 0; i < turns; i++) {
      const r = engine.start(channel.id, `m${i}`, new Date(Date.now() + i * 1000));
      await engine.whenSettled(r.id);
      breaks.push(runContext(db, r.id)[0]?.report.breaks ?? []);
    }
    const drops = breaks.filter((b) => b.includes("emergency_drop")).length;
    expect(drops).toBeGreaterThan(0);
    expect(drops).toBeLessThan(turns / 3);
    // The channel's model and tools stayed the same, so nothing else counts as a break.
    expect(breaks.flat().filter((b) => b !== "emergency_drop")).toEqual([]);
  });

  it("keeps the exact messages for only the newest 20 runs of a channel", async () => {
    const { db, engine, channel } = setup({}, keptPrompts + 2);
    const ids: string[] = [];
    for (let i = 0; i < keptPrompts + 2; i++) {
      const r = engine.start(channel.id, `m${i}`, new Date(Date.now() + i * 1000));
      await engine.whenSettled(r.id);
      ids.push(r.id);
    }
    expect(runContext(db, ids[0] as string)[0]?.messages).toBeNull();
    expect(runContext(db, ids[0] as string)[0]?.report.window).toBeGreaterThan(0);
    expect(runContext(db, ids.at(-1) as string)[0]?.messages).not.toBeNull();
  });
});
