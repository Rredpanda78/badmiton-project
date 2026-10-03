import { idleInput, type PlayerInput } from '../sim/match';
import type { ControlScheme } from '../config';
import type { Flick } from '../sim/shots';

const STICK_RADIUS = 60; // 左搖桿最大半徑（px）
const FLICK_PX_TOUCH = 30; // 右手划動超過這個距離就出拍
const FLICK_PX_MOUSE = 26;
const DOUBLE_TAP_MS = 320; // 兩次按下的間隔在這之內 = 連按兩下（跳殺）
const TAP_MAX_MS = 260; // 按住少於這麼久就放開才算「點一下」
const DOUBLE_TAP_PX = 80;
const SLIDE_PX = 22; // 點擊滑放：放開時滑超過這個距離才算出拍

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
  private pendingDive: { x: number; y: number } | null = null;
  private lastMoveTap: { t: number; x: number; y: number } | null = null;
  private gpWasDive = false;
  /** 自動跑位時左邊撲救區的右緣（px），draw() 每格更新 */
  private diveZoneX = 0;
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
  /** 自動跑位時由電腦自動魚躍（就不顯示左邊撲救區） */
  autoDive = false;
  /** 觸發魚躍的瞬間（UI 回饋用） */
  onDive: (() => void) | null = null;
  /** 擊球操作方式：charge = 蓄力划動、tap = 點擊滑放＋殺球鍵 */
  scheme: ControlScheme = 'charge';
  private smashEl: HTMLButtonElement;
  private labelEl: HTMLElement;
  private smashPad: Pad | null = null;
  private lastSmashTap = 0;
  private smashKnob!: HTMLElement;
  /** 教學：目前要閃的控制 */
  private hl: 'move' | 'action' | 'smash' | 'dive' | null = null;
  private hlEl: HTMLElement;
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
    this.labelEl = mk(overlay, 'pad-label');
    this.smashEl = document.createElement('button');
    this.smashEl.className = 'smash-btn';
    this.smashEl.innerHTML = '<span>殺</span>';
    overlay.appendChild(this.smashEl);
    this.smashEl.addEventListener('pointerdown', this.onSmashDown);
    this.smashEl.addEventListener('pointerup', this.onSmashUp);
    this.smashEl.addEventListener('pointercancel', () => (this.smashPad = null));
    this.smashKnob = mk(this.smashEl, 'smash-knob');
    this.hlEl = mk(overlay, 'tut-ring');

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

  /** 教學：讓某個控制一直閃（null = 不閃） */
  highlight(h: 'move' | 'action' | 'smash' | 'dive' | null): void {
    this.hl = h;
  }

  /** 清掉所有按住狀態（切換畫面、分頁隱藏、全螢幕切換、轉向時呼叫） */
  reset(): void {
    this.move = null;
    this.action = null;
    this.pendingFlick = null;
    this.pendingDive = null;
    this.lastMoveTap = null;
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
    if (!touch) toMove = false;
    else if (this.autoMove) toMove = !this.autoDive && e.clientX < this.diveZoneX; // 自動跑位：左邊 = 撲救區
    else if (this.action && !this.move) toMove = e.clientX < this.action.ox - 40;
    else if (this.move && !this.action) toMove = e.clientX < this.move.ox + 40;
    else toMove = e.clientX < window.innerWidth * 0.5;

    // 已有手指在用的搖桿不搶（避免手掌誤觸把真正的拇指擠掉）；殘留的會被 isPrimary／reconcile 清掉
    if (toMove) {
      if (!this.move) {
        // 連按兩下移動搖桿 = 魚躍待命（接著往哪划就往哪撲）；自動跑位的撲救區一按就待命
        const lt = this.lastMoveTap;
        pad.jump = this.autoMove || (!!lt && now - lt.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) < DOUBLE_TAP_PX);
        this.lastMoveTap = null;
        this.move = pad;
        if (pad.jump && !this.autoMove) this.pressFx(e.clientX, e.clientY, false, true);
      }
    } else if (!this.action) {
      const lt = this.lastTap;
      // 連按兩下 = 跳殺（只有蓄力划動用；點擊滑放的跳殺在「殺」搖桿）
      pad.jump = this.scheme === 'charge' && !!lt && now - lt.t < DOUBLE_TAP_MS && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) < DOUBLE_TAP_PX;
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
  private pressFx(x: number, y: number, jump: boolean, dive = false): void {
    if (!dive) {
      this.ringEl.classList.remove('pop');
      void this.ringEl.offsetWidth; // 重新觸發動畫
      this.ringEl.classList.add('pop');
    }
    const r = document.createElement('div');
    r.className = dive ? 'press-ripple dive' : jump ? 'press-ripple jump' : 'press-ripple';
    r.style.left = `${x}px`;
    r.style.top = `${y}px`;
    this.overlay.appendChild(r);
    setTimeout(() => r.remove(), 450);
  }

  private onMove = (e: PointerEvent) => {
    if (this.smashPad?.id === e.pointerId) {
      this.smashPad.x = e.clientX;
      this.smashPad.y = e.clientY;
    }
    if (this.move?.id === e.pointerId) {
      this.move.x = e.clientX;
      this.move.y = e.clientY;
      const mv = this.move;
      const dx = mv.x - mv.ox;
      const dy = mv.y - mv.oy;
      if (mv.jump && !mv.flicked && Math.hypot(dx, dy) > FLICK_PX_TOUCH) {
        mv.flicked = true;
        this.pendingDive = { x: dx, y: -dy };
        this.onDive?.();
        this.pressFx(mv.x, mv.y, false, true);
      }
    }
    const a = this.action;
    if (a?.id === e.pointerId) {
      a.x = e.clientX;
      a.y = e.clientY;
      const dx = a.x - a.ox;
      const dy = a.y - a.oy;
      const th = e.pointerType === 'mouse' ? FLICK_PX_MOUSE : FLICK_PX_TOUCH;
      if (this.scheme === 'charge' && !a.flicked && Math.hypot(dx, dy) > th) {
        a.flicked = true;
        this.pendingFlick = { x: dx, y: -dy };
      }
    }
  };

  private onUp = (e: PointerEvent) => {
    const mv = this.move;
    if (mv?.id === e.pointerId) {
      // 移動搖桿快速點一下（沒怎麼拖）= 可能是連按兩下魚躍的第一下
      if (!this.autoMove && !mv.jump && performance.now() - mv.downAt < TAP_MAX_MS && Math.hypot(mv.x - mv.ox, mv.y - mv.oy) < SLIDE_PX) {
        this.lastMoveTap = { t: performance.now(), x: mv.ox, y: mv.oy };
      }
      this.move = null;
    }
    const a = this.action;
    if (a?.id === e.pointerId) {
      const dx = a.x - a.ox;
      const dy = a.y - a.oy;
      if (this.scheme === 'tap' && Math.hypot(dx, dy) > SLIDE_PX) {
        // 點擊滑放：放開的那一刻出拍。上手／下手由擊球點高低自動決定
        this.pendingFlick = tapShot(dx, -dy);
      } else if (this.scheme === 'tap') {
        // 只點不滑 = 平球（網前高於網 = 撲球）；球還沒到身邊就不算（避免太早亂點）
        this.pendingFlick = { x: 0, y: 0, cmd: { family: 'side', depth: 5.0, soft: true } };
      } else if (!a.flicked && performance.now() - a.downAt < TAP_MAX_MS) {
        // 沒划動、很快放開 = 點一下（可能是連按兩下的第一下）
        this.lastTap = { t: performance.now(), x: a.ox, y: a.oy };
      }
      this.action = null;
    }
  };

  /**
   * 殺球搖桿（點擊滑放模式）：按住拖曳、放開出拍。
   * 往下／左右 = 殺球（左右決定落點）；往上 = 假殺真切（切球）。後場殺球、前場撲球。
   * 點一下再按住 = 跳殺待命（球快到時自動起跳，滯空時放開）
   */
  private onSmashDown = (e: PointerEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    e.stopPropagation();
    const now = performance.now();
    const lt = this.lastSmashTap;
    const jump = now - lt < DOUBLE_TAP_MS;
    this.lastSmashTap = 0;
    this.smashPad = { id: e.pointerId, ox: e.clientX, oy: e.clientY, x: e.clientX, y: e.clientY, flicked: false, jump, downAt: now };
    this.smashEl.classList.add('down');
    try {
      this.smashEl.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    this.onPress?.(jump);
  };

  private onSmashUp = (e: PointerEvent) => {
    const s = this.smashPad;
    this.smashEl.classList.remove('down');
    if (!s || s.id !== e.pointerId) return;
    this.smashPad = null;
    if (!this.enabled) return;
    const dx = e.clientX - s.ox;
    const dy = e.clientY - s.oy;
    if (Math.hypot(dx, dy) <= SLIDE_PX) {
      // 沒拖曳 = 直線殺球（球快到身邊才出拍；球還遠就只是跳殺連按兩下的第一下）
      this.pendingFlick = { x: 0, y: -1, cmd: { family: 'down', depth: 'smash', soft: true } };
      if (performance.now() - s.downAt < TAP_MAX_MS) this.lastSmashTap = performance.now();
      return;
    }
    const nx = dx / Math.hypot(dx, dy);
    if (dy < 0 && Math.abs(nx) < 0.77) {
      // 往上 = 假殺球、真切球
      this.pendingFlick = { x: dx, y: -dy, cmd: { family: 'down', depth: 1.2 } };
    } else {
      // 往下或左右 = 殺球，左右分量瞄準
      this.pendingFlick = { x: dx, y: -Math.max(Math.abs(dy), 8), cmd: { family: 'down', depth: 'smash' } };
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
    if (e.code.startsWith('Shift') && this.enabled) {
      // Shift = 往 WASD 的方向魚躍
      const k = this.keys;
      const x = (k.has('KeyD') ? 1 : 0) - (k.has('KeyA') ? 1 : 0);
      const y = (k.has('KeyW') ? 1 : 0) - (k.has('KeyS') ? 1 : 0);
      if (x || y) this.pendingDive = { x, y };
    }
    if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
    if (e.code === 'Space' && this.enabled && this.scheme === 'tap') {
      this.smashEl.classList.add('down');
      this.onPress?.(false);
      return;
    }
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
    if (e.code === 'Space' && this.scheme === 'tap' && this.enabled) {
      this.keys.delete(e.code);
      this.smashEl.classList.remove('down');
      this.pendingFlick = { x: 0, y: -1, cmd: { family: 'down', depth: 'smash' } };
      return;
    }
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

    // 魚躍待命中（還沒划出去）不走；按太久沒划就當一般移動
    if (this.move?.jump && !this.move.flicked && !this.autoMove && performance.now() - this.move.downAt > 450) this.move.jump = false;
    if (this.move && !this.autoMove && !(this.move.jump && !this.move.flicked)) {
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
      // B = 往左搖桿方向魚躍
      const diveBtn = !!gp.buttons[1]?.pressed;
      if (diveBtn && !this.gpWasDive && Math.hypot(ax(0), ax(1)) > 0) this.pendingDive = { x: ax(0), y: -ax(1) };
      this.gpWasDive = diveBtn;
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

    if (this.scheme === 'tap') {
      // 點擊滑放不用蓄力
      inp.charging = false;
      inp.jump = !!this.smashPad?.jump; // 殺球搖桿點一下再按住 = 跳殺待命
    }
    if (this.pendingDive) {
      inp.dive = this.pendingDive;
      this.pendingDive = null;
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
    // 右手圈與殺球搖桿：自動跑位時右手圈靠中間一點，殺球搖桿在它右上方；手動時殺球搖桿在右手圈正上方
    const ringX = this.autoMove ? w * (bottomReserve > 0 ? 0.6 : 0.72) : w - restX;
    const smashX = this.autoMove ? ringX + 74 : ringX;
    const smashY = this.autoMove ? restY - 92 : restY - 112;
    // 自動跑位：左邊的圈變成「撲」救區（電腦自動魚躍時不顯示）
    const divePad = this.autoMove && !this.autoDive;
    this.diveZoneX = divePad ? Math.min(ringX - 100, w * 0.45) : 0;
    const show = this.isTouch && (!this.autoMove || divePad);
    this.baseEl.classList.toggle('dive-pad', divePad);
    this.baseEl.classList.toggle('armed', !!this.move?.jump && !this.move.flicked && !this.autoMove);
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
      this.ringEl.style.left = `${ringX}px`;
      this.ringEl.style.top = `${restY}px`;
      this.ringEl.classList.remove('active');
    }
    this.ringEl.classList.toggle('jump', !!a?.jump || this.kbJump || this.gpJump);
    this.ringEl.style.setProperty('--charge', `${(charging ? charge : 0) * 360}deg`);

    // 點擊滑放：殺球鍵放在右手圈上方；按住時顯示目前是下手還是上手
    const tap = this.scheme === 'tap';
    this.smashEl.style.display = tap && this.enabled ? 'block' : 'none';
    if (tap) {
      this.smashEl.style.left = `${smashX}px`;
      this.smashEl.style.top = `${smashY}px`;
    }
    // 殺球搖桿：小搖桿頭跟著手指，最多偏 30 px
    const sp = this.smashPad;
    let kx = 0;
    let ky = 0;
    if (sp) {
      kx = sp.x - sp.ox;
      ky = sp.y - sp.oy;
      const d = Math.hypot(kx, ky);
      if (d > 30) {
        kx *= 30 / d;
        ky *= 30 / d;
      }
    }
    this.smashKnob.style.transform = `translate(${kx}px, ${ky}px)`;
    this.smashEl.classList.toggle('jump', !!sp?.jump);

    // 教學的閃爍圈：疊在要用的那個控制上
    const hlTarget = this.hl === 'action' ? this.ringEl : this.hl === 'smash' ? this.smashEl : this.hl ? this.baseEl : null;
    const hlOn = !!hlTarget && hlTarget.style.display !== 'none';
    this.hlEl.style.display = hlOn ? 'block' : 'none';
    if (hlOn) {
      const size = hlTarget.offsetWidth + 24;
      this.hlEl.style.left = hlTarget.style.left;
      this.hlEl.style.top = hlTarget.style.top;
      this.hlEl.style.width = this.hlEl.style.height = `${size}px`;
      this.hlEl.style.margin = `${-size / 2}px 0 0 ${-size / 2}px`;
    }

    const showLabel = tap && (!!a || !!sp);
    this.labelEl.style.display = showLabel ? 'block' : 'none';
    if (showLabel && sp) {
      this.labelEl.textContent = sp.jump ? '跳殺　↓殺球　↑切球' : '殺球　←→瞄準　↓殺　↑假殺真切';
      this.labelEl.classList.toggle('over', sp.jump);
      // 置中在殺球搖桿上方，但不能超出螢幕
      const half = this.labelEl.offsetWidth / 2 + 8;
      this.labelEl.style.left = `${Math.max(half, Math.min(w - half, smashX))}px`;
      this.labelEl.style.top = `${smashY - 58}px`;
    } else if (showLabel && a) {
      this.labelEl.textContent = '↑ 高遠／挑球　↓ 切球／放網　←→ 平抽';
      this.labelEl.classList.remove('over');
      this.labelEl.style.left = `${a.ox}px`;
      this.labelEl.style.top = `${a.oy - 86}px`;
    }
  }
}

function mk(parent: HTMLElement, cls: string): HTMLElement {
  const el = document.createElement('div');
  el.className = cls;
  parent.appendChild(el);
  return el;
}

/** 點擊滑放的手勢 → 球種：↑ 高遠球／挑球、↓ 切球／放網（上手或下手看擊球點高低）、左右 = 平抽 */
function tapShot(x: number, y: number): Flick {
  const nx = x / (Math.hypot(x, y) || 1);
  if (Math.abs(nx) >= 0.77) return { x, y, cmd: { family: 'side', depth: 5.0 } };
  return { x, y, cmd: { family: y > 0 ? 'up' : 'down', depth: 'auto' } };
}
