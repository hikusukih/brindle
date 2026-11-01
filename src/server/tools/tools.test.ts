import { describe, expect, it } from "vitest";
import { type Tool, ToolRegistry, validateArguments } from "./registry.js";
import { globalMaxResultTokens, sizeResult } from "./sizing.js";
import { htmlToText, webFetchTool, webSearchTool } from "./web.js";

const ctx = {
  runId: "r",
  scope: { kind: "channel", id: "c" } as const,
  signal: new AbortController().signal,
  log: () => {},
  emit: () => {},
};
const tool = (over: Partial<Tool> = {}): Tool => ({
  name: "t",
  description: "d",
  effect: "read",
  parameters: {
    type: "object",
    properties: { n: { type: "integer" }, s: { type: "string", enum: ["a", "b"] } },
    required: ["n"],
  },
  execute: async () => "ok",
  ...over,
});

describe("registry", () => {
  it("refuses a tool without an effect level, a duplicate, and an unnamed tool", () => {
    const registry = new ToolRegistry();
    expect(() => registry.register({ ...tool(), effect: undefined as never })).toThrow(/effect level/);
    registry.register(tool());
    expect(() => registry.register(tool())).toThrow(/already registered/);
    expect(() => registry.register(tool({ name: "" }))).toThrow(/name/);
  });

  it("offers the model name, description and parameters only", () => {
    const defs = new ToolRegistry().register(tool()).definitions();
    expect(Object.keys(defs[0] ?? {}).sort()).toEqual(["description", "name", "parameters"]);
  });

  it("validates arguments against the schema subset", () => {
    const t = tool();
    expect(validateArguments(t, { n: 1 })).toBeNull();
    expect(validateArguments(t, {})).toMatch(/n is required/);
    expect(validateArguments(t, { n: 1.5 })).toMatch(/integer/);
    expect(validateArguments(t, { n: 1, s: "c" })).toMatch(/one of a, b/);
    expect(validateArguments(t, "x")).toMatch(/object/);
  });
});

describe("sizeResult", () => {
  it("passes a small result through", () => {
    expect(sizeResult("short")).toEqual({ text: "short", truncated: false });
  });

  it("cuts a huge result to the cap, keeps head and tail, and says how much was dropped", () => {
    const full = `HEAD${"x".repeat(100_000)}TAIL`;
    const sized = sizeResult(full);
    expect(sized.truncated).toBe(true);
    expect(sized.text.length).toBeLessThan(4_000 * 4 + 200);
    expect(sized.text.startsWith("HEAD")).toBe(true);
    expect(sized.text.endsWith("TAIL")).toBe(true);
    expect(sized.text).toMatch(/\d+ of 100008 characters omitted/);
  });

  it("never lets a tool raise the global cap", () => {
    const sized = sizeResult("x".repeat(500_000), 1_000_000);
    expect(sized.text.length).toBeLessThan(globalMaxResultTokens * 4 + 200);
  });
});

describe("htmlToText", () => {
  it("drops scripts, styles and markup and decodes entities", () => {
    const html =
      "<html><head><style>p{}</style><script>alert(1)</script></head><body><h1>Title</h1><p>A &amp; B&nbsp;&#169;</p><p>Two</p></body></html>";
    expect(htmlToText(html)).toBe("Title\n\nA & B ©\n\nTwo");
  });
});

const page = (body: string, type = "text/html") => new Response(body, { headers: { "content-type": type } });
const publicResolver = async () => ["93.184.216.34"];

describe("web_fetch", () => {
  it("is a read tool that returns readable text", async () => {
    const t = webFetchTool({ fetch: async () => page("<p>Hello</p>"), resolve: publicResolver });
    expect(t.effect).toBe("read");
    expect(await t.execute({ url: "https://example.com/a" }, ctx)).toBe("Hello");
  });

  it("refuses private and local addresses, including through DNS and redirects", async () => {
    const t = webFetchTool({ fetch: async () => page("secret"), resolve: async () => ["10.0.0.5"] });
    await expect(t.execute({ url: "http://127.0.0.1:8787/" }, ctx)).rejects.toThrow(/private address/);
    await expect(t.execute({ url: "http://localhost/" }, ctx)).rejects.toThrow(/local address/);
    await expect(t.execute({ url: "http://[::1]/" }, ctx)).rejects.toThrow(/private address/);
    await expect(t.execute({ url: "https://intranet.example.com/" }, ctx)).rejects.toThrow(/resolves to a private/);

    const redirecting = webFetchTool({
      fetch: async () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } }),
      resolve: publicResolver,
    });
    await expect(redirecting.execute({ url: "https://example.com/" }, ctx)).rejects.toThrow(/private address/);
  });

  it("allows private addresses only when the operator says so", async () => {
    const t = webFetchTool({ fetch: async () => page("lan", "text/plain"), allowPrivate: true });
    expect(await t.execute({ url: "http://192.168.1.2/" }, ctx)).toBe("lan");
  });

  it("rejects other schemes, bad URLs, error statuses and binary content", async () => {
    const t = webFetchTool({ fetch: async () => new Response("no", { status: 404 }), resolve: publicResolver });
    await expect(t.execute({ url: "file:///etc/passwd" }, ctx)).rejects.toThrow(/http and https/);
    await expect(t.execute({ url: "not a url" }, ctx)).rejects.toThrow(/not a valid URL/);
    await expect(t.execute({ url: "https://example.com/" }, ctx)).rejects.toThrow(/404/);
    const bin = webFetchTool({ fetch: async () => page("x", "image/png"), resolve: publicResolver });
    await expect(bin.execute({ url: "https://example.com/i.png" }, ctx)).rejects.toThrow(/image\/png/);
  });

  it("stops following redirects after a few hops", async () => {
    const loop = webFetchTool({
      fetch: async () => new Response(null, { status: 302, headers: { location: "https://example.com/again" } }),
      resolve: publicResolver,
    });
    await expect(loop.execute({ url: "https://example.com/" }, ctx)).rejects.toThrow(/Too many redirects/);
  });
});

describe("web_search", () => {
  it("formats results from a SearXNG-style endpoint", async () => {
    let asked = "";
    const t = webSearchTool("https://search.example.com/", {
      fetch: async (input) => {
        asked = String(input);
        return Response.json({
          results: [
            { title: "One", url: "https://a.example.com", content: "first" },
            { title: "Two", url: "https://b.example.com", content: "second" },
          ],
        });
      },
    });
    const out = await t.execute({ query: "rust lifetimes", count: 1 }, ctx);
    expect(asked).toBe("https://search.example.com/search?q=rust+lifetimes&format=json");
    expect(out).toBe("1. One\n   https://a.example.com\n   first");
  });

  it("reports a service that fails or answers with something else", async () => {
    const down = webSearchTool("https://search.example.com", { fetch: async () => new Response("", { status: 502 }) });
    await expect(down.execute({ query: "x" }, ctx)).rejects.toThrow(/502/);
    const odd = webSearchTool("https://search.example.com", { fetch: async () => Response.json({ nope: 1 }) });
    await expect(odd.execute({ query: "x" }, ctx)).rejects.toThrow(/isn't search results/);
  });
});
