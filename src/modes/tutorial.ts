// 新手教學：固定流程，一步一步教每個搖桿、每個方向。
// 球快到時畫面會「暫停」，等玩家照提示操作才繼續；做錯就重來那一步。
import { GAME, type ControlScheme } from '../config';
import { flickNow, jumpApexTime, type Match, type MatchEvent, type PlayerInput } from '../sim/match';
import { chargeForDepth } from '../sim/shots';

export type TutHighlight = 'move' | 'action' | 'smash' | 'dive' | null;

interface FeedSpec {
  from: { x: number; y: number; z: number };
  family: 'up' | 'down' | 'side';
  depth: number;
  aimX: number;
  playerAt?: { x: number; z: number };
}

type HitInfo = Extract<MatchEvent, { type: 'hit' }>;

export interface TutStep {
  title: string;
  text: string; // 說明（可含 <b>）
  kind: 'info' | 'charge' | 'move' | 'shot';
  hl?: TutHighlight;
  feed?: FeedSpec;
  /** 什麼時候暫停：contact = 該出拍的那一刻；jump = 跳到快最高點；dive = 球快從身邊飛過 */
  freeze?: 'contact' | 'jump' | 'dive';
  prompt?: string; // 暫停時的大字提示
  range?: [number, number]; // 蓄力划動：需要的落點深度（公尺）→ 換算成蓄力區間
  accept?: (e: HitInfo) => boolean;
  fail?: string; // 打錯時的提示
  assist?: boolean; // 電腦幫忙跑位（預設 true；移動、魚躍這兩步關掉）
  targets?: { x: number; z: number }[]; // move：要走到的位置
}

/** 教學畫面要做的事（main.ts 實作） */
export interface TutUI {
  card(title: string, html: string, button: string | null, progress: string): void;
  prompt(text: string | null): void;
  highlight(h: TutHighlight): void;
  target(zone: { x0: number; x1: number; z0: number; z1: number } | null): void;
  toast(ok: boolean, msg: string): void;
  finish(): void;
}

// ---------- 餵球（對面發球機，固定、打到玩家正前方） ----------
const HIGH = (depth: number): FeedSpec => ({ from: { x: 0, y: 0.9, z: -2.0 }, family: 'up', depth, aimX: 0.12, playerAt: { x: 0, z: 3.7 } });
const NET: FeedSpec = { from: { x: 0, y: 1.0, z: -1.6 }, family: 'down', depth: 1.6, aimX: 0.08, playerAt: { x: 0, z: 2.4 } };
const DRIVE: FeedSpec = { from: { x: 0, y: 1.3, z: -3.6 }, family: 'side', depth: 4.0, aimX: 0.3, playerAt: { x: 0, z: 3.6 } };
// 撲球：對面把小球放太高，球在網前、高於網
const NETPOP: FeedSpec = { from: { x: 0, y: 1.0, z: -1.2 }, family: 'up', depth: 1.9, aimX: 0.08, playerAt: { x: 0, z: 1.9 } };
// 魚躍：殺到右邊邊線，人站在中間偏左，跑不到
const WIDE: FeedSpec = { from: { x: 1.0, y: 2.6, z: -4.2 }, family: 'down', depth: 3.7, aimX: -0.95, playerAt: { x: -0.8, z: 3.8 } }; // aimX 是發球機自己的視角：負 = 玩家的右邊

const is = (...names: string[]) => (e: HitInfo) => names.includes(e.name);
const SMASHES = is('殺球', '跳殺', '下壓', '撲球', '跳撲', '機會殺球');

