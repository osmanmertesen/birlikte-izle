// Çekirdek (görünmez "offscreen" sayfa): relay bağlantısı, senkron mantığı, sohbet ve sesli konuşma burada çalışır.
// Yan panel sadece arayüzdür; kapatılsa bile (örneğin tam ekranda) bağlantı, senkron ve ses devam eder.
// Offscreen sayfada sadece chrome.runtime var: sekmelere mesaj background.js üzerinden gider, ayarlar panelden gelir.

const S = {
  ws: null, want: false, me: null,
  peers: new Map(),        // id -> {id, name, voice, lastAudio}
  leader: null,            // son oynat/durdur/sarma yapan kişi; senkronun referansı
  offset: 0, samples: [],  // sunucu saatine göre fark (ms)
  rtt: 0,
  tabId: null, frameId: null, status: null, lastTick: 0, // frameId: videonun bulunduğu çerçeve (iç çerçeveli siteler)
  mic: null, encoder: null, players: null, audioKey: null, voiceLimited: false,
  win: null,               // panelin penceresi: sadece bu penceredeki sekmeleri dinle
  remote: null,            // karşı tarafın açık içeriği {media, url, name}
  cfg: null,               // {server, name, room}
  micGain: 1.5, ns: true, gateDb: -50, ai: true, vol: 1,
  log: [],                 // sohbet/sistem mesajları (panel yeniden açılınca gösterilir)
  calibrating: false,
};

// ---------- Gelen veriyi doğrula (karşı taraf ya da odaya sızan biri bozuk/kötü niyetli veri gönderebilir) ----------
const EMOJIS = new Set(["❤️", "😂", "😮", "😢", "👏", "🔥"]);
const num = (x) => typeof x === "number" && Number.isFinite(x);
function safeUrl(u) {
  try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:" ? x.href : null; } catch { return null; }
}
function clean(m) {
  if (!m || typeof m !== "object" || typeof m.type !== "string") return null;
  m.fromName = String(m.fromName ?? "?").slice(0, 24);
  switch (m.type) {
    case "action": case "tick":
      if (!num(m.time) || m.time < 0 || m.time > 864000 || typeof m.playing !== "boolean" || !num(m.sentAt)) return null;
      if (m.type === "action" && !["play", "pause", "seek", "sync"].includes(m.action)) return null;
      m.media = typeof m.media === "string" ? m.media.slice(0, 300) : null;
      m.url = safeUrl(m.url);
      break;
    case "chat":
      if (typeof m.text !== "string" || !m.text.trim()) return null;
      m.text = m.text.slice(0, 500);
      break;
    case "react":
      if (!EMOJIS.has(m.emoji)) return null;
      break;
    case "voice":
      m.on = m.on === true;
      break;
    case "ad":
      m.on = m.on === true;
      m.resume = m.resume && num(m.resume.time) && num(m.resume.sentAt) && m.resume.time >= 0
        ? { time: m.resume.time, sentAt: m.resume.sentAt, playing: true } : null;
      break;
    case "welcome":
      if (!Array.isArray(m.peers)) m.peers = [];
      m.peers = m.peers.filter((p) => p && typeof p.id === "string").map((p) => ({ id: p.id, name: String(p.name ?? "?").slice(0, 24) }));
      break;
    case "peer-join": case "peer-leave":
      if (typeof m.id !== "string") return null;
      m.name = String(m.name ?? "?").slice(0, 24);
      break;
    case "pong":
      if (!num(m.t0) || !num(m.ts)) return null;
      break;
  }
  return m;
}

