import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { openDatabase } from "../dist/db/connection.js";
import { migrate } from "../dist/db/migrations.js";
import { createApp } from "../dist/app.js";
import { readAuthConfig } from "../dist/auth/config.js";

async function fixture(t, classify = async () => { throw new Error("AI offline in tests"); }) {
  const db = openDatabase(":memory:"); migrate(db);
  const config = readAuthConfig({ NODE_ENV: "production", TELEGRAM_BOT_TOKEN: "shopping-test", APP_ORIGIN: "https://family.example", TELEGRAM_BOT_USERNAME: "family_test_bot" });
  const server = createApp(db, config, classify).listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); });
  async function request(cookie, path, method = "GET", body) {
    return fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method,
      headers: { Origin: config.origin, "X-Family-Planner": "1", "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function login(id) {
    const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id, first_name: `Person ${id}` }) };
    const key = createHmac("sha256", "WebAppData").update(config.botToken).digest();
    const hash = createHmac("sha256", key).update(Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join("\n")).digest("hex");
    const result = await request(null, "/auth/telegram", "POST", { initData: new URLSearchParams({ ...fields, hash }).toString() });
    assert.equal(result.status, 204); return result.headers.get("set-cookie").split(";")[0];
  }
  const owner = await login(1), member = await login(2), outsider = await login(3), alone = await login(4);
  assert.equal((await request(owner, "/families", "POST", { name: "First" })).status, 201);
  assert.equal((await request(outsider, "/families", "POST", { name: "Other" })).status, 201);
  const invite = await (await request(owner, "/family/invitations", "POST", {})).json();
  assert.equal((await request(member, "/family/join", "POST", { token: invite.token })).status, 200);
  async function current(cookie = owner) { const response = await request(cookie, "/shopping-lists/current"); assert.equal(response.status, 200); return response.json(); }
  const initial = await current();
  async function add(cookie = owner, body = {}) {
    const response = await request(cookie, "/shopping-lists/current/items", "POST", { listId: initial.list.id, title: "Молоко", quantity: "2 л", note: "Без лактозы", ...body });
    assert.equal(response.status, 201); return (await response.json()).id;
  }
  return { db, request, current, add, owner, member, outsider, alone, initial };
}

test("shopping is shared by members: create, edit, bought/reopen, delete and validation", async t => {
  const f = await fixture(t);
  const id = await f.add(f.member);
  assert.deepEqual((await f.current(f.owner)).items, (await f.current(f.member)).items);
  assert.equal((await f.request(f.owner, `/shopping-items/${id}`, "PATCH", { title: "Кефир", quantity: "", note: null, bought: true })).status, 204);
  let item = (await f.current(f.member)).items[0];
  assert.equal(item.title, "Кефир"); assert.equal(item.quantity, null); assert.equal(item.note, null); assert.equal(item.bought, true);
  assert.equal((await f.request(f.member, `/shopping-items/${id}`, "PATCH", { bought: false })).status, 204);
  assert.equal((await f.current()).items[0].bought, false);
  for (const body of [{ title: " " }, { title: "x".repeat(201) }, { quantity: "x".repeat(101) }, { note: "x".repeat(2001) }, { bought: "true" }, { family_id: "spoof" }, {}]) {
    assert.equal((await f.request(f.owner, `/shopping-items/${id}`, "PATCH", body)).status, 400);
  }
  assert.equal((await f.request(f.owner, "/shopping-lists/current/items", "POST", { title: "No list" })).status, 400);
  assert.equal((await f.request(f.member, `/shopping-items/${id}`, "DELETE", {})).status, 204);
  assert.equal((await f.current()).items.length, 0);
});