/** 依操作方式組出教學流程 */
export function buildTutorial(scheme: ControlScheme, autoMove: boolean): TutStep[] {
  const s: TutStep[] = [];
  s.push({
    title: '新手教學',
    text: '一步一步教你怎麼打。球飛過來快要擊球時，畫面會<b>暫停</b>，照著提示做就好。',
    kind: 'info',
  });
  if (autoMove)
    s.push({
      title: '自動跑位',
      text: '現在是<b>自動跑位</b>：電腦會幫你跑到球的位置，你只要專心用<b>右手</b>擊球。<br>（想自己跑，可以到「設定」改成手動跑位）',
      kind: 'info',
    });
  else
    s.push({
      title: '移動',
      text: '左邊是<b>移動搖桿</b>：按住往哪推就往哪跑。走到<b>黃色框</b>裡。',
      kind: 'move',
      hl: 'move',
      assist: false,
      targets: [
        { x: 1.6, z: 5.2 },
        { x: -1.6, z: 2.6 },
      ],
    });

  if (scheme === 'charge') {
    s.push({
      title: '蓄力',
      text: '右手<b>按住</b>螢幕右半邊 = 蓄力，按越久蓄力條越高、球打越遠：<br>下面紅色 = 太小力會掛網、<b>綠色</b> = 好球、上面紅色 = 出界。<br>試試看：按住，在<b>綠色時放開</b>（沒划動就放開 = 取消，不會出拍）。',
      kind: 'charge',
      hl: 'action',
    });
    const shot = (title: string, text: string, feed: FeedSpec, prompt: string, range: [number, number], accept: TutStep['accept'], fail: string): TutStep => ({
      title,
      text,
      kind: 'shot',
      hl: 'action',
      feed,
      freeze: 'contact',
      prompt,
      range,
      accept,
      fail,
    });
    s.push(shot('高遠球 ↑', '對面會打來一顆高球。畫面暫停後<b>按住蓄力</b>，蓄力條到<b>綠色</b>時<b>往上划</b>，把球打到對面底線。', HIGH(5.2), '↑ 往上划！', [4.7, 6.5], is('高遠球', '平高球'), '要往上划（蓄力到綠色）'));
    s.push(shot('殺球 ↓', '暫停後按住蓄力，到<b>綠色中段</b>時<b>往下划</b> = 殺球。', HIGH(4.2), '↓ 往下划！', [3.0, 6.5], SMASHES, '蓄力要多一點（綠色），再往下划'));
    s.push(shot('切球 ↓', '暫停後按住，<b>剛進綠色</b>就往下划 = 切球，球會輕輕落到對面網前。', HIGH(4.2), '↓ 輕輕往下划！', [0.8, 2.4], is('切球'), '蓄力要少一點（剛進綠色就好）'));
    s.push(shot('放小球 ↓', '球打到網前、比網子低的時候：按住一下下（剛進綠色），<b>往下划</b> = 放網。', NET, '↓ 往下划！', [0.6, 2.3], is('放網', '推球', '切球'), '輕輕按一下就好，往下划'));
    s.push(shot('挑球 ↑', '網前的球也可以蓄力到綠色後<b>往上划</b>，把球挑到對面後場。', NET, '↑ 往上划！', [4.0, 6.5], is('挑球', '高遠球', '平高球'), '要往上划（蓄力到綠色）'));
    s.push(shot('平抽 ← →', '球平平飛到胸口高度時，蓄力到綠色，<b>往左或往右划</b> = 平抽。斜著划可以控制方向。', DRIVE, '← → 往左或往右划！', [3.0, 6.5], is('平抽', '平高球'), '要往左或往右划'));
    s.push(shot('撲球（網前）', '對手的小球放太高、球在網前<b>比網子高</b>時：<b>往左或往右划</b>就會變成撲球，又快又往下壓。', NETPOP, '← → 往左或往右划！', [0.6, 6.5], is('撲球', '跳撲'), '球在網前比網高的時候往左右划'));
    s.push({
      ...shot('跳殺', '<b>點一下再按住</b>（連按兩下，圈變青色），球快到時會自動起跳；跳起來後<b>往下划</b>。', HIGH(4.4), '↓ 在空中往下划！', [3.0, 5.6], is('跳殺', '跳撲'), '要在球來之前「點一下再按住」才會起跳'),
      freeze: 'jump',
    });
  } else {
    s.push({
      title: '點擊滑放',
      text: '這個操作<b>不用蓄力</b>：右手按住、<b>往哪滑</b>決定球種，<b>放開的那一刻</b>擊球。上手還是下手會依球的高低自動判斷。<br>球快到時畫面會暫停，你可以慢慢照著提示做。',
      kind: 'info',
    });
    const shot = (title: string, text: string, feed: FeedSpec, prompt: string, accept: TutStep['accept'], fail: string, hl: TutHighlight = 'action'): TutStep => ({
      title,
      text,
      kind: 'shot',
      hl,
      feed,
      freeze: 'contact',
      prompt,
      accept,
      fail,
    });
    s.push(shot('挑球', '網前的低球：按住 → <b>往上滑</b> → 放開 = 挑球，把球挑到後場。（球低的時候自動用下手）', NET, '按住 → ↑ 往上滑放開', is('挑球', '高遠球', '平高球'), '按住往上滑再放開'));
    s.push(shot('放小球', '網前的低球：按住 → <b>往下滑</b>放開 = 放小球，輕輕落到對面網前。', NET, '按住 → ↓ 往下滑放開', is('放網', '推球', '切球'), '按住往下滑再放開'));
    s.push(shot('高遠球', '後場的高球：一樣<b>往上滑</b>放開 = 高遠球（球高的時候自動用上手），時機越準越貼底線。', HIGH(5.2), '按住 → ↑ 往上滑放開', is('高遠球', '平高球'), '按住往上滑再放開'));
    s.push(shot('切球', '後場的高球<b>往下滑</b>放開 = 切球，球會輕輕落到對面網前。', HIGH(4.2), '按住 → ↓ 往下滑放開', is('切球'), '按住往下滑再放開'));
    s.push(shot('平抽', '<b>左右滑</b>放開 = 平抽；球到身邊時<b>只點一下</b> = 平球。', DRIVE, '← → 左右滑放開（或只點一下）', is('平抽', '平高球'), '往左或往右滑再放開'));
    s.push(shot('撲球（網前）', '對手的小球放太高、球在網前<b>比網子高</b>時：<b>只點一下</b>（平球）就會變成撲球，又快又往下壓。', NETPOP, '點一下！', is('撲球', '跳撲'), '球在網前比網高的時候點一下'));
    s.push(shot('殺球（殺球搖桿）', '右上方的<b>「殺」搖桿</b>：往下滑放開 = 殺球，往左右滑可以瞄準。', HIGH(4.2), '「殺」搖桿 ↓ 往下滑放開', SMASHES, '用「殺」搖桿往下滑放開', 'smash'));
    s.push(shot('假殺真切', '「殺」搖桿<b>往上滑</b>放開 = 假裝要殺、其實切球。', HIGH(4.2), '「殺」搖桿 ↑ 往上滑放開', is('切球'), '用「殺」搖桿往上滑放開', 'smash'));
    s.push({
      ...shot('跳殺', '「殺」搖桿<b>點一下再按住</b>，球快到時會自動起跳；在空中滑放開。', HIGH(4.4), '在空中 ↓ 滑放開！', is('跳殺', '跳撲'), '要在球來之前「殺」搖桿點一下再按住', 'smash'),
      freeze: 'jump',
    });
  }

  s.push({
    title: '魚躍撲救',
    text: autoMove
      ? '球打到旁邊、跑不到的時候：左手在橘色<b>「撲」圈</b>往球的方向划，就會撲出去，撲到會<b>自動把球救回網前</b>。'
      : '球打到旁邊、跑不到的時候：移動搖桿<b>連按兩下</b>（圈變橘色）再往球的方向划，就會撲出去，撲到會<b>自動把球救回網前</b>。',
    kind: 'shot',
    hl: 'dive',
    feed: WIDE,
    freeze: 'dive',
    prompt: autoMove ? '左手「撲」圈 → 往右划！' : '移動搖桿連按兩下 → 往右划！',
    accept: (e) => e.dive,
    fail: '要往球的方向（右邊）撲',
    assist: false,
  });
  s.push({
    title: '發球',
    text:
      scheme === 'charge'
        ? '比賽開始時要發球：站在框框裡，按住蓄力 → <b>往上划</b> = 發高遠球、<b>往下划</b> = 發小球、<b>往左右划</b> = 平抽發；蓄到最上面的<b>橘色段</b>再往上划 = <b>彈發</b>（快而平、剛過對手頭頂）。斜著划可以瞄準。<br>手上的球會一上一下：<b>落到最低點時</b>出拍最準，太早或太晚小球會飄高、高遠球變短。'
        : '比賽開始時要發球：站在框框裡，按住 → <b>往上滑放開</b> = 發高遠球、<b>往下滑放開</b> = 發小球、往上<b>滑過第二圈</b>放開 = <b>彈發</b>（快而平、剛過對手頭頂）；「殺」搖桿往上 = 彈發、左右 = <b>平抽發</b>。斜著滑可以瞄準。<br>手上的球會一上一下：<b>落到最低點時</b>放開最準，太早或太晚小球會飄高、高遠球變短。',
    kind: 'info',
  });
  return s;
}

