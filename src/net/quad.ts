import { GAME, type MatchSettings, type MoveMode } from '../config';
import type { Match, PlayerId } from '../sim/match';
import { CHARACTERS, RACKETS } from '../sim/kits';
import type { QuadAi, QuadCfg, QuadHuman, QuadRoster, QuadSeat } from './protocol';

/**
 * 4 人房（線上雙打，2 對 2）的名單邏輯（不碰 DOM／網路，大廳畫面和無畫面測試共用）：
 * - 座位 0、2 = A 隊，1、3 = B 隊；空位可以由 AI 補位（房主的手機模擬）
 * - 名單以房主為準：房主改完就廣播 lobby；其他人要換座位／準備都送給房主
 * - 每支手機把自己放在 0 號（畫面下方），隊友 2 號、對手 1、3 號：本機球員編號 = 座位 xor 自己的座位
 *   （A 隊的人看標準視角，B 隊的人整個鏡像）
 */

export const isHuman = (s: QuadSeat | undefined): s is QuadHuman => !!s && !('ai' in s);
export const isAi = (s: QuadSeat | undefined): s is QuadAi => !!s && 'ai' in s;
/** 座位 → 隊伍（0 = A 隊、1 = B 隊） */
export const seatTeam = (seat: number): 0 | 1 => (seat % 2) as 0 | 1;
export const TEAM_NAMES = ['A 隊', 'B 隊'];

/** 擊球範圍倍率（跟 main.ts setupAssist 一樣）：手動 1.2、輔助 1.1、自動 1 */
export function reachForMove(mv: MoveMode): number {
  return mv === 'manual' ? GAME.manualReachMul : mv === 'assist' ? GAME.assistReachMul : 1;
}

export class QuadLobby {
  constructor(public r: QuadRoster) {}

  /** 房主建房：自己坐 0 號（A 隊） */
  static create(host: QuadHuman, cfg: QuadCfg): QuadLobby {
    return new QuadLobby({ seats: [host, null, null, null], cfg, host: host.cid });
  }

  get seats(): QuadSeat[] {
    return this.r.seats;
  }

  seatOf(cid: string): number {
    return this.seats.findIndex((s) => isHuman(s) && s.cid === cid);
  }

  humans(): number {
    return this.seats.filter(isHuman).length;
  }

  /** 這個座位由誰的手機控制（真人 = 自己；AI = 房主） */
  controller(seat: number): string {
    const s = this.seats[seat];
    return isHuman(s) ? s.cid : this.r.host;
  }

  /**
   * 有人進房（或重新連上）：
   * - 已經有座位 → 更新資料、標成連線中（'back'；比賽中要從目前比分繼續）
   * - 比賽中、座位被 AI 代打 → 'return'（下一分還給他）
   * - 比賽中其他人 → 'waiting'（等下一場）
   * - 大廳：找空位（真人少的那隊優先），沒空位就換掉一個 AI 補位；都沒有 → 'full'
   */
  join(h: QuadHuman, inMatch: boolean): 'seated' | 'back' | 'return' | 'waiting' | 'full' {
    const at = this.seatOf(h.cid);
    if (at >= 0) {
      const old = this.seats[at] as QuadHuman;
      this.seats[at] = { ...h, ready: old.ready || h.ready, on: true };
      return inMatch ? 'back' : 'seated';
    }
    if (inMatch) return this.seats.some((s) => isAi(s) && s.was === h.cid) ? 'return' : 'waiting';
    const teamHumans = (t: number) => [t, t + 2].filter((s) => isHuman(this.seats[s])).length;
    const order = [0, 1, 2, 3].sort((a, b) => teamHumans(seatTeam(a)) - teamHumans(seatTeam(b)) || a - b);
    let seat = order.find((s) => this.seats[s] === null);
    if (seat === undefined) seat = order.find((s) => isAi(this.seats[s]));
    if (seat === undefined) return 'full';
    this.seats[seat] = { ...h, on: true };
    return 'seated';
  }

  /** 有人離開：大廳 = 空出座位；比賽中 = 標成斷線（座位留著等他回來） */
  leave(cid: string, inMatch: boolean): void {
    const at = this.seatOf(cid);
    if (at < 0) return;
    if (inMatch) (this.seats[at] as QuadHuman).on = false;
    else this.seats[at] = null;
  }

