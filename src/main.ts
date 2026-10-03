import './style.css';
import { AIController, STYLES } from './ai/ai';
import { ambience, callScore, music, setMusicOn, setSfxOn, setSpeechOn, sfx, unlockAudio } from './audio';
import { DEFAULT_SETTINGS, GAME, PHYS, type MatchSettings, type Venue } from './config';
import { LocalControls } from './input/controls';
import { GameRenderer } from './render/scene';
import { idleInput, Match, type MatchEvent } from './sim/match';
import { DRILLS, DrillRunner, loadBest, saveBest, type Drill } from './modes/drills';
import { loadTour, saveTourWin, stopUnlocked, TOUR, type TourOpponent } from './modes/tour';
import { buildKit, CHARACTERS, characterById, racketById, RACKETS, type Kit } from './sim/kits';
import { Hud } from './ui/hud';
import { chargeZones } from './sim/shots';

const HUMAN = 0 as const;
const $ = (id: string) => document.getElementById(id)!;

type Mode = 'menu' | 'play' | 'paused' | 'result';

const settings = loadSettings();
const renderer = new GameRenderer($('app'));
const controls = new LocalControls(renderer.renderer.domElement, $('touch'));
const hud = new Hud($('hud'));

let mode: Mode = 'menu';
let match!: Match;
let opponent: AIController | null = null; // 練習模式沒有對手 AI
let drill: DrillRunner | null = null; // 目前的訓練關卡
let tourCtx: { stop: number; idx: number } | null = null; // 目前的巡迴賽場次
let again: () => void = () => startGame(); // 「再來一次」要重開什麼
let demoPlayer: AIController | null = null; // 主選單背景的 AI 示範對打
let resultTimer: number | undefined;

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

