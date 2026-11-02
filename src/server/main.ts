import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import { createApp, recordFirstStart } from "./app.js";
import { ArtifactStore } from "./artifacts.js";
import { resolveToken } from "./auth.js";
import { openDatabase } from "./db/index.js";
import { applyLegacyEnv, migrateLegacyDatabase } from "./legacy.js";
import { connectMcpServers, loadMcpConfig } from "./mcp/index.js";
import { modelRegistry } from "./model/config.js";
import { RunEngine } from "./runs.js";
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
const artifacts = new ArtifactStore(db, join(dataDir, "artifacts"));
const tools = builtInTools(process.env, artifacts);
// Plug-in tools from <data>/mcp.json, each with an effect level the user assigned.
const mcpClients = await connectMcpServers(loadMcpConfig(join(dataDir, "mcp.json")), tools);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    for (const c of mcpClients) c.close();
    process.exit(0);
  });
}
const engine = new RunEngine(db, (spec) => models.resolve(spec), undefined, tools);
const recovered = engine.recoverInterrupted();
if (recovered > 0) console.log(`Marked ${recovered} interrupted run(s) as failed.`);
const app = createApp({
  db,
  engine,
  models,
  artifacts,
  clientRoot: existsSync(builtClient) ? builtClient : undefined,
  authHash: token.hash,
});

serve({ fetch: app.fetch, hostname: host, port }, (info) => {
  console.log(`Brindle listening on http://${info.address}:${info.port}`);
});
