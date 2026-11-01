// A tiny MCP server for tests: two tools over newline-delimited JSON-RPC on stdio.
import { createInterface } from "node:readline";

const tools = [
  {
    name: "echo",
    description: "Echo text",
    inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
  },
  { name: "fail", description: "Always fails", inputSchema: { type: "object", properties: {} } },
];
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);

createInterface({ input: process.stdin }).on("line", (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return;
  if (msg.method === "initialize")
    reply(msg.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "fake", version: "0" },
    });
  else if (msg.method === "tools/list") reply(msg.id, { tools });
  else if (msg.method === "tools/call") {
    const { name, arguments: args } = msg.params;
    if (name === "echo")
      reply(msg.id, {
        content: [
          {
            type: "text",
            text: `echo: ${args.text} (secret set: ${process.env.FAKE_TOKEN ? "yes" : "no"}, other: ${process.env.NOT_PASSED ? "leaked" : "no"})`,
          },
        ],
      });
    else reply(msg.id, { isError: true, content: [{ type: "text", text: "it failed" }] });
  } else
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no such method" } })}\n`,
    );
});
