// Sır taraması: git'e girecek (izlenen + izlenmeyen ama yok sayılmayan) dosyalarda
// .env değerleri, sunucu adresi, eklenti ID'si, IP, API anahtarı, e-posta, ad/soyad, kişisel yollar var mı?
// Gizli dosyalar gerçekten dışarıda mı? Sadece kod + herkese açık belgeler mi giriyor?
// Kullanım (proje kökünde, git init sonrası, HER commit/push öncesi):  node test/secrets-scan.mjs
import fs from "fs";
import path from "path";
import os from "os";
import { spawnSync } from "child_process";
import { ROOT, loadEnv } from "../scripts/env.mjs";

const SELF = "test/secrets-scan.mjs"; // kalıpların kendisi burada, içerik taramasından muaf
const git = (...a) => {
  const r = spawnSync("git", a, { cwd: ROOT, encoding: "utf8", shell: false });
  if (r.status !== 0) throw new Error("git " + a.join(" ") + ": " + r.stderr);
  return r.stdout;
};
const gitCfg = (k) => (spawnSync("git", ["config", k], { cwd: ROOT, encoding: "utf8", shell: false }).stdout || "").trim();
const results = [];
const check = (name, ok, info = "") => { results.push(ok); console.log(`${ok ? "GEÇTİ" : "KALDI"}  ${name}${info ? "  — " + info : ""}`); };
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const files = git("ls-files", "--cached", "--others", "--exclude-standard", "-z").split("\0").filter(Boolean);
check("git'e girecek dosya listesi alındı", files.length > 0, files.length + " dosya");

