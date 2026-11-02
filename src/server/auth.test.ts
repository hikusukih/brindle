import { describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { resolveToken, tokenMatches } from "./auth.js";
import { openDatabase } from "./db/index.js";

const token = "test-token-1234abcd1234abcd";

describe("resolveToken", () => {
  it("uses BRINDLE_TOKEN and stores nothing", () => {
    const db = openDatabase(":memory:");
    const r = resolveToken(db, { BRINDLE_TOKEN: token });
    expect(r.generated).toBeUndefined();
    expect(tokenMatches(r.hash, token)).toBe(true);
    expect(tokenMatches(r.hash, `${token}x`)).toBe(false);
    // Nothing was stored, so the next start without the variable generates a fresh one.
    expect(resolveToken(db, {}).generated).toBeDefined();
  });

  it("refuses a short token", () => {
    expect(() => resolveToken(openDatabase(":memory:"), { BRINDLE_TOKEN: "short" })).toThrow(/at least/);
  });

  it("generates once, stores only the hash, and keeps accepting it after a restart", () => {
    const db = openDatabase(":memory:");
    const first = resolveToken(db, {});
    expect(first.generated).toBeDefined();
    expect(tokenMatches(first.hash, first.generated as string)).toBe(true);
    const again = resolveToken(db, {});
    expect(again.generated).toBeUndefined();
    expect(tokenMatches(again.hash, first.generated as string)).toBe(true);
  });
});

describe("the API behind the token", () => {
  const app = () =>
    createApp({
      db: openDatabase(":memory:"),
      authHash: resolveToken(openDatabase(":memory:"), { BRINDLE_TOKEN: token }).hash,
    });
  const get = (a: ReturnType<typeof app>, path: string, authorization?: string) =>
    a.request(path, authorization ? { headers: { authorization } } : undefined);

  it("answers 401 without a valid Authorization header, on every route but health", async () => {
    const a = app();
    for (const path of ["/api/greeting", "/api/channels", "/api/runs/x/events", "/api/nonexistent", "/api/session"]) {
      expect((await get(a, path)).status).toBe(401);
      expect((await get(a, path, "Bearer wrong-token-1234abcd")).status).toBe(401);
      expect((await get(a, path, token)).status).toBe(401);
    }
    expect((await a.request("/api/channels", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await get(a, "/api/health")).status).toBe(200);
  });

  it("lets a request with the token through, and never reads a cookie", async () => {
    const a = app();
    expect((await get(a, "/api/channels", `Bearer ${token}`)).status).toBe(200);
    expect((await get(a, "/api/session", `Bearer ${token}`)).status).toBe(204);
    const viaCookie = await a.request("/api/channels", { headers: { cookie: `token=${token}` } });
    expect(viaCookie.status).toBe(401);
  });

  it("the middleware is the only gate: without a hash the app is open, as the other tests use it", async () => {
    const open = createApp({ db: openDatabase(":memory:") });
    expect((await open.request("/api/channels")).status).toBe(200);
  });
});
