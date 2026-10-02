// 用 WebAudio 即時合成音效，不需要音檔
let ctx: AudioContext | null = null;
let muted = false;

export function unlockAudio(): void {
  if (!ctx) {
    try {
      ctx = new AudioContext();
    } catch {
      return;
    }
  }
  if (ctx.state === 'suspended') void ctx.resume();
}

export function setMuted(m: boolean): void {
  muted = m;
}

function noiseBurst(dur: number, freq: number, q: number, gain: number, delay = 0): void {
  if (!ctx || muted) return;
  const t0 = ctx.currentTime + delay;
  const len = Math.ceil(ctx.sampleRate * dur);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = freq;
  bp.Q.value = q;
  const g = ctx.createGain();
  g.gain.value = gain;
  src.connect(bp).connect(g).connect(ctx.destination);
  src.start(t0);
}

function tone(freq: number, dur: number, gain: number, delay = 0, type: OscillatorType = 'sine'): void {
  if (!ctx || muted) return;
  const t0 = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t0);
  g.gain.linearRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  o.connect(g).connect(ctx.destination);
  o.start(t0);
  o.stop(t0 + dur + 0.02);
}

export const sfx = {
  /** 擊球：品質越好越清脆、球越快越重；跳殺最大聲 */
  hit(quality: number, speedKmh: number, jump: boolean) {
    const p = Math.min(1, speedKmh / 220);
    if (quality < 0.78) {
      // 沒打好：悶悶的
      noiseBurst(0.06, 800, 0.8, 0.5 + p * 0.4);
      tone(300, 0.05, 0.1, 0, 'triangle');
      return;
    }
    noiseBurst(0.05 + p * 0.03, 2200 + p * 1000, 1.1 - p * 0.3, 0.55 + p * 0.9 + (jump ? 0.4 : 0));
    tone(260 - p * 60, 0.06 + p * 0.04, 0.12 + p * 0.15, 0, 'triangle');
    if (quality >= 0.92) tone(2900, 0.06, 0.08, 0.005); // 完美擊球的「叮」
  },
  /** 划動出拍的揮拍聲 */
  whoosh() {
    noiseBurst(0.09, 1300, 0.7, 0.18);
  },
  whiff() {
    noiseBurst(0.12, 700, 0.6, 0.25);
    tone(180, 0.08, 0.06, 0.05, 'sine');
  },
  /** 連按兩下進入跳殺模式 */
  jumpArm() {
    tone(880, 0.05, 0.08);
    tone(1320, 0.07, 0.08, 0.05);
  },
  jump() {
    noiseBurst(0.07, 500, 0.9, 0.3);
  },
  thud() {
    noiseBurst(0.08, 260, 1.0, 0.55);
  },
  /** 蓄力跨區提示：進入好球區（輕）／出界區（低沉警告） */
  tick(out: boolean) {
    if (out) tone(220, 0.07, 0.12, 0, 'square');
    else tone(1560, 0.03, 0.06);
  },
  net() {
    noiseBurst(0.12, 400, 0.8, 0.6);
  },
  land() {
    noiseBurst(0.06, 600, 1.5, 0.35);
  },
  point(win: boolean) {
    if (win) {
      tone(660, 0.14, 0.18);
      tone(990, 0.22, 0.18, 0.1);
    } else {
      tone(330, 0.2, 0.16);
      tone(247, 0.28, 0.16, 0.12);
    }
  },
};
