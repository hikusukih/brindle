import { describe, expect, it } from "vitest";
import { ModelError } from "./adapter.js";
import { type AdapterFactory, runAdapterContract } from "./contract.js";
import { ScriptedModel, type ScriptedTurn } from "./scripted.js";

const usage = { inputTokens: 12, outputTokens: 3 };

const make: AdapterFactory = (behavior) => {
  let turn: ScriptedTurn;
  switch (behavior.kind) {
    case "text":
      turn = { text: behavior.chunks, usage };
      break;
    case "cached_text":
      turn = { text: behavior.chunks, usage: { ...usage, cachedInputTokens: 8 } };
      break;
    case "tool_call":
      turn = { toolCalls: [behavior.call], usage };
      break;
    case "fail":
      turn = { fail: { kind: behavior.error, message: "scripted failure" } };
      break;
    case "fail_midstream":
      turn = {
        text: behavior.chunks,
        fail: { kind: "unavailable", message: "connection dropped" },
      };
      break;
  }
  return new ScriptedModel({ turns: [turn] });
};

runAdapterContract("ScriptedModel", make, { text: usage, cachedText: { ...usage, cachedInputTokens: 8 } });

describe("ScriptedModel", () => {
  it("replays one turn per call, in order, and records what it was sent", async () => {
    const model = new ScriptedModel({
      turns: [{ toolCalls: [{ id: "c1", name: "web_fetch", arguments: {} }] }, { text: ["Done."] }],
    });
    const first = { messages: [{ role: "user" as const, content: "go" }] };

    const a = [];
    for await (const e of model.stream(first)) a.push(e);
    const b = [];
    for await (const e of model.stream(first)) b.push(e);

    expect(a.at(-1)).toMatchObject({ stop: "tool_use" });
    expect(b[0]).toEqual({ type: "text", text: "Done." });
    expect(model.requests).toHaveLength(2);
  });

  it("fails with a non-retryable error once the script runs out", async () => {
    const model = new ScriptedModel({ turns: [] });

    const run = async () => {
      for await (const _ of model.stream({ messages: [] })) {
        // drain
      }
    };

    await expect(run()).rejects.toBeInstanceOf(ModelError);
    await expect(run()).rejects.toMatchObject({ retryable: false });
  });
});
