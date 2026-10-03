import { ballTaker } from '../ai/doubles';
import { GAME } from '../config';
import type { Match, MatchEvent, PlayerId, PreLaunch, RemoteHit, TeamId } from '../sim/match';
import type { Vec3 } from '../sim/physics';
import type { EvMsg, PeerMsg, QuadRoster } from './protocol';
import { isHuman } from './quad';

type V3 = [number, number, number];

/** 伺服器裁決窗口（毫秒，跟 server/src/arbiter.ts 的 ARB_DEFAULTS 一樣；算放慢倍率用） */
export const QUAD_HIT_WINDOW_MS = 60;

/**
 * 4 人房的比賽同步（不碰 DOM／網路，方便無畫面測試）：
 * - 每支手機各自模擬整場；自己（和房主的 AI 補位）由本機控制，其他人照收到的狀態外插
 * - 會影響比分的事件（擊球、落地）都送伺服器裁決（ev），伺服器廣播裁決結果（acc），大家照同樣的順序套用
 * - 自己擊球「搶先」：本機馬上打出去（不用等伺服器），同時送 ev；伺服器採用別人的（隊友先打到、或球先落地）
 *   就把本機這一下還原（restorePreLaunch），改套用被採用的事件
 * - 落地不在本機判分：照確定軌跡算出判定送去裁決（任何一支手機先送到都可以，判定都一樣），等廣播
 * - 訊息裡的座標都是「A 隊在 z>0」的標準視角；自己在 B 隊就整個鏡像（x、z 反號）
 */
export class QuadSync {
  /** 自己到伺服器的單程延遲（毫秒），用 ping 量；rttMs = 來回 */
  lagMs = 40;
  rttMs = 0;
  /** 每個座位到伺服器的單程延遲（毫秒；別人的從他的狀態訊息帶過來，AI = 房主的） */
  seatLag = [40, 40, 40, 40];
  ep = 0;
  /** 已套用的裁決序號 */
  acc = 0;
  /** 本機目前的狀態是第幾個事件之後（含還沒確認的搶先擊球） */
  private localSeq = 0;
  /** 本機搶先、還沒被確認的擊球（照順序），各自記著擊球前的狀態 */
  private spec: { ev: EvMsg; snap: PreLaunch }[] = [];
  /** 根據還沒確認的狀態產生的事件：等前面的確認了才送 */
  private queue: EvMsg[] = [];
  private lastClaim: { ev: EvMsg; at: number } | null = null;
  private ticks = 0;
  private lastPing = -1e9;
  readonly stats = { undo: 0, sent: 0, accepted: 0, jumps: [] as number[], mateJumps: [] as number[] };
  /** 本機搶先的擊球沒被採用（by = 被採用的擊球是誰打的；null = 球先落地） */
  onUndo: (by: PlayerId | null) => void = () => {};

  /**
   * spectator = 觀眾（src/net/spectate.ts）：mySeat 用 0（標準視角）、四個座位都是遠端，不送事件（伺服器也不會收），
   * 只套用裁決結果；放慢照「接球的人的延遲」算（不管打向哪一隊）
   */
  constructor(
    private match: Match,
    private roster: QuadRoster,
    readonly mySeat: number,
    private local: boolean[],
    private send: (m: PeerMsg) => void,
    private now: () => number = () => performance.now(),
    readonly spectator = false,
  ) {
    match.flightDilate = (id) => this.dilateFor(id);
    match.holdNeed = (id) => this.holdNeed(id);
  }

  /**
   * 球到了遠端球員 id 附近（Match.quadHold）：要等多久他的擊球才會傳過來（模擬秒）。
   * 只在「這球分給他接」時放慢（跟 AI、自動跑位用同一個分工 ballTaker），不然本機的人接球時機會不準。
   */
  private holdNeed(id: PlayerId): number {
    const m = this.match;
    if (ballTaker(m, m.teamOf(id))?.id !== id || m.shuttle.lastHitter === null) return 0;
    return (this.lateMs(this.seatOf(m.shuttle.lastHitter), this.seatOf(id)) / 1000) * GAME.simSpeed;
  }

