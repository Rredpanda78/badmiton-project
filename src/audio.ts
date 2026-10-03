// 音效引擎：全部用 WebAudio 即時合成（不需要音檔）
// 匯流排：音效 sfx、場景環境音 amb、音樂 music → 主音量；另有共用殘響
import type { Venue } from './config';

let ctx: AudioContext | null = null;
let master: GainNode;
let sfxBus: GainNode;
let ambBus: GainNode;
let musicBus: GainNode;
let reverb: ConvolverNode;
let reverbSend: GainNode;
let noiseBuf: AudioBuffer;
let sfxOn = true;
let musicOn = true;

/** 第一次觸控時呼叫：建立 / 喚醒 AudioContext，並處理 iPhone 靜音鍵 */
export function unlockAudio(): void {
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      return;
    }
    build();
  }
  // iPhone：靜音鍵開著時 WebAudio 預設沒聲音 → 改成「播放」類別（Safari 17+），舊版用無聲 <audio> 解鎖
  try {
    const nav = navigator as Navigator & { audioSession?: { type: string } };
    if (nav.audioSession) nav.audioSession.type = 'playback';
  } catch {
    /* ignore */
  }
  playSilentHtmlAudio();
  if (ctx.state === 'suspended') void ctx.resume();
}

let silentPlayed = false;
function playSilentHtmlAudio(): void {
  if (silentPlayed) return;
  silentPlayed = true;
  try {
    const a = new Audio('data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQQAAACAgICA');
    a.setAttribute('playsinline', '');
    a.volume = 0.01;
    void a.play().catch(() => {});
  } catch {
    /* ignore */
  }
}

function build(): void {
  const c = ctx!;
  master = c.createGain();
  master.gain.value = 0.9;
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 4;
  master.connect(comp).connect(c.destination);

  sfxBus = c.createGain();
  ambBus = c.createGain();
  musicBus = c.createGain();
  sfxBus.gain.value = sfxOn ? 1 : 0;
  ambBus.gain.value = sfxOn ? 0.5 : 0;
  musicBus.gain.value = 0;
  sfxBus.connect(master);
  ambBus.connect(master);
  musicBus.connect(master);

  // 殘響：用衰減雜訊當脈衝響應
  reverb = c.createConvolver();
  reverb.buffer = impulse(1.6, 2.6);
  reverbSend = c.createGain();
  reverbSend.gain.value = 0.18;
  reverbSend.connect(reverb).connect(master);

  noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

  if (pendingVenue) ambience.setVenue(pendingVenue);
  music.sync();
}

function impulse(secs: number, decay: number): AudioBuffer {
  const c = ctx!;
  const len = Math.floor(c.sampleRate * secs);
  const b = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
  }
  return b;
}

export function setSfxOn(on: boolean): void {
  sfxOn = on;
  if (!ctx) return;
  sfxBus.gain.setTargetAtTime(on ? 1 : 0, ctx.currentTime, 0.05);
  ambBus.gain.setTargetAtTime(on ? 0.5 : 0, ctx.currentTime, 0.2);
  if (!on) speechSynthesis?.cancel();
}

export function setMusicOn(on: boolean): void {
  musicOn = on;
  music.sync();
}

// ---------- 基本合成積木 ----------

interface NoiseOpt {
  dur: number;
  freq: number;
  q?: number;
  type?: BiquadFilterType;
  gain: number;
  delay?: number;
  attack?: number;
  bus?: AudioNode;
  rev?: number; // 殘響送出量
  sweepTo?: number; // 濾波頻率滑到
}

