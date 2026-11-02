import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { ChannelError, createChannel, ensureHomeChannel, getChannel, listChannels } from "./channels.js";
import { openDatabase } from "./db/index.js";
import { channels, events, runs } from "./db/schema.js";

function setup() {
  const db = openDatabase(":memory:");
  const app = createApp({ db });
  const send = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { db, send };
}

describe("channel routes", () => {
  it("creates, lists and renames a channel", async () => {
    const { send } = setup();
    const created = await send("POST", "/api/channels", { name: "  Trip planning " });
    expect(created.status).toBe(201);
    const channel = (await created.json()) as { id: string; name: string };
    expect(channel.name).toBe("Trip planning");

    const renamed = await send("PATCH", `/api/channels/${channel.id}`, { name: "Japan trip" });
    expect(((await renamed.json()) as { name: string }).name).toBe("Japan trip");

    const list = (await (await send("GET", "/api/channels")).json()) as { name: string }[];
    expect(list.map((c) => c.name)).toEqual(["Japan trip"]);
  });

  it("rejects empty and overlong names", async () => {
    const { send } = setup();
    expect((await send("POST", "/api/channels", { name: "   " })).status).toBe(400);
    expect((await send("POST", "/api/channels", {})).status).toBe(400);
    expect((await send("POST", "/api/channels", { name: "x".repeat(121) })).status).toBe(400);
  });

  it("archives out of the main list, blocks renames, and restores", async () => {
    const { send } = setup();
    const { id } = (await (await send("POST", "/api/channels", { name: "Old" })).json()) as { id: string };

    expect((await send("POST", `/api/channels/${id}/archive`)).status).toBe(200);
    expect(await (await send("GET", "/api/channels")).json()).toEqual([]);
    const archived = (await (await send("GET", "/api/channels?archived=true")).json()) as { id: string }[];
    expect(archived.map((c) => c.id)).toEqual([id]);
    expect((await send("PATCH", `/api/channels/${id}`, { name: "New" })).status).toBe(409);

    const restored = (await (await send("POST", `/api/channels/${id}/restore`)).json()) as {
      archivedAt: string | null;
    };
    expect(restored.archivedAt).toBeNull();
    expect((await send("PATCH", `/api/channels/${id}`, { name: "New" })).status).toBe(200);
  });

  it("answers 404 for unknown channels", async () => {
    const { send } = setup();
    expect((await send("PATCH", "/api/channels/nope", { name: "x" })).status).toBe(404);
    expect((await send("POST", "/api/channels/nope/archive")).status).toBe(404);
    expect((await send("DELETE", "/api/channels/nope")).status).toBe(404);
  });

  it("deletes a channel together with its runs and events", async () => {
    const { db, send } = setup();
    const channel = createChannel(db, "Doomed");
    const other = createChannel(db, "Kept");
    const stamp = new Date().toISOString();
    for (const [runId, channelId] of [
      ["r1", channel.id],
      ["r2", other.id],
    ] as const) {
      db.insert(runs).values({ id: runId, channelId, status: "done", startedAt: stamp }).run();
      db.insert(events)
        .values({ id: `e-${runId}`, runId, seq: 0, type: "message", data: "{}", createdAt: stamp })
        .run();
    }

    expect((await send("DELETE", `/api/channels/${channel.id}`)).status).toBe(204);

    expect(
      db
        .select()
        .from(runs)
        .all()
        .map((r) => r.id),
    ).toEqual(["r2"]);
    expect(
      db
        .select()
        .from(events)
        .all()
        .map((e) => e.id),
    ).toEqual(["e-r2"]);
    expect(db.select().from(channels).where(eq(channels.id, channel.id)).all()).toEqual([]);
  });
});

describe("channel store", () => {
  it("lists the most recently changed channel first", () => {
    const { db } = setup();
    createChannel(db, "first", new Date("2026-01-01T00:00:00Z"));
    createChannel(db, "second", new Date("2026-01-02T00:00:00Z"));
    expect(listChannels(db).map((c) => c.name)).toEqual(["second", "first"]);
  });

  it("keeps channels across reopening the same database file", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const file = join(mkdtempSync(join(tmpdir(), "brindle-")), "t.sqlite");
    const id = createChannel(openDatabase(file), "Persisted").id;
    expect(getChannel(openDatabase(file), id).name).toBe("Persisted");
    expect(() => getChannel(openDatabase(file), "missing")).toThrow(ChannelError);
  });
});

describe("the Home channel", () => {
  it("is made once, found again after a restart, and flagged in the list", async () => {
    const { db, send } = setup();
    const home = ensureHomeChannel(db);
    expect(home.isHome).toBe(true);
    expect(ensureHomeChannel(db).id).toBe(home.id);
    const listed = (await (await send("GET", "/api/channels")).json()) as { id: string; isHome: boolean }[];
    expect(listed.filter((c) => c.isHome).map((c) => c.id)).toEqual([home.id]);
    expect(createChannel(db, "Other").isHome).toBe(false);
  });

  it("can be renamed but not archived or deleted, and is still the Home channel after a rename", async () => {
    const { db, send } = setup();
    const home = ensureHomeChannel(db);
    expect((await send("PATCH", `/api/channels/${home.id}`, { name: "Front door" })).status).toBe(200);
    for (const [method, path] of [
      ["POST", `/api/channels/${home.id}/archive`],
      ["DELETE", `/api/channels/${home.id}`],
    ] as const) {
      const res = await send(method, path);
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toBe("home");
    }
    expect(getChannel(db, home.id)).toMatchObject({ name: "Front door", isHome: true, archivedAt: null });
    expect(ensureHomeChannel(db).id).toBe(home.id);
  });
});
