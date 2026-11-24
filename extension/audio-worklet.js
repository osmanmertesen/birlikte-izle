// Ses işleme (ayrı ses iş parçacığında, örnek örnek çalışır).
// bi-gate:    gürültü kapısı + mikrofon gücü. Eşiğin altındaki ses (fan, uğultu) gönderilmez.
// bi-limiter: limitör. Çıkış hiçbir zaman tavanı (-1 dBFS) aşmaz, ses patlamaz.

const dbToLin = (db) => Math.pow(10, db / 20);
const linToDb = (x) => (x > 1e-6 ? 20 * Math.log10(x) : -120);

class Gate extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [
      { name: "threshold", defaultValue: -50, minValue: -90, maxValue: 0, automationRate: "k-rate" },
      { name: "gain", defaultValue: 1.5, minValue: 0, maxValue: 8, automationRate: "k-rate" },
    ];
  }
  constructor() {
    super();
    this.env = 0;       // ses seviyesi zarfı (RMS²)
    this.g = 0;         // kapının şu anki açıklığı (0..1)
    this.open = false;
    this.hold = 0;      // kapı kapanmadan önce bekleme (hece aralarında kesilmesin)
    this.n = 0;
    const sr = sampleRate;
    this.envCoef = Math.exp(-1 / (0.01 * sr));   // 10 ms ölçüm penceresi
    this.attack = Math.exp(-1 / (0.002 * sr));   // 2 ms'de açıl (konuşmanın başı kesilmesin)
    this.release = Math.exp(-1 / (0.15 * sr));   // 150 ms'de yumuşakça kapan
    this.holdN = Math.round(0.3 * sr);           // 300 ms bekle
    this.closedGain = dbToLin(-60);              // kapalıyken -60 dB (pratikte sessiz)
  }
  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0];
    if (!input || !input[0]) return true;
    const inp = input[0];
    const thr = params.threshold[0], gain = params.gain[0];
    const openLin = dbToLin(thr), closeLin = dbToLin(thr - 6); // 6 dB histerezis: eşikte titreşmesin
    let peakLvl = 0;
    for (let i = 0; i < inp.length; i++) {
      const x = inp[i];
      this.env = this.envCoef * this.env + (1 - this.envCoef) * x * x;
      const lvl = Math.sqrt(this.env) * 1.4142; // RMS → yaklaşık tepe
      if (lvl > peakLvl) peakLvl = lvl;
      if (lvl > openLin) { this.open = true; this.hold = this.holdN; }
      else if (this.hold > 0) this.hold--;
      else if (lvl < closeLin) this.open = false;
      const target = this.open ? 1 : this.closedGain;
      const c = target > this.g ? this.attack : this.release;
      this.g = c * this.g + (1 - c) * target;
      const y = x * this.g * gain;
      for (let ch = 0; ch < output.length; ch++) output[ch][i] = y;
    }
    if ((this.n += inp.length) >= 2048) {
      this.n = 0;
      this.port.postMessage({ level: linToDb(peakLvl), open: this.open });
    }
    return true;
  }
}

class Limiter extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: "ceiling", defaultValue: -1, minValue: -20, maxValue: 0, automationRate: "k-rate" }];
  }
  constructor() {
    super();
    this.g = 1;
    this.release = Math.exp(-1 / (0.1 * sampleRate)); // 100 ms'de geri gel
    this.n = 0;
    this.minG = 1;
  }
  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0];
    if (!input || !input[0]) return true;
    const inp = input[0];
    const ceil = dbToLin(params.ceiling[0]);
    for (let i = 0; i < inp.length; i++) {
      const x = inp[i], a = Math.abs(x);
      const need = a > ceil ? ceil / a : 1;
      // Tavanı aşacak tepede kazancı anında düşür, sonra yavaşça geri getir
      this.g = need < this.g ? need : this.release * this.g + (1 - this.release) * need;
      let y = x * this.g;
      if (y > ceil) y = ceil; else if (y < -ceil) y = -ceil; // son güvence
      for (let ch = 0; ch < output.length; ch++) output[ch][i] = y;
      if (this.g < this.minG) this.minG = this.g;
    }
    if ((this.n += inp.length) >= 2048) {
      this.n = 0;
      this.port.postMessage({ reduction: -linToDb(this.minG) });
      this.minG = 1;
    }
    return true;
  }
}

// bi-tap: işlenmiş mikrofon sesini 20 ms'lik (960 örnek @48 kHz) parçalar halinde ana iş parçacığına verir (Opus kodlayıcı için).
// active: parçada duyulabilir ses var mı (kapı kapalıyken çıkış ~-60 dB altındadır → gönderilmez, kota harcanmaz).
const FRAME = 960;
class Tap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(FRAME);
    this.i = 0;
    this.peak = 0;
    this.activeLin = dbToLin(-70);
  }
  process(inputs) {
    const inp = inputs[0] && inputs[0][0];
    if (!inp) return true;
    for (let k = 0; k < inp.length; k++) {
      const x = inp[k];
      this.buf[this.i++] = x;
      const a = x < 0 ? -x : x;
      if (a > this.peak) this.peak = a;
      if (this.i === FRAME) {
        const pcm = this.buf;
        this.port.postMessage({ pcm, active: this.peak > this.activeLin }, [pcm.buffer]);
        this.buf = new Float32Array(FRAME);
        this.i = 0; this.peak = 0;
      }
    }
    return true;
  }
}

// bi-play: karşıdan gelen çözülmüş sesi küçük bir tamponla (titreşim payı) çalar.
// Tampon boşalırsa sessizlik verir ve tekrar dolmasını bekler; çok birikirse (gecikme artmasın) eskiyi atar.
class Player extends AudioWorkletProcessor {
  constructor() {
    super();
    this.q = [];          // Float32Array kuyruğu
    this.off = 0;         // ilk parçada okunan konum
    this.size = 0;        // kuyruktaki toplam örnek
    this.playing = false;
    this.start = Math.round(0.06 * sampleRate);  // 60 ms birikince başla
    this.max = Math.round(0.3 * sampleRate);     // 300 ms'den fazla birikirse
    this.trim = Math.round(0.1 * sampleRate);    // 100 ms'ye indir
    this.port.onmessage = (e) => {
      const d = e.data;
      if (!(d instanceof Float32Array) || d.length === 0 || d.length > 48000) return;
      this.q.push(d); this.size += d.length;
      if (this.size > this.max) this.drop(this.size - this.trim);
    };
  }
  drop(n) {
    while (n > 0 && this.q.length) {
      const left = this.q[0].length - this.off;
      if (left <= n) { n -= left; this.size -= left; this.q.shift(); this.off = 0; }
      else { this.off += n; this.size -= n; n = 0; }
    }
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    if (!out) return true;
    if (!this.playing && this.size >= this.start) this.playing = true;
    let k = 0;
    if (this.playing) {
      while (k < out.length && this.q.length) {
        const cur = this.q[0];
        const n = Math.min(out.length - k, cur.length - this.off);
        out.set(cur.subarray(this.off, this.off + n), k);
        k += n; this.off += n; this.size -= n;
        if (this.off >= cur.length) { this.q.shift(); this.off = 0; }
      }
      if (k < out.length) this.playing = false; // boşaldı: yeniden dolmasını bekle
    }
    for (; k < out.length; k++) out[k] = 0;
    for (let ch = 1; ch < outputs[0].length; ch++) outputs[0][ch].set(out);
    return true;
  }
}

registerProcessor("bi-gate", Gate);
registerProcessor("bi-limiter", Limiter);
registerProcessor("bi-tap", Tap);
registerProcessor("bi-play", Player);
