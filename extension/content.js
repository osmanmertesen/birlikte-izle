// Platform sayfasında çalışır: video oynatıcıyı bulur, yerel olayları yan panele bildirir,
// uzaktan gelen komutları uygular ve sohbet/tepkileri video üstünde gösterir.
(() => {
  if (window.__biLoaded) return;
  window.__biLoaded = true;

  const isNetflix = location.hostname.includes("netflix.com");
  const isYouTube = /(^|\.)youtube(-nocookie)?\.com$/.test(location.hostname);
  let video = null;
  let ignoreUntil = 0;   // komut uygulanırken kısa süre tüm olayları yut
  let expect = null;     // uzaktan uygulanan durum: buna uyan olaylar yankıdır, geri yollanmaz
  let pending = null;    // video hazır değilken / reklam varken gelen komut

  const send = (msg) => {
    try { chrome.runtime.sendMessage({ ...msg, __bi: true }).catch(() => {}); } catch {}
  };

  // Hangi içerik açık? İki tarafın aynı videoda olup olmadığını bununla kontrol ediyoruz.
  function media() {
    const u = new URL(location.href);
    if (isYouTube) return "yt:" + (u.searchParams.get("v") || u.pathname);
    if (isNetflix) { const m = u.pathname.match(/\/watch\/(\d+)/); return "nf:" + (m ? m[1] : u.pathname); }
    return location.hostname + u.pathname;
  }
  const info = () => ({ media: media(), url: location.href });

  function inAd() {
    return isYouTube && !!document.querySelector("#movie_player.ad-showing");
  }

  // Sayfadaki en büyük (gerçek) videoyu seç; küçük önizleme/küçük resim videolarını yok say
  function pick() {
    let best = null, score = 0;
    for (const v of document.querySelectorAll("video")) {
      const r = v.getBoundingClientRect();
      if (r.width < 200 || r.height < 112) continue;
      const s = r.width * r.height * (v.readyState > 0 ? 1 : 0.01);
      if (s > score) { score = s; best = v; }
    }
    return best;
  }

  function isEcho(action) {
    if (Date.now() < ignoreUntil) return true;
    if (!expect || Date.now() > expect.until) return false;
    if (action === "play") return expect.playing;
    if (action === "pause") return !expect.playing;
    const t = expect.time + (expect.playing ? (Date.now() - expect.at) / 1000 : 0);
    return Math.abs(video.currentTime - t) < 2;
  }

  function emit(action) {
    if (!video || inAd() || isEcho(action)) return;
    expect = null;
    send({ kind: "local", action, time: video.currentTime, playing: !video.paused, muted: video.muted || video.volume === 0, ...info() });
  }
  const onPlay = () => emit("play");
  const onPause = () => emit("pause");
  const onSeeked = () => emit("seek");

  function attach() {
    const v = pick();
    if (v === video) return;
    if (video) {
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("seeking", onSeeked);
    }
    const had = !!video;
    video = v;
    if (v) {
      v.addEventListener("play", onPlay);
      v.addEventListener("pause", onPause);
      v.addEventListener("seeking", onSeeked);
    }
    if (v || had) send({ kind: "video", present: !!v, ...info() }); // video olmayan sayfalar hiç konuşmasın
  }
  setInterval(attach, 1000);
  attach();

  setInterval(() => {
    if (!video) return;
    if (inAd()) { send({ kind: "status", ad: true, ...info() }); return; }
    if (pending) {
      const m = pending; pending = null;
      const late = m.playing ? (Date.now() - m.at) / 1000 : 0;
      apply({ ...m, time: m.time + late });
    }
    send({ kind: "status", time: video.currentTime, playing: !video.paused, ...info() });
  }, 1000);

  // Netflix ve YouTube kendi oynatıcı API'leriyle (netflix-main.js / youtube-main.js), diğerleri video öğesiyle
  const viaPage = isNetflix || isYouTube;
  const pageCmd = (cmd, ms) => window.postMessage({ __bi: "cmd", cmd, ms }, "*");
  function seekTo(t) {
    if (viaPage) pageCmd("seek", Math.round(t * 1000));
    else video.currentTime = t;
  }
  async function play() {
    if (isYouTube) { pageCmd("play"); return; }
    await video.play();
  }
  function pause() {
    if (isYouTube) pageCmd("pause");
    else video.pause();
  }

  async function apply(m) {
    if (m.time !== undefined && !(typeof m.time === "number" && Number.isFinite(m.time) && m.time >= 0)) return;
    if (m.playing !== undefined && typeof m.playing !== "boolean") return;
    // Farklı videodaysak sarma/oynatma uygulama: yanlış videoyu bozar
    if (m.media && m.media !== media()) { send({ kind: "mismatch", ...info() }); return; }
    if (!video || inAd() || video.readyState === 0) { pending = { ...m, at: Date.now() }; return; }
    ignoreUntil = Date.now() + 500;
    expect = { time: m.time, playing: m.playing, at: Date.now(), until: Date.now() + 8000 };
    if (typeof m.time === "number" && Math.abs(video.currentTime - m.time) > 0.5) seekTo(m.time);
    if (m.playing === true && video.paused) {
      try { await play(); }
      catch { toast("▶ Oynatmak için videoya bir kez tıkla", "sys"); }
    } else if (m.playing === false && !video.paused) {
      pause();
    }
  }

  // ---------- Video üstü bildirimler ----------
  let box = null;
  function host() { return document.fullscreenElement || document.body; }
  function ensureBox() {
    if (!box) {
      box = document.createElement("div");
      box.style.cssText =
        "position:fixed;left:24px;bottom:96px;z-index:2147483647;display:flex;flex-direction:column;" +
        "gap:6px;pointer-events:none;font:15px/1.35 system-ui,sans-serif;max-width:40vw";
    }
    if (box.parentNode !== host()) host().appendChild(box);
    return box;
  }
  document.addEventListener("fullscreenchange", () => {
    if (box) ensureBox();
    // Tam ekrana geçince panel kendini gizlesin (çekirdek çalışmaya devam eder)
    send({ kind: "fullscreen", on: !!document.fullscreenElement });
  });

  function toast(text, style) {
    const el = document.createElement("div");
    el.textContent = String(text).slice(0, 300); // textContent: HTML olarak yorumlanmaz
    el.style.cssText =
      "background:rgba(20,20,28,.82);color:#fff;padding:8px 12px;border-radius:10px;" +
      "box-shadow:0 2px 10px rgba(0,0,0,.4);transition:opacity .4s;" +
      (style === "sys" ? "color:#c9c9d6;font-size:13px;" : "");
    ensureBox().appendChild(el);
    setTimeout(() => (el.style.opacity = "0"), 5000);
    setTimeout(() => el.remove(), 5500);
  }

  const EMOJIS = new Set(["❤️", "😂", "😮", "😢", "👏", "🔥"]);
  function react(emoji) {
    if (!EMOJIS.has(emoji)) return;
    const el = document.createElement("div");
    el.textContent = emoji;
    const x = 60 + Math.random() * 25;
    el.style.cssText =
      `position:fixed;left:${x}vw;bottom:10vh;font-size:56px;z-index:2147483647;pointer-events:none;` +
      "transition:transform 2.4s ease-out,opacity 2.4s ease-in;";
    host().appendChild(el);
    requestAnimationFrame(() => {
      el.style.transform = "translateY(-45vh) scale(1.3)";
      el.style.opacity = "0";
    });
    setTimeout(() => el.remove(), 2600);
  }

  chrome.runtime.onMessage.addListener((m, _sender, reply) => {
    if (!m || !m.__bi) return;
    if (m.kind === "apply") apply(m);
    else if (m.kind === "toast") toast(m.text, m.style);
    else if (m.kind === "react") react(m.emoji);
    else if (m.kind === "probe") reply({ present: !!video, ...info() });
  });
})();