// ---------- Panel ile iletişim ----------
const PANEL_URL = chrome.runtime.getURL("sidepanel.html");
const toPanel = (o) => chrome.runtime.sendMessage({ __biPanel: true, ...o }).catch(() => {}); // panel kapalıysa sessizce düşer
let viewTimer = null;
function render() { // en fazla 10 kez/sn
  if (viewTimer) return;
  viewTimer = setTimeout(() => { viewTimer = null; toPanel({ ev: "view", view: view() }); }, 100);
}
const renderMeta = render;
function view() {
  const now = Date.now();
  const bad = S.remote && S.status && S.status.media && S.remote.media !== S.status.media;
  return {
    want: S.want, dot: !S.ws ? "off" : S.ws.readyState === 1 ? "on" : S.ws.readyState === 0 ? "wait" : "off",
    me: S.me, cfg: S.cfg,
    peers: [...S.peers.values()].map((p) => ({ name: p.name, voice: !!p.voice, talking: now - (p.lastAudio || 0) < 400 })),
    status: S.status ? { ad: !!S.status.ad, playing: !!S.status.playing, time: S.status.ad ? 0 : localTime() } : null,
    rtt: S.rtt, mic: !!S.mic, voiceLimited: S.voiceLimited, tabId: S.tabId,
    mismatch: bad ? { name: S.remote.name, url: safeUrl(S.remote.url) } : null,
    settings: { micGain: S.micGain, ns: S.ns, gateDb: S.gateDb, ai: S.ai, vol: S.vol },
    calibrating: S.calibrating,
  };
}
function pushLog(e) {
  S.log.push(e);
  if (S.log.length > 300) S.log.shift();
  toPanel({ ev: "log", entry: e });
}
const addMsg = (who, text, cls = "") => pushLog({ who: String(who).slice(0, 24), text: String(text).slice(0, 500), cls });
const sys = (text) => pushLog({ text: String(text).slice(0, 500), cls: "sys" });

// ---------- Relay bağlantısı ----------
function connect() {
  const { server, name, room } = S.cfg;
  const url = `${server.replace(/\/$/, "")}/room/${encodeURIComponent(room)}?name=${encodeURIComponent(name)}`;
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  S.ws = ws;
  deriveKey(room).then((k) => { if (S.ws === ws) S.audioKey = k; });
  render();
  ws.onopen = () => { render(); ping(); };
  ws.onmessage = (e) => {
    if (typeof e.data !== "string") return onAudio(e.data);
    try { const m = clean(JSON.parse(e.data)); if (m) handle(m); } catch (err) { console.error(err); }
  };
  ws.onclose = () => {
    if (S.ws !== ws) return;
    closeAllPlayers();
    S.peers.clear(); S.me = null; render();
    if (S.want) { sys("Bağlantı koptu, yeniden deneniyor…"); setTimeout(() => S.want && S.ws === ws && connect(), 2000); }
  };
}
function send(o) { if (S.ws && S.ws.readyState === 1) S.ws.send(JSON.stringify(o)); }
const serverNow = () => Date.now() + S.offset;

function ping() { send({ type: "ping", t0: Date.now() }); }
setInterval(ping, 4000);
// Konuşan kişinin yanında 🔊 göster/gizle, video zamanını güncelle
setInterval(() => { if (S.want) render(); }, 500);

