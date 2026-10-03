import { GAME, type MatchSettings, type Venue } from '../config';
import { Match, type PlayerId, type TeamId } from '../sim/match';
import type { Vec3 } from '../sim/physics';
import type { PeerMsg, QuadRoster, SnapMsg, SpecMsg, SpecPlayer, SpecStart } from './protocol';
import { configureQuadMatch, isHuman, quadSettings } from './quad';
import type { QuadSession } from './session4';
import { QuadSync } from './sync4';

type V3 = [number, number, number];
type Fr = 'h' | 'g' | undefined;
type StMsg = Extract<PeerMsg, { t: 'st' }>;
type HitMsg = Extract<PeerMsg, { t: 'hit' }>;
type PtMsg = Extract<PeerMsg, { t: 'pt' }>;
type AccMsg = Extract<PeerMsg, { t: 'acc' }>;

/** 觀眾看到的這場：players[id] = 標準視角的球員（畫面換外觀、記分板顯示名字用） */
export interface SpecView {
  kind: 'duo' | 'quad';
  players: { name: string; character: string; racket: string; shirt?: number; shorts?: number; ai: boolean }[];
  teamNames: [string, string];
  venue: Venue;
  points: number;
  games: number;
  doubles: boolean;
}

/**
 * 觀眾端（不碰 DOM／網路，main.ts 和無畫面測試共用）：沒有座位、不操作，只照收到的訊息模擬整場。
 * 一律用「標準視角」：
 * - 2 人房：房主 = 球員 0（AI 隊友 2）、加入的人 = 1（AI 隊友 3），房主那隊在 z>0。伺服器轉來的訊息多帶 fr（h／g = 誰送的）：
 *   房主送的座標、球員編號照用；加入的人送的 x、z 反號、編號 xor 1（跟房主收到時一樣）。
 *   每一球落地不自己判分（arbitrated → await），等接球方的 pt：w／sc 都換成標準視角、比分以 pt 的為準
 * - 4 人房：球員編號 = 座位（A 隊在 z>0），訊息本來就是標準視角；用 QuadSync（spectator 模式，四個座位都是遠端）套用伺服器的裁決結果
 * 中途加入：送 spec-hello 要快照（snap：兩邊的球員、規則、比分、發球、4 人房的名單＋裁決序號），照快照建比賽，從下一球開始看
 */
export class Spectator {
  match: Match | null = null;
  view: SpecView | null = null;
  rttMs = 0;
  lagMs = 40;
  cap: 2 | 4 = 2;
  peers = 0;
  spectators = 0;
  /** 2 人房：兩邊的資料（hello／快照）和這場的規則 */
  duo: { h: SpecPlayer | null; g: SpecPlayer | null; start: SpecStart | null } = { h: null, g: null, start: null };
  /** 4 人房：名單 */
  roster: QuadRoster | null = null;
  private quad: QuadSync | null = null;
  /** 4 人房：還沒有比賽（等快照）時先收到的裁決結果，快照到了再補套用（序號在快照之前的會被丟掉） */
  private accBuf: AccMsg[] = [];
  private lastPing = -1e9;
  private seed: number;
  /** 建好（或重建）一場比賽：畫面換外觀、場地、記分板名字 */
  onMatch: (m: Match, v: SpecView) => void = () => {};
  /** 還沒有比賽可看時的狀態文字 */
  onStatus: (text: string) => void = () => {};
  /** 有人離開／斷線（短暫提示） */
  onNote: (text: string) => void = () => {};

  constructor(
    private base: MatchSettings,
    private send: (m: PeerMsg) => void,
    private now: () => number = () => performance.now(),
    seed = (Date.now() ^ (Math.random() * 1e9)) >>> 0,
  ) {
    this.seed = seed;
  }

  /** 跟玩家要目前的狀態（房主／帶大家繼續的人會回 snap） */
  requestSnap(): void {
    this.send({ t: 'spec-hello' });
  }

  /** 每個模擬 tick（match.step 之後）呼叫：量延遲用的 ping（4 人房由 QuadSync 送） */
  afterStep(): void {
    if (this.quad) return this.quad.afterStep();
    const t = this.now();
    if (t - this.lastPing > 2000) {
      this.lastPing = t;
      this.send({ t: 'ping', a: t });
    }
  }

