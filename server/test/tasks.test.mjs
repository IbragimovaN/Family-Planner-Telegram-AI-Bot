import assert from "node:assert/strict";
import { test } from "node:test";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { openDatabase } from "../dist/db/connection.js";
import { migrate } from "../dist/db/migrations.js";
import { createApp } from "../dist/app.js";
import { readAuthConfig } from "../dist/auth/config.js";
import { localDate, periodStart, periodEnd, overdueCount, validDate } from "../dist/task-dates.js";

const draft = (changes = {}) => ({ title: "Call doctor", description: "Ask for results", periodType: "date", plannedDate: "2026-10-10", plannedTime: null, ...changes });
async function fixture(t, parser = async () => { throw new Error("offline"); }) {
  const db = openDatabase(":memory:"); migrate(db);
  let time = Date.parse("2026-10-10T09:00:00Z");
  const config = readAuthConfig({ NODE_ENV: "production", TELEGRAM_BOT_TOKEN: "test-only", TELEGRAM_BOT_USERNAME: "family_test_bot", APP_ORIGIN: "https://family.example" });
  const server = createApp(db, config, undefined, parser, () => time).listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); });
  async function request(cookie, path, method = "GET", body) {
    return fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method, headers: { "Content-Type": "application/json", "X-Family-Planner": "1", Origin: config.origin, ...(cookie ? { Cookie: cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  }
  async function login(id) {
    const fields = { auth_date: String(Math.floor(Date.now()/1000)), user: JSON.stringify({ id, first_name: `Person ${id}` }) };
    const secret = createHmac("sha256", "WebAppData").update(config.botToken).digest();
    const hash = createHmac("sha256", secret).update(Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join("\n")).digest("hex");
    const response = await request(null, "/auth/telegram", "POST", { initData: new URLSearchParams({ ...fields, hash }).toString() });
    assert.equal(response.status, 204); return response.headers.get("set-cookie").split(";")[0];
  }
  const owner = await login(1), member = await login(2), outsider = await login(3), alone = await login(4);
  await request(owner, "/families", "POST", { name: "Family" }); await request(outsider, "/families", "POST", { name: "Other" });
  const invitation = await (await request(owner, "/family/invitations", "POST", {})).json(); await request(member, "/family/join", "POST", { token: invitation.token });
  const user = id => db.prepare("SELECT id FROM users WHERE telegram_id=?").get(String(id)).id;
  async function add(task = draft(), cookie = owner, target = user(1)) {
    const response = await request(cookie, "/tasks", "POST", { ownerUserId: target, tasks: [task] }); assert.equal(response.status, 201, await response.clone().text()); return (await response.json()).ids[0];
  }
  async function list(query = "", cookie = owner) { const r = await request(cookie, `/tasks?date=2026-10-10${query}`); assert.equal(r.status,200); return (await r.json()).tasks; }
  return { db, request, owner, member, outsider, alone, user, add, list, time: value => { time = Date.parse(value); } };
}

test("dates use family timezone, Monday and real month boundaries including leap years", () => {
  assert.equal(localDate("Europe/Moscow", Date.parse("2026-10-09T21:00:00Z")), "2026-10-10");
  assert.equal(localDate("America/New_York", Date.parse("2026-11-01T05:30:00Z")), "2026-11-01");
  assert.equal(periodStart("2027-01-01", "week"), "2026-12-28");
  assert.equal(periodEnd("2024-02-10", "month"), "2024-02-29");
  assert.equal(periodEnd("2026-02-10", "month"), "2026-02-28");
  assert.equal(validDate("2026-02-30"), false); assert.equal(validDate("2024-02-29"), true);
  assert.equal(overdueCount("2026-12-01", "month", "2027-02-01"), 2);
  assert.equal(overdueCount("2026-10-05", "week", "2026-10-11"), 0);
  assert.equal(overdueCount("2026-10-05", "week", "2026-10-12"), 1);
});
test("family reads and creation are allowed but only list owner may mutate, including author and family owner", async t => {
  const f = await fixture(t); const id = await f.add(draft(), f.owner, f.user(2));
  assert.equal((await f.list(`&owner=${f.user(2)}`)).length, 1);
  for (const [path, method, body] of [[`/tasks/${id}`, "PATCH", draft()], [`/tasks/${id}`, "DELETE", {}], [`/tasks/${id}/complete`, "POST", {}], [`/tasks/${id}/reopen`, "POST", {}]]) {
    assert.equal((await f.request(f.owner,path,method,body)).status,403);
    assert.equal((await f.request(f.outsider,path,method,body)).status,404);
    assert.equal((await f.request(null,path,method,body)).status,401);
  }
  assert.equal((await f.request(f.member, `/tasks/${id}`, "PATCH", draft({ title: "Edited by owner" }))).status,204);
  assert.equal((await f.request(f.member, `/tasks/${id}/complete`, "POST", {})).status,204);
  assert.equal((await f.request(f.member, `/tasks/${id}`, "DELETE", {})).status,204);
  assert.equal((await f.request(f.owner,"/tasks","POST",{ownerUserId:f.user(3),tasks:[draft()]})).status,404);
  assert.equal((await f.request(f.alone,"/tasks")).status,403);
  assert.equal((await f.request(f.outsider,`/tasks?owner=${f.user(2)}`)).status,404);
  await f.request(f.owner,`/family/members/${f.user(2)}`,"DELETE",{});
  assert.equal((await f.request(f.member,"/tasks")).status,403);
});
test("daily carry-over, sorting, actual completion date, idempotency, reschedule and reopen", async t => {
  const f = await fixture(t);
  const late = await f.add(draft({ plannedDate:"2026-10-08", plannedTime:"10:00" }));
  await f.add(draft({ plannedTime:"08:00" })); await f.add(draft());
  let list = await f.list(); assert.deepEqual(list.map(x=>x.plannedTime),["08:00","10:00",null]); assert.equal(list.find(x=>x.id===late).overdue,2);
  await f.request(f.owner,`/tasks/${late}/complete`,"POST",{});
  assert.equal((await f.list()).length,2);
  const completed = (await f.list("&status=all")).at(-1); assert.equal(completed.id,late); assert.equal(completed.completedDate,"2026-10-10");
  f.time("2026-10-11T09:00:00Z"); await f.request(f.owner,`/tasks/${late}/complete`,"POST",{});
  assert.equal((await f.list("&status=all")).find(x=>x.id===late).completedAt,completed.completedAt);
  await f.request(f.owner,`/tasks/${late}/reopen`,"POST",{});
  await f.request(f.owner,`/tasks/${late}`,"PATCH",draft({plannedDate:"2026-10-12"}));
  const row=f.db.prepare("SELECT * FROM tasks WHERE id=?").get(late); assert.equal(row.original_planned_date,"2026-10-08"); assert.equal(row.completed_at,null);
  const future=await (await f.request(f.owner,"/tasks?date=2026-10-12")).json(); assert.equal(future.tasks.find(x=>x.id===late).overdue,0);
});
test("week/month undated carry-over and completion history use actual date", async t => {
  const f=await fixture(t);
  const week=await f.add(draft({periodType:"week",plannedDate:"2026-09-28"}));
  const month=await f.add(draft({periodType:"month",plannedDate:"2026-08-01"}));
  assert.equal((await f.list()).length,0);
  assert.equal((await f.list("&period=week&mode=undated"))[0].overdue,1);
  assert.equal((await f.list("&period=month&mode=undated"))[0].overdue,2);
  await f.request(f.owner,`/tasks/${week}/complete`,"POST",{});
  assert.equal((await f.list("&status=all"))[0].id,week);
  await f.request(f.owner,`/tasks/${month}`,"PATCH",draft({periodType:"month",plannedDate:"2026-11-01"}));
  assert.equal((await f.list("&period=month&mode=undated")).length,0);
  const next=await(await f.request(f.owner,"/tasks?date=2026-11-01&period=month&mode=undated")).json(); assert.equal(next.tasks[0].overdue,0); assert.equal(next.tasks[0].originalPlannedDate,"2026-08-01");
});
test("invalid payloads never save; batch creation is validated as a whole",async t=>{
  const f=await fixture(t);
  for(const task of [draft({plannedDate:"2026-02-30"}),draft({plannedTime:"25:00"}),draft({periodType:"week",plannedDate:"2026-10-10"}),draft({periodType:"month",plannedDate:"2026-10-01",plannedTime:"10:00"}),draft({title:" "}),{...draft(),familyId:"foreign"}]) {
    assert.equal((await f.request(f.owner,"/tasks","POST",{ownerUserId:f.user(1),tasks:[draft(),task]})).status,400);
  }
  assert.equal(f.db.prepare("SELECT count(*) n FROM tasks").get().n,0);
});
test("AI preview saves nothing and validates output; failure does not prevent manual creation",async t=>{
  let context; const f=await fixture(t,async input=>{context=input;return [draft(),draft({title:"Second"})];});
  const response=await f.request(f.owner,"/tasks/parse","POST",{text:"two tasks",date:"2026-10-10",periodType:"week"});
  assert.equal(response.status,200); assert.equal((await response.json()).tasks.length,2); assert.equal(context.today,"2026-10-10"); assert.equal(context.timezone,"Europe/Moscow");
  assert.equal(f.db.prepare("SELECT count(*) n FROM tasks").get().n,0);
  const bad=await fixture(t,async()=>[draft({plannedDate:"2026-02-30"})]);
  assert.equal((await bad.request(bad.owner,"/tasks/parse","POST",{text:"x",date:"2026-10-10",periodType:"date"})).status,503);
  await bad.add();
});
test("legacy records preserved, imported once, deleting imported record does not reimport it",async t=>{
  const f=await fixture(t);
  f.db.prepare("INSERT INTO prototype_tasks(id,title,owner_user_id,completed) VALUES (?,?,?,?)").run("old","Keep me",f.user(1),1);
  const first=await f.list("&status=all"); assert.equal(first.length,1); assert.match(first[0].description,/дата/);
  assert.equal((await f.list("&status=all")).length,1);
  await f.request(f.owner,`/tasks/${first[0].id}`,"DELETE",{});
  assert.equal((await f.list("&status=all")).length,0);
  assert.equal(f.db.prepare("SELECT title FROM prototype_tasks WHERE id='old'").get().title,"Keep me");
});
test("AI returning after removal cannot return family task preview",async t=>{
  let release; const f=await fixture(t,()=>new Promise(resolve=>{release=resolve;}));
  const pending=f.request(f.member,"/tasks/parse","POST",{text:"x",date:"2026-10-10",periodType:"date"});
  for(let i=0;i<100 && !release;i++) await new Promise(resolve=>setTimeout(resolve,5));
  assert.ok(release);
  await f.request(f.owner,`/family/members/${f.user(2)}`,"DELETE",{}); release([draft()]);
  assert.equal((await pending).status,403);
});
