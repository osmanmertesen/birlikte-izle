// Netflix sayfasının kendi dünyasında çalışır. video.currentTime ile sarmak Netflix'te
// hata (M7375) verdiği için Netflix'in oynatıcı API'si üzerinden sarar.
(() => {
  function player() {
    try {
      const vp = window.netflix.appContext.state.playerApp.getAPI().videoPlayer;
      const ids = vp.getAllPlayerSessionIds();
      const id = ids.find((s) => s.startsWith("watch")) || ids[0];
      return vp.getVideoPlayerBySessionId(id);
    } catch {
      return null;
    }
  }

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.__bi !== "cmd") return;
    const p = player();
    if (!p) return;
    const { cmd, ms } = e.data;
    if (cmd === "seek") p.seek(ms);
    else if (cmd === "play") p.play();
    else if (cmd === "pause") p.pause();
  });
})();
