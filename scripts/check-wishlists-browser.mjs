// Run after both builds. Uses an isolated in-memory DB and a simulated Telegram SDK.
// CHROME_PATH may point to another Chromium executable. No real tokens/data are used.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { openDatabase } from "../server/dist/db/connection.js";
import { migrate } from "../server/dist/db/migrations.js";
import { readAuthConfig } from "../server/dist/auth/config.js";
import { createApp } from "../server/dist/app.js";

const db = openDatabase(":memory:"); migrate(db);
const config = readAuthConfig({ NODE_ENV: "development", APP_ORIGIN: "http://127.0.0.1", TELEGRAM_BOT_TOKEN: "browser-test" });
const server = createApp(db, config, async () => { throw new Error("AI offline in browser test"); }).listen(0, "127.0.0.1"); await once(server, "listening");
config.origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), "planner-browser-"));
const artifacts = resolve(".checks.local"); await mkdir(artifacts, { recursive: true });
let browser, socket;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
  browser = spawn(process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "about:blank"], { windowsHide: true, stdio: "ignore" });
  let launchError; browser.on("error", err => { launchError = err; });
  let port;
  for (let i = 0; i < 100; i++) {
    if (launchError) throw launchError;
    try { port = Number((await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]); break; } catch { await sleep(100); }
  }
  assert.ok(port, "Chromium started");
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.timeout(5000) })).json();
  socket = new WebSocket(target.webSocketDebuggerUrl); await once(socket, "open");
  let serial = 0;
  const pending = new Map(); const errors = [];
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (message.id) { const task = pending.get(message.id); pending.delete(message.id); if (message.error) task?.reject(new Error(JSON.stringify(message.error))); else task?.resolve(message.result); }
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
  });
  function cdp(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++serial;
      const timeout = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
      pending.set(id, { resolve: value => { clearTimeout(timeout); resolve(value); }, reject: error => { clearTimeout(timeout); reject(error); } });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression) {
    const response = await cdp("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result.value;
  }
  async function wait(expression) {
    for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await sleep(50); }
    throw new Error(`Timed out: ${expression}\n${await evaluate("document.body.innerText")}`);
  }
  async function click(text) {
    const expression = `[...document.querySelectorAll('button')].find(b => (b.textContent.trim() === ${JSON.stringify(text)} || b.getAttribute('aria-label') === ${JSON.stringify(text)}) && !b.disabled)`;
    await wait(`Boolean(${expression})`);
    const point = await evaluate(`(() => {const b=${expression}; b.scrollIntoView({block:'nearest'}); const r=b.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
  }
  async function input(id, value) {
    await evaluate(`(() => { const e=document.getElementById(${JSON.stringify(id)}); Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)}); e.dispatchEvent(new Event('input',{bubbles:true})); })()`);
  }
  async function screenshot(name) {
    const { data } = await cdp("Page.captureScreenshot", { format: "png", captureBeyondViewport: true });
    await writeFile(join(artifacts, name), Buffer.from(data, "base64"));
  }
  await cdp("Page.enable"); await cdp("Runtime.enable"); await cdp("Network.enable");
  await cdp("Network.setBlockedURLs", { urls: ["*telegram.org/js/*"] });
  const fields = { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 12345, first_name: "Тест" }) };
  const secret = createHmac("sha256", "WebAppData").update(config.botToken).digest();
  const hash = createHmac("sha256", secret).update(Object.keys(fields).sort().map(k => `${k}=${fields[k]}`).join("\n")).digest("hex");
  const initData = new URLSearchParams({ ...fields, hash }).toString();
  await cdp("Page.addScriptToEvaluateOnNewDocument", { source: `
    window.__events={}; window.__back=null;
    window.Telegram={WebApp:{initData:${JSON.stringify(initData)},colorScheme:'light',viewportStableHeight:780,
      ready(){},expand(){},onEvent(n,f){window.__events[n]=f},offEvent(n){delete window.__events[n]},
      BackButton:{show(){window.__backVisible=true},hide(){window.__backVisible=false},onClick(f){window.__back=f},offClick(f){if(window.__back===f)window.__back=null}}
    }};
    window.__theme=(dark)=>{const s=document.documentElement.style;
      for(const [k,v] of Object.entries(dark?{'bg-color':'#1b2433','text-color':'#eff3fb','secondary-bg-color':'#253043','link-color':'#abc3ff'}:{'bg-color':'#ffffff','text-color':'#192638','secondary-bg-color':'#f3f5f8','link-color':'#315dcc'}))s.setProperty('--tg-theme-'+k,v);
      Telegram.WebApp.colorScheme=dark?'dark':'light';window.__events.themeChanged?.();};
  ` });
  await cdp("Emulation.setDeviceMetricsOverride", { width: 375, height: 812, deviceScaleFactor: 1, mobile: true });
  await cdp("Page.navigate", { url: config.origin });
  await wait("Boolean(document.getElementById('family-name'))");
  await input("family-name", "Семья для проверки"); await click("Создать семью");
  await wait("Boolean(document.querySelector('.home-sections'))");
  await click('Вишлисты');
  await wait("Boolean(document.getElementById('wishlist-name'))");
  await input('wishlist-name','Аня'); await click('Создать');
  await wait("document.querySelector('.wishlist-heading h1')?.textContent==='Аня' && Boolean(document.getElementById('wish-title'))");
  const profileHash=await evaluate('location.hash');
  await input('wish-title','Книга'); await click('Добавить');
  await wait("document.querySelectorAll('.wishlist-items > li').length===1");
  await click('Редактировать: Книга');
  await wait("Boolean(document.getElementById('wish-edit-title'))");
  await input('wish-edit-title','Книга с красивыми иллюстрациями для всей семьи');
  await input('wish-url','https://example.com/book'); await input('wish-note','Твёрдая обложка и цветные иллюстрации');
  await evaluate("(() => { const e=document.querySelector('input[aria-label=Цена]'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'1234,50'); e.dispatchEvent(new Event('input',{bubbles:true})); })()");
  await evaluate("document.querySelector('dialog .pastel-select-field button').click()");
  await wait("Boolean(document.querySelector('dialog .pastel-select-options'))");
  await screenshot('wishlist-currency-menu.png');
  await evaluate("document.querySelector('dialog .pastel-select-options button').click()");
  await click('Сохранить');
  await wait("!document.querySelector('dialog') && Boolean(document.querySelector('.wishlist-item-meta a'))");
  assert.ok(await evaluate("document.querySelector('.wishlist-item-meta').textContent.includes('234,50')"));
  assert.equal(await evaluate("document.querySelector('.wishlist-item-meta a').getAttribute('rel')"),'noopener noreferrer');
  for(const width of [320,375,430,880]) {
    await cdp('Emulation.setDeviceMetricsOverride',{width,height:812,deviceScaleFactor:1,mobile:width<500});
    assert.ok(await evaluate('document.documentElement.scrollWidth<=innerWidth'),'Wishlist fits '+width);
    await screenshot('wishlist-items-'+width+'.png');
    await click('Редактировать: Книга с красивыми иллюстрациями для всей семьи');
    await wait("Boolean(document.querySelector('dialog'))");
    assert.ok(await evaluate("document.querySelector('dialog').getBoundingClientRect().right<=innerWidth"));
    assert.ok(await evaluate("document.querySelector('dialog').scrollWidth<=document.querySelector('dialog').clientWidth"),'Dialog fits '+width);
    await screenshot('wishlist-editor-'+width+'.png');
    await click('Отмена');
  }
  await evaluate("document.querySelector('.purchase-check input').click()");
  await wait("document.querySelectorAll('.wishlist-items > li').length===0");
  await click('Скрывать исполненные');
  await wait("Boolean(document.querySelector('.wishlist-items .completed-task'))");
  await evaluate("document.querySelector('.purchase-check input').click()");
  await wait("!document.querySelector('.wishlist-items .completed-task') && document.querySelector('.wishlists-screen').getAttribute('aria-busy')==='false'");
  await click('Переименовать вишлист'); await input('wishlist-rename','Анна'); await click('Сохранить');
  await wait("document.querySelector('.wishlist-heading h1').textContent==='Анна' && !document.querySelector('dialog')");
  await evaluate('window.__back()');
  await wait("Boolean(document.getElementById('wishlist-name'))");
  assert.ok(await evaluate("document.querySelector('.wishlist-profiles').textContent.includes('Анна')"));
  await cdp('Emulation.setDeviceMetricsOverride',{width:375,height:812,deviceScaleFactor:1,mobile:true});
  await screenshot('wishlist-profiles-375.png');
  await evaluate(`location.hash=${JSON.stringify(profileHash)}`);
  await wait("Boolean(document.getElementById('wish-title'))");
  await cdp('Page.reload');
  await wait("document.querySelectorAll('.wishlist-items > li').length===1");
  await click('Удалить вишлист'); await click('Отмена');
  assert.equal(await evaluate("document.querySelectorAll('.wishlist-items > li').length"),1);
  await click('Удалить вишлист'); await click('Удалить');
  await wait("Boolean(document.getElementById('wishlist-name')) && !document.querySelector('.wishlist-profiles')");
  assert.deepEqual(errors,[]);
  console.log('PASS: wishlists create, details, price, currency, complete/reopen, rename, back/reload, delete confirmation; responsive 320-880px');
} finally {
  socket?.close();
  if (browser && browser.exitCode === null && browser.signalCode === null) { const exited = once(browser, "exit"); if (browser.kill()) await Promise.race([exited, sleep(3000)]); }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close();
  assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
