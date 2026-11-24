// "Tüm sitelerde" modu + iç çerçeve + ele geçirme + kötü niyetli katılımcı testleri.
import { chromium } from "playwright";
import { spawn } from "child_process";
import http from "http";
import fs from "fs";
import path from "path";
import { ROOT, relayFromEnv } from "../scripts/env.mjs";
import WebSocket from "ws";

const SRC_EXT = path.join(ROOT, "extension");
const RELAY = relayFromEnv("RELAY") || relayFromEnv("TEST_RELAY_URL") || "ws://127.0.0.1:8787";
const VIDEO = "https://archive.org/download/BigBuckBunny_124/Content/big_buck_bunny_720p_surround.mp4";
const ROOM = "site" + Math.random().toString(36).slice(2, 10);
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = "") => { results.push(ok); console.log(`${ok ? "OK  " : "FAIL"} ${name} ${info}`); };

// Test eklentisi: aynı kod, sadece "tüm siteler" izni kurulumda verilmiş (Chrome izin penceresine otomatik tıklanamıyor)
const EXT = path.resolve("ext-allsites");
fs.rmSync(EXT, { recursive: true, force: true });
fs.cpSync(SRC_EXT, EXT, { recursive: true });
const man = JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8"));
man.host_permissions = ["https://*/*", "http://*/*"];
fs.writeFileSync(path.join(EXT, "manifest.json"), JSON.stringify(man, null, 2));

// Yerel test sitesi: 127.0.0.1 ana sayfa, localhost iç çerçeve (farklı köken = cross-origin iframe)
const pages = {
  "/top.html": `<!doctype html><title>Film sitesi</title><h1>Herhangi bir film sitesi</h1>
    <iframe id="pl" src="http://localhost:8899/player.html" width="900" height="520" allow="autoplay; fullscreen"></iframe>`,
  "/player.html": `<!doctype html><body style="margin:0"><video id="v" src="${VIDEO}" width="880" height="495" controls preload="auto"></video></body>`,
  "/muted.html": `<!doctype html><title>Haber sitesi</title><h1>Haber</h1><video src="${VIDEO}" width="640" height="360" autoplay muted loop></video>`,
};
const server = http.createServer((q, s) => {
  const body = pages[q.url.split("?")[0]];
  s.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8" }); s.end(body || "yok");
}).listen(8899);

let nextPort = 9433;
async function person(name) {
  const dir = path.resolve("profile-site-" + name);
  fs.rmSync(dir, { recursive: true, force: true });
  const port = nextPort++;
  const proc = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [`--user-data-dir=${dir}`, `--remote-debugging-port=${port}`,
    "--enable-unsafe-extension-debugging", "--headless=new", `--user-agent=${UA}`, "--autoplay-policy=no-user-gesture-required",
    "--mute-audio", "--no-first-run", "--window-size=1280,800", "about:blank"], { stdio: "ignore" });
  let browser;
  for (let i = 0; i < 40 && !browser; i++) { try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(500); } }
  const { id: extId } = await (await browser.newBrowserCDPSession()).send("Extensions.loadUnpacked", { path: EXT });
  const ctx = browser.contexts()[0];
  const page = ctx.pages()[0] || (await ctx.newPage());
  return { name, ctx, proc, extId, page, port };
}
const frameOf = (p) => p.page.frames().find((f) => f.url().startsWith("http://localhost:8899/player"));
const vs = (p) => frameOf(p).evaluate(() => { const v = document.getElementById("v"); return { t: v.currentTime, playing: !v.paused }; });
const vdo = (p, js) => frameOf(p).evaluate(js);
async function eng(p, fn, arg) {
  if (!p.engWs) {
    let t;
    for (let i = 0; i < 20 && !t; i++) {
      const list = await (await fetch(`http://127.0.0.1:${p.port}/json/list`)).json();
      t = list.find((x) => x.url.endsWith("/engine.html"));
      if (!t) await sleep(500);
    }
    if (!t) throw new Error(p.name + ": çekirdek (engine.html) bulunamadı");
    p.engWs = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { p.engWs.once("open", r); p.engWs.once("error", j); });
    p.engId = 0; p.engWait = new Map();
    p.engWs.on("message", (d) => { const m = JSON.parse(d); const w = p.engWait.get(m.id); if (w) { p.engWait.delete(m.id); w(m); } });
  }
  const id = ++p.engId;
  const res = await new Promise((r) => {
    p.engWait.set(id, r);
    p.engWs.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression: `(${fn})(${JSON.stringify(arg ?? null)})`, awaitPromise: true, returnByValue: true } }));
  });
  if (res.result && res.result.exceptionDetails) throw new Error("çekirdek: " + JSON.stringify(res.result.exceptionDetails).slice(0, 300));
  const v = res.result && res.result.result;
  if (v && "unserializableValue" in v) return Number(v.unserializableValue); // -0, NaN, Infinity
  return v ? v.value : undefined;
}

