import Database from "better-sqlite3";
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { backupDirectory, databasePath, legacyDatabasePath } from "./config.js";
import { openDatabase } from "./connection.js";
import { migrate, pendingMigrations } from "./migrations.js";
import { backupDatabase } from "./backup.js";

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!["init", "migrate", "backup"].includes(command) || (command !== "init" && args.length) || args.length > 1) {
    throw new Error("Usage: db:init [legacy-database-path] | db:migrate | db:backup");
  }
  if (command === "init") {
    if (existsSync(databasePath)) throw new Error("Target already exists. db:init never overwrites data; use db:migrate or choose a NEW DATABASE_PATH.");
    const legacyPath = args[0] ? resolve(args[0]) : legacyDatabasePath;
    if (existsSync(legacyPath)) {
      const old = new Database(legacyPath, { readonly: true, fileMustExist: true });
      try {
        console.log(`Legacy backup: ${await backupDatabase(old, backupDirectory)}`);
      } finally {
        old.close();
      }
    } else if (args[0]) {
      throw new Error("Explicit legacy database path does not exist.");
    }
    // Exclusive creation protects against concurrent init. Never truncate a database.
    mkdirSync(dirname(databasePath), { recursive: true });
    closeSync(openSync(databasePath, "wx"));
  }
  if (!existsSync(databasePath)) throw new Error("Database does not exist. Run db:init first (backs up the legacy database when present).");
  const db = openDatabase(databasePath, true);
  try {
    if (command === "backup") {
      console.log(`Backup: ${await backupDatabase(db, backupDirectory)}`);
      return;
    }
    const pending = pendingMigrations(db);
    if (command === "migrate" && pending.length) {
      console.log(`Pre-migration backup: ${await backupDatabase(db, backupDirectory)}`);
    }
    console.log(`Applied migrations: ${migrate(db)}. Database: ${databasePath}`);
  } finally {
    db.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Database command failed.");
  process.exitCode = 1;
});