  /** 跟 OnlineSync／QuadSync 一樣的介面（觀眾不送事件） */
  onEvent(): void {}

  receive(msg: SpecMsg): void {
    switch (msg.t) {
      case 'welcome':
        this.cap = msg.cap === 4 ? 4 : 2;
        this.peers = msg.peers;
        this.spectators = msg.spec ?? 0;
        if (msg.peers > 0) this.requestSnap();
        else this.waitText();
        break;
      case 'full':
        this.onStatus(msg.spec ? '這個房間的觀眾滿了（最多 20 人）' : '房間滿了');
        break;
      case 'spec':
        this.spectators = msg.n;
        break;
      case 'peer-join':
        this.peers++;
        this.requestSnap(); // 2 人房會接著收到 hello／start；4 人房會收到名單。要一次快照最保險
        break;
      case 'peer-left':
      case 'bye':
        this.peerLeft(msg.fr, msg.cid, msg.t === 'bye');
        break;
      case 'pong': {
        const rtt = this.now() - msg.a;
        this.rttMs = this.rttMs ? this.rttMs * 0.7 + rtt * 0.3 : rtt;
        this.lagMs = Math.min(400, this.rttMs) / 2;
        if (this.match) this.match.netLag = (this.lagMs / 1000) * GAME.simSpeed;
        this.quad?.receive(msg);
        break;
      }
      case 'snap':
        this.applySnap(msg);
        break;
      // ---- 2 人房 ----
      case 'hello':
        if (this.cap === 2 && msg.fr) {
          this.duo[msg.fr] = { name: msg.name, character: msg.character, racket: msg.racket, shirt: msg.shirt, shorts: msg.shorts, partner: msg.partner, partnerRacket: msg.partnerRacket, on: true };
          if (!this.match) this.waitText();
        }
        break;
      case 'start':
        if (this.cap === 2) {
          this.duo.start = { points: msg.points, games: msg.games, venue: msg.venue, matchType: msg.matchType ?? 'singles', difficulty: msg.difficulty };
          if (!this.buildDuo(0)) this.requestSnap(); // 還沒拿到兩邊的 hello（中途進來）：要快照
        }
        break;
      case 'resume':
        if (this.cap !== 2 || !msg.fr) break;
        if (!this.match) {
          this.requestSnap(); // 還沒有比賽（例如 AI 代打期間進來的）：現在他們繼續了，要一次快照
          break;
        }
        {
          const g = msg.fr === 'g';
          const sc: [number, number] = g ? [msg.sc[1], msg.sc[0]] : [msg.sc[0], msg.sc[1]];
          const gm: [number, number] = g ? [msg.gm[1], msg.gm[0]] : [msg.gm[0], msg.gm[1]];
          this.match.resumePoint(sc, gm, (g ? msg.srv ^ 1 : msg.srv) as PlayerId);
          this.match.drainEvents();
        }
        break;
      case 'st':
        if (this.cap === 4) this.quad?.receive(msg);
        else this.duoState(msg, msg.fr);
        break;
      case 'hit':
        if (this.cap === 2) this.duoHit(msg, msg.fr);
        break;
      case 'pt':
        if (this.cap === 2) this.duoPoint(msg, msg.fr);
        break;
      // ---- 4 人房 ----
      case 'lobby':
        this.cap = 4;
        this.roster = msg.r;
        if (!this.match) this.waitText();
        break;
      case 'go':
        this.buildQuad(msg.r, msg.srv, msg.ep, 0);
        break;
      case 'resume4':
        this.buildQuad(msg.r, msg.srv, msg.ep, 0, msg.courts, msg.sc, msg.gm);
        break;
      case 'acc':
        if (this.quad) this.quad.receive(msg);
        else {
          this.accBuf.push(msg);
          if (this.accBuf.length > 40) this.accBuf.shift();
        }
        break;
    }
  }

