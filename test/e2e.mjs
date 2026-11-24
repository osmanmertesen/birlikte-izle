// İki ayrı Chrome (iki kişi gibi), ikisinde de eklenti; aynı YouTube videosu.
import { chromium } from "playwright";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { ROOT, relayFromEnv } from "../scripts/env.mjs";
import WebSocket from "ws";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const EXT = path.join(ROOT, "extension");
const RELAY = relayFromEnv("RELAY") || relayFromEnv("TEST_RELAY_URL") || "ws://127.0.0.1:8787";
const VIDEO = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
const OTHER = "https://www.youtube.com/watch?v=eRsGyueVLvQ";
const ROOM = "test" + Math.random().toString(36).slice(2, 8);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = "") => { results.push({ name, ok, info }); console.log(`${ok ? "OK  " : "FAIL"} ${name} ${info}`); };
let nextPort = 9333;
const T0 = Date.now();

async function person(name) {
  const dir = path.resolve("profile-" + name);
  fs.rmSync(dir, { recursive: true, force: true });
  const port = nextPort++;
  const proc = spawn(CHROME, [
    `--user-data-dir=${dir}`, `--remote-debugging-port=${port}`, "--enable-unsafe-extension-debugging",
    "--headless=new", "--user-agent=Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36", "--autoplay-policy=no-user-gesture-required", "--mute-audio", "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--no-first-run",
    "--no-default-browser-check", "--window-size=1280,720", "--lang=tr-TR", "about:blank",
  ], { stdio: "ignore" });
  let browser;
  for (let i = 0; i < 40 && !browser; i++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); } catch { await sleep(500); }
  }
  if (!browser) throw new Error(name + ": Chrome'a bağlanılamadı");
  const cdp = await browser.newBrowserCDPSession();
  const { id: extId } = await cdp.send("Extensions.loadUnpacked", { path: EXT });
  const ctx = browser.contexts()[0];
  const yt = ctx.pages()[0] || (await ctx.newPage());
  return { name, ctx, browser, proc, extId, yt, port };
}

async function openVideo(p, url) {
  await p.yt.goto(url, { waitUntil: "domcontentloaded" });
  for (let i = 0; i < 5; i++) {
    const btn = p.yt.locator('button:has-text("Tümünü reddet"), button:has-text("Reject all")').first();
    if (await btn.isVisible().catch(() => false)) { await btn.click(); break; }
    await sleep(1000);
  }
  await p.yt.waitForSelector("video", { timeout: 30000, state: "attached" });
  await waitNoAd(p, 60000);
}
const inAd = (p) => p.yt.evaluate(() => !!document.querySelector("#movie_player.ad-showing"));
async function waitNoAd(p, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!(await inAd(p))) return true;
    await p.yt.evaluate(() => document.querySelector(".ytp-skip-ad-button, .ytp-ad-skip-button-modern")?.click());
    await sleep(1000);
  }
  return false;
}
const vstate = (p) => p.yt.evaluate(() => {
  const p = document.getElementById("movie_player");
  return p && p.getCurrentTime ? { t: p.getCurrentTime(), playing: p.getPlayerState() === 1, ad: p.classList.contains("ad-showing") } : null;
});

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
  p.panel.on("console", (m) => { if (m.text().startsWith("[bi]")) console.log(`  ${((Date.now() - T0) / 1000).toFixed(1)}s ${p.name}`, m.text()); });
  p.panel.on("pageerror", (e) => console.log(`[${p.name} panel HATA]`, e.message));
  await p.panel.goto(`chrome-extension://${p.extId}/sidepanel.html`);
  if (p.name === "Ada") {
    // .env → config.js: panelde varsayılan sunucu adresi bu olmalı (koda gömülü değil)
    const want = relayFromEnv("RELAY_URL");
    await p.panel.waitForFunction(() => document.getElementById("server").value !== "" || !self.BI_CONFIG || !self.BI_CONFIG.relayUrl, null, { timeout: 5000 }).catch(() => {});
    const got = await p.panel.evaluate(() => ({ v: document.getElementById("server").value, cfg: !!self.BI_CONFIG && Object.isFrozen(self.BI_CONFIG) }));
    check("Sunucu adresi .env/config.js'ten geliyor", got.cfg && got.v === want, `config=${got.cfg} eşleşiyor=${got.v === want}`);
  }
  await p.panel.fill("#server", RELAY);
  await p.panel.fill("#name", p.name);
  await p.panel.fill("#room", ROOM);
  await p.panel.click("#connect");
  await p.panel.waitForSelector("#live:not([hidden])"); // bağlantı komutu çekirdeğe ulaştı
  // Gerçekte yan panel video sekmesinin yanında açılır; testte panel ayrı sekme olduğundan video sekmesini elle bağla
  await p.panel.evaluate(async () => {
    const me = await chrome.tabs.getCurrent();
    const tabs = (await chrome.tabs.query({})).filter((t) => t.id !== me.id);
    await chrome.runtime.sendMessage({ __biEngine: true, cmd: "bind", tabId: tabs[0].id, win: tabs[0].windowId });
  });
  await p.yt.bringToFront();
}
const settle = async () => { await waitNoAd(A, 120000); await waitNoAd(B, 120000); await sleep(4000); };
const chatText = (p) => p.panel.locator("#chat").innerText();

