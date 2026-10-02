import './style.css';
import { AIController } from './ai/ai';
import { sfx, unlockAudio } from './audio';
import { DEFAULT_SETTINGS, GAME, PHYS, type MatchSettings } from './config';
import { LocalControls } from './input/controls';
import { GameRenderer } from './render/scene';
import { idleInput, Match, type MatchEvent } from './sim/match';
import { DRILLS, DrillRunner, loadBest, saveBest, type Drill } from './modes/drills';
import { buildKit, CHARACTERS, characterById, racketById, RACKETS } from './sim/kits';
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

function newMatch(demo: boolean): void {
  // 對手每場隨機換一位球員、一支球拍（不跟自己同一位）
  const me = demo ? pick(CHARACTERS) : characterById(settings.character);
  const opp = pick(CHARACTERS.filter((c) => c.id !== me.id));
  const s: MatchSettings = { ...settings, aiCharacter: opp.id, aiRacket: pick(RACKETS).id };
  if (demo) {
    s.character = me.id;
    s.racket = pick(RACKETS).id;
  }
  match = new Match(s, (Date.now() ^ (Math.random() * 1e9)) >>> 0);
  opponent = new AIController(match, 1, demo ? 'hard' : settings.difficulty);
  demoPlayer = demo ? new AIController(match, 0, 'hard') : null;
  assist = !demo && settings.autoMove ? new AIController(match, 0, 'hard', true) : null;
  controls.autoMove = !!assist;
  renderer.setLooks([
    { ...me, racketColor: racketById(s.racket).color },
    { ...opp, racketColor: racketById(s.aiRacket!).color },
  ]);
  renderer.setVenue(settings.venue);
  hud.oppName = opp.name;
  hud.drill = null;
  drill = null;
  renderer.setTarget(null);
  clearTimeout(resultTimer);
  hitStop = 0;
}

/** 選球員／球拍的卡片 */
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
  // 組合後的實際加成
  const k = buildKit(settings.character, settings.racket);
  const chips: string[] = [];
  const pct = (label: string, v: number) => {
    const d = Math.round((v - 1) * 100);
    if (d !== 0) chips.push(`<i class="${d > 0 ? 'up' : 'down'}">${label} ${d > 0 ? '+' : ''}${d}%</i>`);
  };
  pct('殺球', k.speed.smash);
  pct('切球／放網', k.speed.drop);
  pct('推球／平抽', k.speed.push);
  pct('高遠／挑球', k.speed.clear);
  pct('跑速', k.move);
  pct('起步', k.accel);
  pct('揮拍判定', k.window);
  if (k.accuracy !== 1) chips.push(`<i class="up">落點誤差 ${Math.round((k.accuracy - 1) * 100)}%</i>`);
  $('kitSummary').innerHTML = chips.length ? chips.join('') : '<i>標準數值</i>';
}

function setMode(m: Mode): void {
  mode = m;
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
      if (live) sfx.point(e.winner === HUMAN);
      break;
    case 'match':
      if (live) {
        resultTimer = window.setTimeout(() => {
          const win = e.winner === HUMAN;
          $('resultTitle').textContent = win ? '🏆 你贏了！' : 'AI 獲勝';
          $('resultScore').textContent =
            settings.games > 1 ? `局數 ${match.games[0]} : ${match.games[1]}` : `比分 ${match.score[0]} : ${match.score[1]}`;
          setMode('result');
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
      if (!demoPlayer && mine.flick) {
        sfx.whoosh();
        buzz(8);
      }
      match.step([mine, opponent ? opponent.input() : idleInput()]);
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
      if (key === 'venue') renderer.setVenue(settings.venue);
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
    b.innerHTML = `<div><b>${d.name}</b><span>${d.goal}</span><span>${d.how}</span></div><div class="stars">${stars}</div>`;
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
  renderer.setLooks([{ ...me, racketColor: racketById(settings.racket).color }, { shirt: 0x8a96a8, shorts: 0x2a2f38 }]); // 對面是灰色的發球機教練
  renderer.setVenue(settings.venue);
  renderer.setTarget(d.target);
  hud.oppName = '發球機';
  hud.drill = { name: d.name, rep: 0, reps: d.reps, ok: 0, goal: `${d.goal}｜${d.how}` };
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
