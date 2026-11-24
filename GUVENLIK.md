# Birlikte İzle — Güvenlik özeti

Son kontrol: 2026-11-24 · eklenti v0.4.0 · relay sürüm `fb71add2`

## Neler aktarılıyor, neler aktarılmıyor
| Veri | Nereye gider |
|---|---|
| Film görüntüsü/sesi | Hiçbir yere. Herkes kendi hesabından izler. |
| Oynat/durdur/zaman, sohbet, emoji, video adresi | Cloudflare relay üzerinden odadaki kişilere (kaydedilmez) |
| Sesli sohbet | Cloudflare relay üzerinden, **uçtan uca şifreli** (AES-GCM-256, anahtar oda kodundan türetilir; relay/Cloudflare dinleyemez, kaydedilmez) |
| Netflix/Prime şifreleri, çerezler, sayfa içeriği | Eklenti bunlara hiç dokunmaz |

## Alınan önlemler
**Relay (sunucu)**
- Sadece tarayıcı eklentilerinden bağlantı kabul (web siteleri ziyaretçinin tarayıcısını kullanarak bağlanamaz).
- Oda kodu en az 6 karakter; 🎲 10 karakterlik rastgele kod üretir (~50 bit, tahmin edilemez).
- Sadece izinli mesaj türleri iletilir; gönderen kimliği her zaman sunucu tarafından yazılır (taklit edilemez). Ses paketlerinde de gönderen başlığını sunucu ekler.
- Kişi başı saniyede en fazla 40 mesaj ve 50 ses paketi; 32 KB üstü mesaj ve 16 B–2 KB dışındaki ses paketleri düşer; odada en fazla 4 kişi.
- Ücretsiz kota koruması: oda başına günde en fazla 1,2 milyon ses paketi (~13 saat kesintisiz konuşma); aşılırsa sadece ses o gün durur. Kart tanımlı değil → fatura çıkmaz.
- İsimlerden `<` `>` ve kontrol karakterleri silinir.

**Eklenti**
- Karşıdan gelen her mesaj doğrulanır (tür, sayı aralığı, uzunluk, izinli emoji listesi); bozuk olan yok sayılır.
- Ses paketleri: şifresi çözülemeyen (yanlış oda kodu), bozuk yapılı ya da odada olmayan birinden gelen paket çalınmaz.
- Gürültü kapısı kapalıyken hiç ses paketi gönderilmez (sessizlik/fan sesi karşıya gitmez, kota harcanmaz).
- Sohbet ve isimler `textContent` ile yazılır: HTML/JavaScript asla çalışmaz.
- "Onun videosunu aç" sadece `http/https` adres açar ve gideceği siteyi gösterir; `javascript:` vb. açılmaz.
- Başka sekmelerdeki sessiz/otomatik oynayan videolar senkronu ele geçiremez.
- Çekirdek (görünmez offscreen sayfa) komutları sadece eklentinin kendi panel sayfasından kabul eder; background sekmelere mesajı sadece çekirdekten gelirse iletir. Web sayfaları eklentiye mesaj gönderemez.
- Sohbet geçmişi bellekte en fazla 300 kayıt (şişirilemez), diske yazılmaz.
- Dışarıdan kod yüklenmez; RNNoise eklentinin içinde (`vendor/rnnoise`, lisanslarıyla). CSP: `script-src 'self' 'wasm-unsafe-eval'`.
- İzinler: `storage`, `sidePanel`, `scripting`, `offscreen`; diğer siteler isteğe bağlı ("Tüm sitelerde çalıştır"), istenince geri alınabilir.

## Testler (`test/`)
- `secrets-scan.mjs` — git'e girecek dosyalarda sır/kişisel veri yok mu: sunucu adresi, Cloudflare hesap adı, eklenti ID'si, IP adresi, API anahtarı/token, e-posta, ad-soyad, kişisel yollar; `.env`/`config.js`/`CLAUDE.md`/`dagitim/` dışarıda mı, sadece izinli dosyalar mı giriyor. Kasıtlı sızıntı dosyasıyla denendi (hepsini yakaladı), temiz hâlde 13/13.
- `security-relay.mjs` — 16 relay testi (yetkisiz köken, kısa kod, kimlik taklidi, bilinmeyen tür, flood, büyük mesaj, hedefli mesaj sızıntısı, eski `rtc` türü, ses paketi kimliği/boyutu/seli, oda sınırı). Canlı sunucuda 16/16.
- `sites-test.mjs` — her sitede + iç çerçeve senkronu, ele geçirme denemesi, kötü niyetli katılımcı (HTML/JS sohbet, geçersiz zaman, `javascript:` adres, sahte emoji, sahte ses paketleri), web sayfasının çekirdeğe erişememesi. 17/17.
- `e2e.mjs` — YouTube senkron, sohbet, şifreli ses (akış, yanlış anahtar/bozuk paket), limitör, kapı (kapalıyken paket yok), RNNoise, panel kapalıyken çalışma, panel geri açılınca geçmiş, sunucu adresinin `.env`/`config.js`'ten gelmesi. 28/28.
- `rnnoise.mjs` — gerçek konuşma geçiyor (kayıp <1 dB), fan gürültüsü siliniyor.
- Tam ekran (elle betik, `scratchpad/e2e/fs-test.mjs` mantığı): gerçek yan panel açık → YouTube tam ekran → panel kapandı, çekirdek bağlı.

## Bilinen sınırlar (kabul edilen riskler)
- **Oda kodu = anahtar.** Kodu bilen biri odaya girebilir ve sesi çözebilir. Kodu sadece birbirinize gönderin, 🎲 ile üretin.
- Ses anahtarı oda kodundan türetildiği için kısa/tahmin edilebilir kod zayıf şifre demektir (🎲 kodu ~50 bit).
- Origin kontrolü tarayıcı dışı programlarca taklit edilebilir; asıl koruma oda kodunun gizliliği.
- Relay adresi Cloudflare hesap alt adını içerir; bu yüzden koda yazılmaz, `.env`'de durur (git dışı). Dağıtım zip'inde ise bulunur (zip'i sadece birbirinize gönderin).
- "Tüm sitelerde çalıştır" açıkken içerik betiği her sayfada çalışır ama sadece `<video>` öğesine bakar; sayfa verisini okumaz/göndermez.
- (Artık geçerli değil: v0.3'ten beri WebRTC yok, taraflar birbirinin IP adresini görmez.)