// ---------- 1) Hangi dosyalar giriyor ----------
for (const bad of [".env", "extension/config.js", "CLAUDE.md", "CLAUDE.local.md"]) check(`${bad} git dışında`, !files.includes(bad));
check("dagitim/ (zip'ler) git dışında", !files.some((f) => f.startsWith("dagitim/")));
check("relay/.wrangler git dışında (Cloudflare hesap önbelleği)", !files.some((f) => f.includes(".wrangler/")));
check("node_modules ve test profilleri git dışında", !files.some((f) => /node_modules\/|profile-|ext-allsites\//.test(f)));
check("Zip/arşiv/anahtar dosyası git'e girmiyor", !files.some((f) => /\.(zip|tar|gz|7z|rar|crx|pem|key|p12|sqlite|log)$/i.test(f)));
check(".env.example git'te (şablon)", files.includes(".env.example"));
// İzin listesi: yeni bir dosya türü eklenirse önce buraya bilerek eklensin
const ALLOW = [/^extension\//, /^relay\/src\//, /^relay\/wrangler\.toml$/, /^scripts\/[^/]+\.mjs$/, /^test\/[^/]+\.(mjs|cjs|json)$/,
  /^(README|REHBER|GUVENLIK)\.md$/, /^\.env\.example$/, /^\.git(ignore|attributes)$/, /^LICENSE$/];
const stray = files.filter((f) => !ALLOW.some((re) => re.test(f)));
check("Sadece kod ve herkese açık belgeler git'e giriyor", stray.length === 0, stray.join(", "));

// ---------- 2) Aranacak kişisel değerler ----------
const env = loadEnv();
const secrets = [];
for (const [k, v] of Object.entries(env)) {
  if (!v || v.length < 6) continue;
  for (const part of k === "BI_EXTENSION_IDS" ? v.split(",") : [v]) if (part.trim()) secrets.push([`.env değeri (${k})`, part.trim()]);
  const host = /^wss?:\/\/([^/:]+)/.exec(v);
  if (host) {
    secrets.push([`sunucu adı (${k})`, host[1]]);
    if (host[1].endsWith(".workers.dev")) { const sub = host[1].split(".").slice(-3, -2)[0]; if (sub && sub.length >= 4) secrets.push([`Cloudflare hesap alt adı (${k})`, sub]); }
  }
}
const email = gitCfg("user.email");
if (email.length >= 6) secrets.push(["git e-postası", email], ["e-posta kullanıcı adı", email.split("@")[0]]);
// Ad/soyad, kullanıcı adı, bilgisayar adı: tam kelime olarak aranır ("Esen" ≠ "present")
const words = [];
for (const w of gitCfg("user.name").split(/\s+/)) if (w.length >= 3) words.push(["git'teki ad/soyad", w]);
if (os.hostname().length >= 4) words.push(["bilgisayar adı", os.hostname()]);
const user = os.userInfo().username;
if (user.length >= 4) words.push(["işletim sistemi kullanıcı adı", user]);
const wordRe = (w) => new RegExp("(^|[^\\p{L}\\p{N}_])" + esc(w) + "($|[^\\p{L}\\p{N}_])", "iu");

const patterns = [
  ["e-posta adresi", /[A-Za-z0-9._%+-]+@(?!example\.)[A-Za-z0-9-]+\.[A-Za-z]{2,}/],
  ["kişisel Windows yolu", /[A-Za-z]:[\\/]+Users[\\/]+(?!Public\b)[^\\/\s"'`]+/i],
  ["kişisel Mac/Linux yolu", /\/(Users|home)\/(?!<)[A-Za-z0-9._-]+\//],
  ["gerçek workers.dev adresi", /\b[a-z0-9-]+\.[a-z0-9-]{3,}\.workers\.dev\b/i],
  ["özel anahtar", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["anahtar/şifre ataması", /\b(CLOUDFLARE_API_TOKEN|CF_API_TOKEN|CF_ACCOUNT_ID|api[_-]?key|api[_-]?token|secret|password|passwd)\s*[:=]\s*["']?[A-Za-z0-9_\-]{12,}/i],
  ["Cloudflare account_id", /account_id\s*=\s*["']?[0-9a-f]{32}/i],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{30,}\b/],
  ["Google/AWS/Stripe/Slack anahtarı", /\bAIza[0-9A-Za-z_-]{35}\b|\bAKIA[0-9A-Z]{16}\b|\b[sr]k_live_[0-9A-Za-z]{16,}|\bxox[abp]-[0-9A-Za-z-]{10,}/],
  ["JWT", /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/],
];
// Sadece testlerdeki sahte değerlere izin var
const FAKE_IDS = new Set(["abcdefghijklmnopabcdefghijklmnop", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
const ALLOWED_IPS = new Set(["127.0.0.1", "0.0.0.0", "158.0.0.0"]); // yerel adres + Chrome sürüm numarası (user-agent)
const counted = (text) => {
  const out = [];
  for (const m of text.matchAll(/\b[a-p]{32}\b/g)) if (!FAKE_IDS.has(m[0])) out.push("Chrome eklenti ID'si");
  for (const m of text.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) if (!ALLOWED_IPS.has(m[0])) out.push("IP adresi");
  if (/\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b/i.test(text)) out.push("IPv6 adresi");
  return out;
};

// ---------- 3) İçerik taraması ----------
const hits = [];
for (const f of files) {
  const full = path.join(ROOT, f);
  if (!fs.existsSync(full)) continue;
  const buf = fs.readFileSync(full);
  const text = buf.toString("utf8");
  const low = text.toLowerCase();
  if (f !== SELF) {
    for (const [name, val] of secrets) if (low.includes(val.toLowerCase())) hits.push(`${f}: ${name}`);
    if (!buf.includes(0)) for (const [name, w] of words) if (wordRe(w).test(text)) hits.push(`${f}: ${name}`);
  }
  if (buf.includes(0) || f === SELF) continue; // ikili (wasm) dosyada sadece kişisel değerler aranır
  for (const [name, re] of patterns) if (re.test(text)) hits.push(`${f}: ${name}`);
  for (const n of new Set(counted(text))) hits.push(`${f}: ${n}`);
}
// Bulunan değerin kendisi yazılmaz (log'a sır düşmesin), sadece dosya + tür
check("git'e girecek dosyalarda sır / kişisel veri yok", hits.length === 0, [...new Set(hits)].slice(0, 25).join(" | "));
check("taranacak kişisel değer bulundu (tarama boş geçmesin)", secrets.length + words.length >= 3, (secrets.length + words.length) + " değer");

const pass = results.filter(Boolean).length;
console.log(`\n${pass}/${results.length} geçti`);
process.exit(pass === results.length ? 0 : 1);
