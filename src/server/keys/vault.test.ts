import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/index.js";
import { secrets } from "../db/schema.js";
import { aadFor, open } from "./crypto.js";
import { openVault, Vault, VaultError } from "./index.js";
import { masterKeyBytes } from "./master-key.js";

const value = "sk-test-1234abcd1234abcd";
const scope = { hosts: ["api.example.com"] };

function setup() {
  const root = mkdtempSync(join(tmpdir(), "brindle-vault-"));
  const dataDir = join(root, "data");
  const keyFile = join(root, "keys", "master.key");
  const db = openDatabase(":memory:");
  const vault = openVault(db, { keyFile, dataDir });
  return { root, dataDir, keyFile, db, vault, reopen: () => openVault(db, { keyFile, dataDir }) };
}

/** Reads a stored value back the way the vault's own `fetch` will, to prove what is on disk is really the value. */
const plaintextOf = (ctx: ReturnType<typeof setup>, name: string) => {
  const row = ctx.db.select().from(secrets).where(eq(secrets.name, name)).get();
  if (!row) throw new Error("no such secret");
  return open(readFileSync(ctx.keyFile), row, aadFor(row.id, row.name, row.scopeHash));
};

describe("the vault's storage", () => {
  it("keeps the value only as ciphertext, in no encoding the database holds", () => {
    const ctx = setup();
    ctx.vault.store({ name: "weather", kind: "bearer", value, scope });
    const everything = JSON.stringify(ctx.db.select().from(secrets).all());
    for (const form of [value, Buffer.from(value).toString("base64"), Buffer.from(value).toString("hex")]) {
      expect(everything).not.toContain(form);
    }
    expect(plaintextOf(ctx, "weather")).toBe(value);
  });

  it("uses a fresh nonce for every value, so equal values do not look equal", () => {
    const ctx = setup();
    ctx.vault.store({ name: "one", kind: "bearer", value, scope });
    ctx.vault.store({ name: "two", kind: "bearer", value, scope });
    const [a, b] = ctx.db.select().from(secrets).all();
    expect(a?.nonce).not.toBe(b?.nonce);
    expect(a?.ciphertext).not.toBe(b?.ciphertext);
  });

  it("refuses a ciphertext moved to another secret and a scope edited in the database", () => {
    const ctx = setup();
    ctx.vault.store({ name: "one", kind: "bearer", value, scope });
    ctx.vault.store({ name: "two", kind: "bearer", value: "another-secret-9876", scope });
    const [one, two] = ["one", "two"].map((n) => ctx.db.select().from(secrets).where(eq(secrets.name, n)).get());
    ctx.db
      .update(secrets)
      .set({ nonce: two?.nonce ?? "", ciphertext: two?.ciphertext ?? "" })
      .where(eq(secrets.name, "one"))
      .run();
    expect(() => ctx.reopen()).toThrow(/does not open the vault/);
    ctx.db
      .update(secrets)
      .set({ nonce: one?.nonce ?? "", ciphertext: one?.ciphertext ?? "" })
      .where(eq(secrets.name, "one"))
      .run();
    expect(() => ctx.reopen()).not.toThrow();
    // Widening the scope in the database changes its hash, which is part of what the value is bound to.
    ctx.db
      .update(secrets)
      .set({ scopeHash: "0".repeat(64) })
      .where(eq(secrets.name, "one"))
      .run();
    expect(() => ctx.reopen()).toThrow(/does not open the vault/);
  });

  it("returns metadata and never a value from store, describe or list", () => {
    const ctx = setup();
    const made = ctx.vault.store({ name: "weather", kind: "api_key", headerName: "X-Api-Key", value, scope });
    expect(made).toMatchObject({ handle: "{{secret:weather}}", status: "active", headerName: "X-Api-Key" });
    expect(
      JSON.stringify([made, ctx.vault.describe("weather"), ctx.vault.describe("{{secret:weather}}"), ctx.vault.list()]),
    ).not.toContain(value);
    expect(ctx.vault.describe("missing")).toBeNull();
  });

  it("has no method that returns a plaintext value", () => {
    const names = Object.getOwnPropertyNames(Vault.prototype).sort();
    expect(names).toEqual([
      "constructor",
      "describe",
      "list",
      "reveal",
      "revoke",
      "rotateMasterKey",
      "store",
      "verifyKey",
    ]);
    // reveal is private and unused outside the class; nothing public takes a handle and returns text.
    const ctx = setup();
    ctx.vault.store({ name: "weather", kind: "bearer", value, scope });
    for (const method of [
      ctx.vault.describe("weather"),
      ctx.vault.list()[0],
      ctx.vault.store({ name: "second", kind: "bearer", value, scope }),
    ]) {
      expect(JSON.stringify(method)).not.toContain(value);
    }
  });
});

