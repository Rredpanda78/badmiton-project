import './style.css';
import { AIController, STYLES } from './ai/ai';
import { ambience, callScore, music, setMusicOn, setSfxOn, setSpeechOn, sfx, unlockAudio } from './audio';
import { DEFAULT_SETTINGS, GAME, PHYS, type Difficulty, type MatchSettings, type MoveMode, type Venue } from './config';
import { colorById, colorDist, hexCss, pickOppColor, shade, SHIRT_COLORS, tooClose } from './ui/colors';
import { playerThumb, racketThumb } from './render/thumbs';
import { LocalControls } from './input/controls';
import { GameRenderer, type Look } from './render/scene';
import { idleInput, Match, type MatchEvent, type TeamId } from './sim/match';
import { DRILLS, DrillRunner, loadBest, saveBest, type Drill } from './modes/drills';
import { loadTour, saveTourWin, stopUnlocked, TOUR, type TourOpponent } from './modes/tour';
import { buildKit, CHARACTERS, characterById, racketById, RACKETS, type Character, type Kit } from './sim/kits';
import { Hud } from './ui/hud';
import { openGuide } from './ui/guide';
import { chargeZones } from './sim/shots';
import { v3 } from './sim/physics';
import { OnlineSync } from './net/sync';
import { buildTutorial, TutorialRunner, type TutUI } from './modes/tutorial';
import type { PlayerId, PlayerInput } from './sim/match';
import { adoptClientId, clearRejoin, loadRejoin, LOBBY_URL, newRoomCode, normalizeCode, peekClientId, RoomClient, saveRejoin, type Hello, type RejoinRecord, type StartInfo } from './net/room';
import { PROTOCOL, type LobbyRoom, type NetMsg, type PeerMsg, type QuadCfg, type QuadHuman } from './net/protocol';
import { isAi, isHuman, QuadLobby, seatTeam, TEAM_NAMES } from './net/quad';
import { QuadSession } from './net/session4';
import type { QuadSync } from './net/sync4';
import { snapDuo, snapQuad, Spectator, specPlayer, type SpecView } from './net/spectate';
import { isWinner, ReplayPlayer, ReplayRecorder } from './render/replay';

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
/**
 * 線上對戰：房間連線＋比賽同步（還在大廳時 sync = null）
 * - waiting：斷線等待中（比賽暫停），wait = 等待面板的內容（AI 接手／繼續等待／離開）
 * - 2 人房：aiTakeover = 對手不在，AI 在本機接手（變成對 AI 的比賽，房間還開著）；
 *   pendingReturn = 對手回來了，這一分打完就換回來；start = 這場的設定（對手重新整理網頁回來時請他重建）
 * - quad：4 人房（名單、這場比賽、誰斷線）
 * - spectator：自己是觀眾（src/net/spectate.ts；比賽建好後 sync = spectator）；spectators = 房間裡的觀眾人數（玩家看）
 * - pub：自己建的房間有沒有公開到遊戲大廳
 */
let online: {
  room: RoomClient;
  sync: OnlineSync | QuadSync | Spectator | null;
  waiting: boolean;
  wait: WaitState | null;
  aiTakeover: boolean;
  pendingReturn: boolean;
  start: StartInfo | null;
  quad: QuadState | null;
  spectator: Spectator | null;
  spectators: number;
  pub: boolean;
} | null = null;
/** 等待面板：title、倒數到什麼時候（null = 不限時間）、self = 自己的連線出問題、gaveUp = 自動重連放棄了 */
interface WaitState {
  title: string;
  until: number | null;
  self: boolean;
  gaveUp?: boolean;
  text?: string;
}
/** 4 人房：名單（房主為準）、這支手機上的比賽、比賽中斷線的人、房主：回來的人（下一分還他座位） */
interface QuadState {
  lobby: QuadLobby | null;
  sess: QuadSession | null;
  missing: Set<string>;
  pending: QuadHuman[];
}
let netInfoT = 0;
/** 新手教學（暫停時玩家的那一下輸入先存著，下一個 tick 用） */
let tutorial: TutorialRunner | null = null;
let tutInput: PlayerInput | null = null;
/** 得分回放：錄影（每個 tick）、等著播的（得分後 GAME.replay.delay 模擬秒開始）、正在播的、播完要做的事（最後一分的結果畫面） */
const recorder = new ReplayRecorder();
let replayPending: { m: Match; hit: NonNullable<ReplayRecorder['lastHit']>; land: NonNullable<ReplayRecorder['lastLand']> } | null = null;
let replay: { p: ReplayPlayer; m: Match } | null = null;
let afterReplay: (() => void) | null = null;

/** 手機震動（iPhone 的 Safari 不支援，會自動略過） */
function buzz(pattern: number | number[]): void {
  if (!settings.vibration || demoPlayer || online?.spectator) return;
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
/** 這場實際用的跑位（4 人房房主選了「全員手動跑位」時 = manual，不改設定） */
let moveNow: MoveMode = 'auto';
/** 自動跑位的預判狀態（每次對手擊球重新開始） */
let read: { serial: number; t0: number; done: boolean } | null = null;
/** 輔助跑位：玩家已經往對的方向推過（之後放手也幫忙跑完這一球） */
let engaged = -1;
const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)];