function handle(m) {
  switch (m.type) {
    case "welcome":
      S.me = m.id;
      S.peers = new Map(m.peers.map((p) => [p.id, { ...p }]));
      S.leader = m.peers[0] ? m.peers[0].id : S.me;
      if (m.peers.length) send({ type: "sync-req" });
      if (S.mic) send({ type: "voice", on: true });
      sys(m.peers.length ? `Odaya katıldın: ${m.peers.map((p) => p.name).join(", ")}` : "Odaya girdin. Karşı taraf bekleniyor.");
      render();
      break;
    case "peer-join":
      S.peers.set(m.id, { id: m.id, name: m.name });
      sys(`${m.name} odaya katıldı 🎉`);
      toTab({ kind: "toast", text: `${m.name} katıldı`, style: "sys" });
      if (S.status && !S.status.ad) sendAction("sync"); // yeni geleni bizim konuma getir
      if (S.mic) send({ type: "voice", on: true });
      render();
      break;
    case "peer-leave":
      S.peers.delete(m.id);
      closePlayer(m.id);
      if (S.leader === m.id) S.leader = S.me;
      sys(`${m.name} ayrıldı`);
      render();
      break;
    case "pong": {
      const now = Date.now(), rtt = now - m.t0;
      S.samples.push({ rtt, off: m.ts - (m.t0 + now) / 2 });
      if (S.samples.length > 6) S.samples.shift();
      const best = S.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
      S.offset = best.off; S.rtt = rtt;
      render();
      break;
    }
    case "ad":
      if (m.on) {
        sys(`📢 ${m.fromName} reklam izliyor, bekleniyor…`);
        toTab({ kind: "toast", text: `📢 ${m.fromName} reklam izliyor, bekleniyor…`, style: "sys" });
        if (S.status && !S.status.ad) {
          if (S.status.playing) S.pausedForAd = true;
          toTab({ kind: "apply", playing: false });
        }
      } else {
        const resume = S.pausedForAd;
        S.pausedForAd = false;
        if (m.resume) {
          S.leader = m.from;
          toTab({ kind: "apply", time: target(m.resume), playing: true });
        } else if (S.status && !S.status.ad) {
          const playing = resume || S.status.playing;
          if (resume) toTab({ kind: "apply", playing: true });
          sendAction("sync", localTime(), playing);
        }
      }
      break;
    case "sync-req":
      // Yeni katılan ya da videosu yeni açılan biri konumumuzu istiyor
      if (S.status && !S.status.ad) sendAction("sync");
      break;
    case "action": {
      S.leader = m.from;
      noteRemote(m);
      toTab({ kind: "apply", time: target(m), playing: m.playing, media: m.media, url: m.url, fromName: m.fromName });
      const verb = { play: "oynattı ▶", pause: "durdurdu ⏸", seek: `${fmt(m.time)}'e sardı ⏩` }[m.action];
      if (verb) { sys(`${m.fromName} ${verb}`); toTab({ kind: "toast", text: `${m.fromName} ${verb}`, style: "sys" }); }
      break;
    }
    case "tick": {
      if (m.from !== S.leader) break;
      noteRemote(m);
      if (!S.status || S.status.ad || (m.media && m.media !== S.status.media)) break;
      const tgt = target(m), mine = localTime();
      if (m.playing !== S.status.playing || Math.abs(tgt - mine) > 0.5) {
        toTab({ kind: "apply", time: tgt, playing: m.playing, media: m.media, url: m.url, fromName: m.fromName });
      }
      break;
    }
    case "chat":
      addMsg(m.fromName, m.text);
      toTab({ kind: "toast", text: `${m.fromName}: ${m.text}` });
      break;
    case "react":
      sys(`${m.fromName} ${m.emoji}`);
      toTab({ kind: "react", emoji: m.emoji });
      break;
    case "voice": {
      const p = S.peers.get(m.from);
      if (p) { p.voice = m.on; render(); }
      break;
    }
    case "voice-limit":
      if (!S.voiceLimited) { S.voiceLimited = true; sys("Bugünlük ücretsiz ses kotası doldu; sesli sohbet yarın 03:00'te açılır. Senkron ve mesajlaşma çalışıyor."); render(); }
      break;
  }
}

