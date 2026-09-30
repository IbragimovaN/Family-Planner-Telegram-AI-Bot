import { config } from "dotenv";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const serverDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
config({ path: resolve(serverDirectory, ".env"), quiet: true });

// Relative paths always resolve from server/, regardless of the caller's cwd.
export const databasePath = resolve(serverDirectory, process.env.DATABASE_PATH || "data/family-planner-v2.db");
export const backupDirectory = resolve(serverDirectory, process.env.DATABASE_BACKUP_DIR || "data/backups");
export const legacyDatabasePath = resolve(serverDirectory, "data/family-planner.db");
