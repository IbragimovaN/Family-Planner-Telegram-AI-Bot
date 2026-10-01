import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac, createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { openDatabase } from "../dist/db/connection.js";
import { migrate } from "../dist/db/migrations.js";
import { createApp } from "../dist/app.js";
import { readAuthConfig } from "../dist/auth/config.js";

async function fixture(t, path = ":memory:") {
  const db = openDatabase(path); migrate(db);
  const token = "family-test-token";
  const config = readAuthConfig({ NODE_ENV: "production", TELEGRAM_BOT_TOKEN: token, TELEGRAM_BOT_USERNAME: "family_test_bot", APP_ORIGIN: "https://family.example" });
  const server = createApp(db, config).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); });
  async function request(cookie, path, method = "GET", body) {
    return fetch(base + path, { method, headers: { Origin: config.origin, "X-Family-Planner": "1", "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function login(id) {
    const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: `Person ${id}` }) };
    const data = Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join("\n");
    const secret = createHmac("sha256", "WebAppData").update(token).digest();
    const hash = createHmac("sha256", secret).update(data).digest("hex");
    const response = await request(null, "/api/auth/telegram", "POST", { initData: new URLSearchParams({ ...fields, hash }).toString() });
    assert.equal(response.status, 204);
    return response.headers.get("set-cookie").split(";")[0];
  }
  async function create(cookie, name = "Family") {
    const response = await request(cookie, "/api/families", "POST", { name });
    assert.equal(response.status, 201);
    return (await response.json()).family;
  }
  async function invite(cookie) {
    const response = await request(cookie, "/api/family/invitations", "POST", {});
    assert.equal(response.status, 201);
    return response.json();
  }
  return { db, request, login, create, invite };
}

test("family creation is atomic, makes owner and prevents two concurrent families", async t => {
  const f = await fixture(t); const owner = await f.login(1);
  assert.deepEqual(await (await f.request(owner, "/api/family")).json(), { family: null });
  const responses = await Promise.all([f.request(owner, "/api/families", "POST", { name: "First" }), f.request(owner, "/api/families", "POST", { name: "Second" })]);
  assert.deepEqual(responses.map(r => r.status).sort(), [201, 409]);
  const { family } = await (await f.request(owner, "/api/family")).json();
  assert.equal(family.role, "owner"); assert.equal(family.timezone, "Europe/Moscow");
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM families").get().n, 1);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM shopping_lists WHERE family_id=? AND closed_at IS NULL").get(family.id).n, 1);
  const other = await f.login(2);
  f.db.exec("CREATE TRIGGER fail_list BEFORE INSERT ON shopping_lists BEGIN SELECT RAISE(ABORT,'test rollback'); END");
  assert.equal((await f.request(other, "/api/families", "POST", { name: "Fail" })).status, 500);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM families").get().n, 1);
  assert.deepEqual(await (await f.request(other, "/api/family")).json(), { family: null });
});