  /** 這個座位由哪支手機控制（真人 = 他自己；AI = 房主） */
  private ctl(seat: number): string {
    const x = this.roster.seats[seat];
    return isHuman(x) ? x.cid : this.roster.host;
  }

  /**
   * hs 打出去的一球，rs 回擊的訊息會比「本機照沒放慢的時間看到他打到」晚多少（毫秒）：
   * (rs 那支手機開始看到這球 − 本機開始看到這球) ＋ rs 到伺服器 ＋ 裁決窗口 ＋ 伺服器到本機。
   * 開始看到這球的時間（以伺服器裁決 hs 這一下為 0）：hs 在那支手機上 = 搶先打的，比裁決早「窗口＋單程」；其他 = 晚單程
   */
  private lateMs(hs: number, rs: number): number {
    const m = this.match;
    const W = (team: number) => (this.soloTeam(team) ? 0 : QUAD_HIT_WINDOW_MS);
    const wH = m.shuttle.isServe ? 0 : W(hs % 2);
    const lagR = this.seatLag[rs];
    const startR = this.ctl(hs) === this.ctl(rs) ? -wH - lagR : lagR;
    const startMe = this.local[hs] ? -wH - this.lagMs : this.lagMs;
    return Math.max(0, startR - startMe + lagR + W(rs % 2) + this.lagMs);
  }

  /** 座位 → 本機球員編號（反過來也一樣） */
  idOf(seat: number): PlayerId {
    return (seat ^ this.mySeat) as PlayerId;
  }
  seatOf(id: PlayerId): number {
    return id ^ this.mySeat;
  }
  /** 標準視角 ↔ 本機視角（自己在 B 隊 = 鏡像） */
  private cv(a: V3): V3 {
    return this.mySeat & 1 ? [-a[0], a[1], -a[2]] : [a[0], a[1], a[2]];
  }
  private vec(a: V3): Vec3 {
    const b = this.cv(a);
    return { x: b[0], y: b[1], z: b[2] };
  }
  /** 標準隊伍（0 = A 隊）↔ 本機隊伍（0 = 自己這隊） */
  private team(t: number): TeamId {
    return (t ^ (this.mySeat & 1)) as TeamId;
  }

  /** 開賽、繼續比賽：新的 ep、序號從 q 開始，搶先的狀態全部作廢 */
  reset(ep: number, q: number): void {
    this.ep = ep;
    this.acc = this.localSeq = q;
    this.spec = [];
    this.queue = [];
    this.lastClaim = null;
  }

  /** 名單改了（AI 代打、還座位、換房主） */
  setRoster(r: QuadRoster, local: boolean[]): void {
    this.roster = r;
    this.local = local;
  }

  /** 這一隊兩個人都在同一支手機上（房主＋AI 隊友、兩個 AI）：不可能隊友搶球，伺服器不用開窗口 */
  private soloTeam(team: number): boolean {
    return this.ctl(team) === this.ctl(team + 2);
  }

  /**
   * 這支手機上，hitter 打出去的球要放慢多少（倍率）：打向自己這隊 → 不放慢（自己要接，時間要準）；
   * 分給本機模擬的 AI 接 → 不放慢（AI 照沒放慢的時間出拍）；
   * 否則整段平均放慢，讓球在「接的人的回擊傳回來」的時候剛好飛到他的擊球點附近（lateMs）；
   * 擊球點用雙打分工 ballTaker 預估（沒有就用落地）
   */
  private dilateFor(id: PlayerId): number {
    const m = this.match;
    const hs = this.seatOf(id);
    const rt = 1 - (hs % 2);
    if (rt === this.mySeat % 2 && !this.spectator) return 1;
    const pred = m.shuttle.prediction;
    if (!pred) return 1;
    const a = ballTaker(m, m.teamOf(id) === 0 ? 1 : 0);
    if (a ? !m.isRemote(a.id) : this.local[rt] || this.local[rt + 2]) return 1;
    const ms = a ? this.lateMs(hs, this.seatOf(a.id)) : (this.lateMs(hs, rt) + this.lateMs(hs, rt + 2)) / 2;
    const T = a ? a.t : pred.landTime;
    const extra = (ms / 1000) * GAME.simSpeed;
    return T > 0.05 ? T / (T + extra) : 1;
  }