test("concurrent closing creates one replacement; history retains all items and is immutable", async t => {
  const f = await fixture(t); const id = await f.add(); await f.add(f.member, { title: "Хлеб" });
  await f.request(f.member, `/shopping-items/${id}`, "PATCH", { bought: true });
  const body = { listId: f.initial.list.id };
  const results = await Promise.all([f.request(f.member, "/shopping-lists/current/close", "POST", body), f.request(f.owner, "/shopping-lists/current/close", "POST", body)]);
  assert.deepEqual(results.map(r => r.status), [200, 200]);
  const [a, b] = await Promise.all(results.map(r => r.json()));
  assert.equal(a.list.id, b.list.id); assert.notEqual(a.list.id, body.listId); assert.equal(a.items.length, 0);
  const history = await (await f.request(f.member, "/shopping-lists/history")).json();
  assert.equal(history.lists.length, 1); assert.equal(history.lists[0].itemCount, 2); assert.ok(history.lists[0].closedByUserId);
  const archived = await (await f.request(f.member, `/shopping-lists/${body.listId}`)).json();
  assert.equal(archived.items.length, 2); assert.equal(archived.items.filter(i => i.bought).length, 1);
  assert.equal((await f.request(f.owner, `/shopping-items/${id}`, "PATCH", { title: "No" })).status, 409);
  assert.equal((await f.request(f.member, `/shopping-items/${id}`, "DELETE", {})).status, 409);
  assert.equal((await f.request(f.owner, "/shopping-lists/current/items", "POST", { listId: body.listId, title: "Late" })).status, 409);
  assert.equal((await f.request(f.owner, `/shopping-lists/${a.list.id}`, "DELETE", {})).status, 409);
  // Repeating a close later must leave the replacement and its contents intact.
  await f.add(f.member, { listId: a.list.id, title: "Новый" });
  assert.equal((await f.request(f.owner, "/shopping-lists/current/close", "POST", body)).status, 200);
  assert.equal((await f.current()).items.length, 1);
  await f.request(f.owner, "/shopping-lists/current/close", "POST", { listId: a.list.id });
  const ordered = await (await f.request(f.owner, "/shopping-lists/history")).json();
  assert.deepEqual(ordered.lists.map(l => l.id), [a.list.id, body.listId]);
  assert.equal((await f.request(f.member, `/shopping-lists/${body.listId}`, "DELETE", {})).status, 204);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM shopping_items WHERE list_id=?").get(body.listId).n, 0);
  assert.equal((await f.request(f.owner, `/shopping-lists/${body.listId}`)).status, 404);
});

test("shopping rejects anonymous, family-less, foreign and removed members across all routes", async t => {
  const f = await fixture(t); const item = await f.add(); const list = f.initial.list.id;
  const routes = [["/shopping-lists/current", "GET"], ["/shopping-lists/history", "GET"], [`/shopping-lists/${list}`, "GET"],
    ["/shopping-lists/current/items", "POST", { listId: list, title: "Hack" }], [`/shopping-items/${item}`, "PATCH", { bought: true }],
    [`/shopping-items/${item}`, "DELETE", {}], ["/shopping-lists/current/close", "POST", { listId: list }], [`/shopping-lists/${list}`, "DELETE", {}]];
  for (const [path, method, body] of routes) {
    assert.equal((await f.request(null, path, method, body)).status, 401);
    assert.equal((await f.request(f.alone, path, method, body)).status, 403);
    if (path !== "/shopping-lists/current" && path !== "/shopping-lists/history") assert.equal((await f.request(f.outsider, path, method, body)).status, 404);
  }
  assert.equal((await f.current(f.outsider)).items.length, 0);
  const people = await (await f.request(f.owner, "/family/members")).json();
  const removed = people.members.find(p => p.role === "member").id;
  await f.request(f.owner, `/family/members/${removed}`, "DELETE", {});
  for (const [path, method, body] of routes) assert.equal((await f.request(f.member, path, method, body)).status, 403);
});

test("failed replacement rolls back closing and retains all purchases", async t => {
  const f = await fixture(t); await f.add();
  f.db.exec("CREATE TRIGGER fail_replacement BEFORE INSERT ON shopping_lists BEGIN SELECT RAISE(ABORT,'test failure'); END");
  assert.equal((await f.request(f.member, "/shopping-lists/current/close", "POST", { listId: f.initial.list.id })).status, 500);
  const current = await f.current(); assert.equal(current.list.id, f.initial.list.id); assert.equal(current.list.closedAt, null); assert.equal(current.items.length, 1);
  assert.equal((await (await f.request(f.owner, "/shopping-lists/history")).json()).lists.length, 0);
});

