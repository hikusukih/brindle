import { randomUUID } from "node:crypto";
import { asc, eq, inArray } from "drizzle-orm";
import { getChannel } from "./channels.js";
import {
  assembleContext,
  ContextOverflow,
  defaultContextWindow,
  fingerprint,
  type PastRun,
  previousRequest,
  recordContext,
} from "./context.js";
import type { Db } from "./db/index.js";
import { events, runs } from "./db/schema.js";
import { type Message, type ModelAdapter, ModelError, type ToolCall } from "./model/adapter.js";
import { scopeStatementFor } from "./scope-statements.js";
import { needsApproval, ToolRegistry, validateArguments } from "./tools/registry.js";
import { estimateTokens, sizeResult } from "./tools/sizing.js";

export type Run = typeof runs.$inferSelect;
export type RunEvent = typeof events.$inferSelect;

export type RunLimits = {
  /** Model calls in one run. */
  maxSteps: number;
  /** Input plus output tokens summed over the run. */
  maxTokens: number;
  maxMillis: number;
  /** The model's context window in tokens; a per-model setting arrives later. */
  contextWindow: number;
  /** How long a run may wait for an approval before it ends as "approval not given". */
  approvalMillis: number;
};

export const defaultLimits: RunLimits = {
  maxSteps: 10,
  maxTokens: 100_000,
  maxMillis: 120_000,
  contextWindow: defaultContextWindow,
  approvalMillis: 24 * 60 * 60 * 1000,
};

export class RunError extends Error {
  constructor(
    readonly code: "not_found" | "busy" | "invalid_text" | "finished" | "invalid_decision" | "no_model",
    message: string,
  ) {
    super(message);
  }
}

/** One adapter for every channel, or a function that picks by the channel's model spec (null: the default). */
export type ModelSource = ModelAdapter | ((spec: string | null) => ModelAdapter);

export type RunWithEvents = Run & { events: RunEvent[] };

/** A channel's runs oldest first, each with its stored events, for drawing the transcript. Needs no model, so it works without an engine. */
export function channelTranscript(db: Db, channelId: string): RunWithEvents[] {
  getChannel(db, channelId);
  const channelRuns = db.select().from(runs).where(eq(runs.channelId, channelId)).orderBy(asc(runs.startedAt)).all();
  if (!channelRuns.length) return [];
  const rows = db
    .select()
    .from(events)
    .where(
      inArray(
        events.runId,
        channelRuns.map((r) => r.id),
      ),
    )
    .orderBy(asc(events.seq))
    .all();
  return channelRuns.map((run) => ({ ...run, events: rows.filter((e) => e.runId === run.id) }));
}

type Decision = "approve" | "decline";

/** The in-memory side of a run's approvals; the stored events are what survives a restart. */
type LiveRun = { decisions: Map<string, Decision>; waiters: Map<string, () => void> };

/** What a run needs to pick up where a restart left it: the unanswered calls of its last step and its counters. */
type Resume = {
  step: number;
  tokens: number;
  spentMillis: number;
  calls: ToolCall[];
  decisions: Map<string, Decision>;
  requested: Set<string>;
};

function payload(e: RunEvent): Record<string, unknown> {
  return JSON.parse(e.data) as Record<string, unknown>;
}

/** Rebuilds the model's view of one run from its stored events: the user message, each step's reply and tool calls, each tool result. */
function messagesFromEvents(stored: RunEvent[]): Message[] {
  const out: Message[] = [];
  let turn: Extract<Message, { role: "assistant" }> | undefined;
  for (const e of stored) {
    const d = payload(e);
    if (e.type === "message") {
      out.push({ role: "user", content: String(d.text) });
      turn = undefined;
    } else if (e.type === "text") {
      turn = { role: "assistant", content: String(d.text) };
      out.push(turn);
    } else if (e.type === "tool_call") {
      if (!turn) {
        turn = { role: "assistant", content: "" };
        out.push(turn);
      }
      turn.toolCalls = [
        ...(turn.toolCalls ?? []),
        { id: String(d.id), name: String(d.name), arguments: d.arguments as Record<string, unknown> },
      ];
    } else if (e.type === "tool_result") {
      out.push({ role: "tool", toolCallId: String(d.id), content: String(d.modelResult ?? d.result) });
      turn = undefined;
    }
  }
  return out;
}

