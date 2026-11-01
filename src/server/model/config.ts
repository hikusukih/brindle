import { readFileSync } from "node:fs";
import type { ModelAdapter } from "./adapter.js";
import { AnthropicAdapter } from "./anthropic.js";
import { OpenAiAdapter } from "./openai.js";
import { type ScriptedFixture, ScriptedModel } from "./scripted.js";

/** Thrown for a spec that can't be turned into an adapter; the message is written for the user. */
export class ModelConfigError extends Error {}

/** What the Settings screen may show about a model: never a key and never an endpoint. */
export type ModelInfo = { spec: string; provider: "openai" | "anthropic" | "scripted"; keyPresent: boolean };

export type ModelRegistry = {
  /** The spec channels without a model of their own use: the user's choice in Settings, else BRINDLE_MODEL. */
  defaultSpec: string | undefined;
  /** Replaces the default for this process; the spec must be one of `list()`. Null goes back to BRINDLE_MODEL. */
  setDefault(spec: string | null): void;
  /** The configured models: BRINDLE_MODEL and each spec in BRINDLE_MODELS (comma separated). */
  list(): ModelInfo[];
  /** The adapter for a spec, or for the default when null. One instance per spec, so a scripted model keeps its place. */
  resolve(spec: string | null): ModelAdapter;
  /** Throws ModelConfigError unless the spec could be resolved now, key included. */
  validate(spec: string): void;
};

const openAiDefaultBase = "https://api.openai.com/v1";

/**
 * Reads model configuration from the environment. A spec is `scripted`, `openai:<model>` or
 * `anthropic:<model>`. Keys come only from OPENAI_API_KEY and ANTHROPIC_API_KEY. OpenAI-compatible local
 * servers are reached by pointing BRINDLE_OPENAI_BASE_URL at them, in which case no key is required.
 * Misconfiguration throws: failing at startup beats failing on the first message.
 */
export function modelRegistry(
  env: Record<string, string | undefined>,
  readFixture: (path: string) => string = (path) => readFileSync(path, "utf8"),
): ModelRegistry {
  const cache = new Map<string, ModelAdapter>();
  const value = (name: string) => env[name]?.trim() || undefined;

  const build = (spec: string): ModelAdapter => {
    if (spec === "scripted") {
      const path = value("BRINDLE_SCRIPTED_FIXTURE");
      if (!path)
        throw new ModelConfigError(
          "The scripted model needs BRINDLE_SCRIPTED_FIXTURE, the path to a fixture JSON file.",
        );
      const fixture = JSON.parse(readFixture(path)) as ScriptedFixture;
      if (!Array.isArray(fixture?.turns)) {
        throw new ModelConfigError(`${path} is not a scripted fixture: expected a "turns" array.`);
      }
      return new ScriptedModel(fixture);
    }
    const colon = spec.indexOf(":");
    const provider = colon < 0 ? "" : spec.slice(0, colon);
    const model = colon < 0 ? "" : spec.slice(colon + 1).trim();
    if (!model || (provider !== "openai" && provider !== "anthropic")) {
      throw new ModelConfigError(
        `"${spec}" is not a supported model; write openai:<model>, anthropic:<model> or scripted.`,
      );
    }
    if (provider === "anthropic") {
      const apiKey = value("ANTHROPIC_API_KEY");
      if (!apiKey) throw new ModelConfigError("Set ANTHROPIC_API_KEY to use an Anthropic model.");
      return new AnthropicAdapter({ model, apiKey, baseUrl: value("BRINDLE_ANTHROPIC_BASE_URL") });
    }
    const baseUrl = value("BRINDLE_OPENAI_BASE_URL");
    const apiKey = value("OPENAI_API_KEY");
    if (!apiKey && !baseUrl)
      throw new ModelConfigError(
        "Set OPENAI_API_KEY (or BRINDLE_OPENAI_BASE_URL for a local server) to use an OpenAI-compatible model.",
      );
    return new OpenAiAdapter({ model, apiKey, baseUrl: baseUrl ?? openAiDefaultBase });
  };

  const forSpec = (spec: string): ModelAdapter => {
    let adapter = cache.get(spec);
    if (!adapter) {
      adapter = build(spec);
      cache.set(spec, adapter);
    }
    return adapter;
  };

  const envDefault = value("BRINDLE_MODEL");
  if (envDefault) forSpec(envDefault);
  const configured = [
    ...new Set([envDefault, ...(value("BRINDLE_MODELS")?.split(",") ?? []).map((s) => s.trim())].filter(Boolean)),
  ] as string[];
  let chosenDefault: string | undefined;
  const info = (spec: string): ModelInfo => {
    const provider = spec === "scripted" ? "scripted" : spec.startsWith("anthropic:") ? "anthropic" : "openai";
    const keyPresent =
      provider === "scripted"
        ? Boolean(value("BRINDLE_SCRIPTED_FIXTURE"))
        : provider === "anthropic"
          ? Boolean(value("ANTHROPIC_API_KEY"))
          : Boolean(value("OPENAI_API_KEY") || value("BRINDLE_OPENAI_BASE_URL"));
    return { spec, provider, keyPresent };
  };
  return {
    get defaultSpec() {
      return chosenDefault ?? envDefault;
    },
    setDefault(spec) {
      if (spec === null) {
        chosenDefault = undefined;
        return;
      }
      if (!configured.includes(spec)) throw new ModelConfigError(`"${spec}" is not one of the configured models.`);
      forSpec(spec);
      chosenDefault = spec;
    },
    list: () => configured.map(info),
    resolve(spec) {
      const chosen = spec ?? chosenDefault ?? envDefault;
      if (!chosen)
        throw new ModelConfigError("No model is configured. Set BRINDLE_MODEL or choose one for this channel.");
      return forSpec(chosen);
    },
    validate(spec) {
      forSpec(spec);
    },
  };
}