test("first item skips AI; later additions group categories and toggling never moves rows", async t => {
  const calls = [];
  const categories = { "Молоко": 5, "Шампунь": 0, "Корм": 1, "Огурцы": 2, "Курица": 3, "Яйца": 4, "Тунец": 6, "Макароны": 7, "Соль": 8, "Хлеб": 9, "Вода": 10, "Шоколад": 11, "Чипсы": 12, "Творог": 5 };
  const f = await fixture(t, async items => { calls.push(items); return items.map(item => ({ id: item.id, category: categories[item.title] })); });
  const milk = await f.add(f.owner, { title: "Молоко" }); assert.equal(calls.length, 0);
  for (const title of ["Чипсы", "Шоколад", "Вода", "Хлеб", "Соль", "Макароны", "Тунец", "Яйца", "Курица", "Огурцы", "Корм", "Шампунь", "Творог"]) await f.add(f.member, { title });
  assert.deepEqual(calls[0].map(i => i.title), ["Молоко", "Чипсы"]);
  assert.ok(calls.slice(1).every(items => items.length === 1));
  const before = (await f.current()).items;
  assert.deepEqual(before.map(i => i.title), ["Шампунь", "Корм", "Огурцы", "Курица", "Яйца", "Молоко", "Творог", "Тунец", "Макароны", "Соль", "Хлеб", "Вода", "Шоколад", "Чипсы"]);
  const count = calls.length;
  for (const bought of [true, false]) {
    await f.request(f.member, `/shopping-items/${milk}`, "PATCH", { bought });
    assert.deepEqual((await f.current()).items.map(i => i.id), before.map(i => i.id));
  }
  await f.request(f.owner, `/shopping-items/${milk}`, "PATCH", { title: "Кефир" });
  assert.deepEqual((await f.current()).items.map(i => i.id), before.map(i => i.id));
  assert.equal(calls.length, count);
  await f.request(f.owner, "/shopping-lists/current/close", "POST", { listId: f.initial.list.id });
  const archive = await (await f.request(f.owner, `/shopping-lists/${f.initial.list.id}`)).json();
  assert.deepEqual(archive.items.map(i => i.id), before.map(i => i.id));
});

test("AI failure or invalid IDs append without losing items; a later addition retries unknown categories", async t => {
  let attempt = 0;
  const f = await fixture(t, async items => {
    attempt++;
    if (attempt === 1) throw new Error("offline");
    if (attempt === 2) return items.map(() => ({ id: "foreign-id", category: 0 }));
    if (attempt === 3) return items.map(i => ({ id: i.id, category: 99 }));
    return items.map(i => ({ id: i.id, category: i.title === "Шампунь" ? 0 : 5 }));
  });
  for (const title of ["Молоко", "Шампунь", "Кефир", "Творог"]) await f.add(f.owner, { title });
  assert.deepEqual((await f.current()).items.map(i => i.title), ["Молоко", "Шампунь", "Кефир", "Творог"]);
  await f.add(f.owner, { title: "Йогурт" });
  assert.deepEqual((await f.current()).items.map(i => i.title), ["Шампунь", "Молоко", "Кефир", "Творог", "Йогурт"]);
});

test("concurrent additions are classified against the latest list and keep both products", async t => {
  const calls = [];
  const f = await fixture(t, async items => { calls.push(items); return items.map(i => ({ id: i.id, category: i.title === "Шампунь" ? 0 : 5 })); });
  const results = await Promise.all([f.add(f.owner, { title: "Молоко" }), f.add(f.member, { title: "Шампунь" })]);
  assert.equal(new Set(results).size, 2); assert.equal(calls.length, 1); assert.equal(calls[0].length, 2);
  assert.deepEqual((await f.current()).items.map(i => i.title), ["Шампунь", "Молоко"]);
});

