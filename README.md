# Birlikte İzle

Farklı ağlardaki iki-dört kişinin Netflix, Prime Video, TOD, YouTube ve diğer video sitelerinde **senkron** izlemesi için Chrome eklentisi + küçük bir Cloudflare relay sunucusu. Sohbet, emoji ve **uçtan uca şifreli sesli sohbet** içerir.

- Görüntü aktarılmaz: herkes kendi hesabından izler, sadece oynat/durdur/sarma komutları gider.
- Ses Opus ile kodlanır, oda kodundan türetilen anahtarla AES-GCM-256 şifrelenir; relay içeriği göremez.
- Tam ekranda yan panel kendini gizler, her şey çalışmaya devam eder (Alt+B / Option+B ile geri açılır).

## Klasörler
| Yol | İçerik |
|---|---|
| `extension/` | Chrome MV3 eklentisi (offscreen çekirdek + yan panel) |
| `relay/` | Cloudflare Worker + Durable Object (oda başına WebSocket) |
| `scripts/` | `.env`'den ayar üretme (`config.mjs`) ve dağıtım zip'i (`paket.mjs`) |
| `test/` | Uçtan uca, site, relay güvenlik ve sır taraması testleri |

## Kurulum
Adım adım, her şeyiyle: **[REHBER.md](REHBER.md)**. Kısaca:

1. `relay/` klasöründe `npx wrangler login` ve `npx wrangler deploy` ile kendi relay'ini kur (ücretsiz plan yeter).
2. `.env.example` dosyasını `.env` adıyla kopyala, `RELAY_URL=wss://...` satırına kendi adresini yaz.
3. `node scripts/config.mjs` çalıştır, sonra `chrome://extensions` → Geliştirici modu → **Paketlenmemiş öğe yükle** → `extension/`.

`.env` ve üretilen `extension/config.js` git'e girmez.

## Testler
```powershell
cd relay; npx wrangler dev        # ayrı pencerede, yerel relay
cd test; npm i
node security-relay.mjs           # relay güvenliği
node e2e.mjs                      # iki Chrome ile uçtan uca
node sites-test.mjs               # her site + kötü niyetli katılımcı
node secrets-scan.mjs             # git'e sır/kişisel veri girmesin (commit öncesi)
```
Canlı relay'e karşı test için `.env`'de `TEST_RELAY_URL` ya da `RELAY` ortam değişkeni.

## Güvenlik
Alınan önlemler ve bilinen sınırlar: [GUVENLIK.md](GUVENLIK.md).

## Lisans
`extension/vendor/rnnoise/` kendi lisansıyla (MIT) gelir.
