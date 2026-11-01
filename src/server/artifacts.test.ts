import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { ArtifactStore } from "./artifacts.js";
import { createChannel, deleteChannel } from "./channels.js";
import { openDatabase } from "./db/index.js";
import { artifacts, events } from "./db/schema.js";
import { ScriptedModel } from "./model/scripted.js";
import { defaultLimits, RunEngine } from "./runs.js";
import { findArtifactsTool, readArtifactTool } from "./tools/artifacts.js";
import { builtInTools } from "./tools/index.js";

function setup() {
  const db = openDatabase(":memory:");
  const dir = mkdtempSync(join(tmpdir(), "brindle-art-"));
  const store = new ArtifactStore(db, dir);
  return { db, dir, store };
}
const origin = (id: string) => ({ scope: "channel" as const, scopeId: id, runId: "r1" });

describe("artifact store", () => {
  it("writes the file and keeps provenance as copied metadata", () => {
    const { db, dir, store } = setup();
    const ch = createChannel(db, "Trip");
    const a = store.create({ title: "Plan", kind: "document", content: "# Hi" }, origin(ch.id));
    expect(readFileSync(join(dir, a.file), "utf8")).toBe("# Hi");
    expect(a).toMatchObject({ scope: "channel", scopeName: "Trip", runId: "r1", mime: "text/markdown", size: 4 });
  });

  it("outlives its channel", () => {
    const { db, dir, store } = setup();
    const ch = createChannel(db, "Trip");
    const a = store.create({ title: "Plan", kind: "document", content: "x" }, origin(ch.id));
    deleteChannel(db, ch.id);
    expect(store.list()).toHaveLength(1);
    expect(existsSync(join(dir, a.file))).toBe(true);
    expect(store.list()[0]?.scopeName).toBe("Trip");
  });

  it("keeps a model-chosen file name inside the artifact's folder", () => {
    const { db, dir, store } = setup();
    const ch = createChannel(db, "c");
    const a = store.create({ title: "t", kind: "code", content: "x", filename: "../../etc/passwd" }, origin(ch.id));
    expect(a.file).toBe(`${a.id}/passwd`);
    expect(existsSync(join(dir, a.file))).toBe(true);
  });

  it("refuses a bad title, kind or content", () => {
    const { db, store } = setup();
    const ch = createChannel(db, "c");
    expect(() => store.create({ title: " ", kind: "document", content: "x" }, origin(ch.id))).toThrow(/title/);
    expect(() => store.create({ title: "t", kind: "movie", content: "x" }, origin(ch.id))).toThrow(/kind/);
    expect(() => store.create({ title: "t", kind: "code", content: 5 }, origin(ch.id))).toThrow(/text/);
  });

  it("deletes only the listed artifacts of that channel, rows and files together", () => {
    const { db, dir, store } = setup();
    const a = createChannel(db, "A");
    const b = createChannel(db, "B");
    const a1 = store.create({ title: "1", kind: "code", content: "x" }, origin(a.id));
    const a2 = store.create({ title: "2", kind: "code", content: "x" }, origin(a.id));
    const b1 = store.create({ title: "3", kind: "code", content: "x" }, origin(b.id));
    const goal = store.create({ title: "g", kind: "document", content: "x" }, { scope: "goal", scopeId: a.id });
    expect(store.deleteForChannel(a.id, [a1.id, b1.id, goal.id])).toBe(1);
    expect(existsSync(join(dir, a1.file))).toBe(false);
    for (const keep of [a2, b1, goal]) expect(existsSync(join(dir, keep.file))).toBe(true);
    expect(store.deleteForChannel(a.id, [])).toBe(0);
    expect(db.select().from(artifacts).all()).toHaveLength(3);
  });
});

