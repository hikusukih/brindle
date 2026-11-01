import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { ArtifactStore } from "../src/server/artifacts.js";
import { createChannel } from "../src/server/channels.js";
import { openDatabase } from "../src/server/db/index.js";
import { artifacts, events } from "../src/server/db/schema.js";
import type { ModelAdapter } from "../src/server/model/adapter.js";
import { type ScriptedFixture, ScriptedModel } from "../src/server/model/scripted.js";
import { defaultLimits, RunEngine, type RunLimits } from "../src/server/runs.js";
import { createArtifactTool, findArtifactsTool, readArtifactTool } from "../src/server/tools/artifacts.js";
import { type EffectLevel, ToolRegistry } from "../src/server/tools/registry.js";

// One scenario is one channel and a list of user messages, each sent as its own run. The expectations are
// per run, in order. `script` feeds the scripted model in CI; against a real model it is ignored, so
// expectations must hold for any reasonable reply and `eventTypes` (which pins the exact loop) is skipped.
export type RunExpectation = {
  status: "done" | "failed" | "stopped" | "cancelled";
  stopReasonIncludes?: string;
  /** Every string must appear in the concatenated reply text. */
  replyIncludes?: string[];
  /** Exact event types in order. Scripted mode only. */
  eventTypes?: string[];
  /** Answers to approval requests, in the order the cards appear. */
  approvals?: ("approve" | "decline")[];
  /** Every string must appear in some tool result stored on the run. */
  toolResultIncludes?: string[];
  /** The fake tools that actually ran, in order; an empty list asserts that nothing external was sent. */
  executed?: string[];
  /** Whether the first tool result was cut for the model. */
  toolResultTruncated?: boolean;
};

/** A stand-in tool whose result is fixed, so scenarios can exercise effect levels and result sizing. */
export type FakeTool = { name: string; effect: EffectLevel; result: string; repeat?: number };

/** An artifact made earlier in another channel, with a fixed id so a script can name it. Giving any adds the real artifact tools. */
export type SeedArtifact = {
  id: string;
  title: string;
  kind: "document" | "code" | "data" | "page" | "link";
  content: string;
  fromChannel: string;
};

export type Scenario = {
  name: string;
  description: string;
  messages: string[];
  script: ScriptedFixture;
  limits?: Partial<RunLimits>;
  tools?: FakeTool[];
  seedArtifacts?: SeedArtifact[];
  expect: RunExpectation[];
};

export type ScenarioResult = { name: string; failures: string[] };

export async function runScenario(scenario: Scenario, live?: ModelAdapter): Promise<ScenarioResult> {
  const db = openDatabase(":memory:");
  const tools = new ToolRegistry();
  let ran: string[] = [];
  for (const t of scenario.tools ?? []) {
    tools.register({
      name: t.name,
      description: t.name,
      effect: t.effect,
      parameters: { type: "object", properties: {} },
      execute: async () => {
        ran.push(t.name);
        return t.result.repeat(t.repeat ?? 1);
      },
    });
  }
  if (scenario.seedArtifacts?.length) {
    const dir = mkdtempSync(join(tmpdir(), "brindle-eval-"));
    const store = new ArtifactStore(db, dir);
    for (const a of scenario.seedArtifacts) {
      mkdirSync(join(dir, a.id), { recursive: true });
      writeFileSync(join(dir, a.id, "artifact.txt"), a.content);
      db.insert(artifacts)
        .values({
          id: a.id,
          title: a.title,
          kind: a.kind,
          scope: "channel",
          scopeId: createChannel(db, a.fromChannel).id,
          scopeName: a.fromChannel,
          runId: null,
          file: `${a.id}/artifact.txt`,
          mime: "text/plain",
          size: a.content.length,
          createdAt: new Date().toISOString(),
        })
        .run();
    }
    tools.register(createArtifactTool(store));
    tools.register(findArtifactsTool(store));
    tools.register(readArtifactTool(store));
  }
  const engine = new RunEngine(
    db,
    live ?? new ScriptedModel(scenario.script),
    { ...defaultLimits, ...scenario.limits },
    tools,
  );
  const channel = createChannel(db, scenario.name);
  const failures: string[] = [];

  if (scenario.messages.length !== scenario.expect.length) {
    return { name: scenario.name, failures: ["messages and expect must have the same length"] };
  }

  for (const [i, text] of scenario.messages.entries()) {
    const want = scenario.expect[i];
    if (!want) continue;
    const label = `run ${i + 1}`;
    ran = [];
    const run = engine.start(channel.id, text);
    // Answer approval cards as they appear; the run is parked in "waiting" until each one is answered.
    const answers = [...(want.approvals ?? [])];
    let settled = false;
    void engine.whenSettled(run.id).then(() => {
      settled = true;
    });
    while (!settled) {
      const open = db
        .select()
        .from(events)
        .where(eq(events.runId, run.id))
        .orderBy(events.seq)
        .all()
        .filter((e) => e.type === "approval_request" || e.type === "approval_decision");
      const asked = open.filter((e) => e.type === "approval_request").map((e) => String(JSON.parse(e.data).callId));
      const decided = new Set(
        open.filter((e) => e.type === "approval_decision").map((e) => String(JSON.parse(e.data).callId)),
      );
      const next = asked.find((id) => !decided.has(id));
      const answer = answers[0];
      if (next && answer) {
        answers.shift();
        engine.decide(run.id, next, answer);
      } else if (next && engine.get(run.id).status === "waiting") {
        failures.push(`${label}: waited on approval ${next} and no answer was scripted`);
        engine.cancel(run.id);
      }
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const done = engine.get(run.id);
    const stored = db.select().from(events).where(eq(events.runId, run.id)).orderBy(events.seq).all();

    if (done.status !== want.status) failures.push(`${label}: status was ${done.status}, expected ${want.status}`);
    if (want.stopReasonIncludes && !done.stopReason?.includes(want.stopReasonIncludes)) {
      failures.push(`${label}: stop reason "${done.stopReason}" lacks "${want.stopReasonIncludes}"`);
    }
    const reply = stored
      .filter((e) => e.type === "text")
      .map((e) => String((JSON.parse(e.data) as { text?: string }).text ?? ""))
      .join("");
    for (const needle of want.replyIncludes ?? []) {
      if (!reply.includes(needle)) failures.push(`${label}: reply lacks "${needle}"`);
    }
    const results = stored
      .filter((e) => e.type === "tool_result")
      .map((e) => JSON.parse(e.data) as { result: string; truncated?: boolean });
    for (const needle of want.toolResultIncludes ?? []) {
      if (!results.some((r) => r.result.includes(needle)))
        failures.push(`${label}: no tool result includes "${needle}"`);
    }
    if (want.executed && ran.join() !== want.executed.join()) {
      failures.push(`${label}: tools that ran were [${ran.join(", ")}], expected [${want.executed.join(", ")}]`);
    }
    if (want.toolResultTruncated !== undefined && results[0]?.truncated !== want.toolResultTruncated) {
      failures.push(
        `${label}: first tool result truncated was ${results[0]?.truncated}, expected ${want.toolResultTruncated}`,
      );
    }
    if (!live && want.eventTypes) {
      const types = stored.map((e) => e.type);
      if (types.join() !== want.eventTypes.join()) {
        failures.push(`${label}: events were [${types.join(", ")}], expected [${want.eventTypes.join(", ")}]`);
      }
    }
  }
  return { name: scenario.name, failures };
}
