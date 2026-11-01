import { eq } from "drizzle-orm";
import type { Db } from "./db/index.js";
import { appMeta } from "./db/schema.js";

// Small settings the user changes in the app; the app_meta table already holds one-off values like these.
export function getSetting(db: Db, key: string): string | null {
  return db.select().from(appMeta).where(eq(appMeta.key, key)).get()?.value ?? null;
}

export function setSetting(db: Db, key: string, value: string) {
  db.insert(appMeta).values({ key, value }).onConflictDoUpdate({ target: appMeta.key, set: { value } }).run();
}
