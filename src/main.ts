import './style.css';
import { AIController } from './ai/ai';
import { sfx, unlockAudio } from './audio';
import { DEFAULT_SETTINGS, GAME, PHYS, type MatchSettings } from './config';
import { LocalControls } from './input/controls';
import { GameRenderer } from './render/scene';
import { Match, type MatchEvent } from './sim/match';
import { Hud } from './ui/hud';

const HUMAN = 0 as const;
const $ = (id: string) => document.getElementById(id)!;

type Mode = 'menu' | 'play' | 'paused' | 'result';

const settings = loadSettings();
const renderer = new GameRenderer($('app'));
const controls = new LocalControls(renderer.renderer.domElement, $('touch'));
const hud = new Hud($('hud'));

let mode: Mode = 'menu';
let match!: Match;
let opponent!: AIController;
let demoPlayer: AIController | null = null; // 主選單背景的 AI 示範對打
let resultTimer: number | undefined;

function newMatch(demo: boolean): void {
  match = new Match({ ...settings }, (Date.now() ^ (Math.random() * 1e9)) >>> 0);
  opponent = new AIController(match, 1, demo ? 'hard' : settings.difficulty);
  demoPlayer = demo ? new AIController(match, 0, 'hard') : null;
  clearTimeout(resultTimer);
}

function setMode(m: Mode): void {
  mode = m;
  controls.enabled = m === 'play';
  document.body.classList.toggle('in-menu', m === 'menu');
  $('menu').classList.toggle('show', m === 'menu');
  $('pause').classList.toggle('show', m === 'paused');
  $('result').classList.toggle('show', m === 'result');
  $('hud').style.visibility = m === 'menu' ? 'hidden' : 'visible';
}

function handleEvent(e: MatchEvent): void {
  const live = !demoPlayer;
  switch (e.type) {
    case 'hit': {
      const smash = e.family === 'down' && e.speedKmh > 120;
      if (live) smash ? sfx.smash() : sfx.hit(e.charge);
      renderer.burst(e.pos, smash);
      break;
    }
    case 'whiff':
      if (live) sfx.whiff();
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
}

// ---------- 主迴圈：固定步長模擬，畫面照幀率跑 ----------
let last = performance.now();
let acc = 0;
function tick(now: number): void {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (mode === 'play' || mode === 'menu') {
    acc += dt * GAME.simSpeed;
    let n = 0;
    while (acc >= PHYS.dt && n++ < 40) {
      const mine = demoPlayer ? demoPlayer.input() : controls.poll();
      match.step([mine, opponent.input()]);
      acc -= PHYS.dt;
      for (const e of match.drainEvents()) handleEvent(e);
    }
  }
  renderer.update(match, mode === 'paused' || mode === 'result' ? 0 : dt, settings.landingHint && !demoPlayer, HUMAN);
  if (mode !== 'menu') hud.update(match, renderer, dt, HUMAN);
  const me = match.players[HUMAN];
  controls.draw(me.charge, me.charging && !demoPlayer, renderer.bottomReserve);
  renderer.render();
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
    }),
  );
  sync();
});

$('startBtn').addEventListener('click', startGame);
$('againBtn').addEventListener('click', startGame);
$('restartBtn').addEventListener('click', startGame);
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
  if (document.hidden && mode === 'play') setMode('paused');
});
window.addEventListener('resize', () => renderer.resize());

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
  advance(secs: number) {
    for (let t = 0; t < secs; t += 1 / 60) tick(last + 1000 / 60);
  },
};