function noise(o: NoiseOpt): void {
  if (!ctx) return;
  const t0 = ctx.currentTime + (o.delay ?? 0);
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  const f = ctx.createBiquadFilter();
  f.type = o.type ?? 'bandpass';
  f.frequency.setValueAtTime(o.freq, t0);
  if (o.sweepTo) f.frequency.exponentialRampToValueAtTime(o.sweepTo, t0 + o.dur);
  f.Q.value = o.q ?? 1;
  const g = ctx.createGain();
  const a = o.attack ?? 0.002;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(o.gain, t0 + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
  src.connect(f).connect(g).connect(o.bus ?? sfxBus);
  if (o.rev) {
    const s = ctx.createGain();
    s.gain.value = o.rev;
    g.connect(s).connect(reverbSend);
  }
  src.start(t0, Math.random() * 1.5);
  src.stop(t0 + o.dur + 0.05);
}

interface ToneOpt {
  freq: number;
  dur: number;
  gain: number;
  delay?: number;
  type?: OscillatorType;
  to?: number; // 頻率滑到
  bus?: AudioNode;
  attack?: number;
  rev?: number;
}

function tone(o: ToneOpt): void {
  if (!ctx) return;
  const t0 = ctx.currentTime + (o.delay ?? 0);
  const osc = ctx.createOscillator();
  osc.type = o.type ?? 'sine';
  osc.frequency.setValueAtTime(o.freq, t0);
  if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t0 + o.dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.linearRampToValueAtTime(o.gain, t0 + (o.attack ?? 0.005));
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
  osc.connect(g).connect(o.bus ?? sfxBus);
  if (o.rev) {
    const s = ctx.createGain();
    s.gain.value = o.rev;
    g.connect(s).connect(reverbSend);
  }
  osc.start(t0);
  osc.stop(t0 + o.dur + 0.05);
}

// ---------- 遊戲音效 ----------

export const sfx = {
  /** 擊球：拍線脆響＋軟木「啵」＋殺球的爆裂感；品質差就悶悶的 */
  hit(quality: number, speedKmh: number, jump: boolean) {
    const p = Math.min(1, speedKmh / 200);
    const pitch = 0.92 + Math.random() * 0.16;
    if (quality < 0.74) {
      noise({ dur: 0.07, freq: 900 * pitch, q: 0.9, gain: 0.45 + p * 0.3, rev: 0.2 });
      tone({ freq: 280 * pitch, dur: 0.06, gain: 0.1, type: 'triangle' });
      return;
    }
    noise({ dur: 0.025 + p * 0.02, freq: 4200 * pitch, q: 1.4, gain: 0.55 + p * 0.5, rev: 0.3 });
    noise({ dur: 0.05 + p * 0.04, freq: 1500 * pitch, q: 1.2, gain: 0.5 + p * 0.6, rev: 0.3 });
    tone({ freq: (330 - p * 90) * pitch, to: 160, dur: 0.07 + p * 0.05, gain: 0.14 + p * 0.18, type: 'triangle' });
    if (p > 0.6 || jump) noise({ dur: 0.12, freq: 600, q: 0.6, type: 'lowpass', gain: 0.5 + (jump ? 0.3 : 0), rev: 0.5 });
    if (quality >= 0.9) tone({ freq: 2900, dur: 0.07, gain: 0.07, delay: 0.004 }); // 完美的「叮」
  },
  /** 揮拍破風 */
  whoosh() {
    noise({ dur: 0.14, freq: 900, sweepTo: 2600, q: 0.8, gain: 0.16, attack: 0.03 });
  },
  whiff() {
    noise({ dur: 0.16, freq: 700, sweepTo: 300, q: 0.7, gain: 0.22, attack: 0.02 });
  },
  /** 連按兩下（跳殺待命／上手）提示 */
  jumpArm() {
    tone({ freq: 880, dur: 0.05, gain: 0.07 });
    tone({ freq: 1320, dur: 0.07, gain: 0.07, delay: 0.05 });
  },
  jump() {
    noise({ dur: 0.06, freq: 2600, q: 3, gain: 0.18 });
    noise({ dur: 0.08, freq: 400, q: 0.9, gain: 0.25 });
  },
  /** 跳殺落地 */
  thud() {
    noise({ dur: 0.12, freq: 180, q: 0.8, type: 'lowpass', gain: 0.6, rev: 0.3 });
    sfx.squeak(0.6);
  },
  /** 球鞋在地板上的「吱」聲（急停、轉向、弓箭步） */
  squeak(vol = 1) {
    const base = 2200 + Math.random() * 1600;
    const dur = 0.07 + Math.random() * 0.08;
    tone({ freq: base, to: base * (0.7 + Math.random() * 0.6), dur, gain: 0.045 * vol, type: 'sawtooth', attack: 0.01, rev: 0.2 });
    noise({ dur, freq: base, q: 8, gain: 0.12 * vol, attack: 0.01 });
  },
  /** 蓄力跨區提示：進好球區（輕）／出界區（低沉警告） */
  tick(out: boolean) {
    if (out) tone({ freq: 220, dur: 0.08, gain: 0.1, type: 'square' });
    else tone({ freq: 1560, dur: 0.035, gain: 0.06 });
  },
  net() {
    noise({ dur: 0.18, freq: 500, q: 0.7, gain: 0.45 });
    noise({ dur: 0.3, freq: 2500, q: 0.5, gain: 0.08, delay: 0.02 });
  },
  /** 羽球落地 */
  land() {
    noise({ dur: 0.05, freq: 1100, q: 2, gain: 0.25, rev: 0.25 });
    tone({ freq: 220, to: 120, dur: 0.06, gain: 0.08, type: 'triangle' });
  },
  point(win: boolean) {
    if (win) {
      tone({ freq: 660, dur: 0.14, gain: 0.12 });
      tone({ freq: 990, dur: 0.22, gain: 0.12, delay: 0.1 });
    } else {
      tone({ freq: 330, dur: 0.2, gain: 0.1 });
      tone({ freq: 247, dur: 0.28, gain: 0.1, delay: 0.12 });
    }
  },
  /** 觀眾掌聲：一堆隨機的小拍手聲；intensity 0~1，高的時候加上歡呼聲浪 */
  applause(intensity: number) {
    if (!ctx) return;
    const n = Math.round(18 + intensity * 70);
    const span = 1.0 + intensity * 1.6;
    for (let i = 0; i < n; i++) {
      const d = Math.random() * span * Math.random() + Math.random() * 0.15;
      noise({ dur: 0.03 + Math.random() * 0.03, freq: 1200 + Math.random() * 1800, q: 1.2, gain: 0.05 + Math.random() * 0.05 * (0.6 + intensity), delay: d, rev: 0.6 });
    }
    if (intensity > 0.55) noise({ dur: 1.4, freq: 700, q: 0.5, gain: 0.12 * intensity, attack: 0.25, delay: 0.05, rev: 0.6 });
  },
  /** 選單按鈕 */
  click() {
    tone({ freq: 1200, dur: 0.03, gain: 0.05 });
  },
};

// ---------- 裁判報分（瀏覽器內建語音） ----------

let speechOn = true;
export function setSpeechOn(on: boolean): void {
  speechOn = on;
  if (!on && typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
}

export function callScore(text: string): void {
  if (!speechOn || !sfxOn || typeof speechSynthesis === 'undefined') return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    const voices = speechSynthesis.getVoices();
    const v = voices.find((x) => /zh[-_]TW/i.test(x.lang)) ?? voices.find((x) => /^zh/i.test(x.lang));
    if (v) u.voice = v;
    u.lang = v?.lang ?? 'zh-TW';
    u.rate = 1.05;
    u.volume = 0.9;
    speechSynthesis.speak(u);
  } catch {
    /* 不支援語音就算了 */
  }
}

// ---------- 場景環境音 ----------

let pendingVenue: Venue | null = null;

export const ambience = {
  nodes: [] as AudioScheduledSourceNode[],
  timers: [] as number[],
  venue: null as Venue | null,

  setVenue(v: Venue) {
    pendingVenue = v;
    if (!ctx || v === this.venue) return;
    this.stop();
    this.venue = v;
    if (v === 'sakura') this.birds(1);
    if (v === 'bamboo') {
      this.bed(500, 0.6, 0.22, 0.12, 300); // 竹林的風
      this.birds(0.4);
      this.every(4, 9, () => {
        // 竹子互相敲擊的「喀喀」
        const n = 2 + Math.floor(Math.random() * 3);
        for (let i = 0; i < n; i++) noise({ dur: 0.05, freq: 850 + Math.random() * 300, q: 12, gain: 0.08, delay: i * (0.09 + Math.random() * 0.08), bus: ambBus, rev: 0.3 });
      });
    }
    if (v === 'night') {
      this.bed(4500, 6, 0.02, 0.3, 200);
      this.every(0.6, 1.6, () => {
        const f = 4200 + Math.random() * 900;
        for (let i = 0; i < 3; i++) tone({ freq: f, dur: 0.035, gain: 0.025, delay: i * 0.05, type: 'triangle', bus: ambBus }); // 蟋蟀
      });
    }
    if (v === 'indoor') {
      this.bed(650, 0.7, 0.12, 0.08, 150); // 觀眾席的嗡嗡人聲
      this.every(6, 14, () => noise({ dur: 0.08, freq: 1800, q: 2, gain: 0.03, bus: ambBus, rev: 0.8 }));
    }
    if (v === 'market') {
      this.babble(); // 人聲嘈雜
      this.every(4, 10, () => this.vendorCall()); // 遠處攤販的吆喝
      this.every(2, 6, () => (Math.random() < 0.7 ? this.clatter() : this.chop())); // 碗盤碰撞／剁肉
      this.every(16, 32, () => this.scooterPass()); // 偶爾騎過去的機車
    }
    if (v === 'paddy') {
      this.bed(380, 0.5, 0.09, 0.07, 120); // 田野上的微風
      this.insects();
      this.every(0.35, 1.2, () => {
        // 青蛙：此起彼落，偶爾有一隻跟著回應
        this.croak(0);
        if (Math.random() < 0.3) this.croak(0.15 + Math.random() * 0.35);
      });
      this.birds(0.35);
    }
    if (v === 'beach') {
      this.surf(); // 一波一波的浪
      this.bed(320, 0.5, 0.05, 0.05, 90); // 海風
      this.every(5, 13, () => {
        this.gull(0);
        if (Math.random() < 0.35) this.gull(0.6 + Math.random() * 0.8);
      });
    }
    // 室內殘響大、戶外小（市場四周有店面，稍微多一點）
    reverbSend.gain.setTargetAtTime(v === 'indoor' ? 0.32 : v === 'market' ? 0.16 : 0.12, ctx.currentTime, 0.3);
  },

  stop() {
    for (const n of this.nodes) {
      try {
        n.stop();
      } catch {
        /* ignore */
      }
    }
    for (const t of this.timers) clearTimeout(t);
    this.nodes = [];
    this.timers = [];
    this.venue = null;
  },

  every(min: number, max: number, fn: () => void) {
    this.loop(Math.random() * max, () => {
      fn();
      return min + Math.random() * (max - min);
    });
  },

  /** 重複執行；fn 回傳下一次要隔幾秒。每個循環只佔 timers 裡的一格（不會越積越多） */
  loop(first: number, fn: () => number) {
    const i = this.timers.length;
    const run = () => {
      this.timers[i] = window.setTimeout(run, fn() * 1000);
    };
    this.timers.push(window.setTimeout(run, first * 1000));
  },

  /** 一個持續播放的雜訊來源（給環境音用；記下來，換場地時停掉） */
  noiseSrc(rate = 1): AudioBufferSourceNode {
    const src = ctx!.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    src.playbackRate.value = rate;
    src.start(0, Math.random() * 1.9);
    this.nodes.push(src);
    return src;
  },

  /**
   * 市場的人聲嘈雜：4 個帶通雜訊「聲部」（像母音的共振峰），音量各自被一條很慢的雜訊開開合合（像一個個音節），
   * 共振峰位置也慢慢飄。
   */
  babble() {
    const c = ctx!;
    const voices: [number, number, number, number][] = [
      // 中心頻率、Q、音量、調變雜訊的播放速度（不同速度 → 不會聽出 2 秒循環）
      [430, 2.2, 0.2, 0.37],
      [800, 2.6, 0.18, 0.53],
      [1300, 3.0, 0.14, 0.71],
      [2400, 3.5, 0.08, 0.29],
    ];
    for (const [f, q, gain, rate] of voices) {
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = f;
      bp.Q.value = q;
      const amp = c.createGain();
      amp.gain.value = gain * 0.25;
      // 音節：低通到 6 Hz 的雜訊（約 ±0.01）放大後加到音量上
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 6;
      const depth = c.createGain();
      depth.gain.value = gain * 100;
      this.noiseSrc(rate).connect(lp).connect(depth).connect(amp.gain);
      // 共振峰慢慢飄
      const drift = c.createOscillator();
      drift.frequency.value = 0.25 + Math.random() * 0.5;
      const dd = c.createGain();
      dd.gain.value = f * 0.22;
      drift.connect(dd).connect(bp.frequency);
      drift.start();
      this.nodes.push(drift);
      this.noiseSrc().connect(bp).connect(amp).connect(ambBus);
    }
  },

  /** 遠處攤販吆喝：2–4 個有音高起伏的音節（鋸齒波＋共振峰帶通），最後一個拉長往下掉；很小聲、帶殘響 */
  vendorCall() {
    const c = ctx!;
    const n = 2 + Math.floor(Math.random() * 3);
    const pitch = 210 + Math.random() * 170;
    const formant = 750 + Math.random() * 650;
    let t = c.currentTime + 0.05;
    for (let i = 0; i < n; i++) {
      const last = i === n - 1;
      const dur = last ? 0.35 + Math.random() * 0.2 : 0.13 + Math.random() * 0.15;
      const f0 = pitch * (0.92 + Math.random() * 0.3);
      const osc = c.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f0, t);
      osc.frequency.linearRampToValueAtTime(last ? f0 * 0.74 : f0 * (0.95 + Math.random() * 0.15), t + dur);
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = formant * (0.9 + Math.random() * 0.2);
      bp.Q.value = 2.5;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.03, t + 0.03);
      g.gain.setValueAtTime(0.03, t + dur * 0.7);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      const send = c.createGain();
      send.gain.value = 0.6;
      osc.connect(bp).connect(g).connect(ambBus);
      g.connect(send).connect(reverbSend);
      osc.start(t);
      osc.stop(t + dur + 0.05);
      t += dur + 0.03 + Math.random() * 0.07;
    }
  },

  /** 碗盤、鐵鍋碰撞的「叮噹」 */
  clatter() {
    const n = 2 + Math.floor(Math.random() * 3);
    let d = 0;
    for (let i = 0; i < n; i++) {
      const f = 2300 + Math.random() * 2200;
      tone({ freq: f, to: f * 0.985, dur: 0.07 + Math.random() * 0.09, gain: 0.01 + Math.random() * 0.01, delay: d, bus: ambBus, rev: 0.4 });
      noise({ dur: 0.025, freq: f * 0.8, q: 5, gain: 0.025, delay: d, bus: ambBus, rev: 0.3 });
      d += 0.05 + Math.random() * 0.12;
    }
  },

  /** 菜刀剁在砧板上：幾下悶悶的「咚」 */
  chop() {
    const n = 3 + Math.floor(Math.random() * 4);
    for (let i = 0; i < n; i++) noise({ dur: 0.05, freq: 420 + Math.random() * 120, q: 1.4, gain: 0.07, delay: i * (0.17 + Math.random() * 0.05), bus: ambBus, rev: 0.25 });
  },

  /** 遠處騎過去的機車：低沉的鋸齒波，先變大聲再變小、音高往下掉（像都卜勒效應） */
  scooterPass() {
    const c = ctx!;
    const t = c.currentTime + 0.05;
    const D = 2.8 + Math.random() * 1.2;
    const f = 80 + Math.random() * 25;
    const osc = c.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(f, t);
    osc.frequency.linearRampToValueAtTime(f * 1.06, t + D * 0.45);
    osc.frequency.linearRampToValueAtTime(f * 0.82, t + D);
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 480;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.03, t + D * 0.5);
    g.gain.exponentialRampToValueAtTime(0.0001, t + D);
    osc.connect(lp).connect(g).connect(ambBus);
    osc.start(t);
    osc.stop(t + D + 0.05);
  },

  /** 白天的蟲鳴：高頻帶通雜訊被 30 Hz 左右快速開合（嗡嗡的顫音），整體再很慢地一陣大一陣小 */
  insects() {
    const c = ctx!;
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 4700;
    bp.Q.value = 5;
    const amp = c.createGain();
    amp.gain.value = 0.03;
    const buzz = c.createOscillator();
    buzz.frequency.value = 31;
    const bd = c.createGain();
    bd.gain.value = 0.026;
    buzz.connect(bd).connect(amp.gain);
    const out = c.createGain();
    out.gain.value = 0.6;
    const swell = c.createOscillator();
    swell.frequency.value = 0.07;
    const sd = c.createGain();
    sd.gain.value = 0.4;
    swell.connect(sd).connect(out.gain);
    this.noiseSrc().connect(bp).connect(amp).connect(out).connect(ambBus);
    buzz.start();
    swell.start();
    this.nodes.push(buzz, swell);
  },

  /** 青蛙：2–3 下短促的方波脈衝（經過帶通變得「呱呱」的），音高往下掉一點 */
  croak(delay: number) {
    const c = ctx!;
    const f = 230 + Math.random() * 260;
    const n = 2 + Math.floor(Math.random() * 2);
    const gap = 0.06 + Math.random() * 0.035;
    const t0 = c.currentTime + 0.02 + delay;
    const vol = 0.018 + Math.random() * 0.017;
    const osc = c.createOscillator();
    osc.type = 'square';
    osc.frequency.setValueAtTime(f, t0);
    osc.frequency.linearRampToValueAtTime(f * 0.85, t0 + n * gap);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = f * 2.4;
    bp.Q.value = 3;
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    for (let i = 0; i < n; i++) {
      const t = t0 + i * gap;
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(vol, t + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t + gap * 0.75);
    }
    osc.connect(bp).connect(g).connect(ambBus);
    osc.start(t0);
    osc.stop(t0 + n * gap + 0.05);
  },

  /**
   * 海浪：低通雜訊（浪的轟聲）＋帶通雜訊（退潮時沙沙的水聲）。每 6–9 秒一波：
   * 湧過來時慢慢變大聲、變亮 → 拍岸最大聲 → 退回去時轟聲變小、沙沙聲出來再淡掉。
   */
  surf() {
    const c = ctx!;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 450;
    lp.Q.value = 0.5;
    const roar = c.createGain();
    roar.gain.value = 0.04;
    this.noiseSrc().connect(lp).connect(roar).connect(ambBus);
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 2600;
    bp.Q.value = 0.6;
    const hiss = c.createGain();
    hiss.gain.value = 0.0001;
    this.noiseSrc(0.83).connect(bp).connect(hiss).connect(ambBus);
    this.loop(0.3, () => {
      const D = 6 + Math.random() * 3;
      const t = c.currentTime;
      const peak = 0.11 + Math.random() * 0.06;
      roar.gain.setTargetAtTime(peak * 0.45, t, D * 0.15);
      lp.frequency.setTargetAtTime(700, t, D * 0.15);
      roar.gain.setTargetAtTime(peak, t + D * 0.38, 0.12);
      lp.frequency.setTargetAtTime(2000 + Math.random() * 600, t + D * 0.38, 0.1);
      roar.gain.setTargetAtTime(0.035, t + D * 0.48, D * 0.16);
      lp.frequency.setTargetAtTime(420, t + D * 0.48, D * 0.2);
      hiss.gain.setTargetAtTime(0.045 + Math.random() * 0.025, t + D * 0.42, 0.25);
      hiss.gain.setTargetAtTime(0.0001, t + D * 0.6, D * 0.12);
      return D;
    });
  },

  /** 海鷗：「ㄎㄧ—歐」一聲聲，音高先往上衝再往下滑 */
  gull(delay: number) {
    const c = ctx!;
    const n = 2 + Math.floor(Math.random() * 3);
    const base = 950 + Math.random() * 500;
    let t = c.currentTime + 0.02 + delay;
    for (let i = 0; i < n; i++) {
      const dur = 0.22 + Math.random() * 0.12;
      const osc = c.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(base * 0.9, t);
      osc.frequency.linearRampToValueAtTime(base * 1.45, t + 0.05);
      osc.frequency.exponentialRampToValueAtTime(base * 0.75, t + dur);
      const bp = c.createBiquadFilter();
      bp.type = 'bandpass';
      bp.frequency.value = 1900;
      bp.Q.value = 1.6;
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(0.022, t + 0.02);
      g.gain.setValueAtTime(0.022, t + dur * 0.5);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      const send = c.createGain();
      send.gain.value = 0.3;
      osc.connect(bp).connect(g).connect(ambBus);
      g.connect(send).connect(reverbSend);
      osc.start(t);
      osc.stop(t + dur + 0.05);
      t += dur + 0.1 + Math.random() * 0.12;
    }
  },

  /** 持續的濾波雜訊（風、人聲嗡嗡），濾波頻率慢慢晃 */
  bed(freq: number, q: number, gain: number, lfoRate: number, lfoDepth: number) {
    const c = ctx!;
    const src = c.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const f = c.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    f.Q.value = q;
    const lfo = c.createOscillator();
    lfo.frequency.value = lfoRate;
    const lg = c.createGain();
    lg.gain.value = lfoDepth;
    lfo.connect(lg).connect(f.frequency);
    const g = c.createGain();
    g.gain.value = gain;
    src.connect(f).connect(g).connect(ambBus);
    src.start();
    lfo.start();
    this.nodes.push(src, lfo);
  },

  birds(rate: number) {
    this.every(1.5 / rate, 5 / rate, () => {
      const base = 2400 + Math.random() * 1800;
      const n = 2 + Math.floor(Math.random() * 4);
      for (let i = 0; i < n; i++) {
        const f = base * (0.9 + Math.random() * 0.25);
        tone({ freq: f, to: f * (1.15 + Math.random() * 0.3), dur: 0.06 + Math.random() * 0.05, gain: 0.03, delay: i * 0.11, bus: ambBus });
      }
    });
  },
};

