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

async function createProfile(f, cookie=f.member, name="Аня") {
  const response=await f.request(cookie,"/wishlists","POST",{name});
  assert.equal(response.status,201); return (await response.json()).id;
}
async function read(f,id,cookie=f.owner) {
  const response=await f.request(cookie,`/wishlists/${id}`); assert.equal(response.status,200); return response.json();
}
async function createWish(f,profileId,cookie=f.owner,body={title:"Книга"}) {
  const response=await f.request(cookie,`/wishlists/${profileId}/items`,"POST",body);
  assert.equal(response.status,201); return (await response.json()).id;
}
test("wishlists are shared named lists without account binding or automatic creation",async t=>{
  const f=await fixture(t);
  assert.deepEqual((await (await f.request(f.owner,"/wishlists")).json()).profiles,[]);
  const users=f.db.prepare("SELECT count(*) AS n FROM users").get().n;
  const id=await createProfile(f,f.member,"  Подруга Аня  ");
  const ownerLists=await (await f.request(f.owner,"/wishlists")).json();
  const memberLists=await (await f.request(f.member,"/wishlists")).json();
  assert.deepEqual(ownerLists,memberLists);
  assert.equal(ownerLists.profiles[0].name,"Подруга Аня");
  assert.equal(ownerLists.profiles[0].canManage,true);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM users").get().n,users);
  assert.deepEqual((await (await f.request(f.outsider,"/wishlists")).json()).profiles,[]);
  const invite=await (await f.request(f.owner,"/family/invitations","POST",{})).json();
  await f.request(f.alone,"/family/join","POST",{token:invite.token});
  const newcomer=(await (await f.request(f.alone,"/wishlists")).json()).profiles;
  assert.equal(newcomer.length,1); assert.equal(newcomer[0].id,id); assert.equal(newcomer[0].canManage,false);
  // The same display name as a registered user is still just text.
  const second=await createProfile(f,f.owner,"Person 2");
  assert.equal((await read(f,second)).profile.name,"Person 2");
  assert.equal((await read(f,id,f.member)).items.length,0);
});
test("all family members can edit wishes and complete/reopen them without reordering",async t=>{
  const f=await fixture(t), id=await createProfile(f);
  const wish=await createWish(f,id,f.owner,{title:"Книга",url:"https://example.com/book",note:"В твёрдой обложке",priceMinor:123450,currency:"RUB"});
  await createWish(f,id,f.member,{title:"Цветы"});
  let data=await read(f,id); assert.equal(data.profile.itemCount,2);
  assert.equal(data.items[0].priceMinor,123450); assert.equal(data.items[0].author,"Person 1");
  assert.equal((await f.request(f.member,`/wishlist-items/${wish}`,"PATCH",{title:"Альбом",url:null,note:"",priceMinor:null,currency:null})).status,204);
  const ids=(await read(f,id)).items.map(i=>i.id);
  assert.equal((await f.request(f.member,`/wishlist-items/${wish}`,"PATCH",{completed:true})).status,204);
  data=await read(f,id); const completed=data.items[0];
  assert.equal(completed.completed,true); assert.equal(completed.completedBy,"Person 2"); assert.ok(completed.completedAt);
  assert.equal(completed.priceMinor,null); assert.equal(completed.note,null);
  assert.equal(data.profile.completedCount,1); assert.deepEqual(data.items.map(i=>i.id),ids);
  await f.request(f.owner,`/wishlist-items/${wish}`,"PATCH",{completed:true});
  assert.equal((await read(f,id)).items[0].completedBy,"Person 2","Repeated completion is idempotent");
  await f.request(f.owner,`/wishlist-items/${wish}`,"PATCH",{completed:false});
  const reopened=(await read(f,id)).items[0];
  assert.equal(reopened.completedAt,null); assert.equal(reopened.completedBy,null);
  assert.equal((await f.request(f.member,`/wishlist-items/${wish}`,"DELETE",{})).status,204);
  assert.equal((await read(f,id)).items.length,1);
});
test("only creator or family owner may rename/delete profiles; deletion cascades only within target",async t=>{
  const f=await fixture(t), id=await createProfile(f,f.owner);
  const wish=await createWish(f,id);
  for(const [method,body] of [["PATCH",{name:"No"}],["DELETE",{}]]) assert.equal((await f.request(f.member,`/wishlists/${id}`,method,body)).status,403);
  assert.equal((await f.request(f.owner,`/wishlists/${id}`,"PATCH",{name:"Новое имя"})).status,204);
  assert.equal((await read(f,id)).profile.name,"Новое имя");
  const own=await createProfile(f,f.member); await createWish(f,own);
  assert.equal((await f.request(f.member,`/wishlists/${own}`,"PATCH",{name:"Мой вишлист"})).status,204);
  const foreign=await createProfile(f,f.outsider); await createWish(f,foreign,f.outsider);
  assert.equal((await f.request(f.owner,`/wishlists/${own}`,"DELETE",{})).status,204);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM wishlist_items WHERE profile_id=?").get(own).n,0);
  assert.equal((await read(f,id)).items[0].id,wish);
  assert.equal((await read(f,foreign,f.outsider)).items.length,1);
  const creatorOnly=await createProfile(f,f.member);
  assert.equal((await f.request(f.member,`/wishlists/${creatorOnly}`,"DELETE",{})).status,204);
});
test("every wishlist route rejects unauthenticated, family-less, foreign and removed users",async t=>{
  const f=await fixture(t), id=await createProfile(f), wish=await createWish(f,id);
  const routes=[["/wishlists","GET"],["/wishlists","POST",{name:"Hack"}],[`/wishlists/${id}`,"GET"],[`/wishlists/${id}`,"PATCH",{name:"Hack"}],[`/wishlists/${id}`,"DELETE",{}],[`/wishlists/${id}/items`,"POST",{title:"Hack"}],[`/wishlist-items/${wish}`,"PATCH",{completed:true}],[`/wishlist-items/${wish}`,"DELETE",{}]];
  for(const [path,method,body] of routes) {
    assert.equal((await f.request(null,path,method,body)).status,401);
    assert.equal((await f.request(f.alone,path,method,body)).status,403);
    if(path!=="/wishlists") assert.equal((await f.request(f.outsider,path,method,body)).status,404);
  }
  const people=await (await f.request(f.owner,"/family/members")).json();
  await f.request(f.owner,`/family/members/${people.members.find(m=>m.role==="member").id}`,"DELETE",{});
  for(const [path,method,body] of routes) assert.equal((await f.request(f.member,path,method,body)).status,403);
  assert.equal((await read(f,id)).items.length,1);
  assert.equal((await read(f,id)).profile.canManage,true);
});
test("wishlist validation rejects unsafe URLs, invalid prices and spoofed ownership",async t=>{
  const f=await fixture(t), id=await createProfile(f), wish=await createWish(f,id);
  for(const body of [{name:" "},{name:"x".repeat(101)},{name:"A",user_id:"fake"},{name:"A",family_id:"fake"},{}]) {
    assert.equal((await f.request(f.owner,"/wishlists","POST",body)).status,400);
    assert.equal((await f.request(f.member,`/wishlists/${id}`,"PATCH",body)).status,400);
  }
  const invalid=[{title:" "},{title:"x".repeat(201)},{url:"javascript:alert(1)"},{url:"data:text/html,test"},{url:"ftp://example.com"},{url:"https://user:password@example.com"},{url:"bad"},{url:"https://example.com/"+"x".repeat(2048)},{note:"x".repeat(2001)},{priceMinor:-1,currency:"RUB"},{priceMinor:1.1,currency:"RUB"},{priceMinor:10},{currency:"RUB"},{priceMinor:10,currency:"XXX"},{priceMinor:1000000000000,currency:"RUB"},{completed:"yes"},{profile_id:id},{family_id:"fake"}];
  for(const body of invalid) {
    assert.equal((await f.request(f.owner,`/wishlists/${id}/items`,"POST",{title:"Valid",...body})).status,400,JSON.stringify(body));
    assert.equal((await f.request(f.owner,`/wishlist-items/${wish}`,"PATCH",body)).status,400,JSON.stringify(body));
  }
  assert.equal((await f.request(f.owner,`/wishlist-items/${wish}`,"PATCH",{})).status,400);
  assert.equal((await f.request(f.owner,"/wishlists/not-an-id")).status,400);
  assert.equal((await read(f,id)).items.length,1);
  await createWish(f,id,f.owner,{title:"Бесплатно",priceMinor:0,currency:"RUB",url:"https://example.com"});
  assert.equal((await read(f,id)).items[1].priceMinor,0);
});