describe("what store accepts", () => {
  it("refuses short values, bad names, duplicates, malformed kinds and impossible scopes", () => {
    const { vault } = setup();
    const ok = { name: "weather", kind: "bearer" as const, value, scope };
    expect(() => vault.store({ ...ok, value: "short" })).toThrow(/at least 8/);
    expect(() => vault.store({ ...ok, name: "Has Spaces" })).toThrow(/name/);
    expect(() => vault.store({ ...ok, kind: "basic_auth", value: "nocolonhere" })).toThrow(/username:password/);
    expect(() => vault.store({ ...ok, kind: "api_key" })).toThrow(/header/);
    expect(() => vault.store({ ...ok, headerName: "X-Key" })).toThrow(/Only an API key/);
    expect(() => vault.store({ ...ok, scope: { hosts: [] } })).toThrow(/at least one host/);
    expect(() => vault.store({ ...ok, scope: { hosts: ["https://api.example.com/path"] } })).toThrow(/not a host/);
    expect(() => vault.store({ ...ok, scope: { hosts: ["api.example.com:99999"] } })).toThrow(/port/);
    expect(() => vault.store({ ...ok, scope: { hosts: ["a.example.com"], methods: ["TRACE"] } })).toThrow(/method/);
    expect(() => vault.store({ ...ok, expiresAt: new Date(0) })).toThrow(/past/);
    vault.store(ok);
    expect(() => vault.store(ok)).toThrow(/already exists/);
  });

  it("defaults to GET only and a card for every use, and normalizes hosts", () => {
    const { vault } = setup();
    const made = vault.store({
      name: "weather",
      kind: "bearer",
      value,
      scope: { hosts: ["API.Example.com", "*.example.org:8443"] },
    });
    expect(made.scope).toEqual({
      hosts: ["*.example.org:8443", "api.example.com"],
      methods: ["GET"],
      tools: [],
      goals: [],
      channels: [],
      requiresApproval: true,
    });
  });
});

describe("who may see which secret", () => {
  it("shows a run only the active secrets its goal and channel may use", () => {
    const { vault } = setup();
    vault.store({ name: "shared", kind: "bearer", value, scope });
    vault.store({ name: "for-a", kind: "bearer", value, scope: { ...scope, goals: ["goal-a"] } });
    vault.store({ name: "for-b", kind: "bearer", value, scope: { ...scope, goals: ["goal-b"] } });
    vault.store({ name: "in-chat", kind: "bearer", value, scope: { ...scope, channels: ["chat-1"] } });
    vault.store({ name: "gone", kind: "bearer", value, scope });
    vault.revoke("gone");
    const names = (viewer: { goalId?: string; channelId?: string }) => vault.list(viewer).map((s) => s.name);
    expect(names({ goalId: "goal-a" })).toEqual(["for-a", "shared"]);
    expect(names({ goalId: "goal-b", channelId: "chat-1" })).toEqual(["for-b", "in-chat", "shared"]);
    expect(names({})).toEqual(["shared"]);
    expect(vault.list().map((s) => s.name)).toEqual(["for-a", "for-b", "gone", "in-chat", "shared"]);
  });

  it("marks expired and revoked secrets and hides them from runs", () => {
    const { vault } = setup();
    const now = new Date("2026-01-01T00:00:00Z");
    vault.store(
      { name: "short-lived", kind: "bearer", value, scope, expiresAt: new Date("2026-01-02T00:00:00Z") },
      now,
    );
    expect(vault.describe("short-lived", now)?.status).toBe("active");
    const later = new Date("2026-01-03T00:00:00Z");
    expect(vault.describe("short-lived", later)?.status).toBe("expired");
    expect(vault.list({}, later)).toEqual([]);
  });

  it("wipes the sealed value on revoke, so it cannot come back, and keeps the name in history", () => {
    const ctx = setup();
    ctx.vault.store({ name: "weather", kind: "bearer", value, scope });
    expect(ctx.vault.revoke("{{secret:weather}}")).toBe(true);
    expect(ctx.vault.revoke("weather")).toBe(false);
    expect(ctx.vault.describe("weather")?.status).toBe("revoked");
    const row = ctx.db.select().from(secrets).get();
    expect(row).toMatchObject({ ciphertext: "", nonce: "" });
    expect(() => ctx.reopen()).not.toThrow();
  });
});

