// 所有長度單位為公尺、時間為「模擬秒」。手感調整集中在這個檔案。

export const COURT = {
  halfLength: 6.7, // 底線到網
  singlesHalfWidth: 2.59, // 單打邊線
  doublesHalfWidth: 3.05, // 雙打邊線（只畫線）
  shortService: 1.98, // 前發球線到網
  doublesLongService: 5.94, // 雙打後發球線到網（只畫線）
  netTop: 1.524,
  postTop: 1.55,
};

export const PHYS = {
  g: 9.81,
  // 真實羽球終端速度約 6.7 m/s；稍微調大讓球飛得遠一點、手感較好
  terminalVel: 8.0,
  dt: 1 / 120,
};
export const DRAG_K = PHYS.g / (PHYS.terminalVel * PHYS.terminalVel);

export const GAME = {
  // 模擬時間 = 真實時間 × simSpeed（真實羽球太快，放慢才能反應）
  simSpeed: 0.62,

  // 蓄力：從 0 到滿所需的模擬秒數。蓄力值 c ∈ [0,1] 線性對應「落點越過網子的深度」
  chargeTime: 0.65,
  depthAtZero: -0.6, // 蓄力 0 → 落在網前 0.6 m（掛網）
  depthAtFull: 7.6, // 蓄力滿 → 超過底線 0.9 m（出界）。好球區約佔蓄力條 75%

  // 球速：殺球／撲球／下壓維持原速，其他球的飛行時間縮短為 1/ballSpeedMul
  ballSpeedMul: 1.5,
  killMaxSpeed: 16, // 網前撲球初速上限（m/s），避免近網撲殺快到無法反應

  // 擊球判定
  reach: 1.15, // 水平可及距離
  reachMinY: 0.05,
  reachMaxY: 2.85,
  swingWindow: 0.2, // 划動後這段時間內羽球進入範圍就會擊中
  swingDuration: 0.32,
  whiffRecover: 0.15,
  highZoneY: 2.0, // 以上算「高點」（高遠/殺/切）

  // 移動
  moveSpeed: 6.4,
  moveAccel: 42,
  chargeMoveMul: 0.65,
  swingMoveMul: 0.35,

  serveContactY: 0.95,
  pointPause: 1.8,
};

/**
 * 蓄力曲線：前段上升快（小力很快就有）、後段慢（深球比較好控制）。
 * c = 1 - (1 - t/T)^1.8
 */
const CHARGE_EXP = 1.8;
export function chargeFromTime(t: number): number {
  const u = Math.min(1, Math.max(0, t / GAME.chargeTime));
  return 1 - Math.pow(1 - u, CHARGE_EXP);
}
export function timeForCharge(c: number): number {
  return GAME.chargeTime * (1 - Math.pow(1 - Math.min(1, Math.max(0, c)), 1 / CHARGE_EXP));
}

export type Difficulty = 'easy' | 'normal' | 'hard';

export interface MatchSettings {
  difficulty: Difficulty;
  points: 11 | 21;
  games: 1 | 3;
  landingHint: boolean;
}

export const DEFAULT_SETTINGS: MatchSettings = {
  difficulty: 'normal',
  points: 11,
  games: 1,
  landingHint: true,
};