/** 開一場對 AI 的比賽；doubles = 雙打（自己＋AI 夥伴 對 兩位 AI）。回傳這場的球員（開場介紹用） */
function newMatch(demo: boolean, tourOpp?: TourOpponent, venue?: Venue, doubles = false): { partner: Character | null; opps: Character[] } {
  endTutorial();
  cancelReplay();
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
  const look = (c: Character, racket: string): Look => ({ ...c, racketColor: racketById(racket).color, racket });
  // 球衣顏色：示範對打 = 各自球員原色；巡迴賽 = 自己選的顏色 vs 對手球員原色（太像就換）；
  // 單打／雙打 = 比賽設定選的「你的顏色」「對手顏色」（對手預設隨機，跟你太像會自動換）
  const mine = demo ? { shirt: me.shirt, shorts: me.shorts } : myColors(me);
  const avoid = doubles ? [mine.shirt, shade(mine.shirt, -0.32)] : [mine.shirt];
  const theirs = demo ? { shirt: opp.shirt, shorts: opp.shorts } : pickOppColor(tourOpp ? oppIdColor(opp) : settings.oppColor, avoid);
  renderer.setLooks(
    doubles
      ? teamLooks([look(me, s.racket), look(opp, s.aiRacket!), look(partner!, s.partnerRacket!), look(opp2!, s.ai2Racket!)], mine, theirs)
      : [
          { ...look(me, s.racket), ...mine },
          { ...look(opp, s.aiRacket!), shirt: theirs.shirt, shorts: theirs.shorts },
        ],
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

type Colors = { shirt: number; shorts: number };

/** 自己的球衣色：比賽設定選的顏色；「原色」= 球員自己的顏色 */
function myColors(c: Character): Colors {
  const pc = colorById(settings.myColor);
  return pc ? { shirt: pc.shirt, shorts: pc.shorts } : { shirt: c.shirt, shorts: c.shorts };
}

/** 球員原色對應的色盤 id（巡迴賽對手穿自己的顏色；跟你太像時 pickOppColor 會換掉） */
function oppIdColor(c: Character): string {
  return SHIRT_COLORS.find((x) => x.shirt === c.shirt)?.id ?? 'random';
}

/**
 * 雙打隊服：自己這隊穿你的顏色（夥伴深一點），對手那隊穿對手顏色（第二位深一點），一眼分得出兩隊；
 * 髮型、身高、背號、球拍還是各自的。looks 的順序 = 球員編號（0 自己、1 對手、2 夥伴、3 對手）
 */
function teamLooks(looks: Look[], mine: Colors, theirs: Colors): Look[] {
  return looks.map((l, i) => {
    const second = i >= 2;
    const base = i % 2 === 0 ? mine : theirs;
    return { ...l, shirt: second ? shade(base.shirt, -0.32) : base.shirt, shorts: base.shorts };
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

/**
 * 選球員／球拍的卡片（附能力長條圖）。卡片上是 3D 小圖（render/thumbs.ts）：球員穿球衣、拿著目前選的球拍
 * （選中的那位穿「你的顏色」），所有球員同比例看得出身高；球拍照種類有不同外型。
 * deferThumbs：啟動時先把選單顯示出來，小圖下一刻再畫
 */
function buildCards(deferThumbs = false): void {
  const charBox = $('charCards');
  const rBox = $('racketCards');
  const scroll = [charBox.scrollLeft, rBox.scrollLeft]; // 重建卡片不要跳回最左邊
  const rk = racketById(settings.racket);
  const jobs: [HTMLImageElement, () => string][] = [];
  const thumbBox = (b: HTMLElement, alt: string, job: () => string) => {
    const box = document.createElement('div');
    box.className = 'thumb';
    const img = document.createElement('img');
    img.alt = alt;
    box.appendChild(img);
    b.prepend(box);
    jobs.push([img, job]);
  };
  charBox.innerHTML = '';
  for (const c of CHARACTERS) {
    const b = document.createElement('button');
    const sel = c.id === settings.character;
    b.className = 'card' + (sel ? ' on' : '');
    b.innerHTML = `<b>${c.name}</b><small>${c.title}</small><span>${c.desc}</span>`;
    const col = sel ? myColors(c) : { shirt: c.shirt, shorts: c.shorts };
    thumbBox(b, c.name, () => playerThumb(c.id, col.shirt, col.shorts, rk.color, rk.id));
    b.addEventListener('click', () => {
      settings.character = c.id;
      saveSettings();
      buildCards();
    });
    charBox.appendChild(b);
  }
  rBox.innerHTML = '';
  for (const r of RACKETS) {
    const b = document.createElement('button');
    b.className = 'card' + (r.id === settings.racket ? ' on' : '');
    b.innerHTML = `<b>${r.name}</b><span>${r.desc}</span>`;
    thumbBox(b, r.name, () => racketThumb(r.id, r.color));
    b.addEventListener('click', () => {
      settings.racket = r.id;
      saveSettings();
      buildCards();
    });
    rBox.appendChild(b);
  }
  charBox.scrollLeft = scroll[0];
  rBox.scrollLeft = scroll[1];
  const fill = () => jobs.forEach(([img, job]) => (img.src = job()));
  if (deferThumbs) window.setTimeout(fill, 60);
  else fill();
  // 球員 × 球拍 組合後的實際能力
  const me = characterById(settings.character);
  $('kitSummary').innerHTML = `<div class="kit-title">${me.name} ＋ ${rk.name}</div><div class="bars">${bars(buildKit(me.id, rk.id), true)}</div>`;
}

function setMode(m: Mode): void {
  music.setIntensity(m === 'menu' || m === 'result' ? 1 : 0.4); // 比賽中音樂小聲一點
  mode = m;
  $('tour').classList.remove('show');
  if (m !== 'result') $('nextBtn').style.display = 'none';
  controls.enabled = m === 'play' && !online?.spectator; // 觀眾沒有操作
  controls.reset();
  document.body.classList.toggle('in-menu', m === 'menu');
  $('menu').classList.toggle('show', m === 'menu');
  if (m === 'menu') refreshRejoinBtn();
  if (m !== 'play' && m !== 'paused') $('netWait').classList.remove('show');
  $('pause').classList.toggle('show', m === 'paused');
  $('result').classList.toggle('show', m === 'result');
  $('drills').classList.remove('show');
  if (m !== 'menu') $('online').classList.remove('show');
  if (m !== 'menu') $('settings').classList.remove('show');
  $('setup').classList.remove('show');
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
        sfx.point(!!online?.spectator || e.winner === match.teamOf(HUMAN)); // 觀眾：中立，一律用得分的聲音
        onPointAudio(e.winner, e.reason);
      }
      if (isWinner(e) && replayOn()) queueReplay(e.winner);
      if (online && !online.spectator) sendLob(); // 大廳：比分變了（房主才會真的送）
      break;
    case 'match':
      if (online && !online.spectator) {
        online.room.inMatch = false;
        clearRejoin(online.room.cid); // 打完了：不用再「回到剛剛的房間」
      }
      if (live) {
        const ctx = tourCtx;
        const showResult = () => {
          const win = e.winner === match.teamOf(HUMAN);
          // 比分、局數以隊伍為索引：0 = 自己這隊
          const sc = match.settings.games > 1 ? `局數 ${match.games[0]} : ${match.games[1]}` : `比分 ${match.score[0]} : ${match.score[1]}`;
          $('resultTitle').textContent = online?.spectator ? `${hud.teamNames[e.winner]} 獲勝` : win ? (match.doubles ? '🏆 你們贏了！' : '🏆 你贏了！') : `${hud.oppName} 獲勝`;
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
        };
        // 最後一分有得分回放：播完才出結果
        resultTimer = window.setTimeout(() => (replay || replayPending ? (afterReplay = showResult) : showResult()), 1600);
      } else {
        window.setTimeout(() => mode === 'menu' && newMatch(true), 1500);
      }
      break;
  }
  renderer.fxEvent(e, match, live); // 殺球特效：擊球爆閃、飛行拖尾、落地爆炸（render/fx.ts）
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
  if (replay) return replayTick(dt); // 得分回放中：比賽暫停，畫面播回放
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
  else if (onlineWaitTick(dt)) acc = 0; // 線上斷線等待中：比賽暫停
  else if (mode === 'play' || mode === 'menu' || (online?.sync && mode === 'paused')) {
    // 線上：暫停畫面時比賽照樣進行（對方不會等你）
    acc += dt * GAME.simSpeed * (tutorial && mode === 'play' ? tutorial.timeScale : 1);
    let n = 0;
    while (acc >= PHYS.dt && n++ < 40 && hitStop <= 0) {
      const mine = demoPlayer ? demoPlayer.input() : (tutInput ?? controls.poll());
      tutInput = null;
      if (assist && (!tutorial || tutorial.wantAssist)) {
        const a = assist.input();
        if (moveNow === 'assist' && !tutorial) steerAssist(mine, a);
        else {
          // 自動跑位：移動交給電腦，蓄力／出拍還是玩家自己；左手可以預判起步
          mine.moveX = a.moveX;
          mine.moveY = a.moveY;
          mine.dive ??= a.dive;
          if (!tutorial && !demoPlayer) anticipate();
        }
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
      // 2 人房 AI 接手中：變成本機對 AI，不送任何東西
      const sync = online?.aiTakeover ? null : online?.sync;
      const events = match.drainEvents();
      if (replayOn()) recorder.record(match, events); // 得分回放的錄影（只讀比賽狀態）
      for (const e of events) {
        sync?.onEvent(e);
        handleEvent(e);
      }
      sync?.afterStep();
      if (tutorial?.checkFreeze()) {
        acc = 0;
        break;
      }
      if (replayPending && replayDue()) {
        acc = 0;
        break;
      }
    }
    if (hitStop > 0) acc = 0;
    onlinePointBoundary();
  }
  if (replay) return replayTick(0); // 這一幀開始回放：直接畫回放的第一格（不要再用電影鏡頭畫一次比賽）
  const me = match.players[HUMAN];
  const spec = !!online?.spectator && online.sync === online.spectator;
  if (!demoPlayer && !spec) chargeZoneTicks(me.charging, me.charge, match.phase === 'serve' && match.server === HUMAN, match.doubles);
  renderer.update(match, mode === 'paused' || mode === 'result' ? 0 : dt, settings.landingHint && !demoPlayer, HUMAN);
  // 觀戰：記分板左邊 = 畫面下方那隊（可以換邊）
  if (mode !== 'menu') hud.update(match, renderer, dt, spec ? (renderer.viewSide === 1 ? 0 : 1) : HUMAN);
  if (!spec) controls.draw(me.charge, me.charging && !demoPlayer, renderer.bottomReserve);
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
// 效能保險：低階手機持續掉幀（低於約 42 fps 累積 2.5 秒）就自動降一級解析度
let lastFrame = 0;
let slowMs = 0;
function frame(now: number): void {
  const gap = now - lastFrame;
  lastFrame = now;
  if (gap > 24 && gap < 200 && !document.hidden) slowMs += gap;
  else if (gap < 20) slowMs = Math.max(0, slowMs - gap * 0.5);
  if (slowMs > 2500) {
    slowMs = 0;
    renderer.lowerQuality();
  }
  tick(now);
  requestAnimationFrame(frame);
}

// ---------- 得分回放（精彩回放） ----------
/** 這場要不要錄／播回放：對 AI 的單打、雙打、巡迴賽；線上（兩支手機要同步）、教學、訓練、主選單示範不播 */
function replayOn(): boolean {
  return settings.replay && !demoPlayer && !online?.sync && !tutorial && !drill && !match.settings.practice;
}

const REPLAY_SHOTS = new Set(['殺球', '跳殺', '機會殺球', '撲球', '跳撲']);

/** 這一分打之前有沒有一方在局點（或賽點）：得分事件時比分已經加上這一分 */
function wasGamePoint(winner: TeamId): boolean {
  const s = match.score.slice();
  s[winner]--;
  const target = match.settings.points;
  const cap = target === 21 ? 30 : target === 15 ? 21 : 15;
  const onePointFrom = (a: number, b: number) => (a + 1 >= target && a + 1 - b >= 2) || a + 1 >= cap;
  return onePointFrom(s[0], s[1]) || onePointFrom(s[1], s[0]);
}

/** 主動得分（羽球落在對方場內）：記下致勝的那一拍和落地，得分橫幅出現一下之後才開始播 */
function queueReplay(winner: TeamId): void {
  const hit = recorder.lastHit;
  const land = recorder.lastLand;
  if (recorder.recording !== match || !hit || !land || land.tick !== recorder.lastTick || !land.e.inBounds || hit.tick >= land.tick) return;
  if (match.teamOf(hit.e.player) !== winner || hit.e.netFault) return;
  // 只回放殺球、撲球，以及局點／賽點那一分的致勝球（每分都播太頻繁）
  if (!REPLAY_SHOTS.has(hit.e.name) && !wasGamePoint(winner)) return;
  replayPending = { m: match, hit, land };
}

/** 得分暫停中、時間到了就開始播；回傳 true = 開始了（比賽先停在這裡，播完才繼續） */
function replayDue(): boolean {
  const pend = replayPending!;
  if (pend.m !== match || (match.phase !== 'point' && match.phase !== 'matchOver')) {
    replayPending = null;
    flushAfterReplay();
    return false;
  }
  if (match.phaseT < GAME.replay.delay) return false;
  replayPending = null;
  const p = ReplayPlayer.create(recorder, match, pend.hit, pend.land);
  if (!p) {
    flushAfterReplay();
    return false;
  }
  startReplay(p);
  return true;
}

function startReplay(p: ReplayPlayer): void {
  replay = { p, m: match };
  p.aspect = innerWidth / Math.max(1, innerHeight);
  hitStop = 0;
  controls.enabled = false;
  controls.reset();
  renderer.beginReplay(p.view);
  document.body.classList.add('replaying');
  const e = p.shot;
  const ours = match.teamOf(e.player) === match.teamOf(HUMAN);
  $('replayShot').textContent = `${e.name} ${e.speedKmh} km/h`;
  $('replayWho').textContent = e.player === HUMAN ? '你' : ours ? '隊友' : hud.oppName;
  $('replay').classList.toggle('opp', !ours);
  $('replay').classList.add('show');
  $('replayProg').style.width = '0%';
  dipFade();
  sfx.replay();
}

/** 回放中的一幀：比賽不推進，畫面讀回放的檢視用比賽、鏡頭照回放算的擺（暫停畫面時停在原地） */
function replayTick(dt: number): void {
  const r = replay!;
  if (r.m !== match) return cancelReplay();
  const run = mode === 'play';
  r.p.aspect = innerWidth / Math.max(1, innerHeight);
  const { events, animDt } = run ? r.p.update(dt) : { events: [], animDt: 0 };
  for (const e of events) replayEvent(e, r.p);
  renderer.setCinematic(r.p.cam, run ? dt : 0);
  renderer.update(r.p.view, animDt, false, HUMAN);
  hud.update(match, renderer, run ? dt : 0, HUMAN); // 記分板藏著，得分橫幅照樣倒數
  $('replayProg').style.width = `${(r.p.progress * 100).toFixed(1)}%`;
  updateNetInfo(dt);
  renderer.render();
  if (r.p.done) stopReplay();
}

/** 回放裡的事件：只重播聲音和特效（不震動、不跳字、不算分） */
function replayEvent(e: MatchEvent, p: ReplayPlayer): void {
  const view = p.view;
  switch (e.type) {
    case 'hit': {
      const smash = (e.family === 'down' && e.speedKmh > 120) || e.jump;
      const q = e.serve ? 0.85 : e.quality;
      sfx.hit(q, e.speedKmh, e.jump);
      if (e === p.shot) sfx.slowHit(smash ? Math.min(1, e.speedKmh / 220) : 0.15); // 致勝那一拍：慢動作的低沉一聲
      renderer.burst(e.pos, q, smash, e.jump);
      break;
    }
    case 'whiff':
      sfx.whiff();
      break;
    case 'jump':
      sfx.jump();
      break;
    case 'jumpLand':
    case 'diveLand':
      sfx.thud();
      renderer.dust(view.players[e.player].pos);
      break;
    case 'dive':
      sfx.whoosh();
      break;
    case 'net':
      sfx.net();
      break;
    case 'land':
      sfx.land();
      break;
  }
  renderer.fxEvent(e, view, true);
}

/** 回放結束（播完或跳過）：畫面接回比賽，比賽從暫停的地方繼續（狀態完全沒動過） */
function stopReplay(): void {
  if (!replay) return;
  replay = null;
  renderer.endReplay(match);
  document.body.classList.remove('replaying');
  $('replay').classList.remove('show');
  dipFade();
  controls.enabled = mode === 'play';
  controls.reset();
  acc = 0;
  flushAfterReplay();
}

/** 換一場、離開比賽：回放、等著播的、播完要做的事全部取消 */
function cancelReplay(): void {
  afterReplay = null;
  replayPending = null;
  stopReplay();
  recorder.reset();
}

function flushAfterReplay(): void {
  const f = afterReplay;
  afterReplay = null;
  f?.();
}

/** 從黑畫面淡入：遮住進出回放時鏡頭的跳切 */
function dipFade(): void {
  const el = $('replayFade');
  el.classList.remove('go');
  void el.offsetWidth; // 重新開始動畫
  el.classList.add('go');
}

// 回放中點一下（或按任何鍵）就跳過；按鍵不往下傳（不會順便暫停、出拍）
$('replay').addEventListener('pointerdown', (e) => {
  if (!replay || mode !== 'play') return;
  e.preventDefault();
  stopReplay();
});
window.addEventListener(
  'keydown',
  (e) => {
    if (!replay || mode !== 'play') return;
    e.preventDefault();
    e.stopImmediatePropagation();
    stopReplay();
  },
  true,
);

// ---------- 選單 ----------
const DIFF_LABEL: Record<Difficulty, string> = { easy: '簡單', normal: '普通', hard: '困難', extreme: '超難', hell: '地獄' };
const DIFF_HINT: Record<Difficulty, string> = {
  easy: '對手反應慢、常失誤，適合剛上手',
  normal: '一般對手，會打空檔也會殺球',
  hard: '反應快、落點準、會跳殺和魚躍',
  extreme: '反應更快、球球打空檔、多殺多撲，很少失誤',
  hell: '反應極快、腳步比你快一點、球貼邊線又狠——要靠落點和假動作拉開',
};
const VENUE_LABEL: Record<Venue, string> = { sakura: '櫻花園', night: '夜櫻', bamboo: '竹林', indoor: '室內球館', market: '市場', paddy: '稻田', beach: '海灘' };
const VENUES = Object.keys(VENUE_LABEL) as Venue[];

/** 這場的場地：比賽設定選的；「隨機」每場重抽 */
function matchVenue(): Venue {
  return settings.venuePick === 'random' ? pick(VENUES) : settings.venuePick;
}

function goFullscreen(): void {
  if (controls.isTouch || matchMedia('(pointer: coarse)').matches) document.documentElement.requestFullscreen?.().catch(() => {});
}

/** 單打（對 AI）：難度／場地／分數／局數／顏色照比賽設定 */
function startGame(): void {
  unlockAudio();
  goFullscreen();
  const venue = matchVenue();
  const { opps } = newMatch(false, undefined, venue);
  again = () => startGame();
  acc = 0;
  setMode('play');
  hud.intro(`對手：${opps[0].name}`, `${DIFF_LABEL[settings.difficulty]}・${VENUE_LABEL[venue]}・${settings.points} 分${settings.games > 1 ? '・三戰兩勝' : ''}`);
}

/** 雙打（自己＋AI 夥伴 對 兩位 AI），難度／場地／分數／局數／顏色照比賽設定 */
function startDoubles(): void {
  unlockAudio();
  goFullscreen();
  const venue = matchVenue();
  const { partner, opps } = newMatch(false, undefined, venue, true);
  again = () => startDoubles();
  acc = 0;
  setMode('play');
  hud.intro(`雙打・${DIFF_LABEL[settings.difficulty]}`, `夥伴：${partner!.name}\n對手：${opps.map((o) => o.name).join('、')}`);
}

/** 照比賽設定的模式開始（單打／雙打） */
const startSelected = () => (settings.matchType === 'singles' ? startGame() : startDoubles());

/** 設定改了之後要跟著更新的東西（場地預覽、提示文字、音效開關） */
function onSettingChanged(key: string): void {
  if (key === 'moveMode') {
    settings.autoMove = settings.moveMode === 'auto';
    saveSettings();
  }
  if (key === 'venuePick' && settings.venuePick !== 'random') {
    settings.venue = settings.venuePick; // 選了固定場地：訓練、教學、選單背景也用這個
    saveSettings();
    applyVenue(settings.venue);
  }
  if (key === 'difficulty') $('diffHint').textContent = DIFF_HINT[settings.difficulty] ?? '';
  applyAudioSettings();
}

// 設定／比賽設定的分段按鈕：data-key = settings 的欄位，data-v = 值
// （同一個設定可以出現在好幾個地方，例如「跑位」在設定和比賽設定都有：按了全部一起更新）
const segSyncs: (() => void)[] = [];
const syncSegs = () => segSyncs.forEach((f) => f());
document.querySelectorAll<HTMLElement>('.seg[data-key]').forEach((seg) => {
  const key = seg.dataset.key as keyof MatchSettings;
  const buttons = seg.querySelectorAll<HTMLButtonElement>('button');
  const sync = () => buttons.forEach((b) => b.classList.toggle('on', b.dataset.v === String(settings[key])));
  segSyncs.push(sync);
  buttons.forEach((b) =>
    b.addEventListener('click', () => {
      const v = b.dataset.v!;
      (settings as unknown as Record<string, unknown>)[key] = v === 'true' ? true : v === 'false' ? false : /^\d+$/.test(v) ? Number(v) : v;
      saveSettings();
      syncSegs();
      onSettingChanged(key);
    }),
  );
  sync();
});

/** 比賽設定的顏色選擇：你的顏色（原色＋色盤）、對手顏色（隨機＋色盤，跟你太像的不能選） */
function buildColorPickers(): void {
  const me = characterById(settings.character);
  const mine = myColors(me).shirt;
  const swatch = (label: string, color: number | null, on: boolean, title: string, onClick: () => void, disabled = false) => {
    const b = document.createElement('button');
    b.className = 'swatch-btn' + (on ? ' on' : '') + (label ? ' text' : '') + (color !== null && colorDist(color, 0xffffff) < 120 ? ' light' : '');
    if (color === null) b.style.background = 'conic-gradient(#e0483a,#f2a23a,#f2d43a,#34c38f,#2f7fe0,#8a5cf0,#f27fb0,#e0483a)'; // 隨機 = 彩色
    else b.style.setProperty('--c', hexCss(color));
    b.textContent = label;
    b.title = title;
    b.disabled = disabled;
    b.addEventListener('click', () => {
      onClick();
      saveSettings();
      buildColorPickers();
    });
    return b;
  };
  const myBox = $('myColors');
  myBox.innerHTML = '';
  myBox.appendChild(swatch('原色', me.shirt, settings.myColor === 'auto', `${me.name}原本的顏色`, () => (settings.myColor = 'auto')));
  for (const c of SHIRT_COLORS) myBox.appendChild(swatch('', c.shirt, settings.myColor === c.id, c.name, () => (settings.myColor = c.id)));
  // 對手顏色：跟你（雙打還有夥伴的深色）太像的不能選；原本選的變成太像 → 改回隨機
  const avoid = settings.matchType !== 'singles' ? [mine, shade(mine, -0.32)] : [mine];
  const isClose = (c: number) => avoid.some((a) => tooClose(c, a));
  const oc = colorById(settings.oppColor);
  if (settings.oppColor !== 'random' && (!oc || isClose(oc.shirt))) {
    settings.oppColor = 'random';
    saveSettings();
  }
  const oppBox = $('oppColors');
  oppBox.innerHTML = '';
  oppBox.appendChild(swatch('🎲 隨機', null, settings.oppColor === 'random', '每場隨機（不會跟你太像）', () => (settings.oppColor = 'random')));
  for (const c of SHIRT_COLORS) {
    const close = isClose(c.shirt);
    oppBox.appendChild(swatch('', c.shirt, settings.oppColor === c.id, close ? `${c.name}（跟你的顏色太像）` : c.name, () => (settings.oppColor = c.id), close));
  }
  $('colorHint').textContent = settings.matchType !== 'singles' ? '雙打：夥伴穿你的顏色（深一點），對手兩人穿對手顏色' : '';
  // 選了顏色：主選單上選中的球員小圖也換成這個顏色
  buildCards();
}

/** 比賽設定畫面的用途：本機比賽、建立線上房間、加入前選選手 */
let setupMode: 'local' | 'create' | 'join' = 'local';
/** 選手卡片從主選單搬進比賽設定（關掉時搬回去） */
let pickerHome: Comment[] = [];
function mountPicker(): void {
  if (pickerHome.length) return;
  const els = ['charCards', 'racketCards', 'kitSummary'].map((id) => $(id));
  pickerHome = els.map((el) => {
    const c = document.createComment('picker');
    el.before(c);
    return c;
  });
  const box = $('setupPicker');
  const title = (t: string) => {
    const d = document.createElement('div');
    d.className = 'section-title small';
    d.textContent = t;
    return d;
  };
  box.replaceChildren(title('球員'), els[0], title('球拍'), els[1], els[2]);
}
function unmountPicker(): void {
  const els = ['charCards', 'racketCards', 'kitSummary'].map((id) => $(id));
  pickerHome.forEach((c, i) => c.replaceWith(els[i]));
  pickerHome = [];
  $('setupPicker').replaceChildren();
}
const setupField = (sel: string) => document.querySelector(`#setup ${sel}`)?.closest('.field') as HTMLElement | null;
/** 依用途顯示比賽設定裡的欄位 */
function layoutSetup(): void {
  const m = setupMode;
  $('setupTitle').textContent = m === 'create' ? '建立線上房間' : m === 'join' ? '選擇你的選手' : '比賽設定';
  $('setupStartBtn').textContent = m === 'create' ? '建立房間' : m === 'join' ? '確定' : '開始';
  const show = (sel: string, on: boolean) => {
    const f = setupField(sel);
    if (f) f.style.display = on ? '' : 'none';
  };
  const quad = m === 'create' && settings.matchType === 'quad';
  show('.seg[data-key="matchType"]', m !== 'join');
  // 線上單打沒有 AI：難度只給雙打的 AI 隊友（4 人房 = AI 補位）用
  show('.seg[data-key="difficulty"]', m === 'local' || (m === 'create' && settings.matchType !== 'singles'));
  show('.seg[data-key="allManual"]', quad);
  show('.seg[data-key="roomPublic"]', m === 'create');
  show('#setup .seg[data-key="moveMode"]', m !== 'local');
  show('.seg[data-key="venuePick"]', m !== 'join');
  show('.seg[data-key="points"]', m !== 'join');
  show('#oppColors', m === 'local');
  const mt = document.querySelector('#setup .seg[data-key="matchType"] button[data-v="doubles"]');
  if (mt) mt.textContent = m === 'create' ? '雙打（各帶 AI 隊友）' : '雙打（你＋AI 夥伴）';
  const qb = document.querySelector<HTMLElement>('#setup .seg[data-key="matchType"] button[data-v="quad"]');
  if (qb) qb.style.display = m === 'create' ? '' : 'none';
  $('matchTypeHint').textContent = quad ? '4 個真人 2 對 2（座位 0、2 = A 隊，1、3 = B 隊），建房後可以換隊；空位可以讓 AI 補上' : '';
  const dt = setupField('.seg[data-key="difficulty"]')?.querySelector('.section-title');
  if (dt) dt.textContent = quad ? 'AI 補位強度' : '難度';
}

function openSetup(modeArg: 'local' | 'create' | 'join' = 'local'): void {
  setupMode = modeArg;
  // 4 人房只有建立線上房間能選；本機比賽看到的是「雙打」
  if (modeArg === 'local' && settings.matchType === 'quad') {
    settings.matchType = 'doubles';
    saveSettings();
    syncSegs();
  }
  unlockAudio();
  buildColorPickers();
  mountPicker();
  $('setupPickerWrap').classList.add('show');
  layoutSetup();
  $('diffHint').textContent = setupMode === 'create' ? '雙打時 AI 隊友（4 人房的 AI 補位）都用這個強度' : (DIFF_HINT[settings.difficulty] ?? '');
  $('menu').classList.remove('show');
  $('online').classList.remove('show');
  $('setup').classList.add('show');
  $('setup').scrollTop = 0;
  document.querySelector('#setup .panel')!.scrollTop = 0;
}

$('startBtn').addEventListener('click', () => openSetup('local'));
/** 關掉比賽設定：選手卡片搬回主選單，回到來的地方 */
function closeSetup(): void {
  $('setup').classList.remove('show');
  unmountPicker();
  if (setupMode === 'local') $('menu').classList.add('show');
  else openOnline();
}
$('setupStartBtn').addEventListener('click', () => {
  if (setupMode === 'local') {
    unmountPicker();
    startSelected();
  } else if (setupMode === 'create') {
    closeSetup();
    joinRoom(newRoomCode(), true);
  } else {
    closeSetup();
    // 4 人房大廳裡換了選手／跑位：重新告訴房主
    if (online?.quad) sendQuadHello();
  }
});
$('setupBackBtn').addEventListener('click', closeSetup);
// 換模式時更新顏色提示（雙打說明）、要不要顯示難度
document.querySelector('#setup .seg[data-key="matchType"]')?.addEventListener('click', () => {
  buildColorPickers();
  layoutSetup();
});
$('againBtn').addEventListener('click', () => again());
$('restartBtn').addEventListener('click', () => again());
$('pauseBtn').addEventListener('click', () => mode === 'play' && setMode('paused'));
$('resumeBtn').addEventListener('click', () => setMode('play'));
const toMenu = () => {
  leaveOnline();
  newMatch(true);
  setMode('menu');
};
// 線上比賽中按「回主選單」：再按一次才離開（不小心按到；對手會看到你離開，10 分鐘內可以從主選單回來）
let leaveArmed = 0;
$('menuBtn').addEventListener('click', () => {
  const inOnline = !!online?.sync && !online.spectator && match.phase !== 'matchOver'; // 觀眾離開不用確認
  if (inOnline && performance.now() - leaveArmed > 3000) {
    leaveArmed = performance.now();
    $('menuBtn').textContent = '確定離開？再按一次（對手會看到你離開）';
    window.setTimeout(() => ($('menuBtn').textContent = '回主選單'), 3000);
    return;
  }
  leaveArmed = 0;
  $('menuBtn').textContent = '回主選單';
  if (inOnline) markRejoinLeft();
  toMenu();
});
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
      // v4：難度、場地、分數、局數搬到「比賽設定」（值照舊）；比賽場地沿用原本選的場地，新增單雙打與顏色
      if ((s.settingsVersion ?? 1) < 4) {
        s.venuePick = s.venue;
        s.matchType = 'singles';
        s.myColor = 'auto';
        s.oppColor = 'random';
      }
      // 防呆：存檔裡不認得的值改回預設
      if (!['easy', 'normal', 'hard', 'extreme', 'hell'].includes(s.difficulty)) s.difficulty = DEFAULT_SETTINGS.difficulty;
      if (s.myColor !== 'auto' && !colorById(s.myColor)) s.myColor = 'auto';
      if (s.oppColor !== 'random' && !colorById(s.oppColor)) s.oppColor = 'random';
      // v5：跑位改成三種（自動預判／輔助／手動）
      if ((s.settingsVersion ?? 1) < 5) s.moveMode = s.autoMove === false ? 'manual' : 'auto';
      if (!['auto', 'assist', 'manual'].includes(s.moveMode)) s.moveMode = 'auto';
      s.autoMove = s.moveMode === 'auto';
      // v6：新增得分回放（預設開）
      if ((s.settingsVersion ?? 1) < 6 || typeof s.replay !== 'boolean') s.replay = true;
      s.settingsVersion = 6;
      return s;
    }
  } catch {
    /* 私密模式等情況讀不到就用預設 */
  }
  return { ...DEFAULT_SETTINGS, settingsVersion: 6 };
}
function saveSettings(): void {
  try {
    localStorage.setItem('badminton.settings', JSON.stringify(settings));
  } catch {
    /* ignore */
  }
}

applyAudioSettings();
buildCards(true);
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
  get online() {
    return online;
  },
  get bots() {
    return bots;
  },
  get replay() {
    return replay?.p ?? null;
  },
  recorder,
  skipReplay: () => stopReplay(),
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
  cancelReplay();
  unlockAudio();
  if (controls.isTouch || matchMedia('(pointer: coarse)').matches) document.documentElement.requestFullscreen?.().catch(() => {});
  const me = characterById(settings.character);
  match = new Match({ ...settings, practice: true, aiCharacter: 'allround', aiRacket: 'balance' }, (Date.now() ^ (Math.random() * 1e9)) >>> 0);
  bots = [];
  demoPlayer = null;
  setupAssist(false);
  controls.scheme = settings.scheme;
  renderer.setLooks([{ ...me, ...myColors(me), racketColor: racketById(settings.racket).color, racket: settings.racket }, { shirt: 0x8a96a8, shorts: 0x2a2f38 }]); // 對面是灰色的發球機教練
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
/** 自己這邊的輔助：自動跑位（＋自動魚躍）；手動跑位時擊球範圍大一點（force = 4 人房「全員手動跑位」） */
function setupAssist(demo: boolean, force?: MoveMode): void {
  const mode = force ?? settings.moveMode;
  moveNow = mode;
  assist = !demo && mode !== 'manual' ? new AIController(match, 0, 'hard', true) : null;
  if (assist) {
    assist.allowDive = mode === 'auto' && settings.autoDive;
    // 自動：平常起步慢一點，預判對了立刻起步；輔助：玩家自己起步，電腦只負責對準
    assist.reactionOverride = mode === 'auto' ? GAME.anticipation.baseReaction : 0;
  }
  controls.autoMove = !demo && mode === 'auto';
  controls.autoDive = settings.autoDive;
  match.players[HUMAN].reachMul = demo ? 1 : mode === 'manual' ? GAME.manualReachMul : mode === 'assist' ? GAME.assistReachMul : 1;
  read = null;
  engaged = -1;
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
/** 線上雙打：自己的 AI 隊友（進房時抽一次，跟自己不同人） */
let onlinePartner: { character: string; racket: string } | null = null;
/** 線上房間這次用的場地（房主「隨機」時進房抽一次） */
let onlineVenue: Venue | null = null;
const MOVE_LABEL: Record<MoveMode, string> = { auto: '自動', assist: '輔助', manual: '手動' };
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const lookOf = (c: Character, racket: string): Look => ({ ...c, racketColor: racketById(racket).color, racket });

function myHello(): Hello {
  const me = characterById(settings.character);
  const col = myColors(me);
  if (!onlinePartner || onlinePartner.character === me.id) onlinePartner = { character: pick(CHARACTERS.filter((c) => c.id !== me.id)).id, racket: pick(RACKETS).id };
  onlineVenue ??= matchVenue();
  return {
    name: me.name,
    character: settings.character,
    racket: settings.racket,
    points: settings.points,
    games: settings.games,
    venue: onlineVenue,
    matchType: settings.matchType,
    difficulty: settings.difficulty,
    shirt: col.shirt,
    shorts: col.shorts,
    partner: onlinePartner.character,
    partnerRacket: onlinePartner.racket,
    mv: settings.moveMode,
  };
}

function showLobby(code: string | null): void {
  const spec = !!online?.spectator;
  // 2 人房進房後不能換選手（已經告訴對方了）；4 人房可以（重新告訴房主）；觀眾沒有選手
  $('onlinePickBtn').style.display = code && (!online?.quad || spec) ? 'none' : '';
  $('onlineIdle').style.display = code ? 'none' : '';
  $('onlineRoom').style.display = code ? '' : 'none';
  $('roomCode').textContent = code ?? '';
  $('roomCodeLabel').textContent = spec ? '觀戰中・房號' : '房號';
  $('shareRoomBtn').style.display = spec ? 'none' : '';
  if (!code) {
    $('roomStatus').textContent = '';
    $('roomStatus').className = 'room-status';
  }
  renderSpectators();
  renderQuadLobby();
}

/** 房間畫面＋HUD 的觀眾人數（玩家看）；觀眾自己看到的是「觀眾 N（含你）」 */
function renderSpectators(): void {
  const n = online?.spectator ? online.spectator.spectators : (online?.spectators ?? 0);
  const text = n ? `👀 觀眾 ${n}${online?.spectator ? '（含你）' : ''}` : '';
  $('roomSpec').textContent = text;
  const badge = $('specBadge');
  badge.textContent = n && !online?.spectator ? `👀 觀眾 ${n}` : '';
  badge.classList.toggle('show', !!badge.textContent);
}
function setSpectators(n: number): void {
  if (online) online.spectators = n;
  renderSpectators();
}

function openOnline(): void {
  const me = characterById(settings.character);
  $('onlineMe').textContent = `你的選手：${me.name}＋${racketById(settings.racket).name}`;
  $('menu').classList.remove('show');
  $('online').classList.add('show');
  showLobby(online ? online.room.code : null);
}

function leaveOnline(): void {
  hideWait();
  hud.notice(null);
  online?.room.close();
  online = null;
  $('againBtn').style.display = '';
  $('netInfo').textContent = '';
  $('quadLobby').style.display = 'none';
  $('specBadge').classList.remove('show');
  // 觀戰結束：鏡頭、記分板、搖桿都還原
  if (renderer.spectator || renderer.viewSide !== 1) {
    renderer.spectator = false;
    renderer.viewSide = 1;
    renderer.resize();
  }
  hud.spectator = false;
  $('touch').style.display = '';
  document.body.classList.remove('spectating');
}

/**
 * 進房間（creator = 自己建的；rejoin = 從「回到剛剛的房間」回來，沿用當時的連線編號）。
 * 建立 4 人房（比賽設定選「雙打（4 人）」）或伺服器說這是 4 人房 → 訊息交給 onQuadMsg
 */
function joinRoom(code: string, creator = false, rejoin: RejoinRecord | null = null): void {
  leaveOnline();
  unlockAudio();
  onlinePartner = null; // 每次進房重抽 AI 隊友、場地
  onlineVenue = null;
  if (rejoin) adoptClientId(rejoin.cid);
  const room = new RoomClient(code, myHello);
  room.creator = creator;
  if ((creator && settings.matchType === 'quad') || rejoin?.cap === 4) room.cap = 4;
  online = { room, sync: null, waiting: false, wait: null, aiTakeover: false, pendingReturn: false, start: null, quad: room.cap === 4 ? newQuad() : null, spectator: null, spectators: 0, pub: creator && settings.roomPublic !== false };
  saveRejoin({ code, cid: room.cid, cap: room.cap, t: Date.now() });
  room.onStatus = (text, kind) => {
    const el = $('roomStatus');
    el.textContent = text;
    el.className = `room-status ${kind}`;
    if (mode === 'result' && online?.room === room) $('resultScore').textContent = text;
  };
  room.onStart = (start, peer, host, rj) => startOnlineMatch(start, peer, host, rj);
  room.onGame = (msg) => online?.sync?.receive(msg);
  // 觀眾、遊戲大廳（2 人房；4 人房在 onQuadMsg）
  room.onWelcome = () => online?.room === room && sendLob();
  room.onSpectators = (n) => online?.room === room && setSpectators(n);
  room.onSpecHello = () => online?.room === room && sendSnap();
  // 比賽中對方斷線／離開：不把人踢出去，暫停並讓玩家選「AI 接手繼續」「繼續等待」「離開」
  room.onPeerLeft = (bye) => {
    if (online?.room !== room || !online.sync || online.aiTakeover || match.phase === 'matchOver') return;
    online.pendingReturn = false;
    showWait({ title: bye ? '對手離開了' : '對手斷線了', until: performance.now() + 20000, self: false });
  };
  room.onDisconnect = () => {
    if (online?.room !== room || !online.sync || online.aiTakeover || match.phase === 'matchOver') return;
    showWait({ title: '連線中斷', until: null, self: true, text: '重新連線中…' });
  };
  room.onGiveUp = () => {
    if (online?.room !== room || !online.sync || online.aiTakeover || match.phase === 'matchOver') return;
    showWait({ title: '連不上伺服器', until: null, self: true, gaveUp: true, text: '網路恢復後按「重試」，或讓 AI 接手繼續打' });
  };
  room.onRejoin = (_peer, lead) => {
    if (online?.room !== room || !online.sync) return;
    if (!lead) {
      // 對方的比賽狀態比較新：等他送 start／resume
      if (online.wait) {
        online.wait.text = '重新連上了，等對方繼續…';
        renderWait();
      }
      return;
    }
    if (online.aiTakeover) {
      // AI 正在代打：這一分打完就換回對手（onlinePointBoundary）
      online.pendingReturn = true;
      hud.intro('對手回來了', '這一分打完就換回對手');
      return;
    }
    handBack2p();
  };
  room.onResume = (msg) => {
    if (online?.room !== room || !online.sync) return;
    if (online.aiTakeover) undoTakeover2p();
    const L = HUMAN;
    const R = match.remote ?? 1;
    const sc: [number, number] = [0, 0];
    const gm: [number, number] = [0, 0];
    sc[R] = msg.sc[0];
    sc[L] = msg.sc[1];
    gm[R] = msg.gm[0];
    gm[L] = msg.gm[1];
    match.resumePoint(sc, gm, (msg.srv ^ 1) as PlayerId); // 對方的編號 → 本機（xor 1）
    resumed();
  };
  room.onQuad = (msg) => onQuadMsg(room, msg);
  showLobby(code);
  room.connect();
}

/** rejoin = 斷線回來（對方照目前這場的設定請我重建，接著會送 resume；收到之前先暫停） */
function startOnlineMatch(start: StartInfo, peer: Hello, host: boolean, rejoin = false): void {
  if (!online) return;
  endTutorial();
  cancelReplay();
  unlockAudio();
  if (controls.isTouch || matchMedia('(pointer: coarse)').matches) document.documentElement.requestFullscreen?.().catch(() => {});
  const me = characterById(settings.character);
  const opp = characterById(peer.character);
  const doubles = start.matchType === 'doubles';
  const s: MatchSettings = { ...settings, points: start.points, games: start.games, venue: start.venue, aiCharacter: opp.id, aiRacket: peer.racket, doubles };
  // 雙打：自己的 AI 隊友 = 2 號（本機控制），對方的 AI 隊友 = 3 號（對方手機控制）
  const mate = onlinePartner ? characterById(onlinePartner.character) : pick(CHARACTERS.filter((c) => c.id !== me.id));
  const oppMate = peer.partner ? characterById(peer.partner) : pick(CHARACTERS.filter((c) => c.id !== opp.id));
  if (doubles) {
    s.partnerCharacter = mate.id;
    s.partnerRacket = onlinePartner?.racket ?? 'balance';
    s.ai2Character = oppMate.id;
    s.ai2Racket = peer.partnerRacket ?? 'balance';
  }
  match = new Match(s, (Date.now() ^ (Math.random() * 1e9)) >>> 0);
  match.remote = 1; // 對方隊伍 = 1 號隊（畫面上方），自己永遠在下方
  match.server = host ? 0 : 1; // 房主先發
  match.setupServe();
  match.drainEvents();
  bots = [];
  if (doubles) bots[2] = new AIController(match, 2, start.difficulty === 'easy' ? 'normal' : start.difficulty);
  demoPlayer = null;
  tourCtx = null;
  drill = null;
  hud.drill = null;
  setupAssist(false);
  controls.scheme = settings.scheme;
  // 球衣：各自穿自己選的顏色；對方的顏色跟我的太像時，我這邊看到的對方換成對比色
  const mine = myColors(me);
  let theirs = peer.shirt !== undefined ? { shirt: peer.shirt, shorts: peer.shorts ?? opp.shorts } : { shirt: opp.shirt, shorts: opp.shorts };
  if (tooClose(theirs.shirt, mine.shirt) || (doubles && tooClose(theirs.shirt, shade(mine.shirt, -0.32)))) theirs = pickOppColor('random', doubles ? [mine.shirt, shade(mine.shirt, -0.32)] : [mine.shirt]);
  renderer.setLooks(
    doubles
      ? teamLooks([lookOf(me, settings.racket), lookOf(opp, peer.racket), lookOf(mate, s.partnerRacket!), lookOf(oppMate, s.ai2Racket!)], mine, theirs)
      : [
          { ...lookOf(me, settings.racket), ...mine },
          { ...lookOf(opp, peer.racket), shirt: theirs.shirt, shorts: theirs.shorts },
        ],
  );
  applyVenue(start.venue);
  renderer.setTarget(null);
  hud.oppName = doubles ? `${peer.name}隊` : peer.name;
  hud.oppTag = '線上';
  clearTimeout(resultTimer);
  hitStop = 0;
  const room = online.room;
  online.sync = new OnlineSync(match, (msg) => room.send(msg));
  online.start = start;
  online.aiTakeover = false;
  online.pendingReturn = false;
  hideWait();
  online.waiting = rejoin; // 斷線回來：等對方的 resume（從目前比分繼續）
  room.inMatch = true;
  saveRejoin({ code: room.code, cid: room.cid, cap: 2, t: Date.now() });
  again = () => room.requestRematch();
  $('againBtn').style.display = '';
  acc = 0;
  setMode('play');
  renderSpectators();
  sendLob(); // 大廳：比賽中
  if (rejoin) hud.intro('回到比賽', '從目前比分繼續');
  else hud.intro(doubles ? `線上雙打：${peer.name}＋${oppMate.name}（AI）` : `線上對戰：${peer.name}`, `${doubles ? `你的隊友：${mate.name}（AI）｜` : ''}${host ? (doubles ? '你們先發球' : '你先發球') : '對手先發球'}`);
}

// ---------- 遊戲大廳、觀戰（玩家這一邊） ----------

/** 自己是不是回快照／送大廳資料的人：2 人房 = 房主（房主斷線時加入的人）；4 人房 = 房主（比賽中 = 帶大家繼續的人） */
function iAnswerSpectators(): boolean {
  if (!online || online.spectator) return false;
  const room = online.room;
  if (online.quad) return !!online.quad.lobby && (quadInMatch() ? iLead() : quadIsHost());
  if (room.role === 'host') return !room.dropped || !room.peer;
  return room.role === 'guest' && (!room.peer || room.peerMs < room.matchState());
}

/**
 * 房主 → 伺服器：這個房間在大廳的資料（公開與否只有建房的人送；伺服器自己算人數、觀眾數）。
 * 2 人房只有房主送（加入的人剛連上時還不知道對方的狀態，送了會把「比賽中」蓋成「等待中」）；4 人房 = 房主／帶大家繼續的人
 */
function sendLob(): void {
  if (!online || online.spectator) return;
  if (online.quad ? !iAnswerSpectators() : online.room.role !== 'host') return;
  const room = online.room;
  const me = myHello();
  const playing = !!online.sync && match.phase !== 'matchOver';
  const over = !!online.sync && match.phase === 'matchOver';
  const cfg = online.quad?.lobby?.r.cfg;
  let sc: [number, number] | undefined;
  let gm: [number, number] | undefined;
  if (online.sync) {
    // 標準視角：2 人房 [房主, 加入的人]；4 人房 [A 隊, B 隊]
    const f = online.quad?.sess ? online.quad.sess.mySeat & 1 : room.role === 'host' ? 0 : 1;
    sc = [match.score[f], match.score[f ^ 1]];
    gm = [match.games[f], match.games[f ^ 1]];
  }
  room.send({
    t: 'lob',
    ...(room.creator ? { pub: online.pub ? 1 : 0 } : {}),
    name: me.name,
    mode: online.quad ? 'quad' : (online.start?.matchType ?? (me.matchType === 'doubles' ? 'doubles' : 'singles')),
    venue: cfg?.venue ?? online.start?.venue ?? me.venue,
    points: cfg?.points ?? online.start?.points ?? me.points,
    games: cfg?.games ?? online.start?.games ?? me.games,
    st: over ? 'over' : playing ? 'play' : 'wait',
    sc,
    gm,
  });
}

/** 有觀眾進來要狀態：回快照（只有一個人回，不然觀眾會重建兩次） */
function sendSnap(): void {
  if (!online || online.spectator || !iAnswerSpectators()) return;
  const room = online.room;
  if (online.quad) {
    const q = online.quad;
    if (q.lobby) room.send(snapQuad(quadInMatch() ? q.sess : null, q.lobby.r));
    return;
  }
  const inMatch = !!online.sync && !online.aiTakeover;
  const peer = room.peer ? specPlayer(room.peer) : null;
  room.send(snapDuo(room.role === 'host' ? 'host' : 'guest', specPlayer(myHello()), peer, online.start, inMatch ? match : null));
}

// ---------- 觀戰（觀眾這一邊） ----------
/** 觀眾：畫面下方是哪一隊（false = 標準視角：房主／A 隊在下方） */
let specFlip = false;

/** 以觀眾身分進房：沒有座位，照收到的訊息看比賽（src/net/spectate.ts） */
function spectateRoom(code: string): void {
  leaveOnline();
  unlockAudio();
  const room = new RoomClient(code, myHello);
  room.spectator = true;
  const spec = new Spectator(settings, (m) => room.send(m));
  online = { room, sync: null, waiting: false, wait: null, aiTakeover: false, pendingReturn: false, start: null, quad: null, spectator: spec, spectators: 0, pub: false };
  room.onStatus = (text, kind) => {
    const el = $('roomStatus');
    el.textContent = text;
    el.className = `room-status ${kind}`;
  };
  spec.onStatus = (t) => {
    room.onStatus(t, 'wait');
    renderSpectators();
  };
  spec.onNote = (t) => {
    if (mode === 'menu') room.onStatus(t, 'wait');
    else hud.intro(t, '');
  };
  spec.onMatch = (m, v) => enterSpectate(m, v);
  room.onSpectate = (msg) => {
    if (online?.room !== room) return;
    spec.receive(msg);
    if (msg.t === 'spec' || msg.t === 'welcome') renderSpectators();
  };
  room.onGiveUp = () => room.onStatus('連不上伺服器，請回到大廳再試一次', 'error');
  showLobby(code);
  room.connect();
}

/** 觀眾：比賽建好（或重建）了 → 換外觀、場地、記分板名字，開始看 */
function enterSpectate(m: Match, v: SpecView): void {
  const spec = online?.spectator;
  if (!spec || !online) return;
  endTutorial();
  cancelReplay();
  unlockAudio();
  match = m;
  bots = [];
  demoPlayer = null;
  tourCtx = null;
  drill = null;
  hud.drill = null;
  setupAssist(true); // 沒有輔助、沒有搖桿
  controls.scheme = settings.scheme;
  // 球衣：兩隊各穿自己（第一位真人）選的顏色，太像就把對方換成對比色
  const chr = (p: SpecView['players'][number]) => characterById(p.character);
  const teamColor = (ids: number[]): Colors => {
    const ps = ids.map((i) => v.players[i]).filter(Boolean);
    const h = ps.find((p) => !p.ai && p.shirt !== undefined);
    const base = chr(h ?? ps[0]);
    return { shirt: h?.shirt ?? base.shirt, shorts: h?.shorts ?? base.shorts };
  };
  const c0 = teamColor(v.doubles ? [0, 2] : [0]);
  let c1 = teamColor(v.doubles ? [1, 3] : [1]);
  const avoid = v.doubles ? [c0.shirt, shade(c0.shirt, -0.32)] : [c0.shirt];
  if (avoid.some((a) => tooClose(c1.shirt, a))) c1 = pickOppColor('random', avoid);
  const looks = v.players.map((p) => lookOf(chr(p), p.racket));
  renderer.setLooks(v.doubles ? teamLooks(looks, c0, c1) : [{ ...looks[0], ...c0 }, { ...looks[1], ...c1 }]);
  applyVenue(v.venue);
  renderer.setTarget(null);
  renderer.spectator = true;
  renderer.viewSide = specFlip ? -1 : 1;
  renderer.resize();
  hud.spectator = true;
  hud.teamNames = v.teamNames;
  hud.oppName = v.teamNames[1];
  hud.oppTag = '線上';
  clearTimeout(resultTimer);
  hitStop = 0;
  online.sync = spec;
  $('againBtn').style.display = 'none';
  $('touch').style.display = 'none';
  document.body.classList.add('spectating');
  acc = 0;
  setMode('play');
  renderSpectators();
  hud.intro(`觀戰：${v.teamNames[0]} vs ${v.teamNames[1]}`, `${VENUE_LABEL[v.venue]}・${v.points} 分${v.games > 1 ? '・三戰兩勝' : ''}`);
}
$('specFlipBtn').addEventListener('click', () => {
  if (!online?.spectator) return;
  specFlip = !specFlip;
  renderer.viewSide = specFlip ? -1 : 1;
  renderer.resize();
});
$('specLeaveBtn').addEventListener('click', () => toMenu());

// ---------- 遊戲大廳：公開房間的名單（每 3 秒拉一次） ----------
let lobbyTimer: number | undefined;
const MODE_LABEL: Record<LobbyRoom['mode'], string> = { singles: '單打', doubles: '雙打（AI 隊友）', quad: '雙打（4 人）' };

function openLobbyList(): void {
  $('online').classList.remove('show');
  $('lobby').classList.add('show');
  $('lobbyList').innerHTML = '<div class="lobby-empty">讀取中…</div>';
  $('lobbyStatus').textContent = '';
  void refreshLobby();
  window.clearInterval(lobbyTimer);
  lobbyTimer = window.setInterval(() => void refreshLobby(), 3000);
}
function closeLobbyList(): void {
  window.clearInterval(lobbyTimer);
  lobbyTimer = undefined;
  $('lobby').classList.remove('show');
}
async function refreshLobby(): Promise<void> {
  if (!$('lobby').classList.contains('show')) return;
  try {
    const res = await fetch(LOBBY_URL, { cache: 'no-store' });
    if (!res.ok) throw new Error(String(res.status));
    const data = (await res.json()) as { rooms?: LobbyRoom[] };
    if (!$('lobby').classList.contains('show')) return;
    renderLobby(Array.isArray(data.rooms) ? data.rooms : []);
    $('lobbyStatus').textContent = `${new Date().toLocaleTimeString('zh-TW', { hour12: false })} 更新`;
    $('lobbyStatus').className = 'room-status';
  } catch {
    $('lobbyStatus').textContent = '連不上伺服器，稍後再試';
    $('lobbyStatus').className = 'room-status error';
  }
}
function renderLobby(rooms: LobbyRoom[]): void {
  const box = $('lobbyList');
  if (!rooms.length) {
    box.innerHTML = '<div class="lobby-empty">目前沒有公開的房間。建立房間時選「公開到大廳」，朋友就能在這裡找到你。</div>';
    return;
  }
  const venueName = (v: string) => VENUE_LABEL[v as Venue] ?? v;
  box.innerHTML = rooms
    .map((r) => {
      const score = r.sc ? `${r.sc[0]} : ${r.sc[1]}${r.games > 1 && r.gm ? `（局 ${r.gm[0]} : ${r.gm[1]}）` : ''}` : '';
      const st = r.status === 'play' ? `<span class="st play">比賽中</span>${score}` : r.status === 'over' ? `<span class="st over">已結束</span>${score}` : '<span class="st wait">等待中</span>';
      const canJoin = r.players < r.cap && r.status !== 'play';
      return (
        `<div class="lobby-room${r.status === 'play' ? ' playing' : ''}" data-code="${esc(r.code)}">` +
        `<div class="code">${esc(r.code)}</div>` +
        `<div class="main">${esc(r.host)} 的房間・${MODE_LABEL[r.mode] ?? r.mode}</div>` +
        `<div class="acts"><button data-act="join" class="primary"${canJoin ? '' : ' disabled'}>加入</button><button data-act="spec">👀 觀戰</button></div>` +
        `<div class="sub">${st}　👤 ${r.players}/${r.cap}　👀 ${r.spectators}　${venueName(r.venue)}・${r.points} 分・${r.games > 1 ? '三戰兩勝' : '一局'}</div>` +
        `</div>`
      );
    })
    .join('');
}
$('lobbyBtn').addEventListener('click', openLobbyList);
$('lobbyBackBtn').addEventListener('click', () => {
  closeLobbyList();
  openOnline();
});
$('lobbyList').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  const row = (e.target as HTMLElement).closest<HTMLElement>('.lobby-room');
  if (!b || !row || b.disabled) return;
  const code = normalizeCode(row.dataset.code ?? '');
  if (code.length < 4) return;
  closeLobbyList();
  openOnline();
  if (b.dataset.act === 'join') joinRoom(code);
  else spectateRoom(code);
});
$('spectateBtn').addEventListener('click', () => {
  const code = normalizeCode(($('roomCodeInput') as HTMLInputElement).value);
  if (code.length < 4) {
    $('roomStatus').textContent = '房號是 4 個字';
    $('roomStatus').className = 'room-status error';
    return;
  }
  spectateRoom(code);
});

/** 右下角顯示連線延遲；順便更新「回到剛剛的房間」的時間 */
let rejoinSaveT = 0;
function updateNetInfo(dt: number): void {
  const sync = online?.sync;
  if (!sync || mode === 'menu') {
    if ($('netInfo').textContent) $('netInfo').textContent = '';
    return;
  }
  rejoinSaveT -= dt;
  if (rejoinSaveT <= 0 && online && online.room.inMatch) {
    rejoinSaveT = 15;
    saveRejoin({ code: online.room.code, cid: online.room.cid, cap: online.room.cap, t: Date.now() });
  }
  netInfoT -= dt;
  if (netInfoT > 0) return;
  netInfoT = 0.5;
  $('netInfo').textContent = online?.aiTakeover ? 'AI 代打中' : sync.rttMs ? `連線延遲 ${Math.round(sync.rttMs)} ms` : '';
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
  if (online) markRejoinLeft();
  leaveOnline();
  $('online').classList.remove('show');
  $('menu').classList.add('show');
  refreshRejoinBtn();
});
$('createRoomBtn').addEventListener('click', () => openSetup('create'));
$('onlinePickBtn').addEventListener('click', () => openSetup('join'));
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
/** 分享房號連結（手機叫出分享選單，電腦複製到剪貼簿） */
async function shareRoom(): Promise<void> {
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
    if (online.wait) {
      online.wait.text = '連結已複製，貼給對方就能回來';
      renderWait();
    }
  } catch {
    window.prompt('複製這個連結給朋友', url);
  }
}
$('shareRoomBtn').addEventListener('click', () => void shareRoom());

