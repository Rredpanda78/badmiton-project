import * as THREE from 'three';

const RING = 18; // 樣本數（要能裝下最長的 life：18 × 約 0.01 模擬秒）
const SUB = 4; // 相鄰樣本之間再細分幾段（用四元數插值，弧線才圓）
const COLS = (RING - 1) * SUB + 1;
const ROWS = 3; // 每欄 3 個頂點：拍頭外緣（亮邊）、中段、內緣
const STEP = 0.008; // 取樣間隔（模擬秒）：幀率再高，拖尾長度也一樣
/**
 * 深度偏移（公尺）：頂點沿著視線往鏡頭拉近這麼多，螢幕位置不變。
 * 鏡頭在球員後上方，殺球的隨揮會揮到身體前下方，被自己的背擋住；拉近之後拖尾會蓋在身上，從後面也看得到。
 * 網子本身不寫深度，所以不會因此穿網。
 */
const DEPTH_BIAS = 1.3;

/**
 * 緞帶面向鏡頭的程度低於這個值（|法線·視線|）就開始把寬度轉向螢幕。
 * 頭頂殺球的揮拍平面是直立、前後向的，正好包含「後上方鏡頭」的視線 → 原本的扇形緞帶從後面看是一條線。
 */
const FACE_MIN = 0.65;

const _a = new THREE.Vector3();
const _s = new THREE.Vector3();
const _t = new THREE.Vector3();
const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _w = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _c = new THREE.Color();
const _e = new THREE.Color();
const WHITE = new THREE.Color(1, 1, 1);

export interface SwooshStyle {
  color: number;
  strength: number; // 最新那端的不透明度
  life: number; // 拖尾長度（模擬秒）
  inner: number; // 內緣到肩膀的距離（拍子座標，外緣固定在拍頭）
  edge: number; // 外緣往白色混多少（亮邊）
}

export const SWOOSH_NORMAL: SwooshStyle = { color: 0xeaf6ff, strength: 0.75, life: 0.12, inner: 0.62, edge: 0.6 };
export const SWOOSH_SMASH: SwooshStyle = { color: 0xffc642, strength: 0.92, life: 0.15, inner: 0.5, edge: 0.45 };
export const SWOOSH_JUMP: SwooshStyle = { color: 0x6ff3ff, strength: 1, life: 0.17, inner: 0.45, edge: 0.45 };

/**
 * 揮拍拖尾：記錄拍子（肩膀位置＋手臂方向）在世界座標的軌跡，畫成一條漸淡的弧形緞帶。
 * 緞帶橫向分兩段：拍頭那側是一條較亮、接近白色的邊，往內漸淡（讀起來像揮過去的弧，不是一片色塊）。
 * 幾何與所有暫存一次配置好；每幀只改 buffer 內容。
 * mesh 要掛在一個會被加進場景的物件底下，並把 mesh.matrix 設成「父物件世界矩陣的反矩陣」（頂點就是世界座標）。
 */
export class RacketTrail {
  readonly mesh: THREE.Mesh;
  private sh: THREE.Vector3[] = []; // 肩膀（世界）
  private q: THREE.Quaternion[] = []; // 手臂方向（世界；拍子沿 +Y）
  private len = new Float32Array(RING); // 拍子長度倍率
  private age = new Float32Array(RING);
  private n = 0;
  private since = 0;
  private pos: Float32Array;
  private col: Float32Array;
  private posAttr: THREE.BufferAttribute;
  private colAttr: THREE.BufferAttribute;
  private style: SwooshStyle = SWOOSH_NORMAL;
  private tint = new THREE.Color(SWOOSH_NORMAL.color);
  private edgeTint = new THREE.Color().copy(this.tint).lerp(WHITE, SWOOSH_NORMAL.edge);
  /** 鏡頭位置（世界）：每次畫的時候從 onBeforeRender 更新；第一次揮拍前先猜直向鏡頭的位置 */
  private eye = new THREE.Vector3(0, 10.8, 13.2);