// ---------- 背景音樂：日式「都節」五聲音階的撥弦（配合櫻花、竹林） ----------

const SCALE = [0, 1, 5, 7, 8]; // 半音：D Eb G A Bb
const ROOT = 146.83; // D3
const pluckCache = new Map<number, AudioBuffer>();

/** Karplus-Strong 撥弦音 */
function pluckBuf(freq: number): AudioBuffer {
  const key = Math.round(freq);
  const hit = pluckCache.get(key);
  if (hit) return hit;
  const c = ctx!;
  const len = Math.floor(c.sampleRate * 1.6);
  const b = c.createBuffer(1, len, c.sampleRate);
  const d = b.getChannelData(0);
  const N = Math.max(2, Math.round(c.sampleRate / freq));
  for (let i = 0; i < N; i++) d[i] = Math.random() * 2 - 1;
  for (let i = N; i < len; i++) d[i] = 0.996 * 0.5 * (d[i - N] + d[i - N + 1]);
  pluckCache.set(key, b);
  return b;
}

function pluck(freq: number, at: number, gain: number): void {
  const c = ctx!;
  const s = c.createBufferSource();
  s.buffer = pluckBuf(freq);
  const g = c.createGain();
  g.gain.value = gain;
  s.connect(g).connect(musicBus);
  const send = c.createGain();
  send.gain.value = 0.5;
  g.connect(send).connect(reverbSend);
  s.start(at);
}