// Gönderildiği andan bu yana geçen süreyi ekleyerek karşının şu anki konumunu tahmin et
function target(m) {
  const elapsed = Math.max(0, serverNow() - m.sentAt) / 1000;
  return m.time + (m.playing ? elapsed : 0);
}
function localTime() {
  const s = S.status;
  return s.time + (s.playing ? (Date.now() - s.at) / 1000 : 0);
}
function sendAction(action, t = localTime(), playing = S.status.playing) {
  S.leader = S.me;
  send({ type: "action", action, time: t, playing, sentAt: serverNow(), media: S.status.media, url: S.status.url });
}
function fmt(t) {
  t = Math.max(0, Math.floor(t || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
}

// Karşı taraf hangi videoda? Farklıysa panelde uyarı + "onun videosunu aç" düğmesi
function noteRemote(m) {
  if (!m.media) return;
  S.remote = { media: m.media, url: m.url, name: m.fromName };
  render();
}
const renderMismatch = render;

// ---------- Sekme (video) ile iletişim ----------
// Komutlar sadece videonun olduğu çerçeveye gider (bilinmiyorsa ana sayfaya). Offscreen sayfada chrome.tabs yok → background iletir.
function toTab(msg) {
  if (S.tabId == null) return;
  chrome.runtime.sendMessage({ __biBg: "toTab", tabId: S.tabId, frameId: S.frameId ?? 0, msg: { ...msg, __bi: true } }).catch(() => {});
}

function onTabMessage(m, sender) {
  if (!S.want) return;
  // Aynı bilgisayarda iki pencerede deneme yaparken iki pencere birbirinin sekmesini kapmasın
  if (S.win != null && sender.tab.windowId !== S.win) return;
  if (m.kind === "fullscreen") {
    // Bağlı videoda tam ekrana geçildi: paneli kapat (çekirdek çalışmaya devam eder)
    if (m.on === true && sender.tab.id === S.tabId) {
      chrome.runtime.sendMessage({ __biBg: "closePanel", windowId: sender.tab.windowId }).then((closed) => {
        if (closed) toTab({ kind: "toast", text: "Panel gizlendi, her şey çalışıyor. Geri açmak için: Alt+B ya da eklenti simgesi", style: "sys" });
      }).catch(() => {});
    }
    return;
  }
  if (!num(m.time) && (m.kind === "local" || (m.kind === "status" && !m.ad))) return;
  const pageUrl = safeUrl(sender.tab.url) || safeUrl(m.url); // iç çerçevede bile sekmenin asıl adresi
  const media = typeof m.media === "string" ? m.media.slice(0, 300) : null;
  const bound = sender.tab.id === S.tabId && (S.frameId == null || sender.frameId === S.frameId);
  if (m.kind === "local") {
    if (!["play", "pause", "seek"].includes(m.action) || typeof m.playing !== "boolean") return;
    // Bağlı sekme dışından gelen olayı sadece kullanıcının baktığı sekmede ve sesi açık videoda kabul et
    // (rastgele sitelerdeki sessiz otomatik oynayan tanıtım videoları senkronu ele geçirmesin)
    if (!bound && !(sender.tab.active && !m.muted)) return;
    S.tabId = sender.tab.id; // kullanıcı hangi sekmede oynatıyorsa o sekme bağlanır
    S.frameId = sender.frameId;
    S.status = { time: m.time, playing: m.playing, at: Date.now(), media, url: pageUrl };
    if (S.me) sendAction(m.action, m.time, m.playing);
    render();
    return;
  }
  if (sender.tab.id !== S.tabId) return;
  if (S.frameId == null && m.kind === "status") S.frameId = sender.frameId; // videonun çerçevesini öğren
  if (sender.frameId !== S.frameId) return;
  if (m.kind === "status") {
    if (m.ad) {
      if (!S.inAd) {
        // Reklam başladı: film ortasındaysak (aynı video) reklam bitince bizim konum esas alınır
        S.inAd = true;
        S.adMid = !!(S.status && !S.status.ad && S.status.media === media);
        if (S.peers.size) send({ type: "ad", on: true });
      }
      S.status = S.status ? { ...S.status, ad: true } : null;
    } else {
      if (typeof m.playing !== "boolean") return;
      const wasMissing = !S.status || S.status.media !== media; // video yeni açıldı ya da değişti
      S.status = { time: m.time, playing: m.playing, at: Date.now(), media, url: pageUrl };
      if (S.inAd) {
        S.inAd = false;
        // Film ortası reklamı: herkes bizim kaldığımız yerden devam etsin.
        // Başlangıç reklamı: karşı taraf kendi konumunu gönderecek.
        send({ type: "ad", on: false, resume: S.adMid ? { time: m.time, playing: true, sentAt: serverNow() } : null });
        if (S.adMid) S.leader = S.me;
      } else if (wasMissing && S.peers.size) send({ type: "sync-req" });
      if (S.leader === S.me && S.peers.size && Date.now() - S.lastTick > 3000) {
        S.lastTick = Date.now();
        send({ type: "tick", time: m.time, playing: m.playing, sentAt: serverNow(), media, url: pageUrl });
      }
    }
    render();
  } else if (m.kind === "video") {
    if (!m.present) { S.status = null; S.frameId = null; }
    render();
  } else if (m.kind === "mismatch") {
    render();
  }
}

// ---------- Panelden gelen komutlar ----------
const clampNum = (x, lo, hi) => (num(x) ? Math.min(hi, Math.max(lo, x)) : null);
async function onPanelCmd(m) {
  switch (m.cmd) {
    case "hello":
      return { view: view(), log: S.log };
    case "connect": {
      const c = m.cfg || {};
      const server = String(c.server || "").trim(), room = String(c.room || "").trim();
      const name = String(c.name || "").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 24) || "Misafir";
      if (!/^wss?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(server) || !/^[A-Za-z0-9_-]{6,64}$/.test(room)) return { ok: false };
      applySettings(m.settings || {});
      S.cfg = { server, name, room };
      S.win = num(m.win) ? m.win : null;
      if (num(m.tabId)) { S.tabId = m.tabId; S.frameId = null; S.status = null; }
      S.want = true; S.voiceLimited = false;
      audioCtx();
      try { S.ws && S.ws.close(); } catch {}
      S.ws = null;
      connect();
      return { ok: true };
    }
    case "disconnect":
      S.want = false;
      try { S.ws && S.ws.close(); } catch {}
      S.ws = null;
      stopMic(); closeAllPlayers();
      S.peers.clear(); S.me = null; S.status = null; S.remote = null;
      render();
      return { ok: true };
    case "bind":
      if (num(m.tabId)) { S.tabId = m.tabId; S.frameId = null; S.status = null; render(); }
      if (num(m.win)) S.win = m.win;
      return { ok: true };
    case "syncNow":
      if (S.status && !S.status.ad) { sendAction("sync"); sys("Karşı taraf senin konumuna eşitlendi."); }
      else sys("Bağlı sekmede video bulunamadı.");
      return { ok: true };
    case "chat": {
      const text = typeof m.text === "string" ? m.text.trim().slice(0, 500) : "";
      if (!text) return { ok: false };
      send({ type: "chat", text });
      addMsg("Sen", text, "me");
      return { ok: true };
    }
    case "react":
      if (!EMOJIS.has(m.emoji)) return { ok: false };
      send({ type: "react", emoji: m.emoji });
      toTab({ kind: "react", emoji: m.emoji });
      return { ok: true };
    case "mic":
      if (S.mic) { stopMic(); return { ok: true, on: false }; }
      try { await startMic(); } catch { return { ok: false, needPermission: true }; }
      send({ type: "voice", on: true });
      render();
      return { ok: true, on: true };
    case "set":
      applySettings(m.settings || {}, true);
      render();
      return { ok: true };
    case "calibrate":
      return calibrate();
  }
  return { ok: false };
}

function applySettings(v, live = false) {
  const g = clampNum(v.micGain, 1, 4), d = clampNum(v.gateDb, -80, -20), vol = clampNum(v.vol, 0, 3);
  if (g != null) { S.micGain = g; if (S.micNodes) S.micNodes.gate.parameters.get("gain").value = g; }
  if (d != null) { S.gateDb = Math.round(d); if (S.micNodes) S.micNodes.gate.parameters.get("threshold").value = S.gateDb; }
  if (vol != null) { S.vol = vol; if (S.outGain) S.outGain.gain.value = vol; }
  let restart = false;
  if (typeof v.ns === "boolean" && v.ns !== S.ns) { S.ns = v.ns; restart = true; }
  if (typeof v.ai === "boolean" && v.ai !== S.ai) { S.ai = v.ai; restart = true; }
  if (live && restart) restartMic(); // bu iki ayar mikrofon açılırken kuruluyor
}

// Gelen mesajları ayır: içerik betiği (sender.tab var) ya da yan panel (eklentinin kendi sayfası)
chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (!m || typeof m !== "object" || sender.id !== chrome.runtime.id) return;
  if (m.__bi && sender.tab) { onTabMessage(m, sender); return; }
  // Panel sayfası (eklentinin kendi sayfası; web sayfaları ve içerik betikleri bu adresle mesaj gönderemez)
  if (m.__biEngine && sender.url && sender.url.split("?")[0] === PANEL_URL) {
    onPanelCmd(m).then(reply, () => reply({ ok: false }));
    return true;
  }
});