test("invitation uses hash, seven-day expiry, Telegram startapp and idempotent multi-user joining", async t => {
  const f = await fixture(t); const owner = await f.login(1); const member = await f.login(2); const third = await f.login(3);
  const family = await f.create(owner); const invite = await f.invite(owner);
  assert.match(invite.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(invite.url, `https://t.me/family_test_bot?startapp=invite_${invite.token}`);
  assert.equal(invite.invitation.expiresAt - invite.invitation.createdAt, 7 * 86400);
  assert.equal(f.db.prepare("SELECT token_hash FROM invitations").get().token_hash, createHash("sha256").update(invite.token).digest("hex"));
  const list = await (await f.request(owner, "/api/family/invitations")).text();
  assert.ok(!list.includes(invite.token)); assert.ok(!list.includes("token_hash"));
  const concurrent = await Promise.all([f.request(member, "/api/family/join", "POST", { token: invite.token }), f.request(member, "/api/family/join", "POST", { token: invite.token })]);
  assert.deepEqual(concurrent.map(r => r.status), [200, 200]);
  assert.equal((await f.request(third, "/api/family/join", "POST", { token: invite.token })).status, 200);
  const joined = await (await f.request(member, "/api/family")).json();
  assert.equal(joined.family.id, family.id); assert.equal(joined.family.role, "member");
  assert.equal((await (await f.request(owner, "/api/family/members")).json()).members.length, 3);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM wishlist_profiles").get().n, 0);
});

test("member permissions, cross-family IDs and removal never grant access to another family", async t => {
  const f = await fixture(t); const owner = await f.login(1); const member = await f.login(2); const outsider = await f.login(3);
  const first = await f.create(owner); const second = await f.create(outsider, "Other");
  const invite = await f.invite(owner); const outsideInvite = await f.invite(outsider);
  await f.request(member, "/api/family/join", "POST", { token: invite.token });
  const people = (await (await f.request(owner, "/api/family/members")).json()).members;
  const memberId = people.find(p => p.role === "member").id;
  const ownerId = people.find(p => p.role === "owner").id;
  for (const [path, method, body] of [["/api/family", "PATCH", { name: "Hack" }], ["/api/family/invitations", "POST", {}], [`/api/family/members/${ownerId}`, "DELETE", {}], [`/api/family/members/${memberId}`, "DELETE", {}]]) {
    assert.equal((await f.request(member, path, method, body)).status, 403);
  }
  assert.equal((await f.request(member, "/api/family/invitations")).status, 403);
  assert.equal((await f.request(owner, `/api/family/members/${ownerId}`, "DELETE", {})).status, 409);
  assert.equal((await f.request(outsider, `/api/family/members/${memberId}`, "DELETE", {})).status, 404);
  assert.equal((await f.request(owner, `/api/family/invitations/${outsideInvite.invitation.id}`, "DELETE", {})).status, 404);
  assert.equal((await (await f.request(owner, `/api/family?family_id=${second.id}`)).json()).family.id, first.id);
  assert.equal((await f.request(member, "/api/family/join", "POST", { token: outsideInvite.token })).status, 409);
  assert.equal((await f.request(owner, "/api/family", "PATCH", { family_id: second.id, name: "Hack" })).status, 400);
  assert.equal((await f.request(owner, `/api/family/members/${memberId}`, "DELETE", {})).status, 204);
  assert.deepEqual(await (await f.request(member, "/api/family")).json(), { family: null });
  assert.equal((await f.request(member, "/api/family/members")).status, 403);
  assert.equal((await f.request(member, "/api/me")).status, 200);
  assert.equal((await (await f.request(outsider, "/api/family")).json()).family.name, "Other");
});

test("expired, revoked and unknown invitations cannot be used", async t => {
  const f = await fixture(t); const owner = await f.login(1); const member = await f.login(2);
  await f.create(owner); const expired = await f.invite(owner); const revoked = await f.invite(owner);
  f.db.prepare("UPDATE invitations SET expires_at=0 WHERE id=?").run(expired.invitation.id);
  assert.equal((await f.request(owner, `/api/family/invitations/${revoked.invitation.id}`, "DELETE", {})).status, 204);
  for (const token of [expired.token, revoked.token, "x".repeat(43)]) {
    assert.equal((await f.request(member, "/api/family/join", "POST", { token })).status, 410);
  }
  assert.deepEqual(await (await f.request(member, "/api/family")).json(), { family: null });
});

test("family settings validate names and timezones and persist after reconnect", async t => {
  const dir = mkdtempSync(join(tmpdir(), "family-settings-"));
  const path = join(dir, "db.db"); const f = await fixture(t, path); const owner = await f.login(1);
  t.after(() => { assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep)); rmSync(dir, { recursive: true, force: true }); });
  await f.create(owner);
  for (const body of [{ name: "  " }, { timezone: "Mars/Olympus" }, {}]) assert.equal((await f.request(owner, "/api/family", "PATCH", body)).status, 400);
  assert.equal((await f.request(owner, "/api/family", "PATCH", { name: "Updated", timezone: "Asia/Yekaterinburg" })).status, 200);
  const another = openDatabase(path, true);
  try { assert.deepEqual(another.prepare("SELECT name,timezone FROM families").get(), { name: "Updated", timezone: "Asia/Yekaterinburg" }); }
  finally { another.close(); }
});

test("invitation rate limit bounds repeated creation", async t => {
  const f = await fixture(t); const owner = await f.login(1); await f.create(owner);
  for (let i = 0; i < 19; i++) await f.invite(owner);
  assert.equal((await f.request(owner, "/api/family/invitations", "POST", {})).status, 429);
});