let A, B;
try {
  A = await person("Ada");
  B = await person("Bora");
  console.log("Eklenti yüklendi:", A.extId, B.extId);

  await openVideo(A, VIDEO);
  await A.yt.evaluate(() => { const p = document.getElementById("movie_player"); p.seekTo(30, true); p.playVideo(); });
  await openPanel(A);
  await sleep(4000);
  console.log("A durumu:", await vstate(A));

  // 1) Sonradan katılma
  await openVideo(B, VIDEO);
  await B.yt.evaluate(() => { document.getElementById("movie_player").seekTo(5, true); });
  await openPanel(B);
  await sleep(6000);
  let a = await vstate(A), b = await vstate(B);
  check("Katılan kişi aynı konuma geldi", Math.abs(a.t - b.t) < 1.5 && a.playing === b.playing, `A=${a.t.toFixed(1)} B=${b.t.toFixed(1)} oynuyor A=${a.playing} B=${b.playing}`);

  // 2) Durdur
  await A.yt.evaluate(() => document.getElementById("movie_player").pauseVideo());
  await sleep(2500);
  b = await vstate(B);
  check("A durdurunca B de durdu", !b.playing, `B oynuyor=${b.playing}`);

  // 3) Sarma
  await A.yt.evaluate(() => { document.getElementById("movie_player").seekTo(120, true); });
  await sleep(1500); await settle();
  a = await vstate(A); b = await vstate(B);
  check("A 2:00'a sarınca B de sardı", b.t >= 118 && Math.abs(a.t - b.t) < 1.5, `A=${a.t.toFixed(1)} B=${b.t.toFixed(1)}`);

  // 4) B oynatır
  await B.yt.evaluate(() => document.getElementById("movie_player").playVideo());
  await sleep(1500); await settle();
  a = await vstate(A); b = await vstate(B);
  check("B oynatınca A da oynadı", a.playing && b.playing, `A oynuyor=${a.playing}`);

  // 5) Kayma
  await sleep(8000); await settle();
  a = await vstate(A); b = await vstate(B);
  check("10 sn sonra fark < 1 sn", Math.abs(a.t - b.t) < 1.0 && a.playing && b.playing, `A=${a.t.toFixed(2)} B=${b.t.toFixed(2)} fark=${Math.abs(a.t - b.t).toFixed(2)}`);

  // 6) Döngü yok
  const before = (await chatText(A)).split("\n").length;
  await sleep(8000);
  const after = (await chatText(A)).split("\n").length;
  check("Kendi kendine sarma/durdurma döngüsü yok", after - before <= 1, `8 sn'de ${after - before} yeni sistem mesajı`);

  // 7) Sohbet
  await A.panel.fill("#chatInput", "merhaba dünya");
  await A.panel.click("#chatForm button");
  await sleep(1500);
  check("Mesaj karşıya ulaştı", (await chatText(B)).includes("merhaba dünya"));
  check("Mesaj videonun üstünde göründü", await B.yt.evaluate(() => document.body.innerText.includes("Ada: merhaba dünya")));

  console.log("---- ADIM 8 ----");
  // 8) Farklı video
  await openVideo(B, OTHER);
  await sleep(1000);
  await A.yt.evaluate(() => { document.getElementById("movie_player").seekTo(200, true); });
  await sleep(5000);
  b = await vstate(B);
  check("B farklı videodayken uyarı çıktı", await B.panel.evaluate(() => !document.getElementById("mismatch").hidden));
  check("Farklı videodaki B'ye sarma uygulanmadı", Math.abs(b.t - 200) > 5, `B=${b.t.toFixed(1)}`);

  console.log("---- ADIM 9 ----");
  // 9) Onun videosunu aç
  await B.panel.click("#mmOpen");
  await sleep(3000);
  await B.yt.waitForSelector("video", { state: "attached" });
  await settle(); await sleep(3000);
  a = await vstate(A); b = await vstate(B);
  check("'Onun videosunu aç' sonrası eşitlendi", B.yt.url().includes("aqz-KE-bpKQ") && Math.abs(a.t - b.t) < 1.5, `A=${a.t.toFixed(1)} B=${b.t.toFixed(1)}`);
  // 10) Sesli sohbet (sahte mikrofonla)
  // Sahte mikrofon bip sesi çıkarır; RNNoise onu "gürültü" sayıp siler. Akış testleri için kapat, sonda ayrıca test et.
  for (const p of [A, B]) await p.panel.evaluate(() => { const c = document.getElementById("ai"); c.checked = false; c.dispatchEvent(new Event("change")); });
  await A.panel.click("#mic"); await B.panel.click("#mic");
  await sleep(5000);
  const va = await eng(A, () => ({ mic: !!S.mic, tx: S.auTx || 0, key: !!S.audioKey }));
  const vb = { ...(await eng(B, () => ({ mic: !!S.mic, rx: S.auRx || 0, players: S.players ? S.players.size : 0 }))), info: await B.panel.evaluate(() => document.getElementById("voiceInfo").textContent) };
  check("Sesli sohbet relay üzerinden bağlandı", va.mic && vb.mic && va.key && va.tx > 20 && vb.rx > 20 && vb.players === 1, JSON.stringify({ va, vb }));
  const rx1 = await eng(B, () => S.auRx || 0); await sleep(3000); const rx2 = await eng(B, () => S.auRx || 0);
  const pps = (rx2 - rx1) / 3;
  check("Ses akışı sürekli (~25 paket/sn)", pps > 18 && pps < 35, `${pps.toFixed(1)} paket/sn`);
  const q = { ctx: await eng(B, () => S.actx && S.actx.state) };
  // Güvenlik: yanlış anahtarla şifrelenmiş / bozuk / tanımadık kişiden gelen paket çalınmamalı
  const sec = await eng(B, async () => {
    const peerId = [...S.peers.keys()][0];
    const before = S.auRx || 0;
    const mk = async (id, key, payload) => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, payload));
      const out = new Uint8Array(8 + 12 + ct.length);
      out.set(new TextEncoder().encode(id.padEnd(8, "_").slice(0, 8))); out.set(iv, 8); out.set(ct, 20);
      return out.buffer;
    };
    const wrong = await deriveKey("baska-oda-kodu");
    const good = new Uint8Array([1, 0, 1, 1, 0, 3, 252, 255, 254]);
    onAudio(await mk(peerId, wrong, good));                         // yanlış oda anahtarı
    onAudio(await mk("zzzzzzzz", S.audioKey, good));                // odada olmayan kişi
    onAudio(await mk(peerId, S.audioKey, new Uint8Array([1, 0, 1, 6, 0, 200, 1]))); // bozuk uzunluk
    onAudio(await mk(peerId, S.audioKey, new Uint8Array([9, 0, 1, 1, 0, 1, 1])));   // bilinmeyen sürüm
    onAudio(new ArrayBuffer(5000));                                 // çok büyük
    onAudio("metin");                                               // yanlış tür
    const pa = [parseAudio(new Uint8Array([1, 0, 0, 0])), parseAudio(new Uint8Array([1, 0, 0, 1, 0xff, 0xff, 1])), parseAudio(new Uint8Array([1, 0, 0, 1, 0, 1, 7, 99]))];
    return { pa: pa.every((x) => x === null), ok: !!parseAudio(good) };
  });
  check("Ses güvenliği: yanlış anahtar/bozuk/yabancı paketler reddediliyor", sec.pa && sec.ok, JSON.stringify(sec));
  const outPeak = await eng(B, async () => {
    const an = S.actx.createAnalyser(); an.fftSize = 2048; S.outGain.connect(an);
    let peak = 0; const buf = new Float32Array(2048);
    for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 100)); an.getFloatTimeDomainData(buf); for (const x of buf) peak = Math.max(peak, Math.abs(x)); }
    return peak;
  });
  check("Gelen ses hoparlöre gidiyor ve ses motoru çalışıyor", outPeak > 0.01 && q.ctx === "running", `hoparlör tepe=${outPeak.toFixed(3)}`);
  await A.panel.evaluate(() => { const g = document.getElementById("gain"); g.value = 3; g.dispatchEvent(new Event("input")); });
  let gv; // panel → çekirdek mesajı eşzamansız: 2 sn'ye kadar bekle
  for (let i = 0; i < 20 && gv !== 3; i++) { await sleep(100); gv = await eng(A, () => S.micNodes && S.micNodes.gate.parameters.get("gain").value); }
  check("Mikrofon gücü ayarı uygulanıyor", gv === 3, `gain=${gv}`);
  await A.panel.evaluate(() => { const c = document.getElementById("ns"); c.checked = false; c.dispatchEvent(new Event("change")); });
  await sleep(3000);
  const ns = await eng(A, () => ({ ns: S.raw && S.raw.getAudioTracks()[0].getSettings().noiseSuppression, mic: !!S.mic }));
  const bytes2 = await eng(B, () => S.auRx || 0);
  await sleep(2000);
  const bytes3 = await eng(B, () => S.auRx || 0);
  check("Gürültü engelleme kapatılınca ses kesilmeden devam ediyor", ns.mic && ns.ns === false && bytes3 > bytes2, JSON.stringify(ns));
  // 11) Limitör ve gürültü kapısı (A'nın gönderdiği sesi ölç)
  const outPeakA = (ms) => eng(A, async (ms) => {
    const an = S.actx.createAnalyser(); an.fftSize = 2048; S.micNodes.limiter.connect(an);
    let peak = 0; const buf = new Float32Array(2048);
    for (let t = 0; t < ms; t += 50) { await new Promise((r) => setTimeout(r, 50)); an.getFloatTimeDomainData(buf); for (const x of buf) peak = Math.max(peak, Math.abs(x)); }
    S.micNodes.limiter.disconnect(an);
    return peak;
  }, ms);
  await A.panel.evaluate(() => { const g = document.getElementById("gain"); g.value = 4; g.dispatchEvent(new Event("input")); });
  await eng(A, () => S.micNodes.gate.parameters.get("gain").value = 8); // UI'dan bile fazla: 8x
  const lim = await outPeakA(3000);
  const red = await eng(A, () => S.meter.reduction);
  check("Limitör: 8x güçte bile ses -1 dB tavanını aşmıyor", lim > 0.3 && lim <= 0.8913, `tepe=${lim.toFixed(3)} (tavan 0.891) kısma=${red.toFixed(1)} dB`);
  await A.panel.evaluate(() => { const g = document.getElementById("gain"); g.value = 1.5; g.dispatchEvent(new Event("input")); });
  await eng(A, () => S.micNodes.gate.parameters.get("threshold").value = 0); // her sesi eşiğin altında say
  await sleep(2000); // 300 ms bekleme + yumuşak kapanma bitsin
  const gated = await outPeakA(2500);
  const gs = await A.panel.evaluate(() => document.getElementById("gateState").textContent);
  check("Gürültü kapısı: eşiğin altındaki ses gönderilmiyor", gated < 0.005, `tepe=${gated.toFixed(4)} durum="${gs}"`);
  const tx1 = await eng(A, () => S.auTx || 0); await sleep(2000); const tx2 = await eng(A, () => S.auTx || 0);
  check("Kapı kapalıyken hiç ses paketi gönderilmiyor (ücretsiz kota korunuyor)", tx2 === tx1, `${tx2 - tx1} paket/2sn`);
  await A.panel.evaluate(() => { const g = document.getElementById("gate"); g.value = -60; g.dispatchEvent(new Event("input")); });
  await sleep(500);
  const passed = await outPeakA(2500);
  check("Gürültü kapısı: eşiğin üstündeki ses geçiyor", passed > 0.05, `tepe=${passed.toFixed(3)}`);
  await A.panel.click("#calibrate");
  await sleep(3800);
  const cal = { db: await eng(A, () => S.gateDb), ...(await A.panel.evaluate(() => ({ ui: document.getElementById("gateVal").textContent, btn: document.getElementById("calibrate").disabled }))) };
  check("Ortam sesini ölç eşiği ayarladı", cal.db >= -75 && cal.db <= -25 && !cal.btn, JSON.stringify(cal));
  // 12) Yapay zekâ gürültü engelleme (RNNoise) zincire girdi mi? (Konuşma/gürültü ayrımı rnnoise.mjs'de, gerçek kayıtlarla test ediliyor)
  await A.panel.evaluate(() => { const c = document.getElementById("ai"); c.checked = true; c.dispatchEvent(new Event("change")); });
  await sleep(2500);
  const aiInfo = await eng(A, () => ({ rnn: !!(S.micNodes && S.micNodes.rnn), wasm: S.rnnWasm ? S.rnnWasm.byteLength : 0, mic: !!S.mic }));
  check("RNNoise eklentinin içinden yüklendi", aiInfo.rnn && aiInfo.wasm > 100000 && aiInfo.mic, JSON.stringify(aiInfo));
  const b1 = await eng(B, () => S.auRx || 0);
  await sleep(2000);
  const b2 = await eng(B, () => S.auRx || 0);
  check("RNNoise açıkken ses bağlantısı sürüyor", b2 > b1 && !(await chatText(A)).includes("yüklenemedi"), `${b2 - b1} paket/2sn`);
  // 13) Panel kapatılınca çekirdek çalışmaya devam ediyor (tam ekranda panel kendini gizler)
  await A.panel.close(); await B.panel.close();
  await sleep(1500);
  await A.yt.evaluate(() => document.getElementById("movie_player").pauseVideo());
  await sleep(3000);
  b = await vstate(B);
  const r1 = await eng(B, () => S.auRx || 0); await sleep(2000); const r2 = await eng(B, () => S.auRx || 0);
  check("Panel kapalıyken senkron sürüyor", !b.playing, `B oynuyor=${b.playing}`);
  check("Panel kapalıyken ses sürüyor", r2 - r1 > 30, `${r2 - r1} paket/2sn`);
  // Panel yeniden açılınca durumu ve sohbet geçmişini çekirdekten alır
  A.panel = await A.ctx.newPage();
  await A.panel.goto(`chrome-extension://${A.extId}/sidepanel.html`);
  await sleep(1500);
  const re = await A.panel.evaluate(() => ({ live: !document.getElementById("live").hidden, chat: document.getElementById("chat").innerText, mic: document.getElementById("mic").textContent }));
  check("Panel yeniden açılınca kaldığı yerden devam ediyor (sohbet geçmişi + mikrofon)", re.live && re.chat.includes("merhaba dünya") && re.mic.includes("açık"), JSON.stringify({ live: re.live, mic: re.mic }));
} catch (e) {
  console.log("TEST HATASI:", e.message);
} finally {
  if (A?.panel) console.log("\n--- A panel ---\n" + (await chatText(A).catch(() => "")));
  if (B?.panel) console.log("\n--- B panel ---\n" + (await chatText(B).catch(() => "")));
  console.log(`\nSONUC: ${results.filter((r) => r.ok).length}/${results.length} gecti`);
  for (const p of [A, B]) { try { p.proc.kill(); } catch {} }
  process.exit(0);
}