// ---------- 回到剛剛的房間（關掉分頁、手機睡著、不小心按了離開，10 分鐘內） ----------
function refreshRejoinBtn(): void {
  const r = loadRejoin();
  const b = $('rejoinBtn');
  const show = !!r && !online;
  b.style.display = show ? '' : 'none';
  if (r && show) b.textContent = `回到剛剛的房間 ${r.code}`;
}
/** 自己按了離開：紀錄留著（不小心按到還能回去），但回主選單只顯示按鈕、不自動回去 */
function markRejoinLeft(): void {
  const r = online ? loadRejoin(online.room.cid) : null;
  if (r && online && r.code === online.room.code) saveRejoin({ ...r, left: true, t: Date.now() });
}
$('rejoinBtn').addEventListener('click', () => {
  const r = loadRejoin();
  if (!r) return refreshRejoinBtn();
  openOnline();
  joinRoom(r.code, false, r);
});

// 從分享連結進來（?room=房號）：直接進房；?spectate=房號 = 直接觀戰；?lobby = 直接開遊戲大廳；
// 同一個分頁重新整理（比賽中斷線）→ 自動回到剛剛的房間
{
  const params = new URLSearchParams(location.search);
  const code = params.get('room');
  const specCode = params.get('spectate');
  const toLobby = params.get('lobby') !== null;
  const r = loadRejoin(peekClientId()); // 這個分頁自己的紀錄（重新整理前在房間裡）
  const strip = (...keys: string[]) => {
    for (const k of keys) params.delete(k);
    const rest = params.toString();
    history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : ''));
  };
  if (code) {
    strip('room');
    openOnline();
    joinRoom(normalizeCode(code), false, r && r.code === normalizeCode(code) ? r : null);
  } else if (specCode && normalizeCode(specCode).length >= 4) {
    strip('spectate');
    openOnline();
    spectateRoom(normalizeCode(specCode));
  } else if (toLobby) {
    strip('lobby');
    openOnline();
    openLobbyList();
  } else if (r && !r.left) {
    openOnline();
    joinRoom(r.code, false, r);
  } else refreshRejoinBtn();
}

