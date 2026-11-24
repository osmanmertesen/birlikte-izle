// Yan panel: sadece arayüz. Bağlantı, senkron ve ses görünmez çekirdekte (engine.js, offscreen sayfa) çalışır;
// bu yüzden panel kapansa da (örneğin tam ekranda) her şey devam eder. Panel açılınca çekirdekten durumu ve sohbet geçmişini alır.
const $ = (id) => document.getElementById(id);
const P = { view: null, win: null, allSites: false, settings: { micGain: 1.5, ns: true, gateDb: -50, ai: true, vol: 1 } };
const ENGINE_URL = chrome.runtime.getURL("engine.html");

function safeUrl(u) {
  try { const x = new URL(u); return x.protocol === "https:" || x.protocol === "http:" ? x.href : null; } catch { return null; }
}

// Çekirdeğe komut gönder (gerekirse background çekirdeği başlatır)
async function engine(cmd, extra = {}) {
  await chrome.runtime.sendMessage({ __biBg: "ensureEngine" }).catch(() => {});
  try { return (await chrome.runtime.sendMessage({ __biEngine: true, cmd, ...extra })) || { ok: false }; }
  catch { return { ok: false }; }
}

// Çekirdekten gelen güncellemeler (sadece eklentinin kendi çekirdek sayfasından kabul edilir)
chrome.runtime.onMessage.addListener((m, sender) => {
  if (!m || !m.__biPanel || sender.id !== chrome.runtime.id || sender.tab || !sender.url || sender.url.split("?")[0] !== ENGINE_URL) return;
  if (m.ev === "view") renderView(m.view);
  else if (m.ev === "log") addEntry(m.entry);
  else if (m.ev === "meter") drawMeter(m.meter);
});

// ---------- Açılış ----------
(async () => {
  const w = await chrome.windows.getCurrent(); P.win = w.id;
  const v = await chrome.storage.local.get(["server", "name", "room", "micGain", "ns", "vol", "gateDb", "ai"]);
  const def = self.BI_CONFIG && typeof self.BI_CONFIG.relayUrl === "string" ? self.BI_CONFIG.relayUrl : ""; // .env → scripts/config.mjs
  $("server").value = v.server || def;
  $("name").value = v.name || "";
  $("room").value = v.room || "";
  for (const k of ["micGain", "vol", "gateDb"]) if (typeof v[k] === "number") P.settings[k] = v[k];
  for (const k of ["ns", "ai"]) if (typeof v[k] === "boolean") P.settings[k] = v[k];
  showSettings(P.settings);
  // Çekirdek zaten çalışıyorsa (panel kapatılıp açıldıysa) kaldığı yerden göster; yoksa başlatma
  const has = await chrome.runtime.sendMessage({ __biBg: "hasEngine" }).catch(() => false);
  if (has) {
    const r = await engine("hello");
    if (r && r.view) { $("chat").textContent = ""; (r.log || []).forEach(addEntry); renderView(r.view); }
  }
})();

$("newRoom").onclick = () => {
  const a = new Uint8Array(10); crypto.getRandomValues(a);
  $("room").value = Array.from(a, (b) => "abcdefghjkmnpqrstuvwxyz23456789"[b % 31]).join("");
};

$("connect").onclick = async () => {
  const server = $("server").value.trim(), name = $("name").value.trim() || "Misafir", room = $("room").value.trim();
  if (!/^wss?:\/\//.test(server) || !/^[A-Za-z0-9_-]{6,64}$/.test(room)) { alert("Sunucu adresi (wss://…) ve en az 6 karakterlik oda kodu (harf/rakam) gerekli. 🎲 ile güçlü bir kod üret."); return; }
  await chrome.storage.local.set({ server, name, room });
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  $("chat").textContent = "";
  const r = await engine("connect", { cfg: { server, name, room }, win: P.win, tabId: tab ? tab.id : null, settings: P.settings });
  if (!r.ok) { alert("Bağlanılamadı: sunucu adresi ya da oda kodu geçersiz."); return; }
  $("setup").hidden = true; $("live").hidden = false;
};
$("disconnect").onclick = async () => {
  await engine("disconnect");
  await chrome.runtime.sendMessage({ __biBg: "closeEngine" }).catch(() => {});
  $("setup").hidden = false; $("live").hidden = true;
  $("dot").className = "dot off";
};

// ---------- Sekme ----------
$("bind").onclick = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) { await engine("bind", { tabId: tab.id }); addEntry({ cls: "sys", text: "Aktif sekme bağlandı." }); }
};
$("syncNow").onclick = () => engine("syncNow");
$("mmOpen").onclick = async () => {
  const url = P.view && P.view.mismatch && safeUrl(P.view.mismatch.url); // sadece http/https; javascript:, file:, chrome: vb. asla açılmaz
  if (!url) return;
  if (P.view.tabId != null) { await chrome.tabs.update(P.view.tabId, { url }).catch(() => {}); return; }
  const t = await chrome.tabs.create({ url });
  engine("bind", { tabId: t.id });
};

