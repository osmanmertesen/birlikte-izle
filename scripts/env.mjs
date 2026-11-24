// .env okuyucu (bağımlılıksız). Sadece KEY=VALUE satırları; değerler çalıştırılmaz, kabuğa verilmez.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function loadEnv(file = path.join(ROOT, ".env")) {
  const out = {};
  if (!fs.existsSync(file)) return out;
  const text = fs.readFileSync(file, "utf8");
  if (text.length > 16384) throw new Error(".env çok büyük");
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^([A-Z][A-Z0-9_]{0,63})\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2].trim();
    if (/^(["']).*\1$/.test(v)) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

// Sadece ws:// ya da wss:// + makine adı (+ isteğe bağlı port/yol). Boşluk, tırnak, sorgu vb. yok.
export function validRelayUrl(v) {
  return typeof v === "string" && v.length <= 200 && /^wss?:\/\/[A-Za-z0-9.-]+(:\d{1,5})?(\/[A-Za-z0-9._~\/-]*)?$/.test(v);
}

// Öncelik: ortam değişkeni > .env
export function relayFromEnv(key) {
  const env = loadEnv();
  const v = (process.env[key] || env[key] || "").trim();
  if (v && !validRelayUrl(v)) throw new Error(`${key} geçersiz (ws:// ya da wss:// ile başlayan düz bir adres olmalı)`);
  return v;
}
