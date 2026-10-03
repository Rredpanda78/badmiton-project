/**
 * 4 人房的裁決器（純邏輯，不碰 Cloudflare／網路，伺服器和無畫面測試共用）。
 *
 * 每一個「會影響比分的事件」（ev）都帶著它回應的是第幾個已裁決事件（re）：
 * - 擊球（k = 'hit'，含發球）：回應目前飛行中的那一球；ct = 沿著來球飛了多久才擊中（模擬秒，tick 時間），
 *   d = 擊球時球拍（球員）到球的水平距離
 * - 落地（k = 'land'）：ct = 這一球照確定軌跡落地（或掛網）的時間，w／r = 判定
 *
 * 規則（跟使用者講好的）：同一個 re 只會裁決一個事件 —— 最早擊中的贏，差不到 tie 秒就比誰離球近；
 * 落地也當成一個候選（距離無限大，所以同時間時擊球贏）。第一個候選到達後開一個短窗口（擊球 hitWindowMs、
 * 落地 landWindowMs）收集其他候選，窗口結束才決定。同一隊兩人都在同一支手機上（so = 1，例如房主＋AI 隊友、發球）
 * 不可能有隊友搶球，馬上決定。已經裁決過的 re 再來的事件一律丟掉。
 * 裁決結果蓋上序號 q（= 新的 last），廣播給所有人（包含送出的人）。
 *
 * ep（epoch）：房主開賽／斷線後繼續比賽時換一個新的 ep 並重設序號，舊 ep 的事件都丟掉。
 * 伺服器休眠醒來（記憶體清空）時還不知道 ep／序號：採用第一個收到的事件的 ep、re。
 */

export interface ArbEv {
  t: 'ev';
  ep: number;
  re: number;
  k: 'hit' | 'land';
  ct: number;
  d?: number;
  so?: 0 | 1;
  s: number; // 座位
  [key: string]: unknown;
}

export interface Decision {
  q: number;
  ev: ArbEv;
}

export interface ArbConfig {
  hitWindowMs: number;
  landWindowMs: number;
  tie: number; // 擊中時間差在這個秒數內算同時，比距離
}

export const ARB_DEFAULTS: ArbConfig = { hitWindowMs: 60, landWindowMs: 150, tie: 0.03 };

/** 檢查收到的 JSON 是不是合法的事件（伺服器用，避免壞資料卡住裁決） */
export function isArbEv(x: unknown): x is ArbEv {
  if (!x || typeof x !== 'object') return false;
  const e = x as Record<string, unknown>;
  return (
    e.t === 'ev' &&
    (e.k === 'hit' || e.k === 'land') &&
    Number.isFinite(e.ep) &&
    Number.isFinite(e.re) &&
    Number.isFinite(e.ct) &&
    Number.isInteger(e.s) &&
    (e.d === undefined || Number.isFinite(e.d))
  );
}

export class Arbiter {
  ep = 0;
  last = 0;
  /** 已經知道 ep／序號（剛建立或休眠醒來 = false：採用第一個事件的） */
  known = false;
  private win: { re: number; until: number; cands: ArbEv[] } | null = null;
  readonly stats = { decided: 0, conflicts: 0, rejected: 0, landBeatHit: 0 };
  readonly cfg: ArbConfig;

  constructor(cfg: Partial<ArbConfig> = {}) {
    this.cfg = { ...ARB_DEFAULTS, ...cfg };
  }

  /** 房主開賽／繼續比賽：新的 ep、序號從 q 開始 */
  reset(ep: number, q: number): void {
    this.ep = ep;
    this.last = q;
    this.known = true;
    this.win = null;
  }

  /** 下一次要呼叫 poll 的時間（毫秒）；沒有開著的窗口 = null */
  get due(): number | null {
    return this.win ? this.win.until : null;
  }

  /** 收到一個事件；回傳現在就裁決好的結果（要廣播） */
  submit(ev: ArbEv, now: number): Decision[] {
    if (!this.known) this.reset(ev.ep, ev.re);
    if (ev.ep !== this.ep) {
      // 比較新的 ep：伺服器沒收到房主的重設（例如剛醒來），跟上；舊的 ep 丟掉
      if (ev.ep > this.ep && !this.win) this.reset(ev.ep, ev.re);
      else return this.reject();
    }
    if (ev.re < this.last) return this.reject(); // 這一球已經裁決過了
    if (ev.re > this.last) {
      // 客戶端只會回應已裁決的事件，所以這代表伺服器漏了狀態（休眠）→ 跟上
      if (this.win) return this.reject();
      this.last = ev.re;
    }
    if (!this.win) {
      if (ev.k === 'hit' && ev.so) return [this.decide(ev.re, [ev])];
      this.win = { re: ev.re, until: now + (ev.k === 'hit' ? this.cfg.hitWindowMs : this.cfg.landWindowMs), cands: [ev] };
      return [];
    }
    this.win.cands.push(ev);
    return [];
  }

  /** 時間到就關窗口、裁決 */
  poll(now: number): Decision[] {
    const w = this.win;
    if (!w || now < w.until) return [];
    this.win = null;
    return [this.decide(w.re, w.cands)];
  }

  private reject(): Decision[] {
    this.stats.rejected++;
    return [];
  }

  /** 最早擊中的贏；差不到 tie 秒的比距離（落地 = 無限遠）；都一樣就先到的 */
  private decide(re: number, cands: ArbEv[]): Decision {
    let best = cands[0];
    for (const c of cands) if (c.ct < best.ct) best = c;
    const dist = (c: ArbEv) => (c.k === 'land' ? Infinity : (c.d ?? 0));
    let win = best;
    for (const c of cands) if (c.ct <= best.ct + this.cfg.tie && dist(c) < dist(win)) win = c;
    const hitters = new Set(cands.filter((c) => c.k === 'hit').map((c) => c.s));
    if (hitters.size >= 2) this.stats.conflicts++;
    if (win.k === 'land' && hitters.size) this.stats.landBeatHit++;
    this.stats.decided++;
    this.stats.rejected += cands.length - 1;
    this.last = re + 1;
    return { q: this.last, ev: win };
  }
}
