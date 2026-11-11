import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp, recordFirstStart } from "./app.js";
import { ArtifactStore } from "./artifacts.js";
import { resolveToken } from "./auth.js";
import { getChannel } from "./channels.js";
import { modelSummarizer } from "./compaction.js";
import { openDatabase } from "./db/index.js";
import { GoalDrafter } from "./goal-draft.js";
import { applyLegacyEnv, migrateLegacyDatabase } from "./legacy.js";
import { connectMcpServers, loadMcpConfig } from "./mcp/index.js";
import { modelRegistry } from "./model/config.js";
import { applyServerWindows, loadModelSettings, ModelSettingsStore } from "./model/settings.js";
import { PurposeDrafter } from "./purpose.js";
import { defaultLimits, RunEngine, type RunLimits } from "./runs.js";
import { getSetting } from "./settings.js";
import { getTimeZone } from "./time-zone.js";
import { builtInTools } from "./tools/index.js";

applyLegacyEnv(process.env);

const dataDir = resolve(process.env.BRINDLE_DATA_DIR ?? "data");
// Single user with one login token; still stay on loopback unless the operator says otherwise.
const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);

mkdirSync(dataDir, { recursive: true });
migrateLegacyDatabase(dataDir);
const db = openDatabase(join(dataDir, "brindle.sqlite"));
recordFirstStart(db);
const token = resolveToken(db, process.env);
if (token.generated) {
  console.log(`Login token (shown once; set BRINDLE_TOKEN to choose your own): ${token.generated}`);
}

// Resolves to the package root from both src/server and dist/server.
const builtClient = fileURLToPath(new URL("../../dist/client", import.meta.url));
// With no default model and none chosen for a channel, starting a run answers 503.
const models = modelRegistry(process.env);
// The default the user chose in Settings, unless that model is no longer configured.
const chosenDefault = getSetting(db, "default_model");
if (chosenDefault) {
  try {
    models.setDefault(chosenDefault);
  } catch {
    console.warn(
      `The default model chosen in Settings (${chosenDefault}) is no longer configured; using BRINDLE_MODEL.`,
    );
  }
}
// Per-model window and limits; a local server's own window is asked for once, now, so a mismatch fails at startup.
const settings = new ModelSettingsStore(
  loadModelSettings(join(dataDir, "model-settings.json")),
  () => models.defaultSpec,
  (spec) => models.list().some((m) => m.spec === spec),
);
await applyServerWindows(
  settings,
  [...settings.specs(), ...(models.defaultSpec ? [models.defaultSpec] : [])],
  process.env.BRINDLE_OPENAI_BASE_URL?.trim() || undefined,
);
const limitsFor = (spec: string | null): RunLimits => {
  const s = settings.forSpec(spec);
  return { ...defaultLimits, ...s };
};
const artifacts = new ArtifactStore(db, join(dataDir, "artifacts"));
const tools = builtInTools(process.env, artifacts, db);
// Plug-in tools from <data>/mcp.json, each with an effect level the user assigned.
const mcpClients = await connectMcpServers(loadMcpConfig(join(dataDir, "mcp.json")), tools);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    for (const c of mcpClients) c.close();
    process.exit(0);
  });
}
// Housekeeping (rolling compaction) uses BRINDLE_UTILITY_MODEL, defaulting to the channel's own model.
const utilitySpec = process.env.BRINDLE_UTILITY_MODEL?.trim() || null;
const engine = new RunEngine(
  db,
  // A channel whose model is no longer configured falls back to the default; the channel header says so.
  (spec) => models.resolveForChannel(spec),
  limitsFor,
  tools,
  { utilityModel: (spec) => (utilitySpec ? models.resolve(utilitySpec) : models.resolveForChannel(spec)) },
);
// Drafting purpose statements uses the same utility model, else the channel's own.
if (utilitySpec) models.validate(utilitySpec);
const purpose = new PurposeDrafter(db, (channelId) => {
  const spec = utilitySpec ?? getChannel(db, channelId).model;
  return {
    model: models.resolveForChannel(spec),
    // 10 minutes, the default of docs/design/context.md; P2.11's per-model setting replaces it.
    millis: 10 * 60_000,
  };
});
// No channel yet, so the utility model, else the default.
const goalDrafter = new GoalDrafter(() => ({
  model: models.resolveForChannel(utilitySpec ?? null),
  millis: 10 * 60_000,
}));
engine.onRunDone = (channelId) => void purpose.afterRun(channelId);
engine.timeZone = () => getTimeZone(db);
const recovered = engine.recoverInterrupted();
if (recovered > 0) console.log(`Marked ${recovered} interrupted run(s) as failed.`);
const app = createApp({
  db,
  engine,
  // Object.assign, not a spread: a spread would copy defaultSpec's getter value once and freeze the default the API reports.
  models: Object.assign(models, { settings: (spec: string | null) => settings.forSpec(spec) }),
  artifacts,
  purpose,
  // The default model stands in for the source channel's own here, since a seed call isn't tied to one run.
  branching: (input) =>
    modelSummarizer(utilitySpec ? models.resolve(utilitySpec) : models.resolveForChannel(null))({
      ...input,
      signal: AbortSignal.timeout(10 * 60_000),
    }),
  goalDrafter,
  clientRoot: existsSync(builtClient) ? builtClient : undefined,
  authHash: token.hash,
});

serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`Brindle listening on http://${info.address}:${info.port}`);
});
