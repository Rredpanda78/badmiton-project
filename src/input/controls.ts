import { idleInput, type PlayerInput } from '../sim/match';
import type { Flick } from '../sim/shots';

const STICK_RADIUS = 60; // 左搖桿最大半徑（px）
const FLICK_PX_TOUCH = 30; // 右手划動超過這個距離就出拍
const FLICK_PX_MOUSE = 26;

interface Pad {
  id: number;
  ox: number;
  oy: number;
  x: number;
  y: number;
  flicked: boolean;
}

/**
 * 本機玩家輸入：
 * - 手機（直向或橫向）：左半邊 = 移動搖桿；右半邊 = 按住蓄力、往某方向划動出拍（不划直接放開 = 取消）
 * - 電腦：WASD 移動；滑鼠按住蓄力、拖曳出拍（或 空白鍵蓄力 + 方向鍵出拍）
 * - 手把：左搖桿移動；RT/RB/A 蓄力；右搖桿撥出去出拍
 */
export class LocalControls {
  private move: Pad | null = null;
  private action: Pad | null = null;
  private keys = new Set<string>();
  private pendingFlick: Flick | null = null;
  private kbFlicked = false;
  private gpFlickArmed = true;
  private gpFlicked = false;
  enabled = true;

  private baseEl: HTMLElement;
  private knobEl: HTMLElement;
  private ringEl: HTMLElement;
  isTouch = matchMedia('(pointer: coarse)').matches;

  constructor(surface: HTMLElement, overlay: HTMLElement) {
    this.baseEl = mk(overlay, 'stick-base');
    this.knobEl = mk(this.baseEl, 'stick-knob');
    this.ringEl = mk(overlay, 'action-ring');

    surface.addEventListener('pointerdown', this.onDown);
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('pointercancel', this.onUp);
    surface.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      if (e.code === 'Space') this.kbFlicked = false;
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.move = null;
      this.action = null;
    });
  }

  private onDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    const touch = e.pointerType !== 'mouse';
    if (touch) this.isTouch = true;
    const pad: Pad = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY, flicked: false };
    if (touch && e.clientX < window.innerWidth * 0.5) {
      if (!this.move) this.move = pad;
    } else if (!this.action) {
      this.action = pad;
    }
    e.preventDefault();
  };

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
    if (this.action?.id === e.pointerId) this.action = null;
  };

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.repeat) return;
    this.keys.add(e.code);
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
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

  /** 每個模擬 tick 呼叫一次；出拍事件只會回傳一次 */
  poll(): PlayerInput {
    const inp = idleInput();
    if (!this.enabled) return inp;

    if (this.move) {
      const dx = (this.move.x - this.move.ox) / STICK_RADIUS;
      const dy = (this.move.y - this.move.oy) / STICK_RADIUS;
      const m = Math.hypot(dx, dy);
      if (m > 0.12) {
        const s = Math.min(1, m) / m;
        inp.moveX += dx * s;
        inp.moveY += -dy * s;
      }
    }
    const k = this.keys;
    inp.moveX += (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
    inp.moveY += (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);

    inp.charging = (!!this.action && !this.action.flicked) || (k.has('Space') && !this.kbFlicked);

    // 手把
    const gp = navigator.getGamepads?.().find((g) => g && g.connected);
    if (gp) {
      const ax = (i: number) => (Math.abs(gp.axes[i] ?? 0) > 0.18 ? gp.axes[i] : 0);
      inp.moveX += ax(0);
      inp.moveY += -ax(1);
      const chargeBtn = [7, 5, 0].some((i) => gp.buttons[i]?.pressed);
      if (!chargeBtn) this.gpFlicked = false;
      if (chargeBtn && !this.gpFlicked) inp.charging = true;
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
    // 預設位置：直向時放在下方保留區中間，橫向時放左右下角
    const restY = bottomReserve > 0 ? h * (1 - bottomReserve / 2) : h - 110;
    const restX = bottomReserve > 0 ? w * 0.22 : Math.max(90, w * 0.12);
    const show = this.isTouch;
    this.baseEl.style.display = show ? 'block' : 'none';
    this.ringEl.style.display = show || this.action ? 'block' : 'none';
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
    this.ringEl.style.setProperty('--charge', `${(charging ? charge : 0) * 360}deg`);
  }
}

function mk(parent: HTMLElement, cls: string): HTMLElement {
  const el = document.createElement('div');
  el.className = cls;
  parent.appendChild(el);
  return el;
}
