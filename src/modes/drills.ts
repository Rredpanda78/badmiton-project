// 訓練關卡：發球機（對面）一直餵同一種球，練一種手勢。每關 10 球，3 星評分。
import { COURT } from '../config';
import type { Match, MatchEvent } from '../sim/match';
import type { Family } from '../sim/shots';

export interface DrillTarget {
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

interface FeedSpec {
  from: { x: number; y: number; z: number };
  family: Family;
  depth: number;
  aimX: number;
  playerAt?: { x: number; z: number };
}

export interface Drill {
  id: string;
  name: string;
  goal: string; // 一句話說明要做什麼
  how: string; // 手勢提示（蓄力划動）
  howTap: string; // 手勢提示（點擊滑放）
  reps: number;
  stars: [number, number, number]; // 1/2/3 星需要的成功數
  target: DrillTarget | null; // 對面要打進的區域（世界座標）
  feed: (rnd: () => number) => FeedSpec;
  judge: (name: string, land: { x: number; z: number }) => { ok: boolean; msg: string };
}

const W = COURT.singlesHalfWidth;
const L = COURT.halfLength;
const r = (rnd: () => number, a: number, b: number) => a + (b - a) * rnd();
const depthOf = (p: { z: number }) => Math.abs(p.z);

/** 對面發一顆高球到自己半場 */
const liftTo = (rnd: () => number, depth: [number, number]): FeedSpec => ({
  from: { x: r(rnd, -1.2, 1.2), y: 0.9, z: -r(rnd, 1.6, 2.6) },
  family: 'up',
  depth: r(rnd, depth[0], depth[1]),
  aimX: r(rnd, -0.6, 0.6),
  playerAt: { x: 0, z: 3.7 },
});

export const DRILLS: Drill[] = [
  {
    id: 'clear',
    name: '高遠球',
    goal: '把高球打到對面後場（黃色區）',
    how: '往上划，蓄力到深綠色',
    howTap: '點兩下按住，往上滑放開',
    reps: 10,
    stars: [5, 7, 9],
    target: { x0: -W, x1: W, z0: -L, z1: -(L - 1.7) },
    feed: (rnd) => liftTo(rnd, [4.6, 6.2]),
    judge: (name, p) => {
      if (name !== '高遠球' && name !== '平高球' && name !== '挑球') return { ok: false, msg: '要打高遠球' };
      return depthOf(p) >= L - 1.7 ? { ok: true, msg: '漂亮的深球！' } : { ok: false, msg: '不夠深' };
    },
  },
  {
    id: 'smash',
    name: '殺球',
    goal: '把高球殺進對面場內',
    how: '往下划，蓄力多一點；站到球的落點下方',
    howTap: '用「殺」搖桿往下滑放開；站到球的落點下方',
    reps: 10,
    stars: [5, 7, 9],
    target: { x0: -W, x1: W, z0: -L, z1: 0 },
    feed: (rnd) => liftTo(rnd, [3.4, 4.8]),
    judge: (name) =>
      name === '殺球' || name === '跳殺' || name === '機會殺球' || name === '下壓' || name === '撲球' || name === '跳撲'
        ? { ok: true, msg: '殺得好！' }
        : { ok: false, msg: name === '切球' ? '那是切球，要殺球' : '要殺球' },
  },
  {
    id: 'net',
    name: '網前放小球',
    goal: '把網前球輕輕放回對面網前（黃色區）',
    how: '往下划、蓄力少一點點',
    howTap: '點一下按住，往下滑放開',
    reps: 10,
    stars: [5, 7, 9],
    target: { x0: -W, x1: W, z0: -2.4, z1: 0 },
    feed: (rnd) => ({
      from: { x: r(rnd, -1.2, 1.2), y: 1.0, z: -r(rnd, 1.2, 2.0) },
      family: 'down',
      depth: r(rnd, 1.3, 2.0),
      aimX: r(rnd, -0.4, 0.4),
      playerAt: { x: 0, z: 2.5 },
    }),
    judge: (name, p) => {
      if (name !== '放網' && name !== '切球' && name !== '推球') return { ok: false, msg: '要放小球' };
      return depthOf(p) <= 2.4 ? { ok: true, msg: '貼網！' } : { ok: false, msg: '太深了' };
    },
  },
  {
    id: 'defend',
    name: '接殺球',
    goal: '把對面的殺球接回場內',
    how: '一看到殺球就按住；來球快，輕輕一划就能擋回去',
    howTap: '點一下按住，往上滑放開挑回去',
    reps: 10,
    stars: [4, 6, 8],
    target: { x0: -W, x1: W, z0: -L, z1: 0 },
    feed: (rnd) => ({
      from: { x: r(rnd, -1.5, 1.5), y: 2.6, z: -r(rnd, 3.8, 5.0) },
      family: 'down',
      depth: r(rnd, 3.6, 4.4),
      aimX: r(rnd, -0.35, 0.35),
      playerAt: { x: 0, z: 4.0 },
    }),
    judge: () => ({ ok: true, msg: '接起來了！' }),
  },
  {
    id: 'drive',
    name: '平抽',
    goal: '把平球抽回對面中後場（黃色區）',
    how: '往左或往右划',
    howTap: '按住往左或往右滑放開',
    reps: 10,
    stars: [5, 7, 9],
    target: { x0: -W, x1: W, z0: -L, z1: -3.4 },
    feed: (rnd) => ({
      from: { x: r(rnd, -1.5, 1.5), y: 1.3, z: -r(rnd, 3.0, 4.0) },
      family: 'side',
      depth: r(rnd, 3.4, 4.6),
      aimX: r(rnd, -0.7, 0.7),
      playerAt: { x: 0, z: 3.6 },
    }),
    judge: (name, p) => {
      if (name !== '平抽' && name !== '平高球') return { ok: false, msg: '要平抽' };
      return depthOf(p) >= 3.4 ? { ok: true, msg: '又平又快！' } : { ok: false, msg: '太短了' };
    },
  },
  {
    id: 'jump',
    name: '跳殺',
    goal: '用跳殺把高球殺進場內',
    how: '點一下再按住，起跳後約 0.35 秒往下划',
    howTap: '「殺」搖桿點一下再按住，起跳後往下滑放開',
    reps: 10,
    stars: [4, 6, 8],
    target: { x0: -W, x1: W, z0: -L, z1: 0 },
    feed: (rnd) => liftTo(rnd, [3.8, 5.2]),
    judge: (name) => (name === '跳殺' || name === '跳撲' ? { ok: true, msg: '跳殺！' } : { ok: false, msg: '要跳殺' }),
  },
];

export interface RepResult {
  ok: boolean;
  msg: string;
}

/** 跑一個訓練關卡：等待 → 餵球 → 等落地判定 → 下一球 */
export class DrillRunner {
  rep = 0;
  ok = 0;
  done = false;
  private wait = 1.0;
  private lastHit: string | null = null;

