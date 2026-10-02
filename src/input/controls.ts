import { idleInput, type PlayerInput } from '../sim/match';
import type { Flick } from '../sim/shots';

const STICK_RADIUS = 60; // 左搖桿最大半徑（px）
const FLICK_PX_TOUCH = 30; // 右手划動超過這個距離就出拍
const FLICK_PX_MOUSE = 26;
const DOUBLE_TAP_MS = 320; // 兩次按下的間隔在這之內 = 連按兩下（跳殺）
const TAP_MAX_MS = 260; // 按住少於這麼久就放開才算「點一下」
const DOUBLE_TAP_PX = 80;

interface Pad {
  id: number;
  ox: number;
  oy: number;
  x: number;
  y: number;
  flicked: boolean;
  jump: boolean;
  downAt: number;
}

/**
 * 本機玩家輸入：
 * - 手機（直向或橫向）：左邊 = 移動搖桿；右邊 = 按住蓄力、往某方向划動出拍（不划直接放開 = 取消）
 *   右手「點一下再按住」= 跳殺
 * - 電腦：WASD 移動；滑鼠按住蓄力、拖曳出拍（或 空白鍵蓄力 + 方向鍵出拍）；連按兩下 = 跳殺
 * - 手把：左搖桿移動；RT/RB/A 蓄力（連按兩下 = 跳殺）；右搖桿撥出去出拍
 */
export class LocalControls {
  private move: Pad | null = null;
  private action: Pad | null = null;
  private lastTap: { t: number; x: number; y: number } | null = null;
  private keys = new Set<string>();
  private pendingFlick: Flick | null = null;
  private kbFlicked = false;
  private kbJump = false;
  private spaceDownAt = 0;
  private lastSpaceTap = 0;
  private gpFlickArmed = true;
  private gpFlicked = false;
  private gpWasCharging = false;
  private gpJump = false;
  private gpDownAt = 0;
  private lastGpTap = 0;
  enabled = true;
  /** 簡單模式：自動跑位，整個螢幕都是擊球區 */
  autoMove = false;
  /** 按下蓄力鍵的瞬間（jump = 這次是連按兩下） */
  onPress: ((jump: boolean) => void) | null = null;

  private baseEl: HTMLElement;
  private knobEl: HTMLElement;
  private ringEl: HTMLElement;
  isTouch = matchMedia('(pointer: coarse)').matches;

  constructor(private surface: HTMLElement, private overlay: HTMLElement) {
    this.baseEl = mk(overlay, 'stick-base');
    this.knobEl = mk(this.baseEl, 'stick-knob');
    this.ringEl = mk(overlay, 'action-ring');

    surface.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
    surface.addEventListener('lostpointercapture', this.onUp);
    surface.addEventListener('contextmenu', (e) => e.preventDefault());
    // 擋掉瀏覽器自己的捲動／縮放／長按選單，降低被系統搶走觸控的機會
    const block = (e: TouchEvent) => e.cancelable && e.preventDefault();
    surface.addEventListener('touchstart', block, { passive: false });
    surface.addEventListener('touchmove', block, { passive: false });
    // 保險：用 TouchEvent 的實際手指清單校正，清掉沒收到 pointerup 的殘留搖桿
    window.addEventListener('touchend', this.reconcile);
    window.addEventListener('touchcancel', this.reconcile);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  /** 清掉所有按住狀態（切換畫面、分頁隱藏、全螢幕切換、轉向時呼叫） */
  reset(): void {
    this.move = null;
    this.action = null;
    this.pendingFlick = null;
    this.keys.clear();
    this.kbJump = false;
    this.kbFlicked = false;
    this.gpFlicked = false;
    this.lastTap = null;
  }

  private onDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    const touch = e.pointerType !== 'mouse';
    if (touch) this.isTouch = true;
    // 第一根手指按下 = 目前沒有其他手指在螢幕上 → 之前的搖桿一定是殘留的
    if (touch && e.isPrimary) {
      this.move = null;
      this.action = null;
    }
    const now = performance.now();
    const pad: Pad = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY, flicked: false, jump: false, downAt: now };

    let toMove: boolean;
    if (!touch || this.autoMove) toMove = false;
    else if (this.action && !this.move) toMove = e.clientX < this.action.ox - 40;
    else if (this.move && !this.action) toMove = e.clientX < this.move.ox + 40;
    else toMove = e.clientX < window.innerWidth * 0.5;

