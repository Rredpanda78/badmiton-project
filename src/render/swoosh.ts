import * as THREE from 'three';

const RING = 14; // 樣本數
const SUB = 4; // 相鄰樣本之間再細分幾段（用四元數插值，弧線才圓）
const COLS = (RING - 1) * SUB + 1;
const STEP = 0.008; // 取樣間隔（模擬秒）：幀率再高，拖尾長度也一樣

const _a = new THREE.Vector3();
const _s = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _c = new THREE.Color();

export interface SwooshStyle {
  color: number;
  strength: number; // 最新那端的不透明度
  life: number; // 拖尾長度（模擬秒）
  inner: number; // 內緣到肩膀的距離（拍子座標，外緣固定在拍頭）
}

export const SWOOSH_NORMAL: SwooshStyle = { color: 0xffffff, strength: 0.52, life: 0.08, inner: 0.77 };
export const SWOOSH_SMASH: SwooshStyle = { color: 0xffcf5a, strength: 0.8, life: 0.11, inner: 0.6 };
export const SWOOSH_JUMP: SwooshStyle = { color: 0x7ff7ff, strength: 0.92, life: 0.13, inner: 0.52 };

/**
 * 揮拍拖尾：記錄拍子（肩膀位置＋手臂方向）在世界座標的軌跡，畫成一條漸淡的弧形緞帶。
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
  private tint = new THREE.Color(1, 1, 1);

  constructor(private readonly tip = 1.06) {
    for (let i = 0; i < RING; i++) {
      this.sh.push(new THREE.Vector3());
      this.q.push(new THREE.Quaternion());
    }
    this.pos = new Float32Array(COLS * 2 * 3);
    this.col = new Float32Array(COLS * 2 * 4);
    const idx: number[] = [];
    for (let c = 0; c < COLS - 1; c++) {
      const a = c * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
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
    this.mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
    );
    this.mesh.matrixAutoUpdate = false;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 2;
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
    const st = this.style;
    const tint = _c.copy(this.tint);
    const tip = this.tip;
    let c = 0;
    const cols = (this.n - 1) * SUB + 1;
    for (let i = 0; i < this.n - 1; i++) {
      for (let j = 0; j < SUB; j++) this.column(c++, i, j / SUB, st, tint, tip);
    }
    this.column(c++, this.n - 1, 0, st, tint, tip);
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, (cols - 1) * 6);
    this.mesh.visible = true;
  }

  /** 第 c 欄：樣本 i 往 i+1 插值 t */
  private column(c: number, i: number, t: number, st: SwooshStyle, tint: THREE.Color, tip: number): void {
    const j = Math.min(i + 1, this.n - 1);
    _s.lerpVectors(this.sh[i], this.sh[j], t);
    _q.slerpQuaternions(this.q[i], this.q[j], t);
    const len = this.len[i] + (this.len[j] - this.len[i]) * t;
    const age = this.age[i] + (this.age[j] - this.age[i]) * t;
    const f = Math.max(0, 1 - age / st.life);
    const fade = f * f;
    // 越舊越窄：內緣往拍頭收（彗星尾巴）
    const inner = tip - (tip - st.inner) * (0.25 + 0.75 * f);
    const p = this.pos;
    const k = c * 6;
    _a.set(0, tip * len, 0).applyQuaternion(_q).add(_s);
    p[k] = _a.x;
    p[k + 1] = _a.y;
    p[k + 2] = _a.z;
    _a.set(0, inner * len, 0).applyQuaternion(_q).add(_s);
    p[k + 3] = _a.x;
    p[k + 4] = _a.y;
    p[k + 5] = _a.z;
    const cl = this.col;
    const m = c * 8;
    const aOut = st.strength * fade;
    cl[m] = cl[m + 4] = tint.r;
    cl[m + 1] = cl[m + 5] = tint.g;
    cl[m + 2] = cl[m + 6] = tint.b;
    cl[m + 3] = aOut;
    cl[m + 7] = aOut * 0.12;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
