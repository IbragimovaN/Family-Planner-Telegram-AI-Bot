import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { migrations } from "./schema.js";

export type Migration = { version: number; name: string; sql: string };
type Applied = { version: number; name: string; checksum: string };
const checksum = (sql: string) => createHash("sha256").update(sql).digest("hex");

export function pendingMigrations(db: Database.Database, definitions: Migration[] = migrations): Migration[] {
  definitions.forEach((migration, index) => {
    if (migration.version !== index + 1) throw new Error("Migration versions must be consecutive, starting at 1.");
  });
  const hasHistory = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  if (!hasHistory) {
    const existing = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    if (existing.length) throw new Error("Unversioned database: use db:init with a NEW DATABASE_PATH. Existing data will not be overwritten.");
    return definitions;
  }
  const applied = db.prepare("SELECT version, name, checksum FROM schema_migrations ORDER BY version").all() as Applied[];
  applied.forEach((row, index) => {
    const expected = definitions[index];
    if (!expected || row.version !== expected.version || row.name !== expected.name || row.checksum !== checksum(expected.sql)) {
      throw new Error("Unknown or modified migration history. Restore the matching code/schema before continuing.");
    }
  });
  return definitions.slice(applied.length);
}

export function migrate(db: Database.Database, definitions: Migration[] = migrations): number {
  return db.transaction(() => {
    const pending = pendingMigrations(db, definitions);
    db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, checksum TEXT NOT NULL,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch())
    ) STRICT`);
    const record = db.prepare("INSERT INTO schema_migrations (version, name, checksum) VALUES (?, ?, ?)");
    for (const migration of pending) {
      db.exec(migration.sql);
      record.run(migration.version, migration.name, checksum(migration.sql));
    }
    const violations = db.pragma("foreign_key_check");
    if (!Array.isArray(violations) || violations.length) throw new Error("Foreign key check failed; migrations rolled back.");
    return pending.length;
  }).immediate();
}

export function assertCurrentSchema(db: Database.Database): void {
  if (pendingMigrations(db).length) throw new Error("Database migrations required. Run npm run db:migrate --prefix server.");
}
