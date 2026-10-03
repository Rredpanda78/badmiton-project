// 場館巡迴賽：每個場館有兩位打法不同的對手＋一位館主，依序挑戰，打贏館主開放下一站。
import type { Venue } from '../config';

export interface TourOpponent {
  character: string; // kits.ts 的球員 id
  racket: string;
  title: string; // 顯示的稱號
  style: string; // ai.ts STYLES 的 key
  level: number; // 0 簡單 ～ 2 困難（可帶小數）
  points: 11 | 15 | 21;
  boss?: boolean;
  intro: string; // 開場介紹
}

export interface TourStop {
  id: string;
  name: string;
  venue: Venue;
  opponents: TourOpponent[];
}

export const TOUR: TourStop[] = [
  {
    id: 'sakura',
    name: '櫻花園站',
    venue: 'sakura',
    opponents: [
      { character: 'touch', racket: 'control', title: '網前新秀', style: 'netter', level: 0.4, points: 11, intro: '喜歡放小球，記得往前站' },
      { character: 'runner', racket: 'speed', title: '飛毛腿', style: 'defender', level: 0.8, points: 11, intro: '什麼球都救得到，要有耐心' },
      { character: 'touch', racket: 'balance', title: '櫻花館主', style: 'trickster', level: 1.15, points: 11, boss: true, intro: '館主會做假動作——看她腳下光圈亮了又熄就是假的' },
    ],
  },
  {
    id: 'bamboo',
    name: '竹林站',
    venue: 'bamboo',
    opponents: [
      { character: 'driver', racket: 'speed', title: '竹林快槍', style: 'driver', level: 1.1, points: 11, intro: '平抽又快又平，球拍舉高等他' },
      { character: 'allround', racket: 'balance', title: '竹林劍客', style: 'allround', level: 1.3, points: 11, intro: '沒有弱點，靠你的落點拉開他' },
      { character: 'power', racket: 'attack', title: '竹林館主', style: 'attacker', level: 1.55, points: 15, boss: true, intro: '重砲跳殺！別把球挑得太短' },
    ],
  },
  {
    id: 'night',
    name: '夜櫻站',
    venue: 'night',
    opponents: [
      { character: 'runner', racket: 'balance', title: '夜行者', style: 'defender', level: 1.6, points: 11, intro: '防守滴水不漏，要用殺球和網前配合' },
      { character: 'driver', racket: 'control', title: '燈籠師', style: 'trickster', level: 1.75, points: 11, intro: '落點刁鑽又會騙，專心看球' },
      { character: 'allround', racket: 'attack', title: '夜櫻館主', style: 'attacker', level: 2, points: 15, boss: true, intro: '最終館主，全力以赴！' },
    ],
  },
];

/** 進度：每站已打贏到第幾位（0～3） */
export type TourProgress = Record<string, number>;

export function loadTour(): TourProgress {
  try {
    return JSON.parse(localStorage.getItem('badminton.tour') ?? '{}');
  } catch {
    return {};
  }
}

export function saveTourWin(stopId: string, index: number): TourProgress {
  const p = loadTour();
  p[stopId] = Math.max(p[stopId] ?? 0, index + 1);
  try {
    localStorage.setItem('badminton.tour', JSON.stringify(p));
  } catch {
    /* ignore */
  }
  return p;
}

/** 這一站是否開放：第一站永遠開放，其他要打贏前一站館主 */
export function stopUnlocked(p: TourProgress, i: number): boolean {
  if (i === 0) return true;
  const prev = TOUR[i - 1];
  return (p[prev.id] ?? 0) >= prev.opponents.length;
}