// ---------- 2 人房：對手不在時 AI 接手、對手回來換回去 ----------
/** AI 在本機接手對手（變成對 AI，房間還開著，對手回來的話打完那一分就換回來）；這一分重新發球 */
function takeover2p(): void {
  if (!online?.sync) return;
  const diff = online.start?.difficulty ?? settings.difficulty;
  match.remote = null;
  bots[1] = new AIController(match, 1, diff);
  if (match.doubles) bots[3] = new AIController(match, 3, diff);
  match.resumePoint(match.score.slice() as [number, number], match.games.slice() as [number, number], match.server);
  online.aiTakeover = true;
  online.pendingReturn = false;
  hideWait();
  acc = 0;
  hud.oppTag = 'AI';
  hud.intro('AI 接手', '對手回來的話，打完那一分就換回來');
}

/** 對手回來了：AI 拿掉，對手那隊又由網路控制（AI 的跑速加成也拿掉） */
function undoTakeover2p(): void {
  if (!online) return;
  match.remote = 1;
  bots[1] = null;
  bots[3] = null;
  const s = match.settings;
  match.players[1].kit = buildKit(s.aiCharacter ?? 'allround', s.aiRacket ?? 'balance');
  if (match.doubles) match.players[3].kit = buildKit(s.ai2Character ?? 'allround', s.ai2Racket ?? 'balance');
  online.aiTakeover = false;
  online.pendingReturn = false;
  hud.oppTag = '線上';
}

