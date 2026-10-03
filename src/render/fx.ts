import * as THREE from 'three';
import type { ShuttleMode } from '../sim/match';
import type { Vec3 } from '../sim/physics';

/**
 * 擊球／殺球特效（全部程序產生、物件池，執行中不配置記憶體）。
 *
 * draw call（只在有東西時才畫）：
 * - 發光粒子（加法混色）1：閃光、星芒、震波圈、音爆圈、火花、閃電、火星、光柱
 * - 一般粒子（一般混色）1：一般擊球的圈、揚塵、碎屑
 * - 羽球能量拖尾 1、殘影 1（InstancedMesh）、球頭光暈 1
 * - 地面焦痕 1～2、全螢幕閃光／集中線 1（一個 clip-space 的四邊形，不是後製）
 *
 * 顏色都是 0..1 的 RGB 直接輸出（shader 不做色彩空間轉換），所以寫的十六進位色就是畫面上的顏色。
 */

type RGB = readonly [number, number, number];
const rgb = (hex: number): RGB => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

/** 殺球配色：core = 最熱的白芯、main = 主色、outer = 外圈、cool = 冷掉的餘燼 */
export interface FxTheme {
  core: RGB;
  main: RGB;
  outer: RGB;
  cool: RGB;
  flame: number; // 1 = 火焰（拖尾邊緣竄動、火星往上飄）、0 = 電光（閃電、爆閃）
}
/** 一般殺球：金色火焰 */
export const FIRE: FxTheme = { core: rgb(0xfff6dc), main: rgb(0xffb428), outer: rgb(0xff5a12), cool: rgb(0xb8240a), flame: 1 };
/** 跳殺：青色電光 */
export const ELECTRIC: FxTheme = { core: rgb(0xf0ffff), main: rgb(0x5ff2ff), outer: rgb(0x3f6dff), cool: rgb(0x3020c8), flame: 0 };
const CRIMSON = rgb(0xff2d5c); // 機會殺球多一圈的緋紅
const WHITE = rgb(0xffffff);
const DUST = rgb(0xd6cfc2);
const DEBRIS = rgb(0x3a332c);

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

// ======================================================================
// 粒子批次：每顆粒子一個四邊形，CPU 每幀算好四個角（面向鏡頭、沿速度拉長、或固定平面）
// ======================================================================

/** 方向模式 */
const BILL = 0; // 面向鏡頭
const PLANE = 1; // 固定平面（ax = 法線），例如地上的震波、音爆圈
const STREAK = 2; // 沿速度拉長（長度 = 速度 × str）
const SEG = 3; // 固定線段（p → p + ax），閃電、光柱
/** 形狀（fragment shader 依此分支） */
const GLOW = 0;
const RING = 1;
const LINE = 2;
const STAR = 3;
const PUFF = 4;
const BEAM = 5;
const CHIP = 6;
/** 旗標 */
const F_FADEIN = 1; // 前 1/6 淡入（揚塵）
const F_BOUNCE = 2; // 碰地彈跳（碎屑、火花）

const PARTICLE_VS = /* glsl */ `
attribute vec4 aCol;
attribute vec4 aShp;
varying vec2 vUv;
varying vec4 vCol;
varying vec3 vShp;
void main() {
  vUv = uv;
  vCol = aCol;
  vShp = aShp.xyz;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  // 深度偏移：沿視線往鏡頭拉近 aShp.w 公尺（螢幕位置不變），擊球點的閃光不會被自己的身體切掉
  mv.xyz *= max(0.05, 1.0 - aShp.w / max(length(mv.xyz), 1e-3));
  gl_Position = projectionMatrix * mv;
}`;

const PARTICLE_FS = /* glsl */ `
varying vec2 vUv;
varying vec4 vCol;
varying vec3 vShp;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float k = vShp.x;
  float a;
  float core = 0.0;
  if (k < 0.5) { // 柔光點
    float r2 = dot(p, p);
    a = exp(-r2 * 4.5) * (1.0 - smoothstep(0.75, 1.0, r2));
    core = exp(-r2 * 20.0);
  } else if (k < 1.5) { // 圓環（vShp.y = 相對厚度；hot > 0 時外加一圈光暈與淡淡的內部）
    float r = length(p);
    float w = vShp.y;
    float rc = 1.0 - w * 0.5 - 0.03;
    float dd = abs(r - rc);
    float band = 1.0 - smoothstep(w * 0.5 - 0.02, w * 0.5 + 0.03, dd);
    float halo = exp(-dd * 12.0) * 0.4 + (1.0 - smoothstep(0.0, rc, r)) * 0.07;
    a = max(band, halo * vShp.z);
    core = band * (1.0 - smoothstep(0.0, w * 0.5, dd));
  } else if (k < 2.5) { // 火花拖線：x = 橫向、y = 0 尾 → 1 頭
    float across = 1.0 - p.x * p.x;
    a = across * across * vUv.y * vUv.y * (1.0 - smoothstep(0.9, 1.0, vUv.y) * 0.5);
    core = exp(-p.x * p.x * 10.0) * vUv.y;
  } else if (k < 3.5) { // 四芒星
    float r2 = dot(p, p);
    float sx = exp(-abs(p.y) * 16.0) * (1.0 - abs(p.x));
    float sy = exp(-abs(p.x) * 16.0) * (1.0 - abs(p.y));
    a = max(sx, sy) + exp(-r2 * 7.0) * 0.7;
    core = exp(-r2 * 30.0);
  } else if (k < 4.5) { // 煙塵團（邊緣不規則）
    float r = length(p);
    float wob = 0.85 + 0.15 * sin(atan(p.y, p.x) * 5.0 + vShp.y * 6.283);
    a = 1.0 - smoothstep(0.2 * wob, wob, r);
  } else if (k < 5.5) { // 光束／閃電：沿線均勻、兩端收
    a = exp(-p.x * p.x * 5.0) * smoothstep(0.0, 0.06, vUv.y) * smoothstep(1.0, 0.94, vUv.y);
    core = exp(-p.x * p.x * 26.0);
  } else { // 碎屑：實心小點
    a = 1.0 - smoothstep(0.55, 1.0, length(p));
  }
  vec3 col = mix(vCol.rgb, vec3(1.0), clamp(core * vShp.z, 0.0, 1.0));
  gl_FragColor = vec4(col, vCol.a * clamp(a, 0.0, 1.0));
}`;

const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const _n = new THREE.Vector3();
const _d = new THREE.Vector3();
const _s = new THREE.Vector3();
const _e = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const XAXIS = new THREE.Vector3(1, 0, 0);

class Particles {
  readonly mesh: THREE.Mesh;
  n = 0;
  readonly p: Float32Array;
  readonly v: Float32Array;
  readonly ax: Float32Array;
  readonly c0: Float32Array;
  readonly c1: Float32Array;
  readonly age: Float32Array;
  readonly life: Float32Array;
  readonly s0: Float32Array;
  readonly s1: Float32Array;
  readonly a0: Float32Array;
  readonly fp: Float32Array; // 淡出指數：alpha = a0 × (1 - t)^fp
  readonly drag: Float32Array;
  readonly grav: Float32Array;
  readonly str: Float32Array;
  readonly prm: Float32Array;
  readonly hot: Float32Array;
  readonly rot: Float32Array;
  readonly bias: Float32Array;
  readonly ori: Uint8Array;
  readonly shp: Uint8Array;
  readonly flg: Uint8Array;
  private readonly v3s: Float32Array[];
  private readonly f1s: Float32Array[];
  private readonly u8s: Uint8Array[];
  private gPos: Float32Array;
  private gCol: Float32Array;
  private gShp: Float32Array;
  private aPos: THREE.BufferAttribute;
  private aCol: THREE.BufferAttribute;
  private aShp: THREE.BufferAttribute;

