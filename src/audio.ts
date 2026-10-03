// 音效引擎：全部用 WebAudio 即時合成（不需要音檔）
// 匯流排：音效 sfx、場景環境音 amb、音樂 music → 主音量；另有共用殘響（每個場地的空間感不同）
import type { MusicTrack, Venue } from './config';

let ctx: AudioContext | null = null;
let master: GainNode;
let sfxBus: GainNode;
let ambBus: GainNode;
let musicBus: GainNode;
let musicRev: GainNode; // 音樂送進殘響的量（每首曲子不同）
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
  sfxBus.gain.value = sfxOn ? 1 : 0;
  ambBus.gain.value = sfxOn ? 0.5 : 0;
  sfxBus.connect(master);
  ambBus.connect(master);

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
  // 音樂：自己的匯流排（開關、比賽中變小聲）→ 主音量；殘響直接送 revWet（不吃市場的回音）
  ({ bus: musicBus, rev: musicRev } = musicChain(c, master, revWet));
  musicBus.gain.value = 0;
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

  noiseBuf = makeNoise(c);

  setAcoustics(PROFILES[pendingVenue ?? venue].acoustics);
  if (pendingVenue) ambience.setVenue(pendingVenue);
  music.sync();
}

/** 2 秒白雜訊（鼓、風、人聲嘈雜…都從這裡濾出來） */
function makeNoise(c: BaseAudioContext): AudioBuffer {
  const b = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}

/**
 * 音樂的路徑：匯流排 → 30 Hz 高通（去掉直流和用不到的超低頻）→ 主音量；
 * 殘響送出前再濾掉 250 Hz 以下（低音、大鼓不進殘響，比較不糊）
 */
function musicChain(c: BaseAudioContext, out: AudioNode, wet: AudioNode): { bus: GainNode; rev: GainNode } {
  const bus = c.createGain();
  const hp = c.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 30;
  hp.Q.value = 0.7;
  bus.connect(hp).connect(out);
  const rhp = c.createBiquadFilter();
  rhp.type = 'highpass';
  rhp.frequency.value = 250;
  rhp.Q.value = 0.7;
  const rev = c.createGain();
  hp.connect(rhp).connect(rev).connect(wet);
  return { bus, rev };
}

