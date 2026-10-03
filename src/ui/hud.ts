import type { Match, MatchEvent, PlayerId } from '../sim/match';
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
  /** 對手名字旁的小標籤（AI／線上） */
  oppTag = 'AI';
  /** 訓練關卡進度（有值時記分板改顯示這個） */
  drill: { name: string; rep: number; reps: number; ok: number; goal: string } | null = null;
  /** 觀戰：記分板兩邊都顯示真名（teamNames，以隊伍為索引），不顯示發球提示、蓄力條、自己的時機評價 */
  spectator = false;
  teamNames: [string, string] = ['', ''];
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

  onEvent(e: MatchEvent, match: Match, r: GameRenderer, humanId: PlayerId): void {
    if (this.spectator) return this.onSpecEvent(e, match, r);
    const myTeam = match.teamOf(humanId);
    const we = match.doubles ? '你們' : '你';
    switch (e.type) {
      case 'hit': {
        const mine = e.player === humanId;
        const mate = !mine && match.teamOf(e.player) === myTeam; // 雙打隊友
        const at = r.project(v3(e.pos.x, e.pos.y + 0.6, e.pos.z));
        const fast = (e.family === 'down' && e.speedKmh > 120) || e.jump;
        let txt = (e.dive ? '魚躍救球・' : '') + e.name + (fast ? ` ${e.speedKmh} km/h` : '');
        if (e.netFault) txt = `${e.name}（${e.powerShort ? '力道不足' : '擊球不佳'}）`;
        // 自己的球：附上出拍時機（完美／稍早／過早／稍晚／過晚；跳殺、魚躍沒有時機就附評價）
        const graded = mine && !e.netFault && !e.serve;
        const tag = e.timing !== undefined && e.timingFlat ? timingLabel(e.timing, e.timingFlat) : e.grade;
        const cls = e.jump ? 'jump' : mine ? (graded && tag === '完美' ? 'me perfect' : graded && (tag === '過早' || tag === '過晚') ? 'me off' : 'me') : mate ? 'mate' : 'opp';
        // 時機再好、被調動或來球太快也打不出好球：告訴玩家為什麼
        const why = (e.pressure ?? 0) >= 0.45 ? '被調動' : (e.heat ?? 0) >= 0.5 ? '來球太快' : '';
        this.float(graded ? `${txt} · ${tag}${why ? `（${why}）` : ''}` : txt, at.x, at.y, cls);
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
      case 'net':
        if (match.shuttle.lastHitter === humanId) {
          const at = r.project(v3(e.pos.x, e.pos.y + 0.5, e.pos.z));
          this.float('失誤・掛網', at.x, at.y, 'miss');
        }
        break;
      case 'land': {
        // 自己打出界：說是太長還是偏左／偏右（以自己看出去的方向）
        const h = match.shuttle.lastHitter;
        if (h !== humanId || e.inBounds) break;
        const side = match.players[humanId].side;
        if (e.pos.z * side > 0) break; // 落在自己場內 = 掛網落下，上面已經說過
        const W = match.doubles ? 3.05 : 2.59;
        const long = Math.abs(e.pos.z) > 6.7;
        const wide = Math.abs(e.pos.x) > W;
        const dir = wide ? (e.pos.x * side > 0 ? '偏右' : '偏左') : '';
        const at = r.project(v3(e.pos.x, 0.5, e.pos.z));
        this.float(`出界（${[long ? '太長' : '', dir].filter(Boolean).join('、') || '發球區外'}）`, at.x, at.y, 'miss');
        break;
      }
      case 'point': {
        const win = e.winner === myTeam;
        this.showBanner(e.reason, win ? `${we}得分！` : `${this.oppName} 得分`, win ? 'win' : 'lose', 1.6);
        break;
      }
      case 'game':
        if (match.phase !== 'matchOver') {
          const win = e.winner === myTeam;
          this.showBanner(win ? `${we}贏得這局！` : `${this.oppName} 贏得這局`, `局數 ${match.games[myTeam]} : ${match.games[myTeam === 0 ? 1 : 0]}`, win ? 'win' : 'lose', 1.8);
        }
        break;
    }
  }

  /** 觀戰：中立的字幕（球種＋球速、誰得分、誰贏得這局），顏色照隊伍（0 = 藍、1 = 紅） */
  private onSpecEvent(e: MatchEvent, match: Match, r: GameRenderer): void {
    switch (e.type) {
      case 'hit': {
        const at = r.project(v3(e.pos.x, e.pos.y + 0.6, e.pos.z));
        const fast = (e.family === 'down' && e.speedKmh > 120) || e.jump;
        let txt = (e.dive ? '魚躍救球・' : '') + e.name + (fast ? ` ${e.speedKmh} km/h` : '');
        if (e.netFault) txt = `${e.name}（${e.powerShort ? '力道不足' : '擊球不佳'}）`;
        this.float(txt, at.x, at.y, e.jump ? 'jump' : match.teamOf(e.player) === 0 ? 'me' : 'opp');
        break;
      }
      case 'net': {
        const at = r.project(v3(e.pos.x, e.pos.y + 0.5, e.pos.z));
        this.float('掛網', at.x, at.y, 'miss');
        break;
      }
      case 'land':
        if (!e.inBounds) {
          const at = r.project(v3(e.pos.x, 0.5, e.pos.z));
          this.float('出界', at.x, at.y, 'miss');
        }
        break;
      case 'point':
        this.showBanner(e.reason, `${this.teamNames[e.winner]} 得分`, 'intro', 1.6);
        break;
      case 'game':
        if (match.phase !== 'matchOver') this.showBanner(`${this.teamNames[e.winner]} 贏得這局`, `局數 ${match.games[0]} : ${match.games[1]}`, 'intro', 1.8);
        break;
    }
  }

  /** 一直顯示的提示（線上斷線等待等）；null = 收起 */
  notice(text: string | null): void {
    if (!this.noticeEl) {
      this.noticeEl = document.createElement('div');
      this.noticeEl.id = 'notice';
      this.root.appendChild(this.noticeEl);
    }
    this.noticeEl.textContent = text ?? '';
    this.noticeEl.classList.toggle('show', !!text);
  }
  private noticeEl: HTMLElement | null = null;

  /** 自動跑位的預判：讀對立刻起步、猜錯慢一步 */
  readFeedback(ok: boolean, x: number, y: number): void {
    this.float(ok ? '讀對了！' : '猜錯了', x, y, ok ? 'me perfect' : 'miss');
  }

  /** 畫面上某個位置飄一行字（線上 4 人房：搶先打的那一下沒被採用） */
  note(text: string, x: number, y: number, cls = 'miss'): void {
    this.float(text, x, y, cls);
  }

  /** 開場介紹對手 */
  intro(name: string, text: string): void {
    this.showBanner(name, text, 'intro', 2.6);
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

  update(match: Match, r: GameRenderer, dt: number, humanId: PlayerId): void {
    // 比分、局數以隊伍為索引（單打：隊伍 = 球員編號）；發球點標在發球的那一隊
    const mine = match.teamOf(humanId);
    const opp = mine === 0 ? 1 : 0;
    const serveDot = (team: number) => (match.teamOf(match.server) === team && match.phase !== 'matchOver' ? '<i class="dot"></i>' : '');
    const multi = match.settings.games > 1;
    const d = this.drill;
    this.goal.style.display = d && d.goal ? 'block' : 'none';
    if (d) {
      this.score.innerHTML = `<span>${d.name}</span><b>${Math.min(d.rep, d.reps)}/${d.reps}</b><span class="me">✔ ${d.ok}</span>`;
      this.goal.textContent = d.goal;
    } else if (this.spectator) {
      // 觀戰：左邊 = 畫面下方那隊（humanId 的隊伍），兩邊都是真名；顏色照隊伍（A 隊／房主藍、對方紅）
      const name = (t: number) => `<span class="nm">${esc(this.teamNames[t])}</span>`;
      const cls = (t: number) => (t === 0 ? 'me' : 'opp');
      this.score.innerHTML =
        `<span class="${cls(mine)}">${serveDot(mine)}${name(mine)}${multi ? `<small>${match.games[mine]}</small>` : ''}<b>${match.score[mine]}</b></span>` +
        `<span class="sep">:</span>` +
        `<span class="${cls(opp)}"><b>${match.score[opp]}</b>${multi ? `<small>${match.games[opp]}</small>` : ''}${name(opp)}${serveDot(opp)}</span>`;
    } else
      this.score.innerHTML =
        `<span class="me">${serveDot(mine)}${match.doubles ? '你們' : '你'}${multi ? `<small>${match.games[mine]}</small>` : ''}<b>${match.score[mine]}</b></span>` +
        `<span class="sep">:</span>` +
        `<span class="opp"><b>${match.score[opp]}</b>${multi ? `<small>${match.games[opp]}</small>` : ''}${this.oppName}<em>${this.oppTag}</em>${serveDot(opp)}</span>`;

    if (this.bannerTimer > 0) {
      this.bannerTimer -= dt;
      if (this.bannerTimer <= 0) this.banner.className = '';
    }

    if (this.spectator) {
      // 觀眾沒有發球提示、蓄力條
      this.hint.style.display = 'none';
      this.meter.style.display = 'none';
      return;
    }

    // 發球提示
    const myServe = match.phase === 'serve' && match.server === humanId;
    this.hint.style.display = myServe && match.phaseT > 0.4 ? 'block' : 'none';
    if (myServe)
      this.hint.innerHTML =
        match.settings.scheme === 'tap'
          ? '發球：按住 → <b>往上滑放開</b> 發高遠球、<b>往下滑放開</b> 發小球'
          : '發球：按住蓄力 → <b>往上划</b> 發高遠球、<b>往下划</b> 發小球';

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
      const z = chargeZones(serving, match.doubles);
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

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** 出拍時機：d = 比理想早多少（秒，正 = 早），flat = 完美的寬度 */
function timingLabel(d: number, flat: number): string {
  if (Math.abs(d) <= flat) return '完美';
  if (d > 0) return d <= flat * 2.2 ? '稍早' : '過早';
  return d >= -flat * 2.2 ? '稍晚' : '過晚';
}
