// 音效引擎：全部用 WebAudio 即時合成（不需要音檔）
// 匯流排：音效 sfx、場景環境音 amb、音樂 music → 主音量；另有共用殘響（每個場地的空間感不同）
import type { Venue } from './config';

let ctx: AudioContext | null = null;
let master: GainNode;
let sfxBus: GainNode;
let ambBus: GainNode;
let musicBus: GainNode;
let crowdBus: GainNode; // 觀眾掌聲／歡呼（統一送一份到殘響，不用每一下拍手各接一條）
let crowdSend: GainNode;
let reverbSend: GainNode; // 音效、環境音的殘響送出點（也會送到建築物回音）
let revWet: GainNode; // 殘響量（依場地）；音樂直接送這裡，不吃回音
let preDelay: DelayNode;
let revTone: BiquadFilterNode;
let slapDelay: DelayNode;
let slapOut: GainNode;
let noiseBuf: AudioBuffer;
let sfxOn = true;
let musicOn = true;

// ---------- 場地音效設定 ----------

/** 空間感：殘響長度／衰減／預延遲／整體量／殘響的亮度，以及建築物的反彈回音 */
interface Acoustics {
  secs: number;
  decay: number; // 衰減曲線指數：越大越快沒
  pre: number; // 預延遲（秒）：越大越像大空間
  send: number; // 殘響量
  tone: number; // 殘響回來的低通（Hz）：越低越悶、越柔
  slap: number; // 反彈回音量（0 = 沒有）
  slapTime: number;
  crowd: number; // 觀眾聲送進殘響的量
}
/** 球員腳下：室內運動地板、戶外球場墊（下面硬地）、木棧台、泥土地、水泥地 */
type Floor = 'gym' | 'mat' | 'deck' | 'earth' | 'concrete';
/** 觀眾：體育館、市場攤販、海灘一小群人、幾個農夫、花園派對、竹林裡安靜的幾個人 */
type Crowd = 'arena' | 'market' | 'beach' | 'farm' | 'garden' | 'quiet';
/** 得分提示音的音色 */
type Chime = 'arena' | 'bell' | 'steel' | 'wood' | 'koto' | 'bamboo';
/** 背景音樂：音階（5 音）、主音、速度、旋律密度、低音走向（音階的第幾個音）、琵琶式輪指、反拍刷弦 */
interface MusicStyle {
  scale: number[];
  root: number;
  bpm: number;
  density: number;
  bass: number[];
  tremolo?: number;
  offbeat?: boolean;
}
interface SoundProfile {
  acoustics: Acoustics;
  floor: Floor;
  crowd: Crowd;
  chime: Chime;
  music: MusicStyle;
}

const MIYAKO = [0, 1, 5, 7, 8]; // 日本都節音階
const YO = [0, 2, 5, 7, 9]; // 日本陽音階
const MAJOR5 = [0, 2, 4, 7, 9]; // 大調五聲（也是中國宮調）
const MINOR5 = [0, 3, 5, 7, 10]; // 小調五聲

