import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createChannel, getChannel } from "./channels.js";
import { openDatabase } from "./db/index.js";
import { ModelConfigError, modelRegistry } from "./model/config.js";
import { RunEngine } from "./runs.js";
import { getSetting } from "./settings.js";

const fixture = (word: string) => JSON.stringify({ turns: [{ text: [word] }] });

function setup(env: Record<string, string>) {
  const db = openDatabase(":memory:");
  // Each fake path stands for a different scripted fixture, so which model ran shows in the reply.
  const models = modelRegistry(env, (path) => fixture(path));
  const engine = new RunEngine(db, (spec) => models.resolve(spec));
  const app = createApp({ db, engine, models });
  return { db, engine, app, channel: createChannel(db, "Test") };
}

const post = (app: ReturnType<typeof createApp>, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("per-channel model", () => {
  it("reports the default and stores a channel's own choice", async () => {
    const { app, channel } = setup({ BRINDLE_MODEL: "scripted", BRINDLE_SCRIPTED_FIXTURE: "Default." });
    expect(await (await app.request("/api/models")).json()).toEqual({
      default: "scripted",
      models: [{ spec: "scripted", provider: "scripted", keyPresent: true }],
    });

    const res = await post(app, `/api/channels/${channel.id}/model`, { model: "scripted" });
    expect(((await res.json()) as { model: string }).model).toBe("scripted");
    const cleared = await post(app, `/api/channels/${channel.id}/model`, { model: null });
    expect(((await cleared.json()) as { model: null }).model).toBeNull();
  });

  it("refuses a model that can't be built, such as one whose key is missing", async () => {
    const { app, channel, db } = setup({});
    const res = await post(app, `/api/channels/${channel.id}/model`, { model: "anthropic:claude-test" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/ANTHROPIC_API_KEY/);
    expect(getChannel(db, channel.id).model).toBeNull();
  });

  it("runs a channel on its own model and others on the default", async () => {
    const { app, engine, db, channel } = setup({
      BRINDLE_MODEL: "scripted",
      BRINDLE_SCRIPTED_FIXTURE: "Default.",
      OPENAI_API_KEY: "sk-test-1234abcd1234abcd",
      // Nothing listens here, so the run on the OpenAI model fails fast without touching the network.
      BRINDLE_OPENAI_BASE_URL: "http://127.0.0.1:1/v1",
    });
    const other = createChannel(db, "Other");
    await post(app, `/api/channels/${other.id}/model`, { model: "openai:gpt-test" });
    // The OpenAI model is unreachable by design, so its run fails; the default channel is unaffected.
    const own = engine.start(other.id, "hi");
    const def = engine.start(channel.id, "hi");
    await Promise.all([engine.whenSettled(own.id), engine.whenSettled(def.id)]);
    expect(engine.get(def.id).status).toBe("done");
    expect(engine.get(own.id).status).not.toBe("done");
  });

  it("answers 503 when no model is configured anywhere", async () => {
    const { app, channel } = setup({});
    const res = await post(app, `/api/channels/${channel.id}/runs`, { text: "hi" });
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
    const { app } = setup({ ...env, BRINDLE_OPENAI_BASE_URL: "http://192.0.2.10:8080/v1" });
    const text = await (await app.request("/api/models")).text();
    expect(JSON.parse(text).models).toEqual([
      { spec: "scripted", provider: "scripted", keyPresent: true },
      { spec: "anthropic:claude-test", provider: "anthropic", keyPresent: false },
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
