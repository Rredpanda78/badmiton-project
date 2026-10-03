// 球衣顏色：比賽設定裡「你的顏色」「對手顏色」的色盤，還有「兩個顏色是不是太像」的判斷。

export interface ShirtColor {
  id: string;
  name: string;
  shirt: number;
  shorts: number;
}

/** 色盤（前五個 = 五位球員原本的球衣色） */
export const SHIRT_COLORS: ShirtColor[] = [
  { id: 'blue', name: '藍', shirt: 0x2f7fe0, shorts: 0x1b2a44 },
  { id: 'red', name: '紅', shirt: 0xe0483a, shorts: 0x3a1b1b },
  { id: 'pink', name: '粉紅', shirt: 0xf27fb0, shorts: 0x5a2340 },
  { id: 'orange', name: '橘', shirt: 0xf2a23a, shorts: 0x4a3010 },
  { id: 'green', name: '綠', shirt: 0x34c38f, shorts: 0x14402f },
  { id: 'purple', name: '紫', shirt: 0x8a5cf0, shorts: 0x2a1c4a },
  { id: 'yellow', name: '黃', shirt: 0xf2d43a, shorts: 0x3a3412 },
  { id: 'white', name: '白', shirt: 0xeef1f4, shorts: 0x2a2f38 },
];

export const colorById = (id: string | undefined): ShirtColor | undefined => SHIRT_COLORS.find((c) => c.id === id);

export const hexCss = (c: number) => '#' + c.toString(16).padStart(6, '0');

/** 兩個顏色的差距（加權 RGB，0 ～ 約 765；人眼對綠色比較敏感） */
export function colorDist(a: number, b: number): number {
  const ar = (a >> 16) & 255;
  const ag = (a >> 8) & 255;
  const ab = a & 255;
  const br = (b >> 16) & 255;
  const bg = (b >> 8) & 255;
  const bb = b & 255;
  const rm = (ar + br) / 2;
  const dr = ar - br;
  const dg = ag - bg;
  const db = ab - bb;
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

/** 太像（場上分不出兩隊）：同色或非常接近 */
export const tooClose = (a: number, b: number) => colorDist(a, b) < 150;

/** 顏色往黑（k<0）或往白（k>0）調 */
export function shade(c: number, k: number): number {
  const ch = (v: number) => Math.round(k < 0 ? v * (1 + k) : v + (255 - v) * k);
  return (ch((c >> 16) & 255) << 16) | (ch((c >> 8) & 255) << 8) | ch(c & 255);
}

/**
 * 對手（隊）的顏色：choice = 色盤 id 或 'random'。
 * 跟 avoid 裡任何一個顏色太像就不用（選到太像的也自動換一個）；random 從還能用的顏色裡隨機挑。
 */
export function pickOppColor(choice: string, avoid: number[], rand: () => number = Math.random): ShirtColor {
  const ok = (c: ShirtColor) => avoid.every((a) => !tooClose(c.shirt, a));
  const fixed = colorById(choice);
  if (fixed && ok(fixed)) return fixed;
  // 隨機：優先挑對比明顯的（差距 ≥ 220），沒有才放寬到「不會太像」
  let pool = SHIRT_COLORS.filter((c) => avoid.every((a) => colorDist(c.shirt, a) >= 220));
  if (!pool.length) pool = SHIRT_COLORS.filter(ok);
  if (!pool.length) {
    // 理論上不會發生：挑跟所有 avoid 差最多的
    pool = [...SHIRT_COLORS].sort((x, y) => Math.min(...avoid.map((a) => colorDist(y.shirt, a))) - Math.min(...avoid.map((a) => colorDist(x.shirt, a)))).slice(0, 1);
  }
  return pool[Math.floor(rand() * pool.length)];
}
