// Birlikte İzle — relay sunucusu.
// Her oda bir Durable Object; içindekiler arasında mesajları iletir.
// Film görüntüsü/sesi buradan geçmez. Geçenler: senkron komutları, sohbet (JSON) ve sesli sohbet paketleri (ikili).
// Ses paketleri istemcide oda koduyla AES-GCM ile şifrelenir; sunucu içeriği göremez, sadece iletir. Hiçbir şey kaydedilmez.
import { DurableObject } from "cloudflare:workers";

const MAX_PEERS = 4;
const MAX_MSG = 32 * 1024;
const RATE_PER_SEC = 40;            // kişi başı saniyede en fazla JSON mesajı
const ROOM_RE = /^[A-Za-z0-9_-]{6,64}$/;
// Sadece bu türler iletilir; başka her şey çöpe gider
const ALLOWED = new Set(["action", "tick", "chat", "react", "voice", "sync-req", "ad"]);

// Ses paketleri (ikili): istemci 40 ms'de bir paket yollar (~25/sn)
const AU_MIN = 16, AU_MAX = 2048;   // bayt
const AU_RATE = 50;                 // kişi başı saniyede en fazla ses paketi
// Ücretsiz plan koruması: Cloudflare günde 100.000 DO isteği veriyor, gelen WebSocket mesajı 20'si 1 istek sayılıyor.
// Oda başına günde en fazla 1,2 milyon ses paketi (= 60.000 istek, ~13 saat kesintisiz konuşma). Aşılırsa ses o gün durur,
// senkron ve sohbet çalışmaya devam eder. Ücret çıkmaz.
const AU_DAILY = 1_200_000;

// Sadece tarayıcı eklentilerinden bağlantı kabul et (web sitelerinin ziyaretçi tarayıcısı üzerinden bağlanmasını engeller).
// Not: tarayıcı dışı bir istemci Origin'i taklit edebilir; asıl koruma oda kodunun gizli olması.
function originOk(origin) {
  return !!origin && /^(chrome-extension|moz-extension):\/\/[a-z0-9-]+$/i.test(origin);
}

const today = () => new Date().toISOString().slice(0, 10); // UTC gün (Cloudflare kotası UTC'de sıfırlanır)

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.rate = new Map();   // ws -> {t, n}   JSON mesajları
    this.arate = new Map();  // ws -> {t, n}   ses paketleri
    this.au = { day: today(), n: 0 };
    this.limitNoticeAt = 0;
    ctx.blockConcurrencyWhile(async () => {
      const s = await ctx.storage.get("au");
      if (s && s.day === today() && Number.isFinite(s.n)) this.au = s;
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const name = (url.searchParams.get("name") || "Misafir").replace(/[\u0000-\u001f<>]/g, "").slice(0, 24) || "Misafir";

    const others = this.ctx.getWebSockets();
    if (others.length >= MAX_PEERS) return new Response("Oda dolu", { status: 403 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const id = crypto.randomUUID().slice(0, 8);

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, name });

    const peers = others.map((ws) => ws.deserializeAttachment());
    server.send(JSON.stringify({ type: "welcome", id, peers }));
    this.broadcast({ type: "peer-join", id, name }, server);

    return new Response(null, { status: 101, webSocket: client });
  }

  allow(map, ws, limit) {
    const now = Date.now();
    let r = map.get(ws);
    if (!r || now - r.t >= 1000) { r = { t: now, n: 0 }; map.set(ws, r); }
    return ++r.n <= limit;
  }

  // Günlük ses kotası; sayaç ara ara kalıcı depoya yazılır (DO yeniden başlasa da sıfırlanmasın)
  audioBudget() {
    const d = today();
    if (this.au.day !== d) this.au = { day: d, n: 0 };
    if (this.au.n >= AU_DAILY) return false;
    if (++this.au.n % 500 === 0) this.ctx.storage.put("au", this.au);
    return true;
  }

  webSocketMessage(ws, raw) {
    if (typeof raw !== "string") return this.audio(ws, raw);
    if (raw.length > MAX_MSG) return;
    if (!this.allow(this.rate, ws, RATE_PER_SEC)) return;
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) return;

    if (msg.type === "ping") {
      ws.send(JSON.stringify({ type: "pong", t0: Number(msg.t0) || 0, ts: Date.now() }));
      return;
    }
    if (!ALLOWED.has(msg.type)) return;

    const me = ws.deserializeAttachment();
    // Gönderen bilgisi her zaman sunucudan gelir; istemcinin yazdığı from/fromName yok sayılır
    msg.from = me.id;
    msg.fromName = me.name;
    msg.ts = Date.now();
    const to = typeof msg.to === "string" ? msg.to : null;
    const data = JSON.stringify(msg);

    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      if (to && other.deserializeAttachment().id !== to) continue;
      try { other.send(data); } catch {}
    }
  }

  // Ses paketi: içeriğe bakılmaz (şifreli). Başına sunucu, gönderenin 8 karakterlik kimliğini ekler (taklit edilemez).
  audio(ws, buf) {
    if (!(buf instanceof ArrayBuffer) || buf.byteLength < AU_MIN || buf.byteLength > AU_MAX) return;
    if (!this.allow(this.arate, ws, AU_RATE)) return;
    if (!this.audioBudget()) {
      const now = Date.now();
      if (now - this.limitNoticeAt > 60000) {
        this.limitNoticeAt = now;
        this.broadcast({ type: "voice-limit" });
      }
      return;
    }
    const me = ws.deserializeAttachment();
    const out = new Uint8Array(8 + buf.byteLength);
    out.set(new TextEncoder().encode(me.id.padEnd(8, "_").slice(0, 8)), 0);
    out.set(new Uint8Array(buf), 8);
    for (const other of this.ctx.getWebSockets()) {
      if (other === ws) continue;
      try { other.send(out); } catch {}
    }
  }

  webSocketClose(ws, code) {
    this.leave(ws);
    try { ws.close(code, "bye"); } catch {}
  }

  webSocketError(ws) {
    this.leave(ws);
  }

  leave(ws) {
    this.rate.delete(ws);
    this.arate.delete(ws);
    const me = ws.deserializeAttachment();
    if (me) this.broadcast({ type: "peer-leave", id: me.id, name: me.name }, ws);
  }

  broadcast(obj, except) {
    const data = JSON.stringify(obj);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      try { ws.send(data); } catch {}
    }
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const m = url.pathname.match(/^\/room\/([^/]+)$/);
    if (!m) return new Response("Birlikte İzle relay çalışıyor.", { status: 200 });
    if (!ROOM_RE.test(m[1])) return new Response("Geçersiz oda kodu (en az 6 karakter: harf, rakam, - _)", { status: 400 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("WebSocket bekleniyor", { status: 426 });
    if (!originOk(request.headers.get("Origin"))) return new Response("Yetkisiz kaynak", { status: 403 });
    const stub = env.ROOMS.get(env.ROOMS.idFromName(m[1]));
    return stub.fetch(request);
  },
};