describe("create_artifact in a run", () => {
  it("saves the artifact, emits an artifact event and tells the model", async () => {
    const { db, store } = setup();
    const model = new ScriptedModel({
      turns: [
        {
          toolCalls: [
            { id: "c1", name: "create_artifact", arguments: { title: "Notes", kind: "document", content: "hi" } },
          ],
        },
        { text: ["Saved."] },
      ],
    });
    const engine = new RunEngine(db, model, defaultLimits, builtInTools({}, store));
    const ch = createChannel(db, "Notes channel");
    const run = engine.start(ch.id, "make notes");
    for (let i = 0; i < 200 && store.list().length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    const [art] = store.list();
    expect(art).toMatchObject({ title: "Notes", scopeId: ch.id, runId: run.id, scopeName: "Notes channel" });
    for (let i = 0; i < 200; i++) {
      const types = db
        .select()
        .from(events)
        .where(eq(events.runId, run.id))
        .all()
        .map((e) => e.type);
      if (types.includes("artifact") && types.includes("tool_result")) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    const ev = db.select().from(events).where(eq(events.runId, run.id)).all();
    expect(ev.some((e) => e.type === "artifact" && JSON.parse(e.data).id === art?.id)).toBe(true);
  });
});

describe("find_artifacts and read_artifact", () => {
  const ctx = {
    runId: "r",
    scope: { kind: "channel" as const, id: "c" },
    signal: new AbortController().signal,
    log: () => {},
    emit: () => {},
  };

  it("finds by title or content and kind across channels, and reads content back", async () => {
    const { db, store } = setup();
    const a = createChannel(db, "A");
    const b = createChannel(db, "B");
    const doc = store.create(
      { title: "Itinerary", kind: "document", content: "Fly to Lisbon" },
      origin(a.id),
      new Date(2026, 0, 1),
    );
    store.create({ title: "Sums", kind: "data", content: "{}" }, origin(b.id), new Date(2026, 0, 2));
    const find = findArtifactsTool(store);
    const read = readArtifactTool(store);
    expect(find.effect).toBe("read");
    expect(read.effect).toBe("read");
    expect(await find.execute({}, ctx)).toMatch(/Sums[\s\S]*Itinerary/);
    const byContent = await find.execute({ query: "LISBON" }, ctx);
    expect(byContent).toContain(doc.id);
    expect(byContent).toContain('from channel "A"');
    expect(byContent).not.toContain("Sums");
    expect(await find.execute({ kind: "data" }, ctx)).not.toContain("Itinerary");
    expect(await find.execute({ query: "nothing here" }, ctx)).toBe("No artifacts match.");
    expect(await read.execute({ id: doc.id }, ctx)).toContain("Fly to Lisbon");
    expect(await read.execute({ id: "nope" }, ctx)).toBe("No artifact has that id.");
  });

  it("is registered alongside create_artifact", () => {
    const { store } = setup();
    const names = builtInTools({}, store)
      .definitions()
      .map((d) => d.name);
    expect(names).toEqual(expect.arrayContaining(["create_artifact", "find_artifacts", "read_artifact"]));
  });
});

describe("deleting a channel over the API", () => {
  const del = (app: ReturnType<typeof createApp>, id: string, body?: unknown) =>
    app.request(`/api/channels/${id}`, {
      method: "DELETE",
      ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }),
    });

  it("lists the channel's artifacts, keeps them all by default, deletes the chosen ones", async () => {
    const { db, dir, store } = setup();
    const app = createApp({ db, artifacts: store });
    const ch = createChannel(db, "C");
    const one = store.create({ title: "1", kind: "code", content: "x" }, origin(ch.id));
    const two = store.create({ title: "2", kind: "code", content: "x" }, origin(ch.id));
    const listed = (await (await app.request(`/api/channels/${ch.id}/artifacts`)).json()) as { id: string }[];
    expect(listed).toHaveLength(2);

    const ch2 = createChannel(db, "D");
    store.create({ title: "3", kind: "code", content: "x" }, origin(ch2.id));
    expect((await del(app, ch2.id)).status).toBe(204);
    expect(store.list()).toHaveLength(3);

    expect((await del(app, ch.id, { deleteArtifacts: "all" })).status).toBe(400);
    expect((await del(app, ch.id, { deleteArtifacts: [one.id] })).status).toBe(204);
    expect(store.list().map((a) => a.id)).not.toContain(one.id);
    expect(existsSync(join(dir, two.file))).toBe(true);
    expect(store.list().map((a) => a.id)).toContain(two.id);
  });

  it("answers 404 for a missing channel before touching any artifact", async () => {
    const { db, store } = setup();
    const app = createApp({ db, artifacts: store });
    expect((await del(app, "nope", { deleteArtifacts: ["x"] })).status).toBe(404);
  });
});
