import './style.css';
import { AIController, STYLES } from './ai/ai';
import { ambience, callScore, music, setMusicOn, setSfxOn, setSpeechOn, sfx, unlockAudio } from './audio';
import { DEFAULT_SETTINGS, GAME, PHYS, type MatchSettings, type Venue } from './config';
import { LocalControls } from './input/controls';
import { GameRenderer, type Look } from './render/scene';
import { idleInput, Match, type MatchEvent, type TeamId } from './sim/match';
import { DRILLS, DrillRunner, loadBest, saveBest, type Drill } from './modes/drills';
import { loadTour, saveTourWin, stopUnlocked, TOUR, type TourOpponent } from './modes/tour';
import { buildKit, CHARACTERS, characterById, racketById, RACKETS, type Character, type Kit } from './sim/kits';
import { Hud } from './ui/hud';
import { chargeZones } from './sim/shots';
import { OnlineSync } from './net/sync';
import { buildTutorial, TutorialRunner, type TutUI } from './modes/tutorial';
import type { PlayerInput } from './sim/match';
import { newRoomCode, normalizeCode, RoomClient, type Hello, type StartInfo } from './net/room';

const HUMAN = 0 as const;
const $ = (id: string) => document.getElementById(id)!;

type Mode = 'menu' | 'play' | 'paused' | 'result';

const settings = loadSettings();
saveSettings(); // 舊存檔遷移後立刻存回
const renderer = new GameRenderer($('app'));
const controls = new LocalControls(renderer.renderer.domElement, $('touch'));
const hud = new Hud($('hud'));

let mode: Mode = 'menu';
let match!: Match;
/** 電腦控制的球員，索引 = 球員編號（null = 玩家自己／線上對手；練習模式沒有） */
let bots: (AIController | null)[] = [];
let drill: DrillRunner | null = null; // 目前的訓練關卡
let tourCtx: { stop: number; idx: number } | null = null; // 目前的巡迴賽場次
let again: () => void = () => startGame(); // 「再來一次」要重開什麼
let demoPlayer: AIController | null = null; // 主選單背景的 AI 示範對打
let resultTimer: number | undefined;
/** 線上對戰：房間連線＋比賽同步（還在大廳時 sync = null） */
let online: { room: RoomClient; sync: OnlineSync | null } | null = null;
let netInfoT = 0;
/** 新手教學（暫停時玩家的那一下輸入先存著，下一個 tick 用） */
let tutorial: TutorialRunner | null = null;
let tutInput: PlayerInput | null = null;

/** 手機震動（iPhone 的 Safari 不支援，會自動略過） */
function buzz(pattern: number | number[]): void {
  if (!settings.vibration || demoPlayer) return;
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* 不支援就算了 */
  }
}
controls.onPress = (jump) => {
  buzz(jump ? [12, 40, 12] : 12);
  if (jump) sfx.jumpArm();
};

let hitStop = 0; // 擊中瞬間畫面停頓（秒，真實時間）
let lastZone = 0; // 蓄力目前在哪一區：0 掛網 1 好球 2 出界

let assist: AIController | null = null; // 簡單模式：幫玩家自動跑位
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

/** 開一場對 AI 的比賽；doubles = 雙打（自己＋AI 夥伴 對 兩位 AI）。回傳這場的球員（開場介紹用） */
function newMatch(demo: boolean, tourOpp?: TourOpponent, venue?: Venue, doubles = false): { partner: Character | null; opps: Character[] } {
  endTutorial();
  // 對手每場隨機換一位球員、一支球拍（不跟自己同一位）
  const me = demo ? pick(CHARACTERS) : characterById(settings.character);
  const opp = tourOpp ? characterById(tourOpp.character) : pick(CHARACTERS.filter((c) => c.id !== me.id));
  const s: MatchSettings = { ...settings, aiCharacter: opp.id, aiRacket: tourOpp ? tourOpp.racket : pick(RACKETS).id, doubles };
  if (tourOpp) {
    s.points = tourOpp.points;
    s.games = 1;
  }
  if (demo) {
    s.character = me.id;
    s.racket = pick(RACKETS).id;
  }
  // 雙打：夥伴、第二位對手也隨機（四個人都不同）
  let partner: Character | null = null;
  let opp2: Character | null = null;
  if (doubles) {
    partner = pick(CHARACTERS.filter((c) => c.id !== me.id && c.id !== opp.id));
    opp2 = pick(CHARACTERS.filter((c) => c.id !== me.id && c.id !== opp.id && c.id !== partner!.id));
    s.partnerCharacter = partner.id;
    s.partnerRacket = pick(RACKETS).id;
    s.ai2Character = opp2.id;
    s.ai2Racket = pick(RACKETS).id;
  }
  match = new Match(s, (Date.now() ^ (Math.random() * 1e9)) >>> 0);
  tourCtx = null;
  demoPlayer = demo ? new AIController(match, 0, 'hard') : null;
  bots = [
    demoPlayer,
    tourOpp ? new AIController(match, 1, tourOpp.level, false, STYLES[tourOpp.style]) : new AIController(match, 1, demo ? 'hard' : settings.difficulty),
  ];
  if (doubles) {
    // 夥伴至少「普通」（簡單難度時自己這隊不要太弱）；第二位對手跟難度設定
    bots[2] = new AIController(match, 2, settings.difficulty === 'easy' ? 'normal' : settings.difficulty);
    bots[3] = new AIController(match, 3, settings.difficulty);
  }
  setupAssist(demo);
  controls.scheme = settings.scheme;
  const look = (c: Character, racket: string): Look => ({ ...c, racketColor: racketById(racket).color });
  renderer.setLooks(
    doubles
      ? teamLooks([look(me, s.racket), look(opp, s.aiRacket!), look(partner!, s.partnerRacket!), look(opp2!, s.ai2Racket!)])
      : [look(me, s.racket), look(opp, s.aiRacket!)],
  );
  applyVenue(venue ?? settings.venue);
  hud.oppName = tourOpp ? tourOpp.title : doubles ? '對手' : opp.name;
  hud.oppTag = 'AI';
  hud.drill = null;
  drill = null;
  renderer.setTarget(null);
  clearTimeout(resultTimer);
  hitStop = 0;
  return { partner, opps: opp2 ? [opp, opp2] : [opp] };
}