async function openPanel(p) {
  p.panel = await p.ctx.newPage();
  p.panel.on("pageerror", (e) => console.log(`[${p.name} panel HATA]`, e.message));
  await p.panel.goto(`chrome-extension://${p.extId}/sidepanel.html`);
  await p.panel.fill("#server", RELAY);
  await p.panel.fill("#name", p.name);
  await p.panel.fill("#room", ROOM);
  await p.panel.click("#connect");
  await p.panel.waitForSelector("#live:not([hidden])"); // bağlantı komutu çekirdeğe ulaştı
  await p.panel.evaluate(async () => {
    const me = await chrome.tabs.getCurrent();
    const t = (await chrome.tabs.query({})).find((x) => x.id !== me.id && x.url.includes("top.html"));
    await chrome.runtime.sendMessage({ __biEngine: true, cmd: "bind", tabId: t.id, win: t.windowId });
  });
  await p.page.bringToFront();
}
const chatText = (p) => p.panel.locator("#chat").innerText();

let A, B, evil;
try {
  A = await person("Ada"); B = await person("Bora");
  console.log("tarayıcılar açıldı");
  for (const p of [A, B]) {
    await p.page.goto("http://127.0.0.1:8899/top.html", { timeout: 20000 });
    for (let i = 0; i < 20 && !frameOf(p); i++) await sleep(500);
    console.log(p.name, "çerçeveler:", p.page.frames().map((f) => f.url()).join(" | "));
    await frameOf(p).waitForSelector("#v", { timeout: 15000 });
    for (let i = 0; i < 40; i++) {
      const st = await vdo(p, () => { const v = document.getElementById("v"); return { rs: v.readyState, err: v.error && v.error.code, net: v.networkState }; });
      if (st.rs >= 2) break;
      if (i % 10 === 9) console.log(p.name, "video yükleniyor", JSON.stringify(st));
      await sleep(500);
    }
  }
  console.log("videolar hazır");
  const allSites = await (async () => { await openPanel(A); return A.panel.evaluate(() => P.allSites); })();
  check("Test eklentisinde 'tüm siteler' izni aktif", allSites === true);
  await vdo(A, () => { const v = document.getElementById("v"); v.currentTime = 20; v.play(); });
  await sleep(3000);

  // 1) Katılma (B'de video iç çerçevede, farklı kökende)
  await vdo(B, () => { document.getElementById("v").currentTime = 3; });
  await openPanel(B);
  await sleep(5000);
  let a = await vs(A), b = await vs(B);
  check("Genel sitede + iç çerçevede katılan aynı konuma geldi", Math.abs(a.t - b.t) < 1.5 && b.playing, `A=${a.t.toFixed(1)} B=${b.t.toFixed(1)} B oynuyor=${b.playing}`);
  const bFrame = await eng(B, () => S.frameId);
  check("Panel videonun iç çerçevesini buldu", typeof bFrame === "number" && bFrame !== 0, `frameId=${bFrame}`);

  // 2) Durdur + sar
  await vdo(A, () => document.getElementById("v").pause());
  await sleep(2000);
  b = await vs(B);
  check("A durdurunca B durdu (iç çerçeve)", !b.playing);
  await vdo(A, () => { document.getElementById("v").currentTime = 100; });
  await sleep(3000);
  b = await vs(B);
  check("A 1:40'a sarınca B de sardı (iç çerçeve)", Math.abs(b.t - 100) < 2, `B=${b.t.toFixed(1)}`);

  // 3) Mesaj iç çerçevedeki videonun üstünde görünüyor
  await A.panel.fill("#chatInput", "iframe testi");
  await A.panel.click("#chatForm button");
  await sleep(1200);
  check("Mesaj iç çerçevedeki videonun üstünde göründü", await frameOf(B).evaluate(() => document.body.innerText.includes("Ada: iframe testi")));

  // 4) Ele geçirme: A başka sekmede sessiz otomatik oynayan bir video açıyor
  const bBefore = await vs(B);
  const news = await A.ctx.newPage();
  await news.goto("http://127.0.0.1:8899/muted.html");
  await news.bringToFront();
  await sleep(5000);
  const aTabId = await eng(A, () => S.tabId);
  const aTab = await A.panel.evaluate(async (id) => (await chrome.tabs.get(id)).url, aTabId);
  b = await vs(B);
  check("Sessiz otomatik oynayan video senkronu ele geçiremedi", aTab.includes("top.html") && !b.playing && Math.abs(b.t - bBefore.t) < 1, `A bağlı sekme=${aTab.split("/").pop()} B=${b.t.toFixed(1)} oynuyor=${b.playing}`);
  await news.close();
  await A.page.bringToFront();

  // 5) Kötü niyetli katılımcı (oda kodunu bir şekilde öğrenmiş, eklenti kökenini taklit eden bir program)
  evil = await new Promise((res) => {
    const ws = new WebSocket(`${RELAY}/room/${ROOM}?name=Saldirgan`, { headers: { Origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" } });
    ws.on("open", () => res(ws));
  });
  await sleep(800);
  const aBefore = await vs(A);
  const now = Date.now();
  const bad = [
    { type: "chat", text: '<img src=x onerror="document.title=\'HACK\'">merhaba<script>document.title="HACK"</script>' },
    { type: "action", action: "seek", time: "abc", playing: true, sentAt: now },
    { type: "action", action: "seek", time: 1e12, playing: true, sentAt: now },
    { type: "action", action: "seek", time: -50, playing: true, sentAt: now },
    { type: "action", action: "rm -rf", time: 5, playing: true, sentAt: now },
    { type: "action", action: "seek", time: 5, playing: "evet", sentAt: now },
    { type: "react", emoji: "<b>x</b>" },
    { type: "ad", on: false, resume: { time: "x", sentAt: now } },
    { type: "tick", time: NaN, playing: true, sentAt: now },
  ];
  for (const m of bad) { evil.send(JSON.stringify(m)); await sleep(150); }
  await sleep(1500);
  const aAfter = await vs(A);
  const chatHtml = await A.panel.evaluate(() => document.getElementById("chat").innerHTML);
  const title = await A.panel.title();
  check("Sohbetteki HTML/JS çalışmadı, düz yazı olarak göründü", !/<img|<script/i.test(chatHtml) && chatHtml.includes("&lt;img") && title !== "HACK", `başlık="${title}"`);
  check("Sayfaya da HTML enjekte edilemedi", await frameOf(A).evaluate(() => !document.querySelector("img") && document.title !== "HACK") && await A.page.evaluate(() => !document.querySelector("body > img, div img")));
  check("Geçersiz zaman/komutlar videoyu oynatmadı/sarmadı", !aAfter.playing && Math.abs(aAfter.t - aBefore.t) < 0.5, `önce=${aBefore.t.toFixed(1)} sonra=${aAfter.t.toFixed(1)} oynuyor=${aAfter.playing}`);
  check("Sahte emoji gösterilmedi", !(await chatText(A)).includes("<b>x</b>"));

  // 6) Tehlikeli adres: farklı video + javascript: adresi → düğme gizli
  evil.send(JSON.stringify({ type: "action", action: "sync", time: 10, playing: false, sentAt: Date.now(), media: "kotu-video", url: "javascript:document.title='HACK'" }));
  await sleep(1200);
  const mm1 = await A.panel.evaluate(() => ({ warn: !document.getElementById("mismatch").hidden, btn: !document.getElementById("mmOpen").hidden }));
  check("javascript: adresi için 'videosunu aç' düğmesi gösterilmedi", mm1.warn && !mm1.btn, JSON.stringify(mm1));
  await A.panel.evaluate(() => document.getElementById("mmOpen").click());
  await sleep(800);
  check("Düğmeye zorla basılsa bile javascript: adresi açılmadı", (await A.page.url()).includes("top.html") && (await A.page.title()) !== "HACK");
  evil.send(JSON.stringify({ type: "action", action: "sync", time: 10, playing: false, sentAt: Date.now(), media: "baska", url: "https://kotu-site.example/film" }));
  await sleep(1200);
  const mm2 = await A.panel.evaluate(() => document.getElementById("mmOpen").textContent);
  check("Normal adreste düğme hangi siteye gideceğini gösteriyor", mm2.includes("kotu-site.example"), `"${mm2}"`);

  // 7) Çekirdek (offscreen) güvenliği
  const pageApi = await A.page.evaluate(() => typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function");
  const frameApi = await frameOf(A).evaluate(() => typeof chrome === "undefined" || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function");
  check("Web sayfası (ve iç çerçevesi) eklentinin çekirdeğine mesaj gönderemiyor", pageApi && frameApi);
  const rx0 = await eng(A, () => S.auRx || 0);
  for (let i = 0; i < 40; i++) { const b = Buffer.alloc(60 + i * 10); for (let k = 0; k < b.length; k++) b[k] = (Math.random() * 256) | 0; evil.send(b); }
  evil.send(Buffer.alloc(5000));
  await sleep(1500);
  const rx1 = await eng(A, () => ({ rx: S.auRx || 0, want: S.want, ws: S.ws && S.ws.readyState }));
  check("Odaya sızan birinin sahte/şifresiz ses paketleri çalınmadı, bağlantı sağlam", rx1.rx === rx0 && rx1.want && rx1.ws === 1, JSON.stringify(rx1));
  const log = await eng(A, () => S.log.length);
  check("Sohbet geçmişi sınırlı (bellek şişirilemez)", await (async () => { for (let i = 0; i < 40; i++) evil.send(JSON.stringify({ type: "chat", text: "x" + i })); await sleep(1500); const n = await eng(A, () => S.log.length); return n <= 300; })(), `kayıt=${log}`);
} catch (e) {
  console.log("TEST HATASI:", e.message);
} finally {
  console.log(`\nSONUC: ${results.filter(Boolean).length}/${results.length} gecti`);
  try { evil && evil.close(); } catch {}
  for (const p of [A, B]) { try { p.proc.kill(); } catch {} }
  server.close();
  process.exit(0);
}