  constructor(private readonly tip = 1.06) {
    for (let i = 0; i < RING; i++) {
      this.sh.push(new THREE.Vector3());
      this.q.push(new THREE.Quaternion());
    }
    this.pos = new Float32Array(COLS * ROWS * 3);
    this.col = new Float32Array(COLS * ROWS * 4);
    const idx: number[] = [];
    for (let c = 0; c < COLS - 1; c++) {
      for (let r = 0; r < ROWS - 1; r++) {
        const a = c * ROWS + r;
        const b = a + ROWS;
        idx.push(a, a + 1, b, a + 1, b + 1, b);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setIndex(idx);
    this.posAttr = new THREE.BufferAttribute(this.pos, 3);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr = new THREE.BufferAttribute(this.col, 4);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', this.posAttr);
    geo.setAttribute('color', this.colAttr);
    geo.setDrawRange(0, 0);
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    mat.onBeforeCompile = (sh) => {
      sh.vertexShader = sh.vertexShader.replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        mvPosition.xyz *= max(0.05, 1.0 - ${DEPTH_BIAS.toFixed(2)} / max(length(mvPosition.xyz), 1e-3));
        gl_Position = projectionMatrix * mvPosition;`,
      );
    };
    mat.customProgramCacheKey = () => 'racket-swoosh-bias';
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 2;
    this.mesh.onBeforeRender = (_r, _sc, cam) => {
      this.eye.setFromMatrixPosition(cam.matrixWorld);
    };
  }

  /** 換一拍：清掉舊軌跡 */
  reset(): void {
    this.n = 0;
    this.since = 0;
    this.mesh.visible = false;
  }

  setStyle(s: SwooshStyle): void {
    if (s === this.style) return;
    this.style = s;
    this.tint.set(s.color);
    this.edgeTint.copy(this.tint).lerp(WHITE, s.edge);
  }

  /**
   * 每幀呼叫一次。active 時記錄這一幀的拍子：shoulder（世界）、q（世界方向）、len（拍子長度倍率，含身高縮放）。
   * dt 用模擬時間（跟慢動作同步）。
   */
  step(dt: number, active: boolean, shoulder: THREE.Vector3, q: THREE.Quaternion, len: number): void {
    for (let i = 0; i < this.n; i++) this.age[i] += dt;
    this.since += dt;
    if (active) {
      if (this.n === 0 || this.since >= STEP) {
        // 往後挪一格（只交換物件參照，不配置）
        const lastS = this.sh[RING - 1];
        const lastQ = this.q[RING - 1];
        for (let i = RING - 1; i > 0; i--) {
          this.sh[i] = this.sh[i - 1];
          this.q[i] = this.q[i - 1];
          this.len[i] = this.len[i - 1];
          this.age[i] = this.age[i - 1];
        }
        this.sh[0] = lastS;
        this.q[0] = lastQ;
        this.n = Math.min(RING, this.n + 1);
        this.since = 0;
      }
      this.sh[0].copy(shoulder);
      this.q[0].copy(q);
      this.len[0] = len;
      this.age[0] = 0;
    }
    const life = this.style.life;
    // 整段都淡掉的樣本丟掉
    while (this.n > 1 && this.age[this.n - 2] > life) this.n--;
    if (this.n < 2 || this.age[0] > life) {
      this.n = active ? this.n : 0;
      this.mesh.visible = false;
      return;
    }
    this.build();
  }

  private build(): void {
    let c = 0;
    const cols = (this.n - 1) * SUB + 1;
    for (let i = 0; i < this.n - 1; i++) {
      for (let j = 0; j < SUB; j++) this.column(c++, i, j / SUB);
    }
    this.column(c++, this.n - 1, 0);
    this.faceCamera(cols);
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, (cols - 1) * (ROWS - 1) * 6);
    this.mesh.visible = true;
  }

  /**
   * 緞帶側對鏡頭時（例如從後面看頭頂殺球），把每一欄的「拍頭 → 內緣」方向轉向「螢幕上垂直於拍頭軌跡」的方向，寬度不變。
   * 正面看得到的揮拍（平抽、挑球）維持原本的扇形。第一輪決定緞帶擺在軌跡哪一側（整條一致，不會扭轉），第二輪套用。
   */
  private faceCamera(cols: number): void {
    const p = this.pos;
    let side = 0;
    for (let pass = 0; pass < 2; pass++) {
      const sign = side >= 0 ? 1 : -1;
      for (let c = 0; c < cols; c++) {
        const k = c * ROWS * 3;
        const k0 = Math.max(0, c - 1) * ROWS * 3;
        const k1 = Math.min(cols - 1, c + 1) * ROWS * 3;
        _t.set(p[k1] - p[k0], p[k1 + 1] - p[k0 + 1], p[k1 + 2] - p[k0 + 2]); // 拍頭軌跡切線
        if (_t.lengthSq() < 1e-10) continue;
        _t.normalize();
        _a.set(p[k], p[k + 1], p[k + 2]); // 拍頭
        _v.subVectors(_a, this.eye).normalize(); // 視線
        _d.set(p[k + 6] - _a.x, p[k + 7] - _a.y, p[k + 8] - _a.z); // 拍頭 → 內緣
        const wlen = _d.length();
        if (wlen < 1e-5) continue;
        _d.divideScalar(wlen);
        const face = Math.abs(_n.crossVectors(_t, _d).normalize().dot(_v));
        if (face >= FACE_MIN) continue;
        _w.crossVectors(_t, _v);
        if (_w.lengthSq() < 1e-10) continue;
        _w.normalize();
        if (pass === 0) {
          side += _w.dot(_d);
          continue;
        }
        const e = 1 - face / FACE_MIN; // 0 = 夠正面、1 = 完全側對
        _d.lerp(_w.multiplyScalar(sign), e).normalize().multiplyScalar(wlen);
        p[k + 3] = _a.x + _d.x * 0.35; // 中段在外緣往內 35%
        p[k + 4] = _a.y + _d.y * 0.35;
        p[k + 5] = _a.z + _d.z * 0.35;
        p[k + 6] = _a.x + _d.x;
        p[k + 7] = _a.y + _d.y;
        p[k + 8] = _a.z + _d.z;
      }
    }
  }

  /** 第 c 欄：樣本 i 往 i+1 插值 t */
  private column(c: number, i: number, t: number): void {
    const st = this.style;
    const tip = this.tip;
    const j = Math.min(i + 1, this.n - 1);
    _s.lerpVectors(this.sh[i], this.sh[j], t);
    _q.slerpQuaternions(this.q[i], this.q[j], t);
    const len = this.len[i] + (this.len[j] - this.len[i]) * t;
    const age = this.age[i] + (this.age[j] - this.age[i]) * t;
    const f = Math.max(0, 1 - age / st.life);
    // 比平方柔和的淡出：拖尾中段還看得到，不會只剩拍頭一小截
    const fade = f * (0.3 + 0.7 * f);
    // 越舊越窄：內緣往拍頭收（彗星尾巴）；中段固定在外緣往內 35% 的位置
    const inner = tip - (tip - st.inner) * (0.25 + 0.75 * f);
    const mid = tip - (tip - inner) * 0.35;
    const p = this.pos;
    const k = c * ROWS * 3;
    _a.set(0, tip * len, 0).applyQuaternion(_q).add(_s);
    p[k] = _a.x;
    p[k + 1] = _a.y;
    p[k + 2] = _a.z;
    _a.set(0, mid * len, 0).applyQuaternion(_q).add(_s);
    p[k + 3] = _a.x;
    p[k + 4] = _a.y;
    p[k + 5] = _a.z;
    _a.set(0, inner * len, 0).applyQuaternion(_q).add(_s);
    p[k + 6] = _a.x;
    p[k + 7] = _a.y;
    p[k + 8] = _a.z;

    const cl = this.col;
    const m = c * ROWS * 4;
    const a = st.strength * fade;
    // 最新那段的外緣最白，越舊越回到本色
    const e = _e.copy(this.tint).lerp(this.edgeTint, f);
    const tint = _c.copy(this.tint);
    cl[m] = e.r;
    cl[m + 1] = e.g;
    cl[m + 2] = e.b;
    cl[m + 3] = a;
    cl[m + 4] = tint.r;
    cl[m + 5] = tint.g;
    cl[m + 6] = tint.b;
    cl[m + 7] = a * 0.62;
    cl[m + 8] = tint.r;
    cl[m + 9] = tint.g;
    cl[m + 10] = tint.b;
    cl[m + 11] = a * 0.05;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
