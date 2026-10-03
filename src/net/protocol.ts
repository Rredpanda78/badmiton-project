import type { Difficulty, MoveMode, Venue } from '../config';
import type { Family } from '../sim/shots';
import type { HitGrade } from '../sim/match';

/** 兩邊版本不同就不能一起玩（改了訊息格式或物理就 +1） */
export const PROTOCOL = 5;

type V3 = [number, number, number];

/** 一次擊球的內容（2 人的 hit、4 人的 ev 共用） */
export interface HitFields {
  c: V3;
  v: V3;
  dt: number;
  f: Family;
  n: string;
  k: number;
  ch: number;
  q: number;
  g: HitGrade;
  s: boolean;
  j: boolean;
  d: boolean;
  w: boolean;
  ab: number; // 這球有多好殺
  nf: boolean;
  ps: boolean;
}

// ---------- 4 人房 ----------

/** 座位上的真人（cid = 這支手機的連線編號，重連時拿回同一個座位） */
export interface QuadHuman {
  cid: string;
  name: string;
  character: string;
  racket: string;
  shirt?: number;
  shorts?: number;
  mv: MoveMode; // 自己選的跑位
  ready: boolean;
  on: boolean; // 連線中
}
/** AI 補位（房主的手機模擬）；was = 原本坐這裡的真人（斷線由 AI 代打，回來就還給他） */
export interface QuadAi {
  ai: true;
  character: string;
  racket: string;
  was?: string;
}
export type QuadSeat = QuadHuman | QuadAi | null;
/** 房主選的規則；allManual = 全員手動跑位 */
export interface QuadCfg {
  points: 11 | 15 | 21;
  games: 1 | 3;
  venue: Venue;
  difficulty: Difficulty; // AI 補位的強度
  allManual: boolean;
}
/** 名單：座位 0、2 = A 隊，1、3 = B 隊；host = 房主的 cid（AI 補位由房主的手機模擬） */
export interface QuadRoster {
  seats: QuadSeat[];
  cfg: QuadCfg;
  host: string;
}

/**
 * 4 人房會影響比分的事件，送給伺服器裁決（server/src/arbiter.ts）：
 * re = 回應的是第幾個已裁決事件；ct = 擊中（落地）時這一球飛了多久；座標都是「A 隊在 z>0」的標準視角
 */
export type EvMsg =
  | { t: 'ev'; ep: number; re: number; k: 'hit'; s: number; ct: number; d: number; so: 0 | 1; h: HitFields }
  | { t: 'ev'; ep: number; re: number; k: 'land'; s: number; ct: number; w: 0 | 1; r: string };

/** 玩家之間的訊息：2 人房的座標是「送出方自己的視角」（自己在 z>0 那半場），收到的一方鏡像 */
export type PeerMsg =
  | {
      t: 'hello';
      v: number;
      name: string;
      character: string;
      racket: string;
      points: 11 | 15 | 21;
      games: 1 | 3;
      venue: Venue;
      matchType?: 'singles' | 'doubles' | 'quad';
      difficulty?: Difficulty;
      shirt?: number;
      shorts?: number;
      partner?: string;
      partnerRacket?: string;
      cid?: string;
      mv?: MoveMode;
      /** 比賽狀態：0 = 沒在比賽、1 = 比賽中但自己斷過線、2 = 比賽中一直都在（斷線重連時由狀態最新的那邊帶大家繼續） */
      ms?: 0 | 1 | 2;
    }
  // rj = 斷線回來：照目前這場的設定重建比賽，接著會收到 resume
  | { t: 'start'; points: 11 | 15 | 21; games: 1 | 3; venue: Venue; matchType?: 'singles' | 'doubles'; difficulty?: Difficulty; rj?: 1 }
  | { t: 'rematch' }
  // 斷線重連後：從這個比分重新發球（sc / gm = [送出方, 接收方]，srv = 送出方手機上的發球球員編號）
  | { t: 'resume'; sc: [number, number]; gm: [number, number]; srv: number }
  | { t: 'bye'; cid?: string }
  | { t: 'ping'; a: number }
  | { t: 'pong'; a: number }
  // 自己球員的狀態（約每秒 18 次）
  | {
      t: 'st';
      i?: number; // 2 人：送出方手機上的球員編號（0 = 自己、2 = 自己的 AI 隊友；沒有 = 0）；4 人：座位
      lg?: number; // 4 人：送出方到伺服器的單程延遲（毫秒）
      p: V3;
      v: V3;
      a: 0 | 1; // 在空中
      c: 0 | 1; // 蓄力中
      ch: number;
      j: 0 | 1; // 跳殺待命
      d: [number, number, number] | 0; // 魚躍 t, dx, dz
      dn: number; // 趴地剩餘
      sw: [Family, number, 0 | 1] | 0; // 揮拍：球種、t、在空中
    }
  // 自己的擊球（含發球）
  | ({ t: 'hit'; i?: number } & HitFields)
  // 接球方判定這一分：w = 誰贏（以送出方來看），sc / gm = 判定後的比分 [送出方, 接收方]
  | { t: 'pt'; w: 'me' | 'you'; r: string; sc: [number, number]; gm: [number, number] }
  // ---- 4 人房 ----
  | { t: 'lobby'; r: QuadRoster } // 房主 → 大家：目前的名單
  | { t: 'seat'; cid: string; to: number } // → 房主：我要換到這個座位
  | { t: 'ready'; cid: string; r: boolean } // → 房主：準備好了
  | { t: 'go'; r: QuadRoster; ep: number; srv: number } // 房主 → 大家：開打（srv = 先發球的座位）
  // 房主 → 大家：從這個比分繼續（斷線回來、AI 代打、還座位）；sc / gm = [A 隊, B 隊]，courts = 每個座位站的發球區
  | { t: 'resume4'; r: QuadRoster; ep: number; sc: [number, number]; gm: [number, number]; srv: number; courts: (1 | -1)[] }
  | { t: 'arb'; ep: number; q: number } // → 伺服器：裁決器重設（新的 ep、序號從 q 開始）
  | EvMsg
  | { t: 'acc'; q: number; e: EvMsg }; // 伺服器 → 大家：裁決結果（第 q 個事件）

/** 伺服器送的訊息（cap = 房間人數上限；4 人房多帶 cid） */
export type ServerMsg =
  | { t: 'welcome'; role: 'host' | 'guest'; peers: number; cap?: number; cid?: string; ids?: string[] }
  | { t: 'peer-join'; cid?: string }
  | { t: 'peer-left'; cid?: string }
  | { t: 'full'; cap?: number };

export type NetMsg = PeerMsg | ServerMsg;