  /** 還沒有比賽可看：告訴觀眾房間現在怎樣 */
  private waitText(): void {
    if (this.peers === 0) return this.onStatus('房間目前沒有人，等玩家進來…');
    if (this.cap === 4) {
      const r = this.roster;
      if (!r) return this.onStatus('等房主的名單…');
      const n = r.seats.filter(isHuman).length;
      return this.onStatus(`${n} 人在房間裡，等房主開始…`);
    }
    const { h, g } = this.duo;
    if (h && g) return this.onStatus(`${h.name} vs ${g.name}，準備開打…`);
    if (h) return this.onStatus(`房主 ${h.name} 等對手加入…`);
    this.onStatus('等房主進來…');
  }

  private peerLeft(fr: Fr, cid: string | undefined, bye: boolean): void {
    let name: string | null = null;
    if (this.cap === 2 && fr) {
      const p = this.duo[fr];
      if (p && p.on !== false) {
        p.on = false;
        name = p.name;
      }
    } else if (cid && this.roster) {
      const s = this.roster.seats.find((x) => isHuman(x) && x.cid === cid);
      if (isHuman(s) && s.on) {
        s.on = false;
        name = s.name;
      }
    }
    if (name === null) return; // bye 之後的 peer-left（同一個人）
    this.peers = Math.max(0, this.peers - 1);
    this.onNote(`${name} ${bye ? '離開了' : '斷線了'}`);
    if (!this.match) this.waitText();
  }

  private applySnap(s: SnapMsg): void {
    if (s.k === 'duo') {
      this.cap = 2;
      if (s.h) this.duo.h = s.h;
      if (s.g) this.duo.g = s.g;
      if (s.start) this.duo.start = s.start;
      if (s.ph === 'play' && s.sc && s.gm && this.buildDuo(s.srv ?? 0, s.sc, s.gm)) return;
      if (s.ph === 'over') return this.onStatus(`比賽結束了${s.sc ? `（${s.sc[0]} : ${s.sc[1]}）` : ''}，等他們再來一場…`);
      this.waitText();
      return;
    }
    this.cap = 4;
    this.roster = s.r;
    if (s.ph === 'play' && s.sc && s.gm && s.srv !== undefined) this.buildQuad(s.r, s.srv, s.ep ?? 0, s.q ?? 0, s.courts, s.sc, s.gm);
    else if (s.ph === 'over') this.onStatus(`比賽結束了${s.sc ? `（A 隊 ${s.sc[0]} : ${s.sc[1]} B 隊）` : ''}，等房主再開一場…`);
    else this.waitText();
  }

  // ---------- 2 人房 ----------

  /** 照兩邊的 hello 和規則建比賽（房主 = 0 號）；sc/gm 有給 = 中途進來，從這個比分開始看 */
  private buildDuo(srv: number, sc?: [number, number], gm?: [number, number]): boolean {
    const { h, g, start } = this.duo;
    if (!h || !g || !start) return false;
    const doubles = start.matchType === 'doubles';
    const s: MatchSettings = {
      ...this.base,
      points: start.points,
      games: start.games,
      venue: start.venue,
      doubles,
      practice: false,
      character: h.character,
      racket: h.racket,
      aiCharacter: g.character,
      aiRacket: g.racket,
      partnerCharacter: h.partner ?? 'allround',
      partnerRacket: h.partnerRacket ?? 'balance',
      ai2Character: g.partner ?? 'allround',
      ai2Racket: g.partnerRacket ?? 'balance',
    };
    const m = new Match(s, this.seed++);
    m.remoteMask = doubles ? 0b1111 : 0b11; // 四個（兩個）人都是遠端
    m.arbitrated = true; // 不自己判分：落地進 await，等接球方的 pt
    m.netLag = (this.lagMs / 1000) * GAME.simSpeed;
    // 每一球都放慢「兩倍單程延遲」：接球的人的回擊訊息到的時候，球剛好在他球拍附近（玩家的延遲不知道，用自己的估）
    m.flightDilate = () => {
      const T = m.shuttle.prediction?.landTime ?? 0;
      return T > 0.05 ? T / (T + 2 * m.netLag) : 1;
    };
    m.holdNeed = () => 2 * m.netLag;
    m.server = srv as PlayerId;
    if (sc && gm) m.resumePoint(sc, gm, srv as PlayerId);
    else m.setupServe();
    m.drainEvents();
    this.quad = null;
    this.accBuf = [];
    this.match = m;
    const pl = (p: SpecPlayer) => ({ name: p.name, character: p.character, racket: p.racket, shirt: p.shirt, shorts: p.shorts, ai: false });
    const mate = (p: SpecPlayer) => ({ name: 'AI', character: p.partner ?? 'allround', racket: p.partnerRacket ?? 'balance', ai: true });
    this.view = {
      kind: 'duo',
      doubles,
      venue: start.venue,
      points: start.points,
      games: start.games,
      players: doubles ? [pl(h), pl(g), mate(h), mate(g)] : [pl(h), pl(g)],
      teamNames: doubles ? [`${h.name}隊`, `${g.name}隊`] : [h.name, g.name],
    };
    this.onMatch(m, this.view);
    return true;
  }

