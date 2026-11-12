import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, renameSync, unlinkSync } from "node:fs";
import { and, desc, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/index.js";
import { secrets } from "../db/schema.js";
import { aadFor, open, type Sealed, seal } from "./crypto.js";
import { loadMasterKey, masterKeyBytes, readKeyFile, writeKeyFile } from "./master-key.js";
import { normalizeScope, type SecretKind, type SecretScope, scopeHash, secretKinds, VaultError } from "./scope.js";

/** Short values cannot be scrubbed out of text without wrecking ordinary words, so they are not accepted. */
export const minSecretLength = 8;
const maxSecretLength = 8_192;
const namePattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const headerPattern = /^[A-Za-z0-9-]{1,64}$/;

/** What anything outside the vault may learn about a secret. There is deliberately no field for the value. */
export type SecretInfo = {
  /** The text the model writes in a header or body field to use it. */
  handle: string;
  name: string;
  kind: SecretKind;
  headerName: string | null;
  scope: SecretScope;
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  status: "active" | "expired" | "revoked";
};

export type StoreInput = {
  name: string;
  kind: SecretKind;
  value: string;
  scope: Partial<SecretScope> & { hosts: string[] };
  /** Required for `api_key`: the header the value is sent in. */
  headerName?: string;
  expiresAt?: Date;
};

/** The handle the model writes. Names are not secret. */
export const handleFor = (name: string) => `{{secret:${name}}}`;

type Row = typeof secrets.$inferSelect;

/** Recomputes the scope's hash from the stored scope text, so an edit to the scope in the database breaks decryption. */
export function aadOfRow(row: Row): Buffer {
  let hash: string;
  try {
    hash = scopeHash(JSON.parse(row.scope) as SecretScope);
  } catch {
    hash = "unreadable";
  }
  return aadFor({
    id: row.id,
    name: row.name,
    kind: row.kind,
    headerName: row.headerName,
    expiresAt: row.expiresAt,
    scopeHash: hash,
  });
}

/**
 * The vault's whole public surface, which hands out no value: `fetch` (P6.3) will use the stored values from inside
 * this directory and return only scrubbed responses. Nothing here, or anywhere else, returns a plaintext value.
 */
export class Vault {
  // Real private fields, not TypeScript's `private`: those are ordinary properties at run time, so util.inspect, a
  // logged error or (vault as any).key would hand out the master key's bytes.
  #key: Buffer;
  readonly #db: Db;
  readonly #keyFile: string;

  constructor(db: Db, key: Buffer, keyFile: string) {
    this.#db = db;
    this.#key = key;
    this.#keyFile = keyFile;
    this.#verifyKey();
  }

  /** A wrong key file would otherwise surface as a failure on first use, long after startup. */
  #verifyKey() {
    const row = firstLive(this.#db);
    if (!row) return;
    try {
      this.#reveal(row, this.#key);
    } catch {
      throw new VaultError(
        "The master key file does not open the vault. It is the wrong file, or the vault was re-keyed elsewhere.",
      );
    }
  }

  #reveal(row: Row, key: Buffer): string {
    return open(key, { nonce: row.nonce, ciphertext: row.ciphertext }, aadOfRow(row));
  }

  store(input: StoreInput, now = new Date()): SecretInfo {
    if (!namePattern.test(input.name)) {
      throw new VaultError(
        "A secret's name is lowercase letters, digits, hyphens and underscores, up to 64 characters.",
      );
    }
    if (!secretKinds.includes(input.kind)) throw new VaultError(`"${input.kind}" is not a kind of secret.`);
    if (input.value.length < minSecretLength) {
      throw new VaultError(
        `A secret must be at least ${minSecretLength} characters; shorter ones cannot be kept out of ordinary text.`,
      );
    }
    if (input.value.length > maxSecretLength) throw new VaultError("That secret is too long.");
    if (input.kind === "basic_auth" && !input.value.includes(":")) {
      throw new VaultError("A basic-auth secret is written username:password.");
    }
    if (input.kind === "api_key" && !headerPattern.test(input.headerName ?? "")) {
      throw new VaultError("An API key needs the name of the header it is sent in.");
    }
    if (input.kind !== "api_key" && input.headerName) throw new VaultError("Only an API key names a header.");
    if (input.expiresAt && input.expiresAt.getTime() <= now.getTime())
      throw new VaultError("That expiry is already past.");
    const live = this.#db
      .select()
      .from(secrets)
      .where(and(eq(secrets.name, input.name), isNull(secrets.revokedAt)))
      .get();
    if (live) {
      throw new VaultError(`A secret named "${input.name}" already exists; revoke it first to replace it.`);
    }
    const scope = normalizeScope(input.scope);
    const hash = scopeHash(scope);
    const id = randomUUID();
    const expiresAt = input.expiresAt?.toISOString() ?? null;
    const headerName = input.kind === "api_key" ? (input.headerName ?? null) : null;
    const sealed = seal(
      this.#key,
      input.value,
      aadFor({ id, name: input.name, kind: input.kind, headerName, expiresAt, scopeHash: hash }),
    );
    const row: Row = {
      id,
      name: input.name,
      kind: input.kind,
      headerName,
      scope: JSON.stringify(scope),
      scopeHash: hash,
      nonce: sealed.nonce,
      ciphertext: sealed.ciphertext,
      createdAt: now.toISOString(),
      expiresAt,
      lastUsedAt: null,
      revokedAt: null,
    };
    this.#db.insert(secrets).values(row).run();
    return info(row, now);
  }

  /** Metadata for one secret, found by name or by the handle text. Never the value. */
  describe(handleOrName: string, now = new Date()): SecretInfo | null {
    const row = byName(this.#db, handleOrName);
    return row ? info(row, now) : null;
  }

  /**
   * Without `viewer`, every secret with its status, for the vault screen. With one, only the active secrets that goal
   * or channel may use, so a run cannot learn the names of secrets it is not allowed.
   */
  list(viewer?: { goalId?: string; channelId?: string }, now = new Date()): SecretInfo[] {
    const all = this.#db
      .select()
      .from(secrets)
      .all()
      .map((row) => info(row, now));
    const shown = viewer
      ? all.filter(
          (s) =>
            s.status === "active" &&
            (s.scope.goals.length === 0 || (viewer.goalId !== undefined && s.scope.goals.includes(viewer.goalId))) &&
            (s.scope.channels.length === 0 ||
              (viewer.channelId !== undefined && s.scope.channels.includes(viewer.channelId))),
        )
      : all;
    return shown.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Revoking keeps the row, so history still names it, but the value is gone: a revoked secret cannot be used again. */
  revoke(handleOrName: string, now = new Date()): boolean {
    const row = byName(this.#db, handleOrName);
    if (!row || row.revokedAt) return false;
    // Overwrite the sealed value with a tombstone: revoke must mean the plaintext cannot come back from the database.
    this.#db
      .update(secrets)
      .set({ revokedAt: now.toISOString(), nonce: "", ciphertext: "" })
      .where(eq(secrets.id, row.id))
      .run();
    return true;
  }

  /**
   * Re-encrypts every value under a new key, then retires the old key file. The new key is written beside the old
   * first, so a crash between the database commit and the rename leaves a state `openVault` finishes on next start.
   */
  rotateMasterKey(now = new Date()): { rotated: number; retiredFile: string } {
    const next = randomBytes(masterKeyBytes);
    const pending = `${this.#keyFile}.new`;
    writeKeyFile(pending, next);
    let rotated = 0;
    this.#db.transaction((tx) => {
      for (const row of tx.select().from(secrets).all()) {
        if (row.revokedAt) continue;
        const sealed: Sealed = seal(next, this.#reveal(row, this.#key), aadOfRow(row));
        tx.update(secrets).set(sealed).where(eq(secrets.id, row.id)).run();
        rotated++;
      }
    });
    const retiredFile = `${this.#keyFile}.retired-${now.toISOString().replace(/[:.]/g, "-")}`;
    renameSync(this.#keyFile, retiredFile);
    renameSync(pending, this.#keyFile);
    this.#key = next;
    return { rotated, retiredFile };
  }
}

/** A revoked secret keeps no sealed value, so only a live row can say whether a key is the right one. */
const firstLive = (db: Db) => db.select().from(secrets).where(isNull(secrets.revokedAt)).limit(1).get();

/** The live secret by that name if there is one, else the latest revoked one, which history still names. */
const byName = (db: Db, handleOrName: string): Row | undefined =>
  db
    .select()
    .from(secrets)
    .where(eq(secrets.name, nameOf(handleOrName)))
    .orderBy(desc(secrets.createdAt))
    .all()
    .sort((a, b) => Number(a.revokedAt !== null) - Number(b.revokedAt !== null))[0];

const nameOf = (handleOrName: string) => handleOrName.replace(/^\{\{secret:(.*)\}\}$/, "$1");

function info(row: Row, now: Date): SecretInfo {
  const expired = row.expiresAt !== null && new Date(row.expiresAt).getTime() <= now.getTime();
  return {
    handle: handleFor(row.name),
    name: row.name,
    kind: row.kind as SecretKind,
    headerName: row.headerName,
    scope: JSON.parse(row.scope) as SecretScope,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
    status: row.revokedAt ? "revoked" : expired ? "expired" : "active",
  };
}

/**
 * Opens the vault with the key file at `keyFile` (BRINDLE_MASTER_KEY_FILE). It refuses to start on an unsafe, missing
 * or wrong key rather than carrying on without one.
 */
export function openVault(db: Db, options: { keyFile: string; dataDir: string }): Vault {
  const hasSecrets = firstLive(db) !== undefined;
  const pending = `${options.keyFile}.new`;
  if (existsSync(pending)) {
    if (!existsSync(options.keyFile)) {
      // A rotation crashed between retiring the old file and installing the new one; its database change had committed.
      renameSync(pending, options.keyFile);
    } else {
      // Both files exist: either the rotation committed but did not finish renaming, or it never committed.
      const row = firstLive(db);
      let committed = false;
      if (row) {
        try {
          open(readKeyFile(pending), { nonce: row.nonce, ciphertext: row.ciphertext }, aadOfRow(row));
          committed = true;
        } catch {
          // The old key is still the right one.
        }
      }
      if (committed) renameSync(pending, options.keyFile);
      else unlinkSync(pending);
    }
  }
  const key = loadMasterKey({ path: options.keyFile, dataDir: options.dataDir, hasSecrets });
  return new Vault(db, key, options.keyFile);
}
