import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { type Db, defaultMigrationsFolder, openDatabase } from "./index.js";

/** How many copies backups/ keeps; the oldest beyond this are deleted after a new one is written. */
export const keptBackups = 3;

type JournalEntry = { idx: number; when: number; tag: string };

function journal(migrationsFolder: string): JournalEntry[] {
  const file = join(migrationsFolder, "meta", "_journal.json");
  return (JSON.parse(readFileSync(file, "utf8")) as { entries: JournalEntry[] }).entries;
}

/**
 * The migration the database is at and the ones still to run. A database with no migrations applied yet (a new file)
 * has nothing to lose, so it reports nothing pending to copy for.
 */
export function migrationState(filename: string, migrationsFolder = defaultMigrationsFolder) {
  const entries = journal(migrationsFolder);
  if (!existsSync(filename)) return { applied: null, pending: [] as JournalEntry[] };
  const sqlite = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    const table = sqlite
      .prepare("select name from sqlite_master where type = 'table' and name = '__drizzle_migrations'")
      .get();
    const last = table
      ? (sqlite.prepare("select max(created_at) as at from __drizzle_migrations").get() as { at: number | null }).at
      : null;
    if (last === null) return { applied: null, pending: [] as JournalEntry[] };
    // The migrator itself runs every journal entry newer than the last one it recorded, so the same test is used here.
    const applied = [...entries].reverse().find((e) => e.when <= Number(last)) ?? null;
    return { applied, pending: entries.filter((e) => e.when > Number(last)) };
  } finally {
    sqlite.close();
  }
}

const stamp = (now: Date) =>
  now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");

/** Copies are named brindle-<time>-<schema>.sqlite, so sorting the names sorts them by age. */
const backupName = /^brindle-\d{8}T\d{6}Z-.+\.sqlite$/;

export type BackupOptions = {
  backupsDir: string;
  migrationsFolder?: string;
  now?: Date;
  /** The copy itself; tests replace it to make it fail. Defaults to SQLite's online backup. */
  copy?: (source: string, destination: string) => Promise<void>;
  log?: (line: string) => void;
};

async function onlineBackup(source: string, destination: string) {
  const sqlite = new Database(source, { fileMustExist: true });
  try {
    await sqlite.backup(destination);
  } finally {
    sqlite.close();
  }
}

/**
 * Before startup migrations change the only copy of the user's data in place, writes a copy to backups/ and keeps the
 * last three (docs/decisions.md). Returns the copy's path, or null when nothing is pending. Throws if the copy fails;
 * the caller must not migrate then.
 */
export async function backupBeforeMigrations(filename: string, options: BackupOptions): Promise<string | null> {
  const { applied, pending } = migrationState(filename, options.migrationsFolder);
  if (!applied || !pending.length) return null;
  const destination = join(options.backupsDir, `brindle-${stamp(options.now ?? new Date())}-${applied.tag}.sqlite`);
  try {
    mkdirSync(options.backupsDir, { recursive: true });
    await (options.copy ?? onlineBackup)(filename, destination);
  } catch (error) {
    // A half-written copy must not count as one of the three kept.
    try {
      rmSync(destination, { force: true });
    } catch {
      // Nothing was written where there is no folder.
    }
    throw new Error(
      `Could not copy the database to ${destination} before ${pending.length} pending migration(s), so the server will not start: ${(error as Error).message}`,
    );
  }
  const copies = readdirSync(options.backupsDir)
    .filter((name) => backupName.test(name))
    .sort();
  for (const old of copies.slice(0, Math.max(0, copies.length - keptBackups)))
    rmSync(join(options.backupsDir, old), { force: true });
  options.log?.(`Copied the database to ${destination} before migrating from ${applied.tag}.`);
  return destination;
}

/** Startup's way to open the database: the copy first when migrations are pending, then the migrations. */
export async function openDatabaseSafely(filename: string, options: BackupOptions): Promise<Db> {
  await backupBeforeMigrations(filename, options);
  return openDatabase(filename, options.migrationsFolder);
}