// ---------- Sohbet ----------
$("chatForm").onsubmit = (e) => {
  e.preventDefault();
  const text = $("chatInput").value.trim();
  if (!text) return;
  engine("chat", { text });
  $("chatInput").value = "";
};
document.querySelectorAll(".reactions button").forEach((b) => {
  b.onclick = () => engine("react", { emoji: b.dataset.e });
});
function addEntry(e) {
  if (!e || typeof e.text !== "string") return;
  const el = document.createElement("div");
  el.className = "msg " + (e.cls === "sys" ? "sys" : e.cls === "me" ? "me" : "");
  if (e.cls !== "sys") { const b = document.createElement("b"); b.textContent = String(e.who || "?"); el.append(b); }
  el.append(document.createTextNode(e.text)); // textContent: HTML/JS asla çalışmaz
  $("chat").appendChild(el);
  $("chat").scrollTop = $("chat").scrollHeight;
}

// ---------- Ses ----------
$("mic").onclick = async () => {
  const r = await engine("mic");
  if (r.needPermission) {
    addEntry({ cls: "sys", text: "Mikrofon izni gerekli. Açılan sekmede izni ver, sonra tekrar dene." });
    chrome.tabs.create({ url: chrome.runtime.getURL("mic.html") });
  }
};
function setSetting(k, v) {
  P.settings[k] = v;
  chrome.storage.local.set({ [k]: v });
  showSettings(P.settings);
  engine("set", { settings: { [k]: v } });
}
$("gain").oninput = (e) => setSetting("micGain", +e.target.value);
$("gate").oninput = (e) => setSetting("gateDb", +e.target.value);
$("vol").oninput = (e) => setSetting("vol", +e.target.value);
$("ns").onchange = (e) => setSetting("ns", e.target.checked);
$("ai").onchange = (e) => setSetting("ai", e.target.checked);
$("calibrate").onclick = async () => {
  const r = await engine("calibrate");
  if (r.ok) { P.settings.gateDb = r.gateDb; chrome.storage.local.set({ gateDb: r.gateDb }); showSettings(P.settings); }
};

const dbToPct = (db) => Math.max(0, Math.min(100, ((db + 80) / 80) * 100)); // -80 dB .. 0 dB
function showSettings(s) {
  $("gain").value = s.micGain; $("gainVal").textContent = (+s.micGain).toFixed(1) + "x";
  $("gate").value = s.gateDb; $("gateVal").textContent = Math.round(s.gateDb) + " dB";
  $("gateMark").style.left = dbToPct(s.gateDb) + "%";
  $("vol").value = s.vol; $("ns").checked = s.ns; $("ai").checked = s.ai;
}
// Seviye çubuğu: yeşil = iletiliyor, gri = kapı kapalı (iletilmiyor), turuncu = limitör devrede
function drawMeter(m) {
  if (!m || !num(m.level)) { $("meterBar").style.width = "0"; $("gateState").textContent = ""; return; }
  $("meterBar").style.width = dbToPct(m.level) + "%";
  $("meterBar").className = m.open ? (m.reduction > 3 ? "limit" : "open") : "";
  $("gateState").textContent = !m.open ? "⚫ Sessiz (iletilmiyor)"
    : m.reduction > 3 ? `🟠 İletiliyor · limitör ${(+m.reduction).toFixed(0)} dB kısıyor` : "🟢 İletiliyor";
}
const num = (x) => typeof x === "number" && Number.isFinite(x);