describe("the master key file", () => {
  it("is created with owner-only permissions when the vault is empty, and reused after", () => {
    const ctx = setup();
    expect(statSync(ctx.keyFile).mode & 0o777).toBe(0o600);
    expect(readFileSync(ctx.keyFile)).toHaveLength(masterKeyBytes);
    const before = readFileSync(ctx.keyFile);
    ctx.vault.store({ name: "weather", kind: "bearer", value, scope });
    ctx.reopen();
    expect(readFileSync(ctx.keyFile).equals(before)).toBe(true);
  });

  it("refuses to start with a key file other users can read", async () => {
    const ctx = setup();
    const { chmodSync } = await import("node:fs");
    chmodSync(ctx.keyFile, 0o640);
    expect(() => ctx.reopen()).toThrow(/can be read by other users/);
    chmodSync(ctx.keyFile, 0o600);
    expect(() => ctx.reopen()).not.toThrow();
  });

  it("refuses a missing file when the vault holds secrets, instead of making a new key", () => {
    const ctx = setup();
    ctx.vault.store({ name: "weather", kind: "bearer", value, scope });
    renameSync(ctx.keyFile, `${ctx.keyFile}.moved`);
    expect(() => ctx.reopen()).toThrow(/missing/);
    expect(existsSync(ctx.keyFile)).toBe(false);
  });

  it("refuses a file of the wrong size, a wrong key, and a path inside the data directory", () => {
    const ctx = setup();
    ctx.vault.store({ name: "weather", kind: "bearer", value, scope });
    writeFileSync(ctx.keyFile, randomBytes(16), { mode: 0o600 });
    expect(() => ctx.reopen()).toThrow(/exactly 32 bytes/);
    writeFileSync(ctx.keyFile, randomBytes(masterKeyBytes), { mode: 0o600 });
    expect(() => ctx.reopen()).toThrow(/does not open the vault/);
    const db = openDatabase(":memory:");
    expect(() => openVault(db, { keyFile: join(ctx.dataDir, "master.key"), dataDir: ctx.dataDir })).toThrow(
      /outside the data directory/,
    );
  });
});

describe("rotating the master key", () => {
  it("re-encrypts every value, retires the old file and keeps the values", () => {
    const ctx = setup();
    ctx.vault.store({ name: "one", kind: "bearer", value, scope });
    ctx.vault.store({ name: "two", kind: "bearer", value: "another-secret-9876", scope });
    ctx.vault.store({ name: "gone", kind: "bearer", value, scope });
    ctx.vault.revoke("gone");
    const oldKey = readFileSync(ctx.keyFile);
    const before = ctx.db.select().from(secrets).where(eq(secrets.name, "one")).get()?.ciphertext;
    const result = ctx.vault.rotateMasterKey();
    expect(result.rotated).toBe(2);
    expect(readFileSync(result.retiredFile).equals(oldKey)).toBe(true);
    expect(readFileSync(ctx.keyFile).equals(oldKey)).toBe(false);
    expect(statSync(ctx.keyFile).mode & 0o777).toBe(0o600);
    expect(ctx.db.select().from(secrets).where(eq(secrets.name, "one")).get()?.ciphertext).not.toBe(before);
    expect(plaintextOf(ctx, "one")).toBe(value);
    expect(plaintextOf(ctx, "two")).toBe("another-secret-9876");
    // The old key opens nothing now.
    expect(() => new Vault(ctx.db, oldKey, ctx.keyFile)).toThrow(/does not open the vault/);
    expect(() => ctx.reopen()).not.toThrow();
    expect(readdirSync(join(ctx.keyFile, "..")).filter((f) => f.endsWith(".new"))).toEqual([]);
  });

  it("finishes a rotation that committed but did not rename, and drops one that never committed", () => {
    const ctx = setup();
    ctx.vault.store({ name: "one", kind: "bearer", value, scope });
    const oldKey = readFileSync(ctx.keyFile);
    // Never committed: a stray new-key file beside the old one is discarded.
    writeFileSync(`${ctx.keyFile}.new`, randomBytes(masterKeyBytes), { mode: 0o600 });
    ctx.reopen();
    expect(existsSync(`${ctx.keyFile}.new`)).toBe(false);
    expect(readFileSync(ctx.keyFile).equals(oldKey)).toBe(true);

    // Committed, old file still in place: simulate by rotating and then putting the pieces back.
    const result = ctx.vault.rotateMasterKey();
    const newKey = readFileSync(ctx.keyFile);
    renameSync(ctx.keyFile, `${ctx.keyFile}.new`);
    renameSync(result.retiredFile, ctx.keyFile);
    ctx.reopen();
    expect(readFileSync(ctx.keyFile).equals(newKey)).toBe(true);

    // Committed, old file already retired, new one not yet installed.
    renameSync(ctx.keyFile, `${ctx.keyFile}.new`);
    ctx.reopen();
    expect(readFileSync(ctx.keyFile).equals(newKey)).toBe(true);
    expect(plaintextOf(ctx, "one")).toBe(value);
  });
});

describe("errors", () => {
  it("are VaultErrors the HTTP layer can tell apart from bugs", () => {
    const { vault } = setup();
    expect(() => vault.store({ name: "x", kind: "bearer", value: "short", scope })).toThrow(VaultError);
  });
});