// ---------- Sesli sohbet: mikrofon işleme zinciri ----------
// Mikrofon → alçak frekans filtresi (fan/titreşim uğultusu) → yapay zekâ gürültü engelleme (isteğe bağlı)
//          → gürültü kapısı + güç → sıkıştırıcı (sesi dengeler) → limitör (asla patlamaz) → Opus kodlayıcı
// Gelen ses → hoparlör kazancı (3x'e kadar) → hoparlör
function audioCtx() {
  if (!S.actx) {
    S.actx = new AudioContext({ sampleRate: 48000 });
    S.outGain = S.actx.createGain();
    S.outGain.gain.value = S.vol;
    S.outGain.connect(S.actx.destination);
  }
  S.actx.resume().catch(() => {});
  return S.actx;
}

async function startMic() {
  const raw = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: S.ns, autoGainControl: true, channelCount: 1 },
  });
  const ctx = audioCtx();
  await ensureWorklet(ctx);
  const src = ctx.createMediaStreamSource(raw);
  const hpf = ctx.createBiquadFilter();
  hpf.type = "highpass"; hpf.frequency.value = 90; hpf.Q.value = 0.7;
  const rnn = S.ai ? await makeRnnoise(ctx) : null;
  const gate = new AudioWorkletNode(ctx, "bi-gate", { channelCount: 1, channelCountMode: "explicit", outputChannelCount: [1] });
  gate.parameters.get("threshold").value = S.gateDb;
  gate.parameters.get("gain").value = S.micGain;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -24; comp.knee.value = 12; comp.ratio.value = 3;
  comp.attack.value = 0.005; comp.release.value = 0.2;
  const limiter = new AudioWorkletNode(ctx, "bi-limiter", { channelCount: 1, channelCountMode: "explicit", outputChannelCount: [1] });
  limiter.parameters.get("ceiling").value = -1;
  const tap = new AudioWorkletNode(ctx, "bi-tap", { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: "explicit" });
  (rnn ? src.connect(hpf).connect(rnn) : src.connect(hpf)).connect(gate).connect(comp).connect(limiter).connect(tap);
  startEncoder(tap);

  S.meter = { level: -120, open: false, reduction: 0, samples: null };
  gate.port.onmessage = (e) => {
    S.meter.level = e.data.level; S.meter.open = e.data.open;
    if (S.meter.samples) S.meter.samples.push(e.data.level);
    sendMeter();
  };
  limiter.port.onmessage = (e) => { S.meter.reduction = e.data.reduction; };
  S.raw = raw; S.micNodes = { src, hpf, rnn, gate, comp, limiter, tap }; S.mic = raw;
}
let meterAt = 0;
function sendMeter() { // ~10 kez/sn
  const now = Date.now();
  if (now - meterAt < 100) return;
  meterAt = now;
  const m = S.meter;
  toPanel({ ev: "meter", meter: m && S.micNodes ? { level: m.level, open: m.open, reduction: m.reduction } : null });
}

