import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { createChannel } from "./channels.js";
import { assembleContext } from "./context.js";
import { openDatabase } from "./db/index.js";
import { schedules } from "./db/schema.js";
import { ScriptedModel } from "./model/scripted.js";
import { RunEngine } from "./runs.js";
import { Scheduler } from "./scheduler.js";
import { describeToday, getTimeZone, setTimeZone, TimeZoneError } from "./time-zone.js";

describe("the user's time zone", () => {
  it("stores one IANA name, refuses others, and keeps a first choice against the browser's guess", () => {
    const db = openDatabase(":memory:");
    expect(getTimeZone(db)).toBeNull();
    expect(() => setTimeZone(db, "Mars/Olympus")).toThrow(TimeZoneError);
    expect(() => setTimeZone(db, "  ")).toThrow(TimeZoneError);
    expect(setTimeZone(db, "Europe/Lisbon", { onlyIfUnset: true })).toBe("Europe/Lisbon");
    expect(setTimeZone(db, "America/Denver", { onlyIfUnset: true })).toBe("Europe/Lisbon");
    expect(setTimeZone(db, "America/Denver")).toBe("America/Denver");
    expect(getTimeZone(db)).toBe("America/Denver");
  });

  it("stores the standard spelling of a name typed in another case", () => {
    const db = openDatabase(":memory:");
    expect(setTimeZone(db, " europe/lisbon ")).toBe("Europe/Lisbon");
    expect(getTimeZone(db)).toBe("Europe/Lisbon");
  });

  it("the API reads and sets it, tells the scheduler of a change only, and answers 400 for a bad name", async () => {
    const db = openDatabase(":memory:");
    const changes: string[] = [];
    const app = createApp({ db, onTimeZoneChange: (tz) => changes.push(tz) });
    const put = (body: unknown) =>
      app.request("/api/settings/time-zone", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect(await (await app.request("/api/settings/time-zone")).json()).toEqual({ timeZone: null });
    expect((await put({ timeZone: "Europe/Lisbon", onlyIfUnset: true })).status).toBe(200);
    expect((await put({ timeZone: "Europe/Lisbon" })).status).toBe(200);
    expect((await put({ timeZone: "Asia/Tokyo", onlyIfUnset: true })).status).toBe(200);
    expect(await (await app.request("/api/settings/time-zone")).json()).toEqual({ timeZone: "Europe/Lisbon" });
    expect((await put({ timeZone: "nope" })).status).toBe(400);
    await put({ timeZone: "Asia/Tokyo" });
    expect(changes).toEqual(["Europe/Lisbon", "Asia/Tokyo"]);
  });

  it("tells the agent the date where the user is, not where the server is", () => {
    // 03:30 UTC on March 2 is still the evening of March 1 in New York and already morning in Tokyo.
    const now = new Date("2026-03-02T03:30:00.000Z");
    expect(describeToday("America/New_York", now)).toBe("Today is Sunday, March 1, 2026 (time zone America/New_York).");
    expect(describeToday("Asia/Tokyo", now)).toBe("Today is Monday, March 2, 2026 (time zone Asia/Tokyo).");
  });

  it("puts the date just before the current run and counts it, and leaves it out when unset", () => {
    const past = [{ id: "r1", messages: [{ role: "user" as const, content: "earlier" }] }];
    const current = [{ role: "user" as const, content: "now" }];
    const withDate = assembleContext({ past, current, today: "Today is Monday." });
    expect(withDate.messages.map((m) => m.content)).toEqual([expect.any(String), "earlier", "Today is Monday.", "now"]);
    expect(withDate.report.layers.map((l) => l.name)).toContain("today");
    const without = assembleContext({ past, current });
    expect(without.messages).toHaveLength(3);
    expect(without.report.layers.map((l) => l.name)).not.toContain("today");
  });

  it("a run sends the date in the user's zone, read fresh for each request", async () => {
    const db = openDatabase(":memory:");
    const seen: string[][] = [];
    const model = new ScriptedModel({ turns: [{ text: ["ok"] }, { text: ["ok"] }] });
    const spy = {
      stream(request: Parameters<ScriptedModel["stream"]>[0]) {
        seen.push(request.messages.map((m) => m.content));
        return model.stream(request);
      },
    };
    const engine = new RunEngine(db, spy);
    engine.timeZone = () => getTimeZone(db);
    const channel = createChannel(db, "C");
    setTimeZone(db, "Asia/Tokyo");
    const first = engine.start(channel.id, "hi");
    await engine.whenSettled(first.id);
    setTimeZone(db, "America/Denver");
    const second = engine.start(channel.id, "again");
    await engine.whenSettled(second.id);
    expect(seen[0]?.some((m) => m.includes("time zone Asia/Tokyo"))).toBe(true);
    expect(seen[1]?.some((m) => m.includes("time zone America/Denver"))).toBe(true);
  });

  it("changing the zone moves a schedule's next fire: 6:30 stays 6:30 where the user is", () => {
    const db = openDatabase(":memory:");
    const hooks = { prepareRun: () => "r", beginRun: () => {}, goalBusy: () => false };
    const scheduler = new Scheduler(db, hooks, { timeZone: "America/New_York" });
    const now = new Date("2026-03-02T12:00:00.000Z");
    const created = scheduler.createSchedule({ goalId: "g", cron: "30 6 * * *", prompt: "brief" }, now);
    expect(created.nextFireAt).toBe("2026-03-03T11:30:00.000Z");
    scheduler.setTimeZone("Asia/Tokyo", now);
    expect(db.select().from(schedules).get()?.nextFireAt).toBe("2026-03-02T21:30:00.000Z");
    expect(() => scheduler.setTimeZone("nope", now)).toThrow();
  });
});
