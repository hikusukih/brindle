import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createChannel, getChannel } from "./channels.js";
import { runContext } from "./context.js";
import { openDatabase } from "./db/index.js";
import { ModelConfigError, modelRegistry } from "./model/config.js";
import { ModelSettingsStore } from "./model/settings.js";
import { defaultLimits, RunEngine } from "./runs.js";
import { getSetting } from "./settings.js";

const fixture = (word: string) => JSON.stringify({ turns: [{ text: [word] }] });

function setup(env: Record<string, string>) {
  const db = openDatabase(":memory:");
  // Each fake path stands for a different scripted fixture, so which model ran shows in the reply.
  const models = modelRegistry(env, (path) => fixture(path));
  const engine = new RunEngine(db, (spec) => models.resolveForChannel(spec));
  const app = createApp({ db, engine, models });
  return { db, engine, app, channel: createChannel(db, "Test") };
}

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
  app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("per-channel model", () => {
  it("reports the default and stores a channel's own choice", async () => {
    const { app, channel } = setup({
      BRINDLE_MODEL: "scripted",
      BRINDLE_SCRIPTED_FIXTURE: "Default.",
    });
    expect(await (await app.request("/api/models")).json()).toEqual({
      default: "scripted",
      models: [{ spec: "scripted", provider: "scripted", keyPresent: true }],
    });

    const res = await post(app, `/api/channels/${channel.id}/model`, {
      model: "scripted",
    });
    expect(((await res.json()) as { model: string }).model).toBe("scripted");
    const cleared = await post(app, `/api/channels/${channel.id}/model`, {
      model: null,
    });
    expect(((await cleared.json()) as { model: null }).model).toBeNull();
  });

  it("tells the channel view which window and limits its model runs under", async () => {
    const db = openDatabase(":memory:");
    const settings = (spec: string | null) => ({
      model: spec ?? "scripted",
      contextWindow: spec === "scripted" || spec === null ? 8192 : 32_000,
      maxSteps: 10,
      maxTokens: 100_000,
      maxMillis: 300_000,
    });
    const app = createApp({
      db,
      models: {
        defaultSpec: "scripted",
        validate: () => {},
        list: () => [],
        setDefault: () => {},
        settings,
      },
    });
    const channel = createChannel(db, "Test");
    expect(await (await app.request(`/api/channels/${channel.id}/model-settings`)).json()).toEqual({
      model: "scripted",
      contextWindow: 8192,
      maxSteps: 10,
      maxTokens: 100_000,
      maxMillis: 300_000,
    });
    // Without settings configured the view gets null, not a guess.
    const bare = createApp({ db });
    expect(await (await bare.request(`/api/channels/${channel.id}/model-settings`)).json()).toBeNull();
    expect((await app.request("/api/channels/nope/model-settings")).status).toBe(404);
  });

  it("refuses a model that can't be built, such as one whose key is missing", async () => {
    const { app, channel, db } = setup({
      BRINDLE_MODELS: "anthropic:claude-test",
    });
    const res = await post(app, `/api/channels/${channel.id}/model`, {
      model: "anthropic:claude-test",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/ANTHROPIC_API_KEY/);
    expect(getChannel(db, channel.id).model).toBeNull();
  });

  it("refuses a model that is not one of the configured ones, even if it has a key", async () => {
    const { app, channel, db } = setup({
      OPENAI_API_KEY: "sk-test-1234abcd1234abcd",
      BRINDLE_MODELS: "scripted",
      BRINDLE_SCRIPTED_FIXTURE: "x",
    });
    const res = await post(app, `/api/channels/${channel.id}/model`, {
      model: "openai:other",
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/not one of the configured/);
    expect(getChannel(db, channel.id).model).toBeNull();
  });

  it("falls back to the default when a channel's model is no longer configured", () => {
    const models = modelRegistry(
      {
        BRINDLE_MODEL: "scripted",
        BRINDLE_SCRIPTED_FIXTURE: "Default.",
        OPENAI_API_KEY: "sk-test-1234abcd1234abcd",
      },
      (path) => fixture(path),
    );
    expect(models.resolveForChannel("openai:gone")).toBe(models.resolve(null));
    expect(models.resolveForChannel(null)).toBe(models.resolve(null));
  });

  it("runs a channel on its own model and others on the default", async () => {
    const { app, engine, db, channel } = setup({
      BRINDLE_MODEL: "scripted",
      BRINDLE_SCRIPTED_FIXTURE: "Default.",
      OPENAI_API_KEY: "sk-test-1234abcd1234abcd",
      BRINDLE_MODELS: "scripted, openai:gpt-test",
      // Nothing listens here, so the run on the OpenAI model fails fast without touching the network.
      BRINDLE_OPENAI_BASE_URL: "http://127.0.0.1:1/v1",
    });
    const other = createChannel(db, "Other");
    await post(app, `/api/channels/${other.id}/model`, {
      model: "openai:gpt-test",
    });
    // The OpenAI model is unreachable by design, so its run fails; the default channel is unaffected.
    const own = engine.start(other.id, "hi");
    const def = engine.start(channel.id, "hi");
    await Promise.all([engine.whenSettled(own.id), engine.whenSettled(def.id)]);
    expect(engine.get(def.id).status).toBe("done");
    expect(engine.get(own.id).status).not.toBe("done");
  });

  it("answers 503 when no model is configured anywhere", async () => {
    const { app, channel } = setup({});
    const res = await post(app, `/api/channels/${channel.id}/runs`, {
      text: "hi",
    });
    expect(res.status).toBe(503);
  });

  it("is a ModelConfigError that explains itself", () => {
    expect(() => modelRegistry({}).resolve(null)).toThrow(ModelConfigError);
  });
});

describe("the configured models and the default", () => {
  const env = {
    BRINDLE_MODEL: "scripted",
    BRINDLE_SCRIPTED_FIXTURE: "Default.",
    BRINDLE_MODELS: "anthropic:claude-test, openai:gpt-test, scripted",
    OPENAI_API_KEY: "sk-test-1234abcd1234abcd",
  };
  const put = (app: ReturnType<typeof createApp>, model: unknown) =>
    app.request("/api/settings/default-model", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
    });

  it("lists each model once with whether its key is present, and never a key or an endpoint", async () => {
    const { app } = setup({
      ...env,
      BRINDLE_OPENAI_BASE_URL: "http://192.0.2.10:8080/v1",
    });
    const text = await (await app.request("/api/models")).text();
    expect(JSON.parse(text).models).toEqual([
      { spec: "scripted", provider: "scripted", keyPresent: true },
      {
        spec: "anthropic:claude-test",
        provider: "anthropic",
        keyPresent: false,
      },
      { spec: "openai:gpt-test", provider: "openai", keyPresent: true },
    ]);
    expect(text).not.toContain("sk-test");
    expect(text).not.toContain("192.0.2.10");
  });

  it("changes the default to a configured model and refuses others", async () => {
    const { app, db } = setup(env);
    expect((await put(app, "openai:gpt-test")).status).toBe(200);
    expect(((await (await app.request("/api/models")).json()) as { default: string }).default).toBe("openai:gpt-test");
    expect(getSetting(db, "default_model")).toBe("openai:gpt-test");
    expect((await put(app, "openai:not-listed")).status).toBe(400);
    expect((await put(app, 7)).status).toBe(400);
  });
});

describe("limits follow the model a request really uses", () => {
  // Two scripted models with different windows; the report names the resolved spec and its window.
  function wired() {
    const db = openDatabase(":memory:");
    const models = modelRegistry(
      {
        BRINDLE_MODEL: "scripted",
        BRINDLE_SCRIPTED_FIXTURE: "x",
        BRINDLE_MODELS: "scripted, openai:other",
        OPENAI_API_KEY: "sk-test-1234abcd1234abcd",
      },
      (path) => fixture(path),
    );
    const store = new ModelSettingsStore(
      {
        scripted: { contextWindow: 8_000 },
        "openai:other": { contextWindow: 16_000 },
      },
      () => models.defaultSpec,
      (spec) => models.list().some((m) => m.spec === spec),
    );
    const engine = new RunEngine(
      db,
      (spec) => models.resolveForChannel(spec),
      (spec) => ({ ...defaultLimits, ...store.forSpec(spec) }),
    );
    const app = createApp({
      db,
      engine,
      models: { ...models, settings: (spec) => store.forSpec(spec) },
    });
    return { db, engine, app, models, channel: createChannel(db, "Test") };
  }
  const reportOf = async (w: ReturnType<typeof wired>) => {
    const run = w.engine.start(w.channel.id, "hi");
    await w.engine.whenSettled(run.id);
    const [first] = runContext(w.db, run.id);
    if (!first) throw new Error("no context report");
    return first.report;
  };

  it("uses the new default's window and names it after the default is changed in Settings", async () => {
    const w = wired();
    expect(await reportOf(w)).toMatchObject({
      model: "scripted",
      window: 8_000,
    });
    const res = await w.app.request("/api/settings/default-model", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "openai:other" }),
    });
    expect(res.status).toBe(200);
    expect(await (await w.app.request(`/api/channels/${w.channel.id}/model-settings`)).json()).toMatchObject({
      model: "openai:other",
      contextWindow: 16_000,
    });
    expect(await reportOf(w)).toMatchObject({
      model: "openai:other",
      window: 16_000,
      breaks: ["model_change"],
    });
  });

  it("uses the default's numbers for a channel whose own model is no longer configured", async () => {
    const w = wired();
    // Stored directly: the endpoint would refuse a model that is not configured.
    w.db.run(sql`update channels set model = 'openai:gone' where id = ${w.channel.id}`);
    expect(await reportOf(w)).toMatchObject({
      model: "scripted",
      window: 8_000,
    });
    expect(await (await w.app.request(`/api/channels/${w.channel.id}/model-settings`)).json()).toMatchObject({
      model: "scripted",
      contextWindow: 8_000,
    });
  });
});