// Yapay zekâ gürültü engelleme (RNNoise, eklentinin içinde, internete bağlanmaz).
// Konuşma olmayan sesleri (fan, klavye, trafik) konuşurken bile ayıklar. 48 kHz bekler.
const RNN_PROC = "@sapphi-red/web-noise-suppressor/rnnoise";
const SIMD_TEST = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
async function makeRnnoise(ctx) {
  try {
    if (!S.rnnWasm) {
      const file = WebAssembly.validate(SIMD_TEST) ? "rnnoise_simd.wasm" : "rnnoise.wasm";
      S.rnnWasm = await (await fetch(chrome.runtime.getURL("vendor/rnnoise/" + file))).arrayBuffer();
      await ctx.audioWorklet.addModule(chrome.runtime.getURL("vendor/rnnoise/rnnoise-worklet.js"));
    }
    return new AudioWorkletNode(ctx, RNN_PROC, {
      channelCount: 1, channelCountMode: "explicit", outputChannelCount: [1],
      processorOptions: { maxChannels: 1, wasmBinary: S.rnnWasm },
    });
  } catch (e) {
    console.warn("RNNoise yüklenemedi", e);
    sys("Yapay zekâ gürültü engelleme yüklenemedi, onsuz devam ediliyor.");
    return null;
  }
}

// Ortam sesini ölç: 3 sn sessiz kal, eşik = en yüksek ortam sesi + 6 dB
async function calibrate() {
  if (!S.micNodes) { sys("Önce mikrofonu aç."); return { ok: false }; }
  if (S.calibrating) return { ok: false };
  S.calibrating = true; render();
  S.meter.samples = [];
  await new Promise((r) => setTimeout(r, 3000));
  const s = (S.meter && S.meter.samples ? S.meter.samples : []).sort((a, b) => a - b);
  if (S.meter) S.meter.samples = null;
  const noise = s.length ? s[Math.floor(s.length * 0.95)] : -60; // ara sıra tıkırtıları sayma
  applySettings({ gateDb: Math.min(-25, Math.max(-75, noise + 6)) });
  sys(`Ortam sesi ${noise.toFixed(0)} dB ölçüldü, eşik ${S.gateDb} dB yapıldı.`);
  S.calibrating = false; render();
  return { ok: true, gateDb: S.gateDb };
}

