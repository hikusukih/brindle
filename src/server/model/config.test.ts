import { describe, expect, it } from "vitest";
import { AnthropicAdapter } from "./anthropic.js";
import { ModelConfigError, modelRegistry } from "./config.js";
import { OpenAiAdapter } from "./openai.js";
import { ScriptedModel } from "./scripted.js";

const fixture = JSON.stringify({ turns: [{ text: ["hi"] }] });

describe("modelRegistry", () => {
  it("has no default when none is configured, and refuses to resolve one", () => {
    expect(modelRegistry({}).defaultSpec).toBeUndefined();
    expect(modelRegistry({ BRINDLE_MODEL: " " }).defaultSpec).toBeUndefined();
    expect(() => modelRegistry({}).resolve(null)).toThrow(/No model is configured/);
  });

  it("loads the scripted model from the fixture path, once per registry", () => {
    const registry = modelRegistry({ BRINDLE_MODEL: "scripted", BRINDLE_SCRIPTED_FIXTURE: "turns.json" }, (path) => {
      expect(path).toBe("turns.json");
      return fixture;
    });
    expect(registry.resolve(null)).toBeInstanceOf(ScriptedModel);
    expect(registry.resolve("scripted")).toBe(registry.resolve(null));
  });

  it("builds provider adapters from specs, with keys only from the environment", () => {
    const registry = modelRegistry({
      OPENAI_API_KEY: "sk-test-1234abcd1234abcd",
      ANTHROPIC_API_KEY: "sk-test-1234abcd1234abcd",
    });
    expect(registry.resolve("openai:gpt-test")).toBeInstanceOf(OpenAiAdapter);
    expect(registry.resolve("anthropic:claude-test")).toBeInstanceOf(AnthropicAdapter);
  });

  it("lets a local OpenAI-compatible server go without a key", () => {
    expect(
      modelRegistry({ BRINDLE_OPENAI_BASE_URL: "http://127.0.0.1:11434/v1" }).resolve("openai:llama"),
    ).toBeInstanceOf(OpenAiAdapter);
  });

  it("fails loudly on a missing key or path, a bad fixture or an unknown model", () => {
    expect(() => modelRegistry({ BRINDLE_MODEL: "scripted" })).toThrow(/BRINDLE_SCRIPTED_FIXTURE/);
    expect(() => modelRegistry({ BRINDLE_MODEL: "scripted", BRINDLE_SCRIPTED_FIXTURE: "x" }, () => "{}")).toThrow(
      /turns/,
    );
    expect(() => modelRegistry({ BRINDLE_MODEL: "gpt" })).toThrow(ModelConfigError);
    expect(() => modelRegistry({ BRINDLE_MODELS: "anthropic:claude-test" }).validate("anthropic:claude-test")).toThrow(
      /ANTHROPIC_API_KEY/,
    );
    expect(() => modelRegistry({ BRINDLE_MODELS: "openai:gpt-test" }).validate("openai:gpt-test")).toThrow(
      /OPENAI_API_KEY/,
    );
    expect(() => modelRegistry({}).validate("openai:gpt-test")).toThrow(/not one of the configured/);
  });
});