const SLOW = 0.45; // 球飛過來時放慢，讓人有時間準備

/** 跑教學流程 */
export class TutorialRunner {
  idx = 0;
  /** 模擬時間倍率（0 = 暫停） */
  timeScale = 1;
  frozen = false;
  done = false;
  private state: 'card' | 'feedWait' | 'live' | 'frozen' | 'after' | 'next' = 'card';
  private t = 0;
  private hit: HitInfo | null = null;
  private landed = false;
  private held = 0; // 蓄力步驟：放開前最後的蓄力值
  private targetIdx = 0;
  private froze = false; // 這一球已經暫停過（只停一次）

  constructor(
    private match: Match,
    readonly steps: TutStep[],
    private ui: TutUI,
    private scheme: ControlScheme,
  ) {
    this.enter();
  }

  get step(): TutStep {
    return this.steps[this.idx];
  }

  /** 球在飛（說明卡縮小，不擋視線） */
  get inPlay(): boolean {
    return this.state === 'feedWait' || this.state === 'live' || this.state === 'frozen' || this.state === 'after';
  }

  /** 這一步要不要電腦幫忙跑位 */
  get wantAssist(): boolean {
    const st = this.steps[this.idx];
    return !!st && st.assist !== false && st.kind === 'shot';
  }

  private progress(): string {
    return `${Math.min(this.idx + 1, this.steps.length)} / ${this.steps.length}`;
  }

