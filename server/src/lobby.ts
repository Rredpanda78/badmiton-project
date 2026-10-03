/**
 * 遊戲大廳的名單（純邏輯，不碰 Cloudflare／網路，伺服器和無畫面測試共用）。
 *
 * 每個「公開到大廳」的房間一筆：房間物件（Room）每次有變動（建房、有人進出、開打、得分、結束、觀眾進出）
 * 就把完整的一筆送過來（upsert 整筆取代），等待中每 LOBBY_HEARTBEAT_MS 心跳一次；
 * 超過 LOBBY_MAX_AGE_MS 沒更新的（房間物件被回收、伺服器重啟）就當作消失。
 * 房間送出前用 Coalescer 節流：LOBBY_MIN_GAP_MS 內最多送一次，密集的變動合併成最後一次。
 */

export type LobbyMode = 'singles' | 'doubles' | 'quad';
export type LobbyStatus = 'wait' | 'play' | 'over';

export interface LobbyEntry {
  code: string;
  host: string; // 房主的名字（球員名）
  mode: LobbyMode;
  venue: string;
  points: number;
  games: number;
  cap: 2 | 4;
  players: number; // 連線中的玩家（不含觀眾）
  spectators: number;
  status: LobbyStatus;
  sc?: [number, number]; // 比賽中的比分 [房主那隊, 對方]（2 人房 = [房主, 加入的人]；4 人房 = [A 隊, B 隊]）
  gm?: [number, number]; // 局數
  t: number; // 最後更新（毫秒）
}

/** 等待中的房間多久心跳一次 */
export const LOBBY_HEARTBEAT_MS = 30_000;
/** 多久沒更新就當作消失（兩次心跳沒到＋餘裕） */
export const LOBBY_MAX_AGE_MS = 75_000;
/** 同一個房間兩次更新最少隔多久（密集的變動合併） */
export const LOBBY_MIN_GAP_MS = 2_000;

const STATUS_ORDER: Record<LobbyStatus, number> = { wait: 0, play: 1, over: 2 };

export class LobbyRegistry {
  private map = new Map<string, LobbyEntry>();

  get size(): number {
    return this.map.size;
  }

  get(code: string): LobbyEntry | undefined {
    return this.map.get(code);
  }

  /** 整筆取代（房間每次都送完整的一筆） */
  upsert(e: LobbyEntry): void {
    this.map.set(e.code, e);
  }

  remove(code: string): boolean {
    return this.map.delete(code);
  }

  /** 清掉太久沒更新的；回傳清掉的房號（伺服器順便刪儲存） */
  prune(now: number, maxAge = LOBBY_MAX_AGE_MS): string[] {
    const gone: string[] = [];
    for (const [code, e] of this.map) if (now - e.t > maxAge) gone.push(code);
    for (const c of gone) this.map.delete(c);
    return gone;
  }

  /** 目前的名單：可以加入的（等待中）排前面，再比賽中、已結束；同一類最近有動靜的在前 */
  list(now: number, maxAge = LOBBY_MAX_AGE_MS): LobbyEntry[] {
    return [...this.map.values()].filter((e) => now - e.t <= maxAge).sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.t - a.t);
  }
}

/** 節流：minGapMs 內最多送一次；期間的變動合併，時間到再送最新的一筆 */
export class Coalescer {
  /** 上一次送出的時間 */
  last = -Infinity;
  /** 有排程中（還沒送）的變動 */
  pending = false;

  constructor(readonly minGapMs = LOBBY_MIN_GAP_MS) {}

  /** 有東西要送：回傳 null = 現在就送（送完呼叫 sent）；數字 = 到這個時間再送（已經排過就回傳同一個時間） */
  request(now: number): number | null {
    if (now - this.last >= this.minGapMs) return null;
    this.pending = true;
    return this.last + this.minGapMs;
  }

  sent(now: number): void {
    this.last = now;
    this.pending = false;
  }
}