/** 2 人房：由我帶對手回到比賽（他重新整理過網頁就先請他照這場的設定重建），從目前比分重新發球 */
function handBack2p(): void {
  if (!online?.sync) return;
  const room = online.room;
  if (room.peerMs === 0 && online.start) room.sendRejoinStart(online.start);
  if (online.aiTakeover) undoTakeover2p();
  const R = match.remote ?? 1;
  room.send({ t: 'resume', sc: [match.score[HUMAN], match.score[R]], gm: [match.games[HUMAN], match.games[R]], srv: match.server });
  match.resumePoint(match.score.slice() as [number, number], match.games.slice() as [number, number], match.server);
  room.dropped = false;
  resumed();
  sendLob(); // 大廳：又是比賽中了
}

/** 每幀（比賽推進後）：一分打完的空檔才做的事 —— 回來的人換回去（2 人：AI → 對手；4 人：AI 代打 → 還座位） */
function onlinePointBoundary(): void {
  if (!online?.sync) return;
  const ph = match.phase;
  if (ph !== 'point' && ph !== 'serve' && ph !== 'matchOver') return;
  if (online.pendingReturn) {
    if (ph === 'matchOver' || !online.room.peer) online.pendingReturn = false;
    else handBack2p();
  }
  const q = online.quad;
  if (q?.lobby && q.sess && q.pending.length && ph !== 'matchOver' && iLead()) {
    for (const h of q.pending) q.lobby.giveBack(h);
    q.pending = [];
    quadResumeAll();
  }
}

