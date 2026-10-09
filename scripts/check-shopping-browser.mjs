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
  await evaluate("document.documentElement.style.setProperty('--tg-safe-area-inset-top','20px'); document.documentElement.style.setProperty('--tg-content-safe-area-inset-top','10px')");
  assert.equal(await evaluate("getComputedStyle(document.getElementById('root')).paddingTop"), "30px");
  await evaluate("Telegram.WebApp.viewportStableHeight=600; window.__events.viewportChanged()");
  assert.equal(await evaluate("getComputedStyle(document.getElementById('root')).minHeight"), "600px");
  await evaluate("document.documentElement.style.removeProperty('--tg-safe-area-inset-top'); document.documentElement.style.removeProperty('--tg-content-safe-area-inset-top'); Telegram.WebApp.viewportStableHeight=780; window.__events.viewportChanged()");
  assert.equal(await evaluate("document.querySelectorAll('.home-sections button').length"), 4);
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.home-sections')).gridTemplateColumns.split(' ').length"), 2);
  for (const width of [320, 375, 430]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: 812, deviceScaleFactor: 1, mobile: true });
    for (const dark of [false, true]) {
      await evaluate(`window.__theme(${dark})`);
      assert.ok(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), `Home fits ${width}`);
      await screenshot(`home-${width}-${dark ? "dark" : "light"}.png`);
    }
  }
  await click("Продукты"); await wait("Boolean(document.querySelector('.shopping-screen'))");
  await wait("window.__backVisible === true");
  await wait("Boolean(document.getElementById('purchase-add-title'))");
  await input("purchase-add-title", "Молоко");
  await cdp("Emulation.setDeviceMetricsOverride", { width: 320, height: 812, deviceScaleFactor: 1, mobile: true });
  assert.ok(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), "Form fits 320px");
  await screenshot("shopping-form-320.png");
  await click("Добавить"); await wait("document.querySelectorAll('.shopping-items > li').length===1");
  const rowGeometry = "JSON.stringify({row:document.querySelector('.shopping-items > li').getBoundingClientRect().toJSON(),input:document.querySelector('.purchase-title').getBoundingClientRect().toJSON(),scroll:window.scrollY})";
  const beforeEdit = await evaluate(rowGeometry);
  await evaluate("void (window.__purchaseField=document.querySelector('.purchase-title'))");
  await click("Редактировать: Молоко");
  await wait("Boolean(document.querySelector('.purchase-edit-row button[aria-label=\"Сохранить\"]'))");
  assert.equal(await evaluate(rowGeometry), beforeEdit, "Editing preserves row/input geometry and scroll position");
  assert.ok(await evaluate("window.__purchaseField===document.getElementById('purchase-title')"), "Editing reuses the same input element");
  await input("purchase-title", "Кефир"); await click("Сохранить");
  await wait("document.querySelector('.purchase-title')?.value==='Кефир' && document.querySelector('.purchase-title').readOnly");
  await evaluate("document.querySelector('.purchase-check input').click()");
  await wait("document.querySelectorAll('.shopping-items > li').length===0");
  await click("Показать все"); await wait("document.querySelectorAll('.shopping-items > li').length===1");
  assert.equal(await evaluate("document.querySelector('.purchase-check input').checked"), true);
  for (const width of [320, 375, 430]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: 812, deviceScaleFactor: 1, mobile: true });
    for (const dark of [false, true]) {
      await evaluate(`window.__theme(${dark})`);
      assert.ok(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), `Shopping fits ${width}`);
      await screenshot(`shopping-${width}-${dark ? "dark" : "light"}.png`);
    }
  }
  await click("Закрыть список"); await wait("Boolean(document.querySelector('dialog[open]'))");
  assert.equal(await evaluate("document.activeElement.textContent"), "Отмена");
  await evaluate("window.__back()"); await wait("!document.querySelector('dialog[open]')");
  await click("Закрыть список"); await wait("Boolean(document.querySelector('dialog[open]'))");
  await cdp("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await cdp("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await wait("!document.querySelector('dialog[open]')");
  await click("Закрыть список"); await wait("Boolean(document.querySelector('dialog[open]'))");
  await screenshot("confirmation.png");
  await evaluate("document.querySelector('dialog .danger').click()");
  await wait("!document.querySelector('dialog[open]') && document.querySelectorAll('.shopping-items > li').length===0");
  await click("История"); await wait("document.querySelectorAll('.shopping-history li').length===1");
  await evaluate("document.querySelector('.shopping-history button').click()");
  await wait("document.querySelector('.shopping-screen h1')?.textContent==='Закрытый список'");
  assert.equal(await evaluate("document.querySelectorAll('.shopping-items input').length"), 0);
  assert.ok(await evaluate("document.querySelector('.shopping-items').textContent.includes('Кефир')"));
  await click("Удалить закрытый список"); await wait("Boolean(document.querySelector('dialog[open]'))");
  await evaluate("document.querySelector('dialog .danger').click()");
  await wait("document.querySelector('.shopping-screen')?.textContent.includes('История пока пуста')");
  await evaluate("window.__back()"); await wait("location.hash==='#/shopping'");
  await wait("Boolean(document.getElementById('purchase-add-title'))"); await input("purchase-add-title", "Не потерять черновик");
  await evaluate(`(async () => {
    const {list}=await (await fetch('/api/shopping-lists/current')).json();
    await fetch('/api/shopping-lists/current/close',{method:'POST',headers:{'Content-Type':'application/json','X-Family-Planner':'1'},body:JSON.stringify({listId:list.id})});
    window.dispatchEvent(new Event('focus'));
  })()`);
  await wait("document.body.textContent.includes('Другой участник закрыл список')");
  assert.equal(await evaluate("document.getElementById('purchase-add-title').value"), "Не потерять черновик");
  await click("Добавить в новый список"); await click("Добавить");
  await wait("document.querySelector('.purchase-title')?.value==='Не потерять черновик'");
  await click("Удалить: Не потерять черновик");
  await wait("!document.querySelector('dialog[open]') && document.querySelectorAll('.shopping-items > li').length===0");
  await evaluate("window.__back()"); await wait("Boolean(document.querySelector('.home-sections'))");
  assert.equal(await evaluate("window.__backVisible"), false);
  await click("Покупки"); await wait("Boolean(document.querySelector('.purchases-screen #purchase-add-title'))");
  assert.ok(await evaluate("![...document.querySelectorAll('.shopping-screen button')].some(b=>['История','Закрыть список'].includes(b.textContent.trim()))"));
  await input("purchase-add-title", "Лампа"); await click("Добавить");
  await wait("document.querySelector('.purchase-title')?.value==='Лампа'");
  await click("Редактировать: Лампа"); await input("purchase-title", "Настольная лампа"); await click("Сохранить");
  await wait("document.querySelector('.purchase-title')?.value==='Настольная лампа' && document.querySelector('.purchase-title').readOnly");
  await evaluate("document.querySelector('.purchase-check input').click()");
  await wait("document.querySelectorAll('.shopping-items > li').length===0");
  await click("Показать все"); await wait("document.querySelectorAll('.shopping-items > li').length===1");
  for (const width of [320,375,430]) {
    await cdp("Emulation.setDeviceMetricsOverride", { width, height: 812, deviceScaleFactor: 1, mobile: true });
    for (const dark of [false,true]) {
      await evaluate(`window.__theme(${dark})`);
      assert.ok(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"));
      await screenshot(`purchases-${width}-${dark ? 'dark' : 'light'}.png`);
    }
  }
  await evaluate("window.__back()"); await wait("Boolean(document.querySelector('.home-sections'))");
  await click("Покупки"); await wait("Boolean(document.querySelector('.purchases-screen #purchase-add-title'))");
  assert.equal(await evaluate("document.querySelectorAll('.shopping-items > li').length"), 0, "Bought hidden on re-entry");
  await click("Показать все"); await click("Удалить: Настольная лампа");
  await wait("document.querySelectorAll('.shopping-items > li').length===0");
  assert.deepEqual(errors, []);
  console.log("PASS: mobile widths/themes, Telegram back, purchases CRUD, close, readonly history, delete; screenshots: .checks.local");
} finally {
  socket?.close();
  if (browser && browser.exitCode === null && browser.signalCode === null) { const exited = once(browser, "exit"); if (browser.kill()) await Promise.race([exited, sleep(3000)]); }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close();
  assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