test("closing a list during AI classification prevents a late insertion", async t => {
  let release, started;
  const waiting = new Promise(resolve => { started = resolve; });
  const answer = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, async items => { started(); await answer; return items.map(i => ({ id: i.id, category: 5 })); });
  await f.add();
  const pending = f.request(f.member, "/shopping-lists/current/items", "POST", { listId: f.initial.list.id, title: "Кефир" });
  await waiting;
  await f.request(f.owner, "/shopping-lists/current/close", "POST", { listId: f.initial.list.id });
  release(); assert.equal((await pending).status, 409);
  assert.equal((await f.current()).items.length, 0);
  const archive = await (await f.request(f.owner, `/shopping-lists/${f.initial.list.id}`)).json();
  assert.equal(archive.items.length, 1);
});

test("general purchases share CRUD, retain order, never call AI and stay separate from groceries", async t => {
  let aiCalls = 0;
  const f = await fixture(t, async () => { aiCalls++; return []; });
  const ids = [];
  for (const title of ["Лампа", "Стул"]) {
    const result = await f.request(f.member, "/purchases", "POST", { title });
    assert.equal(result.status, 201); ids.push((await result.json()).id);
  }
  const read = async cookie => (await (await f.request(cookie, "/purchases")).json()).items;
  assert.deepEqual(await read(f.owner), await read(f.member));
  assert.equal((await f.current()).items.length, 0);
  assert.equal((await f.request(f.owner, `/purchases/${ids[0]}`, "PATCH", { title: "Настольная лампа", bought: true })).status, 204);
  assert.deepEqual((await read(f.member)).map(i => i.id), ids);
  assert.equal((await read(f.member))[0].bought, true);
  assert.equal((await f.request(f.member, `/purchases/${ids[0]}`, "PATCH", { bought: false })).status, 204);
  assert.equal((await f.request(f.owner, `/shopping-items/${ids[0]}`, "PATCH", { bought: true })).status, 404);
  const grocery = await f.add();
  assert.equal((await f.request(f.owner, `/purchases/${grocery}`, "PATCH", { bought: true })).status, 404);
  assert.equal((await f.request(f.owner, "/purchases/current/close", "POST", {})).status, 404);
  assert.equal((await f.request(f.owner, "/purchases/history")).status, 404);
  for (const body of [{title:" "},{title:"x".repeat(201)},{title:"Стол",family_id:"spoof"}]) assert.equal((await f.request(f.owner,"/purchases","POST",body)).status,400);
  assert.equal((await f.request(f.member, `/purchases/${ids[0]}`, "DELETE", {})).status,204);
  assert.deepEqual((await read(f.owner)).map(i => i.id), [ids[1]]);
  assert.equal(aiCalls, 0);
});

test("general purchases reject anonymous, foreign-family and removed members", async t => {
  const f = await fixture(t);
  const created = await (await f.request(f.owner,"/purchases","POST",{title:"Лампа"})).json();
  for (const [path,method,body] of [["/purchases","GET"],["/purchases","POST",{title:"Книга"}],[`/purchases/${created.id}`,"PATCH",{bought:true}],[`/purchases/${created.id}`,"DELETE",{}]]) {
    assert.equal((await f.request(null,path,method,body)).status,401);
    assert.equal((await f.request(f.alone,path,method,body)).status,403);
    if(path!=="/purchases") assert.equal((await f.request(f.outsider,path,method,body)).status,404);
  }
  assert.equal((await (await f.request(f.outsider,"/purchases")).json()).items.length,0);
  const people = await (await f.request(f.owner,"/family/members")).json();
  const memberId = people.members.find(m=>m.role==="member").id;
  await f.request(f.owner,`/family/members/${memberId}`,"DELETE",{});
  assert.equal((await f.request(f.member,"/purchases")).status,403);
  assert.equal((await f.request(f.member,`/purchases/${created.id}`,"PATCH",{bought:true})).status,403);
});