function newMatch(demo: boolean, tourOpp?: TourOpponent, venue?: Venue): void {
  // 對手每場隨機換一位球員、一支球拍（不跟自己同一位）
  const me = demo ? pick(CHARACTERS) : characterById(settings.character);
  const opp = tourOpp ? characterById(tourOpp.character) : pick(CHARACTERS.filter((c) => c.id !== me.id));
  const s: MatchSettings = { ...settings, aiCharacter: opp.id, aiRacket: tourOpp ? tourOpp.racket : pick(RACKETS).id };
  if (tourOpp) {
    s.points = tourOpp.points;
    s.games = 1;
  }
  if (demo) {
    s.character = me.id;
    s.racket = pick(RACKETS).id;
  }
  match = new Match(s, (Date.now() ^ (Math.random() * 1e9)) >>> 0);
  opponent = tourOpp
    ? new AIController(match, 1, tourOpp.level, false, STYLES[tourOpp.style])
    : new AIController(match, 1, demo ? 'hard' : settings.difficulty);
  tourCtx = null;
  demoPlayer = demo ? new AIController(match, 0, 'hard') : null;
  assist = !demo && settings.autoMove ? new AIController(match, 0, 'hard', true) : null;
  controls.autoMove = !!assist;
  controls.scheme = settings.scheme;
  renderer.setLooks([
    { ...me, racketColor: racketById(s.racket).color },
    { ...opp, racketColor: racketById(s.aiRacket!).color },
  ]);
  applyVenue(venue ?? settings.venue);
  hud.oppName = tourOpp ? tourOpp.title : opp.name;
  hud.drill = null;
  drill = null;
  renderer.setTarget(null);
  clearTimeout(resultTimer);
  hitStop = 0;
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
      if (live) hitStop = e.serve ? 0.03 : mine ? (e.jump ? 0.11 : smash ? 0.09 : e.grade === '完美' ? 0.07 : 0.05) : smash ? 0.06 : 0.03;
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
    case 'net':
      if (live) sfx.net();
      break;
    case 'land':
      if (live) sfx.land();
      break;
    case 'point':
      if (live) {
        sfx.point(e.winner === HUMAN);
        onPointAudio(e.winner, e.reason);
      }
      break;
    case 'match':
      if (live) {
        const ctx = tourCtx;
        resultTimer = window.setTimeout(() => {
          const win = e.winner === HUMAN;
          const sc = match.settings.games > 1 ? `局數 ${match.games[0]} : ${match.games[1]}` : `比分 ${match.score[0]} : ${match.score[1]}`;
          $('resultTitle').textContent = win ? '🏆 你贏了！' : `${hud.oppName} 獲勝`;
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
}

// ---------- 主迴圈：固定步長模擬，畫面照幀率跑 ----------
let last = performance.now();
let acc = 0;
function tick(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (drill && mode === 'play' && hitStop <= 0) drill.tick(dt);
  if (hitStop > 0) hitStop -= dt;
  else if (mode === 'play' || mode === 'menu') {
    acc += dt * GAME.simSpeed;
    let n = 0;
    while (acc >= PHYS.dt && n++ < 40 && hitStop <= 0) {
      const mine = demoPlayer ? demoPlayer.input() : controls.poll();
      if (assist) {
        // 簡單模式：移動交給自動跑位，蓄力／出拍還是玩家自己
        const a = assist.input();
        mine.moveX = a.moveX;
        mine.moveY = a.moveY;
      }
      const prevSwing = match.players[HUMAN].swing;
      match.step([mine, opponent ? opponent.input() : idleInput()]);
      // 真的開始揮拍才出聲（只點不滑但球還沒來 = 連按兩下的第一下，不算）
      const sw = match.players[HUMAN].swing;
      if (!demoPlayer && sw && sw !== prevSwing) {
        sfx.whoosh();
        buzz(8);
      }
      if (!demoPlayer) shoeSqueaks();
      acc -= PHYS.dt;
      for (const e of match.drainEvents()) handleEvent(e);
    }
    if (hitStop > 0) acc = 0;
  }
  const me = match.players[HUMAN];
  if (!demoPlayer) chargeZoneTicks(me.charging, me.charge, match.phase === 'serve' && match.server === HUMAN);
  renderer.update(match, mode === 'paused' || mode === 'result' ? 0 : dt, settings.landingHint && !demoPlayer, HUMAN);
  if (mode !== 'menu') hud.update(match, renderer, dt, HUMAN);
  controls.draw(me.charge, me.charging && !demoPlayer, renderer.bottomReserve);
  renderer.render();
}

/** 蓄力跨進「好球區」或「出界區」時給一下聲音＋震動（iPhone 沒震動，靠聲音） */
function chargeZoneTicks(charging: boolean, charge: number, serving: boolean): void {
  if (!charging) {
    lastZone = 0;
    return;
  }
  const z = chargeZones(serving);
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

$('startBtn').addEventListener('click', startGame);
$('againBtn').addEventListener('click', () => again());
$('restartBtn').addEventListener('click', () => again());
$('pauseBtn').addEventListener('click', () => mode === 'play' && setMode('paused'));
$('resumeBtn').addEventListener('click', () => setMode('play'));
const toMenu = () => {
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
    if (raw) return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    /* 私密模式等情況讀不到就用預設 */
  }
  return { ...DEFAULT_SETTINGS };
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
  unlockAudio();
  if (controls.isTouch || matchMedia('(pointer: coarse)').matches) document.documentElement.requestFullscreen?.().catch(() => {});
  const me = characterById(settings.character);
  match = new Match({ ...settings, practice: true, aiCharacter: 'allround', aiRacket: 'balance' }, (Date.now() ^ (Math.random() * 1e9)) >>> 0);
  opponent = null;
  demoPlayer = null;
  assist = settings.autoMove ? new AIController(match, 0, 'hard', true) : null;
  controls.autoMove = !!assist;
  controls.scheme = settings.scheme;
  renderer.setLooks([{ ...me, racketColor: racketById(settings.racket).color }, { shirt: 0x8a96a8, shorts: 0x2a2f38 }]); // 對面是灰色的發球機教練
  applyVenue(settings.venue);
  renderer.setTarget(d.target);
  hud.oppName = '發球機';
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

/** 球鞋吱吱聲：急停或急轉時 */
const lastVel: { x: number; z: number; t: number }[] = [
  { x: 0, z: 0, t: 0 },
  { x: 0, z: 0, t: 0 },
];
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
function onPointAudio(winner: 0 | 1, reason: string): void {
  const rally = match.rallyHits;
  const big = reason === '落地得分' && rally >= 8;
  sfx.applause(Math.min(1, 0.25 + rally / 16 + (winner === HUMAN ? 0.15 : 0) + (big ? 0.2 : 0)));
  if (match.settings.practice) return;
  const s = match.score;
  const srv = match.server; // 得分的人下一球發球，先報發球方的分數
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
