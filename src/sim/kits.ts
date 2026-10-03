// 球員特質與球拍：每個都有長處也有代價，沒有「純升級」，比的還是技術。

/** 球種分組（球速倍率用） */
export type ShotGroup = 'smash' | 'drop' | 'push' | 'clear';

export function shotGroup(name: string): ShotGroup {
  if (name === '殺球' || name === '跳殺' || name === '下壓' || name === '跳撲' || name === '撲球') return 'smash';
  if (name === '切球' || name === '放網' || name === '發小球') return 'drop';
  if (name === '推球' || name === '平抽' || name === '平快發球') return 'push';
  return 'clear';
}

export interface Kit {
  /** 各組球的飛行速度倍率（同一條軌跡跑得更快） */
  speed: Record<ShotGroup, number>;
  move: number; // 跑速倍率
  accel: number; // 起步加速倍率
  window: number; // 揮拍可擊中時間倍率（越大越好打到）
  accuracy: number; // 落點誤差倍率（越小越準）
}

export interface Character {
  id: string;
  name: string;
  title: string;
  desc: string;
  shirt: number;
  shorts: number;
  kit: Partial<Omit<Kit, 'speed'>> & { speed?: Partial<Record<ShotGroup, number>> };
}

export interface Racket {
  id: string;
  name: string;
  desc: string;
  color: number;
  kit: Partial<Omit<Kit, 'speed'>> & { speed?: Partial<Record<ShotGroup, number>> };
}

export const CHARACTERS: Character[] = [
  {
    id: 'allround',
    name: '全能型',
    title: '均衡',
    desc: '沒有弱點，什麼都會一點',
    shirt: 0x2f7fe0,
    shorts: 0x1b2a44,
    kit: {},
  },
  {
    id: 'power',
    name: '重砲手',
    title: '殺球專精',
    desc: '殺球更快；跑得慢一點',
    shirt: 0xe0483a,
    shorts: 0x3a1b1b,
    kit: { speed: { smash: 1.12 }, move: 0.96, accel: 0.94 },
  },
  {
    id: 'touch',
    name: '網前魔術師',
    title: '網前專精',
    desc: '切球、放網更快更準；殺球、高遠球較慢',
    shirt: 0xf27fb0,
    shorts: 0x5a2340,
    kit: { speed: { drop: 1.03, smash: 0.94, clear: 0.95 }, accuracy: 0.85 },
  },
  {
    id: 'driver',
    name: '推壓手',
    title: '平抽專精',
    desc: '推球、平抽更快；高遠球較慢',
    shirt: 0xf2a23a,
    shorts: 0x4a3010,
    kit: { speed: { push: 1.06, clear: 0.93 } },
  },
  {
    id: 'runner',
    name: '快腿',
    title: '速度專精',
    desc: '移動與起步最快；球速稍慢',
    shirt: 0x34c38f,
    shorts: 0x14402f,
    kit: { move: 1.05, accel: 1.1, speed: { smash: 0.95, push: 0.97 } },
  },
];

export const RACKETS: Racket[] = [
  { id: 'balance', name: '均衡拍', desc: '標準手感', color: 0xdfe6ee, kit: {} },
  {
    id: 'attack',
    name: '攻擊拍（頭重）',
    desc: '殺球 +4%；落點誤差 +15%',
    color: 0xff5a4a,
    kit: { speed: { smash: 1.04 }, accuracy: 1.15 },
  },
  {
    id: 'speed',
    name: '速度拍（頭輕）',
    desc: '揮拍判定時間 +18%、推球 +5%；殺球 -3%',
    color: 0x4ad7ff,
    kit: { window: 1.18, speed: { push: 1.05, smash: 0.97 } },
  },
  {
    id: 'control',
    name: '控制拍',
    desc: '落點誤差 -30%；殺球 -5%',
    color: 0xb48cff,
    kit: { accuracy: 0.7, speed: { smash: 0.95 } },
  },
];

export const BASE_KIT: Kit = { speed: { smash: 1, drop: 1, push: 1, clear: 1 }, move: 1, accel: 1, window: 1, accuracy: 1 };

/** 球員特質 × 球拍 → 最終數值（倍率相乘） */
export function buildKit(characterId: string, racketId: string): Kit {
  const parts = [CHARACTERS.find((c) => c.id === characterId)?.kit ?? {}, RACKETS.find((r) => r.id === racketId)?.kit ?? {}];
  const k: Kit = { ...BASE_KIT, speed: { ...BASE_KIT.speed } };
  for (const p of parts) {
    for (const g of Object.keys(k.speed) as ShotGroup[]) k.speed[g] *= p.speed?.[g] ?? 1;
    k.move *= p.move ?? 1;
    k.accel *= p.accel ?? 1;
    k.window *= p.window ?? 1;
    k.accuracy *= p.accuracy ?? 1;
  }
  return k;
}

export const characterById = (id: string) => CHARACTERS.find((c) => c.id === id) ?? CHARACTERS[0];
export const racketById = (id: string) => RACKETS.find((r) => r.id === id) ?? RACKETS[0];
