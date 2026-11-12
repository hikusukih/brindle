import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { openDatabase } from "./db/index.js";
import { modelRegistry } from "./model/config.js";
import { describeModelSettings, ModelSettingsStore, updateModelSettings } from "./model/settings.js";

function setup() {
  const db = openDatabase(":memory:");
  const models = modelRegistry({ BRINDLE_MODEL: "scripted", BRINDLE_SCRIPTED_FIXTURE: "f" }, () => '{"turns":[]}');
  const store = new ModelSettingsStore({ scripted: { maxSteps: 3 } }, () => models.defaultSpec);
  const writes: string[] = [];
  const app = createApp({
    db,
    models,
    modelSettings: {
      list: () =>
        describeModelSettings(
          store,
          models.list().map((m) => m.spec),
        ),
      update: (spec, patch) =>
        updateModelSettings(store, "/data/model-settings.json", spec, patch, { write: (_p, t) => void writes.push(t) }),
    },
  });
  return { app, writes };
}

const put = (app: ReturnType<typeof createApp>, body: unknown) =>
  app.request("/api/settings/model-settings", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("model settings API", () => {
  it("lists each configured model's numbers", async () => {
    const { app } = setup();
    const res = await app.request("/api/settings/model-settings");
    expect(await res.json()).toMatchObject([{ spec: "scripted", configured: { maxSteps: 3 }, serverWindow: null }]);
  });

  it("saves a change and returns the model's new view", async () => {
    const { app, writes } = setup();
    const res = await put(app, { model: "scripted", settings: { maxTokens: 5000, maxSteps: null } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      configured: { maxTokens: 5000 },
      effective: { maxTokens: 5000, maxSteps: 10 },
    });
    expect(JSON.parse(writes[0] ?? "")).toEqual({ scripted: { maxTokens: 5000 } });
  });

  it("answers 400 with a message for a bad value, an unknown model or a malformed body", async () => {
    const { app } = setup();
    const bad = await put(app, { model: "scripted", settings: { maxSteps: 0 } });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toMatch(/positive whole number/);
    expect((await put(app, { model: "openai:other", settings: {} })).status).toBe(400);
    expect((await put(app, { model: "scripted", settings: [] })).status).toBe(400);
  });
});