  /** 換座位（換隊）：只能換到空位或 AI 補位的位置 */
  move(cid: string, to: number): boolean {
    const from = this.seatOf(cid);
    if (from < 0 || to < 0 || to > 3 || from === to || isHuman(this.seats[to])) return false;
    this.seats[to] = { ...(this.seats[from] as QuadHuman), ready: false };
    this.seats[from] = null;
    return true;
  }

  /** 房主切換空位的「AI 補位」 */
  toggleAi(seat: number): boolean {
    const s = this.seats[seat];
    if (isHuman(s)) return false;
    this.seats[seat] = s ? null : this.newAi();
    return true;
  }

  setReady(cid: string, ready: boolean): void {
    const at = this.seatOf(cid);
    if (at >= 0) (this.seats[at] as QuadHuman).ready = ready;
  }

  /** 開打前：空位都由 AI 補上 */
  fillAi(): void {
    for (let i = 0; i < 4; i++) if (!this.seats[i]) this.seats[i] = this.newAi();
  }

  /** 比賽中有人斷線：AI 代打（用他的球員、球拍），記住原本是誰 */
  takeover(seat: number): void {
    const s = this.seats[seat];
    if (!isHuman(s)) return;
    this.seats[seat] = { ai: true, character: s.character, racket: s.racket, was: s.cid };
  }

  /** 被 AI 代打的人回來了：還給他 */
  giveBack(h: QuadHuman): number {
    const at = this.seats.findIndex((s) => isAi(s) && s.was === h.cid);
    if (at >= 0) this.seats[at] = { ...h, on: true };
    return at;
  }

  /** 房主不在了：由 newHost 接手當房主（模擬 AI、決定繼續） */
  setHost(cid: string): void {
    this.r.host = cid;
  }

  private newAi(): QuadAi {
    const used = new Set(this.seats.filter((s): s is QuadHuman | QuadAi => !!s).map((s) => s.character));
    const free = CHARACTERS.filter((c) => !used.has(c.id));
    const pool = free.length ? free : CHARACTERS;
    return { ai: true, character: pool[Math.floor(Math.random() * pool.length)].id, racket: RACKETS[Math.floor(Math.random() * RACKETS.length)].id };
  }
}

/** 名單 → 這支手機的比賽設定（球員編號 = 座位 xor 自己的座位） */
export function quadSettings(base: MatchSettings, r: QuadRoster, mySeat: number): MatchSettings {
  const at = (id: number) => r.seats[id ^ mySeat] as QuadHuman | QuadAi;
  return {
    ...base,
    points: r.cfg.points,
    games: r.cfg.games,
    venue: r.cfg.venue,
    doubles: true,
    practice: false,
    character: at(0).character,
    racket: at(0).racket,
    aiCharacter: at(1).character,
    aiRacket: at(1).racket,
    partnerCharacter: at(2).character,
    partnerRacket: at(2).racket,
    ai2Character: at(3).character,
    ai2Racket: at(3).racket,
  };
}

/** 哪些座位由這支手機控制：自己＋（房主）AI 補位 */
export function localSeats(r: QuadRoster, mySeat: number, myCid: string): boolean[] {
  return r.seats.map((s, seat) => seat === mySeat || (isAi(s) && r.host === myCid));
}

/**
 * 把一場 Match 設成 4 人線上：伺服器裁決、哪些球員是遠端、每個座位站的發球區、各人的擊球範圍
 * （別人的跑位設定也照著設，雙打分工 ballTaker 才會跟他自己手機上算的比較接近）
 */
export function configureQuadMatch(m: Match, r: QuadRoster, mySeat: number, myCid: string, courts?: (1 | -1)[], spectator = false): boolean[] {
  const local = spectator ? r.seats.map(() => false) : localSeats(r, mySeat, myCid); // 觀眾：四個人都是遠端
  m.arbitrated = true;
  let mask = 0;
  for (let seat = 0; seat < 4; seat++) {
    const id = (seat ^ mySeat) as PlayerId;
    if (!local[seat]) mask |= 1 << id;
    const p = m.players[id];
    p.court = courts ? courts[seat] : seat < 2 ? 1 : -1;
    const s = r.seats[seat];
    p.reachMul = isHuman(s) ? reachForMove(r.cfg.allManual ? 'manual' : s.mv) : 1;
  }
  m.remoteMask = mask;
  return local;
}