// ---------- Görünüm ----------
function fmt(t) {
  t = Math.max(0, Math.floor(t || 0));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
}
function renderView(v) {
  if (!v || typeof v !== "object") return;
  P.view = v;
  if (v.want) { $("setup").hidden = true; $("live").hidden = false; }
  $("dot").className = "dot " + (["on", "wait", "off"].includes(v.dot) ? v.dot : "off");
  const list = Array.isArray(v.peers) ? v.peers : [];
  $("peers").textContent = list.length
    ? "👥 " + list.map((p) => String(p.name) + (p.talking ? " 🔊" : p.voice ? " 🎤" : "")).join(", ")
    : v.me ? "Karşı taraf bekleniyor…" : "Bağlanıyor…";
  $("mic").textContent = v.mic ? "🎤 Mikrofon açık" : "🎤 Mikrofonu aç";
  $("mic").classList.toggle("on", !!v.mic);
  if (!v.mic) drawMeter(null);
  $("voiceInfo").textContent = !list.length ? "" :
    v.voiceLimited ? "Bugünlük ses kotası doldu (yarın açılır)" : "🔒 Ses şifreli gidiyor · kulaklık önerilir";
  const s = v.status;
  const vt = !s ? "🎬 Bağlı sekmede video yok" : s.ad ? "📢 Reklam oynuyor, bitince eşitlenecek" : `🎬 ${fmt(s.time)} ${s.playing ? "▶" : "⏸"}`;
  $("meta").textContent = `${vt} · gecikme ${num(v.rtt) ? v.rtt : 0} ms`;
  const mm = v.mismatch;
  $("mismatch").hidden = !mm;
  if (mm) {
    const url = safeUrl(mm.url);
    $("mmText").textContent = `⚠️ ${String(mm.name)} farklı bir video izliyor.`;
    $("mmOpen").hidden = !url;
    if (url) $("mmOpen").textContent = `Onun videosunu aç (${new URL(url).hostname})`;
  }
  $("calibrate").disabled = !!v.calibrating;
  $("calibrate").textContent = v.calibrating ? "🤫 3 sn sessiz kal…" : "🎚 Ortam sesini ölç";
}

// ---------- Tüm sitelerde çalıştır (isteğe bağlı izin) ----------
// Netflix/Prime/TOD/YouTube'da her zaman çalışır. Diğer siteler için Chrome bir kez izin sorar;
// izin verilince eklenti her sitede (iç çerçevelerdeki oynatıcılar dahil) videoyu bulur.
// Eklenti sayfa içeriğini okumaz/göndermez: sadece <video> öğesinin zamanını ve oynat/durdur durumunu kullanır.
const ALL_SITES = ["https://*/*", "http://*/*"];
function renderAllSites() {
  document.querySelectorAll(".allSitesBtn").forEach((b) => {
    b.textContent = P.allSites ? "🌐 Tüm sitelerde açık" : "🌐 Tüm sitelerde çalıştır";
    b.classList.toggle("on", P.allSites);
    b.title = P.allSites ? "Kapatmak için tıkla (izni geri alır)" : "Netflix/Prime/TOD/YouTube dışındaki video siteleri için izin ister";
  });
}
async function syncAllSites() {
  P.allSites = await chrome.permissions.contains({ origins: ALL_SITES });
  renderAllSites();
}
syncAllSites();
chrome.permissions.onAdded.addListener(syncAllSites);
chrome.permissions.onRemoved.addListener(syncAllSites);

async function injectIntoTab(tabId) {
  if (tabId == null) return;
  try { await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, files: ["content.js"] }); } catch {}
}
document.querySelectorAll(".allSitesBtn").forEach((b) => {
  b.onclick = async () => {
    if (P.allSites) {
      await chrome.permissions.remove({ origins: ALL_SITES });
      addEntry({ cls: "sys", text: "Diğer sitelerdeki izin geri alındı. Netflix/Prime/TOD/YouTube'da çalışmaya devam eder." });
      return syncAllSites();
    }
    // İzin penceresi tıklamayla aynı anda açılmalı; araya bekleme koyma
    const ok = await chrome.permissions.request({ origins: ALL_SITES });
    await chrome.runtime.sendMessage({ __biBg: "sync-scripts" }).catch(() => {});
    await syncAllSites();
    if (!ok) { addEntry({ cls: "sys", text: "İzin verilmedi. Sadece Netflix/Prime/TOD/YouTube'da çalışır." }); return; }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    await injectIntoTab(tab && tab.id);
    addEntry({ cls: "sys", text: "Artık video olan her sitede çalışıyor. Açık sayfa algılanmazsa sayfayı yenile." });
  };
});