  constructor(
    private readonly cap: number,
    additive: boolean,
    order: number,
  ) {
    const N = cap + 1; // 最後一格 = 池滿時的垃圾格（寫進去也不會畫）
    const f3 = () => new Float32Array(N * 3);
    const f1 = () => new Float32Array(N);
    this.p = f3();
    this.v = f3();
    this.ax = f3();
    this.c0 = f3();
    this.c1 = f3();
    this.age = f1();
    this.life = f1();
    this.s0 = f1();
    this.s1 = f1();
    this.a0 = f1();
    this.fp = f1();
    this.drag = f1();
    this.grav = f1();
    this.str = f1();
    this.prm = f1();
    this.hot = f1();
    this.rot = f1();
    this.bias = f1();
    this.ori = new Uint8Array(N);
    this.shp = new Uint8Array(N);
    this.flg = new Uint8Array(N);
    this.v3s = [this.p, this.v, this.ax, this.c0, this.c1];
    this.f1s = [this.age, this.life, this.s0, this.s1, this.a0, this.fp, this.drag, this.grav, this.str, this.prm, this.hot, this.rot, this.bias];
    this.u8s = [this.ori, this.shp, this.flg];

    this.gPos = new Float32Array(cap * 4 * 3);
    this.gCol = new Float32Array(cap * 4 * 4);
    this.gShp = new Float32Array(cap * 4 * 4);
    const uv = new Float32Array(cap * 4 * 2);
    const idx = new Uint16Array(cap * 6);
    for (let i = 0; i < cap; i++) {
      uv.set([0, 0, 1, 0, 1, 1, 0, 1], i * 8);
      const b = i * 4;
      idx.set([b, b + 1, b + 2, b, b + 2, b + 3], i * 6);
    }
    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.gPos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.gCol, 4).setUsage(THREE.DynamicDrawUsage);
    this.aShp = new THREE.BufferAttribute(this.gShp, 4).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('aCol', this.aCol);
    geo.setAttribute('aShp', this.aShp);
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    geo.setDrawRange(0, 0);
    const mat = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VS,
      fragmentShader: PARTICLE_FS,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = order;
    this.mesh.visible = false;
  }

  /** 新增一顆；回傳索引，之後用 vel()/look() 等補設定（池滿時回傳垃圾格，照樣可以寫） */
  spawn(ori: number, shp: number, x: number, y: number, z: number, life: number, s0: number, s1: number, c0: RGB, c1: RGB, a0: number): number {
    const i = this.n < this.cap ? this.n++ : this.cap;
    const k = i * 3;
    this.p[k] = x;
    this.p[k + 1] = y;
    this.p[k + 2] = z;
    this.v[k] = this.v[k + 1] = this.v[k + 2] = 0;
    this.ax[k] = 0;
    this.ax[k + 1] = 1;
    this.ax[k + 2] = 0;
    this.c0[k] = c0[0];
    this.c0[k + 1] = c0[1];
    this.c0[k + 2] = c0[2];
    this.c1[k] = c1[0];
    this.c1[k + 1] = c1[1];
    this.c1[k + 2] = c1[2];
    this.age[i] = 0;
    this.life[i] = life;
    this.s0[i] = s0;
    this.s1[i] = s1;
    this.a0[i] = a0;
    this.fp[i] = 1;
    this.drag[i] = 0;
    this.grav[i] = 0;
    this.str[i] = 0;
    this.prm[i] = 0.3;
    this.hot[i] = 0;
    this.rot[i] = 0;
    this.bias[i] = 0;
    this.ori[i] = ori;
    this.shp[i] = shp;
    this.flg[i] = 0;
    return i;
  }

  vel(i: number, x: number, y: number, z: number, drag = 0, grav = 0): void {
    const k = i * 3;
    this.v[k] = x;
    this.v[k + 1] = y;
    this.v[k + 2] = z;
    this.drag[i] = drag;
    this.grav[i] = grav;
  }

  axis(i: number, x: number, y: number, z: number): void {
    const k = i * 3;
    this.ax[k] = x;
    this.ax[k + 1] = y;
    this.ax[k + 2] = z;
  }

  /** 外觀：prm = 形狀參數（圓環厚度等）、hot = 白芯強度、fp = 淡出指數、bias = 往鏡頭拉近幾公尺 */
  look(i: number, prm: number, hot: number, fp = 1, bias = 0): void {
    this.prm[i] = prm;
    this.hot[i] = hot;
    this.fp[i] = fp;
    this.bias[i] = bias;
  }

  /** 延遲 d 秒才出現 */
  delay(i: number, d: number): void {
    this.age[i] = -d;
  }

  clear(): void {
    this.n = 0;
    this.mesh.visible = false;
  }

  private kill(i: number): void {
    const j = --this.n;
    if (i === j) return;
    for (let a = 0; a < this.v3s.length; a++) {
      const arr = this.v3s[a];
      arr[i * 3] = arr[j * 3];
      arr[i * 3 + 1] = arr[j * 3 + 1];
      arr[i * 3 + 2] = arr[j * 3 + 2];
    }
    for (let a = 0; a < this.f1s.length; a++) this.f1s[a][i] = this.f1s[a][j];
    for (let a = 0; a < this.u8s.length; a++) this.u8s[a][i] = this.u8s[a][j];
  }

  update(dt: number): void {
    const p = this.p;
    const v = this.v;
    for (let i = 0; i < this.n; ) {
      const age = (this.age[i] += dt);
      if (age >= this.life[i]) {
        this.kill(i);
        continue;
      }
      if (age > 0) {
        const k = i * 3;
        const dr = this.drag[i];
        if (dr > 0) {
          const f = Math.exp(-dr * dt);
          v[k] *= f;
          v[k + 1] *= f;
          v[k + 2] *= f;
        }
        v[k + 1] += this.grav[i] * dt;
        p[k] += v[k] * dt;
        p[k + 1] += v[k + 1] * dt;
        p[k + 2] += v[k + 2] * dt;
        if (this.flg[i] & F_BOUNCE && p[k + 1] < 0.02) {
          p[k + 1] = 0.02;
          v[k + 1] = Math.abs(v[k + 1]) * 0.3;
          v[k] *= 0.55;
          v[k + 2] *= 0.55;
        }
      }
      i++;
    }
  }

  /** 把活著的粒子寫成四邊形 */
  build(cam: THREE.Camera): void {
    const m = cam.matrixWorld.elements;
    const rx = m[0], ry = m[1], rz = m[2]; // 鏡頭右
    const ux = m[4], uy = m[5], uz = m[6]; // 鏡頭上
    _e.set(m[12], m[13], m[14]);
    const P = this.gPos;
    const C = this.gCol;
    const S = this.gShp;
    let w = 0;
    for (let i = 0; i < this.n; i++) {
      const age = this.age[i];
      if (age < 0) continue;
      const t = age / this.life[i];
      const ease = 1 - (1 - t) * (1 - t);
      const size = this.s0[i] + (this.s1[i] - this.s0[i]) * ease;
      let alpha = this.a0[i] * Math.pow(1 - t, this.fp[i]);
      if (this.flg[i] & F_FADEIN) alpha *= Math.min(1, t * 6);
      if (alpha < 0.004 || size <= 0) continue;
      const k = i * 3;
      const px = this.p[k], py = this.p[k + 1], pz = this.p[k + 2];
      const o = this.ori[i];
      const q = w * 12;
      if (o === BILL || o === PLANE) {
        if (o === BILL) {
          _r.set(rx, ry, rz);
          _u.set(ux, uy, uz);
        } else {
          _n.set(this.ax[k], this.ax[k + 1], this.ax[k + 2]);
          _r.crossVectors(_n, Math.abs(_n.y) < 0.9 ? UP : XAXIS).normalize();
          _u.crossVectors(_r, _n);
        }
        const h = size * 0.5;
        const cr = Math.cos(this.rot[i]) * h;
        const sr = Math.sin(this.rot[i]) * h;
        // R = r·cos + u·sin、U = -r·sin + u·cos
        const Rx = _r.x * cr + _u.x * sr, Ry = _r.y * cr + _u.y * sr, Rz = _r.z * cr + _u.z * sr;
        const Ux = -_r.x * sr + _u.x * cr, Uy = -_r.y * sr + _u.y * cr, Uz = -_r.z * sr + _u.z * cr;
        P[q] = px - Rx - Ux;
        P[q + 1] = py - Ry - Uy;
        P[q + 2] = pz - Rz - Uz;
        P[q + 3] = px + Rx - Ux;
        P[q + 4] = py + Ry - Uy;
        P[q + 5] = pz + Rz - Uz;
        P[q + 6] = px + Rx + Ux;
        P[q + 7] = py + Ry + Uy;
        P[q + 8] = pz + Rz + Uz;
        P[q + 9] = px - Rx + Ux;
        P[q + 10] = py - Ry + Uy;
        P[q + 11] = pz - Rz + Uz;
      } else {
        // 線段：尾 _a → 頭 _b
        if (o === SEG) {
          _a.set(px, py, pz);
          _b.set(px + this.ax[k], py + this.ax[k + 1], pz + this.ax[k + 2]);
        } else {
          _d.set(this.v[k], this.v[k + 1], this.v[k + 2]);
          const sp = _d.length();
          if (sp > 1e-4) _d.divideScalar(sp);
          else _d.set(this.ax[k], this.ax[k + 1], this.ax[k + 2]);
          const len = sp * this.str[i] + size;
          _b.set(px, py, pz);
          _a.copy(_b).addScaledVector(_d, -len);
        }
        _d.subVectors(_b, _a);
        _s.set((_a.x + _b.x) * 0.5 - _e.x, (_a.y + _b.y) * 0.5 - _e.y, (_a.z + _b.z) * 0.5 - _e.z);
        _s.cross(_d);
        const sl = _s.length();
        if (sl < 1e-8) continue;
        _s.multiplyScalar((size * 0.5) / sl);
        P[q] = _a.x - _s.x;
        P[q + 1] = _a.y - _s.y;
        P[q + 2] = _a.z - _s.z;
        P[q + 3] = _a.x + _s.x;
        P[q + 4] = _a.y + _s.y;
        P[q + 5] = _a.z + _s.z;
        P[q + 6] = _b.x + _s.x;
        P[q + 7] = _b.y + _s.y;
        P[q + 8] = _b.z + _s.z;
        P[q + 9] = _b.x - _s.x;
        P[q + 10] = _b.y - _s.y;
        P[q + 11] = _b.z - _s.z;
      }
      const cr = this.c0[k] + (this.c1[k] - this.c0[k]) * t;
      const cg = this.c0[k + 1] + (this.c1[k + 1] - this.c0[k + 1]) * t;
      const cb = this.c0[k + 2] + (this.c1[k + 2] - this.c0[k + 2]) * t;
      const sh = this.shp[i], prm = this.prm[i], hot = this.hot[i], bias = this.bias[i];
      for (let c = 0; c < 4; c++) {
        const j = (w * 4 + c) * 4;
        C[j] = cr;
        C[j + 1] = cg;
        C[j + 2] = cb;
        C[j + 3] = alpha;
        S[j] = sh;
        S[j + 1] = prm;
        S[j + 2] = hot;
        S[j + 3] = bias;
      }
      w++;
    }
    this.mesh.visible = w > 0;
    if (!w) return;
    this.mesh.geometry.setDrawRange(0, w * 6);
    upload(this.aPos, w * 12);
    upload(this.aCol, w * 16);
    upload(this.aShp, w * 16);
  }
}