/** A run that ended mid-step can leave a tool call with no result, which providers reject; drop those calls. */
function closeCalls(messages: Message[]): Message[] {
  const answered = new Set(messages.flatMap((m) => (m.role === "tool" ? [m.toolCallId] : [])));
  return messages.flatMap((m): Message[] => {
    if (m.role !== "assistant" || !m.toolCalls) return [m];
    const toolCalls = m.toolCalls.filter((c) => answered.has(c.id));
    if (!toolCalls.length && !m.content) return [];
    return [{ ...m, toolCalls: toolCalls.length ? toolCalls : undefined }];
  });
}

type Listener = (event: RunEvent | null) => void;

/** Owns the live side of runs: abort handles and SSE subscribers. Persistence stays in the database. */
export class RunEngine {
  private readonly active = new Map<string, AbortController>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly settled = new Map<string, Promise<void>>();
  private readonly live = new Map<string, LiveRun>();
  /** Called after a run ends as done, for housekeeping such as drafting a purpose statement. Must not throw into the run. */
  onRunDone?: (channelId: string) => void;

  constructor(
    private readonly db: Db,
    private readonly model: ModelSource,
    private readonly limits: RunLimits = defaultLimits,
    private readonly tools: ToolRegistry = new ToolRegistry(),
  ) {}

  /** Runs left "running" by a previous process can never finish; say so instead of leaving them spinning. */
  recoverInterrupted(now = new Date()): number {
    const stale = this.db.select().from(runs).where(eq(runs.status, "running")).all();
    for (const run of stale) {
      this.append(run.id, "error", { message: "The server restarted while this run was working." }, now);
      this.finish(run.id, "failed", "server restarted", now);
    }
    return stale.length;
  }

  start(channelId: string, text: unknown, now = new Date()): Run {
    const channel = getChannel(this.db, channelId);
    if (channel.archivedAt) throw new RunError("busy", "Restore the channel before sending a message.");
    const message = typeof text === "string" ? text.trim() : "";
    if (!message) throw new RunError("invalid_text", "A message can't be empty.");
    const running = this.db.select().from(runs).where(eq(runs.channelId, channelId)).all();
    if (running.some((r) => r.status === "running" || r.status === "waiting"))
      throw new RunError("busy", "This channel is still working on a message.");

    const model = this.modelFor(channel.model);
    const past = this.history(channelId);
    const run: Run = {
      id: randomUUID(),
      channelId,
      status: "running",
      stopReason: null,
      startedAt: now.toISOString(),
      endedAt: null,
    };
    this.db.insert(runs).values(run).run();
    this.append(run.id, "message", { text: message }, now);

    const controller = new AbortController();
    this.active.set(run.id, controller);
    this.settled.set(
      run.id,
      this.loop(run.id, channelId, model, past, [{ role: "user", content: message }], controller),
    );
    return run;
  }

  /** Resolves once the run's loop has ended; tests use it instead of sleeping. */
  whenSettled(runId: string): Promise<void> {
    return this.settled.get(runId) ?? Promise.resolve();
  }

  cancel(runId: string): Run {
    const run = this.get(runId);
    if (run.status !== "running" && run.status !== "waiting") {
      throw new RunError("finished", "This run has already ended.");
    }
    const controller = this.active.get(runId);
    if (controller) controller.abort(new CancelledByUser());
    // A run left waiting by a restart has no loop to abort, so it is ended here.
    else if (run.status === "waiting") this.finish(runId, "cancelled", "cancelled by you");
    return run;
  }

  /**
   * Records the user's answer to an approval card. A live run picks it up; a run left waiting by a
   * restart is rebuilt from its stored events and carried on from the call that was waiting.
   */
  decide(runId: string, callId: string, decision: unknown): Run {
    if (decision !== "approve" && decision !== "decline") {
      throw new RunError("invalid_decision", 'A decision is "approve" or "decline".');
    }
    const run = this.get(runId);
    if (run.status !== "running" && run.status !== "waiting")
      throw new RunError("finished", "This run has already ended.");
    const stored = this.storedEvents(runId);
    const asked = (e: RunEvent, type: string) => e.type === type && payload(e).callId === callId;
    if (!stored.some((e) => asked(e, "approval_request"))) throw new RunError("not_found", "No such approval request.");
    if (stored.some((e) => asked(e, "approval_decision"))) throw new RunError("finished", "That was already decided.");

    const state = this.live.get(runId);
    // Resolved before the decision is stored, so a model that is no longer configured leaves the card answerable.
    const model = state ? undefined : this.modelFor(getChannel(this.db, run.channelId).model);
    this.append(runId, "approval_decision", { callId, decision });
    if (state) {
      state.decisions.set(callId, decision);
      state.waiters.get(callId)?.();
    } else if (model) {
      this.resume(run, model);
    }
    return this.get(runId);
  }

