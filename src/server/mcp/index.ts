import { existsSync, readFileSync } from "node:fs";
import type { EffectLevel, Tool, ToolRegistry } from "../tools/registry.js";
import { McpClient, type McpServerSpec } from "./client.js";

type ServerConfig = McpServerSpec & {
  /** Effect level per tool name, assigned by the user. */
  effects?: Record<string, EffectLevel>;
  /** For tools not named in `effects`. Defaults to external, so an unreviewed tool always asks. */
  defaultEffect?: EffectLevel;
};

export type McpConfig = { servers: Record<string, ServerConfig> };

const levels = ["read", "local", "external"];

export class McpConfigError extends Error {}

function level(value: unknown, where: string): EffectLevel {
  if (typeof value !== "string" || !levels.includes(value)) {
    throw new McpConfigError(`${where} must be one of read, local, external.`);
  }
  return value as EffectLevel;
}

/** Checked at startup so a typo in an effect level can't quietly widen what runs without asking. */
export function parseMcpConfig(text: string): McpConfig {
  let raw: { servers?: Record<string, Record<string, unknown>> };
  try {
    raw = JSON.parse(text);
  } catch {
    throw new McpConfigError("mcp.json is not valid JSON.");
  }
  const servers: McpConfig["servers"] = {};
  for (const [name, s] of Object.entries(raw.servers ?? {})) {
    if (!/^[A-Za-z0-9_-]{1,30}$/.test(name)) {
      throw new McpConfigError(`Server name "${name}" must be 1 to 30 letters, digits, - or _.`);
    }
    if (typeof s.command !== "string" || !s.command) throw new McpConfigError(`${name}: command is required.`);
    const effects: Record<string, EffectLevel> = {};
    for (const [tool, value] of Object.entries((s.effects ?? {}) as Record<string, unknown>)) {
      effects[tool] = level(value, `${name}.effects.${tool}`);
    }
    servers[name] = {
      command: s.command,
      args: Array.isArray(s.args) ? s.args.map(String) : undefined,
      env: Array.isArray(s.env) ? s.env.map(String) : undefined,
      effects,
      defaultEffect: s.defaultEffect === undefined ? "external" : level(s.defaultEffect, `${name}.defaultEffect`),
    };
  }
  return { servers };
}

function toolName(server: string, tool: string): string {
  return `${server}__${tool}`.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 64);
}

/** Wraps one MCP tool as a registry tool, so approval, validation and result sizing apply to it like any other. */
export function mcpTool(
  client: McpClient,
  server: string,
  info: { name: string; description: string; inputSchema: Record<string, unknown> },
  effect: EffectLevel,
): Tool {
  return {
    name: toolName(server, info.name),
    description: `[${server}] ${info.description}`,
    effect,
    parameters: info.inputSchema,
    describeCall: (args) => `${server}: ${info.name} ${JSON.stringify(args).slice(0, 200)}`,
    execute: (args, ctx) => client.callTool(info.name, args, ctx.signal),
  };
}

/**
 * Starts each configured server and registers its tools. A server that won't start or answer is skipped
 * with a warning, since one broken plug-in shouldn't keep the rest of Brindle from starting.
 */
export async function connectMcpServers(
  config: McpConfig,
  registry: ToolRegistry,
  env: Record<string, string | undefined> = process.env,
  warn: (message: string) => void = console.warn,
): Promise<McpClient[]> {
  const clients: McpClient[] = [];
  for (const [name, server] of Object.entries(config.servers)) {
    const client = new McpClient(name, server, env);
    try {
      await client.connect();
      for (const info of await client.listTools()) {
        const effect = server.effects?.[info.name] ?? server.defaultEffect ?? "external";
        registry.register(mcpTool(client, name, info, effect));
      }
      clients.push(client);
    } catch (error) {
      client.close();
      warn(`MCP server "${name}" skipped: ${(error as Error).message}`);
    }
  }
  return clients;
}

/** Reads `mcp.json` from the data directory; no file means no MCP servers. */
export function loadMcpConfig(path: string): McpConfig {
  return existsSync(path) ? parseMcpConfig(readFileSync(path, "utf8")) : { servers: {} };
}
