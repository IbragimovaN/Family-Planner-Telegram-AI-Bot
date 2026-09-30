import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export function openDatabase(path: string, mustExist = false): Database.Database {
  if (!mustExist && path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path, { fileMustExist: mustExist, timeout: 5000 });
  try {
    db.pragma("foreign_keys = ON");
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