  private resume(run: Run, model: ModelAdapter) {
    const stored = this.storedEvents(run.id);
    const decisions = new Map<string, Decision>();
    const requested = new Set<string>();
    const answered = new Set<string>();
    const calls: ToolCall[] = [];
    for (const e of stored) {
      const d = payload(e);
      if (e.type === "approval_request") requested.add(String(d.callId));
      else if (e.type === "approval_decision") decisions.set(String(d.callId), d.decision as Decision);
      else if (e.type === "tool_result") answered.add(String(d.id));
      else if (e.type === "tool_call")
        calls.push({ id: String(d.id), name: String(d.name), arguments: d.arguments as Record<string, unknown> });
    }
    const snapshot = payload([...stored].reverse().find((e) => e.type === "approval_request") as RunEvent);
    const controller = new AbortController();
    this.active.set(run.id, controller);
    const past = this.history(run.channelId, run.id);
    const current = messagesFromEvents(stored);
    const resume: Resume = {
      step: Number(snapshot.step),
      tokens: Number(snapshot.tokens),
      spentMillis: Number(snapshot.spentMillis),
      calls: calls.filter((c) => !answered.has(c.id)),
      decisions,
      requested,
    };
    this.settled.set(run.id, this.loop(run.id, run.channelId, model, past, current, controller, resume));
  }

  private modelFor(spec: string | null): ModelAdapter {
    try {
      return typeof this.model === "function" ? this.model(spec) : this.model;
    } catch (err) {
      throw new RunError("no_model", (err as Error).message);
    }
  }

  private storedEvents(runId: string): RunEvent[] {
    return this.db.select().from(events).where(eq(events.runId, runId)).orderBy(asc(events.seq)).all();
  }