// ---------- 線上 4 人房（雙打 2 對 2） ----------
const newQuad = (): QuadState => ({ lobby: null, sess: null, missing: new Set(), pending: [] });
type Go4 = Extract<PeerMsg, { t: 'go' }>;
type Resume4 = Extract<PeerMsg, { t: 'resume4' }>;

/** 自己在 4 人房名單上的資料 */
function meHuman(): QuadHuman {
  const h = myHello();
  return { cid: online!.room.cid, name: h.name, character: h.character, racket: h.racket, shirt: h.shirt, shorts: h.shorts, mv: settings.moveMode, ready: false, on: true };
}
/** 房主建房時的規則 */
function quadCfg(): QuadCfg {
  return { points: settings.points, games: settings.games, venue: myHello().venue, difficulty: settings.difficulty, allManual: !!settings.allManual };
}
function sendQuadHello(): void {
  if (!online) return;
  const q = online.quad;
  const ms: 0 | 1 | 2 = quadInMatch() ? (online.room.dropped ? 1 : 2) : 0;
  online.room.send({ t: 'hello', v: PROTOCOL, ...myHello(), cid: online.room.cid, ms });
  if (q?.lobby && quadIsHost() && !quadInMatch()) {
    // 房主自己換了選手：直接改名單
    q.lobby.join({ ...meHuman(), ready: true }, false);
    broadcastLobby();
  }
}
function quadIsHost(): boolean {
  return !!online?.quad?.lobby && online.quad.lobby.r.host === online.room.cid;
}
function quadInMatch(): boolean {
  const q = online?.quad;
  return !!q?.sess && online!.sync === q.sess.sync && q.sess.match.phase !== 'matchOver';
}
/** 比賽中帶大家繼續的人：房主還在就是房主；房主斷線了 → 座位號碼最小、還連著的真人 */
function actingHost(): string | null {
  const q = online?.quad;
  const r = q?.lobby?.r;
  if (!q || !r) return null;
  if (!q.missing.has(r.host)) return r.host;
  for (let s = 0; s < 4; s++) {
    const x = r.seats[s];
    if (isHuman(x) && !q.missing.has(x.cid)) return x.cid;
  }
  return null;
}
/** 由我帶大家繼續（自己沒斷過線） */
function iLead(): boolean {
  return !!online && actingHost() === online.room.cid && !online.room.dropped;
}
function nameOf(cid: string): string {
  const s = online?.quad?.lobby?.r.seats.find((x) => isHuman(x) && x.cid === cid);
  return isHuman(s) ? s.name : '玩家';
}
function broadcastLobby(): void {
  const q = online?.quad;
  if (!q?.lobby || !online) return;
  online.room.send({ t: 'lobby', r: q.lobby.r });
  renderQuadLobby();
  sendLob(); // 房主換了選手（名字）也讓大廳知道
}

function onQuadMsg(room: RoomClient, msg: NetMsg): void {
  if (online?.room !== room) return;
  const q = (online.quad ??= newQuad());
  switch (msg.t) {
    case 'welcome':
      saveRejoin({ code: room.code, cid: room.cid, cap: 4, t: Date.now() });
      if (msg.spec !== undefined) setSpectators(msg.spec);
      if (!q.lobby && msg.role === 'host' && msg.peers === 0 && room.creator) {
        q.lobby = QuadLobby.create({ ...meHuman(), ready: true }, quadCfg());
        room.onStatus('房間建好了：把房號或連結傳給朋友（最多 4 人）', 'ok');
      } else if (!q.lobby) room.onStatus(msg.peers ? '連上了，等房主的名單…' : `房間 ${room.code} 目前沒有人（房主可能暫時離開，或房號打錯），等房主回來…`, 'wait');
      sendQuadHello();
      sendLob();
      if (quadInMatch() && online.wait?.self) {
        online.wait.text = '重新連上了，等大家繼續…';
        online.wait.gaveUp = false;
        renderWait();
      }
      renderQuadLobby();
      break;
    case 'full':
      room.onStatus('這個房間已經滿了（4 人）', 'error');
      break;
    case 'peer-left':
    case 'bye':
      if (msg.cid) quadPeerLeft(msg.cid, msg.t === 'bye');
      break;
    case 'hello':
      quadHello(msg);
      break;
    case 'lobby':
      // 名單以房主（比賽中：帶大家繼續的人）為準；大廳裡房主自己的最新
      if (!q.lobby || !quadIsHost() || quadInMatch()) q.lobby = new QuadLobby(clone(msg.r));
      if (!quadInMatch()) {
        const mine = q.lobby.seatOf(room.cid);
        room.onStatus(mine >= 0 ? (quadIsHost() ? '等朋友加入，人夠了就按開始' : '等房主開始…（可以換隊、按準備）') : '房間的座位滿了，或比賽進行中（等下一場）', 'wait');
      }
      renderQuadLobby();
      break;
    case 'seat':
      if (quadIsHost() && !quadInMatch() && q.lobby?.move(msg.cid, msg.to)) broadcastLobby();
      break;
    case 'ready':
      if (quadIsHost() && !quadInMatch() && q.lobby) {
        q.lobby.setReady(msg.cid, msg.r);
        broadcastLobby();
      }
      break;
    case 'go':
      quadGo(msg);
      break;
    case 'resume4':
      quadResume(msg);
      break;
    case 'peer-join':
    case 'rematch':
      break; // peer-join：等他的 hello
    case 'spec':
      setSpectators(msg.n);
      break;
    case 'spec-hello':
      sendSnap();
      break;
    case 'snap':
    case 'lob':
      break; // 只有觀眾／伺服器會收到
    default:
      if (q.sess && online.sync === q.sess.sync) q.sess.sync.receive(msg as PeerMsg);
  }
}