export const music = {
  playing: false,
  timer: 0,
  nextAt: 0,
  step: 0,
  note: 5,
  intensity: 1, // 選單 1；比賽中小聲一點

  setIntensity(x: number) {
    this.intensity = x;
    this.sync();
  },

  sync() {
    if (!ctx) return;
    musicBus.gain.setTargetAtTime(musicOn ? 0.22 * this.intensity : 0, ctx.currentTime, 0.4);
    if (musicOn && !this.playing) this.start();
    if (!musicOn && this.playing) this.stopLoop();
  },

  start() {
    if (!ctx || this.playing) return;
    this.playing = true;
    this.nextAt = ctx.currentTime + 0.1;
    const beat = 60 / 84 / 2; // 84 BPM 的八分音符
    const tick = () => {
      if (!this.playing || !ctx) return;
      while (this.nextAt < ctx.currentTime + 0.35) {
        const s = this.step++;
        // 低音：每小節第一拍
        if (s % 8 === 0) pluck((ROOT / 2) * Math.pow(2, SCALE[[0, 0, 3, 2][Math.floor(s / 8) % 4]] / 12), this.nextAt, 0.5);
        // 旋律：隨機漫步，偶爾休止
        if (Math.random() < 0.62) {
          this.note = Math.max(0, Math.min(11, this.note + [-2, -1, -1, 0, 1, 1, 2][Math.floor(Math.random() * 7)]));
          const deg = SCALE[this.note % 5] + 12 * Math.floor(this.note / 5);
          pluck(ROOT * Math.pow(2, deg / 12), this.nextAt + (Math.random() - 0.5) * 0.015, 0.32);
        }
        this.nextAt += beat;
      }
      this.timer = window.setTimeout(tick, 100);
    };
    tick();
  },

  stopLoop() {
    this.playing = false;
    clearTimeout(this.timer);
  },
};
