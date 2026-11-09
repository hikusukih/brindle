import { describe, expect, it } from "vitest";
import { createChannel } from "../channels.js";
import { openDatabase } from "../db/index.js";
import { events, runs } from "../db/schema.js";
import { searchHistoryTool } from "./history.js";

function setup() {
  const db = openDatabase(":memory:");
  const a = createChannel(db, "A");
  const b = createChannel(db, "B");
  let n = 0;
  const addRun = (channelId: string, id: string, started: string, evs: [string, Record<string, unknown>][]) => {
    db.insert(runs).values({ id, channelId, status: "done", startedAt: started }).run();
    for (const [seq, [type, data]] of evs.entries()) {
      db.insert(events)
        .values({ id: `e${n++}`, runId: id, seq, type, data: JSON.stringify(data), createdAt: started })
        .run();
    }
  };
  const ctx = (channelId: string, runId = "current") => ({
    runId,
    scope: { kind: "channel", id: channelId } as const,
    signal: new AbortController().signal,
    log: () => {},
    emit: () => {},
  });
  return { db, a, b, addRun, ctx };
}

describe("search_history", () => {
  it("finds verbatim passages in this channel only, newest first, with their run", async () => {
    const { db, a, b, addRun, ctx } = setup();
    addRun(a.id, "r1", "2026-01-01T00:00:00Z", [
      ["message", { text: "My cat is named Biscuit." }],
      ["text", { text: "Nice name." }],
    ]);
    addRun(a.id, "r2", "2026-01-02T00:00:00Z", [["message", { text: "Remind me about the BISCUIT vet visit." }]]);
    addRun(b.id, "r3", "2026-01-03T00:00:00Z", [["message", { text: "Biscuit in another channel" }]]);
    const out = await searchHistoryTool(db).execute({ query: "biscuit" }, ctx(a.id));
    expect(out).toContain("run r2");
    expect(out).toContain("Remind me about the BISCUIT vet visit.");
    expect(out).toContain("My cat is named Biscuit.");
    expect(out).not.toContain("another channel");
    expect(out.indexOf("run r2")).toBeLessThan(out.indexOf("run r1"));
  });

  it("leaves out the current run, searches tool results, honors the limit and reports no match", async () => {
    const { db, a, addRun, ctx } = setup();
    addRun(a.id, "r1", "2026-01-01T00:00:00Z", [
      ["tool_result", { id: "c", result: "full text zebra", modelResult: "cut text" }],
    ]);
    addRun(a.id, "r2", "2026-01-02T00:00:00Z", [["message", { text: "zebra one" }]]);
    addRun(a.id, "current", "2026-01-03T00:00:00Z", [["message", { text: "zebra now" }]]);
    const tool = searchHistoryTool(db);
    expect(await tool.execute({ query: "zebra" }, ctx(a.id))).not.toContain("zebra now");
    expect(await tool.execute({ query: "cut text" }, ctx(a.id))).toContain("tool result");
    expect(await tool.execute({ query: "zebra" }, ctx(a.id))).not.toContain("full text");
    expect((await tool.execute({ query: "zebra", limit: 1 }, ctx(a.id))).match(/--- run/g)).toHaveLength(1);
    expect(await tool.execute({ query: "giraffe" }, ctx(a.id))).toBe("No earlier message in this channel matches.");
    expect(await tool.execute({ query: "  " }, ctx(a.id))).toMatch(/^Error/);
  });

  it("cuts a long message around the match", async () => {
    const { db, a, addRun, ctx } = setup();
    addRun(a.id, "r1", "2026-01-01T00:00:00Z", [
      ["message", { text: `${"x".repeat(2000)} needle ${"y".repeat(2000)}` }],
    ]);
    const out = await searchHistoryTool(db).execute({ query: "needle" }, ctx(a.id));
    expect(out).toContain("needle");
    expect(out.length).toBeLessThan(1000);
    expect(out).toContain("[...]");
  });
});
