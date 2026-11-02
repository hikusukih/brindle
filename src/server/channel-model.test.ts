import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createChannel, getChannel } from "./channels.js";
import { openDatabase } from "./db/index.js";
import { ModelConfigError, modelRegistry } from "./model/config.js";
import { RunEngine } from "./runs.js";

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
    expect(await (await app.request("/api/models")).json()).toEqual({ default: "scripted" });

    const res = await post(app, `/api/channels/${channel.id}/model`, { model: "scripted" });
    expect(((await res.json()) as { model: string }).model).toBe("scripted");
    const cleared = await post(app, `/api/channels/${channel.id}/model`, { model: null });
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
    const app = createApp({ db, models: { defaultSpec: "scripted", validate: () => {}, settings } });
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
