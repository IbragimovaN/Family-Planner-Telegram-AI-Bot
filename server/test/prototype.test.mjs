import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { openDatabase } from "../dist/db/connection.js";
import { migrate } from "../dist/db/migrations.js";

test("prototype API uses fresh storage and retains tasks after process restart", { timeout: 15000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "family-planner-api-"));
  const databasePath = join(root, "test.db");
  const db = openDatabase(databasePath);
  try { migrate(db); } finally { db.close(); }
  const reservation = createServer();
  reservation.listen(0, "127.0.0.1");
  await once(reservation, "listening");
  const port = reservation.address().port;
  await new Promise((resolveClose, reject) => reservation.close(error => error ? reject(error) : resolveClose()));
  const base = `http://127.0.0.1:${port}`;
  let child;
  let cookie;
  const headers = { "Content-Type": "application/json", "X-Family-Planner": "1", Origin: base };
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }
  async function start() {
    child = spawn(process.execPath, [fileURLToPath(new URL("../dist/index.js", import.meta.url))], {
      env: { ...process.env, PORT: String(port), DATABASE_PATH: databasePath, OPENAI_API_KEY: "test-no-network", NODE_ENV: "development", DEV_AUTH_ENABLED: "true", APP_ORIGIN: base },
      stdio: "ignore",
    });
    for (let attempt = 0; attempt < 80; attempt++) {
      if (child.exitCode !== null) throw new Error("Test server exited before becoming ready");
      try {
        const response = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(500) });
        if (response.ok) return;
      } catch { /* Wait for this test's process to listen. */ }
      await delay(50);
    }
    throw new Error("Test server did not become ready");
  }
  try {
    await start();
    const login = await fetch(`${base}/api/auth/dev`, { method: "POST", headers, body: "{}" });
    assert.equal(login.status, 204);
    cookie = login.headers.get("set-cookie").split(";")[0];
    assert.deepEqual(await (await fetch(`${base}/api/tasks`, { headers: { Cookie: cookie } })).json(), []);
    const created = await fetch(`${base}/api/tasks`, {
      method: "POST", headers: { ...headers, Cookie: cookie }, body: JSON.stringify({ title: "Test task" }),
    });
    assert.equal(created.status, 201);
    const task = await created.json();
    const toggled = await fetch(`${base}/api/tasks/${task.id}/toggle`, { method: "PATCH", headers: { ...headers, Cookie: cookie }, body: "{}" });
    assert.equal((await toggled.json()).completed, true);
    await stop();
    await start();
    assert.deepEqual(await (await fetch(`${base}/api/tasks`, { headers: { Cookie: cookie } })).json(), [{ ...task, completed: true }]);
    const read = openDatabase(databasePath, true);
    try { assert.equal(read.prepare("SELECT count(*) AS count FROM tasks").get().count, 0); }
    finally { read.close(); }
  } finally {
    await stop();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep));
    rmSync(root, { recursive: true, force: true });
  }
});
