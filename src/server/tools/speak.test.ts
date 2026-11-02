import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactStore } from "../artifacts.js";
import { createChannel } from "../channels.js";
import { openDatabase } from "../db/index.js";
import { builtInTools } from "./index.js";
import { speakTool } from "./speak.js";

function setup(reply: () => Response) {
  const db = openDatabase(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "brindle-speak-"));
  const store = new ArtifactStore(db, dir);
  const channel = createChannel(db, "Brief");
  const seen: { url: string; init: RequestInit }[] = [];
  const tool = speakTool(store, {
    baseUrl: "http://192.0.2.10:8880/v1/",
    model: "tts-test",
    voice: "alloy",
    apiKey: "sk-test-1234abcd1234abcd",
    fetch: (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return reply();
    }) as unknown as typeof fetch,
  });
  const events: { type: string; data: unknown }[] = [];
  const ctx = {
    runId: "r1",
    scope: { kind: "channel" as const, id: channel.id },
    signal: new AbortController().signal,
    log: () => {},
    emit: (type: string, data: unknown) => events.push({ type, data }),
  };
  return { db, dir, store, tool, seen, events, ctx };
}

const mp3 = () => new Response(new Uint8Array([1, 2, 3, 4]), { headers: { "content-type": "audio/mpeg" } });

describe("speak", () => {
  it("is local, posts to the speech endpoint with the key in the header, and saves an audio artifact", async () => {
    const { tool, seen, store, dir, events, ctx } = setup(mp3);
    expect(tool.effect).toBe("local");
    const result = await tool.execute({ title: "Morning brief", text: "Good morning." }, ctx);
    expect(result).toMatch(/^Saved audio "Morning brief"/);
    expect(seen[0]?.url).toBe("http://192.0.2.10:8880/v1/audio/speech");
    expect((seen[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer sk-test-1234abcd1234abcd");
    expect(JSON.parse(String(seen[0]?.init.body))).toMatchObject({
      model: "tts-test",
      voice: "alloy",
      input: "Good morning.",
    });
    const [a] = store.list({ kind: "audio" });
    expect(a).toMatchObject({ kind: "audio", mime: "audio/mpeg", size: 4, runId: "r1" });
    expect([...readFileSync(join(dir, a?.file ?? ""))]).toEqual([1, 2, 3, 4]);
    expect(events[0]).toMatchObject({ type: "artifact", data: { kind: "audio" } });
  });

  it("refuses empty or over-long text, a failing server, and a reply that is not audio", async () => {
    const ok = setup(mp3);
    await expect(ok.tool.execute({ title: "t", text: "  " }, ok.ctx)).rejects.toThrow(/something to say/);
    await expect(ok.tool.execute({ title: "t", text: "x".repeat(5_000) }, ok.ctx)).rejects.toThrow(/in parts/);
    const failing = setup(() => new Response("secret echo", { status: 500 }));
    await expect(failing.tool.execute({ title: "t", text: "hi" }, failing.ctx)).rejects.toThrow(/answered 500\.$/);
    const html = setup(() => new Response("<script>x</script>", { headers: { "content-type": "text/html" } }));
    await expect(html.tool.execute({ title: "t", text: "hi" }, html.ctx)).rejects.toThrow(/not an audio type/);
    expect(html.store.list()).toEqual([]);
  });

  it("is only a tool when a speech endpoint is configured, and create_artifact cannot make audio", async () => {
    const db = openDatabase(":memory:");
    const store = new ArtifactStore(db, mkdtempSync(join(tmpdir(), "brindle-speak-")));
    const names = (env: Record<string, string>) =>
      builtInTools(env, store)
        .definitions()
        .map((d) => d.name);
    expect(names({})).not.toContain("speak");
    expect(names({ BRINDLE_SPEECH_URL: "http://192.0.2.10:8880/v1" })).toContain("speak");
    const channel = createChannel(db, "C");
    expect(() =>
      store.create({ title: "t", kind: "audio", content: "x" }, { scope: "channel", scopeId: channel.id }),
    ).toThrow(/kind/);
  });

  it("keeps audio out of text search and read_artifact", async () => {
    const { store, tool, ctx } = setup(mp3);
    await tool.execute({ title: "Brief", text: "hello" }, ctx);
    expect(store.find({ query: "\u0001" })).toEqual([]);
    expect(store.find({ query: "brief" })).toHaveLength(1);
  });
});
