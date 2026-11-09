import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { ArtifactStore } from "../src/server/artifacts.js";
import { branchChannel } from "../src/server/branch.js";
import { createChannel } from "../src/server/channels.js";
import { modelSummarizer } from "../src/server/compaction.js";
import { runContext } from "../src/server/context.js";
import { openDatabase } from "../src/server/db/index.js";
import { artifacts, events, goals, runs, schedules, summaries } from "../src/server/db/schema.js";
import { createGoal } from "../src/server/goals.js";
import type { McpClient } from "../src/server/mcp/client.js";
import { effectFor, mcpTool } from "../src/server/mcp/index.js";
import type { ModelAdapter } from "../src/server/model/adapter.js";
import { type ScriptedFixture, ScriptedModel } from "../src/server/model/scripted.js";
import { defaultLimits, RunEngine, type RunLimits } from "../src/server/runs.js";
import { Scheduler } from "../src/server/scheduler.js";
import { createArtifactTool, findArtifactsTool, readArtifactTool } from "../src/server/tools/artifacts.js";
import { proposeGoalTool } from "../src/server/tools/goal.js";
import { type EffectLevel, ToolRegistry } from "../src/server/tools/registry.js";
import { proposeScheduleTool } from "../src/server/tools/schedule.js";

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
  /** How many summary versions exist after this run, once any fold has finished. Scripted mode only. */
  summaryVersions?: number;
  /** Every string must appear in the channel's latest summary. Holds for a real utility model too. */
  summaryIncludes?: string[];
  /** Every string must appear in the messages of this run's last request: a fact reached the model, from the summary or the history. */
  contextIncludes?: string[];
  /** How many schedules exist after this run, for scenarios with a `goal`. Holds against a real model too. */
  schedules?: number;
  /** How many goals exist after this run. Holds against a real model too. */
  goals?: number;
  /** The schedules' cron expressions after this run, in the order made. Scripted mode only: a real model may word them differently. */
  crons?: string[];
};

/** A stand-in tool whose result is fixed, so scenarios can exercise effect levels and result sizing. */
export type FakeTool = { name: string; effect: EffectLevel; result: string; repeat?: number };

/**
 * A plug-in server with fixed tools, registered through the same wrapper and effect rule as a real MCP server, so a
 * scenario can plant text in a tool's description (which goes to the model as part of the tool list) or its result,
 * and leave a tool unclassified to check that it asks.
 */
export type FakeMcpServer = {
  name: string;
  effects?: Record<string, EffectLevel>;
  defaultEffect?: EffectLevel;
  tools: { name: string; description: string; result: string }[];
};

/** An artifact made earlier in another channel, with a fixed id so a script can name it. Giving any adds the real artifact tools. */
export type SeedArtifact = {
  id: string;
  title: string;
  kind: "document" | "code" | "data" | "page" | "link";
  content: string;
  fromChannel: string;
};

/** Runs the scenario in a goal's own channel and adds the real `propose_schedule` tool, with the clock in New York. */
export type ScenarioGoal = { title: string; brief: string };

