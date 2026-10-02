import type { Match, MatchEvent } from '../sim/match';
import { v3 } from '../sim/physics';
import { chargeZones } from '../sim/shots';
import type { GameRenderer } from '../render/scene';


export class Hud {
  private score: HTMLElement;
  private meter: HTMLElement;
  private meterFill: HTMLElement;
  private banner: HTMLElement;
  private bannerSub: HTMLElement;
  private hint: HTMLElement;
  private bannerTimer = 0;
  private meterHold = 0;
  private lastCharge = 0;
  oppName = 'AI';
  /** 訓練關卡進度（有值時記分板改顯示這個） */
  drill: { name: string; rep: number; reps: number; ok: number; goal: string } | null = null;
  private goal: HTMLElement;

  constructor(private root: HTMLElement) {
    this.score = root.querySelector('#scoreboard')!;
    this.meter = root.querySelector('#meter')!;
    this.meterFill = root.querySelector('#meter .fill')!;
    this.banner = root.querySelector('#banner')!;
    this.bannerSub = root.querySelector('#banner .sub')!;
    this.hint = root.querySelector('#hint')!;
    this.goal = root.querySelector('#drillGoal')!;
  }

  onEvent(e: MatchEvent, match: Match, r: GameRenderer, humanId: 0 | 1): void {
    switch (e.type) {
      case 'hit': {
        const mine = e.player === humanId;
        const at = r.project(v3(e.pos.x, e.pos.y + 0.6, e.pos.z));
        const fast = (e.family === 'down' && e.speedKmh > 120) || e.jump;
        let txt = e.name + (fast ? ` ${e.speedKmh} km/h` : '');
        if (e.netFault) txt = `${e.name}（${e.powerShort ? '力道不足' : '擊球不佳'}）`;
        // 自己的球：附上擊球評價，讓玩家知道時機好不好
        const graded = mine && !e.netFault && !e.serve;
        const cls = e.jump ? 'jump' : mine ? (graded && e.grade === '完美' ? 'me perfect' : 'me') : 'opp';
        this.float(graded ? `${txt} · ${e.grade}` : txt, at.x, at.y, cls);
        break;
      }
      case 'whiff':
        if (e.player === humanId) {
          const p = match.players[e.player].pos;
          const at = r.project(v3(p.x, 2.2, p.z));
          const tip = e.reason === '太高' && !e.airborne ? '（試試連按兩下跳殺）' : '';
          this.float(`揮空・${e.reason}${tip}`, at.x, at.y, 'miss');
        }
        break;
      case 'point': {
        const win = e.winner === humanId;
        this.showBanner(e.reason, win ? '你得分！' : `${this.oppName} 得分`, win ? 'win' : 'lose', 1.6);
        break;
      }
      case 'game':
        if (match.phase !== 'matchOver') {
          const win = e.winner === humanId;
          this.showBanner(win ? '你贏得這局！' : 'AI 贏得這局', `局數 ${match.games[humanId]} : ${match.games[humanId === 0 ? 1 : 0]}`, win ? 'win' : 'lose', 1.8);
        }
        break;
    }
  }

  /** 訓練關卡每一球的結果 */
  showRep(ok: boolean, msg: string): void {
    this.showBanner(`${ok ? '✔' : '✘'} ${msg}`, '', `rep ${ok ? 'win' : 'lose'}`, 1.1);
  }

  private showBanner(main: string, sub: string, cls: string, secs: number): void {
    this.banner.firstChild!.textContent = main;
    this.bannerSub.textContent = sub;
    this.banner.className = `show ${cls}`;
    this.bannerTimer = secs;
  }

  private float(text: string, x: number, y: number, cls: string): void {
    const el = document.createElement('div');
    el.className = `float ${cls}`;
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    this.root.appendChild(el);
    setTimeout(() => el.remove(), 1100);
  }

  update(match: Match, r: GameRenderer, dt: number, humanId: 0 | 1): void {
    const opp = humanId === 0 ? 1 : 0;
    const serveDot = (id: number) => (match.server === id && match.phase !== 'matchOver' ? '<i class="dot"></i>' : '');
    const multi = match.settings.games > 1;
    const d = this.drill;
    this.goal.style.display = d ? 'block' : 'none';
    if (d) {
      this.score.innerHTML = `<span>${d.name}</span><b>${Math.min(d.rep, d.reps)}/${d.reps}</b><span class="me">✔ ${d.ok}</span>`;
      this.goal.textContent = d.goal;
    } else
      this.score.innerHTML =
        `<span class="me">${serveDot(humanId)}你${multi ? `<small>${match.games[humanId]}</small>` : ''}<b>${match.score[humanId]}</b></span>` +
        `<span class="sep">:</span>` +
        `<span class="opp"><b>${match.score[opp]}</b>${multi ? `<small>${match.games[opp]}</small>` : ''}${this.oppName}<em>AI</em>${serveDot(opp)}</span>`;

    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.banner.className = '';
    }

    // 發球提示
    const myServe = match.phase === 'serve' && match.server === humanId;
    this.hint.style.display = myServe && match.phaseT > 0.4 ? 'block' : 'none';

    // 蓄力條：跟著自己，顯示掛網／好球／出界區間
    const me = match.players[humanId];
    if (me.charging) {
      this.meterHold = 0.45;
      this.lastCharge = me.charge;
    } else this.meterHold -= dt;
    const visible = me.charging || this.meterHold > 0;
    this.meter.style.display = visible ? 'block' : 'none';
    if (visible) {
      const serving = match.phase === 'serve' && match.server === humanId;
      const z = chargeZones(serving);
      const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
      this.meter.style.background = `linear-gradient(to top,
        #e5484d 0 ${pct(z.net)}, #9be37b ${pct(z.net)} ${pct(z.front)},
        #4cc36b ${pct(z.front)} ${pct(z.deep)}, #1f9d55 ${pct(z.deep)} ${pct(z.out)},
        #e5484d ${pct(z.out)} 100%)`;
      this.meterFill.style.bottom = pct(this.lastCharge);
      const at = r.project(v3(me.pos.x, 1.2, me.pos.z));
      this.meter.style.left = `${Math.min(window.innerWidth - 26, at.x + 44)}px`;
      this.meter.style.top = `${at.y}px`;
    }
  }
}
