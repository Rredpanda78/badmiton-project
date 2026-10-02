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
  hit(power: number) {
    noiseBurst(0.05, 2400 + power * 1200, 1.2, 0.5 + power * 0.7);
    tone(900 + power * 500, 0.04, 0.12, 0, 'triangle');
  },
  smash() {
    noiseBurst(0.07, 1800, 0.9, 1.4);
    tone(220, 0.08, 0.25, 0, 'triangle');
  },
  whiff() {
    noiseBurst(0.12, 700, 0.6, 0.25);
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