/** 只上傳用到的那一段 buffer */
function upload(attr: THREE.BufferAttribute, count: number): void {
  attr.clearUpdateRanges();
  attr.addUpdateRange(0, count);
  attr.needsUpdate = true;
}

// ======================================================================
// 羽球能量拖尾：沿最近的飛行路徑畫一條面向鏡頭、頭寬尾尖的緞帶（白芯 → 主色 → 外圈）
// ======================================================================

const HIST = 48; // 路徑歷史點
const RIB = 26; // 緞帶重新取樣的點數（頭 → 尾，等距）

const RIBBON_VS = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  mv.xyz *= max(0.05, 1.0 - 0.4 / max(length(mv.xyz), 1e-3));
  gl_Position = projectionMatrix * mv;
}`;

const RIBBON_FS = /* glsl */ `
uniform vec3 uCore;
uniform vec3 uMain;
uniform vec3 uOuter;
uniform float uTime;
uniform float uAlpha;
uniform float uFlame;
uniform float uLen;
varying vec2 vUv;
float hash(vec2 q) { return fract(sin(dot(q, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 x) {
  vec2 i = floor(x);
  vec2 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
void main() {
  float s = vUv.x;                    // 0 = 球頭、1 = 尾巴
  float c = abs(vUv.y * 2.0 - 1.0);   // 0 = 中線、1 = 邊
  float arc = s * uLen;
  // 火焰：邊緣隨時間往後竄；電光：一節一節閃爍
  float n = noise(vec2(arc * 2.6 - uTime * 16.0, vUv.y * 2.5 + uTime * 3.0));
  float lim = mix(1.0, 0.45 + 0.7 * n, uFlame * smoothstep(0.0, 0.25, s));
  float body = 1.0 - smoothstep(lim * 0.55, lim, c);
  float zap = mix(0.7 + 0.6 * step(0.45, hash(vec2(floor(arc * 5.0), floor(uTime * 28.0)))), 1.0, uFlame);
  float coreW = exp(-c * c * 16.0) * (1.0 - s * 0.85);
  vec3 col = mix(uOuter, uMain, smoothstep(0.1, 0.75, (1.0 - c) * (1.0 - s * 0.7)));
  col = mix(col, uCore, clamp(coreW * 1.3, 0.0, 1.0));
  float a = body * pow(1.0 - s, 0.9) * uAlpha * zap;
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
}`;

class Ribbon {
  readonly mesh: THREE.Mesh;
  /** 重新取樣後的路徑（頭 → 尾，世界座標）；殘影也用 */
  readonly samples = new Float32Array(RIB * 3);
  count = 0;
  length = 0; // 實際取樣的長度（公尺）
  private hist = new Float32Array(HIST * 3);
  private hn = 0;
  private head = new THREE.Vector3();
  private pos = new Float32Array(RIB * 2 * 3);
  private uvs = new Float32Array(RIB * 2 * 2);
  private aPos: THREE.BufferAttribute;
  private aUv: THREE.BufferAttribute;
  readonly uniforms = {
    uCore: { value: new THREE.Vector3() },
    uMain: { value: new THREE.Vector3() },
    uOuter: { value: new THREE.Vector3() },
    uTime: { value: 0 },
    uAlpha: { value: 1 },
    uFlame: { value: 1 },
    uLen: { value: 1 },
  };

  constructor() {
    const idx: number[] = [];
    for (let j = 0; j < RIB - 1; j++) {
      const a = j * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const geo = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aUv = new THREE.BufferAttribute(this.uvs, 2).setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.aPos);
    geo.setAttribute('uv', this.aUv);
    geo.setIndex(idx);
    const mat = new THREE.ShaderMaterial({
      vertexShader: RIBBON_VS,
      fragmentShader: RIBBON_FS,
      uniforms: this.uniforms,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 5;
    this.mesh.visible = false;
  }

  setTheme(th: FxTheme, outer: RGB): void {
    this.uniforms.uCore.value.set(th.core[0], th.core[1], th.core[2]);
    this.uniforms.uMain.value.set(th.main[0], th.main[1], th.main[2]);
    this.uniforms.uOuter.value.set(outer[0], outer[1], outer[2]);
    this.uniforms.uFlame.value = th.flame;
  }

  reset(p: Vec3): void {
    this.hist[0] = p.x;
    this.hist[1] = p.y;
    this.hist[2] = p.z;
    this.hn = 1;
    this.head.set(p.x, p.y, p.z);
    this.count = 0;
  }

  /** 記錄球頭位置（離上一個歷史點夠遠才存一點，跟幀率無關） */
  push(p: Vec3): void {
    this.head.set(p.x, p.y, p.z);
    const h = this.hist;
    const d = Math.hypot(p.x - h[0], p.y - h[1], p.z - h[2]);
    if (d < 0.1) return;
    h.copyWithin(3, 0, (HIST - 1) * 3);
    h[0] = p.x;
    h[1] = p.y;
    h[2] = p.z;
    this.hn = Math.min(HIST, this.hn + 1);
  }

  /** 第 i 個路徑點：0 = 現在的球頭，之後是歷史 */
  private pt(i: number, out: THREE.Vector3): THREE.Vector3 {
    if (i === 0) return out.copy(this.head);
    const k = (i - 1) * 3;
    return out.set(this.hist[k], this.hist[k + 1], this.hist[k + 2]);
  }

  /** 從球頭往回取 len 公尺，等距取樣成 RIB 點 */
  private resample(len: number): void {
    const np = this.hn + 1;
    let total = 0;
    for (let i = 1; i < np; i++) total += this.pt(i - 1, _a).distanceTo(this.pt(i, _b));
    const L = Math.min(len, total);
    this.length = L;
    if (L < 0.05) {
      this.count = 0;
      return;
    }
    let seg = 1;
    let segStart = 0;
    this.pt(0, _a);
    this.pt(1, _b);
    let segLen = _a.distanceTo(_b);
    for (let j = 0; j < RIB; j++) {
      const target = (L * j) / (RIB - 1);
      while (segStart + segLen < target && seg < np - 1) {
        segStart += segLen;
        seg++;
        _a.copy(_b);
        this.pt(seg, _b);
        segLen = _a.distanceTo(_b);
      }
      const f = segLen > 1e-6 ? Math.min(1, (target - segStart) / segLen) : 0;
      const k = j * 3;
      this.samples[k] = _a.x + (_b.x - _a.x) * f;
      this.samples[k + 1] = _a.y + (_b.y - _a.y) * f;
      this.samples[k + 2] = _a.z + (_b.z - _a.z) * f;
    }
    this.count = RIB;
  }

  build(len: number, width: number, alpha: number, time: number, cam: THREE.Camera): void {
    this.resample(len);
    if (this.count < 2 || alpha <= 0.01) {
      this.mesh.visible = false;
      return;
    }
    const m = cam.matrixWorld.elements;
    _e.set(m[12], m[13], m[14]);
    const S = this.samples;
    for (let j = 0; j < RIB; j++) {
      const k = j * 3;
      const k0 = Math.max(0, j - 1) * 3;
      const k1 = Math.min(RIB - 1, j + 1) * 3;
      _d.set(S[k0] - S[k1], S[k0 + 1] - S[k1 + 1], S[k0 + 2] - S[k1 + 2]); // 往球頭的切線
      _s.set(S[k] - _e.x, S[k + 1] - _e.y, S[k + 2] - _e.z);
      const far = Math.min(1.8, Math.max(0.9, _s.length() / 13)); // 遠近補償（同 FxSystem.farScale）
      _s.cross(_d);
      const sl = _s.length();
      const u = j / (RIB - 1);
      // 寬度：球頭圓一點、最寬在前段、尾巴收尖（殺球多半朝鏡頭或背向鏡頭飛，長度被透視壓短，寬度要夠）
      const prof = Math.pow(1 - u, 0.55) * (0.65 + 0.35 * Math.min(1, u / 0.08));
      const hw = sl > 1e-8 ? (width * 0.5 * prof * far) / sl : 0;
      const q = j * 6;
      this.pos[q] = S[k] + _s.x * hw;
      this.pos[q + 1] = S[k + 1] + _s.y * hw;
      this.pos[q + 2] = S[k + 2] + _s.z * hw;
      this.pos[q + 3] = S[k] - _s.x * hw;
      this.pos[q + 4] = S[k + 1] - _s.y * hw;
      this.pos[q + 5] = S[k + 2] - _s.z * hw;
      const r = j * 4;
      this.uvs[r] = u;
      this.uvs[r + 1] = 1;
      this.uvs[r + 2] = u;
      this.uvs[r + 3] = 0;
    }
    this.aPos.needsUpdate = true;
    this.aUv.needsUpdate = true;
    this.uniforms.uAlpha.value = alpha;
    this.uniforms.uTime.value = time;
    this.uniforms.uLen.value = this.length;
    this.mesh.visible = true;
  }

  /** 路徑上離球頭 d 公尺的點與往前方向；超出取樣長度回傳 false */
  at(d: number, out: THREE.Vector3, dir: THREE.Vector3): boolean {
    if (this.count < 2 || d > this.length) return false;
    const f = (d / this.length) * (RIB - 1);
    const j = Math.min(RIB - 2, Math.floor(f));
    const t = f - j;
    const S = this.samples;
    const k = j * 3;
    out.set(S[k] + (S[k + 3] - S[k]) * t, S[k + 1] + (S[k + 4] - S[k + 1]) * t, S[k + 2] + (S[k + 5] - S[k + 2]) * t);
    dir.set(S[k] - S[k + 3], S[k + 1] - S[k + 4], S[k + 2] - S[k + 5]);
    if (dir.lengthSq() < 1e-10) return false;
    dir.normalize();
    return true;
  }
}

// ======================================================================
// 全螢幕：邊緣閃光（暈影）＋集中線。一個直接畫在 clip space 的四邊形，只在有效果時才畫
// ======================================================================

const SCREEN_VS = /* glsl */ `
varying vec2 vNdc;
void main() {
  vNdc = position.xy;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}`;

const SCREEN_FS = /* glsl */ `
uniform float uFlash;
uniform float uVig;
uniform float uLines;
uniform float uLineR;
uniform vec3 uColor;
uniform vec2 uCenter;
uniform float uAspect;
uniform float uSeed;
varying vec2 vNdc;
float hash(float n) { return fract(sin(n * 12.9898 + uSeed) * 43758.5453); }
void main() {
  // 邊緣暈影：中間保持乾淨，四周一圈主色光
  vec2 q = vNdc;
  float vig = smoothstep(0.55, 1.35, length(q * vec2(1.0, 0.92)));
  vec3 col = uColor * (vig * uVig + uFlash * 0.28) + vec3(uFlash * 0.1);
  // 集中線：以擊球點為中心的放射楔形，越外面越粗；內緣半徑隨時間往內衝
  if (uLines > 0.001) {
    vec2 d = vNdc - uCenter;
    d *= uAspect > 1.0 ? vec2(uAspect, 1.0) : vec2(1.0, 1.0 / uAspect); // 以短邊為 1（直向、橫向都是四周都有線）
    float ang = atan(d.y, d.x) / 6.28318 + 0.5;
    float N = 140.0;
    float cell = floor(ang * N);
    float f = fract(ang * N);
    float h = hash(cell);
    float h2 = hash(cell + 71.0);
    float on = step(0.56, h);
    float width = 0.1 + 0.26 * h2;
    float line = on * (1.0 - smoothstep(width * 0.4, width, abs(f - 0.5)));
    // 只畫在螢幕外圈（用 NDC 的橢圓距離：直向、橫向都一樣只佔邊緣一圈，球場中間保持乾淨）
    float r0 = uLineR * (0.85 + 0.3 * h2);
    line *= smoothstep(r0, r0 + 0.3, length(vNdc));
    col += mix(vec3(1.0), uColor, 0.35) * line * uLines;
  }
  gl_FragColor = vec4(col, 1.0);
}`;

class ScreenFx {
  readonly mesh: THREE.Mesh;
  private u = {
    uFlash: { value: 0 },
    uVig: { value: 0 },
    uLines: { value: 0 },
    uLineR: { value: 1 },
    uColor: { value: new THREE.Vector3(1, 1, 1) },
    uCenter: { value: new THREE.Vector2() },
    uAspect: { value: 1 },
    uSeed: { value: 0 },
  };
  private flash = 0;
  private vig = 0;
  private vigPeak = 0;
  private lines = 0;
  private linesT = 1;
  private linesDur = 0.24;
  private reroll = 0;

  constructor() {
    const mat = new THREE.ShaderMaterial({
      vertexShader: SCREEN_VS,
      fragmentShader: SCREEN_FS,
      uniforms: this.u,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 999;
    this.mesh.visible = false;
  }

  /** 閃一下：flash = 全畫面一瞬間的亮度、vig = 邊緣暈影 */
  hit(color: RGB, flash: number, vig: number): void {
    this.u.uColor.value.set(color[0], color[1], color[2]);
    this.flash = Math.max(this.flash, flash);
    this.vig = Math.max(this.vig, vig);
    this.vigPeak = this.vig;
  }

  /** 集中線（ndc 中心）；strength 0..1、dur 秒 */
  speedLines(cx: number, cy: number, strength: number, dur: number): void {
    this.u.uCenter.value.set(cx, cy);
    this.lines = strength;
    this.linesT = 0;
    this.linesDur = dur;
    this.u.uSeed.value = Math.random() * 100;
  }

  clear(): void {
    this.flash = this.vig = this.lines = 0;
    this.linesT = 1;
    this.mesh.visible = false;
  }

  update(dt: number, aspect: number): void {
    this.flash = Math.max(0, this.flash - dt / 0.07);
    this.vig = Math.max(0, this.vig - (dt * Math.max(this.vigPeak, 0.01)) / 0.3);
    this.linesT += dt;
    const lt = this.linesT / this.linesDur;
    const lines = lt < 1 ? this.lines * (lt < 0.15 ? lt / 0.15 : 1 - (lt - 0.15) / 0.85) : 0;
    // 線一直重抽（閃爍感），內緣半徑從畫面外往內衝
    this.reroll += dt;
    if (this.reroll > 0.035) {
      this.reroll = 0;
      this.u.uSeed.value = Math.random() * 100;
    }
    this.u.uFlash.value = this.flash;
    this.u.uVig.value = this.vig;
    this.u.uLines.value = lines;
    this.u.uLineR.value = 1.15 - 0.35 * Math.min(1, lt / 0.4);
    this.u.uAspect.value = aspect;
    this.mesh.visible = this.flash > 0.002 || this.vig > 0.002 || lines > 0.002;
  }
}

// ======================================================================
// 地面焦痕：裂痕貼圖（canvas 產生一次）＋焦黑，裂縫先發光再冷掉
// ======================================================================

const SCORCH_VS = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const SCORCH_FS = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uGlowCol;
uniform float uScorch;
uniform float uGlow;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  float crack = texture2D(uMap, vUv).a;
  float ang = atan(p.y, p.x);
  float soot = (1.0 - smoothstep(0.15, 1.0, r)) * (0.8 + 0.2 * sin(ang * 7.0) * sin(ang * 3.0 + 1.7));
  float glow = crack * uGlow * (1.0 - smoothstep(0.2, 1.0, r));
  vec3 col = mix(vec3(0.07, 0.055, 0.045), uGlowCol, clamp(glow * 1.6, 0.0, 1.0));
  col = mix(col, vec3(1.0), clamp(glow * 1.4 - 0.8, 0.0, 1.0));
  float a = max(soot * 0.42, crack * 0.8) * uScorch;
  a = max(a, glow);
  gl_FragColor = vec4(col, clamp(a, 0.0, 1.0));
}`;

function crackTexture(): THREE.Texture {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d')!;
  const c = S / 2;
  const grad = g.createRadialGradient(c, c, 0, c, c, 26);
  grad.addColorStop(0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  g.strokeStyle = '#fff';
  g.lineCap = 'round';
  const crack = (x: number, y: number, a: number, reach: number, w0: number, depth: number) => {
    let r = 0;
    while (r < reach) {
      const step = rnd(7, 14);
      a += rnd(-0.38, 0.38);
      const nx = x + Math.cos(a) * step;
      const ny = y + Math.sin(a) * step;
      g.lineWidth = Math.max(0.7, w0 * (1 - r / reach));
      g.beginPath();
      g.moveTo(x, y);
      g.lineTo(nx, ny);
      g.stroke();
      x = nx;
      y = ny;
      r += step;
      if (depth > 0 && Math.random() < 0.16) crack(x, y, a + rnd(0.5, 1.0) * (Math.random() < 0.5 ? -1 : 1), (reach - r) * 0.6, w0 * 0.55, depth - 1);
    }
  };
  const N = 9;
  for (let i = 0; i < N; i++) crack(c, c, (i / N) * Math.PI * 2 + rnd(-0.25, 0.25), rnd(72, 120), 4.5, 2);
  // 幾段同心的環狀裂紋
  for (let i = 0; i < 5; i++) {
    const rr = rnd(34, 70);
    const a0 = rnd(0, Math.PI * 2);
    g.lineWidth = rnd(1, 2);
    g.beginPath();
    g.arc(c, c, rr, a0, a0 + rnd(0.4, 1.1));
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  return tex;
}

class Scorch {
  private items: { mesh: THREE.Mesh; mat: THREE.ShaderMaterial; t: number; life: number }[] = [];
  private next = 0;

  constructor(parent: THREE.Object3D) {
    const tex = crackTexture();
    const geo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    for (let i = 0; i < 2; i++) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: SCORCH_VS,
        fragmentShader: SCORCH_FS,
        uniforms: {
          uMap: { value: tex },
          uGlowCol: { value: new THREE.Vector3(1, 0.7, 0.2) },
          uScorch: { value: 0 },
          uGlow: { value: 0 },
        },
        transparent: true,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -4,
        polygonOffsetUnits: -4,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 1;
      mesh.visible = false;
      parent.add(mesh);
      this.items.push({ mesh, mat, t: 0, life: 0 });
    }
  }

  spawn(x: number, z: number, size: number, glow: RGB, life: number): void {
    const it = this.items[this.next];
    this.next = (this.next + 1) % this.items.length;
    it.mesh.position.set(x, 0.012, z);
    it.mesh.rotation.y = Math.random() * Math.PI * 2;
    it.mesh.scale.set(size, 1, size);
    (it.mat.uniforms.uGlowCol.value as THREE.Vector3).set(glow[0], glow[1], glow[2]);
    it.t = 0;
    it.life = life;
    it.mesh.visible = true;
  }

  clear(): void {
    for (const it of this.items) it.mesh.visible = false;
  }

  update(dt: number): void {
    for (const it of this.items) {
      if (!it.mesh.visible) continue;
      it.t += dt;
      const t = it.t / it.life;
      if (t >= 1) {
        it.mesh.visible = false;
        continue;
      }
      // 裂縫 0.5 秒內從白熱冷掉；焦痕撐到 40% 再淡出
      it.mat.uniforms.uGlow.value = Math.max(0, 1 - it.t / 0.5) ** 1.5;
      it.mat.uniforms.uScorch.value = Math.min(1, it.t / 0.04) * (t < 0.4 ? 1 : 1 - (t - 0.4) / 0.6);
    }
  }
}

// ======================================================================
// 總管：事件 → 特效
// ======================================================================

export interface SmashHit {
  pos: Vec3;
  vel: Vec3;
  kmh: number;
  perfect: boolean;
  electric: boolean; // 跳殺：青色電光；否則金色火焰
  chance: boolean; // 機會殺球：再加一級
  near: boolean; // 擊球的人在畫面下方（自己這側）
  live: boolean; // false = 主選單背景示範：不閃螢幕、震動減半
}

export interface FxHooks {
  shake(amp: number, dur: number): void;
  punch(deg: number): void;
}

/** 殺球強度 0..~1.3：球速 110 → 0、220 km/h → 1；完美、機會殺球再加 */
export function smashPower(kmh: number, perfect: boolean, chance: boolean): number {
  return clamp01((kmh - 110) / 110) + (perfect ? 0.15 : 0) + (chance ? 0.2 : 0);
}

const _p = new THREE.Vector3();
const _q = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _m4 = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _scl = new THREE.Vector3();
const _col = new THREE.Color();
const GHOSTS = 4;

export class FxSystem {
  readonly group = new THREE.Group();
  private glow = new Particles(640, true, 4);
  private soft = new Particles(192, false, 3);
  private ribbon = new Ribbon();
  private ghosts: THREE.InstancedMesh;
  private headGlow: THREE.Sprite;
  private screen = new ScreenFx();
  private scorch: Scorch;
  private time = 0;
  // 飛行中的殺球
  private fl = {
    on: false, // 球還在飛
    vis: 0, // 拖尾可見度（落地後快速收掉）
    theme: FIRE,
    outer: FIRE.outer as RGB,
    k: 0,
    P: 1,
    chance: false,
    near: true,
    live: true,
    hitter: 0, // 擊球方在哪一側（z 的正負號）
    last: new THREE.Vector3(),
    dir: new THREE.Vector3(0, 0, -1),
    emit: 0,
    zap: 0,
  };

  private eye = new THREE.Vector3();

  constructor(
    shuttleGeo: THREE.BufferGeometry,
    private readonly cam: THREE.PerspectiveCamera,
    private readonly hooks: FxHooks,
  ) {
    this.scorch = new Scorch(this.group);
    const gm = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    this.ghosts = new THREE.InstancedMesh(shuttleGeo, gm, GHOSTS);
    this.ghosts.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < GHOSTS; i++) this.ghosts.setColorAt(i, _col.setRGB(0, 0, 0));
    this.ghosts.frustumCulled = false;
    this.ghosts.renderOrder = 5;
    this.ghosts.visible = false;

    const cv = document.createElement('canvas');
    cv.width = cv.height = 64;
    const g = cv.getContext('2d')!;
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.25, 'rgba(255,255,255,0.55)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
    this.headGlow = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    this.headGlow.renderOrder = 6;
    this.headGlow.visible = false;

    this.group.add(this.soft.mesh, this.glow.mesh, this.ribbon.mesh, this.ghosts, this.headGlow, this.screen.mesh);
  }

  /**
   * 遠近補償：離鏡頭越遠放越大（世界尺寸 × 這個倍率），對面場地的爆炸在螢幕上才不會只剩一小點。
   * 以約 13 m（近側場地）為 1，範圍 0.9～1.8。
   */
  private farScale(x: number, y: number, z: number): number {
    this.eye.setFromMatrixPosition(this.cam.matrixWorld);
    const d = Math.hypot(x - this.eye.x, y - this.eye.y, z - this.eye.z);
    return Math.min(1.8, Math.max(0.9, d / 13));
  }

  /** 殺球正在飛（拖尾在畫）：原本的白色細拖尾先藏起來 */
  get smashing(): boolean {
    return this.fl.vis > 0;
  }

  /** 換場、重開：全部清掉 */
  clear(): void {
    this.glow.clear();
    this.soft.clear();
    this.screen.clear();
    this.scorch.clear();
    this.endFlight(true);
  }

  // ---------------- 一般擊球（跟原本的圈一樣，改用物件池） ----------------

  /** 一般擊球的圈：size 跟原本 RingGeometry(0.05·size, 0.09·size) 放大到 ×5.2 一樣 */
  ring(p: Vec3, color: number, size: number, flat: boolean, delay = 0): void {
    const c = rgb(color);
    const i = this.soft.spawn(flat ? PLANE : BILL, RING, p.x, p.y, p.z, 0.26, 0.18 * size, 0.94 * size, c, c, 0.9);
    this.soft.look(i, 0.44, 0, 1, flat ? 0 : 0.3);
    if (delay) this.soft.delay(i, delay);
  }

  /** 完美擊球（非殺球）：幾顆小金色火花，低調 */
  sparkle(p: Vec3, color: number): void {
    const c = rgb(color);
    for (let n = 0; n < 7; n++) {
      randDir(_d);
      const sp = rnd(3, 6);
      const i = this.glow.spawn(STREAK, LINE, p.x, p.y, p.z, rnd(0.12, 0.2), 0.03, 0.015, WHITE, c, 0.85);
      this.glow.vel(i, _d.x * sp, _d.y * sp, _d.z * sp, 5, -4);
      this.glow.str[i] = 0.035;
      this.glow.look(i, 0, 0.6, 1.2, 0.5);
    }
  }

  // ---------------- 殺球 ----------------

  smash(h: SmashHit): void {
    const th = h.electric ? ELECTRIC : FIRE;
    const k = smashPower(h.kmh, h.perfect, h.chance);
    const P = 0.5 + 0.55 * k; // 尺寸倍率
    const { x, y, z } = h.pos;
    const S = P * Math.pow(this.farScale(x, y, z), 0.8); // 對手那側的看起來小，放大一點（但不放到跟自己的一樣大）
    _dir.set(h.vel.x, h.vel.y, h.vel.z);
    if (_dir.lengthSq() < 1e-6) _dir.set(0, -0.3, h.near ? -1 : 1);
    _dir.normalize();
    const D = _dir;
    const G = this.glow;
    // 視線方向：往四周噴的火花取「垂直視線」的方向，在螢幕上才拉得長（沿視線噴的會被透視壓扁）
    this.eye.setFromMatrixPosition(this.cam.matrixWorld);
    _n.set(x - this.eye.x, y - this.eye.y, z - this.eye.z).normalize();
    const V = _n;

    // 1. 擊球點的閃光：柔光＋四芒星（完美多一顆斜的）
    let i = G.spawn(BILL, GLOW, x, y, z, 0.16, 0.9 * S, 2.6 * S, th.core, th.main, 1);
    G.look(i, 0, 1, 2, 1.2);
    i = G.spawn(BILL, STAR, x, y, z, 0.13 + 0.05 * k, 1.8 * S, 3.8 * S, th.core, th.main, 0.95);
    G.look(i, 0, 1, 1.6, 1.2);
    G.rot[i] = rnd(-0.3, 0.3);
    if (h.perfect || h.chance) {
      i = G.spawn(BILL, STAR, x, y, z, 0.11, 1.2 * S, 2.6 * S, WHITE, th.main, 0.8);
      G.look(i, 0, 1, 1.6, 1.2);
      G.rot[i] = Math.PI / 4 + rnd(-0.2, 0.2);
    }

    // 2. 震波圈（面向鏡頭）：主圈＋細的第二圈；機會殺球再一圈緋紅
    i = G.spawn(BILL, RING, x, y, z, 0.32, 0.3 * S, 3.6 * S, th.main, th.outer, 0.95);
    G.look(i, 0.08, 0.7, 1.2, 1);
    i = G.spawn(BILL, RING, x, y, z, 0.28, 0.2 * S, 2.6 * S, th.core, th.main, 0.7);
    G.look(i, 0.05, 1, 1.2, 1);
    G.delay(i, 0.05);
    if (h.chance) {
      i = G.spawn(BILL, RING, x, y, z, 0.38, 0.4 * S, 4.8 * S, CRIMSON, CRIMSON, 0.85);
      G.look(i, 0.07, 0.5, 1.3, 1);
      G.delay(i, 0.09);
    }

    // 3. 音爆圈：沿出球方向一串垂直於球路的圓圈，像球把空氣打穿
    const booms = 2 + Math.round(2 * Math.min(1, k));
    for (let b = 0; b < booms; b++) {
      const d = (0.3 + b * 0.55) * S;
      i = G.spawn(PLANE, RING, x + D.x * d, y + D.y * d, z + D.z * d, 0.2, 0.2 * S, (0.75 + b * 0.28) * S, th.core, th.main, 0.85 - b * 0.12);
      G.axis(i, D.x, D.y, D.z);
      G.look(i, 0.16, 0.8, 1.3, 1);
      G.delay(i, b * 0.025);
    }

    // 4. 火花：一半沿出球方向噴出，其餘往四周（貼著螢幕平面）炸開
    const nFwd = Math.round(12 + 18 * Math.min(1.2, k));
    for (let n = 0; n < nFwd; n++) {
      randDir(_d);
      _d.multiplyScalar(0.55).add(D).normalize();
      const sp = rnd(9, 26) * (0.6 + 0.4 * P);
      i = G.spawn(STREAK, LINE, x, y, z, rnd(0.18, 0.36), rnd(0.07, 0.11) * S, 0.03, th.core, th.outer, 1);
      G.vel(i, _d.x * sp, _d.y * sp, _d.z * sp, 3.5, -6);
      G.str[i] = 0.035;
      G.look(i, 0, 0.8, 1, 0.8);
      G.flg[i] = F_BOUNCE;
    }
    const nRad = Math.round(12 + 14 * Math.min(1.2, k));
    for (let n = 0; n < nRad; n++) {
      randDir(_d);
      _d.addScaledVector(V, -_d.dot(V) * 0.85).normalize();
      const sp = rnd(6, 15) * S;
      i = G.spawn(STREAK, LINE, x, y, z, rnd(0.14, 0.28), rnd(0.06, 0.09) * S, 0.02, th.core, n % 3 ? th.main : th.outer, 0.95);
      G.vel(i, _d.x * sp, _d.y * sp, _d.z * sp, 5, -4);
      G.str[i] = 0.035;
      G.look(i, 0, 0.8, 1, 0.8);
    }

    // 5. 主題：火焰 = 往前衝的火團＋火星；電光 = 放射狀閃電（再閃一次）
    if (th.flame) {
      const nPuff = Math.round(5 + 6 * k);
      for (let n = 0; n < nPuff; n++) {
        randDir(_d);
        _d.multiplyScalar(0.6).add(D).normalize();
        const sp = rnd(2.5, 8);
        i = G.spawn(BILL, GLOW, x, y, z, rnd(0.2, 0.36), rnd(0.25, 0.4) * S, rnd(0.6, 0.95) * S, th.main, th.cool, 0.75);
        G.vel(i, _d.x * sp, _d.y * sp, _d.z * sp, 6, 1.5);
        G.look(i, 0, 0.6, 1.4, 0.8);
      }
    } else {
      const nBolt = Math.round(6 + 4 * k);
      for (let n = 0; n < nBolt; n++) {
        randDir(_d);
        _d.addScaledVector(V, -_d.dot(V) * 0.8).normalize().addScaledVector(D, 0.3).normalize();
        const L = rnd(1.1, 2.1) * S;
        this.bolt(x, y, z, x + _d.x * L, y + _d.y * L, z + _d.z * L, 5, 0.24 * S, 0.075 * S, rnd(0.08, 0.12), n < nBolt / 2 ? 0 : 0.055, th);
      }
    }

    // 6. 鏡頭與螢幕：震動、視角衝擊、邊緣閃光、集中線（對手的殺球小很多）
    const who = h.near ? 1 : 0.4;
    const live = h.live ? 1 : 0.5;
    const elec = h.electric ? 1.2 : 1;
    this.hooks.shake((0.07 + 0.13 * Math.min(1.2, k)) * elec * (h.chance ? 1.2 : 1) * who * live, 0.24 + 0.06 * Math.min(1, k));
    this.hooks.punch((1.5 + 2.3 * Math.min(1.2, k)) * elec * (h.near ? 1 : 0.5));
    if (h.live) {
      this.screen.hit(h.chance ? CRIMSON : th.main, (0.35 + 0.5 * Math.min(1, k)) * who, (0.22 + 0.32 * Math.min(1.2, k)) * (h.near ? 1 : 0.55));
      if (k > 0.3 || h.electric || h.chance) {
        _p.set(x, y, z).project(this.cam);
        this.screen.speedLines(_p.x * 0.6, _p.y * 0.6 + 0.08, Math.min(1, 0.35 + 0.5 * k) * (h.near ? 0.85 : 0.35), 0.2 + 0.08 * Math.min(1, k) + (h.chance ? 0.08 : 0));
      }
    }

    // 7. 開始飛行拖尾
    const f = this.fl;
    f.on = true;
    f.vis = 1;
    f.theme = th;
    f.outer = h.chance ? CRIMSON : th.outer;
    f.k = k;
    f.P = P;
    f.chance = h.chance;
    f.near = h.near;
    f.live = h.live;
    f.hitter = Math.sign(z) || 1;
    f.last.set(x, y, z);
    f.dir.copy(D);
    f.emit = 0;
    f.zap = 0;
    this.ribbon.setTheme(th, f.outer);
    this.ribbon.reset(h.pos);
    this.headGlow.material.color.setRGB(th.main[0], th.main[1], th.main[2], THREE.SRGBColorSpace);
  }

  /** 不是殺球的擊球、掛網、重發球：拖尾收掉 */
  endFlight(now = false): void {
    this.fl.on = false;
    if (now) {
      this.fl.vis = 0;
      this.ribbon.mesh.visible = false;
      this.ghosts.visible = false;
      this.headGlow.visible = false;
    }
  }

  /** 落地：如果是殺球就炸開（界內、打過網 = 得分，更大） */
  land(p: Vec3, inBounds: boolean): void {
    const f = this.fl;
    if (!f.on) return;
    f.on = false;
    const th = f.theme;
    const crossed = Math.sign(p.z) !== f.hitter;
    const winner = inBounds && crossed;
    const k = f.k;
    const { x, z } = p;
    const L = f.P * (winner ? 1.3 : inBounds ? 1 : 0.7) * this.farScale(x, 0, z);
    const G = this.glow;
    const Sf = this.soft;

    // 地面閃光（平貼）＋一個面向鏡頭的閃光（低角度也看得到）
    let i = G.spawn(PLANE, GLOW, x, 0.03, z, 0.24, 1.2 * L, 3.4 * L, th.core, th.main, 0.95);
    G.look(i, 0, 1, 2, 0.3);
    i = G.spawn(BILL, GLOW, x, 0.25, z, 0.14, 1.2 * L, 2.4 * L, th.core, th.main, 0.75);
    G.look(i, 0, 1, 2, 0.6);
    // 地上的震波：兩圈
    i = G.spawn(PLANE, RING, x, 0.04, z, 0.44, 0.3 * L, 3.8 * L, th.main, f.outer, 1);
    G.look(i, 0.08, 0.7, 1.2, 0.3);
    i = G.spawn(PLANE, RING, x, 0.04, z, 0.36, 0.2 * L, 2.5 * L, th.core, th.main, 0.75);
    G.look(i, 0.05, 1, 1.2, 0.3);
    G.delay(i, 0.07);
    // 得分：衝天光柱
    if (winner) {
      i = G.spawn(SEG, BEAM, x, 0, z, 0.42, 0.9 * L, 0.5 * L, th.main, th.outer, 0.8);
      G.axis(i, 0, 3.4 * L, 0);
      G.look(i, 0, 0.9, 1.6, 0.3);
      i = G.spawn(SEG, BEAM, x, 0, z, 0.3, 0.3 * L, 0.12 * L, th.core, th.main, 1);
      G.axis(i, 0, 4.2 * L, 0);
      G.look(i, 0, 1, 1.4, 0.3);
    }
    // 火花：往四周、偏球飛來的方向噴
    _q.set(f.dir.x, 0, f.dir.z);
    if (_q.lengthSq() > 1e-6) _q.normalize();
    const nSpark = Math.round((14 + 16 * Math.min(1.2, k)) * (winner ? 1.3 : 1));
    for (let n = 0; n < nSpark; n++) {
      const az = Math.random() * Math.PI * 2;
      const el = rnd(0.25, 1.1);
      _d.set(Math.cos(az) * Math.cos(el), Math.sin(el), Math.sin(az) * Math.cos(el)).addScaledVector(_q, 0.7).normalize();
      const sp = rnd(4, 11) * (0.7 + 0.3 * L);
      i = G.spawn(STREAK, LINE, x, 0.05, z, rnd(0.3, 0.55), 0.045 * L, 0.02, th.core, th.outer, 1);
      G.vel(i, _d.x * sp, _d.y * sp, _d.z * sp, 1.5, -9.8);
      G.str[i] = 0.04;
      G.look(i, 0, 0.8, 1, 0.4);
      G.flg[i] = F_BOUNCE;
    }
    // 碎屑（實心小點，會彈）＋揚塵
    const nChip = Math.round(10 + 10 * k);
    for (let n = 0; n < nChip; n++) {
      const az = Math.random() * Math.PI * 2;
      const out = rnd(1, 3.2);
      i = Sf.spawn(BILL, CHIP, x, 0.04, z, rnd(0.55, 0.9), rnd(0.05, 0.09), 0.04, DEBRIS, DEBRIS, 0.95);
      Sf.vel(i, Math.cos(az) * out + _q.x, rnd(2.5, 5.2), Math.sin(az) * out + _q.z, 0.6, -14);
      Sf.look(i, 0, 0, 3, 0.2);
      Sf.flg[i] = F_BOUNCE;
    }
    const nDust = Math.round(9 + 6 * k);
    for (let n = 0; n < nDust; n++) {
      const az = (n / nDust) * Math.PI * 2 + rnd(-0.3, 0.3);
      const out = rnd(1, 2.6);
      i = Sf.spawn(BILL, PUFF, x + Math.cos(az) * 0.2, 0.15, z + Math.sin(az) * 0.2, rnd(0.6, 1.0), 0.35 * L, rnd(1.0, 1.5) * L, DUST, DUST, 0.42);
      Sf.vel(i, Math.cos(az) * out, rnd(0.3, 0.9), Math.sin(az) * out, 2.6, 0.2);
      Sf.look(i, Math.random(), 0, 1.3, 0.2);
      Sf.flg[i] = F_FADEIN;
    }
    // 主題：火焰往上竄；電光沿地面亂竄
    if (th.flame) {
      for (let n = 0; n < 7; n++) {
        i = G.spawn(BILL, GLOW, x + rnd(-0.3, 0.3), 0.1, z + rnd(-0.3, 0.3), rnd(0.3, 0.5), 0.35 * L, 0.8 * L, th.main, th.cool, 0.7);
        G.vel(i, rnd(-0.6, 0.6), rnd(1.5, 3.2), rnd(-0.6, 0.6), 2, 0.5);
        G.look(i, 0, 0.5, 1.4, 0.3);
      }
    } else {
      for (let n = 0; n < 7; n++) {
        const az = Math.random() * Math.PI * 2;
        const len = rnd(0.9, 1.7) * L;
        this.bolt(x, 0.05, z, x + Math.cos(az) * len, 0.05, z + Math.sin(az) * len, 5, 0.2 * L, 0.07 * L, rnd(0.08, 0.13), n < 4 ? 0 : 0.06, th);
      }
    }
    this.scorch.spawn(x, z, (winner ? 2.3 : 1.7) * L, th.main, winner ? 2.0 : 1.5);

    const near = Math.sign(z) === 1 ? 1 : 0.75;
    this.hooks.shake((0.045 + 0.045 * Math.min(1, k)) * (winner ? 1.5 : 1) * near * (f.live ? 1 : 0.5), 0.22);
    if (f.live && winner) this.screen.hit(f.outer, 0, 0.22);
  }

  /** 殺球掛網：網上一小團火花 */
  net(p: Vec3): void {
    const f = this.fl;
    if (!f.on) return;
    this.endFlight();
    const th = f.theme;
    const G = this.glow;
    const i = G.spawn(BILL, GLOW, p.x, p.y, p.z, 0.14, 0.4, 1.1, th.core, th.main, 0.8);
    G.look(i, 0, 1, 2, 0.5);
    for (let n = 0; n < 12; n++) {
      randDir(_d);
      const sp = rnd(2, 6);
      const j = G.spawn(STREAK, LINE, p.x, p.y, p.z, rnd(0.15, 0.3), 0.035, 0.015, th.core, th.outer, 0.9);
      G.vel(j, _d.x * sp, _d.y * sp, _d.z * sp, 3, -8);
      G.str[j] = 0.03;
      G.look(j, 0, 0.7, 1, 0.5);
    }
  }

  /** 一道閃電：起點到終點折成 segs 段，每段橫向亂偏 jitter；外層主色＋白芯 */
  private bolt(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, segs: number, jitter: number, width: number, life: number, delay: number, th: FxTheme): void {
    const G = this.glow;
    _b.set(x1 - x0, y1 - y0, z1 - z0);
    let px = x0, py = y0, pz = z0;
    for (let s = 1; s <= segs; s++) {
      const t = s / segs;
      let nx = x0 + _b.x * t, ny = y0 + _b.y * t, nz = z0 + _b.z * t;
      if (s < segs) {
        randDir(_s);
        nx += _s.x * jitter;
        ny += _s.y * jitter * (y0 < 0.1 && y1 < 0.1 ? 0.15 : 1);
        nz += _s.z * jitter;
      }
      let i = G.spawn(SEG, BEAM, px, py, pz, life, width * 2.2, width * 1.6, th.main, th.outer, 0.8);
      G.axis(i, nx - px, ny - py, nz - pz);
      G.look(i, 0, 0.6, 1, 0.6);
      if (delay) G.delay(i, delay);
      i = G.spawn(SEG, BEAM, px, py, pz, life, width * 0.7, width * 0.5, WHITE, th.core, 1);
      G.axis(i, nx - px, ny - py, nz - pz);
      G.look(i, 0, 1, 1, 0.6);
      if (delay) G.delay(i, delay);
      px = nx;
      py = ny;
      pz = nz;
    }
  }

  /** 每幀：飛行拖尾、粒子、螢幕效果 */
  update(dt: number, shuttle: { pos: Vec3; mode: ShuttleMode }, cam: THREE.PerspectiveCamera, aspect: number): void {
    this.time += dt;
    const f = this.fl;
    if (f.on && shuttle.mode !== 'flight') f.on = false; // 掛網、發球重置……
    if (f.on) this.flight(dt, shuttle.pos);
    else if (f.vis > 0) f.vis = Math.max(0, f.vis - dt / 0.14);

    // 拖尾（落地後一邊變短一邊淡掉）
    if (f.vis > 0) {
      const len = (2.2 + 2.6 * Math.min(1.2, f.k)) * (0.35 + 0.65 * f.vis);
      const width = 0.3 + 0.26 * Math.min(1.2, f.k);
      this.ribbon.build(len, width, f.vis * (f.live ? 1 : 0.8), this.time, cam);
      this.updateGhosts(f.vis);
      const hg = this.headGlow;
      hg.visible = f.on;
      if (f.on) {
        const { x, y, z } = shuttle.pos;
        hg.position.set(x, y, z);
        const s = (0.55 + 0.5 * f.P) * (1 + 0.12 * Math.sin(this.time * 60)) * this.farScale(x, y, z);
        hg.scale.set(s, s, 1);
      }
    } else {
      this.ribbon.mesh.visible = false;
      this.ghosts.visible = false;
      this.headGlow.visible = false;
    }

    this.glow.update(dt);
    this.soft.update(dt);
    this.glow.build(cam);
    this.soft.build(cam);
    this.scorch.update(dt);
    this.screen.update(dt, aspect);
  }

  /** 殺球飛行中：記錄路徑、沿路灑火星／電花、閃電 */
  private flight(dt: number, pos: Vec3): void {
    const f = this.fl;
    const th = f.theme;
    const G = this.glow;
    this.ribbon.push(pos);
    _p.set(pos.x, pos.y, pos.z);
    const moved = _p.distanceTo(f.last);
    if (moved > 1e-4) f.dir.subVectors(_p, f.last).divideScalar(moved);
    f.last.copy(_p);
    const far = this.farScale(pos.x, pos.y, pos.z);
    // 每公尺灑幾顆（跟幀率無關）
    f.emit += moved * (th.flame ? 6 + 6 * f.k : 4 + 4 * f.k);
    while (f.emit >= 1) {
      f.emit -= 1;
      const back = Math.random() * moved; // 沿這一幀走過的路平均分布
      const x = pos.x - f.dir.x * back + rnd(-0.05, 0.05);
      const y = pos.y - f.dir.y * back + rnd(-0.05, 0.05);
      const z = pos.z - f.dir.z * back + rnd(-0.05, 0.05);
      randDir(_d);
      if (th.flame) {
        const i = G.spawn(BILL, GLOW, x, y, z, rnd(0.25, 0.45), rnd(0.22, 0.38) * f.P * far, 0.04, th.main, th.cool, 0.9);
        G.vel(i, _d.x * 1.6 - f.dir.x * 1.5, _d.y * 1.6 + 0.6, _d.z * 1.6 - f.dir.z * 1.5, 2, 1.5);
        G.look(i, 0, 0.6, 1, 0.4);
      } else {
        const sp = rnd(2, 5) * far;
        const i = G.spawn(STREAK, LINE, x, y, z, rnd(0.1, 0.18), 0.05 * far, 0.015, th.core, th.main, 0.9);
        G.vel(i, _d.x * sp, _d.y * sp, _d.z * sp, 4, 0);
        G.str[i] = 0.03;
        G.look(i, 0, 0.8, 1, 0.4);
      }
    }
    // 電光：沿拖尾不時劈一道閃電，偶爾往旁邊岔出一道電弧
    if (!th.flame && this.ribbon.count > 1) {
      f.zap -= dt;
      if (f.zap <= 0) {
        f.zap = rnd(0.03, 0.055);
        const sc = f.P * far;
        const d0 = rnd(0, 0.3);
        const d1 = d0 + rnd(0.8, 1.6);
        if (this.ribbon.at(d0, _a, _d) && this.ribbon.at(Math.min(d1, this.ribbon.length), _q, _d)) {
          this.bolt(_a.x, _a.y, _a.z, _q.x, _q.y, _q.z, 5, 0.22 * sc, 0.05 * sc, 0.08, 0, th);
        }
        if (Math.random() < 0.5 && this.ribbon.at(rnd(0.2, 1.2), _a, _d)) {
          randDir(_q).addScaledVector(_d, -_q.dot(_d)).normalize();
          const L = rnd(0.5, 1.0) * sc;
          this.bolt(_a.x, _a.y, _a.z, _a.x + _q.x * L, _a.y + _q.y * L, _a.z + _q.z * L, 3, 0.14 * sc, 0.04 * sc, 0.06, 0, th);
        }
      }
    }
  }

  /** 殘影：沿拖尾擺幾顆主題色的羽球（加法混色，一個 draw call） */
  private updateGhosts(vis: number): void {
    const f = this.fl;
    const gap = 0.3 + 0.18 * Math.min(1, f.k);
    let shown = 0;
    for (let g = 0; g < GHOSTS; g++) {
      const ok = f.on && this.ribbon.at(gap * (g + 1), _p, _d);
      const fade = ok ? vis * 0.75 * Math.pow(1 - g / GHOSTS, 1.4) : 0;
      if (ok) {
        _quat.setFromUnitVectors(UP, _d.negate()); // 軟木頭朝前進方向
        const s = 1 + 0.12 * (g + 1);
        _m4.compose(_p, _quat, _scl.set(s, s, s));
        this.ghosts.setMatrixAt(g, _m4);
        shown++;
      }
      const c = g === 0 ? f.theme.core : f.theme.main;
      this.ghosts.setColorAt(g, _col.setRGB(c[0] * fade, c[1] * fade, c[2] * fade, THREE.SRGBColorSpace));
    }
    this.ghosts.visible = shown > 0;
    this.ghosts.instanceMatrix.needsUpdate = true;
    if (this.ghosts.instanceColor) this.ghosts.instanceColor.needsUpdate = true;
  }
}

/** 隨機單位向量（寫進 out） */
function randDir(out: THREE.Vector3): THREE.Vector3 {
  const u = Math.random() * 2 - 1;
  const a = Math.random() * Math.PI * 2;
  const r = Math.sqrt(1 - u * u);
  return out.set(r * Math.cos(a), u, r * Math.sin(a));
}
