// Dağıtım zip'i: önce .env'den config.js üretir, sonra extension/ klasörünü dagitim/birlikte-izle.zip yapar.
// Kullanım:  node scripts/paket.mjs     (Windows 10+ ve macOS'ta yerleşik "tar" kullanılır)
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { ROOT } from "./env.mjs";

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: false, ...opts }); // kabuk yok: argümanlar enjekte edilemez
  if (r.status !== 0) process.exit(r.status || 1);
};

run(process.execPath, [path.join(ROOT, "scripts", "config.mjs")]);

const outDir = path.join(ROOT, "dagitim");
fs.mkdirSync(outDir, { recursive: true });
const zip = path.join(outDir, "birlikte-izle.zip");
fs.rmSync(zip, { force: true });

// extension/ içeriği zip'te "birlikte-izle/" klasörü olarak dursun
const stage = path.join(outDir, "_stage");
fs.rmSync(stage, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, "extension"), path.join(stage, "birlikte-izle"), { recursive: true });
// Windows'ta yerleşik bsdtar (Git Bash'in GNU tar'ı zip yapamaz); macOS'ta sistem tar'ı zaten bsdtar
const tar = process.platform === "win32" ? path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
run(tar, ["-a", "-c", "-f", path.join("..", "birlikte-izle.zip"), "birlikte-izle"], { cwd: stage });
fs.rmSync(stage, { recursive: true, force: true });
console.log("Hazır:", path.relative(ROOT, zip));
