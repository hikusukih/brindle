import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { type BetterSQLite3Database, drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "./schema.js";

export type Db = BetterSQLite3Database<typeof schema>;

// The same relative path holds from src/server/db and from dist/server/db.
export const defaultMigrationsFolder = fileURLToPath(new URL("../../../drizzle", import.meta.url));

export function openDatabase(filename: string, migrationsFolder = defaultMigrationsFolder): Db {
  const sqlite = new Database(filename);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder });
  return db;
}