/** 殘響脈衝響應：雙聲道衰減雜訊，開頭 10 ms 淡入（比較不會有「啪」一聲的硬起音） */
function impulse(c: BaseAudioContext, secs: number, decay: number): AudioBuffer {
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
    ir = impulse(c, a.secs, a.decay);
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
  if (!on) music.previewUntil = 0; // 關掉音樂也停掉試聽
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
  src.loop = true; // 從隨機位置開始播，長一點的聲音才不會碰到緩衝結尾被切掉
  const f = ctx.createBiquadFilter();
  f.type = o.type ?? 'bandpass';
  f.frequency.setValueAtTime(o.freq, t0);
  if (o.sweepTo) f.frequency.exponentialRampToValueAtTime(o.sweepTo, t0 + o.dur);
  f.Q.value = o.q ?? 1;
  const g = ctx.createGain();
  const a = o.attack ?? 0.002;
  g.gain.value = 0.0001;
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
  g.gain.value = 0.0001;
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
  /** 精彩回放開始：倒帶似的「咻——」往上掃 */
  replay() {
    noise({ dur: 0.42, freq: 300, sweepTo: 3600, q: 0.9, gain: 0.2, attack: 0.16, rev: 0.35 });
    tone({ freq: 160, to: 640, dur: 0.36, gain: 0.045, type: 'triangle', attack: 0.12, rev: 0.3 });
  },
  /** 回放的慢動作擊球：在擊球聲底下加一聲低沉拉長的「轟」（power 0..1：殺球越快越重） */
  slowHit(power: number) {
    tone({ freq: 74, to: 36, dur: 0.75, gain: 0.12 + 0.12 * power, attack: 0.008, rev: 0.6 });
    noise({ dur: 0.6, freq: 320, sweepTo: 90, q: 0.7, type: 'lowpass', gain: 0.22 + 0.25 * power, attack: 0.01, rev: 0.7 });
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
  g.gain.value = 0.0001;
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
  g.gain.value = 0.0001;
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
      case 'koto': // 撥弦（跟背景音樂同一種撥弦合成；低音的撥弦能量大，輸分時小聲一點）
        chimePluck(f, d, win ? 0.22 : 0.14);
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

/** 得分提示音的撥弦（音效匯流排＋一點殘響） */
function chimePluck(freq: number, delay: number, gain: number): void {
  if (!ctx) return;
  const c = ctx;
  const t = c.currentTime + delay;
  const ks = ksBuf(c, Math.round(69 + 12 * Math.log2(freq / 440)), 3200, 1.0);
  const s = c.createBufferSource();
  s.buffer = ks.buf;
  s.playbackRate.value = ks.rate;
  const g = c.createGain();
  g.gain.value = 0;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(gain, t + 0.003);
  const send = c.createGain();
  send.gain.value = 0.3;
  s.connect(g).connect(sfxBus);
  g.connect(send).connect(reverbSend);
  s.start(t);
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
/** 市場人聲嘈雜的音量：跟室內觀眾席的嗡嗡聲差不多（約 -42 dBFS），在背景音樂底下 */
const BABBLE_LEVEL = 0.6;

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
    music.venueChanged(); // 背景音樂「依場地自動」時換成這個場地的曲風
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
      const base = gain * BABBLE_LEVEL;
      amp.gain.value = base;
      // 音節：低通到 6 Hz 的雜訊（標準差約 0.0115/√播放速度）放大成音量的 ±60% 加上去。
      // （以前放大成音量的 9 倍：音量有四成時間是負的，整片變成比背景音樂還大聲 4 dB 的沙沙雜訊）
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 6;
      const depth = c.createGain();
      depth.gain.value = (base * 0.6 * Math.sqrt(rate)) / 0.0115;
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
      g.gain.value = 0.0001;
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
    g.gain.value = 0.0001;
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
    g.gain.value = 0.0001;
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
      g.gain.value = 0.0001;
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

// ---------- 背景音樂 ----------
// 兩種來源（設定裡的「背景音樂」選）：
//   auto：依場地自動 —— 每個場地自己的撥弦五聲音階即興（見 PROFILES 的 music）
//   固定曲目：MUSIC_TRACKS 裡寫好的曲子（和弦進行＋旋律＋低音＋鼓），一直循環
// 全部即時合成：排程器每 60 ms 醒來一次，把接下來 0.3 秒內要響的音排好（以 16 分音符為一格）。
// 每首曲子播放時有自己的匯流排（Mx.out），換曲時舊的淡出後整串拆掉，不會留下沒停的聲音。
// 同一套程式也拿來離線算試聽檔（renderMusic → OfflineAudioContext）。

type SongId = Exclude<MusicTrack, 'auto'>;

/** 設定裡可以選的固定曲目（auto＝依場地自動不在這裡） */
export const MUSIC_TRACKS: readonly { id: SongId; name: string; desc: string }[] = [
  { id: 'sakura', name: '櫻花撥弦', desc: '古箏＋尺八風，D 都節音階，84 BPM' },
  { id: 'sports', name: '熱血運動', desc: '運動動畫風搖滾，D 大調，140 BPM' },
  { id: 'synth', name: '輕快電子', desc: '明亮的合成器流行＋8-bit 主旋律，F 大調，120 BPM' },
  { id: 'lofi', name: 'Lo-fi 放鬆', desc: '電鋼琴七和弦＋搖擺節拍，E♭ 大調，82 BPM' },
  { id: 'bossa', name: '海島 Bossa', desc: '尼龍吉他＋鋼鼓，D 大調，100 BPM' },
];

// ---- 樂理小工具 ----

const mtof = (m: number): number => 440 * Math.pow(2, (m - 69) / 12);
const PC: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const pcOf = (s: string): number => (PC[s[0]] + (s[1] === '#' ? 1 : s[1] === 'b' ? -1 : 0) + 12) % 12;

/** 音名 → MIDI 音高（'C4' = 60、'F#5'、'Bb3'） */
function midi(s: string): number {
  const m = /^([A-G][#b]?)(\d)$/.exec(s);
  if (!m) throw new Error(`看不懂的音名：${s}`);
  return pcOf(m[1]) + 12 * (Number(m[2]) + 1);
}

/** 一個音符：at、len 以 16 分音符為單位 */
interface Ev {
  at: number;
  len: number;
  m: number;
}

/** 旋律字串 → 音符。'D5:4' = 音名:長度（16 分音符）、'-:4' 休止、'|' 小節線（只用來檢查有沒有對齊） */
function mel(src: string): Ev[] {
  const out: Ev[] = [];
  let at = 0;
  for (const tok of src.trim().split(/\s+/)) {
    if (tok === '|') {
      if (at % 16) console.warn(`旋律沒對齊小節線（第 ${at} 格）`);
      continue;
    }
    const [n, l] = tok.split(':');
    const len = Number(l);
    if (n !== '-') out.push({ at, len, m: midi(n) });
    at += len;
  }
  return out;
}

/** 把事件依開始的格子排好（每格最多幾個），播的時候直接查表 */
function byStep<T extends { at: number }>(evs: T[], n: number): (T[] | undefined)[] {
  const a: (T[] | undefined)[] = new Array(n);
  for (const e of evs) (a[e.at % n] ??= []).push(e);
  return a;
}

const QUAL: Record<string, number[]> = {
  '': [0, 4, 7],
  m: [0, 3, 7],
  '5': [0, 7],
  sus4: [0, 5, 7],
  m6: [0, 3, 7, 9],
  '7': [0, 4, 7, 10],
  maj7: [0, 4, 7, 11],
  m7: [0, 3, 7, 10],
  '7sus4': [0, 5, 7, 10],
  maj9: [0, 4, 7, 11, 14],
  m9: [0, 3, 7, 10, 14],
  '13': [0, 4, 10, 14, 21],
  '7b9': [0, 4, 7, 10, 13],
};

/** 半小節一格的和弦：和弦名稱、排好的和弦音、低音 */
interface Slot {
  sym: string;
  root: number; // 根音（0–11）
  notes: number[]; // 排好的和弦音（MIDI）
  bass: number; // 低音（MIDI，在 bassLo 往上一個八度內）
}

/**
 * 和弦排成實際的音：每個轉位都試，挑音域 lo–hi 內、跟上一個和弦最接近的（聲部進行平順）。
 * rootless：五個音以上的和弦拿掉根音（低音會彈），比較不糊。
 */
function voiceChord(pcs: number[], prev: number[] | null, lo: number, hi: number): number[] {
  let best: number[] | null = null;
  let bestCost = Infinity;
  for (let r = 0; r < pcs.length; r++) {
    let base = lo;
    while (base % 12 !== pcs[r]) base++;
    const v = [base];
    for (let k = 1; k < pcs.length; k++) {
      let n = v[k - 1] + 1;
      while (n % 12 !== pcs[(r + k) % pcs.length]) n++;
      v.push(n);
    }
    for (let shift = 0; v[v.length - 1] + shift <= hi; shift += 12) {
      const w = v.map((n) => n + shift);
      let cost: number;
      if (prev) {
        // 每個新音到最近的舊音＋每個舊音到最近的新音（音數不同也能比）
        cost = 0;
        for (const n of w) cost += Math.min(...prev.map((p) => Math.abs(n - p)));
        for (const p of prev) cost += Math.min(...w.map((n) => Math.abs(n - p)));
      } else cost = Math.abs((w[0] + w[w.length - 1]) / 2 - (lo + hi) / 2);
      if (cost < bestCost) {
        bestCost = cost;
        best = w;
      }
    }
    if (!best && r === pcs.length - 1) best = v; // 音域太窄放不下：至少給一個
  }
  return best ?? [];
}

/** 每小節一個和弦，或 'Em7 A7'（前半、後半）→ 每半小節一格 */
function chords(bars: string[], lo: number, hi: number, bassLo: number, rootless = false): Slot[] {
  const out: Slot[] = [];
  let prev: number[] | null = null;
  for (const bar of bars) {
    const syms = bar.split(' ');
    for (let h = 0; h < 2; h++) {
      if (h === 1 && syms.length === 1) {
        out.push(out[out.length - 1]);
        continue;
      }
      const sym = syms[h];
      const m = /^([A-G][#b]?)([^/]*)(?:\/([A-G][#b]?))?$/.exec(sym);
      const ivs = m ? QUAL[m[2]] : undefined;
      if (!m || !ivs) throw new Error(`看不懂的和弦：${sym}`);
      const root = pcOf(m[1]);
      let pcs = [...new Set(ivs.map((i) => (root + i) % 12))];
      if (rootless && pcs.length >= 5) pcs = pcs.slice(1);
      const notes = voiceChord(pcs, prev, lo, hi);
      prev = notes;
      const b = m[3] ? pcOf(m[3]) : root;
      out.push({ sym, root, notes, bass: bassLo + ((b - bassLo) % 12 + 12) % 12 });
    }
  }
  return out;
}

/** 和聲墊：和弦換了才重新起音，同一個和弦就一直延續 */
function padEvents(slots: Slot[]): { at: number; len: number; notes: number[] }[] {
  const out: { at: number; len: number; notes: number[] }[] = [];
  for (let i = 0; i < slots.length; i++) {
    if (i > 0 && slots[i].sym === slots[i - 1].sym) continue;
    let j = i + 1;
    while (j < slots.length && slots[j].sym === slots[i].sym) j++;
    out.push({ at: i * 8, len: (j - i) * 8, notes: slots[i].notes });
  }
  return out;
}

/** 琶音：和弦音往上排，超過就加八度 */
const arp = (notes: number[], i: number): number => notes[i % notes.length] + 12 * Math.floor(i / notes.length);

// ---- 播放中的曲子 ----

interface Song {
  bpm: number;
  bars: number; // 一輪幾小節（之後從頭循環）
  swing?: number; // 反拍的 16 分音符往後拖多少（0–0.5 格）
  gain: number; // 響度校正（每首差不多大聲）
  rev: number; // 殘響送出量
  echo?: { beats: number; fb: number; mix: number; tone: number }; // 迴聲（拍數、回授、量、亮度）
  fx?: (c: BaseAudioContext, input: AudioNode, out: AudioNode, keep: AudioNode[]) => void; // 整首的效果（例如 lo-fi 的錄音帶晃動）
  /** 排一格（16 分音符）：k = 這一輪的第幾格、pass = 第幾輪 */
  play(mx: Mx, k: number, t: number, pass: number): void;
}

/** 一首曲子正在播的實例（即時或離線都一樣） */
interface Mx {
  c: BaseAudioContext;
  song: Song;
  dry: GainNode; // 樂器接這裡 → （曲子效果）→ out
  out: GainNode; // 曲子的總音量，換曲時淡出
  echo: GainNode | null;
  pans: Map<number, AudioNode>;
  noise: AudioBuffer;
  d16: number; // 一格幾秒
  keep: AudioNode[]; // 曲子存在期間一直在的節點（停的時候拆掉）
  ring: Map<number, GainNode>; // 還在響的弦（同一根弦再撥時先止住）
  openHat: GainNode | null; // 開放鈸（下一下閉鈸會把它悶掉）
  note: number; // 場地即興：旋律目前在音階的第幾個音
}

function newMx(c: BaseAudioContext, song: Song, dest: AudioNode, noise: AudioBuffer): Mx {
  const out = c.createGain();
  out.gain.value = song.gain;
  out.connect(dest);
  const dry = c.createGain();
  const keep: AudioNode[] = [out, dry];
  if (song.fx) song.fx(c, dry, out, keep);
  else dry.connect(out);
  let echo: GainNode | null = null;
  if (song.echo) {
    const e = song.echo;
    echo = c.createGain();
    const dl = c.createDelay(2);
    dl.delayTime.value = (60 / song.bpm) * e.beats;
    const lp = c.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = e.tone;
    const fb = c.createGain();
    fb.gain.value = e.fb;
    const ret = c.createGain();
    ret.gain.value = e.mix;
    echo.connect(dl).connect(lp).connect(fb).connect(dl);
    lp.connect(ret).connect(out);
    keep.push(echo, dl, lp, fb, ret);
  }
  return { c, song, dry, out, echo, pans: new Map(), noise, d16: 60 / song.bpm / 4, keep, ring: new Map(), openHat: null, note: 5 };
}

/** 曲子淡出，之後整串拆掉（已經排好但還沒響的音會接到拆掉的節點上，等於靜音，時間到自己停） */
function disposeMx(mx: Mx, fade: number): void {
  const g = mx.out.gain;
  const t = mx.c.currentTime;
  g.cancelScheduledValues(t);
  g.setValueAtTime(g.value, t);
  g.setTargetAtTime(0, t, fade / 4);
  window.setTimeout(() => {
    for (const n of mx.keep) {
      try {
        if (n instanceof OscillatorNode) n.stop();
      } catch {
        /* 已經停了 */
      }
      n.disconnect();
    }
  }, fade * 1000 + 2500);
}

/** 左右聲像（每個位置一個共用的 panner） */
function pan(mx: Mx, p: number): AudioNode {
  if (!p || typeof mx.c.createStereoPanner !== 'function') return mx.dry;
  let n = mx.pans.get(p);
  if (!n) {
    const sp = mx.c.createStereoPanner();
    sp.pan.value = p;
    sp.connect(mx.dry);
    mx.keep.push(sp);
    mx.pans.set(p, sp);
    n = sp;
  }
  return n;
}

/** 送一點到曲子的迴聲 */
function sendEcho(mx: Mx, from: AudioNode, amt: number): GainNode | null {
  if (!amt || !mx.echo) return null;
  const s = mx.c.createGain();
  s.gain.value = amt;
  from.connect(s).connect(mx.echo);
  return s;
}

/** 音量包絡：a 秒起音到 peak → 往 peak×s 衰減（約 d 秒）→ hold 秒後放開，r 秒內淡掉。回傳可以停掉聲源的時間 */
function env(p: AudioParam, t: number, peak: number, a: number, d: number, s: number, hold: number, r: number): number {
  // 第一個事件之前的值也要是 0：AudioParam 在第一個事件之前用 .value（音量預設 1），
  // 音源用次取樣精度開始時第一個取樣可能落在 t 前面 → 那一個取樣用音量 1 播出來 → 「喀」一聲尖刺
  p.value = 0;
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(peak, t + a);
  if (s < 1) p.setTargetAtTime(peak * s, t + a, d / 3);
  const off = t + Math.max(hold, a);
  p.setTargetAtTime(0, off, r / 4);
  return off + r * 2;
}

// ---- 樂器 ----

/** 減法合成的音色：振盪器 →（低通＋濾波包絡）→ 音量包絡 */
interface Patch {
  wave: OscillatorType | 'pulse';
  uni?: number; // 兩顆振盪器各偏 ±幾 cents（厚度）；沒有 = 一顆
  cut: number; // 低通截止頻率（Hz）
  key?: number; // 截止頻率跟著音高走的比例
  fenv?: number; // 起音時濾波器多打開幾倍
  fdec?: number; // 濾波包絡回落的時間（秒）
  q?: number;
  a: number;
  d: number;
  s: number;
  r: number;
  vib?: number; // 顫音深度（cents），起音後慢慢出來
  scoop?: number; // 起音從低幾 cents 滑上來（銅管、尺八的感覺）
  sine?: number; // 疊一個同音高的正弦（低音的厚度）
}

const pulseCache = new WeakMap<BaseAudioContext, PeriodicWave>();
/** 25% 脈衝波（8-bit 遊戲機的主旋律音色）；瀏覽器會依音高自動限頻，不會有疊頻雜音 */
function pulseWave(c: BaseAudioContext): PeriodicWave {
  let w = pulseCache.get(c);
  if (!w) {
    const N = 32;
    const re = new Float32Array(N);
    const im = new Float32Array(N);
    for (let k = 1; k < N; k++) {
      re[k] = Math.sin(2 * Math.PI * k * 0.25) / (Math.PI * k);
      im[k] = (1 - Math.cos(2 * Math.PI * k * 0.25)) / (Math.PI * k);
    }
    w = c.createPeriodicWave(re, im);
    pulseCache.set(c, w);
  }
  return w;
}

/** 一個音，或一整個和弦（m 給陣列：所有振盪器共用一個濾波器和包絡，省節點、手機跑得動） */
function synth(mx: Mx, m: number | number[], t: number, dur: number, vel: number, p: Patch, dest: AudioNode = mx.dry, echo = 0): void {
  const c = mx.c;
  const ms = typeof m === 'number' ? [m] : m;
  if (!ms.length) return;
  const f = mtof(ms[0]);
  const g = c.createGain();
  const stop = env(g.gain, t, vel, p.a, p.d, p.s, dur, p.r);
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = p.q ?? 0.7;
  const cut = Math.min(16000, p.cut * (p.key ? Math.pow(f / 261.6, p.key) : 1));
  if (p.fenv) {
    const ta = t + Math.max(0.004, p.a * 0.8);
    lp.frequency.setValueAtTime(cut, t);
    lp.frequency.linearRampToValueAtTime(Math.min(16000, cut * (1 + p.fenv)), ta);
    lp.frequency.setTargetAtTime(cut, ta, (p.fdec ?? 0.2) / 3);
  } else lp.frequency.value = cut;
  lp.connect(g).connect(dest);
  const es = sendEcho(mx, g, echo);
  const srcs: OscillatorNode[] = [];
  const voices = p.uni ? 2 : 1;
  for (const n of ms) {
    for (let i = 0; i < voices; i++) {
      const o = c.createOscillator();
      if (p.wave === 'pulse') o.setPeriodicWave(pulseWave(c));
      else o.type = p.wave;
      o.frequency.value = mtof(n);
      const det = p.uni ? (i ? p.uni : -p.uni) : 0;
      if (p.scoop) {
        o.detune.setValueAtTime(det - p.scoop, t);
        o.detune.linearRampToValueAtTime(det, t + 0.08);
      } else o.detune.value = det;
      o.connect(lp);
      srcs.push(o);
    }
  }
  let sg: GainNode | null = null;
  if (p.sine) {
    const o = c.createOscillator();
    o.frequency.value = f;
    sg = c.createGain();
    sg.gain.value = p.sine;
    o.connect(sg).connect(lp);
    srcs.push(o);
  }
  let lg: GainNode | null = null;
  if (p.vib) {
    const l = c.createOscillator();
    l.frequency.value = 5.3;
    lg = c.createGain();
    lg.gain.value = 0;
    lg.gain.setValueAtTime(0, t);
    lg.gain.setValueAtTime(0, t + 0.15);
    lg.gain.linearRampToValueAtTime(p.vib, t + 0.5);
    l.connect(lg);
    for (const o of srcs) lg.connect(o.detune);
    srcs.push(l);
  }
  for (const o of srcs) {
    o.start(t);
    o.stop(stop);
  }
  srcs[0].onended = () => {
    g.disconnect();
    es?.disconnect();
    lg?.disconnect();
    sg?.disconnect();
  };
}

/** Karplus-Strong 撥弦的波形（每個 AudioContext 一份快取） */
interface Ks {
  buf: AudioBuffer;
  rate: number; // 補音準用的 playbackRate
}
const ksCaches = new WeakMap<BaseAudioContext, Map<string, Ks>>();
const KS_MAX = 32; // 每個音最多約 0.2 MB；超過就丟掉最久沒用的

/**
 * Karplus-Strong 撥弦：
 * - 激發用「兩次低通過的雜訊」（bright = 截止頻率 Hz，越低越圓潤；以前用沒濾過的白雜訊，每一下都帶一陣沙沙聲），
 *   去掉直流、正規化
 * - 迴圈延遲取整數（平均濾波本身多半格），剩下的小數用 playbackRate 補 → 音準準確（以前高音會偏到 20 cents 以上）
 * - 每一圈的損耗依音高算，高低音的餘音長度一樣（t60 秒衰減 60 dB）
 */
function ksBuf(c: BaseAudioContext, m: number, bright: number, t60: number): Ks {
  let cache = ksCaches.get(c);
  if (!cache) ksCaches.set(c, (cache = new Map()));
  const key = `${m}|${bright}|${t60}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key); // 移到最後（最近用過）
    cache.set(key, hit);
    return hit;
  }
  const sr = c.sampleRate;
  const P = sr / mtof(m);
  const N = Math.max(2, Math.floor(P - 0.5));
  const len = Math.floor(sr * Math.min(t60, 1.2));
  const buf = c.createBuffer(1, len, sr);
  const d = buf.getChannelData(0);
  // 激發：低通雜訊 e（前面 N 個只是讓濾波器暖機），取 e[N..2N) 當一圈弦；
  // 開頭一段跟 e[2N..] 交叉淡入，讓這一圈頭尾接得起來（不然每一圈都有一個跳階，聽起來沙沙的）
  const a = 1 - Math.exp((-2 * Math.PI * bright) / sr);
  const M = Math.max(1, N >> 1);
  const e = new Float32Array(2 * N + M);
  let y1 = 0;
  let y2 = 0;
  for (let i = -N; i < e.length; i++) {
    y1 += a * (Math.random() * 2 - 1 - y1);
    y2 += a * (y1 - y2);
    if (i >= 0) e[i] = y2;
  }
  let mean = 0;
  for (let i = 0; i < N; i++) {
    const w = i < M ? i / M : 1;
    d[i] = e[N + i] * w + (i < M ? e[2 * N + i] * (1 - w) : 0);
    mean += d[i];
  }
  mean /= N;
  let pk = 1e-9;
  for (let i = 0; i < N; i++) pk = Math.max(pk, Math.abs((d[i] -= mean)));
  for (let i = 0; i < N; i++) d[i] /= pk;
  const g = 0.5 * Math.pow(10, -3 / (t60 * (sr / (N + 0.5))));
  d[N] = g * (d[0] + d[N - 1]); // 弦是一圈：第 0 個的前一個是激發的最後一個（當成 0 的話這裡會有一個取樣的尖刺）
  for (let i = N + 1; i < len; i++) d[i] = g * (d[i - N] + d[i - N - 1]);
  const fade = Math.floor(sr * 0.03);
  for (let i = 0; i < fade; i++) d[len - 1 - i] *= i / fade;
  const ks = { buf, rate: (N + 0.5) / P };
  if (cache.size >= KS_MAX) cache.delete(cache.keys().next().value!);
  cache.set(key, ks);
  return ks;
}

interface PluckOpt {
  bright: number; // 激發的截止頻率（Hz）：越低越圓潤
  t60: number;
  dur?: number; // 幾秒後用手止音（沒有 = 讓它自然響完）
  bend?: number; // 起音時高幾 cents 再落下來（古箏的感覺）
  damp?: boolean; // 同一根弦再撥時先止住上一下（不會兩下疊在一起糊掉）
}

/** 撥一下弦 */
function pluck(mx: Mx, m: number, t: number, vel: number, o: PluckOpt, dest: AudioNode = mx.dry, echo = 0): void {
  const c = mx.c;
  const ks = ksBuf(c, m, o.bright, o.t60);
  const s = c.createBufferSource();
  s.buffer = ks.buf;
  if (o.bend) {
    s.playbackRate.setValueAtTime(ks.rate * Math.pow(2, o.bend / 1200), t);
    s.playbackRate.setTargetAtTime(ks.rate, t + 0.01, 0.03);
  } else s.playbackRate.value = ks.rate;
  const g = c.createGain();
  g.gain.value = 0;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vel, t + 0.003); // 3 ms 起音：沒有「喀」一聲
  let end = t + ks.buf.duration / ks.rate;
  if (o.dur !== undefined) {
    g.gain.setTargetAtTime(0, t + o.dur, 0.03);
    end = Math.min(end, t + o.dur + 0.25);
  }
  if (o.damp) {
    mx.ring.get(m)?.gain.setTargetAtTime(0, t, 0.01);
    mx.ring.set(m, g);
  }
  s.connect(g).connect(dest);
  const es = sendEcho(mx, g, echo);
  s.start(t);
  s.stop(end);
  s.onended = () => {
    g.disconnect();
    es?.disconnect();
    if (mx.ring.get(m) === g) mx.ring.delete(m);
  };
}

/** 電鋼琴（FM：調變器跟載波同頻，起音亮、很快變圓） */
function epiano(mx: Mx, m: number, t: number, dur: number, vel: number, dest: AudioNode = mx.dry): void {
  const c = mx.c;
  const f = mtof(m);
  const car = c.createOscillator();
  car.frequency.value = f;
  const mod = c.createOscillator();
  mod.frequency.value = f;
  const mg = c.createGain();
  mg.gain.value = f * (0.9 + vel * 2.5);
  mg.gain.setValueAtTime(f * (0.9 + vel * 2.5), t);
  mg.gain.setTargetAtTime(f * 0.28, t, 0.15);
  mod.connect(mg).connect(car.frequency);
  const g = c.createGain();
  const decay = 1.6 * Math.sqrt(261.6 / f); // 高音比較快沒
  g.gain.value = 0;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vel, t + 0.005);
  g.gain.setTargetAtTime(0, t + 0.005, decay / 3);
  g.gain.setTargetAtTime(0, t + dur, 0.07);
  car.connect(g).connect(dest);
  const stop = t + dur + 0.5;
  car.start(t);
  mod.start(t);
  car.stop(stop);
  mod.stop(stop);
  car.onended = () => {
    g.disconnect();
    mg.disconnect();
  };
}

/** 木琴／拇指琴：正弦＋一個很快消失的高泛音 */
function mallet(mx: Mx, m: number, t: number, vel: number, dest: AudioNode = mx.dry, echo = 0): void {
  const c = mx.c;
  const f = mtof(m);
  const g = c.createGain();
  g.gain.value = 0;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vel, t + 0.003);
  g.gain.setTargetAtTime(0, t + 0.003, 0.32);
  g.connect(dest);
  const es = sendEcho(mx, g, echo);
  const o1 = c.createOscillator();
  o1.frequency.value = f;
  o1.connect(g);
  const o2 = c.createOscillator();
  o2.frequency.value = f * 4;
  const g2 = c.createGain();
  g2.gain.value = 0.22;
  g2.gain.setValueAtTime(0.22, t);
  g2.gain.setTargetAtTime(0, t, 0.025);
  o2.connect(g2).connect(g);
  for (const o of [o1, o2]) {
    o.start(t);
    o.stop(t + 2);
  }
  o1.onended = () => {
    g.disconnect();
    g2.disconnect();
    es?.disconnect();
  };
}

const panWaves = new WeakMap<BaseAudioContext, PeriodicWave>();
/**
 * 鋼鼓：基音（正弦，餘音長）＋上面的泛音（八度、十二度、兩個八度，很快就沒）。
 * 起音時音高微微往下落。不用會動的濾波器（手機上比較省）
 */
function steelpan(mx: Mx, m: number, t: number, vel: number, dest: AudioNode = mx.dry, echo = 0): void {
  const c = mx.c;
  let w = panWaves.get(c);
  if (!w) {
    w = c.createPeriodicWave(new Float32Array(5), new Float32Array([0, 0, 1, 0.42, 0.16]), { disableNormalization: true });
    panWaves.set(c, w);
  }
  const f = mtof(m);
  const g = c.createGain();
  g.gain.value = 0;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vel, t + 0.004);
  g.gain.setTargetAtTime(0, t + 0.004, 0.45);
  g.connect(dest);
  const es = sendEcho(mx, g, echo);
  const hg = c.createGain();
  hg.gain.value = 0.6;
  hg.gain.setValueAtTime(0.6, t);
  hg.gain.setTargetAtTime(0, t, 0.09);
  hg.connect(g);
  const o1 = c.createOscillator();
  const o2 = c.createOscillator();
  o2.setPeriodicWave(w);
  for (const o of [o1, o2]) {
    o.frequency.setValueAtTime(f * 1.012, t);
    o.frequency.setTargetAtTime(f, t, 0.012);
    o.start(t);
    o.stop(t + 2.6);
  }
  o1.connect(g);
  o2.connect(hg);
  o1.onended = () => {
    g.disconnect();
    hg.disconnect();
    es?.disconnect();
  };
}

// ---- 鼓 ----

/** 一段濾過的雜訊（鈸、小鼓、沙鈴…）。雜訊緩衝循環播放，長的也不會半途被切掉 */
function noiseHit(mx: Mx, t: number, vel: number, type: BiquadFilterType, freq: number, q: number, dec: number, dest: AudioNode = mx.dry, attack = 0.001): GainNode {
  const c = mx.c;
  const s = c.createBufferSource();
  s.buffer = mx.noise;
  s.loop = true;
  const f = c.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  f.Q.value = q;
  const g = c.createGain();
  g.gain.value = 0;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vel, t + attack);
  g.gain.setTargetAtTime(0, t + attack, dec / 4);
  s.connect(f).connect(g).connect(dest);
  s.start(t, Math.random() * 1.5);
  s.stop(t + attack + dec * 2.2);
  s.onended = () => g.disconnect();
  return g;
}

/** 有音高的鼓：正弦（或三角波）從 f0 掃到 f1 */
function drumTone(mx: Mx, t: number, vel: number, f0: number, f1: number, sweep: number, dec: number, wave: OscillatorType = 'sine', dest: AudioNode = mx.dry): void {
  const c = mx.c;
  const o = c.createOscillator();
  o.type = wave;
  o.frequency.setValueAtTime(f0, t);
  o.frequency.exponentialRampToValueAtTime(f1, t + sweep);
  const g = c.createGain();
  g.gain.value = 0;
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(vel, t + 0.002);
  g.gain.setTargetAtTime(0, t + 0.004, dec / 4);
  o.connect(g).connect(dest);
  o.start(t);
  o.stop(t + dec * 2.2 + 0.01);
  o.onended = () => g.disconnect();
}

const kick = (mx: Mx, t: number, vel: number, f0 = 150, dec = 0.32): void => drumTone(mx, t, vel, f0, 46, 0.075, dec);

function snare(mx: Mx, t: number, vel: number, freq = 2400, dec = 0.15, body = 0.5): void {
  noiseHit(mx, t, vel, 'bandpass', freq, 0.6, dec);
  drumTone(mx, t, vel * body, 200, 165, 0.04, 0.09, 'triangle');
}

/** 拍手：三下很快的雜訊＋一點尾巴 */
function handclap(mx: Mx, t: number, vel: number): void {
  for (let i = 0; i < 3; i++) noiseHit(mx, t + i * 0.011, vel * (0.7 + 0.15 * i), 'bandpass', 1350, 1.1, 0.014);
  noiseHit(mx, t + 0.033, vel * 0.8, 'bandpass', 1250, 0.9, 0.16);
}

/** 鈸：閉鈸短、開放鈸長（下一下閉鈸會悶掉開放鈸） */
function hat(mx: Mx, t: number, vel: number, open = false): void {
  mx.openHat?.gain.setTargetAtTime(0, t, 0.012);
  mx.openHat = null;
  const g = noiseHit(mx, t, vel, 'highpass', 7200, 0.7, open ? 0.32 : 0.045, pan(mx, 0.3));
  if (open) mx.openHat = g;
}

const crash = (mx: Mx, t: number, vel: number): void => void noiseHit(mx, t, vel, 'highpass', 4800, 0.5, 1.3, pan(mx, -0.25));
const shaker = (mx: Mx, t: number, vel: number): void => void noiseHit(mx, t, vel, 'bandpass', 6200, 1.2, 0.055, pan(mx, 0.4), 0.008);

/** 鼓邊敲擊（Bossa 的 rim click） */
function rim(mx: Mx, t: number, vel: number): void {
  drumTone(mx, t, vel, 1750, 1650, 0.01, 0.035, 'triangle', pan(mx, -0.2));
  noiseHit(mx, t, vel * 0.5, 'bandpass', 3000, 2, 0.015, pan(mx, -0.2));
}

/** 太鼓：低沉的「咚」＋鼓皮 */
function taiko(mx: Mx, t: number, vel: number): void {
  drumTone(mx, t, vel, 125, 72, 0.12, 0.5);
  drumTone(mx, t, vel * 0.45, 240, 160, 0.06, 0.1, 'triangle');
}

// ---- 音色 ----

const KOTO: PluckOpt = { bright: 2600, t60: 1.3, bend: 18, damp: true };
const KOTO_BASS: PluckOpt = { bright: 900, t60: 1.6 };
const NYLON: PluckOpt = { bright: 1500, t60: 1.1 };
const P_SHO: Patch = { wave: 'triangle', uni: 5, cut: 1100, q: 0.5, a: 0.7, d: 2, s: 0.9, r: 1.1 };
const P_FLUTE: Patch = { wave: 'triangle', cut: 2300, q: 0.5, a: 0.08, d: 0.5, s: 0.85, r: 0.22, vib: 16, scoop: 45 };
const P_BRASS: Patch = { wave: 'sawtooth', uni: 8, cut: 1250, key: 0.5, fenv: 1.6, fdec: 0.3, q: 1, a: 0.03, d: 0.5, s: 0.7, r: 0.12, vib: 12, scoop: 30 };
// 常常出現的短音（刷弦、琶音、貝斯）用固定的濾波器：濾波器頻率在動的話瀏覽器每個取樣都要重算係數，手機吃不消
const P_CHUG: Patch = { wave: 'sawtooth', uni: 10, cut: 1000, q: 1.1, a: 0.004, d: 0.12, s: 0.35, r: 0.05 };
const P_BRASS_LOW: Patch = { wave: 'sawtooth', cut: 900, q: 0.8, a: 0.03, d: 0.5, s: 0.7, r: 0.12 };
const P_PAD: Patch = { wave: 'sawtooth', uni: 12, cut: 1700, q: 0.6, a: 0.3, d: 1.5, s: 0.85, r: 0.6 };
const P_ROCKBASS: Patch = { wave: 'sawtooth', cut: 650, q: 1.2, a: 0.004, d: 0.2, s: 0.6, r: 0.05, sine: 0.6 };
const P_CHIP: Patch = { wave: 'pulse', cut: 3600, q: 0.5, a: 0.005, d: 0.3, s: 0.7, r: 0.07, vib: 14 };
const P_ARP: Patch = { wave: 'square', cut: 2600, q: 0.7, a: 0.003, d: 0.1, s: 0, r: 0.05 };
const P_SYNBASS: Patch = { wave: 'sawtooth', cut: 620, q: 1.4, a: 0.004, d: 0.15, s: 0.5, r: 0.05, sine: 0.5 };
const P_BRIGHTPAD: Patch = { wave: 'sawtooth', uni: 14, cut: 2400, q: 0.5, a: 0.15, d: 1, s: 0.8, r: 0.5 };
const P_SPARKLE: Patch = { wave: 'triangle', cut: 6000, a: 0.004, d: 0.3, s: 0.4, r: 0.15 };
const P_LOFIBASS: Patch = { wave: 'triangle', cut: 520, q: 0.6, a: 0.012, d: 0.6, s: 0.5, r: 0.1, sine: 0.7 };
const P_UPRIGHT: Patch = { wave: 'triangle', cut: 800, q: 0.7, a: 0.006, d: 0.3, s: 0.35, r: 0.08, sine: 0.5 };

/** 輕微的人味：音量 ±8% */
const hum = (v: number): number => v * (0.92 + Math.random() * 0.16);

// ---- 曲目 ----

/** 櫻花撥弦：古箏旋律（A 段）→ 尺八風的笛子旋律＋古箏琶音（B 段），結尾古箏刮奏回到開頭。D 都節音階（D E♭ G A B♭） */
const SAKURA: Song = (() => {
  const prog = chords(['D5', 'Gm', 'Bbmaj7', 'Asus4', 'D5', 'Gm', 'Ebmaj7', 'D5', 'Gm', 'Ebmaj7', 'Bbmaj7', 'Asus4', 'Gm', 'Ebmaj7', 'Asus4', 'D5'], 48, 64, 38);
  const arpProg = chords(['D5', 'Gm', 'Bbmaj7', 'Asus4', 'D5', 'Gm', 'Ebmaj7', 'D5', 'Gm', 'Ebmaj7', 'Bbmaj7', 'Asus4', 'Gm', 'Ebmaj7', 'Asus4', 'D5'], 55, 72, 38);
  const koto = byStep(
    mel(`D5:4 A4:2 Bb4:2 A4:4 G4:4 | A4:6 Bb4:2 A4:2 G4:2 Eb4:4 | D4:4 Eb4:2 G4:2 A4:4 Bb4:4 | A4:12 -:4 |
         D5:4 Eb5:2 D5:2 Bb4:4 A4:4 | G4:4 A4:2 Bb4:2 A4:4 G4:2 Eb4:2 | D4:4 G4:2 A4:2 Bb4:2 A4:2 G4:2 Eb4:2 | D4:12 -:4 |`),
    256,
  );
  const flute = byStep(
    mel(`-:128 | G4:6 A4:2 Bb4:8 | D5:4 Bb4:4 G4:8 | A4:4 Bb4:4 D5:6 Eb5:2 | D5:12 -:4 |
         G5:6 Eb5:2 D5:8 | Bb4:4 D5:4 Eb5:4 D5:4 | A4:8 G4:4 A4:4 | D5:8 -:8 |`),
    256,
  );
  const pads = byStep(padEvents(prog), 256);
  const gliss = ['D4', 'Eb4', 'G4', 'A4', 'Bb4', 'D5', 'Eb5', 'G5'].map(midi);
  const ARP = [0, 1, 2, 3, 4, 3, 2, 1];
  return {
    bpm: 84,
    bars: 16,
    gain: 1.25,
    rev: 1.4,
    play(mx, k, t) {
      const bar = k >> 4;
      const s = k & 15;
      const d = mx.d16;
      const ch = prog[k >> 3];
      for (const e of koto[k] ?? []) pluck(mx, e.m, t, hum(0.34), KOTO, pan(mx, 0.12));
      for (const e of flute[k] ?? []) synth(mx, e.m, t, e.len * d * 0.95, 0.15, P_FLUTE, pan(mx, -0.1));
      for (const e of pads[k] ?? []) {
        synth(mx, e.notes.filter((_, i) => i % 2 === 0), t, e.len * d, 0.032, P_SHO, pan(mx, -0.3));
        synth(mx, e.notes.filter((_, i) => i % 2 === 1), t, e.len * d, 0.032, P_SHO, pan(mx, 0.3));
      }
      // 低音弦：第一拍根音、第三拍五度
      if (s === 0) pluck(mx, ch.bass, t, 0.36, KOTO_BASS);
      if (s === 8) pluck(mx, ch.bass + 7, t, 0.2, KOTO_BASS);
      // B 段：古箏八分音符琶音
      if (bar >= 8 && !(s & 1) && !(bar === 15 && s >= 12)) {
        const n = arpProg[k >> 3].notes;
        pluck(mx, arp(n, ARP[s >> 1]), t, hum(s % 4 ? 0.13 : 0.17), { bright: 2000, t60: 1.0, damp: true }, pan(mx, -0.25));
      }
      // 最後一拍：古箏往上刮奏回到開頭
      if (bar === 15 && s === 12) gliss.forEach((n, i) => pluck(mx, n, t + i * d * 0.5, 0.1 + i * 0.022, { bright: 2400, t60: 1.0, damp: true }, pan(mx, 0.12)));
      // 太鼓：每小節第一拍；B 段第三拍再輕一下；偶數小節最後一個八分音符小鼓「碰」
      if (s === 0) taiko(mx, t, bar === 0 || bar === 8 ? 0.32 : 0.24);
      if (s === 8 && bar >= 8) taiko(mx, t, 0.13);
      if (s === 14 && bar % 2 === 1 && bar !== 15) drumTone(mx, t, 0.1, 440, 300, 0.05, 0.14, 'sine', pan(mx, -0.2));
    },
  };
})();

/** 熱血運動：主歌（銅管音色的主旋律＋悶音刷弦）→ 導歌（往上推）→ 副歌（王道進行 IV–V–iii–vi）。D 大調 */
const SPORTS: Song = (() => {
  const prog = chords(
    ['Bm', 'G', 'D', 'A', 'Bm', 'G', 'Em', 'A', 'G', 'A', 'F#m', 'Bm', 'G', 'A', 'G', 'Asus4 A', 'Gmaj7', 'A', 'F#m7', 'Bm7', 'Em7', 'F#m7', 'Gmaj7', 'A'],
    52,
    71,
    38,
  );
  const lead = byStep(
    mel(`F#5:3 F#5:3 E5:2 D5:2 E5:2 F#5:4 | G5:3 F#5:3 E5:2 D5:4 B4:4 | A4:3 B4:3 D5:2 -:2 D5:2 E5:2 F#5:2 | E5:8 -:4 C#5:2 E5:2 |
         F#5:3 F#5:3 E5:2 D5:2 E5:2 F#5:4 | G5:3 A5:3 B5:2 A5:4 G5:4 | B5:3 A5:3 G5:2 F#5:2 G5:2 E5:4 | E5:2 F#5:2 G5:2 A5:6 -:4 |
         D5:6 E5:2 D5:4 B4:4 | C#5:6 D5:2 E5:8 | F#5:6 E5:2 C#5:4 A4:4 | B4:6 C#5:2 D5:8 |
         D5:4 E5:4 F#5:4 G5:4 | E5:4 F#5:4 G5:4 A5:4 | B5:8 A5:4 G5:4 | A5:12 -:4 |
         A5:2 B5:2 A5:6 F#5:2 D5:4 | E5:6 F#5:2 A5:4 C#6:4 | C#6:6 B5:2 A5:4 E5:4 | F#5:6 E5:2 D5:8 |
         G5:2 F#5:2 G5:6 A5:2 B5:4 | C#6:6 A5:2 F#5:4 E5:4 | D6:6 B5:2 A5:4 F#5:4 | E5:4 F#5:4 A5:8 |`),
    384,
  );
  const pads = byStep(padEvents(prog), 384);
  return {
    bpm: 140,
    bars: 24,
    gain: 0.45,
    rev: 0.6,
    echo: { beats: 0.75, fb: 0.25, mix: 0.3, tone: 2600 },
    play(mx, k, t) {
      const bar = k >> 4;
      const s = k & 15;
      const d = mx.d16;
      const sec = bar >> 3; // 0 主歌、1 導歌、2 副歌
      const ch = prog[k >> 3];
      for (const e of lead[k] ?? []) {
        const v = sec === 2 ? 0.17 : 0.14;
        synth(mx, e.m, t, e.len * d * 0.9, v, P_BRASS, mx.dry, sec === 2 ? 0.22 : 0.12);
        if (sec === 2) synth(mx, e.m - 12, t, e.len * d * 0.9, 0.07, P_BRASS_LOW, pan(mx, -0.2));
      }
      if (sec > 0) for (const e of pads[k] ?? []) synth(mx, e.notes, t, e.len * d, sec === 2 ? 0.024 : 0.016, P_PAD, pan(mx, 0.3));
      // 悶音刷弦（根音＋五度的強力和弦）：主歌、副歌八分音符；導歌四分音符拉長
      const pr = 47 + ((ch.root - 47) % 12 + 12) % 12;
      if (sec !== 1 ? !(s & 1) : !(s & 3)) {
        const len = sec === 1 ? d * 3.2 : d * 1.5;
        const v = s % 4 ? 0.045 : 0.06;
        synth(mx, [pr, pr + 7], t, len, hum(v), P_CHUG, pan(mx, -0.35));
      }
      // 貝斯：八分音符；副歌八度跳
      if (!(s & 1)) synth(mx, ch.bass + (sec === 2 && s % 4 ? 12 : 0), t, d * 1.6, hum(0.24), P_ROCKBASS);
      // 副歌：16 分音符的亮晶晶琶音
      if (sec === 2) synth(mx, arp(ch.notes, [0, 1, 2, 3, 1, 2, 3, 4][(s & 7)]) + 12, t, d * 0.8, hum(0.03), P_ARP, pan(mx, 0.4), 0.3);
      // 鼓
      const fillEnd = bar === 15 || bar === 23;
      if (k === 0 || k === 256 || k === 320) crash(mx, t, 0.12);
      if (sec === 2) {
        if (s === 0 || s === 6 || s === 8 || s === 14) kick(mx, t, s === 14 ? 0.45 : 0.6, 190);
        if (s === 4 || s === 12) snare(mx, t, 0.3);
        if (!(s & 1)) hat(mx, t, s % 4 ? 0.06 : 0.045, s % 4 === 2);
      } else {
        if (s === 0 || s === 8 || (sec === 0 && s === 10)) kick(mx, t, 0.6, 190);
        if ((s === 4 || s === 12) && !(fillEnd && s === 12)) snare(mx, t, 0.3);
        if (!(s & 1)) hat(mx, t, s % 4 ? 0.05 : 0.065, sec === 1 && s === 14);
      }
      if (bar === 7 && s >= 13) snare(mx, t, 0.12 + (s - 13) * 0.06);
      if (fillEnd && s >= 8) {
        snare(mx, t, 0.1 + (s - 8) * 0.03);
        if (s === 12) kick(mx, t, 0.5, 190);
      }
    },
  };
})();

/** 輕快電子：8-bit 脈衝波主旋律＋16 分音符琶音＋八度跳的貝斯；主歌 → 副歌（四拍大鼓）。F 大調，第二輪主旋律加高八度 */
const SYNTHPOP: Song = (() => {
  const prog = chords(['F', 'C/E', 'Dm', 'Bb', 'F', 'C/E', 'Bb', 'C', 'Bb', 'C', 'Am7', 'Dm7', 'Gm7', 'C7', 'F', 'C'], 57, 74, 36);
  const lead = byStep(
    mel(`C5:2 A4:2 C5:2 F5:4 E5:2 F5:2 G5:2 | E5:6 D5:2 C5:4 -:4 | D5:2 F5:2 A5:2 G5:4 F5:2 E5:2 D5:2 | F5:8 -:4 D5:2 F5:2 |
         C5:2 A4:2 C5:2 F5:4 E5:2 F5:2 A5:2 | G5:6 E5:2 C5:4 -:4 | D5:2 F5:2 Bb5:4 A5:2 G5:2 F5:4 | E5:4 G5:4 C6:4 -:4 |
         F5:6 G5:2 F5:4 D5:4 | E5:6 F5:2 E5:4 C5:4 | C5:2 D5:2 E5:6 G5:2 E5:4 | F5:6 E5:2 D5:8 |
         Bb5:6 A5:2 G5:4 F5:4 | E5:4 G5:4 C6:4 Bb5:4 | A5:12 -:4 | G5:2 F5:2 E5:2 D5:2 C5:4 -:4 |`),
    256,
  );
  const pads = byStep(padEvents(prog), 256);
  const ARP = [0, 1, 2, 3, 2, 1, 2, 3];
  return {
    bpm: 120,
    bars: 16,
    gain: 0.56,
    rev: 0.6,
    echo: { beats: 0.75, fb: 0.32, mix: 0.32, tone: 3000 },
    play(mx, k, t, pass) {
      const bar = k >> 4;
      const s = k & 15;
      const d = mx.d16;
      const chorus = bar >= 8;
      const ch = prog[k >> 3];
      for (const e of lead[k] ?? []) {
        synth(mx, e.m, t, e.len * d * 0.85, 0.11, P_CHIP, mx.dry, 0.4);
        if (pass % 2 === 1 || chorus) synth(mx, e.m + 12, t, e.len * d * 0.85, 0.035, P_SPARKLE, pan(mx, -0.3), 0.3);
      }
      if (chorus) for (const e of pads[k] ?? []) synth(mx, e.notes, t, e.len * d, 0.02, P_BRIGHTPAD, pan(mx, -0.3));
      // 琶音：16 分音符，主歌第一輪前四小節先不出來
      if (pass > 0 || bar >= 4) synth(mx, arp(ch.notes, ARP[s & 7]) + 12, t, d * 0.7, hum(s & 1 ? 0.028 : 0.04), P_ARP, pan(mx, 0.35), 0.25);
      // 貝斯：八分音符，低音／高八度交替
      if (!(s & 1)) synth(mx, ch.bass + (s & 2 ? 12 : 0), t, d * 1.5, hum(0.22), P_SYNBASS);
      // 鼓
      if (k === 0 || k === 128) crash(mx, t, 0.1);
      if (chorus ? !(s & 3) : s === 0 || s === 8 || s === 11) kick(mx, t, 0.6, 165);
      if (s === 4 || s === 12) handclap(mx, t, 0.22);
      if (chorus && s % 4 === 2) hat(mx, t, 0.055, true);
      else hat(mx, t, s & 1 ? 0.025 : 0.045);
      if ((bar === 7 || bar === 15) && s >= 8 && s % 2 === 0 && s !== 12) snare(mx, t, 0.1 + (s - 8) * 0.025, 2600, 0.1);
    },
  };
})();

/** Lo-fi 放鬆：電鋼琴九和弦／十三和弦（ii–V–I–vi），拇指琴旋律，搖擺的 boom-bap 鼓。整首經過錄音帶晃動＋悶一點的低通。E♭ 大調 */
const LOFI: Song = (() => {
  const bars8 = ['Fm9', 'Bb13', 'Ebmaj9', 'Cm9', 'Abmaj7', 'G7b9', 'Cm9', 'Bb7sus4'];
  const prog = chords([...bars8, ...bars8], 53, 72, 36, true);
  const lead = byStep(
    mel(`-:4 C5:2 Eb5:2 G5:6 F5:2 | D5:6 C5:2 -:4 Bb4:4 | G5:8 F5:4 D5:4 | Eb5:12 -:4 |
         -:4 C5:2 Eb5:2 G5:6 Ab5:2 | F5:6 Eb5:2 D5:4 B4:4 | C5:4 D5:4 Eb5:8 | F5:4 Eb5:4 -:8 |
         Ab5:4 G5:2 F5:2 Eb5:4 C5:4 | D5:8 -:8 | Bb4:2 D5:2 F5:2 G5:2 Bb5:8 | G5:4 Eb5:4 D5:8 |
         Eb5:6 C5:2 Eb5:4 G5:4 | F5:4 D5:4 B4:8 | -:4 G4:2 Bb4:2 C5:8 | -:16 |`),
    256,
  );
  // 電鋼琴的節奏：[格, 長度, 力度]（奇數小節換一種，比較像人在彈）
  const COMP = [
    [
      [0, 6, 0.2],
      [7, 2, 0.1],
      [10, 5, 0.14],
    ],
    [
      [0, 7, 0.2],
      [11, 3, 0.12],
      [14, 2, 0.09],
    ],
  ];
  return {
    bpm: 82,
    bars: 16,
    swing: 0.3,
    gain: 0.53,
    rev: 0.8,
    fx(c, input, out, keep) {
      // 錄音帶：很慢的音高晃動（wow）＋一點點快的抖動（flutter），再把高頻收掉一些
      const dl = c.createDelay(0.1);
      dl.delayTime.value = 0.012;
      const lp = c.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 4200;
      lp.Q.value = 0.5;
      input.connect(dl).connect(lp).connect(out);
      keep.push(dl, lp);
      for (const [rate, depth] of [
        [0.55, 0.0011],
        [4.3, 0.00008],
      ]) {
        const o = c.createOscillator();
        o.frequency.value = rate;
        const g = c.createGain();
        g.gain.value = depth;
        o.connect(g).connect(dl.delayTime);
        o.start();
        keep.push(o, g);
      }
    },
    play(mx, k, t) {
      const bar = k >> 4;
      const s = k & 15;
      const d = mx.d16;
      const ch = prog[k >> 3];
      for (const [at, len, v] of COMP[bar & 1]) {
        if (s !== at) continue;
        ch.notes.forEach((n, i) => epiano(mx, n, t + i * 0.007 + Math.random() * 0.006, len * d, hum(v) * 0.6, pan(mx, i % 2 ? 0.22 : -0.22)));
      }
      for (const e of lead[k] ?? []) mallet(mx, e.m, t, hum(0.17), pan(mx, 0.15));
      // 貝斯：根音、（反拍）根音、五度、往下一個和弦的經過音
      const next = prog[((bar + 1) % 16) * 2];
      if (s === 0) synth(mx, ch.bass, t, d * 6, 0.3, P_LOFIBASS);
      if (s === 7) synth(mx, ch.bass, t, d * 2, 0.17, P_LOFIBASS);
      if (s === 10) synth(mx, ch.bass + 7, t, d * 3.5, 0.24, P_LOFIBASS);
      if (s === 14 && bar !== 15) synth(mx, next.bass - 1, t, d * 1.8, 0.15, P_LOFIBASS);
      // 鼓：大鼓 1、（2 的反拍）、3 的後半；小鼓 2、4；鈸八分音符（反拍輕）＋幾個鬼音
      if (s === 0 || (s === 10 && bar !== 15) || (s === 7 && bar % 4 === 3)) kick(mx, t, s === 0 ? 0.55 : 0.42, 110, 0.36);
      if (s === 4 || s === 12) snare(mx, t, 0.2, 1700, 0.17, 0.6);
      if (!(s & 1)) hat(mx, t, s % 4 ? 0.03 : 0.045);
      if (s === 15 || (s === 7 && bar & 1)) hat(mx, t, 0.018);
    },
  };
})();

/** 海島 Bossa：尼龍吉他照 bossa 節奏刷和弦（下一小節的和弦提前半拍進來）、低音大提琴、鋼鼓旋律、沙鈴、鼓邊。D 大調 */
const BOSSA: Song = (() => {
  const prog = chords(
    ['Dmaj7', 'Bm7', 'Em7', 'A7', 'F#m7', 'B7', 'Em7', 'A7', 'Gmaj7', 'Gm6', 'F#m7', 'B7b9', 'Em7', 'A7', 'Dmaj7', 'Em7 A7'],
    52,
    69,
    38,
    true,
  );
  const lead = byStep(
    mel(`-:2 F#5:2 A5:3 F#5:3 E5:2 C#5:4 | D5:6 B4:2 -:4 A4:2 B4:2 | -:2 G5:2 B5:3 G5:3 F#5:2 D5:4 | E5:6 C#5:2 -:4 B4:2 C#5:2 |
         -:2 A5:2 C#6:3 A5:3 F#5:2 E5:4 | D#5:6 F#5:2 -:4 A5:2 F#5:2 | G5:4 F#5:2 E5:2 D5:4 B4:4 | C#5:6 E5:2 G5:4 -:4 |
         B5:6 A5:2 F#5:4 D5:4 | Bb5:6 G5:2 E5:4 D5:4 | A5:4 C#6:4 A5:4 E5:4 | D#5:6 C5:2 A5:4 F#5:4 |
         G5:6 F#5:2 E5:4 B4:4 | C#5:4 E5:4 G5:4 A5:4 | F#5:12 -:4 | -:4 E5:2 F#5:2 G5:4 C#5:4 |`),
    256,
  );
  const HITS = [0, 3, 6, 10, 13]; // bossa 的切分節奏
  return {
    bpm: 100,
    bars: 16,
    swing: 0.06,
    gain: 0.65,
    rev: 0.8,
    echo: { beats: 0.75, fb: 0.2, mix: 0.2, tone: 2200 },
    play(mx, k, t) {
      const bar = k >> 4;
      const s = k & 15;
      const d = mx.d16;
      const ch = prog[k >> 3];
      // 吉他：最後一下（第 13 格）提前彈下一小節的和弦
      const hi = HITS.indexOf(s);
      if (hi >= 0) {
        const g = s === 13 ? prog[((bar + 1) % 16) * 2] : ch;
        const len = ((HITS[hi + 1] ?? 16) - s) * d * 0.92;
        g.notes.forEach((n, i) => pluck(mx, n, t + i * 0.011, hum(i === g.notes.length - 1 ? 0.16 : 0.12), { ...NYLON, dur: len }, pan(mx, -0.25)));
      }
      for (const e of lead[k] ?? []) steelpan(mx, e.m, t, hum(0.19), pan(mx, 0.15), 0.18);
      // 低音：附點四分＋八分（根音、根音、五度、五度）；和弦在小節中間換的話第三拍彈新的根音
      const first = prog[bar * 2];
      const second = prog[bar * 2 + 1];
      const fifth = second.sym !== first.sym ? second.bass : first.bass + 7;
      if (s === 0) synth(mx, first.bass, t, d * 5.5, 0.3, P_UPRIGHT);
      if (s === 6) synth(mx, first.bass, t, d * 1.6, 0.18, P_UPRIGHT);
      if (s === 8) synth(mx, fifth, t, d * 5.5, 0.26, P_UPRIGHT);
      if (s === 14) synth(mx, fifth, t, d * 1.6, 0.16, P_UPRIGHT);
      // 打擊：沙鈴 16 分音符、鼓邊、很輕的大鼓
      shaker(mx, t, s & 1 ? 0.022 : s % 4 ? 0.032 : 0.04);
      if (s === 3 || s === 10) rim(mx, t, 0.07);
      if (s === 0 || s === 8) kick(mx, t, 0.36, 95, 0.28);
      if (s === 6 || s === 14) kick(mx, t, 0.18, 95, 0.22);
      if (bar === 15 && s === 12) rim(mx, t, 0.06);
    },
  };
})();

const SONGS: Record<SongId, Song> = { sakura: SAKURA, sports: SPORTS, synth: SYNTHPOP, lofi: LOFI, bossa: BOSSA };/**
 * 依場地自動：撥弦五聲音階即興（八分音符一格）。
 * 低音每小節第一拍；旋律在音階上隨機漫步、偶爾休止；市場加琵琶式輪指；海灘反拍刷弦。
 */
const venueSongs = new Map<Venue, Song>();
function venueSong(v: Venue): Song {
  let song = venueSongs.get(v);
  if (song) return song;
  const st = (PROFILES[v] ?? PROFILES.indoor).music;
  const root = Math.round(69 + 12 * Math.log2(st.root / 440));
  const deg = (i: number): number => st.scale[i % 5] + 12 * Math.floor(i / 5);
  song = {
    bpm: st.bpm,
    bars: st.bass.length,
    gain: 1.2,
    rev: 2.2,
    play(mx, k, t) {
      if (k & 1) return;
      const bar = k >> 4;
      const d8 = mx.d16 * 2;
      const bi = st.bass[bar % st.bass.length];
      if ((k & 15) === 0) pluck(mx, root - 12 + st.scale[bi], t, 0.5, KOTO_BASS);
      if (Math.random() < st.density) {
        mx.note = Math.max(0, Math.min(11, mx.note + [-2, -1, -1, 0, 1, 1, 2][Math.floor(Math.random() * 7)]));
        const m = root + deg(mx.note);
        pluck(mx, m, t + (Math.random() - 0.5) * 0.012, 0.32, KOTO);
        // 琵琶式輪指：同一根弦半拍後再撥一下（先止住上一下）
        if (st.tremolo && Math.random() < st.tremolo) pluck(mx, m, t + d8 / 2, 0.2, KOTO);
      }
      // 反拍刷弦：低音那個和弦的兩個音，像烏克麗麗輕輕刷過
      if (st.offbeat && (k & 3) === 2 && Math.random() < 0.75) {
        for (let i = 0; i < 2; i++) pluck(mx, root + 12 + st.scale[(bi + 2 + i * 2) % 5], t + i * 0.012, 0.11, { bright: 2000, t60: 0.8, damp: true });
      }
    },
  };
  venueSongs.set(v, song);
  return song;
}

/** 排一格：算出這一輪的第幾格、搖擺 */
function playStep(mx: Mx, step: number, t: number): void {
  const song = mx.song;
  const n = song.bars * 16;
  const k = step % n;
  song.play(mx, k, t + (k & 1 ? (song.swing ?? 0) * mx.d16 : 0), Math.floor(step / n));
}

const LOOKAHEAD = 0.3;

export const music = {
  playing: false,
  timer: 0,
  nextAt: 0,
  step: 0,
  intensity: 1, // 選單 1；比賽中小聲一點
  choice: 'auto' as MusicTrack,
  cur: null as Mx | null,
  previewUntil: 0, // 音樂關著時按「試聽」：播到這個時間（AudioContext 秒）

  setIntensity(x: number) {
    this.intensity = x;
    this.sync();
  },

  /** 選曲：'auto' = 依場地自動；換曲時舊的淡出、新的從頭開始 */
  setTrack(id: MusicTrack) {
    this.choice = id === 'auto' || id in SONGS ? id : 'auto';
    if (this.playing) this.load(this.song());
  },

  song(): Song {
    return this.choice === 'auto' ? venueSong(venue) : SONGS[this.choice];
  },

  /** 換場地了：依場地自動的話換成新場地的曲風 */
  venueChanged() {
    if (this.playing && this.choice === 'auto') this.load(this.song());
  },

  /** 試聽：目前選的曲子從頭播；音樂關著時也播 20 秒 */
  preview() {
    if (!ctx) return;
    if (!musicOn) this.previewUntil = ctx.currentTime + 20;
    if (this.playing) this.load(this.song(), true);
    this.sync();
    window.setTimeout(() => this.sync(), 20200);
  },

  /** 離開設定畫面：音樂關著的試聽停掉 */
  endPreview() {
    this.previewUntil = 0;
    this.sync();
  },

  sync() {
    if (!ctx) return;
    const on = musicOn || ctx.currentTime < this.previewUntil;
    musicBus.gain.setTargetAtTime(on ? 0.22 * this.intensity : 0, ctx.currentTime, 0.4);
    if (on && !this.playing) this.start();
    if (!on && this.playing) this.stopLoop();
  },

  start() {
    if (!ctx || this.playing) return;
    this.playing = true;
    this.load(this.song(), true);
    const tick = () => {
      if (!this.playing || !ctx || !this.cur) return;
      const mx = this.cur;
      const now = ctx.currentTime;
      // 分頁在背景時計時器會被放慢：錯過的格子直接跳過，不要回來時一次全部擠出來
      if (this.nextAt < now) {
        const miss = Math.ceil((now - this.nextAt) / mx.d16);
        this.step += miss;
        this.nextAt += miss * mx.d16;
      }
      while (this.nextAt < now + LOOKAHEAD) {
        playStep(mx, this.step++, this.nextAt);
        this.nextAt += mx.d16;
      }
      this.timer = window.setTimeout(tick, 60);
    };
    tick();
  },

  /** 換成這首（同一首就不動；restart = 從頭） */
  load(song: Song, restart = false) {
    if (!ctx || (this.cur?.song === song && !restart)) return;
    if (this.cur) disposeMx(this.cur, 0.35);
    this.cur = newMx(ctx, song, musicBus, noiseBuf);
    musicRev.gain.setTargetAtTime(song.rev, ctx.currentTime, 0.1);
    this.step = 0;
    this.nextAt = ctx.currentTime + 0.12;
  },

  stopLoop() {
    this.playing = false;
    clearTimeout(this.timer);
    if (this.cur) disposeMx(this.cur, 0.8);
    this.cur = null;
  },
};

/**
 * 離線算一段背景音樂（試聽檔、檢查音量用；跟遊戲裡同一套合成程式和同一條音樂路徑：
 * 音樂匯流排 → 高通 → 主音量 → 壓縮器，殘響用場地的）。track = 'auto' 時用 venue 的場地曲風。
 */
export async function renderMusic(
  track: MusicTrack,
  o: { venue?: Venue; seconds?: number; sampleRate?: number; startBar?: number; intensity?: number } = {},
): Promise<AudioBuffer> {
  const v = o.venue ?? 'sakura';
  const secs = o.seconds ?? 25;
  const sr = o.sampleRate ?? 32000;
  const c = new OfflineAudioContext(2, Math.ceil(secs * sr), sr);
  const out = c.createGain();
  out.gain.value = 0.9;
  const comp = c.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.ratio.value = 4;
  out.connect(comp).connect(c.destination);
  const a = PROFILES[v].acoustics;
  const wet = c.createGain();
  wet.gain.value = a.send;
  const pre = c.createDelay(0.2);
  pre.delayTime.value = a.pre;
  const conv = c.createConvolver();
  conv.buffer = impulse(c, a.secs, a.decay);
  const tone = c.createBiquadFilter();
  tone.type = 'lowpass';
  tone.Q.value = 0.5;
  tone.frequency.value = a.tone;
  wet.connect(pre).connect(conv).connect(tone).connect(out);
  const song = track === 'auto' ? venueSong(v) : SONGS[track];
  const { bus, rev } = musicChain(c, out, wet);
  bus.gain.value = 0.22 * (o.intensity ?? 1);
  rev.gain.value = song.rev;
  const mx = newMx(c, song, bus, makeNoise(c));
  // 跟即時播放一樣邊播邊排（每 0.25 秒停一下排接下來的音），同時存在的節點數才會跟遊戲裡一樣
  let step = (o.startBar ?? 0) * 16;
  let t = 0.05;
  const sched = (until: number): void => {
    for (; t < Math.min(until, secs); t += mx.d16) playStep(mx, step++, t);
  };
  sched(LOOKAHEAD + 0.25);
  for (let at = 0.25; at < secs; at += 0.25) {
    const when = at;
    void c.suspend(when).then(() => {
      sched(when + LOOKAHEAD + 0.25);
      void c.resume();
    });
  }
  return c.startRendering();
}
