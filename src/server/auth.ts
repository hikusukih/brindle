import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import type { MiddlewareHandler } from "hono";
import type { Db } from "./db/index.js";
import { appMeta } from "./db/schema.js";

const metaKey = "auth_token_sha256";
const minLength = 16;

const digest = (token: string) => createHash("sha256").update(token).digest();

/**
 * Both sides are hashed first so the comparison is over equal-length buffers: timingSafeEqual needs
 * that, and it keeps the token's length from leaking through the comparison.
 */
export function tokenMatches(expected: Buffer, given: string): boolean {
  return timingSafeEqual(expected, digest(given));
}

/**
 * The token comes from BRINDLE_TOKEN, or is generated at first start and returned once so the
 * caller can print it. Only its hash is stored, so a later start cannot show it again; set
 * BRINDLE_TOKEN to choose a new one.
 */
export function resolveToken(db: Db, env: Record<string, string | undefined>): { hash: Buffer; generated?: string } {
  const fromEnv = env.BRINDLE_TOKEN?.trim();
  if (fromEnv) {
    if (fromEnv.length < minLength) throw new Error(`BRINDLE_TOKEN must be at least ${minLength} characters.`);
    return { hash: digest(fromEnv) };
  }
  const row = db.select().from(appMeta).where(eq(appMeta.key, metaKey)).get();
  if (row) return { hash: Buffer.from(row.value, "hex") };
  const generated = randomBytes(24).toString("base64url");
  const hash = digest(generated);
  db.insert(appMeta)
    .values({ key: metaKey, value: hash.toString("hex") })
    .run();
  return { hash, generated };
}

/** Every /api route but the health check needs `Authorization: Bearer <token>`. A header, never a cookie, so a hostile page cannot ride the browser's state. */
export function requireToken(hash: Buffer): MiddlewareHandler {
  return async (c, next) => {
    if (c.req.path === "/api/health") return next();
    const given = /^Bearer (.+)$/.exec(c.req.header("authorization") ?? "")?.[1];
    if (!given || !tokenMatches(hash, given)) {
      return c.json({ error: "unauthorized", message: "A login token is needed." }, 401, {
        "www-authenticate": "Bearer",
      });
    }
    return next();
  };
}