  private enter(retryMsg?: string): void {
    const st = this.step;
    this.state = 'card';
    this.t = 0;
    this.hit = null;
    this.landed = false;
    this.held = 0;
    this.timeScale = 1;
    this.frozen = false;
    this.froze = false;
    this.ui.prompt(null);
    this.ui.highlight(st.hl ?? null);
    this.ui.target(null);
    const text = retryMsg ? `<span class="tut-retry">${retryMsg}，再試一次！</span><br>${st.text}` : st.text;
    if (st.kind === 'info') this.ui.card(st.title, text, this.idx === 0 ? '開始' : '下一步', this.progress());
    else if (st.kind === 'shot') this.ui.card(st.title, text, retryMsg ? '再來一球' : '來球！', this.progress());
    else {
      this.ui.card(st.title, text, null, this.progress());
      if (st.kind === 'move') {
        this.targetIdx = 0;
        this.showTarget();
      }
    }
  }

  private showTarget(): void {
    const p = this.step.targets![this.targetIdx];
    this.ui.target({ x0: p.x - 0.45, x1: p.x + 0.45, z0: p.z - 0.45, z1: p.z + 0.45 });
  }

  /** 卡片上的按鈕 */
  button(): void {
    const st = this.step;
    if (this.state !== 'card') return;
    if (st.kind === 'info') return this.next();
    if (st.kind === 'shot') this.state = 'feedWait';
  }

  private next(): void {
    this.idx++;
    if (this.idx >= this.steps.length) {
      this.done = true;
      this.timeScale = 1;
      this.ui.prompt(null);
      this.ui.highlight(null);
      this.ui.target(null);
      this.ui.finish();
      return;
    }
    this.enter();
  }

  /** 每幀呼叫（真實秒） */
  tick(dt: number): void {
    if (this.done) return;
    const m = this.match;
    const st = this.step;
    const me = m.players[0];
    this.t += dt;
    switch (this.state) {
      case 'card':
        if (st.kind === 'charge') {
          // 在綠色的時候放開就過關
          const lo = chargeForDepth(0.6);
          const hi = chargeForDepth(COURT_OUT);
          if (me.charging) this.held = me.charge;
          else if (this.held > 0) {
            const ok = this.held >= lo && this.held <= hi;
            this.ui.toast(ok, ok ? '很好！就是這樣控制遠近' : this.held < lo ? '太早放了（紅色 = 掛網）' : '太晚放了（紅色 = 出界）');
            this.held = 0;
            if (ok) {
              this.state = 'next';
              this.t = 0;
            }
          }
        } else if (st.kind === 'move') {
          const p = st.targets![this.targetIdx];
          if (Math.hypot(me.pos.x - p.x, me.pos.z - p.z) < 0.5) {
            this.targetIdx++;
            if (this.targetIdx >= st.targets!.length) {
              this.ui.target(null);
              this.ui.toast(true, '會跑了！');
              this.state = 'next';
              this.t = 0;
            } else this.showTarget();
          }
        }
        break;
      case 'feedWait':
        if (m.phase === 'drill') {
          m.feed(st.feed!);
          this.state = 'live';
          this.timeScale = SLOW;
          this.ui.prompt(null);
        }
        break;
      case 'after':
        // 擊球後等球落地（最多 2.5 秒），再判定
        if (this.landed || this.t > 2.5) this.judge();
        break;
      case 'next':
        if (this.t > 1.1) this.next();
        break;
    }
    if (this.state === 'frozen') this.updatePrompt();
  }

