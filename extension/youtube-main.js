// YouTube sayfasının kendi dünyasında çalışır. Video öğesini doğrudan sarmak YouTube'da
// oynatıcının yeniden yüklenmesine yol açabildiği için YouTube'un oynatıcı API'si kullanılır.
(() => {
  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.__bi !== "cmd") return;
    const p = document.getElementById("movie_player");
    if (!p || typeof p.seekTo !== "function") return;
    const { cmd, ms } = e.data;
    if (cmd === "seek") p.seekTo(ms / 1000, true);
    else if (cmd === "play") p.playVideo();
    else if (cmd === "pause") p.pauseVideo();
  });
})();
