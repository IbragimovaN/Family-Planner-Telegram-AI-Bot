import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash, createHmac } from "node:crypto";
import { once } from "node:events";
import { openDatabase } from "../dist/db/connection.js";
import { migrate } from "../dist/db/migrations.js";
import { createApp } from "../dist/app.js";
import { readAuthConfig } from "../dist/auth/config.js";
import { validateInitData } from "../dist/auth/telegram.js";

const botToken = "123456:test-only-not-a-real-token";
const origin = "https://planner.example.test";
const now = () => Math.floor(Date.now() / 1000);
function signed(user = { id: 1234, first_name: "Анна & София" }, extra = {}) {
  const fields = { user: JSON.stringify(user), auth_date: String(now()), query_id: "test-query", ...extra };
  const data = Object.keys(fields).sort().map(key => `${key}=${fields[key]}`).join("\n");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const hash = createHmac("sha256", secret).update(data).digest("hex");
  return new URLSearchParams({ ...fields, hash }).toString();
}

async function fixture(t, env = {}) {
  const db = openDatabase(":memory:");
  migrate(db);
  const config = readAuthConfig({ NODE_ENV: "production", APP_ORIGIN: origin, TELEGRAM_BOT_TOKEN: botToken, ...env });
  const server = createApp(db, config).listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    db.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  function request(path, { cookie, body, method = body === undefined ? "GET" : "POST", headers = {} } = {}) {
    return fetch(base + path, { method, headers: {
      "Content-Type": "application/json", "X-Family-Planner": "1", Origin: config.origin,
      ...(cookie ? { Cookie: cookie } : {}), ...headers,
    }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function login(user, cookie) {
    const response = await request("/api/auth/telegram", { body: { initData: signed(user) }, cookie });
    assert.equal(response.status, 204);
    return { response, cookie: response.headers.get("set-cookie").split(";")[0] };
  }
  return { db, config, request, login };
}

test("Telegram validation checks raw signed fields including signature, freshness and user identity", () => {
  assert.equal(validateInitData(signed(undefined, { signature: "signed-extra-field" }), botToken, 300).id, 1234);
  assert.throws(() => validateInitData(signed() + "&user=%7B%7D", botToken, 300));
  assert.throws(() => validateInitData(signed().replace("test-query", "tampered"), botToken, 300));
  assert.throws(() => validateInitData(signed(), "wrong-token", 300));
  assert.throws(() => validateInitData(signed(undefined, { auth_date: String(now() - 301) }), botToken, 300));
  assert.throws(() => validateInitData(signed(undefined, { auth_date: String(now() + 90) }), botToken, 300));
  assert.throws(() => validateInitData(signed({ id: "1234", first_name: "Invalid" }), botToken, 300));
  assert.throws(() => validateInitData(signed({ id: -1, first_name: "Invalid" }), botToken, 300));
  assert.throws(() => validateInitData(signed({ id: 1234, first_name: "Bot", is_bot: true }), botToken, 300));
});

test("all protected APIs reject anonymous access; invalid logins never create users", async (t) => {
  const { db, request } = await fixture(t);
  for (const path of ["/api/me", "/api/tasks", "/api/future-route"]) assert.equal((await request(path)).status, 401);
  for (const path of ["/api/tasks", "/api/ai/tasks", "/api/auth/logout"]) assert.equal((await request(path, { body: {} })).status, 401);
  assert.equal((await request("/api/health")).status, 200);
  assert.equal((await request("/api/auth/telegram", { body: { initData: "forged" } })).status, 401);
  assert.equal((await request("/api/auth/telegram", { body: { initData: signed(undefined, { auth_date: String(now() - 301) }) } })).status, 401);
  assert.equal((await request("/api/auth/telegram", { body: { initData: signed().replace("test-query", "tampered") } })).status, 401);
  assert.equal((await request("/api/auth/telegram", { body: { user: { id: 1 } } })).status, 400);
  assert.equal(db.prepare("SELECT count(*) AS count FROM users").get().count, 0);
});

test("valid login upserts user, hashes random session, rotates cookie and provides profile", async (t) => {
  const { db, request, login } = await fixture(t);
  const first = await login();
  const cookieHeader = first.response.headers.get("set-cookie");
  for (const flag of ["HttpOnly", "Secure", "SameSite=None", "Path=/", "Max-Age=604800"]) assert.ok(cookieHeader.includes(flag), flag);
  assert.ok(first.cookie.startsWith("__Host-family_session="));
  const profile = await (await request("/api/me", { cookie: first.cookie })).json();
  assert.equal(profile.user.firstName, "Анна & София");
  assert.equal(profile.authMethod, "telegram");
  const token = first.cookie.split("=")[1];
  const row = db.prepare("SELECT token_hash FROM sessions").get();
  assert.notEqual(row.token_hash, token);
  assert.equal(row.token_hash, createHash("sha256").update(token).digest("hex"));
  const second = await login({ id: 1234, first_name: "Новое имя" }, first.cookie);
  assert.notEqual(first.cookie, second.cookie);
  assert.equal(db.prepare("SELECT count(*) AS count FROM users").get().count, 1);
  assert.equal(db.prepare("SELECT count(*) AS count FROM sessions").get().count, 1);
  assert.equal((await request("/api/me", { cookie: first.cookie })).status, 401);
  assert.equal((await (await request("/api/me", { cookie: second.cookie })).json()).user.firstName, "Новое имя");
});

test("logout and expiry invalidate sessions on the server", async (t) => {
  const { db, request, login } = await fixture(t);
  const first = await login();
  const logout = await request("/api/auth/logout", { cookie: first.cookie, body: {} });
  assert.equal(logout.status, 204);
  assert.equal(db.prepare("SELECT count(*) AS count FROM sessions").get().count, 0);
  assert.equal((await request("/api/me", { cookie: first.cookie })).status, 401);
  const second = await login();
  db.prepare("UPDATE sessions SET expires_at=?").run(now() - 1);
  assert.equal((await request("/api/me", { cookie: second.cookie })).status, 401);
});

test("mutations reject wrong origin and missing header without changing data", async (t) => {
  const { db, request, login } = await fixture(t);
  const { cookie } = await login();
  assert.equal((await request("/api/tasks", { cookie, body: { title: "blocked" }, headers: { Origin: "https://evil.example" } })).status, 403);
  assert.equal((await request("/api/tasks", { cookie, body: { title: "blocked" }, headers: { "X-Family-Planner": "" } })).status, 403);
  assert.equal(db.prepare("SELECT count(*) AS count FROM prototype_tasks").get().count, 0);
});

test("prototype tasks belong to authenticated user, including ID-based updates", async (t) => {
  const { db, request, login } = await fixture(t);
  db.exec("INSERT INTO prototype_tasks (id,title) VALUES ('unowned','Previous prototype record')");
  const a = await login({ id: 1, first_name: "A" });
  const b = await login({ id: 2, first_name: "B" });
  const created = await request("/api/tasks", { cookie: a.cookie, body: { title: "Private", owner_user_id: "other" } });
  assert.equal(created.status, 201);
  const task = await created.json();
  assert.deepEqual(await (await request("/api/tasks", { cookie: a.cookie })).json(), [task]);
  assert.deepEqual(await (await request("/api/tasks", { cookie: b.cookie })).json(), []);
  assert.equal((await request(`/api/tasks/${task.id}/toggle`, { cookie: b.cookie, method: "PATCH", body: {} })).status, 404);
  assert.equal((await request(`/api/tasks/${task.id}/toggle`, { cookie: a.cookie, method: "PATCH", body: {} })).status, 200);
});

test("dev login is explicit, local, cannot impersonate a user and is forbidden in production", async (t) => {
  assert.throws(() => readAuthConfig({ NODE_ENV: "production", DEV_AUTH_ENABLED: "true" }), /only/);
  assert.throws(() => readAuthConfig({ DEV_AUTH_ENABLED: "true" }), /only/);
  assert.throws(() => readAuthConfig({ NODE_ENV: "production", APP_ORIGIN: "http://localhost", TELEGRAM_BOT_TOKEN: botToken }), /HTTPS/);
  const prod = await fixture(t);
  assert.equal((await prod.request("/api/auth/dev", { body: {} })).status, 404);
  assert.deepEqual(await (await prod.request("/api/auth/config")).json(), { devLoginEnabled: false });
  const dev = await fixture(t, { NODE_ENV: "development", DEV_AUTH_ENABLED: "true", APP_ORIGIN: "http://localhost:5173", TELEGRAM_BOT_TOKEN: "" });
  assert.deepEqual(await (await dev.request("/api/auth/config")).json(), { devLoginEnabled: true });
  assert.equal((await dev.request("/api/auth/dev", { body: { userId: "other" } })).status, 400);
  assert.equal((await dev.request("/api/auth/dev", { body: {}, headers: { "X-Forwarded-For": "1.2.3.4" } })).status, 404);
  const response = await dev.request("/api/auth/dev", { body: {} });
  assert.equal(response.status, 204);
  const cookie = response.headers.get("set-cookie").split(";")[0];
  assert.equal((await (await dev.request("/api/me", { cookie })).json()).authMethod, "dev");
  assert.equal(dev.db.prepare("SELECT telegram_id FROM users").get().telegram_id, "dev:local");
  dev.config.devEnabled = false;
  assert.equal((await dev.request("/api/me", { cookie })).status, 401);
});

test("login rate limiting returns 429 without logging or reflecting initData", async (t) => {
  const { request } = await fixture(t);
  for (let i = 0; i < 20; i++) await request("/api/auth/telegram", { body: { initData: "secret-sentinel" } });
  const response = await request("/api/auth/telegram", { body: { initData: "secret-sentinel" } });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "60");
  assert.ok(!(await response.text()).includes("secret-sentinel"));
});
