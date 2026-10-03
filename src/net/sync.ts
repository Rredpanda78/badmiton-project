import { GAME } from '../config';
import type { Match, MatchEvent, PlayerId } from '../sim/match';
import type { Vec3 } from '../sim/physics';
import type { PeerMsg } from './protocol';

/**
 * 線上對戰的同步（不碰 DOM／網路，方便無畫面測試）：
 * - 各自模擬整場比賽；自己的球員由自己控制，對方的位置照收到的狀態外插
 * - 擊球方送「擊球點＋初速」，對方從同一點發出去（軌跡確定），再補上網路延遲
 * - 每一球由「接球方」判定得分（只有他知道自己有沒有接到），擊球方等判定
 * 座標：雙方都把自己放在 z>0（畫面下方），所以收到的座標 x、z 要反過來
 */
export class OnlineSync {
  /** 單程延遲（模擬秒），用 ping 量 */
  latency = 0.02;
  rttMs = 0;
  private ticks = 0;
  private lastPing = -1e9;

  constructor(
    private match: Match,
    private send: (m: PeerMsg) => void,
    private now: () => number = () => performance.now(),
  ) {}

  private get L(): 0 | 1 {
    return this.match.remote === 0 ? 1 : 0;
  }
  private get R(): 0 | 1 {
    return this.match.remote ?? 1;
  }

  /** 每個模擬 tick（match.step 之後）呼叫 */
  afterStep(): void {
    if (++this.ticks % 4 === 0) for (const p of this.match.players) if (!this.match.isRemote(p.id)) this.sendState(p.id);
    const t = this.now();
    if (t - this.lastPing > 2000) {
      this.lastPing = t;
      this.send({ t: 'ping', a: t });
    }
  }

  /** match.drainEvents() 的每個事件都要給這裡看 */
  onEvent(e: MatchEvent): void {
    const m = this.match;
    if (e.type === 'hit' && !m.isRemote(e.player)) {
      this.send({
        t: 'hit',
        i: e.player,
        c: [e.pos.x, e.pos.y, e.pos.z],
        v: [e.vel.x, e.vel.y, e.vel.z],
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
      });
    } else if (e.type === 'point' && !e.byRemote) {
      this.send({ t: 'pt', w: e.winner === this.L ? 'me' : 'you', r: e.reason, sc: [m.score[this.L], m.score[this.R]], gm: [m.games[this.L], m.games[this.R]] });
    }
  }

  receive(msg: PeerMsg): void {
    const m = this.match;
    switch (msg.t) {
      case 'ping':
        this.send({ t: 'pong', a: msg.a });
        break;
      case 'pong': {
        const rtt = this.now() - msg.a;
        this.rttMs = this.rttMs ? this.rttMs * 0.7 + rtt * 0.3 : rtt;
        this.latency = (Math.min(400, this.rttMs) / 2 / 1000) * GAME.simSpeed;
        this.match.netLag = this.latency;
        break;
      }
      case 'st':
        m.setRemoteState(peerId(msg.i), {
          pos: mir(msg.p),
          vel: mir(msg.v),
          airborne: !!msg.a,
          charging: !!msg.c,
          charge: msg.ch,
          jumpArmed: !!msg.j,
          dive: msg.d ? { t: msg.d[0], dx: -msg.d[1], dz: -msg.d[2] } : null,
          downT: msg.dn,
          swing: msg.sw ? { family: msg.sw[0], t: msg.sw[1], airborne: !!msg.sw[2] } : null,
        });
        break;
      case 'hit':
        m.applyRemoteHit(
          {
            player: peerId(msg.i),
            contact: mir(msg.c),
            vel: mir(msg.v),
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
          this.latency,
        );
        break;
      case 'pt': {
        const score: [number, number] = [0, 0];
        const games: [number, number] = [0, 0];
        score[this.R] = msg.sc[0];
        score[this.L] = msg.sc[1];
        games[this.R] = msg.gm[0];
        games[this.L] = msg.gm[1];
        m.applyRemoteVerdict({ remoteWon: msg.w === 'me', reason: msg.r, score, games });
        break;
      }
    }
  }

  private sendState(id: number): void {
    const p = this.match.players[id];
    const s = p.swing;
    this.send({
      t: 'st',
      i: id,
      p: [r3(p.pos.x), r3(p.pos.y), r3(p.pos.z)],
      v: [r3(p.vel.x), r3(p.vy), r3(p.vel.z)],
      a: p.airborne ? 1 : 0,
      c: p.charging ? 1 : 0,
      ch: r3(p.charge),
      j: p.jumpArmed ? 1 : 0,
      d: p.dive ? [r3(p.dive.t), r3(p.dive.dx), r3(p.dive.dz)] : 0,
      dn: r3(p.downT),
      sw: s && !s.isServe ? [s.family, r3(s.t), s.airborne ? 1 : 0] : 0,
    });
  }
}

/** 對方手機上的球員編號 → 本機：雙方都把自己當 0 號（隊友 2 號），在對方那邊就是 1、3 號（xor 1） */
const peerId = (i: number | undefined) => ((i ?? 0) ^ 1) as PlayerId;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
/** 對方視角 → 自己視角：繞球場中心轉 180°（x、z 反號） */
const mir = (a: [number, number, number]): Vec3 => ({ x: -a[0], y: a[1], z: -a[2] });