  /** 每個模擬 tick（match.step 之後）呼叫 */
  afterStep(): void {
    const m = this.match;
    if (++this.ticks % 4 === 0) for (let seat = 0; seat < 4; seat++) if (this.local[seat]) this.sendState(seat);
    const t = this.now();
    if (t - this.lastPing > 2000) {
      this.lastPing = t;
      this.send({ t: 'ping', a: t }); // 4 人房由伺服器直接回 pong
    }
    // 落地判定送出去很久都沒有結果（例如剛好斷線重連）：再送一次（同一球重複送沒關係，裁決過的會被丟掉）
    const c = this.lastClaim;
    if (m.phase === 'await' && c && c.ev.re === this.acc && t - c.at > 1500) {
      c.at = t;
      this.send(c.ev);
    }
  }

  /** match.drainEvents() 的每個事件都要給這裡看 */
  onEvent(e: MatchEvent): void {
    if (this.spectator) return; // 觀眾不送事件（落地判定由玩家送）
    const m = this.match;
    if (e.type === 'hit' && !m.isRemote(e.player)) {
      const s = this.seatOf(e.player);
      const ev: EvMsg = {
        t: 'ev',
        ep: this.ep,
        re: this.localSeq,
        k: 'hit',
        s,
        ct: e.ct ?? 0,
        d: e.dist ?? 0,
        so: e.serve || this.soloTeam(s % 2) ? 1 : 0,
        h: {
          c: this.cv([e.pos.x, e.pos.y, e.pos.z]),
          v: this.cv([e.vel.x, e.vel.y, e.vel.z]),
          dt: e.stepDt,
          f: e.family,
          n: e.name,
          k: e.speedKmh,
          ch: e.charge,
          q: e.quality,
          g: e.grade,
          s: e.serve,
          j: e.jump,
          d: e.dive,
          w: e.wobble,
          ab: e.attack,
          nf: e.netFault,
          ps: e.powerShort,
        },
      };
      this.spec.push({ ev, snap: m.preLaunch! });
      this.localSeq++;
      this.emit(ev);
    } else if (e.type === 'land' && m.arbitrated && m.phase === 'await' && m.landClaim) {
      const c = m.landClaim;
      const ev: EvMsg = { t: 'ev', ep: this.ep, re: this.localSeq, k: 'land', s: this.mySeat, ct: c.t, w: this.team(c.winner) as 0 | 1, r: c.reason };
      this.lastClaim = { ev, at: this.now() };
      this.emit(ev);
    }
  }

  private emit(ev: EvMsg): void {
    if (ev.re === this.acc) {
      this.stats.sent++;
      this.send(ev);
    } else this.queue.push(ev);
  }

  receive(msg: PeerMsg): void {
    const m = this.match;
    switch (msg.t) {
      case 'pong': {
        const rtt = this.now() - msg.a;
        this.rttMs = this.rttMs ? this.rttMs * 0.7 + rtt * 0.3 : rtt;
        this.lagMs = Math.min(400, this.rttMs) / 2;
        m.netLag = (this.lagMs / 1000) * GAME.simSpeed;
        for (let s = 0; s < 4; s++) if (this.local[s]) this.seatLag[s] = this.lagMs;
        break;
      }
      case 'st': {
        const seat = msg.i ?? -1;
        if (seat < 0 || seat > 3 || this.local[seat]) break;
        if (msg.lg !== undefined) this.seatLag[seat] = msg.lg;
        const d = msg.d ? this.cv([msg.d[1], 0, msg.d[2]]) : null;
        m.setRemoteState(this.idOf(seat), {
          pos: this.vec(msg.p),
          vel: this.vec(msg.v),
          airborne: !!msg.a,
          charging: !!msg.c,
          charge: msg.ch,
          jumpArmed: !!msg.j,
          dive: msg.d && d ? { t: msg.d[0], dx: d[0], dz: d[2] } : null,
          downT: msg.dn,
          swing: msg.sw ? { family: msg.sw[0], t: msg.sw[1], airborne: !!msg.sw[2] } : null,
        });
        break;
      }
      case 'acc':
        this.accepted(msg.q, msg.e);
        break;
    }
  }