  get(runId: string): Run {
    const run = this.db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!run) throw new RunError("not_found", "No such run.");
    return run;
  }

  /**
   * Stored events after `after`, plus an unsubscribe. Reading and subscribing happen in one
   * synchronous step so no event can fall between the replay and the live feed.
   */
  subscribe(
    runId: string,
    after: number,
    onEvent: Listener,
  ): { backlog: RunEvent[]; done: boolean; unsubscribe: () => void } {
    const run = this.get(runId);
    const all = this.db.select().from(events).where(eq(events.runId, runId)).orderBy(asc(events.seq)).all();
    const backlog = all.filter((e) => e.seq > after);
    if (run.status !== "running" && run.status !== "waiting") return { backlog, done: true, unsubscribe: () => {} };
    const set = this.listeners.get(runId) ?? new Set();
    set.add(onEvent);
    this.listeners.set(runId, set);
    return { backlog, done: false, unsubscribe: () => set.delete(onEvent) };
  }

  /** A channel's finished runs oldest first, each as the messages the model saw: replies, tool calls and sized results. */
  private history(channelId: string, exceptRunId?: string): PastRun[] {
    const channelRuns = this.db
      .select()
      .from(runs)
      .where(eq(runs.channelId, channelId))
      .orderBy(asc(runs.startedAt))
      .all()
      .filter((r) => r.id !== exceptRunId);
    if (!channelRuns.length) return [];
    const rows = this.db
      .select()
      .from(events)
      .where(
        inArray(
          events.runId,
          channelRuns.map((r) => r.id),
        ),
      )
      .orderBy(asc(events.seq))
      .all();
    const byRun = new Map<string, RunEvent[]>();
    for (const e of rows) byRun.set(e.runId, [...(byRun.get(e.runId) ?? []), e]);
    return channelRuns.map((run) => ({
      id: run.id,
      messages: closeCalls(messagesFromEvents(byRun.get(run.id) ?? [])),
    }));
  }

  private async loop(
    runId: string,
    channelId: string,
    model: ModelAdapter,
    past: PastRun[],
    messages: Message[],
    controller: AbortController,
    resume?: Resume,
  ): Promise<void> {
    const { maxSteps, maxTokens, maxMillis } = this.limits;
    const state: LiveRun = { decisions: new Map(resume?.decisions), waiters: new Map() };
    this.live.set(runId, state);
    const requested = new Set(resume?.requested);

    // The time limit counts the model's and the tools' time, not the user's: it stops while the run waits.
    let spent = resume?.spentMillis ?? 0;
    let since = Date.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      since = Date.now();
      timer = setTimeout(() => controller.abort(new TimeLimit()), Math.max(0, maxMillis - spent));
    };
    const pause = () => {
      clearTimeout(timer);
      spent += Date.now() - since;
    };
    arm();

    let tokens = resume?.tokens ?? 0;
    let carried = resume?.calls;
    const scope = { kind: "channel", id: channelId } as const;
    try {
      for (let step = resume?.step ?? 1; ; step++) {
        let calls: ToolCall[];
        if (carried) {
          calls = carried;
          carried = undefined;
        } else {
          let text = "";
          calls = [];
          let stop: string | undefined;
          const tools = this.tools.size ? this.tools.definitions() : undefined;
          let assembled: ReturnType<typeof assembleContext>;
          try {
            assembled = assembleContext({
              past,
              current: messages,
              window: this.limits.contextWindow,
              toolTokens: tools ? estimateTokens(JSON.stringify(tools)) : 0,
              scopeStatement: scopeStatementFor(this.db, channelId),
              model: getChannel(this.db, channelId).model ?? "default",
              toolSet: fingerprint(tools ?? []),
              previous: previousRequest(this.db, channelId),
            });
          } catch (error) {
            // Nothing is sent, but keep the report at the step it happened so the debug view shows why.
            if (error instanceof ContextOverflow)
              recordContext(this.db, { runId, channelId, step, messages: null, report: error.report });
            throw error;
          }
          recordContext(this.db, {
            runId,
            channelId,
            step,
            messages: assembled.messages,
            tools,
            report: assembled.report,
          });
          const request = { messages: assembled.messages, tools, signal: controller.signal };
          for await (const ev of model.stream(request)) {
            if (ev.type === "text") text += ev.text;
            else if (ev.type === "tool_call") calls.push(ev.call);
            else {
              stop = ev.stop;
              tokens += ev.usage.inputTokens + ev.usage.outputTokens;
            }
          }
          if (text) this.append(runId, "text", { text });
          messages.push({ role: "assistant", content: text, toolCalls: calls.length ? calls : undefined });

          if (stop !== "tool_use" || !calls.length) {
            // A reply cut off by the model's own length cap is still an answer, but the user should know.
            if (stop === "length") return this.finish(runId, "stopped", "the model hit its output length limit");
            return this.finish(runId, "done", null);
          }
          for (const call of calls) {
            this.append(runId, "tool_call", { id: call.id, name: call.name, arguments: call.arguments });
          }
        }

        // Every external call is put to the user before any of them runs, so the cards appear together.
        const checked = calls.map((call) => {
          const tool = this.tools.get(call.name);
          if (!tool) return { call, problem: `Error: no tool named ${call.name} is available.` };
          const invalid = validateArguments(tool, call.arguments);
          if (invalid) return { call, tool, problem: `Error: invalid arguments: ${invalid}.` };
          return { call, tool, ask: needsApproval(tool, call, scope) };
        });
        for (const { call, tool, ask } of checked) {
          if (!tool || !ask || requested.has(call.id)) continue;
          requested.add(call.id);
          this.append(runId, "approval_request", {
            callId: call.id,
            tool: call.name,
            arguments: call.arguments,
            reason: tool.describeCall?.(call.arguments) ?? `Run ${call.name}`,
            // What a restart needs to carry on from here.
            step,
            tokens,
            spentMillis: spent + (Date.now() - since),
          });
        }

        for (const { call, tool, problem, ask } of checked) {
          let result = problem ?? "";
          let isError = problem !== undefined;
          if (tool && !problem) {
            let decision: Decision = "approve";
            if (ask) {
              if (!state.decisions.has(call.id)) {
                pause();
                this.setStatus(runId, "waiting");
                await this.awaitDecision(call.id, state, controller);
                this.setStatus(runId, "running");
                arm();
              }
              decision = state.decisions.get(call.id) ?? "decline";
            }
            if (decision === "decline") {
              result = "The user declined this action.";
              isError = true;
            } else {
              try {
                result = await tool.execute(call.arguments, {
                  runId,
                  scope,
                  signal: controller.signal,
                  log: (message) => console.log(`[${call.name}] ${message}`),
                  emit: (type, data) => this.append(runId, type, data),
                });
              } catch (error) {
                // A cancel or a limit during the tool is the run's to handle, not a tool failure.
                if (controller.signal.aborted) throw controller.signal.reason;
                result = `Error: ${(error as Error).message.slice(0, 300)}`;
                isError = true;
              }
            }
          }
          const sized = sizeResult(result, tool?.maxResultTokens);
          // The event keeps what the tool really returned for the UI; the model gets the sized copy.
          this.append(runId, "tool_result", {
            id: call.id,
            name: call.name,
            result,
            isError,
            truncated: sized.truncated,
            ...(sized.truncated ? { modelResult: sized.text } : {}),
          });
          messages.push({ role: "tool", toolCallId: call.id, content: sized.text });
        }
        if (tokens >= maxTokens) return this.stopForLimit(runId, `token limit (${maxTokens}) reached`);
        if (step >= maxSteps) return this.stopForLimit(runId, `step limit (${maxSteps}) reached`);
      }
    } catch (error) {
      const cause = controller.signal.reason;
      if (cause instanceof CancelledByUser) return this.finish(runId, "cancelled", "cancelled by you");
      if (cause instanceof TimeLimit) return this.stopForLimit(runId, `time limit (${maxMillis / 1000}s) reached`);
      if (cause instanceof ApprovalTimeout) return this.stopForLimit(runId, "approval not given");
      if (error instanceof ContextOverflow) return this.stopForLimit(runId, error.message);
      const message = error instanceof ModelError ? error.message : "Something went wrong inside the server.";
      this.append(runId, "error", { message, ...(error instanceof ModelError ? { kind: error.kind } : {}) });
      this.finish(runId, "failed", message);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Resolves when the user answers the call; rejects with the abort reason on cancel or when the wait runs out. */
  private awaitDecision(callId: string, state: LiveRun, controller: AbortController): Promise<void> {
    const signal = controller.signal;
    const giveUp = setTimeout(() => controller.abort(new ApprovalTimeout()), this.limits.approvalMillis);
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(signal.reason);
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      state.waiters.set(callId, () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      });
    }).finally(() => {
      clearTimeout(giveUp);
      state.waiters.delete(callId);
    });
  }

  private setStatus(runId: string, status: Run["status"]) {
    this.db.update(runs).set({ status }).where(eq(runs.id, runId)).run();
  }

  private stopForLimit(runId: string, reason: string) {
    this.append(runId, "error", { message: `Stopped: ${reason}.`, kind: "limit" });
    this.finish(runId, "stopped", reason);
  }

  private append(runId: string, type: string, payload: object, now = new Date()): RunEvent {
    const last = this.db
      .select({ seq: events.seq })
      .from(events)
      .where(eq(events.runId, runId))
      .orderBy(asc(events.seq))
      .all()
      .at(-1);
    const row: RunEvent = {
      id: randomUUID(),
      runId,
      seq: (last?.seq ?? 0) + 1,
      type,
      data: JSON.stringify(payload),
      createdAt: now.toISOString(),
    };
    this.db.insert(events).values(row).run();
    for (const listener of this.listeners.get(runId) ?? []) listener(row);
    return row;
  }

  private finish(runId: string, status: Run["status"], stopReason: string | null, now = new Date()) {
    this.db.update(runs).set({ status, stopReason, endedAt: now.toISOString() }).where(eq(runs.id, runId)).run();
    this.active.delete(runId);
    this.live.delete(runId);
    for (const listener of this.listeners.get(runId) ?? []) listener(null);
    this.listeners.delete(runId);
    // After everything the user waits on; a failing hook must never touch the run.
    const run = this.db.select().from(runs).where(eq(runs.id, runId)).get();
    if (run && status === "done") {
      try {
        this.onRunDone?.(run.channelId);
      } catch {
        // The hook is housekeeping; the run is already finished.
      }
    }
  }
}

class CancelledByUser extends Error {}
class TimeLimit extends Error {}
class ApprovalTimeout extends Error {}
