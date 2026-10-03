import * as THREE from 'three';

const N = 26; // 保留幾個取樣點（每幀一點：約 0.4 秒的飛行）
const _t = new THREE.Vector3();
const _v = new THREE.Vector3();
const _s = new THREE.Vector3();
const _eye = new THREE.Vector3();

/** 拖尾的樣式（依球種）：顏色、最亮的不透明度 */
export interface TrailStyle {
  color: number;
  strength: number;
}
export const TRAIL_DRIVE: TrailStyle = { color: 0xffffff, strength: 0.9 }; // 平抽、平高球
export const TRAIL_LIFT: TrailStyle = { color: 0xbfe0ff, strength: 0.8 }; // 挑球、高遠球：偏冷
export const TRAIL_DROP: TrailStyle = { color: 0xffe3a0, strength: 0.85 }; // 下壓、切球、放網：偏暖
export const TRAIL_SERVE: TrailStyle = { color: 0xd8f0ff, strength: 0.6 };

/**
 * 羽球的飛行拖尾：一條面向鏡頭的緞帶（每個取樣點兩個頂點，沿螢幕上垂直於軌跡的方向張開），
 * 加法混色、越舊越窄越淡。長度自然跟球速成正比（每幀一點，快的球一幀走得遠）；
 * 亮度與寬度再乘上球速係數：切球、放網幾乎看不到，平抽、高遠球是一道亮亮的光痕。
 * （殺球有自己的能量拖尾：render/fx.ts，那時這條會藏起來）
 * 幾何與暫存一次配置好；每幀只改 buffer 內容。
 */
export class ShuttleTrail {
  readonly mesh: THREE.Mesh;
  private pts: THREE.Vector3[] = [];
  private n = 0;
  private pos: Float32Array;
  private col: Float32Array;
  private posAttr: THREE.BufferAttribute;
  private colAttr: THREE.BufferAttribute;
  private tint = new THREE.Color(TRAIL_DRIVE.color);
  private style: TrailStyle = TRAIL_DRIVE;

  constructor() {
    for (let i = 0; i < N; i++) this.pts.push(new THREE.Vector3());
    this.pos = new Float32Array(N * 2 * 3);
    this.col = new Float32Array(N * 2 * 4);
    const idx: number[] = [];
    for (let i = 0; i < N - 1; i++) {
      const a = i * 2;
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
    const mat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = 3;
  }

  setStyle(s: TrailStyle): void {
    if (s === this.style) return;
    this.style = s;
    this.tint.set(s.color);
  }

  /** 新的一球／不在飛：從這個點重新開始 */
  reset(p: { x: number; y: number; z: number }): void {
    for (const q of this.pts) q.set(p.x, p.y, p.z);
    this.n = 0;
    this.mesh.visible = false;
  }

  /**
   * 每幀（球在飛時）：加一個取樣點並重建緞帶。speed = 球速（m/s）、far = 遠近補償（對面場地的放大一點）。
   */
  push(p: { x: number; y: number; z: number }, speed: number, cam: THREE.Camera, far: number): void {
    const last = this.pts[N - 1];
    for (let i = N - 1; i > 0; i--) this.pts[i] = this.pts[i - 1];
    this.pts[0] = last.set(p.x, p.y, p.z);
    this.n = Math.min(N, this.n + 1);
    // 球速係數：5 m/s 以下看不到（放網、切球落下），17 m/s 以上全亮（平抽、高遠球剛出手）
    const k = Math.min(1, Math.max(0, (speed - 5) / 12));
    if (this.n < 3 || k <= 0) {
      this.mesh.visible = false;
      return;
    }
    const width = (0.03 + 0.06 * k) * far;
    const alpha = this.style.strength * k;
    _eye.setFromMatrixPosition(cam.matrixWorld);
    const P = this.pos;
    const C = this.col;
    const n = this.n;
    for (let i = 0; i < n; i++) {
      const a = this.pts[i];
      const b = this.pts[Math.min(i + 1, n - 1)];
      const c = this.pts[Math.max(i - 1, 0)];
      _t.subVectors(c, b); // 軌跡切線
      _v.subVectors(_eye, a); // 往鏡頭
      _s.crossVectors(_t, _v);
      if (_s.lengthSq() < 1e-12) _s.set(0, 1, 0);
      const f = 1 - i / n; // 1 = 最新
      _s.normalize().multiplyScalar(width * (0.35 + 0.65 * f));
      const k6 = i * 6;
      P[k6] = a.x + _s.x;
      P[k6 + 1] = a.y + _s.y;
      P[k6 + 2] = a.z + _s.z;
      P[k6 + 3] = a.x - _s.x;
      P[k6 + 4] = a.y - _s.y;
      P[k6 + 5] = a.z - _s.z;
      const fade = alpha * f * f * (0.4 + 0.6 * f);
      const k8 = i * 8;
      // 最新那段偏白（球頭亮），往後回到本色
      const wht = f * 0.6;
      const r = this.tint.r + (1 - this.tint.r) * wht;
      const g = this.tint.g + (1 - this.tint.g) * wht;
      const bl = this.tint.b + (1 - this.tint.b) * wht;
      C[k8] = C[k8 + 4] = r;
      C[k8 + 1] = C[k8 + 5] = g;
      C[k8 + 2] = C[k8 + 6] = bl;
      C[k8 + 3] = C[k8 + 7] = fade;
    }
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.mesh.geometry.setDrawRange(0, (n - 1) * 6);
    this.mesh.visible = true;
  }

  hide(): void {
    this.mesh.visible = false;
  }
}