/** 顏色往黑（k<0）或往白（k>0）調 */
function shade(c: number, k: number): number {
  const ch = (v: number) => Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k);
  return (ch((c >> 16) & 255) << 16) | (ch((c >> 8) & 255) << 8) | ch(c & 255);
}

/** 色相（0..360），選對手隊色用 */
function hueOf(c: number): number {
  const r = ((c >> 16) & 255) / 255;
  const g = ((c >> 8) & 255) / 255;
  const b = (c & 255) / 255;
  const mx = Math.max(r, g, b);
  const d = mx - Math.min(r, g, b);
  if (d < 1e-6) return 0;
  const h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

/**
 * 雙打隊服：自己這隊穿自己球員的球衣顏色（夥伴深一點），對手那隊穿對比色（藍或紅，選離自己色相遠的），
 * 一眼分得出兩隊；髮型、身高、背號、球拍還是各自的。looks 的順序 = 球員編號（0 自己、1 對手、2 夥伴、3 對手）
 */
function teamLooks(looks: Look[]): Look[] {
  const mine = looks[0].shirt;
  const hd = (a: number, b: number) => {
    const d = Math.abs(hueOf(a) - hueOf(b));
    return Math.min(d, 360 - d);
  };
  const theirs = hd(mine, 0x2f7fe0) >= hd(mine, 0xe0483a) ? { shirt: 0x2f7fe0, shorts: 0x1b2a44 } : { shirt: 0xe0483a, shorts: 0x3a1b1b };
  return looks.map((l, i) => {
    const partner = i >= 2;
    const base = i % 2 === 0 ? { shirt: mine, shorts: looks[0].shorts } : theirs;
    return { ...l, shirt: partner ? shade(base.shirt, -0.32) : base.shirt, shorts: base.shorts };
  });
}

/** 選球員／球拍的卡片 */
/** 能力值（倍率）→ 長條百分比：1.0 = 一半，±20% 到底 */
const barPct = (v: number) => Math.max(4, Math.min(100, 50 + (v - 1) * 250));

/** 7 項能力：殺球、切球、推球、高遠、速度（跑速＋起步）、判定（揮拍時間）、準度 */
function kitStats(k: Kit): [string, string, number][] {
  return [
    ['殺', '殺球', k.speed.smash],
    ['切', '切球／放網', k.speed.drop],
    ['推', '推球／平抽', k.speed.push],
    ['高', '高遠／挑球', k.speed.clear],
    ['速', '跑速／起步', (k.move + k.accel) / 2],
    ['判', '揮拍判定', k.window],
    ['準', '落點準度', 1 / k.accuracy],
  ];
}

function bars(k: Kit, full: boolean): string {
  return kitStats(k)
    .map(([short, long, v]) => {
      const d = Math.round((v - 1) * 100);
      const cls = d > 0 ? 'up' : d < 0 ? 'down' : '';
      const label = full ? long : short;
      const val = full ? `<em>${d > 0 ? '+' : ''}${d}%</em>` : '';
      return `<div class="bar ${cls}"><label>${label}</label><div class="track"><div class="mid"></div><div class="fill" style="width:${barPct(v)}%"></div></div>${val}</div>`;
    })
    .join('');
}

/** 選球員／球拍的卡片（附能力長條圖） */
function buildCards(): void {
  const charBox = $('charCards');
  charBox.innerHTML = '';
  for (const c of CHARACTERS) {
    const b = document.createElement('button');
    b.className = 'card' + (c.id === settings.character ? ' on' : '');
    b.innerHTML = `<div class="swatch" style="background:#${c.shirt.toString(16).padStart(6, '0')}"></div><b>${c.name}</b><small>${c.title}</small><span>${c.desc}</span>`;
    b.addEventListener('click', () => {
      settings.character = c.id;
      saveSettings();
      buildCards();
    });
    charBox.appendChild(b);
  }
  const rBox = $('racketCards');
  rBox.innerHTML = '';
  for (const r of RACKETS) {
    const b = document.createElement('button');
    b.className = 'card' + (r.id === settings.racket ? ' on' : '');
    b.innerHTML = `<div class="swatch" style="background:#${r.color.toString(16).padStart(6, '0')}"></div><b>${r.name}</b><span>${r.desc}</span>`;
    b.addEventListener('click', () => {
      settings.racket = r.id;
      saveSettings();
      buildCards();
    });
    rBox.appendChild(b);
  }
  // 球員 × 球拍 組合後的實際能力
  const me = characterById(settings.character);
  const rk = racketById(settings.racket);
  $('kitSummary').innerHTML = `<div class="kit-title">${me.name} ＋ ${rk.name}</div><div class="bars">${bars(buildKit(me.id, rk.id), true)}</div>`;
}

function setMode(m: Mode): void {
  music.setIntensity(m === 'menu' || m === 'result' ? 1 : 0.4); // 比賽中音樂小聲一點
  mode = m;
  $('tour').classList.remove('show');
  if (m !== 'result') $('nextBtn').style.display = 'none';
  controls.enabled = m === 'play';
  controls.reset();
  document.body.classList.toggle('in-menu', m === 'menu');
  $('menu').classList.toggle('show', m === 'menu');
  $('pause').classList.toggle('show', m === 'paused');
  $('result').classList.toggle('show', m === 'result');
  $('drills').classList.remove('show');
  if (m !== 'menu') $('online').classList.remove('show');
  if (m !== 'menu') $('settings').classList.remove('show');
  $('restartBtn').style.display = online?.sync ? 'none' : ''; // 線上不能重新開始
  $('hud').style.visibility = m === 'menu' ? 'hidden' : 'visible';
}

function handleEvent(e: MatchEvent): void {
  const live = !demoPlayer;
  const mine = 'player' in e && e.player === HUMAN;
  switch (e.type) {
    case 'hit': {
      const smash = (e.family === 'down' && e.speedKmh > 120) || e.jump;
      const q = e.serve ? 0.85 : e.quality; // 發球不評分
      if (live) sfx.hit(q, e.speedKmh, e.jump);
      if (mine) buzz(e.jump ? [45, 25, 35] : smash ? [40, 20, 25] : e.serve ? 14 : e.grade === '完美' ? 30 : e.grade === '勉強' ? 10 : 18);
      renderer.burst(e.pos, q, smash, e.jump);
      if (live && !online?.sync) hitStop = e.serve ? 0.03 : mine ? (e.jump ? 0.11 : smash ? 0.09 : e.grade === '完美' ? 0.07 : 0.05) : smash ? 0.06 : 0.03;
      break;
    }
    case 'whiff':
      if (live) sfx.whiff();
      if (mine) buzz([6, 50, 6]);
      break;
    case 'jump':
      if (live) sfx.jump();
      break;
    case 'jumpLand':
      if (live) sfx.thud();
      renderer.dust(match.players[e.player].pos);
      break;
    case 'dive':
      if (live) {
        sfx.whoosh();
        sfx.squeak(mine ? 1 : 0.6);
      }
      if (mine) buzz(25);
      break;
    case 'diveLand':
      if (live) sfx.thud();
      if (mine) buzz([30, 30, 15]);
      renderer.dust(match.players[e.player].pos);
      break;
    case 'net':
      if (live) sfx.net();
      break;
    case 'land':
      if (live) sfx.land();
      break;
    case 'point':
      if (live) {
        sfx.point(e.winner === match.teamOf(HUMAN));
        onPointAudio(e.winner, e.reason);
      }
      break;
    case 'match':
      if (live) {
        const ctx = tourCtx;
        resultTimer = window.setTimeout(() => {
          const win = e.winner === match.teamOf(HUMAN);
          // 比分、局數以隊伍為索引：0 = 自己這隊
          const sc = match.settings.games > 1 ? `局數 ${match.games[0]} : ${match.games[1]}` : `比分 ${match.score[0]} : ${match.score[1]}`;
          $('resultTitle').textContent = win ? (match.doubles ? '🏆 你們贏了！' : '🏆 你贏了！') : `${hud.oppName} 獲勝`;
          $('resultScore').textContent = sc;
          if (ctx) {
            const stop = TOUR[ctx.stop];
            const opp = stop.opponents[ctx.idx];
            if (win) {
              saveTourWin(stop.id, ctx.idx);
              const last = ctx.idx === stop.opponents.length - 1;
              $('resultTitle').textContent = opp.boss ? `👑 打敗${opp.title}！` : `🏆 打贏${opp.title}！`;
              $('resultScore').textContent = last
                ? ctx.stop < TOUR.length - 1
                  ? `${sc}　${stop.name}制霸！開放「${TOUR[ctx.stop + 1].name}」`
                  : `${sc}　恭喜完成全部巡迴賽！`
                : sc;
              const next = last ? (ctx.stop < TOUR.length - 1 ? { stop: ctx.stop + 1, idx: 0 } : null) : { stop: ctx.stop, idx: ctx.idx + 1 };
              if (next) {
                $('nextBtn').style.display = 'block';
                $('nextBtn').onclick = () => startTour(next.stop, next.idx);
              }
            }
          }
          setMode('result');
          if (ctx && win) $('nextBtn').style.display = $('nextBtn').onclick ? 'block' : 'none';
        }, 1600);
      } else {
        window.setTimeout(() => mode === 'menu' && newMatch(true), 1500);
      }
      break;
  }
  if (live) hud.onEvent(e, match, renderer, HUMAN);
  drill?.onEvent(e);
  tutorial?.onEvent(e);
}

// ---------- 主迴圈：固定步長模擬，畫面照幀率跑 ----------
let last = performance.now();
let acc = 0;
function tick(now: number): void {
  // 不小於 0：console 的 game.advance() 會把 last 推到未來，之後的真實畫格不能算出負的 dt
  const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
  last = now;
  if (drill && mode === 'play' && hitStop <= 0) drill.tick(dt);
  if (tutorial && mode === 'play') {
    tutorial.tick(dt);
    $('tutCard').classList.toggle('compact', tutorial.inPlay);
    if (tutorial.frozen) {
      // 教學暫停：世界停住，只收玩家的輸入（蓄力照算），做對了才繼續
      const inp = controls.poll();
      if (!inp.flick) match.holdCharge(HUMAN, inp.charging, dt * GAME.simSpeed); // 划的那一下保留蓄力
      tutInput = tutorial.frozenInput(inp) ?? tutInput;
    }
  }
  if (hitStop > 0) hitStop -= dt;
  else if (mode === 'play' || mode === 'menu' || (online?.sync && mode === 'paused')) {
    // 線上：暫停畫面時比賽照樣進行（對方不會等你）
    acc += dt * GAME.simSpeed * (tutorial && mode === 'play' ? tutorial.timeScale : 1);
    let n = 0;
    while (acc >= PHYS.dt && n++ < 40 && hitStop <= 0) {
      const mine = demoPlayer ? demoPlayer.input() : (tutInput ?? controls.poll());
      tutInput = null;
      if (assist && (!tutorial || tutorial.wantAssist)) {
        // 簡單模式：移動交給自動跑位，蓄力／出拍還是玩家自己
        const a = assist.input();
        mine.moveX = a.moveX;
        mine.moveY = a.moveY;
        mine.dive ??= a.dive;
      }
      const prevSwing = match.players[HUMAN].swing;
      // 依球員編號順序取輸入（AI 會用比賽的亂數，順序固定才可重現）
      match.step(match.players.map((p) => (p.id === HUMAN ? mine : (bots[p.id]?.input() ?? idleInput()))));
      // 真的開始揮拍才出聲（只點不滑但球還沒來 = 連按兩下的第一下，不算）
      const sw = match.players[HUMAN].swing;
      if (!demoPlayer && sw && sw !== prevSwing) {
        sfx.whoosh();
        buzz(8);
      }
      if (!demoPlayer) shoeSqueaks();
      acc -= PHYS.dt;
      const sync = online?.sync;
      for (const e of match.drainEvents()) {
        sync?.onEvent(e);
        handleEvent(e);
      }
      sync?.afterStep();
      if (tutorial?.checkFreeze()) {
        acc = 0;
        break;
      }
    }
    if (hitStop > 0) acc = 0;
  }
  const me = match.players[HUMAN];
  if (!demoPlayer) chargeZoneTicks(me.charging, me.charge, match.phase === 'serve' && match.server === HUMAN, match.doubles);
  renderer.update(match, mode === 'paused' || mode === 'result' ? 0 : dt, settings.landingHint && !demoPlayer, HUMAN);
  if (mode !== 'menu') hud.update(match, renderer, dt, HUMAN);
  controls.draw(me.charge, me.charging && !demoPlayer, renderer.bottomReserve);
  updateNetInfo(dt);
  renderer.render();
}

/** 蓄力跨進「好球區」或「出界區」時給一下聲音＋震動（iPhone 沒震動，靠聲音） */
function chargeZoneTicks(charging: boolean, charge: number, serving: boolean, doubles: boolean): void {
  if (!charging) {
    lastZone = 0;
    return;
  }
  const z = chargeZones(serving, doubles);
  const zone = charge >= z.out ? 2 : charge >= z.net ? 1 : 0;
  if (zone > lastZone) {
    if (zone === 1) {
      sfx.tick(false);
      buzz(8);
    } else {
      sfx.tick(true);
      buzz(22);
    }
  }
  lastZone = zone;
}
function frame(now: number): void {
  tick(now);
  requestAnimationFrame(frame);
}

// ---------- 選單 ----------
function startGame(): void {
  unlockAudio();
  if (controls.isTouch || matchMedia('(pointer: coarse)').matches) {
    const el = document.documentElement;
    el.requestFullscreen?.().catch(() => {});
  }
  newMatch(false);
  again = () => startGame();
  acc = 0;
  setMode('play');
}

document.querySelectorAll<HTMLElement>('.seg').forEach((seg) => {
  const key = seg.dataset.key as keyof MatchSettings;
  const buttons = seg.querySelectorAll<HTMLButtonElement>('button');
  const sync = () => buttons.forEach((b) => b.classList.toggle('on', b.dataset.v === String(settings[key])));
  buttons.forEach((b) =>
    b.addEventListener('click', () => {
      const v = b.dataset.v!;
      (settings as unknown as Record<string, unknown>)[key] = v === 'true' ? true : v === 'false' ? false : /^\d+$/.test(v) ? Number(v) : v;
      saveSettings();
      sync();
      if (key === 'venue') applyVenue(settings.venue);
      applyAudioSettings();
    }),
  );
  sync();
});

/** 雙打（自己＋AI 夥伴 對 兩位 AI），難度／分數／局數／場地照設定 */
function startDoubles(): void {
  unlockAudio();
  if (controls.isTouch || matchMedia('(pointer: coarse)').matches) document.documentElement.requestFullscreen?.().catch(() => {});
  const { partner, opps } = newMatch(false, undefined, undefined, true);
  again = () => startDoubles();
  acc = 0;
  setMode('play');
  hud.intro('雙打', `夥伴：${partner!.name}\n對手：${opps.map((o) => o.name).join('、')}`);
}

$('startBtn').addEventListener('click', startGame);
$('doublesBtn').addEventListener('click', startDoubles);
$('againBtn').addEventListener('click', () => again());
$('restartBtn').addEventListener('click', () => again());
$('pauseBtn').addEventListener('click', () => mode === 'play' && setMode('paused'));
$('resumeBtn').addEventListener('click', () => setMode('play'));
const toMenu = () => {
  leaveOnline();
  newMatch(true);
  setMode('menu');
};
$('menuBtn').addEventListener('click', toMenu);
$('resultMenuBtn').addEventListener('click', toMenu);

window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape' || e.code === 'KeyP') {
    if (mode === 'play') setMode('paused');
    else if (mode === 'paused') setMode('play');
  }
});
document.addEventListener('visibilitychange', () => {
  controls.reset();
  if (document.hidden && mode === 'play') setMode('paused');
});
// 手機網址列收合也會觸發 resize，所以只有「轉向」時才清掉搖桿狀態
let wasPortrait = innerHeight > innerWidth;
window.addEventListener('resize', () => {
  renderer.resize();
  const portrait = innerHeight > innerWidth;
  if (portrait !== wasPortrait) controls.reset();
  wasPortrait = portrait;
});
for (const ev of ['pagehide', 'blur']) window.addEventListener(ev, () => controls.reset());
document.addEventListener('fullscreenchange', () => controls.reset());