  /** 加入的人送的 → 鏡像（跟房主收到時一樣）；房主送的照用 */
  private duoId(fr: Fr, i: number | undefined): PlayerId {
    return ((i ?? 0) ^ (fr === 'g' ? 1 : 0)) as PlayerId;
  }
  private duoVec(fr: Fr, a: V3): Vec3 {
    return fr === 'g' ? { x: -a[0], y: a[1], z: -a[2] } : { x: a[0], y: a[1], z: a[2] };
  }

  private duoState(msg: StMsg, fr: Fr): void {
    const m = this.match;
    if (!m || !fr) return;
    const id = this.duoId(fr, msg.i);
    if (id >= m.players.length) return;
    const neg = fr === 'g' ? -1 : 1;
    m.setRemoteState(id, {
      pos: this.duoVec(fr, msg.p),
      vel: this.duoVec(fr, msg.v),
      airborne: !!msg.a,
      charging: !!msg.c,
      charge: msg.ch,
      jumpArmed: !!msg.j,
      dive: msg.d ? { t: msg.d[0], dx: neg * msg.d[1], dz: neg * msg.d[2] } : null,
      downT: msg.dn,
      swing: msg.sw ? { family: msg.sw[0], t: msg.sw[1], airborne: !!msg.sw[2] } : null,
    });
  }

  private duoHit(msg: HitMsg, fr: Fr): void {
    const m = this.match;
    if (!m || !fr) return;
    const id = this.duoId(fr, msg.i);
    if (id >= m.players.length) return;
    m.applyRemoteHit(
      {
        player: id,
        contact: this.duoVec(fr, msg.c),
        vel: this.duoVec(fr, msg.v),
        stepDt: msg.dt,
        family: msg.f,
        name: msg.n,
        speedKmh: msg.k,
        charge: msg.ch,
        quality: msg.q,
        grade: msg.g,
        serve: msg.s,
        jump: msg.j,
        dive: msg.d,
        wobble: msg.w,
        attack: msg.ab ?? 0,
        netFault: msg.nf,
        powerShort: msg.ps,
      },
      0,
    );
  }

  /** 接球方判定：w 是「送出方贏了沒」、sc/gm 是 [送出方, 接收方] → 換成 [房主, 加入的人] */
  private duoPoint(msg: PtMsg, fr: Fr): void {
    const m = this.match;
    if (!m || !fr) return;
    const g = fr === 'g';
    const winner: TeamId = (msg.w === 'me') !== g ? 0 : 1;
    const sc: [number, number] = g ? [msg.sc[1], msg.sc[0]] : [msg.sc[0], msg.sc[1]];
    const gm: [number, number] = g ? [msg.gm[1], msg.gm[0]] : [msg.gm[0], msg.gm[1]];
    m.applyAbsoluteVerdict(winner, msg.r, sc, gm);
  }

  // ---------- 4 人房 ----------

