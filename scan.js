/**
 * scan.js — čtení QR z kamery.
 *
 * Primárně nativní BarcodeDetector (Chrome na Androidu — rychlý, šetří baterii),
 * fallback jsQR nad <canvas> (iOS Safari, starší prohlížeče). jsQR je vendorovaný
 * v lib/, aby čtečka fungovala i offline.
 */

const INTERVAL_MS = 120;          // jak často se kouká do obrazu
const STEJNY_KOD_TICHO_MS = 2500; // tentýž kód se podruhé neohlásí dřív

export class Ctecka {
  constructor(video, onKod) {
    this.video = video;
    this.onKod = onKod;
    this.stream = null;
    this.timer = null;
    this.detector = null;
    this.canvas = null;
    this.ctx = null;
    this.posledni = {kod: '', cas: 0};
    this.bezi = false;
  }

  get jeAktivni() {
    return this.bezi;
  }

  async start() {
    if (this.bezi) return;

    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error('Prohlížeč neumí pracovat s kamerou. Otevři aplikaci přes https://.');
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      video: {facingMode: {ideal: 'environment'}, width: {ideal: 1280}, height: {ideal: 720}},
      audio: false
    });
    this.video.srcObject = this.stream;
    this.video.setAttribute('playsinline', '');  // iOS jinak přepne na celou obrazovku
    await this.video.play();

    if ('BarcodeDetector' in window) {
      try {
        const podporovane = await window.BarcodeDetector.getSupportedFormats();
        if (podporovane.includes('qr_code')) {
          this.detector = new window.BarcodeDetector({formats: ['qr_code']});
        }
      } catch { /* spadneme na jsQR */ }
    }

    if (!this.detector) {
      this.canvas = document.createElement('canvas');
      this.ctx = this.canvas.getContext('2d', {willReadFrequently: true});
    }

    this.bezi = true;
    this.timer = setInterval(() => this.tik(), INTERVAL_MS);
  }

  stop() {
    this.bezi = false;
    clearInterval(this.timer);
    this.timer = null;
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    this.video.srcObject = null;
  }

  /** Po vyřízení verdiktu — ať jde tutéž kartu hned zkusit znovu. */
  zapomenPosledni() {
    this.posledni = {kod: '', cas: 0};
  }

  async tik() {
    if (!this.bezi || this.video.readyState < 2) return;

    let kod = null;
    try {
      kod = this.detector ? await this.pomociDetectoru() : this.pomociJsQr();
    } catch { /* jeden nepovedený snímek nevadí */ }

    if (!kod) return;

    const ted = Date.now();
    if (kod === this.posledni.kod && ted - this.posledni.cas < STEJNY_KOD_TICHO_MS) return;
    this.posledni = {kod, cas: ted};

    this.onKod(kod);
  }

  async pomociDetectoru() {
    const nalezy = await this.detector.detect(this.video);
    return nalezy.length ? nalezy[0].rawValue : null;
  }

  pomociJsQr() {
    if (typeof window.jsQR !== 'function') return null;

    // Zmenšený snímek stačí a je výrazně rychlejší než plné rozlišení.
    const sirka = 480;
    const pomer = this.video.videoHeight / this.video.videoWidth || 0.75;
    const vyska = Math.round(sirka * pomer);
    if (this.canvas.width !== sirka) {
      this.canvas.width = sirka;
      this.canvas.height = vyska;
    }

    this.ctx.drawImage(this.video, 0, 0, sirka, vyska);
    const obraz = this.ctx.getImageData(0, 0, sirka, vyska);
    const nalez = window.jsQR(obraz.data, sirka, vyska, {inversionAttempts: 'dontInvert'});
    return nalez ? nalez.data : null;
  }
}

/** Krátká zpětná vazba, aby obsluha nemusela koukat na displej. */
export function odezva(druh) {
  if (navigator.vibrate) {
    navigator.vibrate(druh === 'ok' ? 60 : druh === 'pozor' ? [80, 60, 80] : [140, 70, 140]);
  }
  pipni(druh);
}

let audioCtx = null;

function pipni(druh) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();

    const tony = druh === 'ok' ? [[880, 0.12]]
               : druh === 'pozor' ? [[660, 0.1], [660, 0.1]]
               : [[300, 0.18], [220, 0.22]];

    let cas = audioCtx.currentTime;
    for (const [frekvence, delka] of tony) {
      const osc = audioCtx.createOscillator();
      const zisk = audioCtx.createGain();
      osc.frequency.value = frekvence;
      osc.type = 'sine';
      zisk.gain.setValueAtTime(0.0001, cas);
      zisk.gain.exponentialRampToValueAtTime(0.25, cas + 0.01);
      zisk.gain.exponentialRampToValueAtTime(0.0001, cas + delka);
      osc.connect(zisk).connect(audioCtx.destination);
      osc.start(cas);
      osc.stop(cas + delka + 0.02);
      cas += delka + 0.06;
    }
  } catch { /* zvuk je bonus, ne nutnost */ }
}
