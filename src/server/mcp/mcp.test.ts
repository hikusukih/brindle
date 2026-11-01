import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { needsApproval, ToolRegistry, validateArguments } from "../tools/registry.js";
import type { McpClient } from "./client.js";
import { connectMcpServers, parseMcpConfig } from "./index.js";

const fake = fileURLToPath(new URL("./fake-server.mjs", import.meta.url));
const ctx = {
  runId: "r",
  scope: { kind: "channel", id: "c" } as const,
  signal: new AbortController().signal,
  log: () => {},
  emit: () => {},
};
const config = (extra: object = {}) =>
  parseMcpConfig(
    JSON.stringify({ servers: { fake: { command: process.execPath, args: [fake], env: ["FAKE_TOKEN"], ...extra } } }),
  );

let open: McpClient[] = [];
afterEach(() => {
  for (const c of open) c.close();
  open = [];
});

describe("MCP config", () => {
  it("defaults an unassigned tool to external", () => {
    expect(config().servers.fake?.defaultEffect).toBe("external");
  });

  it("refuses an unknown effect level, a bad server name and missing command", () => {
    expect(() => config({ effects: { echo: "safe" } })).toThrow(/one of read, local, external/);
    expect(() => parseMcpConfig('{"servers":{"a b":{"command":"x"}}}')).toThrow(/Server name/);
    expect(() => parseMcpConfig('{"servers":{"a":{}}}')).toThrow(/command/);
    expect(() => parseMcpConfig("nope")).toThrow(/JSON/);
  });
});

describe("MCP tools in the registry", () => {
  it("registers each tool with the assigned effect, and external when unassigned", async () => {
    const registry = new ToolRegistry();
    open = await connectMcpServers(config({ effects: { echo: "read" } }), registry, { PATH: process.env.PATH });
    expect(registry.get("fake__echo")?.effect).toBe("read");
    expect(registry.get("fake__fail")?.effect).toBe("external");
    const fail = registry.get("fake__fail");
    expect(fail && needsApproval(fail, { id: "c", name: "fake__fail", arguments: {} }, ctx.scope)).toBe(true);
  });

  it("validates arguments from the server's schema and returns the tool's text", async () => {
    const registry = new ToolRegistry();
    open = await connectMcpServers(config({ defaultEffect: "read" }), registry, {
      PATH: process.env.PATH,
      FAKE_TOKEN: "x",
    });
    const echo = registry.get("fake__echo");
    expect(echo && validateArguments(echo, {})).toMatch(/text is required/);
    expect(await echo?.execute({ text: "hi" }, ctx)).toBe("echo: hi (secret set: yes, other: no)");
  });

  it("passes only the named environment variables to the server", async () => {
    const registry = new ToolRegistry();
    open = await connectMcpServers(config({ defaultEffect: "read" }), registry, {
      PATH: process.env.PATH,
      NOT_PASSED: "1",
    });
    expect(await registry.get("fake__echo")?.execute({ text: "a" }, ctx)).toBe("echo: a (secret set: no, other: no)");
  });

  it("throws a tool-reported error so the run records it as an error", async () => {
    const registry = new ToolRegistry();
    open = await connectMcpServers(config({ defaultEffect: "read" }), registry, { PATH: process.env.PATH });
    await expect(registry.get("fake__fail")?.execute({}, ctx)).rejects.toThrow("it failed");
  });

  it("skips a server that won't start and keeps the rest", async () => {
    const registry = new ToolRegistry();
    const warnings: string[] = [];
    const bad = parseMcpConfig(JSON.stringify({ servers: { broken: { command: "/nonexistent/brindle-mcp" } } }));
    open = await connectMcpServers(bad, registry, { PATH: process.env.PATH }, (m) => warnings.push(m));
    expect(open).toHaveLength(0);
    expect(registry.size).toBe(0);
    expect(warnings[0]).toMatch(/broken.*skipped/);
  });
});