    // 已有手指在用的搖桿不搶（避免手掌誤觸把真正的拇指擠掉）；殘留的會被 isPrimary／reconcile 清掉
    if (toMove) {
      if (!this.move) this.move = pad;
    } else if (!this.action) {
      const lt = this.lastTap;
      pad.jump = !!lt && now - lt.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) < DOUBLE_TAP_PX;
      this.lastTap = null;
      this.action = pad;
      this.pressFx(e.clientX, e.clientY, pad.jump);
      this.onPress?.(pad.jump);
    }
    try {
      this.surface.setPointerCapture(e.pointerId);
    } catch {
      /* 有些瀏覽器不支援 */
    }
    e.preventDefault();
  };

  /** 按下右手蓄力區的視覺回饋：圓環彈一下＋擴散波紋（跳殺為青色） */
  private pressFx(x: number, y: number, jump: boolean): void {
    this.ringEl.classList.remove('pop');
    void this.ringEl.offsetWidth; // 重新觸發動畫
    this.ringEl.classList.add('pop');
    const r = document.createElement('div');
    r.className = jump ? 'press-ripple jump' : 'press-ripple';
    r.style.left = `${x}px`;
    r.style.top = `${y}px`;
    this.overlay.appendChild(r);
    setTimeout(() => r.remove(), 450);
  }

  private onMove = (e: PointerEvent) => {
    if (this.move?.id === e.pointerId) {
      this.move.x = e.clientX;
      this.move.y = e.clientY;
    }
    const a = this.action;
    if (a?.id === e.pointerId) {
      a.x = e.clientX;
      a.y = e.clientY;
      const dx = a.x - a.ox;
      const dy = a.y - a.oy;
      const th = e.pointerType === 'mouse' ? FLICK_PX_MOUSE : FLICK_PX_TOUCH;
      if (!a.flicked && Math.hypot(dx, dy) > th) {
        a.flicked = true;
        this.pendingFlick = { x: dx, y: -dy };
      }
    }
  };

  private onUp = (e: PointerEvent) => {
    if (this.move?.id === e.pointerId) this.move = null;
    const a = this.action;
    if (a?.id === e.pointerId) {
      // 沒划動、很快放開 = 點一下（可能是連按兩下的第一下）
      if (!a.flicked && performance.now() - a.downAt < TAP_MAX_MS) this.lastTap = { t: performance.now(), x: a.ox, y: a.oy };
      this.action = null;
    }
  };

  private reconcile = (e: TouchEvent) => {
    const touches = Array.from(e.touches);
    const alive = (p: Pad | null) => !!p && touches.some((t) => Math.hypot(t.clientX - p.x, t.clientY - p.y) < 70);
    if (this.move && !alive(this.move)) this.move = null;
    if (this.action && !alive(this.action)) this.action = null;
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    this.keys.add(e.code);
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    if (e.code === 'Space' && this.enabled) {
      const now = performance.now();
      this.kbJump = now - this.lastSpaceTap < DOUBLE_TAP_MS;
      this.spaceDownAt = now;
      this.onPress?.(this.kbJump);
    }
    // 空白鍵蓄力中按方向鍵 → 出拍（同時按兩個方向可以斜划）
    if (this.keys.has('Space') && !this.kbFlicked && e.code.startsWith('Arrow')) {
      setTimeout(() => {
        const x = (this.keys.has('ArrowRight') ? 1 : 0) - (this.keys.has('ArrowLeft') ? 1 : 0);
        const y = (this.keys.has('ArrowUp') ? 1 : 0) - (this.keys.has('ArrowDown') ? 1 : 0);
        if ((x || y) && this.keys.has('Space') && !this.kbFlicked) {
          this.kbFlicked = true;
          this.pendingFlick = { x, y };
        }
      }, 45);
    }
  };

  private onKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
    if (e.code === 'Space') {
      const now = performance.now();
      this.lastSpaceTap = !this.kbFlicked && now - this.spaceDownAt < TAP_MAX_MS ? now : 0;
      this.kbFlicked = false;
      this.kbJump = false;
    }
  };

  /** 每個模擬 tick 呼叫一次；出拍事件只會回傳一次 */
  poll(): PlayerInput {
    const inp = idleInput();
    if (!this.enabled) return inp;

    if (this.move) {
      const dx = (this.move.x - this.move.ox) / STICK_RADIUS;
      const dy = (this.move.y - this.move.oy) / STICK_RADIUS;
      const m = Math.hypot(dx, dy);
      if (m > 0.12) {
        // 過了死區至少有 35% 速度，輕推也走得動
        const s = (0.35 + 0.65 * Math.min(1, m)) / m;
        inp.moveX += dx * s;
        inp.moveY += -dy * s;
      }
    }
    const k = this.keys;
    inp.moveX += (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    inp.moveY += (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);

    const a = this.action;
    const touchCharging = !!a && !a.flicked;
    const kbCharging = k.has('Space') && !this.kbFlicked;
    inp.charging = touchCharging || kbCharging;
    inp.jump = (touchCharging && a!.jump) || (kbCharging && this.kbJump);

    // 手把
    const gp = navigator.getGamepads?.().find((g) => g && g.connected);
    if (gp) {
      const ax = (i: number) => (Math.abs(gp.axes[i] ?? 0) > 0.18 ? gp.axes[i] : 0);
      inp.moveX += ax(0);
      inp.moveY += -ax(1);
      const chargeBtn = [7, 5, 0].some((i) => gp.buttons[i]?.pressed);
      const now = performance.now();
      if (chargeBtn && !this.gpWasCharging) {
        this.gpJump = now - this.lastGpTap < DOUBLE_TAP_MS;
        this.gpDownAt = now;
        this.onPress?.(this.gpJump);
      }
      if (!chargeBtn && this.gpWasCharging) {
        this.lastGpTap = !this.gpFlicked && now - this.gpDownAt < TAP_MAX_MS ? now : 0;
        this.gpFlicked = false;
        this.gpJump = false;
      }
      this.gpWasCharging = chargeBtn;
      if (!chargeBtn) this.gpFlicked = false;
      if (chargeBtn && !this.gpFlicked) {
        inp.charging = true;
        inp.jump ||= this.gpJump;
      }
      const rx = gp.axes[2] ?? 0;
      const ry = gp.axes[3] ?? 0;
      const rm = Math.hypot(rx, ry);
      if (rm < 0.3) this.gpFlickArmed = true;
      if (rm > 0.7 && this.gpFlickArmed) {
        this.gpFlickArmed = false;
        this.gpFlicked = true;
        this.pendingFlick = { x: rx, y: -ry };
      }
    }

    if (this.pendingFlick) {
      inp.flick = this.pendingFlick;
      inp.charging = false;
      this.pendingFlick = null;
    }
    return inp;
  }

  /** 更新觸控搖桿外觀；charge 0..1 */
  draw(charge: number, charging: boolean, bottomReserve: number): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    // 預設位置：直向時放在球場下方（離螢幕底部遠一點，避開系統手勢區），橫向時放左右下角
    const restY = bottomReserve > 0 ? Math.min(h * (1 - bottomReserve) + 80, h - 125) : h - 110;
    const restX = bottomReserve > 0 ? w * 0.22 : Math.max(90, w * 0.12);
    const show = this.isTouch && !this.autoMove;
    const showRing = this.isTouch;
    this.baseEl.style.display = show ? 'block' : 'none';
    this.ringEl.style.display = showRing || this.action ? 'block' : 'none';
    const m = this.move;
    if (m) {
      this.baseEl.style.left = `${m.ox}px`;
      this.baseEl.style.top = `${m.oy}px`;
      this.baseEl.classList.add('active');
      let dx = m.x - m.ox;
      let dy = m.y - m.oy;
      const d = Math.hypot(dx, dy);
      if (d > STICK_RADIUS) {
        dx *= STICK_RADIUS / d;
        dy *= STICK_RADIUS / d;
      }
      this.knobEl.style.transform = `translate(${dx}px, ${dy}px)`;
    } else {
      this.baseEl.style.left = `${restX}px`;
      this.baseEl.style.top = `${restY}px`;
      this.baseEl.classList.remove('active');
      this.knobEl.style.transform = '';
    }
    const a = this.action;
    if (a) {
      this.ringEl.style.left = `${a.ox}px`;
      this.ringEl.style.top = `${a.oy}px`;
      this.ringEl.classList.add('active');
    } else {
      this.ringEl.style.left = `${w - restX}px`;
      this.ringEl.style.top = `${restY}px`;
      this.ringEl.classList.remove('active');
    }
    this.ringEl.classList.toggle('jump', !!a?.jump || this.kbJump || this.gpJump);
    this.ringEl.style.setProperty('--charge', `${(charging ? charge : 0) * 360}deg`);
  }
}

function mk(parent: HTMLElement, cls: string): HTMLElement {
  const el = document.createElement('div');
  el.className = cls;
  parent.appendChild(el);
  return el;
}
