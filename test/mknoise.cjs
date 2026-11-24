// 12 sn fan benzeri gürültü (kahverengi + biraz beyaz gürültü + 120 Hz uğultu), 48 kHz mono 16 bit WAV
const fs = require("fs");
const sr = 48000, n = sr * 12, buf = Buffer.alloc(44 + n * 2);
buf.write("RIFF", 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write("WAVEfmt ", 8);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sr, 24);
buf.writeUInt32LE(sr * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write("data", 36); buf.writeUInt32LE(n * 2, 40);
let brown = 0;
for (let i = 0; i < n; i++) {
  const w = Math.random() * 2 - 1;
  brown = (brown + 0.02 * w) / 1.02;
  const s = brown * 3.0 + w * 0.08 + 0.05 * Math.sin(2 * Math.PI * 120 * i / sr);
  buf.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(s * 0.5 * 32767))), 44 + i * 2);
}
fs.writeFileSync("noise.wav", buf);