function loadSettings(): MatchSettings {
  try {
    const raw = localStorage.getItem('badminton.settings');
    if (raw) {
      const s: MatchSettings = { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
      // v2：預設改成自動跑位＋自己划撲救（舊存檔一次性套用新預設）
      if ((s.settingsVersion ?? 1) < 2) {
        s.autoMove = true;
        s.autoDive = false;
      }
      // v3：預設改成點擊滑放
      if ((s.settingsVersion ?? 1) < 3) s.scheme = 'tap';
      s.settingsVersion = 3;
      return s;
    }
  } catch {
    /* 私密模式等情況讀不到就用預設 */
  }
  return { ...DEFAULT_SETTINGS, settingsVersion: 3 };
}
function saveSettings(): void {
  try {
    localStorage.setItem('badminton.settings', JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

applyAudioSettings();
buildCards();
newMatch(true);
setMode('menu');
requestAnimationFrame(frame);

// 開發用：在 console 可以存取目前比賽；advance(秒) 可在分頁隱藏時手動推進畫面
(window as unknown as { game: unknown }).game = {
  get match() {
    return match;
  },
  get tutorial() {
    return tutorial;
  },
  get bots() {
    return bots;
  },
  settings,
  renderer,
  controls,
  advance(secs: number) {
    for (let t = 0; t < secs; t += 1 / 60) tick(last + 1000 / 60);
  },
};

// ---------- 訓練關卡 ----------
function buildDrillList(): void {
  const best = loadBest();
  const box = $('drillList');
  box.innerHTML = '';
  for (const d of DRILLS) {
    const b = document.createElement('button');
    b.className = 'drill-item';
    const s = best[d.id] ?? 0;
    const stars = [1, 2, 3].map((i) => (i <= s ? '★' : '<i class="off">★</i>')).join('');
    b.innerHTML = `<div><b>${d.name}</b><span>${d.goal}</span><span>${settings.scheme === 'tap' ? d.howTap : d.how}</span></div><div class="stars">${stars}</div>`;
    b.addEventListener('click', () => startDrill(d));
    box.appendChild(b);
  }
}

function startDrill(d: Drill): void {
  endTutorial();
  unlockAudio();
  if (controls.isTouch || matchMedia('(pointer: coarse)').matches) document.documentElement.requestFullscreen?.().catch(() => {});
  const me = characterById(settings.character);
  match = new Match({ ...settings, practice: true, aiCharacter: 'allround', aiRacket: 'balance' }, (Date.now() ^ (Math.random() * 1e9)) >>> 0);
  bots = [];
  demoPlayer = null;
  setupAssist(false);
  controls.scheme = settings.scheme;
  renderer.setLooks([{ ...me, racketColor: racketById(settings.racket).color }, { shirt: 0x8a96a8, shorts: 0x2a2f38 }]); // 對面是灰色的發球機教練
  applyVenue(settings.venue);
  renderer.setTarget(d.target);
  hud.oppName = '發球機';
  hud.oppTag = 'AI';
  hud.drill = { name: d.name, rep: 0, reps: d.reps, ok: 0, goal: `${d.goal}｜${settings.scheme === 'tap' ? d.howTap : d.how}` };
  hitStop = 0;
  clearTimeout(resultTimer);
  drill = new DrillRunner(
    match,
    d,
    (r) => {
      hud.drill = { ...hud.drill!, rep: drill!.rep, ok: drill!.ok };
      hud.showRep(r.ok, r.msg);
      sfx.point(r.ok);
      buzz(r.ok ? 20 : [8, 40, 8]);
    },
    (ok, stars) => {
      saveBest(d.id, stars);
      $('resultTitle').textContent = `${'★'.repeat(stars)}${'☆'.repeat(3 - stars)}  ${d.name}`;
      $('resultScore').textContent = `成功 ${ok} / ${d.reps}${stars < 3 ? `（3 星需要 ${d.stars[2]} 球）` : '　完美通關！'}`;
      setMode('result');
    },
  );
  // 每一球更新進度
  const origTick = drill.tick.bind(drill);
  drill.tick = (dt: number) => {
    origTick(dt);
    if (drill && hud.drill) hud.drill.rep = drill.rep;
  };
  again = () => startDrill(d);
  acc = 0;
  setMode('play');
}

$('drillsBtn').addEventListener('click', () => {
  buildDrillList();
  $('menu').classList.remove('show');
  $('drills').classList.add('show');
});
$('drillsBackBtn').addEventListener('click', () => {
  $('drills').classList.remove('show');
  $('menu').classList.add('show');
});

// ---------- 場館巡迴賽 ----------
function buildTourList(): void {
  const prog = loadTour();
  const box = $('tourList');
  box.innerHTML = '';
  TOUR.forEach((stop, si) => {
    const open = stopUnlocked(prog, si);
    const done = prog[stop.id] ?? 0;
    const div = document.createElement('div');
    div.className = 'tour-stop' + (open ? '' : ' locked');
    div.innerHTML = `<h3>${stop.name}${done >= stop.opponents.length ? ' 👑' : ''}${open ? '' : ' 🔒'}</h3>`;
    stop.opponents.forEach((o, oi) => {
      const c = characterById(o.character);
      const b = document.createElement('button');
      b.className = 'tour-opp' + (o.boss ? ' boss' : '');
      b.disabled = !open || oi > done;
      const state = oi < done ? '✔' : oi === done && open ? '▶' : '🔒';
      b.innerHTML = `<div class="swatch" style="background:#${c.shirt.toString(16).padStart(6, '0')}"></div><div><b>${o.boss ? '👑 ' : ''}${o.title}</b><span>${c.name}・${STYLES[o.style].name}｜${o.points} 分｜${o.intro}</span></div><div class="state">${state}</div>`;
      b.addEventListener('click', () => startTour(si, oi));
      div.appendChild(b);
    });
    box.appendChild(div);
  });
}

function startTour(stopIdx: number, oppIdx: number): void {
  unlockAudio();
  if (controls.isTouch || matchMedia('(pointer: coarse)').matches) document.documentElement.requestFullscreen?.().catch(() => {});
  const stop = TOUR[stopIdx];
  const opp = stop.opponents[oppIdx];
  newMatch(false, opp, stop.venue);
  tourCtx = { stop: stopIdx, idx: oppIdx };
  again = () => startTour(stopIdx, oppIdx);
  $('nextBtn').onclick = null;
  acc = 0;
  setMode('play');
  hud.intro(`${opp.boss ? '👑 ' : ''}${hud.oppName}`, opp.intro);
}

$('tourBtn').addEventListener('click', () => {
  buildTourList();
  $('menu').classList.remove('show');
  $('tour').classList.add('show');
});
$('tourBackBtn').addEventListener('click', () => {
  $('tour').classList.remove('show');
  $('menu').classList.add('show');
});

// ---------- 音效 ----------

/** 換場地：畫面＋環境音一起換 */
/** 自己這邊的輔助：自動跑位（＋自動魚躍）；手動跑位時擊球範圍大一點 */
function setupAssist(demo: boolean): void {
  assist = !demo && settings.autoMove ? new AIController(match, 0, 'hard', true) : null;
  if (assist) assist.allowDive = settings.autoDive;
  controls.autoMove = !!assist;
  controls.autoDive = settings.autoDive;
  match.players[HUMAN].reachMul = !demo && !settings.autoMove ? GAME.manualReachMul : 1;
}

function applyVenue(v: Venue): void {
  renderer.setVenue(v);
  ambience.setVenue(v);
}

function applyAudioSettings(): void {
  setSfxOn(settings.sound);
  setMusicOn(settings.music);
  setSpeechOn(settings.umpire);
}

// 第一次碰螢幕就解鎖音訊（瀏覽器規定要使用者操作後才能出聲），選單音樂也從這時開始
window.addEventListener('pointerdown', () => unlockAudio());
window.addEventListener('keydown', () => unlockAudio());
// 選單按鈕的點擊聲
document.addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('.overlay button')) sfx.click();
});

/** 球鞋吱吱聲：急停或急轉時（索引 = 球員編號，雙打 4 人） */
const lastVel: { x: number; z: number; t: number }[] = [0, 1, 2, 3].map(() => ({ x: 0, z: 0, t: 0 }));
function shoeSqueaks(): void {
  match.players.forEach((p, i) => {
    const lv = lastVel[i];
    const sp0 = Math.hypot(lv.x, lv.z);
    const sp1 = Math.hypot(p.vel.x, p.vel.z);
    const braking = sp0 > 2.6 && (sp0 - sp1) / PHYS.dt > 22;
    const turning = sp0 > 2 && sp1 > 1 && (lv.x * p.vel.x + lv.z * p.vel.z) / (sp0 * sp1) < 0.2;
    if ((braking || turning) && match.time - lv.t > 0.35 && !p.airborne) {
      sfx.squeak(i === HUMAN ? 1 : 0.55);
      lv.t = match.time;
    }
    lv.x = p.vel.x;
    lv.z = p.vel.z;
  });
}

/** 得分後：觀眾掌聲（回合越長越熱烈）＋裁判報分 */
function onPointAudio(winner: TeamId, reason: string): void {
  const rally = match.rallyHits;
  const big = reason === '落地得分' && rally >= 8;
  sfx.applause(Math.min(1, 0.25 + rally / 16 + (winner === match.teamOf(HUMAN) ? 0.15 : 0) + (big ? 0.2 : 0)));
  if (match.settings.practice) return;
  const s = match.score;
  const srv = match.teamOf(match.server); // 得分的那一隊下一球發球，先報發球方的分數（比分以隊伍為索引）
  const a = s[srv];
  const b = s[srv === 0 ? 1 : 0];
  const target = match.settings.points;
  const cap = target === 21 ? 30 : target === 15 ? 21 : 15;
  const gameWon = (a >= target && a - b >= 2) || a >= cap;
  let extra = '';
  if (match.phase === 'matchOver') extra = '，比賽結束';
  else if (gameWon) extra = '，本局結束';
  else if ((a >= target - 1 && a > b) || a === cap - 1) extra = match.games[srv] + 1 > match.settings.games / 2 ? '，賽點' : '，局點';
  const text = a === 0 && b === 0 ? '新的一局，零比零' : `${a} 比 ${b}${extra}`;
  window.setTimeout(() => callScore(text), 750);
}

// ---------- 線上對戰（好友房） ----------
function myHello(): Hello {
  return {
    name: characterById(settings.character).name,
    character: settings.character,
    racket: settings.racket,
    points: settings.points,
    games: settings.games,
    venue: settings.venue,
  };
}

function showLobby(code: string | null): void {
  $('onlineIdle').style.display = code ? 'none' : '';
  $('onlineRoom').style.display = code ? '' : 'none';
  $('roomCode').textContent = code ?? '';
  if (!code) {
    $('roomStatus').textContent = '';
    $('roomStatus').className = 'room-status';
  }
}

function openOnline(): void {
  $('menu').classList.remove('show');
  $('online').classList.add('show');
  showLobby(online ? online.room.code : null);
}

function leaveOnline(): void {
  online?.room.close();
  online = null;
  $('againBtn').style.display = '';
  $('netInfo').textContent = '';
}

function joinRoom(code: string): void {
  leaveOnline();
  unlockAudio();
  const room = new RoomClient(code, myHello);
  online = { room, sync: null };
  room.onStatus = (text, kind) => {
    const el = $('roomStatus');
    el.textContent = text;
    el.className = `room-status ${kind}`;
    if (mode === 'result' && online?.room === room) $('resultScore').textContent = text;
  };
  room.onStart = (start, peer, host) => startOnlineMatch(start, peer, host);
  room.onGame = (msg) => online?.sync?.receive(msg);
  room.onPeerLeft = () => {
    if (online?.room !== room || !online.sync) return;
    // 比賽中對方離開：結束這場
    online.sync = null;
    clearTimeout(resultTimer);
    $('resultTitle').textContent = '對手離開了';
    $('resultScore').textContent = `比分 ${match.score[0]} : ${match.score[1]}`;
    $('againBtn').style.display = 'none';
    setMode('result');
  };
  showLobby(code);
  room.connect();
}

function startOnlineMatch(start: StartInfo, peer: Hello, host: boolean): void {
  if (!online) return;
  endTutorial();
  unlockAudio();
  if (controls.isTouch || matchMedia('(pointer: coarse)').matches) document.documentElement.requestFullscreen?.().catch(() => {});
  const me = characterById(settings.character);
  const opp = characterById(peer.character);
  const s: MatchSettings = { ...settings, points: start.points, games: start.games, venue: start.venue, aiCharacter: opp.id, aiRacket: peer.racket };
  match = new Match(s, (Date.now() ^ (Math.random() * 1e9)) >>> 0);
  match.remote = 1; // 對方 = 1 號（畫面上方），自己永遠在下方
  match.server = host ? 0 : 1; // 房主先發
  match.setupServe();
  match.drainEvents();
  bots = [];
  demoPlayer = null;
  tourCtx = null;
  drill = null;
  hud.drill = null;
  setupAssist(false);
  controls.scheme = settings.scheme;
  renderer.setLooks([
    { ...me, racketColor: racketById(settings.racket).color },
    // 兩邊選同一位球員：對手換成紅色球衣，才分得出來
    { ...opp, ...(opp.id === me.id ? { shirt: 0xe0483a, shorts: 0x3a1b1b } : {}), racketColor: racketById(peer.racket).color },
  ]);
  applyVenue(start.venue);
  renderer.setTarget(null);
  hud.oppName = peer.name;
  hud.oppTag = '線上';
  clearTimeout(resultTimer);
  hitStop = 0;
  const room = online.room;
  online.sync = new OnlineSync(match, (msg) => room.send(msg));
  again = () => room.requestRematch();
  $('againBtn').style.display = '';
  acc = 0;
  setMode('play');
  hud.intro(`線上對戰：${peer.name}`, host ? '你先發球' : '對手先發球');
}

/** 右下角顯示連線延遲 */
function updateNetInfo(dt: number): void {
  const sync = online?.sync;
  if (!sync || mode === 'menu') {
    if ($('netInfo').textContent) $('netInfo').textContent = '';
    return;
  }
  netInfoT -= dt;
  if (netInfoT > 0) return;
  netInfoT = 0.5;
  $('netInfo').textContent = sync.rttMs ? `連線延遲 ${Math.round(sync.rttMs)} ms` : '';
}

$('onlineBtn').addEventListener('click', openOnline);
$('settingsBtn').addEventListener('click', () => {
  $('menu').classList.remove('show');
  $('settings').classList.add('show');
});
$('settingsDoneBtn').addEventListener('click', () => {
  $('settings').classList.remove('show');
  $('menu').classList.add('show');
});
$('onlineBackBtn').addEventListener('click', () => {
  leaveOnline();
  $('online').classList.remove('show');
  $('menu').classList.add('show');
});
$('createRoomBtn').addEventListener('click', () => joinRoom(newRoomCode()));
$('joinRoomBtn').addEventListener('click', () => {
  const code = normalizeCode(($('roomCodeInput') as HTMLInputElement).value);
  if (code.length < 4) {
    $('roomStatus').textContent = '房號是 4 個字';
    $('roomStatus').className = 'room-status error';
    return;
  }
  joinRoom(code);
});
$('roomCodeInput').addEventListener('keydown', (e) => {
  if ((e as KeyboardEvent).key === 'Enter') $('joinRoomBtn').click();
});
$('shareRoomBtn').addEventListener('click', async () => {
  if (!online) return;
  const code = online.room.code;
  const url = `${location.origin}${location.pathname}?room=${code}`;
  if (navigator.share) {
    try {
      await navigator.share({ title: '羽球對決 2.5D', text: `來打羽球！房號 ${code}`, url });
    } catch {
      /* 取消分享 */
    }
    return;
  }
  try {
    await navigator.clipboard.writeText(url);
    $('roomStatus').textContent = '連結已複製，貼給朋友就能直接加入';
    $('roomStatus').className = 'room-status ok';
  } catch {
    window.prompt('複製這個連結給朋友', url);
  }
});

// 從分享連結進來（?room=房號）：直接進房
{
  const params = new URLSearchParams(location.search);
  const code = params.get('room');
  if (code) {
    params.delete('room');
    const rest = params.toString();
    history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : ''));
    openOnline();
    joinRoom(normalizeCode(code));
  }
}