  /** 照名單建比賽（球員編號 = 座位，四個都是遠端），裁決序號從 q 開始；sc/gm 有給 = 中途進來／繼續比賽 */
  private buildQuad(r: QuadRoster, srv: number, ep: number, q: number, courts?: (1 | -1)[], sc?: [number, number], gm?: [number, number]): void {
    this.cap = 4;
    this.roster = r;
    const m = new Match(quadSettings(this.base, r, 0), this.seed++);
    configureQuadMatch(m, r, 0, '', courts, true);
    const sync = new QuadSync(m, r, 0, [false, false, false, false], this.send, this.now, true);
    sync.lagMs = this.lagMs;
    m.netLag = (this.lagMs / 1000) * GAME.simSpeed;
    m.server = srv as PlayerId;
    if (sc && gm) m.resumePoint(sc, gm, srv as PlayerId, courts);
    else m.setupServe();
    m.drainEvents();
    sync.reset(ep, q);
    this.match = m;
    this.quad = sync;
    const buf = this.accBuf;
    this.accBuf = [];
    for (const a of buf) sync.receive(a); // 等快照時先到的裁決：補套用（序號 ≤ q 的會被丟掉）
    const seat = (i: number) => {
      const s = r.seats[i];
      if (isHuman(s)) return { name: s.name, character: s.character, racket: s.racket, shirt: s.shirt, shorts: s.shorts, ai: false };
      return { name: 'AI', character: s?.character ?? 'allround', racket: s?.racket ?? 'balance', ai: true };
    };
    const players = [0, 1, 2, 3].map(seat);
    const team = (a: number, b: number) => `${players[a].name}＋${players[b].name}`;
    this.view = { kind: 'quad', doubles: true, venue: r.cfg.venue, points: r.cfg.points, games: r.cfg.games, players, teamNames: [team(0, 2), team(1, 3)] };
    this.onMatch(m, this.view);
  }
}

// ---------- 玩家端：回快照 ----------

/** hello 裡觀眾要的欄位 */
export function specPlayer(h: { name: string; character: string; racket: string; shirt?: number; shorts?: number; partner?: string; partnerRacket?: string }, on = true): SpecPlayer {
  return { name: h.name, character: h.character, racket: h.racket, shirt: h.shirt, shorts: h.shorts, partner: h.partner, partnerRacket: h.partnerRacket, on };
}

/**
 * 2 人房的玩家做快照：role = 自己在伺服器上的角色、me／peer = 兩邊、start = 這場的規則、m = 目前的比賽（null = 還沒開打）。
 * 自己的比賽裡對方永遠是 1 號隊，所以房主那隊 = 自己是房主 ? 0 : 1；srv 換成房主手機上的編號
 */
export function snapDuo(role: 'host' | 'guest', me: SpecPlayer, peer: SpecPlayer | null, start: SpecStart | null, m: Match | null): SnapMsg {
  const host = role === 'host';
  const h = host ? me : peer;
  const g = host ? peer : me;
  if (!m || !start || !peer) return { t: 'snap', k: 'duo', h, g, start, ph: 'wait' };
  const H = host ? 0 : 1;
  const sc: [number, number] = [m.score[H], m.score[H ^ 1]];
  const gm: [number, number] = [m.games[H], m.games[H ^ 1]];
  return { t: 'snap', k: 'duo', h, g, start, ph: m.phase === 'matchOver' ? 'over' : 'play', sc, gm, srv: host ? m.server : m.server ^ 1 };
}

/** 4 人房的快照（帶大家繼續的人做）：比賽中 = 名單＋比分＋發球區＋裁決序號（跟 resume4 一樣的欄位） */
export function snapQuad(sess: QuadSession | null, r: QuadRoster): SnapMsg {
  if (!sess) return { t: 'snap', k: 'quad', r, ph: 'wait' };
  const m = sess.match;
  const f = sess.mySeat & 1;
  const sc: [number, number] = [m.score[f], m.score[f ^ 1]];
  const gm: [number, number] = [m.games[f], m.games[f ^ 1]];
  if (m.phase === 'matchOver') return { t: 'snap', k: 'quad', r, ph: 'over', sc, gm };
  const re = sess.resumeMsg(r, sess.sync.ep);
  return { t: 'snap', k: 'quad', r: re.r, ph: 'play', ep: re.ep, q: sess.sync.acc, sc, gm, srv: re.srv, courts: re.courts };
}
