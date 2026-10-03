import { AIController } from '../ai/ai';
import type { MatchSettings } from '../config';
import { idleInput, Match, type PlayerId, type PlayerInput } from '../sim/match';
import { buildKit } from '../sim/kits';
import type { PeerMsg, QuadRoster } from './protocol';
import { configureQuadMatch, isAi, isHuman, quadSettings } from './quad';
import { QuadSync } from './sync4';

type Go = Extract<PeerMsg, { t: 'go' }>;
type Resume4 = Extract<PeerMsg, { t: 'resume4' }>;

/**
 * 一支手機上的一場 4 人線上比賽（不碰 DOM，main.ts 和無畫面測試共用）：
 * 照名單建 Match（自己 = 0 號）、QuadSync、本機控制的 AI（房主才有）；
 * 名單改了（AI 代打、還座位、換房主）就重新設定誰是遠端、AI 由誰模擬。
 */
export class QuadSession {
  readonly match: Match;
  readonly sync: QuadSync;
  readonly mySeat: number;
  /** 本機控制的 AI（索引 = 本機球員編號） */
  bots: (AIController | null)[] = [null, null, null, null];
  local: boolean[];
  roster: QuadRoster;

  private constructor(
    base: MatchSettings,
    r: QuadRoster,
    readonly myCid: string,
    mySeat: number,
    send: (m: PeerMsg) => void,
    now: () => number,
    seed: number,
    courts?: (1 | -1)[],
  ) {
    this.roster = clone(r);
    this.mySeat = mySeat;
    this.match = new Match(quadSettings(base, r, mySeat), seed);
    this.local = configureQuadMatch(this.match, r, mySeat, myCid, courts);
    this.sync = new QuadSync(this.match, this.roster, mySeat, this.local, send, now);
    this.makeBots();
  }

  /** 自己在名單上的座位；不在名單上（比賽中才進來的人）= -1 */
  static seatIn(r: QuadRoster, cid: string): number {
    return r.seats.findIndex((s) => isHuman(s) && s.cid === cid);
  }

  /** 房主送來的 go：開打（A 隊 srv 座位先發） */
  static start(base: MatchSettings, go: Go, myCid: string, send: (m: PeerMsg) => void, now?: () => number, seed = (Date.now() ^ (Math.random() * 1e9)) >>> 0): QuadSession | null {
    const seat = QuadSession.seatIn(go.r, myCid);
    if (seat < 0) return null;
    const s = new QuadSession(base, go.r, myCid, seat, send, now ?? (() => performance.now()), seed);
    s.match.server = s.sync.idOf(go.srv);
    s.match.setupServe();
    s.match.drainEvents();
    s.sync.reset(go.ep, 0);
    return s;
  }

  /** 斷線回來（本機沒有比賽、或座位變了）：直接照 resume4 建一場 */
  static fromResume(base: MatchSettings, msg: Resume4, myCid: string, send: (m: PeerMsg) => void, now?: () => number, seed = (Date.now() ^ (Math.random() * 1e9)) >>> 0): QuadSession | null {
    const seat = QuadSession.seatIn(msg.r, myCid);
    if (seat < 0) return null;
    const s = new QuadSession(base, msg.r, myCid, seat, send, now ?? (() => performance.now()), seed, msg.courts);
    s.resume(msg);
    return s;
  }

  get isHost(): boolean {
    return this.roster.host === this.myCid;
  }

  /** 名單改了：誰是遠端、誰的 AI 由本機模擬、球員／球拍（AI 代打用原本的人的；還座位時換回來） */
  applyRoster(r: QuadRoster): void {
    const old = this.roster;
    this.roster = clone(r);
    const m = this.match;
    const courts = m.players.map((p) => p.court);
    for (let seat = 0; seat < 4; seat++) {
      const a = old.seats[seat];
      const b = r.seats[seat];
      if (a && b && (a.character !== b.character || a.racket !== b.racket)) m.players[this.sync.idOf(seat)].kit = buildKit(b.character, b.racket);
    }
    this.local = configureQuadMatch(m, r, this.mySeat, this.myCid, courts.map((_, seat) => courts[seat ^ this.mySeat]));
    this.sync.setRoster(this.roster, this.local);
    this.makeBots();
  }

  /** 房主送來的 resume4：從這個比分重新發球 */
  resume(msg: Resume4): void {
    this.applyRoster(msg.r);
    const f = this.mySeat & 1;
    const m = this.match;
    m.resumePoint(
      [msg.sc[f], msg.sc[f ^ 1]],
      [msg.gm[f], msg.gm[f ^ 1]],
      this.sync.idOf(msg.srv),
      m.players.map((p) => msg.courts[this.sync.seatOf(p.id)]),
    );
    m.drainEvents();
    this.sync.reset(msg.ep, 0);
  }

  /** 房主：照目前的比分做一個 resume4（新的 ep） */
  resumeMsg(r: QuadRoster, ep: number): Resume4 {
    const m = this.match;
    const f = this.mySeat & 1;
    return {
      t: 'resume4',
      r: clone(r),
      ep,
      sc: [m.score[f], m.score[f ^ 1]],
      gm: [m.games[f], m.games[f ^ 1]],
      srv: this.sync.seatOf(m.server),
      courts: [0, 1, 2, 3].map((seat) => m.players[this.sync.idOf(seat)].court),
    };
  }

  /** 每個 tick 的輸入：自己 = own、本機的 AI 照 AI、遠端的人不用輸入（依球員編號順序取，AI 用比賽的亂數才可重現） */
  inputs(own: PlayerInput): PlayerInput[] {
    return this.match.players.map((p) => (p.id === 0 ? own : (this.bots[p.id]?.input() ?? idleInput())));
  }

  /** 本機要模擬的 AI：房主模擬所有 AI 補位（已經有的留著，不然「地獄」的跑速加成會重複加） */
  private makeBots(): void {
    for (let seat = 0; seat < 4; seat++) {
      const id = this.sync.idOf(seat) as PlayerId;
      const want = seat !== this.mySeat && this.local[seat] && isAi(this.roster.seats[seat]);
      if (want && !this.bots[id]) this.bots[id] = new AIController(this.match, id, this.roster.cfg.difficulty);
      else if (!want && this.bots[id]) {
        this.bots[id] = null;
        const s = this.roster.seats[seat];
        if (s) this.match.players[id].kit = buildKit(s.character, s.racket); // 拿掉 AI 的跑速加成
      }
    }
  }
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