// ---------- 新手教學 ----------
const tutUI: TutUI = {
  card(title, html, button, progress) {
    $('tutCard').style.display = 'block';
    $('tutTitle').textContent = title;
    $('tutProg').textContent = progress;
    $('tutText').innerHTML = html;
    $('tutBtn').style.display = button ? '' : 'none';
    $('tutBtn').textContent = button ?? '';
    $('tutBtn2').style.display = 'none';
    if (hud.drill && tutorial) hud.drill = { ...hud.drill, rep: tutorial.idx + 1 };
  },
  prompt(text) {
    $('tutPrompt').textContent = text ?? '';
    $('tutPrompt').classList.toggle('show', !!text);
  },
  highlight(h) {
    controls.highlight(h);
  },
  target(zone) {
    renderer.setTarget(zone);
  },
  toast(ok, msg) {
    hud.showRep(ok, msg);
    sfx.point(ok);
    buzz(ok ? 20 : [8, 40, 8]);
    if (ok && hud.drill) hud.drill = { ...hud.drill, ok: hud.drill.ok + 1 };
  },
  finish() {
    $('tutCard').style.display = 'block';
    $('tutTitle').textContent = '教學完成！🎉';
    $('tutProg').textContent = '';
    $('tutText').innerHTML = '基本操作都學會了。可以開始比賽，或到「訓練關卡」把每種球練熟。';
    $('tutBtn').style.display = '';
    $('tutBtn').textContent = '開始比賽';
    $('tutBtn2').style.display = '';
    $('tutBtn2').textContent = '回主選單';
    try {
      localStorage.setItem('badminton.tutorialDone', '1');
    } catch {
      /* ignore */
    }
  },
};