const PROFILES: Record<Venue, SoundProfile> = {
  // 室內球館：大空間、長殘響、明顯的預延遲；運動地板吱吱叫；滿場觀眾
  indoor: {
    acoustics: { secs: 2.2, decay: 2.3, pre: 0.032, send: 0.34, tone: 6500, slap: 0, slapTime: 0.1, crowd: 0.6 },
    floor: 'gym',
    crowd: 'arena',
    chime: 'arena',
    music: { scale: MAJOR5, root: 164.81, bpm: 108, density: 0.74, bass: [0, 3, 4, 3] },
  },
  // 市場：戶外但四周有店面 → 短殘響＋一道清楚的反彈回音
  market: {
    acoustics: { secs: 0.8, decay: 3.4, pre: 0.012, send: 0.14, tone: 4200, slap: 0.3, slapTime: 0.115, crowd: 0.35 },
    floor: 'concrete',
    crowd: 'market',
    chime: 'bell',
    music: { scale: MAJOR5, root: 196.0, bpm: 96, density: 0.66, bass: [0, 0, 3, 4], tremolo: 0.18 },
  },
  // 竹林：竹子擋住、吸掉高頻 → 中等長度但很柔、很散的殘響
  bamboo: {
    acoustics: { secs: 1.4, decay: 2.8, pre: 0.008, send: 0.15, tone: 2100, slap: 0, slapTime: 0.1, crowd: 0.4 },
    floor: 'earth',
    crowd: 'quiet',
    chime: 'bamboo',
    music: { scale: YO, root: 146.83, bpm: 76, density: 0.5, bass: [0, 0, 2, 3] },
  },
  // 櫻花園：開闊的庭園，殘響短而乾淨
  sakura: {
    acoustics: { secs: 0.9, decay: 3.4, pre: 0.01, send: 0.11, tone: 3600, slap: 0, slapTime: 0.1, crowd: 0.3 },
    floor: 'mat',
    crowd: 'garden',
    chime: 'koto',
    music: { scale: MIYAKO, root: 146.83, bpm: 84, density: 0.62, bass: [0, 0, 3, 2] },
  },
  // 夜櫻：夜裡空氣靜，殘響稍長
  night: {
    acoustics: { secs: 1.2, decay: 3.0, pre: 0.012, send: 0.13, tone: 3000, slap: 0, slapTime: 0.1, crowd: 0.35 },
    floor: 'mat',
    crowd: 'garden',
    chime: 'koto',
    music: { scale: MIYAKO, root: 130.81, bpm: 68, density: 0.48, bass: [0, 3, 2, 0] },
  },
  // 稻田：空曠的田野，幾乎沒有殘響
  paddy: {
    acoustics: { secs: 0.6, decay: 4.0, pre: 0.006, send: 0.07, tone: 3200, slap: 0, slapTime: 0.1, crowd: 0.2 },
    floor: 'earth',
    crowd: 'farm',
    chime: 'wood',
    music: { scale: MINOR5, root: 146.83, bpm: 70, density: 0.48, bass: [0, 3, 2, 0] },
  },
  // 海灘：最開闊，聲音一出去就散了
  beach: {
    acoustics: { secs: 0.45, decay: 4.5, pre: 0.004, send: 0.05, tone: 2800, slap: 0, slapTime: 0.1, crowd: 0.15 },
    floor: 'deck',
    crowd: 'beach',
    chime: 'steel',
    music: { scale: MAJOR5, root: 174.61, bpm: 104, density: 0.5, bass: [0, 3, 4, 3], offbeat: true },
  },
};

/** 目前的場地（ambience.setVenue 會更新；sfx 依它決定音色） */
let venue: Venue = 'indoor';
const prof = (): SoundProfile => PROFILES[venue] ?? PROFILES.indoor;

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

  // 殘響：reverbSend → 殘響量 → 預延遲 → 卷積（衰減雜訊當脈衝響應，換場地時交叉淡入新的）→ 低通 → 主音量
  reverbSend = c.createGain();
  revWet = c.createGain();
  revWet.gain.value = 0.18;
  preDelay = c.createDelay(0.2);
  revTone = c.createBiquadFilter();
  revTone.type = 'lowpass';
  revTone.Q.value = 0.5;
  reverbSend.connect(revWet).connect(preDelay);
  revTone.connect(master);
  // 建築物的反彈回音（市場）：延遲＋低通、再回授一點點 → 「啪…啪」兩三下
  slapDelay = c.createDelay(0.5);
  const slapLp = c.createBiquadFilter();
  slapLp.type = 'lowpass';
  slapLp.frequency.value = 2800;
  const slapFb = c.createGain();
  slapFb.gain.value = 0.28;
  slapOut = c.createGain();
  slapOut.gain.value = 0;
  reverbSend.connect(slapDelay).connect(slapLp).connect(slapOut).connect(master);
  slapLp.connect(slapFb).connect(slapDelay);
  // 觀眾
  crowdBus = c.createGain();
  crowdSend = c.createGain();
  crowdBus.connect(sfxBus);
  crowdBus.connect(crowdSend).connect(reverbSend);

  noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

  setAcoustics(PROFILES[pendingVenue ?? venue].acoustics);
  if (pendingVenue) ambience.setVenue(pendingVenue);
  music.sync();
}