  constructor(
    private match: Match,
    readonly drill: Drill,
    private onRep: (r: RepResult) => void,
    private onDone: (ok: number, stars: number) => void,
  ) {}

  /** 每幀呼叫（真實秒） */
  tick(dt: number): void {
    if (this.done || this.match.phase !== 'drill') return;
    this.wait -= dt;
    if (this.wait > 0) return;
    if (this.rep >= this.drill.reps) {
      this.done = true;
      const s = this.drill.stars;
      this.onDone(this.ok, this.ok >= s[2] ? 3 : this.ok >= s[1] ? 2 : this.ok >= s[0] ? 1 : 0);
      return;
    }
    this.rep++;
    this.lastHit = null;
    this.match.feed(this.drill.feed(() => this.match.rng.next()));
    this.wait = 0.55;
  }

  onEvent(e: MatchEvent): void {
    if (e.type === 'hit' && e.player === 0) this.lastHit = e.name;
    if (e.type !== 'drillLand') return;
    let r: RepResult;
    if (!this.lastHit || e.hitter !== 0) r = { ok: false, msg: '沒接到' };
    else if (e.net) r = { ok: false, msg: '掛網' };
    else if (!e.inBounds) r = { ok: false, msg: '出界' };
    else r = this.drill.judge(this.lastHit, e.pos);
    if (r.ok) this.ok++;
    this.onRep(r);
  }
}

/** 每關最佳星數（存在瀏覽器） */
export function loadBest(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem('badminton.drills') ?? '{}');
  } catch {
    return {};
  }
}
export function saveBest(id: string, stars: number): void {
  const b = loadBest();
  if ((b[id] ?? 0) >= stars) return;
  b[id] = stars;
  try {
    localStorage.setItem('badminton.drills', JSON.stringify(b));
  } catch {
    /* ignore */
  }
}
