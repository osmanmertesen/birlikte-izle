// Relay güvenlik testleri: yetkisiz bağlantı, kimlik taklidi, bilinmeyen tür, flood, büyük mesaj, oda sınırı, hedefli mesaj, ses paketleri.
import WebSocket from "ws";
import { relayFromEnv } from "../scripts/env.mjs";
const BASE = relayFromEnv("RELAY") || relayFromEnv("TEST_RELAY_URL") || "ws://127.0.0.1:8787";
const EXT_ORIGIN = "chrome-extension://abcdefghijklmnopabcdefghijklmnop";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, info = "") => { results.push(ok); console.log(`${ok ? "OK  " : "FAIL"} ${name} ${info}`); };
const room = () => "sec" + Math.random().toString(36).slice(2, 10);

function open(roomCode, name, origin = EXT_ORIGIN) {
  return new Promise((res) => {
    const headers = origin ? { Origin: origin } : {};
    const ws = new WebSocket(`${BASE}/room/${roomCode}?name=${encodeURIComponent(name)}`, { headers });
    ws.msgs = []; ws.bins = [];
    ws.on("message", (d, isBinary) => (isBinary ? ws.bins.push(Buffer.from(d)) : ws.msgs.push(JSON.parse(d.toString()))));
    ws.on("open", () => res({ ok: true, ws }));
    ws.on("unexpected-response", (_req, r) => res({ ok: false, status: r.statusCode }));
    ws.on("error", () => res({ ok: false, status: "error" }));
  });
}

// 1) Origin kontrolü
const r1 = await open(room(), "x", null);
check("Origin'siz bağlantı reddedildi", !r1.ok && r1.status === 403, `durum=${r1.status}`);
const r2 = await open(room(), "x", "https://kotu-site.example");
check("Web sitesinden (https origin) bağlantı reddedildi", !r2.ok && r2.status === 403, `durum=${r2.status}`);
const r3 = await open(room(), "x");
check("Eklenti origin'iyle bağlantı kabul edildi", r3.ok);
r3.ws?.close();

// 2) Oda kodu
const r4 = await open("abc", "x");
check("Kısa oda kodu (3 karakter) reddedildi", !r4.ok && r4.status === 400, `durum=${r4.status}`);
const r5 = await open("ab%2F..%2Fcd", "x");
check("Geçersiz karakterli oda kodu reddedildi", !r5.ok, `durum=${r5.status}`);

// 3) İsimdeki HTML temizleniyor, kimlik taklit edilemiyor, bilinmeyen tür iletilmiyor
const R = room();
const a = (await open(R, "Ada")).ws;
const b = (await open(R, "<img src=x onerror=alert(1)>Kötü")).ws;
await sleep(300);
const join = a.msgs.find((m) => m.type === "peer-join");
check("İsimdeki < > karakterleri temizlendi", join && !/[<>]/.test(join.name), `isim="${join && join.name}"`);
b.send(JSON.stringify({ type: "chat", text: "selam", from: "SAHTE", fromName: "Ada" }));
b.send(JSON.stringify({ type: "evil-cmd", payload: 1 }));
b.send(JSON.stringify({ type: "welcome", id: "x", peers: [] }));
b.send(JSON.stringify({ type: "peer-leave", id: "y", name: "z" }));
b.send("bozuk json {{{");
b.send(JSON.stringify([1, 2, 3]));
await sleep(500);
const chat = a.msgs.find((m) => m.type === "chat");
check("Gönderen kimliği taklit edilemiyor (from/fromName sunucudan)", chat && chat.from !== "SAHTE" && chat.fromName !== "Ada", `from=${chat && chat.from} fromName="${chat && chat.fromName}"`);
check("İzin listesinde olmayan türler iletilmedi (evil-cmd, sahte welcome/peer-leave)",
  !a.msgs.some((m) => m.type === "evil-cmd" || (m.type === "welcome" && m.id === "x") || (m.type === "peer-leave" && m.id === "y")));

// 4) Flood: 300 mesajı bir anda gönder, karşıya en fazla ~40/sn geçmeli
const before = a.msgs.length;
for (let i = 0; i < 300; i++) b.send(JSON.stringify({ type: "react", emoji: "🔥" }));
await sleep(1500);
const got = a.msgs.length - before;
check("Mesaj seli sınırlandı (saniyede ≤40)", got <= 45, `300 gönderildi, ${got} ulaştı`);
await sleep(1200);

// 5) Büyük mesaj
b.send(JSON.stringify({ type: "chat", text: "x".repeat(40000) }));
await sleep(500);
check("32 KB üstü mesaj düşürüldü", !a.msgs.some((m) => m.type === "chat" && m.text.length > 30000));

// 6) Hedefli mesaj sadece hedefe gider
const c = (await open(R, "Ucuncu")).ws;
await sleep(300);
const aId = b.msgs.find((m) => m.type === "welcome").peers.find((p) => p.name === "Ada").id;
b.send(JSON.stringify({ type: "chat", to: aId, text: "sadece-ada" }));
b.send(JSON.stringify({ type: "rtc", sdp: { type: "offer", sdp: "eski" } }));
await sleep(500);
check("Hedefli (to) mesaj başkasına sızmadı", a.msgs.some((m) => m.text === "sadece-ada") && !c.msgs.some((m) => m.text === "sadece-ada"));
check("Kaldırılan WebRTC türü (rtc) artık iletilmiyor", !a.msgs.some((m) => m.type === "rtc") && !c.msgs.some((m) => m.type === "rtc"));

// 6b) Ses paketleri (ikili)
const bId = a.msgs.find((m) => m.type === "peer-join" && m.name !== "Ucuncu").id;
const pkt = Buffer.alloc(120, 7); pkt.write("SAHTEID!", 0);
b.send(pkt);
await sleep(400);
const ga = a.bins.at(-1), gc = c.bins.at(-1);
check("Ses paketi odadakilere iletildi, gönderen kimliğini sunucu yazdı (taklit edilemez)",
  ga && gc && ga.length === 128 && ga.subarray(0, 8).toString().replace(/_+$/, "") === bId && ga.subarray(8).equals(pkt) && !b.bins.length,
  `başlık=${ga && ga.subarray(0, 8).toString()} b=${bId}`);
const n0 = a.bins.length;
b.send(Buffer.alloc(3000)); b.send(Buffer.alloc(5));
await sleep(400);
check("Çok büyük (3000 B) ve çok küçük (5 B) ses paketleri düşürüldü", a.bins.length === n0, `${a.bins.length - n0} geçti`);
await sleep(1100);
const n1 = a.bins.length;
for (let i = 0; i < 300; i++) b.send(Buffer.alloc(100, 1));
await sleep(1500);
const gotB = a.bins.length - n1;
check("Ses paketi seli sınırlandı (saniyede ≤50)", gotB <= 55, `300 gönderildi, ${gotB} ulaştı`);

// 7) Oda sınırı
const d = (await open(R, "Dorduncu")).ws;
const e = await open(R, "Besinci");
check("Odaya 5. kişi giremedi", !e.ok && e.status === 403, `durum=${e.status}`);

for (const w of [a, b, c, d]) w.close();
console.log(`\nSONUC: ${results.filter(Boolean).length}/${results.length} gecti`);
process.exit(0);
