import { databasePath } from "./db/config.js";
import { openDatabase } from "./db/connection.js";
import { assertCurrentSchema } from "./db/migrations.js";

const database = openDatabase(databasePath, true);
try {
  assertCurrentSchema(database);
} catch (error) {
  database.close();
  throw error;
}

export default database;