function releaseMic() {
  stopEncoder();
  if (S.raw) S.raw.getTracks().forEach((t) => t.stop());
  if (S.micNodes) {
    try { S.micNodes.src.disconnect(); S.micNodes.limiter.disconnect(); S.micNodes.gate.port.onmessage = null; S.micNodes.tap.port.onmessage = null; } catch {}
    if (S.micNodes.rnn) { try { S.micNodes.rnn.port.postMessage("destroy"); S.micNodes.rnn.disconnect(); } catch {} }
  }
  S.raw = null; S.mic = null; S.micNodes = null;
  sendMeter();
}
function stopMic() {
  if (!S.mic) return;
  releaseMic();
  send({ type: "voice", on: false });
  render();
}
async function restartMic() {
  if (!S.mic) return;
  releaseMic();
  try { await startMic(); } catch { stopMic(); }
}

// ---------- Sesli sohbet: Opus (WebCodecs) + AES-GCM, relay üzerinden ----------
// Doğrudan bağlantı (WebRTC) bazı ağlarda kurulamıyor; ses bunun yerine relay'den küçük şifreli paketlerle gider.
// Paket (şifreli içerik): [sürüm=1][sıra u16][kare sayısı n][(uzunluk u16, opus karesi) × n]
// Gönderilen: [IV 12 bayt][AES-GCM şifreli içerik]. Relay başına gönderenin 8 karakterlik kimliğini ekler.
// Anahtar oda kodundan türetilir: odaya girmeyen (Cloudflare dahil) sesi çözemez.
const AU_FRAMES = 2;          // paket başına 2 × 20 ms = 40 ms
const AU_HANG = 15;           // ses kesildikten sonra 300 ms daha gönder (kelime sonu kesilmesin)
const AU_MAX_FRAMES = 6, AU_MAX_FRAME_LEN = 1000;
const OPUS = { codec: "opus", sampleRate: 48000, numberOfChannels: 1 };

async function deriveKey(room) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(room), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new TextEncoder().encode("birlikte-izle/ses/v1"), info: new Uint8Array() },
    base, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

async function ensureWorklet(ctx) {
  if (!S.workletReady) S.workletReady = ctx.audioWorklet.addModule(chrome.runtime.getURL("audio-worklet.js"));
  await S.workletReady;
  S.workletLoaded = true;
}

// --- Gönderme ---
function startEncoder(tap) {
  stopEncoder();
  const E = { frames: [], seq: 0, ts: 0, hang: 0, chain: Promise.resolve() };
  E.enc = new AudioEncoder({
    output: (chunk) => {
      const b = new Uint8Array(chunk.byteLength);
      chunk.copyTo(b);
      E.frames.push(b);
      if (E.frames.length >= AU_FRAMES) flushAudio(E);
    },
    error: (e) => console.warn("opus kodlayıcı", e),
  });
  E.enc.configure({ ...OPUS, bitrate: 64000, opus: { frameDuration: 20000, complexity: 9 } });
  tap.port.onmessage = (e) => {
    const { pcm } = e.data;
    // Gönderme kararı gürültü kapısına göre: kapı kapalıysa (fan, uğultu, sessizlik) hiç paket gitmez → kota harcanmaz
    const active = !!(S.meter && S.meter.open) && e.data.active;
    if (S.voiceLimited || !S.peers.size || !S.audioKey) { E.hang = 0; return; }
    if (active) E.hang = AU_HANG;
    else if (E.hang > 0) E.hang--;
    else { if (E.frames.length) flushAudio(E); return; }
    if (E.enc.state !== "configured") return;
    const ad = new AudioData({ format: "f32-planar", sampleRate: 48000, numberOfFrames: pcm.length, numberOfChannels: 1, timestamp: E.ts, data: pcm });
    E.ts += 20000;
    E.enc.encode(ad);
    ad.close();
    E.sentAt = Date.now();
  };
  S.encoder = E;
}
function stopEncoder() {
  const E = S.encoder;
  if (!E) return;
  try { E.enc.close(); } catch {}
  S.encoder = null;
}
function flushAudio(E) {
  const frames = E.frames.splice(0);
  if (!frames.length) return;
  let len = 4;
  for (const f of frames) len += 2 + f.length;
  const p = new Uint8Array(len), dv = new DataView(p.buffer);
  E.seq = (E.seq + 1) & 0xffff;
  p[0] = 1; dv.setUint16(1, E.seq); p[3] = frames.length;
  let o = 4;
  for (const f of frames) { dv.setUint16(o, f.length); p.set(f, o + 2); o += 2 + f.length; }
  const key = S.audioKey;
  // Şifreleme sırası korunsun diye zincir
  E.chain = E.chain.then(async () => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, p));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv); out.set(ct, 12);
    if (S.ws && S.ws.readyState === 1 && S.ws.bufferedAmount < 64 * 1024) { S.ws.send(out.buffer); S.auTx = (S.auTx || 0) + 1; }
  }).catch(() => {});
}

