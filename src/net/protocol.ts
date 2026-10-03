import type { Venue } from '../config';
import type { Family } from '../sim/shots';
import type { HitGrade } from '../sim/match';

/** 兩邊版本不同就不能一起玩（改了訊息格式或物理就 +1） */
export const PROTOCOL = 3;

type V3 = [number, number, number];

/** 玩家之間的訊息：座標都是「送出方自己的視角」（自己在 z>0 那半場），收到的一方鏡像 */
export type PeerMsg =
  | { t: 'hello'; v: number; name: string; character: string; racket: string; points: 11 | 15 | 21; games: 1 | 3; venue: Venue }
  | { t: 'start'; points: 11 | 15 | 21; games: 1 | 3; venue: Venue }
  | { t: 'rematch' }
  // 斷線重連後由房主送：從這個比分重新發球（sc / gm = [送出方, 接收方]，srv = 誰發球）
  | { t: 'resume'; sc: [number, number]; gm: [number, number]; srv: 'me' | 'you' }
  | { t: 'bye' }
  | { t: 'ping'; a: number }
  | { t: 'pong'; a: number }
  // 自己球員的狀態（約每秒 18 次）
  | {
      t: 'st';
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
  | {
      t: 'hit';
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
  // 接球方判定這一分：w = 誰贏（以送出方來看），sc / gm = 判定後的比分 [送出方, 接收方]
  | { t: 'pt'; w: 'me' | 'you'; r: string; sc: [number, number]; gm: [number, number] };

/** 伺服器送的訊息 */
export type ServerMsg = { t: 'welcome'; role: 'host' | 'guest'; peers: number } | { t: 'peer-join' } | { t: 'peer-left' } | { t: 'full' };

export type NetMsg = PeerMsg | ServerMsg;