/** 離開教學（開始其他模式時呼叫） */
function endTutorial(): void {
  tutorial = null;
  tutInput = null;
  $('tutCard').style.display = 'none';
  $('tutPrompt').classList.remove('show'); // 不能用 tutUI（啟動時還沒宣告）
  controls.highlight(null);
}

function startTutorial(): void {
  unlockAudio();
  if (controls.isTouch || matchMedia('(pointer: coarse)').matches) document.documentElement.requestFullscreen?.().catch(() => {});
  leaveOnline();
  endTutorial();
  const me = characterById(settings.character);
  match = new Match({ ...settings, practice: true, aiCharacter: 'allround', aiRacket: 'balance' }, (Date.now() ^ (Math.random() * 1e9)) >>> 0);
  bots = [];
  demoPlayer = null;
  drill = null;
  tourCtx = null;
  setupAssist(false);
  // 教學一律有跑位輔助（每一步自己決定用不用），撲救一定自己划
  assist = new AIController(match, HUMAN, 'hard', true);
  assist.allowDive = false;
  controls.autoDive = false;
  controls.scheme = settings.scheme;
  renderer.setLooks([{ ...me, racketColor: racketById(settings.racket).color }, { shirt: 0x8a96a8, shorts: 0x2a2f38 }]);
  applyVenue(settings.venue);
  renderer.setTarget(null);
  hud.oppName = '教練';
  hud.oppTag = 'AI';
  const steps = buildTutorial(settings.scheme, settings.autoMove);
  hud.drill = { name: '新手教學', rep: 1, reps: steps.length, ok: 0, goal: '' };
  hitStop = 0;
  clearTimeout(resultTimer);
  tutorial = new TutorialRunner(match, steps, tutUI, settings.scheme);
  again = () => startTutorial();
  acc = 0;
  setMode('play');
}

