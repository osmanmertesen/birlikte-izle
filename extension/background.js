// Eklenti simgesine (ya da Alt+B'ye) basınca yan panel açılsın.
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

// "Tüm sitelerde çalıştır" izni varsa içerik betiğini her siteye (iç çerçeveler dahil) kaydet, yoksa kaldır.
const ALL_SITES = ["https://*/*", "http://*/*"];
const ID = "all-sites";
async function syncScripts() {
  const on = await chrome.permissions.contains({ origins: ALL_SITES });
  const reg = await chrome.scripting.getRegisteredContentScripts({ ids: [ID] });
  if (on && !reg.length) {
    await chrome.scripting.registerContentScripts([{
      id: ID, matches: ALL_SITES, js: ["content.js"], allFrames: true, runAt: "document_idle", persistAcrossSessions: true,
    }]);
  } else if (!on && reg.length) {
    await chrome.scripting.unregisterContentScripts({ ids: [ID] });
  }
}
chrome.runtime.onInstalled.addListener(syncScripts);
chrome.runtime.onStartup.addListener(syncScripts);
chrome.permissions.onAdded.addListener(syncScripts);
chrome.permissions.onRemoved.addListener(syncScripts);

// ---------- Çekirdek (görünmez offscreen sayfa) ----------
// Bağlantı, senkron ve ses orada çalışır; böylece yan panel kapansa da (tam ekran) her şey sürer.
const ENGINE = "engine.html";
const ENGINE_URL = chrome.runtime.getURL(ENGINE);
const PANEL_URL = chrome.runtime.getURL("sidepanel.html");
let creating = null;
async function hasEngine() {
  const c = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [ENGINE_URL] });
  return c.length > 0;
}
async function ensureEngine() {
  if (await hasEngine()) return;
  creating ||= chrome.offscreen.createDocument({
    url: ENGINE,
    reasons: ["USER_MEDIA"],
    justification: "Sesli sohbet (mikrofon ve karşı tarafın sesi) ve oda bağlantısı yan panel kapalıyken de sürsün.",
  }).catch(() => {}).finally(() => { creating = null; });
  await creating;
}
async function closeEngine() {
  if (await hasEngine()) await chrome.offscreen.closeDocument().catch(() => {});
}

const fromPanel = (s) => !!s.url && s.url.split("?")[0] === PANEL_URL; // sadece eklentinin kendi sayfası bu adrese sahip olabilir
const fromEngine = (s) => !s.tab && s.url && s.url.split("?")[0] === ENGINE_URL;

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (!m || typeof m !== "object" || !m.__biBg || sender.id !== chrome.runtime.id) return;
  // Sadece eklentinin kendi sayfalarından gelen istekler (web sayfaları/içerik betikleri bunları kullanamaz)
  if (m.__biBg === "sync-scripts" && fromPanel(sender)) {
    syncScripts().then(() => reply(true), () => reply(false));
    return true;
  }
  if (m.__biBg === "ensureEngine" && fromPanel(sender)) { ensureEngine().then(() => reply(true)); return true; }
  if (m.__biBg === "hasEngine" && fromPanel(sender)) { hasEngine().then(reply, () => reply(false)); return true; }
  if (m.__biBg === "closeEngine" && fromPanel(sender)) { closeEngine().then(() => reply(true)); return true; }
  // Çekirdekte chrome.tabs yok: sekmedeki videoya gidecek komutları buradan ilet
  if (m.__biBg === "toTab" && fromEngine(sender)) {
    if (Number.isInteger(m.tabId) && Number.isInteger(m.frameId) && m.msg && m.msg.__bi === true) {
      chrome.tabs.sendMessage(m.tabId, m.msg, { frameId: m.frameId }).catch(() => {});
    }
    return;
  }
  // Bağlı video tam ekrana geçti: paneli kapat (çekirdek çalışmaya devam eder). Chrome 141+.
  if (m.__biBg === "closePanel" && fromEngine(sender)) {
    if (!Number.isInteger(m.windowId) || !chrome.sidePanel.close) { reply(false); return; }
    chrome.sidePanel.close({ windowId: m.windowId }).then(() => reply(true), () => reply(false));
    return true;
  }
});
