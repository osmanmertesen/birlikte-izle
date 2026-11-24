// Gerçek konuşma kaydını mikrofon gibi ver: RNNoise konuşmayı geçiriyor mu?
import { chromium } from "playwright";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { ROOT, relayFromEnv } from "../scripts/env.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXT = path.join(ROOT, "extension");
const WAV = path.resolve(process.env.WAV || "speech.wav");
const dir = path.resolve("profile-speech");
fs.rmSync(dir, { recursive: true, force: true });
const proc = spawn("C:/Program Files/Google/Chrome/Application/chrome.exe", [`--user-data-dir=${dir}`, "--remote-debugging-port=9360",
  "--enable-unsafe-extension-debugging", "--headless=new", "--no-first-run", "--mute-audio",
  "--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", `--use-file-for-fake-audio-capture=${WAV}`, "about:blank"], { stdio: "ignore" });
let b; for (let i = 0; i < 40 && !b; i++) { try { b = await chromium.connectOverCDP("http://127.0.0.1:9360"); } catch { await sleep(500); } }
const { id } = await (await b.newBrowserCDPSession()).send("Extensions.loadUnpacked", { path: EXT });
const pg = b.contexts()[0].pages()[0];
pg.on("pageerror", (e) => console.log("HATA", e.message));
await pg.goto(`chrome-extension://${id}/sidepanel.html`);
await sleep(500);
const measure = () => pg.evaluate(async () => {
  // Konuşma bandında (300-3400 Hz) enerji: konuşma geçiyor mu?
  const an = S.actx.createAnalyser(); an.fftSize = 2048; S.micNodes.limiter.connect(an);
  const f = new Float32Array(an.frequencyBinCount); const t = new Float32Array(2048);
  let speechE = 0, peak = 0, n = 0;
  for (let k = 0; k < 60; k++) {
    await new Promise((r) => setTimeout(r, 50));
    an.getFloatFrequencyData(f); an.getFloatTimeDomainData(t);
    for (const x of t) peak = Math.max(peak, Math.abs(x));
    const hz = S.actx.sampleRate / an.fftSize;
    for (let i = Math.floor(300 / hz); i < Math.floor(3400 / hz); i++) speechE += Math.pow(10, f[i] / 10);
    n++;
  }
  S.micNodes.limiter.disconnect(an);
  return { peak, speechDb: 10 * Math.log10(speechE / n) };
});
const setAi = (on) => pg.evaluate((on) => { const c = document.getElementById("ai"); c.checked = on; c.dispatchEvent(new Event("change")); }, on);
await pg.evaluate(() => { const g = document.getElementById("gate"); g.value = -60; g.dispatchEvent(new Event("input")); });
await setAi(false);
await pg.evaluate(() => { audioCtx(); document.getElementById("mic").click(); });
await sleep(2500);
const off = await measure();
await setAi(true);
await sleep(2500);
const on = await measure();
const rnn = await pg.evaluate(() => !!S.micNodes.rnn);
console.log("RNNoise kapalı:", JSON.stringify(off));
console.log("RNNoise açık  :", JSON.stringify(on), "rnn=", rnn);
const kayip = off.speechDb - on.speechDb;
if (process.env.WAV && process.env.WAV.includes("noise"))
  console.log(`${rnn && on.peak < off.peak * 0.05 ? "OK  " : "FAIL"} Fan gürültüsü RNNoise ile bastırılıyor (tepe ${off.peak.toFixed(3)} → ${on.peak.toFixed(5)})`);
else
  console.log(`${rnn && on.peak > 0.1 && kayip < 6 ? "OK  " : "FAIL"} Konuşma RNNoise'dan geçiyor (konuşma bandında kayıp ${kayip.toFixed(1)} dB)`);
proc.kill(); process.exit(0);
