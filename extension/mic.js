document.getElementById("go").onclick = async () => {
  const out = document.getElementById("out");
  try {
    const s = await navigator.mediaDevices.getUserMedia({ audio: true });
    s.getTracks().forEach((t) => t.stop());
    out.textContent = "✅ İzin verildi. Bu sekmeyi kapatıp yan panelde mikrofonu açabilirsin.";
  } catch (e) {
    out.textContent = "❌ İzin alınamadı: " + e.name + ". Adres çubuğundaki kilit/ayar simgesinden mikrofonu 'İzin ver' yap.";
  }
};