/** 殘響脈衝響應：雙聲道衰減雜訊，開頭 10 ms 淡入（比較不會有「啪」一聲的硬起音） */
function impulse(secs: number, decay: number): AudioBuffer {
  const c = ctx!;
  const len = Math.floor(c.sampleRate * secs);
  const fade = c.sampleRate * 0.01;
  const b = c.createBuffer(2, len, c.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = b.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay) * Math.min(1, i / fade);
  }
  return b;
}

const irCache = new Map<Acoustics, AudioBuffer>(); // 每個場地一份（全部場地加起來約 3 MB）
let acousticsNow: Acoustics | null = null;
let conv: { node: ConvolverNode; gain: GainNode } | null = null;

/** 換場地的空間感：殘響參數慢慢滑過去，卷積器換新的並交叉淡入（舊的淡出後拆掉） */
function setAcoustics(a: Acoustics): void {
  if (!ctx || a === acousticsNow) return;
  acousticsNow = a;
  const c = ctx;
  const t = c.currentTime;
  revWet.gain.setTargetAtTime(a.send, t, 0.3);
  preDelay.delayTime.setTargetAtTime(a.pre, t, 0.05);
  revTone.frequency.setTargetAtTime(a.tone, t, 0.2);
  slapDelay.delayTime.setTargetAtTime(a.slapTime, t, 0.05);
  slapOut.gain.setTargetAtTime(a.slap, t, 0.3);
  crowdSend.gain.setTargetAtTime(a.crowd, t, 0.3);
  let ir = irCache.get(a);
  if (!ir) {
    ir = impulse(a.secs, a.decay);
    irCache.set(a, ir);
  }
  const node = c.createConvolver();
  node.buffer = ir;
  const gain = c.createGain();
  gain.gain.value = 0;
  gain.gain.setTargetAtTime(1, t, 0.15);
  preDelay.connect(node).connect(gain).connect(revTone);
  const old = conv;
  conv = { node, gain };
  if (old) {
    old.gain.gain.setTargetAtTime(0, t, 0.15);
    window.setTimeout(() => {
      preDelay.disconnect(old.node);
      old.node.disconnect();
      old.gain.disconnect();
    }, 1500);
  }
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
  /** 跳殺／魚躍落地：依地板不同（彈性木地板、空心棧板、泥土、水泥…） */
  thud() {
    switch (prof().floor) {
      case 'gym': // 有彈性的木地板：低沉的「咚」＋地板共鳴，球館殘響
        noise({ dur: 0.12, freq: 180, q: 0.8, type: 'lowpass', gain: 0.6, rev: 0.4 });
        tone({ freq: 96, to: 62, dur: 0.2, gain: 0.03, rev: 0.3 });
        break;
      case 'deck': // 木棧台：空心的「咚」＋木板敲擊，板子再彈一下
        noise({ dur: 0.1, freq: 220, q: 0.8, type: 'lowpass', gain: 0.45 });
        tone({ freq: 150, to: 128, dur: 0.24, gain: 0.028, type: 'triangle' });
        tone({ freq: 335, to: 300, dur: 0.16, gain: 0.018, type: 'triangle' });
        noise({ dur: 0.04, freq: 950, q: 3, gain: 0.15 });
        noise({ dur: 0.03, freq: 1150, q: 3, gain: 0.06, delay: 0.045 });
        break;
      case 'earth': // 泥土地：悶、短、沒有餘音，揚起一點沙土
        noise({ dur: 0.09, freq: 130, q: 0.7, type: 'lowpass', gain: 0.95 });
        scuff(1, 2400);
        break;
      case 'concrete': // 水泥地：紮實短促、帶一點清脆，四周店面彈回來
        noise({ dur: 0.08, freq: 160, q: 0.8, type: 'lowpass', gain: 0.9, rev: 0.35 });
        noise({ dur: 0.03, freq: 700, q: 1.5, gain: 0.32, rev: 0.3 });
        break;
      default: // 戶外球場墊（下面是硬地）
        noise({ dur: 0.1, freq: 170, q: 0.8, type: 'lowpass', gain: 0.8, rev: 0.2 });
        scuff(0.5, 3000);
    }
    sfx.squeak(0.6);
  },
  /** 球鞋的「吱」聲（急停、轉向、弓箭步）：室內運動地板最響最長；戶外球場墊短而軟，再加上鞋底磨到沙土的沙沙聲 */
  squeak(vol = 1) {
    const floor = prof().floor;
    const base = 2200 + Math.random() * 1600;
    if (floor === 'gym') {
      const dur = 0.08 + Math.random() * 0.1;
      tone({ freq: base, to: base * (0.7 + Math.random() * 0.6), dur, gain: 0.05 * vol, type: 'sawtooth', attack: 0.01, rev: 0.3 });
      noise({ dur, freq: base, q: 8, gain: 0.13 * vol, attack: 0.01, rev: 0.15 });
      return;
    }
    const dur = 0.045 + Math.random() * 0.05;
    const sq = floor === 'deck' ? 0.75 : 0.9;
    tone({ freq: base * 1.1, to: base * (0.8 + Math.random() * 0.4), dur, gain: 0.032 * vol * sq, type: 'sawtooth', attack: 0.008, rev: 0.15 });
    noise({ dur, freq: base * 1.1, q: 6, gain: 0.08 * vol * sq, attack: 0.008 });
    const grit = floor === 'earth' ? 1 : floor === 'concrete' ? 0.85 : floor === 'deck' ? 0.7 : 0.55;
    scuff(vol * grit, floor === 'concrete' ? 2600 : floor === 'deck' ? 3800 : 3200);
    if (floor === 'deck' && Math.random() < 0.6) creak(vol);
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
  /** 羽球落地：球場墊上「啪」一下；室內帶殘響、泥土邊比較悶、棧台有一點空心的回響 */
  land() {
    const floor = prof().floor;
    const dull = floor === 'earth';
    noise({ dur: 0.05, freq: floor === 'gym' ? 1100 : dull ? 800 : 1000, q: floor === 'gym' ? 2 : 1.5, gain: dull ? 0.28 : 0.25, rev: floor === 'gym' ? 0.3 : 0.15 });
    tone({ freq: dull ? 200 : 220, to: dull ? 105 : 120, dur: 0.06, gain: 0.08, type: 'triangle' });
    if (floor === 'deck') tone({ freq: 265, to: 215, dur: 0.1, gain: 0.04, type: 'triangle', delay: 0.006 });
  },
  /** 得分提示音：每個場地不同音色（記分板叮咚、小銅鈴、鋼鼓、木魚、撥弦、竹筒）；輸分時有觀眾的地方會「唉～」 */
  point(win: boolean) {
    const p = prof();
    chime(p.chime, win);
    if (!win && (p.crowd === 'arena' || p.crowd === 'market' || p.crowd === 'beach')) {
      noise({ dur: 0.75, freq: 600, sweepTo: 380, q: 1.4, gain: p.crowd === 'arena' ? 0.16 : 0.1, attack: 0.12, delay: 0.15, bus: crowdBus });
    }
  },
  /** 觀眾的反應（intensity 0~1，回合越長越熱烈）：每個場地的觀眾不一樣 */
  applause(intensity: number) {
    if (!ctx) return;
    const k = Math.max(0, Math.min(1, intensity));
    switch (prof().crowd) {
      case 'arena': {
        // 滿場觀眾：密集的掌聲＋歡呼聲浪＋口哨
        const n = Math.round(22 + k * 50);
        const span = 1.0 + k * 1.6;
        for (let i = 0; i < n; i++) {
          clap(Math.random() * span * Math.random() + Math.random() * 0.15, 1200 + Math.random() * 1800, 0.05 + Math.random() * 0.05 * (0.6 + k), 1.2);
        }
        if (k > 0.45) {
          noise({ dur: 1.4, freq: 650, sweepTo: 760, q: 0.6, gain: 0.12 * k, attack: 0.25, delay: 0.05, bus: crowdBus });
          noise({ dur: 1.1, freq: 1300, sweepTo: 1500, q: 1, gain: 0.05 * k, attack: 0.2, delay: 0.1, bus: crowdBus });
        }
        if (k > 0.7) whistle(0.3 + Math.random() * 0.5, false);
        break;
      }
      case 'market': {
        // 攤販和客人：一群人拍手，有人喊兩聲，很熱烈時有人敲鍋子
        clappers(4 + Math.round(k * 4), [0.17, 0.24], 3 + Math.round(k * 2), [1100, 2600], 0.065);
        const shouts = 1 + Math.floor(k * 2.5);
        for (let i = 0; i < shouts; i++) voice(0.1 + Math.random() * 0.7, 230 + Math.random() * 120, 'hey', 0.06);
        if (k > 0.65) potClang(0.25 + Math.random() * 0.4);
        break;
      }
      case 'beach': {
        // 海灘上一小群人：拍手、吹口哨、「呼～」
        clappers(3 + Math.round(k * 3), [0.16, 0.22], 3 + Math.round(k * 2), [1300, 2800], 0.07);
        if (Math.random() < 0.45 + 0.5 * k) whistle(0.15 + Math.random() * 0.4, true);
        if (k > 0.5) voice(0.2 + Math.random() * 0.4, 280 + Math.random() * 80, 'woo', 0.06);
        break;
      }
      case 'farm':
        // 田邊幾個農夫：稀稀落落、慢慢的、比較厚的拍手；很精彩時有人喊一聲
        clappers(2 + Math.round(k * 2), [0.28, 0.36], 3 + Math.round(k * 2), [850, 1700], 0.08);
        if (k > 0.6) voice(0.3 + Math.random() * 0.3, 170 + Math.random() * 50, 'hey', 0.055);
        break;
      case 'garden':
        // 花園派對：有禮貌的輕拍，很精彩時一聲小小的「喔～」
        clappers(4 + Math.round(k * 4), [0.2, 0.26], 3 + Math.round(k * 2), [1800, 3200], 0.05);
        if (k > 0.7) noise({ dur: 0.9, freq: 420, sweepTo: 560, q: 2.2, gain: 0.14 * k, attack: 0.18, delay: 0.1, bus: crowdBus });
        break;
      default:
        // 竹林：只有兩三個人輕輕拍手
        clappers(2 + Math.round(k * 3), [0.22, 0.3], 3 + Math.round(k * 2), [1500, 2800], 0.045);
    }
  },
  /** 選單按鈕 */
  click() {
    tone({ freq: 1200, dur: 0.03, gain: 0.05 });
  },
};

// ---------- 場地音效的小積木 ----------

/** 鞋底磨到沙土：一段寬帶通雜訊＋幾顆細小的沙粒聲 */
function scuff(vol: number, freq: number): void {
  noise({ dur: 0.07 + Math.random() * 0.04, freq, q: 0.9, gain: 0.075 * vol, attack: 0.006 });
  const n = 2 + Math.floor(Math.random() * 3);
  for (let i = 0; i < n; i++) {
    noise({ dur: 0.008 + Math.random() * 0.006, freq: 4500 + Math.random() * 2500, q: 2, gain: (0.02 + 0.04 * Math.random()) * vol, delay: Math.random() * 0.06 });
  }
}

/** 木棧板被踩的「嘎」：鋸齒波經過帶通，音高微微滑動 */
function creak(vol: number): void {
  if (!ctx) return;
  const c = ctx;
  const t = c.currentTime + Math.random() * 0.02;
  const dur = 0.07 + Math.random() * 0.06;
  const f = 380 + Math.random() * 160;
  const osc = c.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(f, t);
  osc.frequency.linearRampToValueAtTime(f * (0.9 + Math.random() * 0.25), t + dur);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 900;
  bp.Q.value = 3;
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.03 * vol, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(bp).connect(g).connect(sfxBus);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

/** 一下拍手（短帶通雜訊），送到觀眾匯流排（殘響在匯流排統一送） */
function clap(delay: number, freq: number, gain: number, q = 1.2): void {
  noise({ dur: 0.03 + Math.random() * 0.03, freq, q, gain, delay, bus: crowdBus });
}

/** 幾個人各自規律地拍手：每人自己的節奏與音色，越拍越輕 */
function clappers(people: number, gap: [number, number], count: number, freq: [number, number], gain: number): void {
  for (let p = 0; p < people; p++) {
    const iv = gap[0] + Math.random() * (gap[1] - gap[0]);
    const f = freq[0] + Math.random() * (freq[1] - freq[0]);
    const n = Math.max(2, count + Math.floor(Math.random() * 3) - 1);
    let t = Math.random() * 0.3;
    for (let i = 0; i < n; i++) {
      clap(t, f * (0.9 + Math.random() * 0.2), gain * (1 - (0.4 * i) / n) * (0.8 + Math.random() * 0.4));
      t += iv * (0.92 + Math.random() * 0.16);
    }
  }
}

/** 人聲：喊一聲「嘿！」（先上揚再往下）或「呼～」（一路往上滑）；鋸齒波＋兩個母音共振峰 */
function voice(delay: number, pitch: number, kind: 'hey' | 'woo', gain: number): void {
  if (!ctx) return;
  const c = ctx;
  const t = c.currentTime + delay;
  const hey = kind === 'hey';
  const dur = hey ? 0.22 + Math.random() * 0.1 : 0.45 + Math.random() * 0.15;
  const osc = c.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(pitch * (hey ? 0.9 : 0.8), t);
  if (hey) {
    osc.frequency.linearRampToValueAtTime(pitch * 1.15, t + 0.07);
    osc.frequency.linearRampToValueAtTime(pitch * 0.8, t + dur);
  } else osc.frequency.exponentialRampToValueAtTime(pitch * 1.6, t + dur * 0.8);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.03);
  g.gain.setValueAtTime(gain, t + dur * 0.6);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  const formants: [number, number, number][] = hey
    ? [
        [750, 4, 1],
        [1750, 5, 0.6],
      ]
    : [
        [420, 4, 1],
        [900, 5, 0.5],
      ];
  for (const [f, q, a] of formants) {
    const bp = c.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = f * (0.92 + Math.random() * 0.16);
    bp.Q.value = q;
    const ga = c.createGain();
    ga.gain.value = a;
    osc.connect(bp).connect(ga).connect(g);
  }
  g.connect(crowdBus);
  osc.start(t);
  osc.stop(t + dur + 0.03);
}

/** 口哨：觀眾席拉長往上的哨音；海灘的手指口哨「咻～咻嗚」 */
function whistle(delay: number, finger: boolean): void {
  if (finger) {
    tone({ freq: 1700, to: 2700, dur: 0.14, gain: 0.03, delay, bus: crowdBus, attack: 0.02 });
    tone({ freq: 2650, to: 1450, dur: 0.38, gain: 0.03, delay: delay + 0.2, bus: crowdBus, attack: 0.03 });
  } else tone({ freq: 2300, to: 3000, dur: 0.45, gain: 0.022, delay, bus: crowdBus, attack: 0.04 });
}

/** 市場攤販敲鍋子「鏘、鏘」：不和諧泛音的金屬聲 */
function potClang(delay: number): void {
  for (let k = 0; k < 2; k++) {
    const d = delay + k * (0.2 + Math.random() * 0.06);
    const v = k ? 0.75 : 1;
    tone({ freq: 520, dur: 0.5, gain: 0.04 * v, delay: d, bus: crowdBus, attack: 0.002 });
    tone({ freq: 1430, dur: 0.35, gain: 0.025 * v, delay: d, bus: crowdBus, attack: 0.002 });
    tone({ freq: 2390, dur: 0.22, gain: 0.015 * v, delay: d, bus: crowdBus, attack: 0.002 });
    noise({ dur: 0.02, freq: 3000, q: 1, gain: 0.08 * v, delay: d, bus: crowdBus });
  }
}

/** 得分提示音（贏：往上兩個音；輸：往下兩個音），音色依場地 */
function chime(kind: Chime, win: boolean): void {
  const notes = win ? [660, 990] : [330, 247];
  const gap = win ? 0.1 : 0.12;
  for (let i = 0; i < 2; i++) {
    const f = notes[i];
    const d = i * gap;
    switch (kind) {
      case 'bell': // 小銅鈴：不和諧泛音、餘音長
        tone({ freq: f * 1.5, dur: 0.55, gain: 0.08, delay: d, rev: 0.3 });
        tone({ freq: f * 1.5 * 2.76, dur: 0.3, gain: 0.03, delay: d });
        tone({ freq: f * 1.5 * 5.4, dur: 0.14, gain: 0.012, delay: d });
        break;
      case 'steel': // 鋼鼓：基音＋八度＋十二度，起音時音高微微往下
        tone({ freq: f * 1.02, to: f, dur: 0.45, gain: 0.1, delay: d, attack: 0.004 });
        tone({ freq: f * 2, dur: 0.25, gain: 0.04, delay: d });
        tone({ freq: f * 3, dur: 0.12, gain: 0.015, delay: d });
        break;
      case 'wood': // 木魚：短促的「叩」
        tone({ freq: f * 1.25, to: f, dur: 0.09, gain: 0.22, type: 'triangle', delay: d });
        noise({ dur: 0.02, freq: f * 3, q: 4, gain: 0.25, delay: d });
        break;
      case 'koto': // 撥弦（跟背景音樂同一種音色；低音的撥弦能量大，輸分時小聲一點）
        if (ctx) pluck(f, ctx.currentTime + d, win ? 0.22 : 0.14, sfxBus, reverbSend, 0.3);
        break;
      case 'bamboo': // 竹筒：很窄的共鳴＋一點木頭聲
        noise({ dur: 0.08, freq: f * 1.3, q: 14, gain: 0.5, delay: d, rev: 0.3 });
        tone({ freq: f * 1.3, dur: 0.1, gain: 0.17, delay: d });
        break;
      default: // 記分板「叮咚」：正弦＋一點方波的電子感
        tone({ freq: f, dur: i ? 0.22 : 0.14, gain: 0.11, delay: d, rev: 0.3 });
        tone({ freq: f, dur: i ? 0.18 : 0.12, gain: 0.025, type: 'square', delay: d });
    }
  }
}

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
    venue = v; // 音效（腳步、落地、觀眾、提示音）和背景音樂都跟著換
    if (!ctx || v === this.venue) return;
    this.stop();
    this.venue = v;
    setAcoustics(prof().acoustics);
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

// ---------- 背景音樂：撥弦五聲音階，每個場地不同的音階／速度／手法（見 PROFILES 的 music） ----------
// 櫻花園、夜櫻：日本都節音階；竹林：陽音階；室內：明亮的大調五聲、快；市場：中國宮調＋琵琶式輪指；
// 稻田：小調五聲、慢；海灘：大調五聲＋反拍刷弦（像烏克麗麗）

const pluckCache = new Map<number, AudioBuffer>();
const PLUCK_CACHE_MAX = 32; // 每個音約 0.2 MB；換了很多場地也不會一直長

/** Karplus-Strong 撥弦音（1 秒，結尾淡出） */
function pluckBuf(freq: number): AudioBuffer {
  const key = Math.round(freq);
  const hit = pluckCache.get(key);
  if (hit) return hit;
  const c = ctx!;
  const len = Math.floor(c.sampleRate * 1.0);
  const b = c.createBuffer(1, len, c.sampleRate);
  const d = b.getChannelData(0);
  const N = Math.max(2, Math.round(c.sampleRate / freq));
  for (let i = 0; i < N; i++) d[i] = Math.random() * 2 - 1;
  for (let i = N; i < len; i++) d[i] = 0.996 * 0.5 * (d[i - N] + d[i - N + 1]);
  const fade = Math.floor(c.sampleRate * 0.08);
  for (let i = 0; i < fade; i++) d[len - 1 - i] *= i / fade;
  if (pluckCache.size >= PLUCK_CACHE_MAX) pluckCache.delete(pluckCache.keys().next().value!);
  pluckCache.set(key, b);
  return b;
}

/** 撥一下：音樂走 musicBus、殘響直接送 revWet（不吃市場的回音）；得分提示音的撥弦走 sfxBus */
function pluck(freq: number, at: number, gain: number, bus: AudioNode = musicBus, send: AudioNode = revWet, sendAmt = 0.5): void {
  const c = ctx!;
  const s = c.createBufferSource();
  s.buffer = pluckBuf(freq);
  const g = c.createGain();
  g.gain.value = gain;
  s.connect(g).connect(bus);
  const sg = c.createGain();
  sg.gain.value = sendAmt;
  g.connect(sg).connect(send);
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
    const tick = () => {
      if (!this.playing || !ctx) return;
      while (this.nextAt < ctx.currentTime + 0.35) {
        // 每一步都看目前場地的曲風（換場地馬上換）
        const st = prof().music;
        const beat = 60 / st.bpm / 2; // 八分音符
        const s = this.step++;
        const bassDeg = st.scale[st.bass[Math.floor(s / 8) % st.bass.length]];
        // 低音：每小節第一拍
        if (s % 8 === 0) pluck((st.root / 2) * Math.pow(2, bassDeg / 12), this.nextAt, 0.5);
        // 旋律：隨機漫步，偶爾休止
        if (Math.random() < st.density) {
          this.note = Math.max(0, Math.min(11, this.note + [-2, -1, -1, 0, 1, 1, 2][Math.floor(Math.random() * 7)]));
          const deg = st.scale[this.note % 5] + 12 * Math.floor(this.note / 5);
          const f = st.root * Math.pow(2, deg / 12);
          pluck(f, this.nextAt + (Math.random() - 0.5) * 0.015, 0.32);
          // 琵琶式輪指：同一個音在半拍後再撥一下
          if (st.tremolo && Math.random() < st.tremolo) pluck(f, this.nextAt + beat / 2, 0.2);
        }
        // 反拍刷弦：低音所在和弦的兩個音，像烏克麗麗一樣輕輕刷過
        if (st.offbeat && s % 2 === 1 && Math.random() < 0.75) {
          const i0 = st.bass[Math.floor(s / 8) % st.bass.length];
          for (let k = 0; k < 2; k++) {
            const deg = st.scale[(i0 + 2 + k * 2) % 5] + 12;
            pluck(st.root * Math.pow(2, deg / 12), this.nextAt + k * 0.012, 0.11);
          }
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