export type Scenario = {
  name: string;
  description: string;
  messages: string[];
  script: ScriptedFixture;
  limits?: Partial<RunLimits>;
  /** Turns on rolling compaction with a scripted utility model (or the live model, in live mode). */
  compaction?: { script: ScriptedFixture };
  /**
   * After every message: "New channel from here" on run `fromRun` (1-based) with a utility model that follows `script`,
   * then `followUp` sent in the new channel. The new channel's last request must contain every `contextIncludes`
   * string, and the source must still hold every run it had.
   */
  branch?: { fromRun: number; script: ScriptedFixture; followUp: string; contextIncludes: string[] };
  tools?: FakeTool[];
  seedArtifacts?: SeedArtifact[];
  mcpServers?: FakeMcpServer[];
  goal?: ScenarioGoal;
  /** Adds the real `propose_goal` tool, in an ordinary channel. */
  proposeGoal?: boolean;
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
  for (const server of scenario.mcpServers ?? []) {
    for (const info of server.tools) {
      // Only callTool is used once a tool is wrapped, so a stub stands in for the stdio client.
      const client = {
        callTool: async () => {
          ran.push(`${server.name}__${info.name}`);
          return info.result;
        },
      } as unknown as McpClient;
      tools.register(
        mcpTool(
          client,
          server.name,
          { ...info, inputSchema: { type: "object", properties: {} } },
          effectFor(server, info.name),
        ),
      );
    }
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
  // The scheduler is only used to store and read schedules; nothing here starts a run from one.
  const scheduler = new Scheduler(
    db,
    { prepareRun: () => "unused", beginRun: () => {}, goalBusy: () => false },
    { timeZone: "America/New_York" },
  );
  const goal = scenario.goal ? createGoal(db, scenario.goal) : undefined;
  if (goal) tools.register(proposeScheduleTool(db, scheduler));
  if (scenario.proposeGoal) tools.register(proposeGoalTool(db, scheduler));
  const engine = new RunEngine(
    db,
    live ?? new ScriptedModel(scenario.script),
    { ...defaultLimits, ...scenario.limits },
    tools,
    scenario.compaction ? { utilityModel: live ?? new ScriptedModel(scenario.compaction.script) } : undefined,
  );
  const channel = goal ? { id: goal.channelId } : createChannel(db, scenario.name);
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
    await engine.whenCompacted(channel.id);
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
    const summaryRows = db.select().from(summaries).orderBy(summaries.version).all();
    if (!live && want.summaryVersions !== undefined && summaryRows.length !== want.summaryVersions) {
      failures.push(`${label}: ${summaryRows.length} summary version(s) exist, expected ${want.summaryVersions}`);
    }
    for (const needle of want.summaryIncludes ?? []) {
      if (!summaryRows.at(-1)?.text.includes(needle)) failures.push(`${label}: latest summary lacks "${needle}"`);
    }
    if (want.contextIncludes) {
      const sent = runContext(db, run.id)
        .filter((c) => c.messages)
        .at(-1)
        ?.messages?.map((m) => m.content)
        .join("\n");
      for (const needle of want.contextIncludes) {
        if (!sent?.includes(needle)) failures.push(`${label}: the request lacks "${needle}"`);
      }
    }
    if (want.goals !== undefined) {
      const count = db.select().from(goals).all().length;
      if (count !== want.goals) failures.push(`${label}: ${count} goal(s) exist, expected ${want.goals}`);
    }
    const made = db.select().from(schedules).orderBy(schedules.createdAt).all();
    if (want.schedules !== undefined && made.length !== want.schedules) {
      failures.push(`${label}: ${made.length} schedule(s) exist, expected ${want.schedules}`);
    }
    if (!live && want.crons && made.map((s) => s.cron).join("|") !== want.crons.join("|")) {
      failures.push(
        `${label}: schedules were [${made.map((s) => s.cron).join(", ")}], expected [${want.crons.join(", ")}]`,
      );
    }
    if (!live && want.eventTypes) {
      const types = stored.map((e) => e.type);
      if (types.join() !== want.eventTypes.join()) {
        failures.push(`${label}: events were [${types.join(", ")}], expected [${want.eventTypes.join(", ")}]`);
      }
    }
  }
  if (scenario.branch) {
    const b = scenario.branch;
    const runsBefore = db.select().from(runs).where(eq(runs.channelId, channel.id)).all();
    const from = runsBefore.sort((x, y) => x.startedAt.localeCompare(y.startedAt))[b.fromRun - 1];
    if (!from) failures.push(`branch: run ${b.fromRun} does not exist`);
    else {
      const branched = await branchChannel(db, channel.id, from.id, {
        summarize: modelSummarizer(live ?? new ScriptedModel(b.script)),
      });
      const next = engine.start(branched.id, b.followUp);
      await engine.whenSettled(next.id);
      const sent = runContext(db, next.id)
        .filter((c) => c.messages)
        .at(-1)
        ?.messages?.map((m) => m.content)
        .join("\n");
      for (const needle of b.contextIncludes) {
        if (!sent?.includes(needle)) failures.push(`branch: the new channel's request lacks "${needle}"`);
      }
      const after = db.select().from(runs).where(eq(runs.channelId, channel.id)).all().length;
      if (after !== runsBefore.length)
        failures.push(`branch: the source has ${after} run(s), expected ${runsBefore.length}`);
    }
  }
  return { name: scenario.name, failures };
}
