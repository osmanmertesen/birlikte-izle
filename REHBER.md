# Birlikte İzle — Adım Adım Kurulum ve Kullanım Rehberi

Bu rehber, hiç kurulum yapmamış birinin baştan sona her şeyi kendi başına kurabilmesi için yazıldı.
Toplam süre: ilk seferde yaklaşık **20–30 dakika**. Hepsi **ücretsiz**, kredi kartı gerekmez.

---

## İçindekiler
1. [Nasıl çalışıyor?](#1-nasıl-çalışıyor)
2. [Gerekenler](#2-gerekenler)
3. [Projeyi bilgisayarına indir](#3-projeyi-bilgisayarına-indir)
4. [Kendi relay sunucunu kur (Cloudflare, ücretsiz)](#4-kendi-relay-sunucunu-kur-cloudflare-ücretsiz)
5. [.env dosyasını hazırla](#5-env-dosyasını-hazırla)
6. [Eklentiyi Chrome'a yükle](#6-eklentiyi-chromea-yükle)
7. [Arkadaşına gönder](#7-arkadaşına-gönder)
8. [Birlikte izle](#8-birlikte-izle)
9. [Sesli sohbet](#9-sesli-sohbet)
10. [Tam ekran](#10-tam-ekran)
11. [Güncelleme](#11-güncelleme)
12. [Sorun giderme](#12-sorun-giderme)
13. [Güvenlik ve gizlilik](#13-güvenlik-ve-gizlilik)
14. [Geliştiriciler için: testler](#14-geliştiriciler-için-testler)

---

## 1) Nasıl çalışıyor?

- **Film aktarılmaz.** Herkes filmi kendi Netflix / Prime Video / TOD / YouTube hesabından açar.
- Eklenti sadece **oynat / durdur / sar** komutlarını, sohbet mesajlarını ve sesli sohbeti karşıya iletir.
- Bu iletimi senin kuracağın küçük bir **relay sunucusu** yapar (Cloudflare'in ücretsiz planında çalışır).
- Sesli sohbet **uçtan uca şifrelidir**: anahtar oda kodundan üretilir, sunucu bile dinleyemez.
- Bir odada en fazla **4 kişi** olabilir.

```
 Sen (Chrome + eklenti)  ⇄  Senin relay sunucun (Cloudflare)  ⇄  Arkadaşın (Chrome + eklenti)
```

> **Sunucuyu sadece bir kişi kurar.** Arkadaşın sunucu kurmaz; sadece eklentiyi yükler ve senin verdiğin
> sunucu adresi + oda koduyla bağlanır.

---

## 2) Gerekenler

| Ne | Kim için | Not |
|---|---|---|
| Google Chrome (güncel) | Herkes | Windows ya da macOS. Tam ekranda panelin kendini gizlemesi için Chrome 141+ |
| Node.js LTS | Sadece sunucuyu kuran kişi | https://nodejs.org → "LTS" sürümünü indir, kur |
| Ücretsiz Cloudflare hesabı | Sadece sunucuyu kuran kişi | https://dash.cloudflare.com/sign-up — kart istemez |
| Kulaklık | Herkes (önerilir) | Yoksa film sesi mikrofondan karşıya geri gider |

Node.js kuruldu mu kontrol et. Terminali aç (Windows: **PowerShell**, Mac: **Terminal**) ve yaz:

```
node -v
```

`v20...` ya da daha yeni bir sayı görmelisin.

---

## 3) Projeyi bilgisayarına indir

**Git biliyorsan:**
```
git clone <bu-deponun-adresi>
cd birlikte-izle
```

**Git bilmiyorsan:** GitHub sayfasında yeşil **Code** düğmesi → **Download ZIP** → zip'i aç.
Klasörü kalıcı bir yere koy (örneğin Belgeler). **Silme**, eklenti bu klasörden çalışır.

Klasörün içinde şunları görmelisin:

```
birlikte-izle/
├─ extension/      ← Chrome eklentisi
├─ relay/          ← sunucu kodu
├─ scripts/        ← ayar ve paketleme betikleri
├─ test/           ← testler
├─ .env.example    ← ayar şablonu
└─ REHBER.md       ← bu dosya
```

---

## 4) Kendi relay sunucunu kur (Cloudflare, ücretsiz)

> Bu bölümü **sadece bir kişi** yapar.

1. Terminalde projenin `relay` klasörüne gir:
   ```
   cd relay
   ```
2. Cloudflare hesabına giriş yap (tarayıcı açılır, **Allow** de):
   ```
   npx wrangler login
   ```
   İlk seferde "wrangler kurulsun mu?" diye sorarsa `y` yazıp Enter'a bas.
3. Sunucuyu yayınla:
   ```
   npx wrangler deploy
   ```
4. Çıktının sonunda şuna benzer bir adres görürsün:
   ```
   https://birlikte-izle-relay.<hesap-adın>.workers.dev
   ```
   Bu adresi bir yere not et. Eklentide kullanırken başındaki **`https://` yerine `wss://`** yazacaksın:
   ```
   wss://birlikte-izle-relay.<hesap-adın>.workers.dev
   ```

> **Bu adres sana özeldir.** İçinde Cloudflare hesap adın geçer. GitHub'a, foruma, herkese açık bir yere yazma;
> sadece birlikte izleyeceğin kişiye gönder.

**Ücret çıkar mı?** Hayır. Ücretsiz planda kart tanımlı olmadığı için fatura oluşmaz. Sunucu, ücretsiz kotayı
aşmamak için oda başına günde yaklaşık **13 saat kesintisiz konuşma** sınırı koyar; aşılırsa o gün sadece ses durur.

Bilgisayarında denemek istersen (isteğe bağlı): `npx wrangler dev` → adres `ws://127.0.0.1:8787`.

---

## 5) .env dosyasını hazırla

Gizli ayarlar (sunucu adresin gibi) koda yazılmaz, **`.env`** adlı dosyada durur. Bu dosya git'e **girmez**.

1. Proje kökündeki `.env.example` dosyasının bir kopyasını oluştur ve adını **`.env`** yap.
   - Windows (PowerShell, proje kökünde): `Copy-Item .env.example .env`
   - Mac (Terminal, proje kökünde): `cp .env.example .env`
   - Mac'te Finder nokta ile başlayan dosyaları gizler. Görmek için Finder'da **Cmd + Shift + .** tuşlarına bas.
2. `.env` dosyasını bir metin düzenleyiciyle aç (Not Defteri, TextEdit "düz metin" modu, VS Code…) ve
   `RELAY_URL=` satırına 4. adımdaki **wss://** adresini yaz:
   ```
   RELAY_URL=wss://birlikte-izle-relay.<hesap-adın>.workers.dev
   ```
   Tırnak, boşluk koyma. Kaydet.
3. Terminalde proje kökünde çalıştır:
   ```
   node scripts/config.mjs
   ```
   `extension/config.js yazıldı (sunucu ayarlandı).` görmelisin. Bu dosya da git'e girmez.

> `.env` yapmak istemezsen bu adımı atlayabilirsin. O zaman eklenti panelinde **Sunucu** alanı boş gelir,
> adresi oraya elle yazarsın. Bir kez yazınca hatırlanır.

---

## 6) Eklentiyi Chrome'a yükle

**Windows ve Mac'te aynı:**

1. Chrome'u aç, adres çubuğuna yaz: `chrome://extensions`
2. Sağ üstteki **Geliştirici modu** anahtarını aç.
3. Sol üstte **Paketlenmemiş öğe yükle**'ye bas.
4. Projenin içindeki **`extension`** klasörünü seç (içinde `manifest.json` olan klasör).
5. Sağ üstteki yapboz (🧩) simgesine tıkla, **Birlikte İzle**'nin yanındaki raptiyeye bas. Simge araç çubuğunda kalır.

Kartta sürüm numarasını görürsün (ör. `0.4.0`). **İzleyeceğin herkesin sürümü aynı olmalı.**

---

## 7) Arkadaşına gönder

Arkadaşının sunucu kurmasına gerek yok. İki yol var:

**Kolay yol: hazır zip gönder (önerilen)**
1. Proje kökünde çalıştır:
   ```
   node scripts/paket.mjs
   ```
2. `dagitim/birlikte-izle.zip` oluşur. İçinde sunucu adresin hazır gelir.
3. Bu zip'i arkadaşına **özelden** gönder (WhatsApp, Drive…). İçinde sunucu adresin olduğu için herkese açık yere koyma.
4. Arkadaşın zip'i açar, `birlikte-izle` klasörünü kalıcı bir yere koyar ve 6. adımı uygular
   (Mac kullanıcıları için klasörün içinde ayrıca `KURULUM-MAC.txt` var).

**Diğer yol:** Arkadaşın projeyi GitHub'dan indirip 6. adımı uygular. Sunucu adresini sen ona özelden yazarsın,
o da paneldeki **Sunucu** alanına yapıştırır.

---

## 8) Birlikte izle

1. İkiniz de aynı filmi / bölümü kendi hesabınızda açın. Oynatıcı sayfasında olun.
2. Araç çubuğundaki **Birlikte İzle** simgesine tıklayın ya da **Alt+B** (Mac: **Option+B**). Sağda bir panel açılır.
3. Birinizin panelinde 🎲 düğmesine basın. Güçlü, rastgele bir **oda kodu** üretilir. Bu kodu karşı tarafa **özelden** gönderin.
4. İkiniz de: **Sunucu** (dolu gelir), **Adın**, aynı **Oda kodu** → **Bağlan**.
5. Artık biriniz oynatınca, durdurunca ya da sarınca diğerinde de aynısı olur.
   - Kayma olursa **🔄 Eşitle**.
   - Farklı videodaysanız panel uyarır. **Onun videosunu aç** ile aynı videoya geçebilirsiniz.
6. Mesajlar ve emojiler hem panelde hem videonun üstünde görünür.

**Desteklenen siteler:** Netflix, Prime Video, TOD, YouTube.
**Başka bir video sitesi için:** Panelde **🌐 Tüm sitelerde çalıştır**'a basın ve Chrome'un sorduğu izne **İzin ver** deyin.
Video algılanmazsa sayfayı yenileyin, sonra panelde **📺 Bu sekmeyi bağla**'ya basın.

---

## 9) Sesli sohbet

1. Panelde **🎤 Mikrofonu aç**'a bas.
2. İlk seferde bir izin sekmesi açılır. **İzin ver** de, sekmeyi kapat, tekrar **Mikrofonu aç**'a bas.
   - **Mac:** "Chrome mikrofona erişmek istiyor" diye sorarsa **İzin Ver** de.
     Sormazsa: **Sistem Ayarları → Gizlilik ve Güvenlik → Mikrofon → Google Chrome** açık olmalı.
3. **Ortam sesini ölç**'e bas ve 3 saniye sessiz kal. Gürültü kapısı eşiği ayarlanır: konuşmadığın zaman fan, klavye vb. sesler gitmez.
4. **Kulaklık kullanın.**

Ayarlar:

| Ayar | Ne işe yarar |
|---|---|
| Mikrofon gücü | Sesin karşıya kısık gidiyorsa artır |
| Gürültü eşiği | Ortam sesi geçiyorsa artır, sözlerin kesiliyorsa azalt |
| Yapay zekâ gürültü engelleme (RNNoise) | Fan, klima, klavye sesini siler. Tamamen bilgisayarında çalışır |
| Tarayıcının gürültü engellemesi | Karşı taraf seni boğuk duyuyorsa kapat |
| 🔊 (karşı tarafın sesi) | Gelen sesi 3 kata kadar yükseltir |

---

## 10) Tam ekran

- Videoyu tam ekran yapınca panel **kendiliğinden gizlenir**. Senkron, mesajlar ve sesli sohbet çalışmaya devam eder.
  Mesajlar videonun üstünde görünür.
- Paneli geri açmak için **Alt+B** (Mac: **Option+B**) ya da araç çubuğundaki simge. Sohbet geçmişi ve bağlantı kaybolmaz.
- Kısayolu değiştirmek istersen: `chrome://extensions/shortcuts`.

---

## 11) Güncelleme

1. Yeni sürümü indir: `git pull` yap ya da yeni zip'i aç ve eski klasörün **yerine** koy.
2. `.env` kullanıyorsan `node scripts/config.mjs` komutunu tekrar çalıştır.
3. `chrome://extensions` → Birlikte İzle kartındaki **🔄 yenile** simgesine bas.
4. Arkadaşına da yeni zip'i gönder (`node scripts/paket.mjs`). **İkinizin sürümü aynı olmalı.**

---

## 12) Sorun giderme

| Belirti | Çözüm |
|---|---|
| "Oynatmak için videoya bir kez tıkla" | Tarayıcı otomatik oynatmayı engelledi. Videoya bir kez tıkla |
| Bağlanmıyor | Sunucu adresi `wss://` ile mi başlıyor? Oda kodu en az 6 karakter mi? `npx wrangler deploy` başarılı oldu mu? |
| Ses gitmiyor / gelmiyor | İki tarafın eklenti sürümü aynı mı? Mikrofon izni verildi mi (Mac: Sistem Ayarları)? Gürültü kapısı eşiği çok yüksek olabilir |
| "Bugünlük ücretsiz ses kotası doldu" | Ücretsiz plan koruması. Ertesi gün UTC gece yarısı (Türkiye saatiyle 03:00) kendiliğinden açılır; senkron ve mesajlar çalışmaya devam eder |
| Ses boğuk | "Tarayıcının gürültü engellemesi"ni kapat |
| Video algılanmadı | Sayfayı yenile, panelde **📺 Bu sekmeyi bağla** |
| Tam ekranda panel kapanmıyor | Chrome'u güncelle (141+ gerekir). Diğer her şey yine çalışır |
| `node` komutu bulunamadı | Node.js'i kur, terminali kapatıp yeniden aç |
| `.env` dosyası görünmüyor (Mac) | Finder'da Cmd + Shift + . |

---

## 13) Güvenlik ve gizlilik

- **Gizli kalması gerekenler:** sunucu adresin, oda kodun ve `.env` dosyan. Bunları herkese açık bir yere yazma.
  Oda kodunu bilen biri odaya girebilir ve sesi çözebilir. Her zaman 🎲 ile üretilen kodu kullan.
- Eklenti Netflix/Prime şifrelerine, çerezlerine ya da sayfa içeriğine **dokunmaz**. Sadece `<video>` öğesini kontrol eder.
- Sohbet kaydedilmez. Sadece eklentinin belleğinde, en fazla 300 satır durur; Chrome kapanınca silinir.
- Taraflar birbirinin IP adresini görmez. Her şey relay üzerinden gider.
- Ayrıntılar ve test listesi: [GUVENLIK.md](GUVENLIK.md).

**Projeyi kendi GitHub'ına koyacaksan:**
- `.env`, `extension/config.js`, `dagitim/` ve `relay/.wrangler/` zaten `.gitignore`'da. Bunları elle ekleme (`git add -f` kullanma).
- Her commit'ten önce sır taramasını çalıştır:
  ```
  node test/secrets-scan.mjs
  ```
  Sunucu adresin, Cloudflare hesap adın, e-postan, eklenti ID'in, IP adresi ya da API anahtarı gibi bir şey
  git'e girecekse uyarır ve `KALDI` der. Kendi eklenti ID'lerini `.env`'de `BI_EXTENSION_IDS=` satırına yazarsan onları da arar.
- Commit'lerde adın ve e-postan görünür. Gizlemek için GitHub'ın verdiği "noreply" adresini kullan:
  `git config user.email "<kullanıcı-adın>@users.noreply.github.com"`
  (GitHub → Settings → Emails → "Keep my email addresses private").

---

## 14) Geliştiriciler için: testler

```
cd test
npm i
```

| Komut | Ne test eder | Gerekenler |
|---|---|---|
| `node secrets-scan.mjs` | Git'e sır / kişisel veri girmiyor mu | git |
| `node security-relay.mjs` | Relay güvenliği (yetkisiz köken, kimlik taklidi, flood, boyut, oda sınırı, ses paketleri) | Çalışan relay |
| `node e2e.mjs` | İki Chrome ile uçtan uca senkron, sohbet, şifreli ses | Chrome + relay |
| `node sites-test.mjs` | Her site, iç çerçeve, kötü niyetli katılımcı | Chrome + relay |
| `node rnnoise.mjs` | Gürültü engelleme (önce `speech.wav` gerekir) | Chrome |

Relay adresi şu sırayla aranır: `RELAY` ortam değişkeni → `.env`'deki `TEST_RELAY_URL` → `ws://127.0.0.1:8787`
(ayrı bir terminalde `cd relay` ve `npx wrangler dev`).
Testlerde Chrome'un yeri Windows için `C:/Program Files/Google/Chrome/Application/chrome.exe` olarak yazılı; başka bir sistemde değiştir.
