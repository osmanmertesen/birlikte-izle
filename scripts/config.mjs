// .env'deki RELAY_URL'den extension/config.js üretir (git'e girmez).
// Kullanım:  node scripts/config.mjs
import fs from "fs";
import path from "path";
import { ROOT, relayFromEnv } from "./env.mjs";

let relay;
try {
  relay = relayFromEnv("RELAY_URL");
} catch (e) {
  console.error("HATA:", e.message);
  process.exit(1);
}

const out = path.join(ROOT, "extension", "config.js");
// JSON.stringify ile yazılır: değer kod olarak çalışamaz (zaten doğrulandı).
const js = `// OTOMATİK ÜRETİLDİ (scripts/config.mjs, .env'den). Elle düzenleme, git'e ekleme.
self.BI_CONFIG = Object.freeze({ relayUrl: ${JSON.stringify(relay)} });
`;
fs.writeFileSync(out, js, "utf8");
console.log(relay ? `extension/config.js yazıldı (sunucu ayarlandı).` : "extension/config.js yazıldı (RELAY_URL boş: panelde elle girilecek).");