  /** 每個模擬 tick 之後呼叫：回傳 true = 現在要暫停 */
  checkFreeze(): boolean {
    if (this.state !== 'live') return false;
    if (this.froze) return false;
    const m = this.match;
    const me = m.players[0];
    const st = this.step;
    let freeze = false;
    if (st.freeze === 'dive') {
      // 球快飛到自己這一排的深度、而且很低 → 撲
      const sh = m.shuttle;
      if (sh.prediction && sh.lastHitter === 1) {
        const el = m.time - sh.launchTime;
        for (const pt of sh.prediction.points) {
          if (pt.t < el) continue;
          if (pt.p.z >= me.pos.z - 0.5 && pt.p.y < GAME.dive.maxY) {
            freeze = pt.t - el <= GAME.dive.dur * 0.7;
            break;
          }
        }
      }
    } else {
      if (st.freeze === 'jump' && me.airborne) freeze = m.time - me.takeoffAt >= jumpApexTime() * 0.8;
      else {
        freeze = flickNow(m, 0, 0.01);
      }
    }
    if (!freeze) return false;
    this.state = 'frozen';
    this.frozen = true;
    this.froze = true;
    this.timeScale = 0;
    this.updatePrompt();
    return true;
  }

  /** 暫停中的提示：蓄力划動要先蓄到對的區間 */
  private updatePrompt(): void {
    const st = this.step;
    const me = this.match.players[0];
    if (this.scheme === 'charge' && st.range && st.freeze !== 'dive') {
      const lo = chargeForDepth(st.range[0]);
      const hi = chargeForDepth(st.range[1]);
      if (!me.charging) return this.ui.prompt('右手按住蓄力');
      if (me.charge < lo) return this.ui.prompt('繼續按住…');
      if (me.charge > hi) return this.ui.prompt('蓄太多了！放開重新按');
    }
    this.ui.prompt(st.prompt ?? null);
  }

  /** 暫停中每幀把玩家輸入給這裡：回傳要拿去推進模擬的輸入（null = 繼續暫停） */
  frozenInput(inp: PlayerInput): PlayerInput | null {
    if (this.state !== 'frozen') return null;
    const st = this.step;
    const go = st.freeze === 'dive' ? !!inp.dive : !!inp.flick;
    if (!go) return null;
    this.state = 'live';
    this.frozen = false;
    this.timeScale = 1;
    this.ui.prompt(null);
    return inp;
  }

  onEvent(e: MatchEvent): void {
    if (this.done) return;
    if (e.type === 'hit' && e.player === 0 && !this.hit) {
      this.hit = e;
      if (this.state === 'live' || this.state === 'frozen') {
        this.state = 'after';
        this.t = 0;
        this.timeScale = 1;
      }
    }
    if (e.type === 'drillLand') {
      this.landed = true;
      if (this.state === 'live' || this.state === 'frozen') {
        // 沒打到就落地了
        this.state = 'after';
        this.t = 0;
      }
    }
  }

  private judge(): void {
    const st = this.step;
    const h = this.hit;
    let ok = false;
    let msg: string;
    if (!h) msg = '沒打到';
    else if (h.netFault) msg = st.fail ?? '掛網了';
    else if (st.accept && !st.accept(h)) msg = `打成「${h.name}」了：${st.fail ?? '再試一次'}`;
    else {
      ok = true;
      msg = h.dive ? '救起來了！' : `${h.name}！${h.grade === '完美' ? '完美' : '成功'}`;
    }
    this.ui.toast(ok, msg);
    if (ok) {
      this.state = 'next';
      this.t = 0;
    } else this.enter(msg);
  }
}

/** 蓄力步驟的上限：剛好打到底線 */
const COURT_OUT = 6.6;
