import { describe, expect, it } from "vitest";
import {
  applyServerWindows,
  defaultModelSettings,
  describeModelSettings,
  loadModelSettings,
  ModelSettingsError,
  ModelSettingsStore,
  serverContextWindow,
  updateModelSettings,
} from "./settings.js";

const file = (json: unknown) => () => JSON.stringify(json);
const server = (n_ctx: unknown, status = 200) =>
  (async (url: string) => {
    expect(url).toBe("http://127.0.0.1:8080/props");
    return Response.json({ default_generation_settings: { n_ctx } }, { status });
  }) as unknown as typeof fetch;

describe("model settings file", () => {
  it("is empty when the file is missing", () => {
    expect(loadModelSettings("/nowhere/model-settings.json", () => undefined)).toEqual({});
  });

  it("gives a model with no entry the defaults for a CPU-only host, and names the model", () => {
    const store = new ModelSettingsStore({}, () => "openai:local");
    expect(store.forSpec(null)).toEqual({ ...defaultModelSettings, model: "openai:local" });
    expect(store.forSpec("anthropic:x").model).toBe("anthropic:x");
    expect(new ModelSettingsStore().forSpec(null).model).toBe("default");
    expect(defaultModelSettings).toMatchObject({ contextWindow: 32_000, maxSteps: 10, maxMillis: 300_000 });
  });

  it("overrides only what the entry sets, keyed by spec", () => {
    const settings = loadModelSettings("s.json", file({ "anthropic:x": { contextWindow: 200_000, warmCache: false } }));
    const store = new ModelSettingsStore(settings, () => "openai:local");
    expect(store.forSpec("anthropic:x")).toMatchObject({ contextWindow: 200_000, warmCache: false, maxSteps: 10 });
    expect(store.forSpec(null).contextWindow).toBe(32_000);
  });

  it("refuses a file it can't trust rather than falling back silently", () => {
    expect(() => loadModelSettings("s.json", () => "{")).toThrow(ModelSettingsError);
    expect(() => loadModelSettings("s.json", file([]))).toThrow(/keyed by model spec/);
    expect(() => loadModelSettings("s.json", file({ a: { contextWindow: -1 } }))).toThrow(/positive whole number/);
    expect(() => loadModelSettings("s.json", file({ a: { contextwindow: 5 } }))).toThrow(/unknown setting/);
    expect(() => loadModelSettings("s.json", file({ a: { warmCache: "yes" } }))).toThrow(/true or false/);
  });
});

describe("the server's own window", () => {
  it("is read from /props, whether or not the base URL ends in /v1", async () => {
    expect(await serverContextWindow("http://127.0.0.1:8080/v1", server(8192))).toBe(8192);
    expect(await serverContextWindow("http://127.0.0.1:8080", server(8192))).toBe(8192);
  });

  it("is unknown when the server has no /props or answers nonsense", async () => {
    expect(await serverContextWindow("http://127.0.0.1:8080", server(8192, 404))).toBeUndefined();
    expect(await serverContextWindow("http://127.0.0.1:8080", server("big"))).toBeUndefined();
    const down = (async () => {
      throw new Error("refused");
    }) as unknown as typeof fetch;
    expect(await serverContextWindow("http://127.0.0.1:8080", down)).toBeUndefined();
  });

  it("is used when no window is configured", async () => {
    const store = new ModelSettingsStore({}, () => "openai:local");
    await applyServerWindows(store, ["openai:local"], "http://127.0.0.1:8080/v1", server(8192));
    expect(store.forSpec(null).contextWindow).toBe(8192);
  });

  it("loses to a configured window that fits, and a configured one that is larger is a configuration error", async () => {
    const fits = new ModelSettingsStore({ "openai:local": { contextWindow: 4096 } }, () => "openai:local");
    await applyServerWindows(fits, ["openai:local"], "http://127.0.0.1:8080/v1", server(8192));
    expect(fits.forSpec(null).contextWindow).toBe(4096);

    const toBig = new ModelSettingsStore({ "openai:local": { contextWindow: 65_536 } }, () => "openai:local");
    await expect(applyServerWindows(toBig, ["openai:local"], "http://127.0.0.1:8080/v1", server(8192))).rejects.toThrow(
      /larger than the server's \(8192\)/,
    );
  });

  it("is not asked for hosted models or without a local base URL", async () => {
    const never = (async () => {
      throw new Error("should not be called");
    }) as unknown as typeof fetch;
    const store = new ModelSettingsStore({}, () => "anthropic:x");
    await applyServerWindows(store, ["anthropic:x"], "http://127.0.0.1:8080/v1", never);
    await applyServerWindows(store, ["openai:local"], undefined, never);
    expect(store.forSpec(null).contextWindow).toBe(32_000);
  });
});

