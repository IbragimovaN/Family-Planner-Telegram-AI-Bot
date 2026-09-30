import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export async function backupDatabase(source: Database.Database, directory: string): Promise<string> {
  mkdirSync(directory, { recursive: true });
  const destination = join(directory, `backup-${Date.now()}-${randomUUID()}.db`);
  // SQLite backup API includes committed WAL pages; copying only .db does not.
  await source.backup(destination);
  const copy = new Database(destination, { readonly: true });
  try {
    if (copy.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("Backup integrity check failed.");
  } finally {
    copy.close();
  }
  return destination;
}