// --- Alma ---
const asciiId = (b) => String.fromCharCode(...b).replace(/_+$/, "");
function onAudio(buf) {
  if (!(buf instanceof ArrayBuffer) || buf.byteLength < 8 + 12 + 16 + 4 || buf.byteLength > 8 + 2048) return;
  const all = new Uint8Array(buf);
  const from = asciiId(all.subarray(0, 8));
  const peer = S.peers.get(from);
  if (!peer || !S.audioKey || !S.actx) return;
  const pl = getPlayer(from);
  if (!pl) return;
  const key = S.audioKey;
  pl.chain = pl.chain.then(async () => {
    let p;
    try {
      p = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.subarray(8, 20) }, key, all.subarray(20)));
    } catch { return; } // anahtar uymuyor / bozuk paket → yok say
    const frames = parseAudio(p);
    if (!frames || pl.dec.state !== "configured") return;
    for (const f of frames) {
      pl.dec.decode(new EncodedAudioChunk({ type: "key", timestamp: pl.ts, data: f }));
      pl.ts += 20000;
    }
    peer.lastAudio = Date.now();
    S.auRx = (S.auRx || 0) + 1;
  }).catch(() => {});
}
// Çözülmüş içeriği sıkı doğrula; bozuksa hiç kullanma
function parseAudio(p) {
  if (p.length < 4 || p[0] !== 1) return null;
  const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
  const n = p[3];
  if (n < 1 || n > AU_MAX_FRAMES) return null;
  const frames = [];
  let o = 4;
  for (let i = 0; i < n; i++) {
    if (o + 2 > p.length) return null;
    const len = dv.getUint16(o); o += 2;
    if (len < 1 || len > AU_MAX_FRAME_LEN || o + len > p.length) return null;
    frames.push(p.subarray(o, o + len)); o += len;
  }
  return o === p.length ? frames : null;
}
function getPlayer(id) {
  S.players ||= new Map();
  let pl = S.players.get(id);
  if (pl) return pl;
  if (!S.workletLoaded) { ensureWorklet(audioCtx()).catch(() => {}); return null; }
  const node = new AudioWorkletNode(S.actx, "bi-play", { numberOfInputs: 0, outputChannelCount: [1] });
  node.connect(S.outGain);
  pl = { node, ts: 0, chain: Promise.resolve() };
  pl.dec = new AudioDecoder({
    output: (ad) => {
      try {
        const f = new Float32Array(ad.numberOfFrames);
        ad.copyTo(f, { planeIndex: 0, format: "f32-planar" });
        node.port.postMessage(f, [f.buffer]);
      } finally { ad.close(); }
    },
    error: (e) => { console.warn("opus çözücü", e); closePlayer(id); },
  });
  pl.dec.configure(OPUS);
  S.players.set(id, pl);
  return pl;
}
function closePlayer(id) {
  const pl = S.players && S.players.get(id);
  if (!pl) return;
  try { if (pl.dec.state !== "closed") pl.dec.close(); } catch {}
  try { pl.node.disconnect(); } catch {}
  S.players.delete(id);
}
function closeAllPlayers() { if (S.players) for (const id of [...S.players.keys()]) closePlayer(id); }