/**
 * 有人送 hello（進房、重新連上、重新整理後回來）：
 * 大廳 → 房主排座位；比賽中 → 帶大家繼續的人處理：原本的座位還在（等他回來）→ 人齊了就從目前比分繼續；
 * 座位被 AI 代打 → 這一分打完還給他；其他人 → 等下一場
 */
function quadHello(msg: Extract<PeerMsg, { t: 'hello' }>): void {
  const q = online!.quad!;
  const room = online!.room;
  if (msg.v !== PROTOCOL) {
    room.onStatus('有人的遊戲版本不同，請大家都重新整理網頁', 'error');
    return;
  }
  if (!msg.cid || !q.lobby) return;
  const h: QuadHuman = { cid: msg.cid, name: msg.name, character: msg.character, racket: msg.racket, shirt: msg.shirt, shorts: msg.shorts, mv: msg.mv ?? 'auto', ready: false, on: true };
  if (!quadInMatch()) {
    if (quadIsHost()) {
      q.lobby.join(h, false);
      broadcastLobby();
    } else if (msg.cid === q.lobby.r.host) room.send({ t: 'lobby', r: q.lobby.r }); // 房主（重新整理後）回來：把名單告訴他
    return;
  }
  if (!iLead()) return;
  const res = q.lobby.join(h, true);
  room.send({ t: 'lobby', r: q.lobby.r }); // 讓他知道名單（和現在誰是房主）
  if (res === 'back') {
    q.missing.delete(h.cid);
    if (q.missing.size === 0) quadResumeAll();
    else renderWait();
  } else if (res === 'return' && !q.pending.some((p) => p.cid === h.cid)) q.pending.push(h);
}

/** 有人斷線（離開）：大廳 = 空出座位；比賽中 = 大家先暫停，等他回來或由帶大家繼續的人讓 AI 代打 */
function quadPeerLeft(cid: string, bye: boolean): void {
  const q = online!.quad!;
  const room = online!.room;
  const r = q.lobby?.r;
  if (!r) return;
  if (!quadInMatch()) {
    if (quadIsHost()) {
      q.lobby!.leave(cid, false);
      broadcastLobby();
    } else if (cid === r.host) room.onStatus('房主離開了，等房主回來…', 'wait');
    renderQuadLobby();
    return;
  }
  const seat = q.lobby!.seatOf(cid);
  if (seat < 0) return; // 不在名單上（等下一場的人）或已經由 AI 代打
  q.missing.add(cid);
  (r.seats[seat] as QuadHuman).on = false;
  q.pending = q.pending.filter((p) => p.cid !== cid);
  const names = [...q.missing].map((c) => nameOf(c) + (c === r.host ? '（房主）' : '')).join('、');
  const w = online!.wait;
  showWait({ title: `${names} ${bye ? '離開了' : '斷線了'}`, until: w && !w.self && w.until !== null ? w.until : performance.now() + 20000, self: false });
}

/** 帶大家繼續的人按「AI 接手繼續」：斷線的人由 AI 代打（房主不在 → 我接手當房主，AI 由我模擬），從目前比分繼續 */
function quadTakeover(): void {
  const q = online?.quad;
  if (!q?.lobby || !q.sess || !iLead()) return;
  if (q.lobby.r.host !== online!.room.cid && q.missing.has(q.lobby.r.host)) q.lobby.setHost(online!.room.cid);
  for (const cid of q.missing) {
    const s = q.lobby.seatOf(cid);
    if (s >= 0) q.lobby.takeover(s);
  }
  q.missing.clear();
  quadResumeAll();
}

/** 帶大家從目前比分重新發球（新的 ep，伺服器裁決器跟著重設） */
function quadResumeAll(): void {
  const q = online?.quad;
  if (!q?.lobby || !q.sess || !online) return;
  const ep = q.sess.sync.ep + 1;
  const msg = q.sess.resumeMsg(q.lobby.r, ep);
  online.room.send({ t: 'arb', ep, q: 0 });
  online.room.send(msg);
  quadResume(msg);
}

/** 房主按開始：空位由 AI 補上，A 隊 0 號座位先發 */
function quadStart(): void {
  const q = online?.quad;
  if (!q?.lobby || !online || !quadIsHost()) return;
  if (q.lobby.humans() < 2) {
    online.room.onStatus('至少要 2 個人才能開始', 'error');
    return;
  }
  q.lobby.fillAi();
  const ep = (q.sess?.sync.ep ?? 0) + 1;
  const go: Go4 = { t: 'go', r: clone(q.lobby.r), ep, srv: 0 };
  online.room.send({ t: 'arb', ep, q: 0 });
  online.room.send(go);
  quadGo(go);
}

/** 再來一場：房主直接開下一場（不在的人由 AI 補）；其他人等房主 */
function quadRematch(): void {
  const q = online?.quad;
  if (!q?.lobby || !online) return;
  if (!quadIsHost()) {
    online.room.onStatus('等房主按「再來一場」…', 'wait');
    return;
  }
  q.lobby.r.seats.forEach((s, i) => {
    if (isHuman(s) && !s.on) q.lobby!.takeover(i);
  });
  quadStart();
}

function quadGo(msg: Go4): void {
  const q = online!.quad!;
  const room = online!.room;
  q.lobby = new QuadLobby(clone(msg.r));
  q.missing.clear();
  q.pending = [];
  const s = QuadSession.start(settings, msg, room.cid, (m) => room.send(m));
  if (!s) {
    room.onStatus('比賽開始了，你這場沒有座位（等下一場）', 'wait');
    renderQuadLobby();
    return;
  }
  enterQuadMatch(s);
  sendLob(); // 大廳：比賽中
  const mate = s.roster.seats[s.mySeat ^ 2];
  const opps = [s.mySeat ^ 1, s.mySeat ^ 3].map((i) => s.roster.seats[i]);
  const nm = (x: (typeof opps)[number]) => (isHuman(x) ? x.name : `AI（${characterById(x!.character).name}）`);
  hud.intro('線上雙打（4 人）', `隊友：${nm(mate)}｜對手：${opps.map(nm).join('、')}\n${seatTeam(msg.srv) === seatTeam(s.mySeat) ? '你們先發球' : '對手先發球'}`);
}

function quadResume(msg: Resume4): void {
  const q = online!.quad!;
  const room = online!.room;
  q.lobby = new QuadLobby(clone(msg.r));
  q.missing.clear();
  q.pending = q.pending.filter((p) => !msg.r.seats.some((s) => isHuman(s) && s.cid === p.cid));
  if (q.sess && q.sess.match === match && online!.sync === q.sess.sync && QuadSession.seatIn(msg.r, room.cid) === q.sess.mySeat) {
    q.sess.resume(msg);
    setupAssist(false, q.sess.roster.cfg.allManual ? 'manual' : undefined);
    applyQuadLooks(q.sess);
  } else {
    const s = QuadSession.fromResume(settings, msg, room.cid, (m) => room.send(m));
    if (!s) {
      room.onStatus('比賽進行中，你這場沒有座位（等下一場）', 'wait');
      renderQuadLobby();
      return;
    }
    enterQuadMatch(s);
  }
  room.dropped = false;
  room.inMatch = true;
  resumed();
  sendLob();
}

/** 進入一場 4 人比賽（開打、或斷線回來重建） */
let quadColors: { mine: Colors; theirs: Colors } | null = null;
function enterQuadMatch(s: QuadSession): void {
  const q = online!.quad!;
  const room = online!.room;
  endTutorial();
  unlockAudio();
  if (controls.isTouch || matchMedia('(pointer: coarse)').matches) document.documentElement.requestFullscreen?.().catch(() => {});
  q.sess = s;
  match = s.match;
  bots = s.bots;
  demoPlayer = null;
  tourCtx = null;
  drill = null;
  hud.drill = null;
  setupAssist(false, s.roster.cfg.allManual ? 'manual' : undefined);
  controls.scheme = settings.scheme;
  quadColors = null;
  applyQuadLooks(s);
  applyVenue(s.roster.cfg.venue);
  renderer.setTarget(null);
  hud.oppTag = '線上';
  clearTimeout(resultTimer);
  hitStop = 0;
  online!.sync = s.sync;
  // 自己搶先打的那一下沒被採用（隊友先打到、球先落地）：腳邊飄一行字
  s.sync.onUndo = (by) => {
    const me = match.players[HUMAN];
    const at = renderer.project(v3(me.pos.x, 2.3, me.pos.z));
    hud.note(by === null ? '球先落地了' : match.teamOf(by) === match.teamOf(HUMAN) ? '隊友先打到' : '對方先打到', at.x, at.y);
  };
  online!.aiTakeover = false;
  online!.pendingReturn = false;
  hideWait();
  room.inMatch = true;
  saveRejoin({ code: room.code, cid: room.cid, cap: 4, t: Date.now() });
  again = () => quadRematch();
  $('againBtn').style.display = '';
  acc = 0;
  setMode('play');
}

/** 4 人房的外觀：自己這隊穿我的顏色（隊友深一點），對手那隊穿他們第一位真人選的顏色（太像就換） */
function applyQuadLooks(s: QuadSession): void {
  const r = s.roster;
  const seatAt = (id: number) => r.seats[s.sync.seatOf(id as PlayerId)]!;
  if (!quadColors) {
    const mine = myColors(characterById(seatAt(0).character));
    const oppH = [seatAt(1), seatAt(3)].find((x) => isHuman(x) && x.shirt !== undefined) as QuadHuman | undefined;
    const c1 = characterById(seatAt(1).character);
    let theirs: Colors = oppH ? { shirt: oppH.shirt!, shorts: oppH.shorts ?? c1.shorts } : { shirt: c1.shirt, shorts: c1.shorts };
    const avoid = [mine.shirt, shade(mine.shirt, -0.32)];
    if (avoid.some((a) => tooClose(theirs.shirt, a))) theirs = pickOppColor('random', avoid);
    quadColors = { mine, theirs };
  }
  renderer.setLooks(
    teamLooks(
      [0, 1, 2, 3].map((id) => lookOf(characterById(seatAt(id).character), seatAt(id).racket)),
      quadColors.mine,
      quadColors.theirs,
    ),
  );
  hud.oppName = [seatAt(1), seatAt(3)].map((x) => (isHuman(x) ? x.name : 'AI')).join('＋');
}