$('tutorialBtn').addEventListener('click', startTutorial);
$('tutBtn').addEventListener('click', () => {
  if (!tutorial) return;
  if (tutorial.done) startGame();
  else tutorial.button();
});
$('tutBtn2').addEventListener('click', () => toMenu());

// ---------- 新版提示 ----------
// GitHub Pages 的 index.html 會被瀏覽器快取 10 分鐘：打開或切回來時檢查有沒有新版，有就提示更新
let lastUpdateCheck = 0;
async function checkUpdate(): Promise<void> {
  if (import.meta.env.DEV || Date.now() - lastUpdateCheck < 60_000) return;
  lastUpdateCheck = Date.now();
  try {
    const html = await (await fetch(`${import.meta.env.BASE_URL}?v=${Date.now()}`, { cache: 'no-store' })).text();
    const latest = html.match(/assets\/index-[\w-]+\.js/)?.[0];
    const current = document.querySelector<HTMLScriptElement>('script[type="module"][src*="assets/index-"]')?.src;
    if (latest && current && !current.endsWith(latest)) $('updateBar').classList.add('show');
  } catch {
    /* 離線就算了 */
  }
}
$('updateBar').addEventListener('click', () => location.reload());
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) void checkUpdate();
});
void checkUpdate();

// ---------- 加到主畫面（變成 App） ----------
// iPhone：Safari 的「分享 → 加入主畫面」；Android Chrome：會給安裝提示，按「安裝成 App」就好
{
  const tip = document.createElement('div');
  tip.id = 'a2hsTip';
  document.body.appendChild(tip);
  const standalone = matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches || (navigator as unknown as { standalone?: boolean }).standalone === true;
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  let dismissed = false;
  try {
    dismissed = localStorage.getItem('badminton.a2hs') === '1';
  } catch {
    /* ignore */
  }
  const close = () => {
    tip.classList.remove('show');
    try {
      localStorage.setItem('badminton.a2hs', '1');
    } catch {
      /* ignore */
    }
  };
  const show = (html: string) => {
    if (standalone || dismissed) return;
    tip.innerHTML = `${html}<button class="x" aria-label="關閉">×</button>`;
    tip.querySelector('.x')!.addEventListener('click', close);
    tip.classList.add('show');
  };
  if (ios) show('📲 把遊戲加到主畫面：點下方「分享」或「⋯」→「<b>加入主畫面</b>」，就能全螢幕、像 App 一樣玩');
  // Android Chrome：攔下安裝提示，改成自己的按鈕
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    const ev = e as Event & { prompt: () => Promise<void> };
    show('📲 可以把遊戲安裝成 App（全螢幕、主畫面有圖示）<button class="install">安裝成 App</button>');
    tip.querySelector('.install')?.addEventListener('click', () => {
      void ev.prompt();
      close();
    });
  });
}
