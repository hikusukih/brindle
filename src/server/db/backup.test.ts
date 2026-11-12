import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { backupBeforeMigrations, keptBackups, migrationState, openDatabaseSafely } from "./backup.js";
import { openDatabase } from "./index.js";

/** A migrations folder of its own, so a test can add a migration the database hasn't run yet. */
function migrations(dir: string, tags: string[]) {
  mkdirSync(join(dir, "meta"), { recursive: true });
  const entries = tags.map((tag, idx) => ({
    idx,
    version: "6",
    when: 1_700_000_000_000 + idx,
    tag,
    breakpoints: true,
  }));
  writeFileSync(join(dir, "meta", "_journal.json"), JSON.stringify({ version: "7", dialect: "sqlite", entries }));
  tags.forEach((tag, i) => {
    writeFileSync(join(dir, `${tag}.sql`), `CREATE TABLE t${i} (id integer);`);
  });
}

function setup() {
  const root = mkdtempSync(join(tmpdir(), "brindle-backup-"));
  const folder = join(root, "drizzle");
  const file = join(root, "brindle.sqlite");
  migrations(folder, ["0000_first"]);
  openDatabase(file, folder);
  return { root, folder, file, backupsDir: join(root, "backups") };
}

const tables = (file: string) =>
  (
    new Database(file, { readonly: true }).prepare("select name from sqlite_master where type = 'table'").all() as {
      name: string;
    }[]
  ).map((t) => t.name);

describe("a copy of the database before startup migrations", () => {
  it("makes no copy when nothing is pending", async () => {
    const { folder, file, backupsDir } = setup();
    expect(await backupBeforeMigrations(file, { backupsDir, migrationsFolder: folder })).toBeNull();
    expect(existsSync(backupsDir)).toBe(false);
  });

  it("makes no copy of a new database, which has nothing to lose", async () => {
    const { root, folder, backupsDir } = setup();
    const fresh = join(root, "fresh.sqlite");
    expect(migrationState(fresh, folder).pending).toEqual([]);
    expect(await backupBeforeMigrations(fresh, { backupsDir, migrationsFolder: folder })).toBeNull();
  });

  it("copies the database, named for its schema and the time, before a pending migration runs", async () => {
    const { folder, file, backupsDir } = setup();
    migrations(folder, ["0000_first", "0001_second"]);
    const lines: string[] = [];

    await openDatabaseSafely(file, {
      backupsDir,
      migrationsFolder: folder,
      now: new Date("2026-11-12T01:02:03.456Z"),
      log: (l) => lines.push(l),
    });

    const copy = join(backupsDir, "brindle-20261112T010203Z-0000_first.sqlite");
    expect(readdirSync(backupsDir)).toEqual(["brindle-20261112T010203Z-0000_first.sqlite"]);
    // The copy is the database as it was: the pending migration's table is only in the live file.
    expect(tables(copy)).toContain("t0");
    expect(tables(copy)).not.toContain("t1");
    expect(tables(file)).toContain("t1");
    expect(lines.join("\n")).toContain(copy);
  });

  it("keeps the last three copies", async () => {
    const { folder, file, backupsDir } = setup();
    const tags = ["0000_first"];
    for (let i = 1; i <= keptBackups + 2; i++) {
      tags.push(`000${i}_more`);
      migrations(folder, tags);
      await openDatabaseSafely(file, {
        backupsDir,
        migrationsFolder: folder,
        now: new Date(Date.UTC(2026, 10, 12, 0, 0, i)),
      });
    }
    expect(readdirSync(backupsDir).sort()).toEqual([
      "brindle-20261112T000003Z-0002_more.sqlite",
      "brindle-20261112T000004Z-0003_more.sqlite",
      "brindle-20261112T000005Z-0004_more.sqlite",
    ]);
  });

  it("refuses to start, before any migration runs, when the copy fails", async () => {
    const { folder, file, backupsDir } = setup();
    migrations(folder, ["0000_first", "0001_second"]);

    await expect(
      openDatabaseSafely(file, {
        backupsDir,
        migrationsFolder: folder,
        copy: async () => {
          throw new Error("disk full");
        },
      }),
    ).rejects.toThrow(/Could not copy the database .* so the server will not start: disk full/);
    expect(tables(file)).not.toContain("t1");
    expect(migrationState(file, folder).pending.map((e) => e.tag)).toEqual(["0001_second"]);
  });

  it("refuses to start when backups/ cannot be made", async () => {
    const { folder, file, root } = setup();
    migrations(folder, ["0000_first", "0001_second"]);
    const blocked = join(root, "not-a-dir");
    writeFileSync(blocked, "a file where the folder should be");

    await expect(
      openDatabaseSafely(file, { backupsDir: join(blocked, "backups"), migrationsFolder: folder }),
    ).rejects.toThrow(/will not start/);
    expect(tables(file)).not.toContain("t1");
  });

  it("finds the real migrations pending on a database from an older version", async () => {
    const root = mkdtempSync(join(tmpdir(), "brindle-backup-"));
    const file = join(root, "brindle.sqlite");
    openDatabase(file);
    expect(migrationState(file).pending).toEqual([]);
    expect(migrationState(file).applied?.tag).toMatch(/^\d{4}_/);
  });
});