describe("editing model settings", () => {
  const base = "http://127.0.0.1:8080/v1";

  it("describes each model with the server's window and a problem when the configured one is larger", async () => {
    const store = new ModelSettingsStore(
      { "openai:local": { contextWindow: 9000, maxSteps: 4 } },
      () => "openai:local",
    );
    const [view] = await describeModelSettings(store, ["openai:local"], { baseUrl: base, fetch: server(8192) });
    expect(view).toMatchObject({
      spec: "openai:local",
      configured: { contextWindow: 9000, maxSteps: 4 },
      serverWindow: 8192,
      effective: { maxSteps: 4, contextWindow: 9000 },
    });
    expect(view?.problem).toMatch(/larger than the server's \(8192\)/);
    const [hosted] = await describeModelSettings(store, ["anthropic:x"], { baseUrl: base });
    expect(hosted).toMatchObject({ serverWindow: null, problem: null, configured: {} });
  });

  it("saves a change, clears a key with null, and writes the whole file", async () => {
    const store = new ModelSettingsStore({ "openai:local": { maxSteps: 4, warmCache: false } }, () => "openai:local");
    const writes: [string, string][] = [];
    const write = (path: string, text: string) => void writes.push([path, text]);
    await updateModelSettings(
      store,
      "/data/model-settings.json",
      "openai:local",
      { contextWindow: 4096, maxSteps: null },
      { baseUrl: base, fetch: server(8192), write },
    );
    expect(store.entry("openai:local")).toEqual({ warmCache: false, contextWindow: 4096 });
    expect(JSON.parse(writes[0]?.[1] ?? "")).toEqual({ "openai:local": { warmCache: false, contextWindow: 4096 } });
    expect(writes[0]?.[0]).toBe("/data/model-settings.json");
    // Clearing everything removes the model's entry.
    await updateModelSettings(
      store,
      "/data/model-settings.json",
      "openai:local",
      { contextWindow: null, warmCache: null },
      { write },
    );
    expect(JSON.parse(writes[1]?.[1] ?? "")).toEqual({});
  });

  it("refuses a window larger than the server's, an unknown key and a bad value, saving nothing", async () => {
    const store = new ModelSettingsStore({}, () => "openai:local");
    const write = () => {
      throw new Error("should not write");
    };
    const opts = { baseUrl: base, fetch: server(8192), write };
    await expect(updateModelSettings(store, "/x", "openai:local", { contextWindow: 9000 }, opts)).rejects.toThrow(
      /larger than the server's \(8192\)/,
    );
    await expect(updateModelSettings(store, "/x", "openai:local", { colour: 1 }, opts)).rejects.toBeInstanceOf(
      ModelSettingsError,
    );
    await expect(updateModelSettings(store, "/x", "openai:local", { maxSteps: -1 }, opts)).rejects.toThrow(
      /positive whole number/,
    );
    await expect(updateModelSettings(store, "/x", "openai:local", { colour: null }, opts)).rejects.toBeInstanceOf(
      ModelSettingsError,
    );
    expect(store.entry("openai:local")).toEqual({});
  });

  it("puts the old entry back when the file can't be written", async () => {
    const store = new ModelSettingsStore({ "openai:local": { maxSteps: 4 } }, () => "openai:local");
    const write = () => {
      throw new Error("disk full");
    };
    await expect(updateModelSettings(store, "/x", "openai:local", { maxSteps: 6 }, { write })).rejects.toThrow(
      "disk full",
    );
    expect(store.entry("openai:local")).toEqual({ maxSteps: 4 });
  });
});
