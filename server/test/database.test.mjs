import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { openDatabase } from "../dist/db/connection.js";
import { migrate, pendingMigrations, assertCurrentSchema } from "../dist/db/migrations.js";
import { migrations } from "../dist/db/schema.js";
import { backupDatabase } from "../dist/db/backup.js";

function temporary(t) {
  const root = mkdtempSync(join(tmpdir(), "family-planner-test-"));
  t.after(() => {
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

function memory(t) {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  migrate(db);
  return db;
}

function seed(db) {
  db.exec(`
    INSERT INTO users (id, telegram_id, first_name) VALUES ('u1', '1001', 'One'), ('u2', '1002', 'Two'), ('u3', '1003', 'Three');
    INSERT INTO families (id, name) VALUES ('f1', 'First'), ('f2', 'Second');
    INSERT INTO family_members (family_id, user_id, role) VALUES ('f1', 'u1', 'owner'), ('f2', 'u2', 'owner');
  `);
}

test("empty schema contains all MVP tables; migration repeat preserves records", (t) => {
  const db = memory(t);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  for (const table of ["users", "families", "family_members", "invitations", "sessions", "shopping_lists", "shopping_items", "tasks", "wishlist_profiles", "wishlist_items", "notification_deliveries"]) {
    assert.ok(tables.includes(table), table);
    assert.equal(db.prepare(`SELECT count(*) AS count FROM ${table}`).get().count, 0);
  }
  seed(db);
  assert.equal(migrate(db), 0);
  assert.equal(db.prepare("SELECT count(*) AS count FROM users").get().count, 3);
  assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
  assertCurrentSchema(db);
});

test("auth migration preserves version-1 data without assigning old tasks to a user", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  migrate(db, [migrations[0]]);
  db.exec("INSERT INTO prototype_tasks (id,title) VALUES ('old','Unassigned')");
  const checksum = db.prepare("SELECT checksum FROM schema_migrations WHERE version=1").get().checksum;
  assert.equal(migrate(db), migrations.length - 1);
  assert.deepEqual(db.prepare("SELECT title,owner_user_id FROM prototype_tasks").get(), { title: "Unassigned", owner_user_id: null });
  assert.equal(db.prepare("SELECT checksum FROM schema_migrations WHERE version=1").get().checksum, checksum);
});

test("pending schema cannot be used by application and failed migrations roll back", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  assert.throws(() => assertCurrentSchema(db), /migrations required/);
  const broken = [...migrations, { version: migrations.length + 1, name: "broken", sql: "CREATE TABLE partial(id TEXT); INSERT INTO missing VALUES (1);" }];
  assert.throws(() => migrate(db, broken), /missing/);
  assert.deepEqual(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all(), []);
  assert.equal(migrate(db), migrations.length);
  assert.throws(() => migrate(db, broken), /missing/);
  assert.equal(db.prepare("SELECT count(*) AS count FROM schema_migrations").get().count, migrations.length);
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='partial'").get(), undefined);
});

test("unversioned database and changed or future migration history are rejected", (t) => {
  const db = memory(t);
  assert.throws(() => pendingMigrations(db, [{ ...migrations[0], sql: migrations[0].sql + "\n" }]), /history/);
  assert.throws(() => pendingMigrations(db, []), /history/);
  const old = openDatabase(":memory:");
  try {
    old.exec("CREATE TABLE tasks (id TEXT); INSERT INTO tasks VALUES ('keep');");
    assert.throws(() => migrate(old), /Unversioned/);
    assert.equal(old.prepare("SELECT id FROM tasks").get().id, "keep");
  } finally { old.close(); }
});

test("membership, owner, open-list uniqueness and cross-family children are constrained", (t) => {
  const db = memory(t);
  seed(db);
  assert.throws(() => db.exec("INSERT INTO family_members VALUES ('f2','u1','member',0)"), /UNIQUE/);
  assert.throws(() => db.exec("INSERT INTO family_members VALUES ('f1','u3','owner',0)"), /UNIQUE/);
  db.exec("INSERT INTO shopping_lists (id,family_id) VALUES ('list','f1')");
  assert.throws(() => db.exec("INSERT INTO shopping_lists (id,family_id) VALUES ('other','f1')"), /UNIQUE/);
  assert.throws(() => db.exec("INSERT INTO shopping_items (id,family_id,list_id,title,created_by_user_id) VALUES ('item','f2','list','Milk','u2')"), /FOREIGN KEY/);
  db.exec("INSERT INTO wishlist_profiles (id,family_id,name,created_by_user_id) VALUES ('profile','f1','Friend','u1')");
  assert.throws(() => db.exec("INSERT INTO wishlist_items (id,family_id,profile_id,title,created_by_user_id,updated_by_user_id) VALUES ('wish','f2','profile','Book','u2','u2')"), /FOREIGN KEY/);
  db.exec("INSERT INTO wishlist_items (id,family_id,profile_id,title,created_by_user_id,updated_by_user_id) VALUES ('wish','f1','profile','Book','u1','u1')");
  db.exec("DELETE FROM wishlist_profiles WHERE id='profile'");
  assert.equal(db.prepare("SELECT count(*) AS count FROM wishlist_items").get().count, 0);
});

test("task periods, dates, completion history and manual rescheduling are represented safely", (t) => {
  const db = memory(t);
  seed(db);
  const insert = db.prepare(`INSERT INTO tasks
    (id,family_id,owner_user_id,created_by_user_id,title,period_type,planned_date,planned_time,original_period_type,original_planned_date)
    VALUES (?,'f1','u1','u1','Task',?,?,?, ?,?)`);
  insert.run("task", "date", "2026-09-28", "14:30", "date", "2026-09-28");
  assert.throws(() => insert.run("bad", "date", "2026-02-30", null, "date", "2026-02-28"), /CHECK/);
  assert.throws(() => insert.run("bad", "week", "2026-09-30", null, "week", "2026-09-28"), /CHECK/);
  assert.throws(() => insert.run("bad", "month", "2026-09-02", null, "month", "2026-09-01"), /CHECK/);
  assert.throws(() => insert.run("bad", "date", "2026-09-28", "25:99", "date", "2026-09-28"), /CHECK/);
  assert.throws(() => insert.run("bad", "date", "2026-09-28", "24:00", "date", "2026-09-28"), /CHECK/);
  insert.run("week", "week", "2026-09-28", null, "week", "2026-09-28");
  insert.run("month", "month", "2026-09-01", null, "month", "2026-09-01");
  db.exec("UPDATE tasks SET planned_date='2026-10-01' WHERE id='task'");
  assert.equal(db.prepare("SELECT original_planned_date FROM tasks WHERE id='task'").get().original_planned_date, "2026-09-28");
  assert.throws(() => db.exec("UPDATE tasks SET completed=1 WHERE id='task'"), /CHECK/);
  db.exec("UPDATE tasks SET completed=1,completed_at=1790812800 WHERE id='task'");
  assert.equal(db.prepare("SELECT completed_at FROM tasks WHERE id='task'").get().completed_at, 1790812800);
});

test("notification deduplication distinguishes event, recipient and kind", (t) => {
  const db = memory(t);
  seed(db);
  const insert = db.prepare("INSERT INTO notification_deliveries (id,family_id,user_id,kind,deduplication_key) VALUES (?,'f1',?,?,?)");
  insert.run("n1", "u1", "morning_summary", "2026-09-30");
  assert.throws(() => insert.run("n2", "u1", "morning_summary", "2026-09-30"), /UNIQUE/);
  insert.run("n3", "u1", "morning_summary", "2026-10-01");
  insert.run("n4", "u3", "morning_summary", "2026-09-30");
  assert.throws(() => insert.run("n5", "u1", "overdue", "2026-09-30"), /CHECK/);
});

test("WAL backup restores committed data and database survives reconnect", async (t) => {
  const root = temporary(t);
  const path = join(root, "source.db");
  const db = openDatabase(path);
  let backup;
  try {
    migrate(db);
    db.pragma("wal_autocheckpoint = 0");
    seed(db);
    assert.ok(existsSync(path + "-wal"));
    backup = await backupDatabase(db, join(root, "backups"));
    const restored = openDatabase(backup, true);
    try {
      assertCurrentSchema(restored);
      assert.equal(restored.prepare("SELECT count(*) AS count FROM users").get().count, 3);
      assert.equal(restored.pragma("integrity_check", { simple: true }), "ok");
    } finally { restored.close(); }
  } finally { db.close(); }
  const reopened = openDatabase(path, true);
  try {
    assert.equal(migrate(reopened), 0);
    assert.equal(reopened.prepare("SELECT count(*) AS count FROM users").get().count, 3);
  } finally { reopened.close(); }
});

test("CLI init backs up legacy WAL, starts empty, refuses overwrite and repeat migrate is safe", (t) => {
  const root = temporary(t);
  const oldPath = join(root, "old.db");
  const newPath = join(root, "new.db");
  const old = openDatabase(oldPath);
  old.exec("CREATE TABLE tasks (id TEXT); INSERT INTO tasks VALUES ('legacy');");
  const cli = fileURLToPath(new URL("../dist/db/cli.js", import.meta.url));
  const env = { ...process.env, DATABASE_PATH: newPath, DATABASE_BACKUP_DIR: join(root, "backups") };
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8" });
  try {
    const first = run("init", oldPath);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(run("init", oldPath).status, 1);
    assert.equal(run("migrate").status, 0);
    assert.equal(old.prepare("SELECT id FROM tasks").get().id, "legacy");
    const backup = new Database(join(root, "backups", readdirSync(join(root, "backups"))[0]), { readonly: true });
    try { assert.equal(backup.prepare("SELECT id FROM tasks").get().id, "legacy"); }
    finally { backup.close(); }
    const fresh = openDatabase(newPath, true);
    try {
      assert.equal(fresh.prepare("SELECT count(*) AS count FROM tasks").get().count, 0);
      assert.equal(fresh.prepare("SELECT count(*) AS count FROM prototype_tasks").get().count, 0);
      fresh.exec("INSERT INTO prototype_tasks (id,title) VALUES ('new','Keep')");
    } finally { fresh.close(); }
    assert.equal(run("migrate").status, 0);
    const after = openDatabase(newPath, true);
    try { assert.equal(after.prepare("SELECT title FROM prototype_tasks").get().title, "Keep"); }
    finally { after.close(); }
  } finally { old.close(); }
});
