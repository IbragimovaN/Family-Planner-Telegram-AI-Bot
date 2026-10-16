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

  await click("Список дел");
  await wait("Boolean(document.querySelector('.task-status-filter summary'))");
  for (const width of [320,375,430,880]) {
    await cdp('Emulation.setDeviceMetricsOverride', {width,height:900,deviceScaleFactor:1,mobile:width<500});
    for(let period=0;period<3;period++) {
      await evaluate(`document.querySelectorAll('.task-periods button')[${period}].click()`);
      await wait(`document.querySelectorAll('.task-periods button')[${period}].getAttribute('aria-pressed')==='true'`);
      await wait("!document.querySelector('.tasks-planner [role=status]:not(.sr-only)')");
      assert.equal(await evaluate("document.querySelectorAll('.task-quick-add .primary').length"),1);
      assert.equal(await evaluate("Boolean(document.querySelector('.task-date-navigation'))"),period!==2);
      assert.ok(await evaluate("document.documentElement.scrollWidth <= window.innerWidth"), 'Page fits '+width);
      await screenshot('tasks-ui-'+width+'-'+period+'.png');
      if (period === 1) {
        const firstDay = await evaluate("document.querySelector('.task-week section').dataset.dropDay");
        const nextWeek = new Date(firstDay + 'T12:00:00Z'); nextWeek.setUTCDate(nextWeek.getUTCDate() + 7);
        await evaluate("document.querySelector('.task-date-navigation > button:last-child').click()");
        await wait(`document.querySelector('.task-week section')?.dataset.dropDay===${JSON.stringify(nextWeek.toISOString().slice(0,10))}`);
        await evaluate("document.querySelector('.task-date-navigation > button:first-child').click()");
        await wait(`document.querySelector('.task-week section')?.dataset.dropDay===${JSON.stringify(firstDay)}`);
      }
      if(period>0) {
        await evaluate("document.querySelectorAll('.task-date-modes button')[1].click()");
        await wait("document.querySelectorAll('.task-date-modes button')[1].getAttribute('aria-pressed')==='true'");
        await wait("!document.querySelector('.tasks-planner [role=status]:not(.sr-only)')");
        await screenshot('tasks-ui-'+width+'-'+period+'-undated.png');
        await evaluate("document.querySelectorAll('.task-date-modes button')[0].click()");
      }
    }
  }
  await cdp('Emulation.setDeviceMetricsOverride', {width:375,height:900,deviceScaleFactor:1,mobile:true});
  await evaluate("document.querySelectorAll('.task-periods button')[0].click()");
  await wait("!document.querySelector('.tasks-planner [role=status]:not(.sr-only)')");
  await evaluate("document.querySelector('.task-quick-add button').click()");
  await wait("Boolean(document.querySelector('dialog fieldset input'))");
  await evaluate("document.querySelector('dialog .pastel-select-field button').click()");
  await wait("document.querySelectorAll('dialog .pastel-select-options button').length===3");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('dialog .pastel-select-options')).gap"), "8px");
  await evaluate("document.querySelector('dialog .pastel-select-options button').click()");
  await evaluate("(() => { const e=document.querySelector('dialog fieldset input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Проверить новую карточку'); e.dispatchEvent(new Event('input',{bubbles:true})); })()");
  await click("Сохранить");
  await wait("document.querySelectorAll('.planner-task-list li').length===1 && !document.querySelector('dialog')");
  await screenshot('tasks-ui-375-populated.png');
  await evaluate("document.querySelector('.planner-task-list input[type=checkbox]').click()");
  await wait("document.querySelectorAll('.planner-task-list li').length===0");
  await evaluate("document.querySelector('.task-status-filter summary').click()");
  await wait("document.querySelector('.task-status-filter').open");
  assert.equal(await evaluate("getComputedStyle(document.querySelector('.task-status-filter .task-owner-options')).gap"), "8px");
  await screenshot('tasks-status-menu.png');
  await evaluate("document.querySelectorAll('.task-status-filter button')[1].click()");
  assert.equal(await evaluate("document.querySelector('.task-status-filter').open"), false);
  await wait("Boolean(document.querySelector('.planner-task-list .completed-task'))");
  await evaluate("document.querySelector('.task-card-menu').click()");
  await wait("Boolean(document.querySelector('dialog'))");
  await click("Закрыть");
  await evaluate("(() => {const e=document.querySelector('.task-quick-add input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'Быстрое дело'); e.dispatchEvent(new Event('input',{bubbles:true}));})()");
  await evaluate("document.querySelector('.task-add').click()");
  await wait("document.querySelectorAll('.planner-task-list li').length===2");
  assert.equal(await evaluate("document.querySelector('.task-quick-add input').value"), "");
  await click("Добавить с AI");
  await wait("Boolean(document.querySelector('#task-phrase'))");
  await click("Отмена");
  await evaluate("document.querySelectorAll('.task-periods button')[1].click()");
  await wait("Boolean(document.querySelector('.task-week li[draggable=true]'))");
  const targetDay = await evaluate("document.querySelector('.task-week section:last-child').dataset.dropDay");
  await evaluate("(() => {const card=document.querySelector('.task-week li[draggable=true]'); const target=document.querySelector('.task-week section:last-child'); const dataTransfer=new DataTransfer(); card.dispatchEvent(new DragEvent('dragstart',{bubbles:true,dataTransfer})); target.dispatchEvent(new DragEvent('dragover',{bubbles:true,cancelable:true,dataTransfer}));})()");
  await wait("Boolean(document.querySelector('.task-drop-active'))");
  await evaluate("document.querySelector('.task-week section:last-child').dispatchEvent(new DragEvent('drop',{bubbles:true,cancelable:true,dataTransfer:new DataTransfer()}))");
  await wait("document.querySelector('.task-week section:last-child').textContent.includes('Быстрое дело') && document.querySelector('.tasks-planner').getAttribute('aria-busy')==='false'");
  await evaluate("document.querySelector('.task-week section:last-child .task-card-menu').click()");
  await wait(`document.querySelector('dialog')?.textContent.includes(${JSON.stringify(targetDay)})`);
  await click("Закрыть");
  assert.deepEqual(errors, []);
  console.log('PASS: all task modes and mobile widths; screenshots in .checks.local');
} finally {
  socket?.close();
  if (browser && browser.exitCode === null && browser.signalCode === null) { const exited = once(browser, "exit"); if (browser.kill()) await Promise.race([exited, sleep(3000)]); }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close();
  assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep));
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