/** 4 人房大廳：兩隊各兩個座位（名字、球員、跑位、準備），換座位、AI 補位、開始 */
function renderQuadLobby(): void {
  const box = $('quadLobby');
  const q = online?.quad;
  if (!q?.lobby || !online) {
    box.style.display = 'none';
    return;
  }
  box.style.display = '';
  $('onlinePickBtn').style.display = '';
  const r = q.lobby.r;
  const my = online.room.cid;
  const host = r.host === my;
  const mySeat = q.lobby.seatOf(my);
  const playing = quadInMatch();
  const seatHtml = (i: number) => {
    const s = r.seats[i];
    const cls = ['quad-seat'];
    let body: string;
    if (isHuman(s)) {
      if (s.cid === my) cls.push('me');
      const tags = [
        s.cid === my ? '<span class="tg">你</span>' : '',
        s.cid === r.host ? '<span class="tg">房主</span>' : '',
        !s.on ? '<span class="tg off">離線</span>' : s.ready || s.cid === r.host ? '<span class="tg ok">準備好了</span>' : '<span class="tg">還沒準備</span>',
      ].join('');
      body = `<span class="nm">${esc(s.name)}</span><span class="tags">${tags}</span><span class="sub">${esc(characterById(s.character).name)}・${esc(racketById(s.racket).name)}</span><span class="sub">跑位：${MOVE_LABEL[r.cfg.allManual ? 'manual' : s.mv] ?? '自動'}</span>`;
    } else if (isAi(s)) {
      body = `<span class="nm">🤖 AI 補位</span><span class="sub">${esc(characterById(s.character).name)}・${esc(racketById(s.racket).name)}</span>`;
      if (host && !playing) body += `<button data-act="ai" data-seat="${i}">改回空位</button>`;
      if (!playing && mySeat >= 0) body += `<button data-act="move" data-seat="${i}">換到這裡</button>`;
    } else {
      cls.push('empty');
      body = '<span class="nm">空位</span><span class="sub">等人加入</span>';
      if (host && !playing) body += `<button data-act="ai" data-seat="${i}">AI 補位</button>`;
      if (!playing && mySeat >= 0) body += `<button data-act="move" data-seat="${i}">換到這裡</button>`;
    }
    return `<div class="${cls.join(' ')}" data-seat="${i}">${body}</div>`;
  };
  const team = (t: number) => `<div class="quad-team" data-team="${t}"><div class="quad-team-title">${TEAM_NAMES[t]}</div>${seatHtml(t)}${seatHtml(t + 2)}</div>`;
  const c = r.cfg;
  const humans = q.lobby.humans();
  let html = `<div class="quad-teams">${team(0)}${team(1)}</div><p class="quad-cfg">${c.points} 分・${c.games > 1 ? '三戰兩勝' : '一局'}・${VENUE_LABEL[c.venue]}・AI ${DIFF_LABEL[c.difficulty]}${c.allManual ? '・全員手動跑位' : ''}</p>`;
  if (!playing) {
    if (host) html += `<button id="quadStartBtn" class="primary"${humans < 2 ? ' disabled' : ''}>${humans < 2 ? '至少 2 人才能開始' : r.seats.some((x) => !x) ? '開始（空位由 AI 補上）' : '開始比賽'}</button>`;
    else if (mySeat >= 0) {
      const me = r.seats[mySeat] as QuadHuman;
      html += `<button id="quadReadyBtn"${me.ready ? '' : ' class="primary"'}>${me.ready ? '取消準備' : '準備好了'}</button>`;
    }
  }
  box.innerHTML = html;
}
$('quadLobby').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button');
  const q = online?.quad;
  if (!b || !q?.lobby || !online) return;
  const room = online.room;
  const my = room.cid;
  if (b.id === 'quadStartBtn') return quadStart();
  if (b.id === 'quadReadyBtn') {
    const s = q.lobby.seatOf(my);
    if (s < 0) return;
    const me = q.lobby.r.seats[s] as QuadHuman;
    me.ready = !me.ready;
    room.send({ t: 'ready', cid: my, r: me.ready });
    renderQuadLobby();
    return;
  }
  const seat = Number(b.dataset.seat);
  if (b.dataset.act === 'ai' && quadIsHost()) {
    if (q.lobby.toggleAi(seat)) broadcastLobby();
  } else if (b.dataset.act === 'move') {
    if (quadIsHost()) {
      if (q.lobby.move(my, seat)) broadcastLobby();
    } else room.send({ t: 'seat', cid: my, to: seat });
  }
});

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
  cancelReplay();
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
  renderer.setLooks([{ ...me, ...myColors(me), racketColor: racketById(settings.racket).color, racket: settings.racket }, { shirt: 0x8a96a8, shorts: 0x2a2f38 }]);
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
  if (tutorial.done) startSelected();
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

// ---------- 球種說明（設定、暫停畫面都可以打開） ----------
for (const [panelSel, beforeId] of [
  ['#settings .panel', 'settingsDoneBtn'],
  ['#pause .panel', 'menuBtn'],
] as const) {
  const panel = document.querySelector(panelSel);
  if (!panel) continue;
  const b = document.createElement('button');
  b.textContent = '📖 球種說明';
  b.className = 'guide-btn';
  b.addEventListener('click', () => openGuide(settings.scheme));
  panel.insertBefore(b, document.getElementById(beforeId));
}

// ---------- 跑位：自動的「預判起步」、輔助跑位 ----------
function incomingToMe(): boolean {
  const sh = match.shuttle;
  return sh.mode === 'flight' && sh.lastHitter !== null && match.teamOf(sh.lastHitter) !== match.teamOf(HUMAN);
}

/**
 * 自動跑位的預判：對手擊球前 preWindow 秒內～擊球後 window 秒內，左手往某方向按住拖。
 * 方向跟這一球要跑的方向差不多（60° 內）→ 立刻起步；猜錯 → 多等一下。沒拖 = 照平常的反應時間。
 */
function anticipate(): void {
  if (!assist || !incomingToMe()) {
    read = null;
    return;
  }
  const A = GAME.anticipation;
  if (read?.serial !== match.hitSerial) read = { serial: match.hitSerial, t0: performance.now(), done: false };
  if (read.done) return;
  const target = assist.planTarget();
  const lean = controls.lean;
  const now = performance.now();
  const age = (now - read.t0) / 1000;
  if (!lean || lean.since < read.t0 - A.preWindow * 1000) {
    if (age > A.window) read.done = true; // 沒預判（或拖太早、一直按著不算）
    return;
  }
  if (!target) return;
  read.done = true;
  const me = match.players[HUMAN];
  const dx = target.x - me.pos.x;
  const dz = target.z - me.pos.z;
  const d = Math.hypot(dx, dz);
  if (d < 0.5) return; // 球就打在身邊，不用跑
  // 自己視角 → 世界座標
  const lx = me.side * lean.x;
  const lz = -me.side * lean.y;
  const ok = (lx * dx + lz * dz) / d > 0.5;
  if (ok) assist.startNow();
  else assist.delay(A.wrongPenalty);
  const at = renderer.project(v3(me.pos.x, 2.3, me.pos.z));
  hud.readFeedback(ok, at.x, at.y);
  if (ok) buzz(10);
}

/**
 * 輔助跑位：玩家自己推搖桿。這一球分給自己時，只要推的方向跟最佳位置差不多（約 70° 內），
 * 就改用電腦算的路線（對準、剛好停住）；推過一次就幫忙跑完這一球，除非往別的方向推。
 * 沒有球要接、又沒推搖桿 → 自動回位（單打回中間、雙打照陣型）。
 */
function steerAssist(mine: PlayerInput, a: PlayerInput): void {
  const pm = Math.hypot(mine.moveX, mine.moveY);
  const am = Math.hypot(a.moveX, a.moveY);
  const target = incomingToMe() ? assist?.planTarget() : null;
  if (target) {
    const agree = pm > 0.2 && am > 0.05 && (mine.moveX * a.moveX + mine.moveY * a.moveY) / (pm * am) > 0.3;
    if (agree) engaged = match.hitSerial;
    if (agree || (pm < 0.2 && engaged === match.hitSerial)) {
      mine.moveX = a.moveX;
      mine.moveY = a.moveY;
    } else if (pm >= 0.2) engaged = -1; // 往別的方向推：聽玩家的
    return;
  }
  if (pm < 0.15) {
    mine.moveX = a.moveX * 0.85;
    mine.moveY = a.moveY * 0.85;
  }
}

// ---------- 線上：斷線暫停（不會把人踢出去）、重連後繼續 ----------
/** 暫停比賽，顯示等待面板（倒數完不會自動結束，改成一直等，讓玩家自己選） */
function showWait(w: WaitState): void {
  if (!online) return;
  online.wait = w;
  online.waiting = true;
  hud.notice(null);
  renderWait();
}

function hideWait(): void {
  if (online) {
    online.wait = null;
    online.waiting = false;
  }
  $('netWait').classList.remove('show');
}

/** 可以按「AI 接手繼續」：2 人房一定可以；4 人房只有帶大家繼續的人（AI 由他的手機模擬） */
function canTakeover(): boolean {
  if (!online?.sync) return false;
  if (!online.quad) return true;
  return iLead() && online.room.connected;
}

function renderWait(): void {
  const w = online?.wait;
  if (!online || !w) return;
  const left = w.until === null ? 0 : Math.ceil((w.until - performance.now()) / 1000);
  if (w.until !== null && left <= 0) w.until = null; // 倒數完：不會把人踢出去，改成一直等
  $('netWait').classList.toggle('show', mode === 'play' || mode === 'paused');
  $('netWaitTitle').textContent = w.title;
  const code = online.room.code;
  let text = w.text ?? (w.until !== null ? `等他回來… ${left}` : `繼續等待中：用房號 ${code}（或分享的連結）就能回來`);
  if (online.quad && !w.self && !canTakeover()) {
    const lead = actingHost();
    text += lead ? `\n要不要讓 AI 代打由${nameOf(lead)}決定` : '';
  }
  $('netWaitText').textContent = text;
  $('netWaitCode').textContent = code;
  const indefinite = !w.self && w.until === null;
  $('netWaitCodeBox').style.display = indefinite ? '' : 'none';
  $('netWaitAi').style.display = canTakeover() ? '' : 'none';
  $('netWaitKeep').style.display = w.gaveUp || (!w.self && w.until !== null) ? '' : 'none';
  $('netWaitKeep').textContent = w.gaveUp ? '重試' : '繼續等待';
  $('netWaitShare').style.display = indefinite ? '' : 'none';
}

$('netWaitAi').addEventListener('click', () => {
  if (!online) return;
  if (online.quad) quadTakeover();
  else takeover2p();
});
$('netWaitKeep').addEventListener('click', () => {
  const w = online?.wait;
  if (!w || !online) return;
  if (w.gaveUp) {
    w.gaveUp = false;
    w.text = '重新連線中…';
    online.room.retry();
  } else w.until = null; // 不限時間等下去
  renderWait();
});
$('netWaitShare').addEventListener('click', () => void shareRoom());
$('netWaitLeave').addEventListener('click', () => {
  markRejoinLeft();
  toMenu();
});

/** 斷線後重新連上、從目前比分重新發球 */
function resumed(): void {
  if (!online) return;
  hideWait();
  acc = 0;
  hud.notice(null);
  hud.intro('繼續比賽', '從目前比分重新發球');
}

/** 每幀：斷線等待中暫停比賽，更新倒數 */
let waitRenderT = 0;
function onlineWaitTick(_dt: number): boolean {
  if (!online?.sync || !online.waiting) return false;
  const now = performance.now();
  if (now - waitRenderT > 250) {
    waitRenderT = now;
    renderWait();
  }
  return true;
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) online?.room.wake();
});

// ---------- 背景音樂選曲（設定畫面；一選就換成那首，可以試聽） ----------
import { MUSIC_TRACKS } from './audio';
{
  const choices: [MatchSettings['musicTrack'], string, string][] = [
    ['auto', '依場地自動', '每個場地自己的撥弦曲風（櫻花園都節音階、市場宮調輪指、海灘反拍刷弦…）'],
    ...MUSIC_TRACKS.map((t): [MatchSettings['musicTrack'], string, string] => [t.id, t.name, t.desc]),
  ];
  if (!choices.some(([id]) => id === settings.musicTrack)) settings.musicTrack = 'auto'; // 舊存檔／拿掉的曲目
  music.setTrack(settings.musicTrack);

  const panel = document.querySelector('#settings .panel');
  if (panel) {
    const row = document.createElement('div');
    row.className = 'row music-pick';
    const label = document.createElement('label');
    label.textContent = '背景音樂';
    label.htmlFor = 'musicTrackSel';
    const sel = document.createElement('select');
    sel.id = 'musicTrackSel';
    for (const [id, name] of choices) sel.add(new Option(name, id, false, id === settings.musicTrack));
    const tryBtn = document.createElement('button');
    tryBtn.type = 'button';
    tryBtn.className = 'music-try';
    tryBtn.textContent = '▶ 試聽';
    const ctl = document.createElement('div');
    ctl.className = 'music-pick-ctl';
    ctl.append(sel, tryBtn);
    row.append(label, ctl);
    const hint = document.createElement('p');
    hint.className = 'hint-line music-hint';
    const showHint = () => (hint.textContent = choices.find(([id]) => id === sel.value)?.[2] ?? '');
    showHint();
    sel.addEventListener('change', () => {
      settings.musicTrack = sel.value as MatchSettings['musicTrack'];
      saveSettings();
      showHint();
      unlockAudio();
      music.setTrack(settings.musicTrack); // 選單本來就有音樂：馬上換成這首從頭播
      if (!settings.music) music.preview(); // 音樂關著：試聽 20 秒
    });
    tryBtn.addEventListener('click', () => {
      unlockAudio();
      music.preview(); // 從頭播（音樂關著也播 20 秒）
    });
    // 放在「音樂 開／關」那一列下面；找不到就放「完成」前面；再找不到就放最後
    const musicRow = panel.querySelector('.seg[data-key="music"]')?.closest('.row');
    const done = document.getElementById('settingsDoneBtn');
    if (musicRow) musicRow.after(row, hint);
    else if (done && panel.contains(done)) done.before(row, hint);
    else panel.append(row, hint);
    done?.addEventListener('click', () => music.endPreview());
  }
}