  /** 伺服器裁決的第 q 個事件 */
  private accepted(q: number, e: EvMsg): void {
    if (e.ep !== this.ep || q <= this.acc) return; // 舊的（換過 ep）或重複
    const m = this.match;
    this.acc = q;
    this.stats.accepted++;
    const first = this.spec[0];
    if (first && first.ev.k === e.k && first.ev.re === e.re && first.ev.s === e.s && first.ev.ct === e.ct) {
      // 自己搶先的那一下被採用了：什麼都不用改，接著送後面排隊的
      this.spec.shift();
      this.flush();
      return;
    }
    if (this.spec.length) {
      // 被別人搶先（或球先落地）：還原成搶先之前，再套用被採用的
      m.restorePreLaunch(this.spec[0].snap);
      this.spec = [];
      this.stats.undo++;
      this.onUndo(e.k === 'hit' ? this.idOf(e.s) : null);
    }
    this.queue = [];
    this.localSeq = this.acc;
    this.lastClaim = null;
    if (e.k === 'hit') {
      const id = this.idOf(e.s);
      const h = e.h;
      const at = this.cv(h.c);
      if (!h.s && m.shuttle.mode !== 'held') {
        // 收到擊球時本機的球離擊球點多遠（畫面上要滑過去的距離；隊友的另外記）
        const jump = Math.hypot(m.shuttle.pos.x - at[0], m.shuttle.pos.y - at[1], m.shuttle.pos.z - at[2]);
        (e.s % 2 === this.mySeat % 2 ? this.stats.mateJumps : this.stats.jumps).push(jump);
      }
      const hit: RemoteHit = {
        player: id,
        contact: this.vec(h.c),
        vel: this.vec(h.v),
        stepDt: h.dt,
        family: h.f,
        name: h.n,
        speedKmh: h.k,
        charge: h.ch,
        quality: h.q,
        grade: h.g,
        serve: h.s,
        jump: h.j,
        dive: h.d,
        wobble: h.w,
        attack: h.ab ?? 0,
        netFault: h.nf,
        powerShort: h.ps,
      };
      m.applyRemoteHit(hit, 0, true);
    } else {
      m.applyArbitratedPoint(this.team(e.w), e.r);
    }
  }

  /** 前面的確認了：送出排隊中、現在輪到的事件 */
  private flush(): void {
    const ready = this.queue.filter((e) => e.re === this.acc);
    this.queue = this.queue.filter((e) => e.re !== this.acc);
    for (const ev of ready) {
      this.stats.sent++;
      this.send(ev);
      if (ev.k === 'land' && this.lastClaim?.ev === ev) this.lastClaim.at = this.now();
    }
  }

  private sendState(seat: number): void {
    const p = this.match.players[this.idOf(seat)];
    const s = p.swing;
    const pos = this.cv([r3(p.pos.x), r3(p.pos.y), r3(p.pos.z)]);
    const vel = this.cv([r3(p.vel.x), r3(p.vy), r3(p.vel.z)]);
    const dv = p.dive ? this.cv([r3(p.dive.dx), 0, r3(p.dive.dz)]) : null;
    this.send({
      t: 'st',
      i: seat,
      lg: Math.round(this.lagMs),
      p: pos,
      v: vel,
      a: p.airborne ? 1 : 0,
      c: p.charging ? 1 : 0,
      ch: r3(p.charge),
      j: p.jumpArmed ? 1 : 0,
      d: p.dive && dv ? [r3(p.dive.t), dv[0], dv[2]] : 0,
      dn: r3(p.downT),
      sw: s && !s.isServe ? [s.family, r3(s.t), s.airborne ? 1 : 0] : 0,
    });
  }
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;
