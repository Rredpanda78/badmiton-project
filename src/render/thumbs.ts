import * as THREE from 'three';
import { BASE_KIT } from '../sim/kits';
import type { PlayerState } from '../sim/match';
import { PlayerModel, playerStyle } from './playerModel';
import { makeRacket } from './racket';

/**
 * 選單卡片的 3D 小圖：用一個小的離屏 WebGLRenderer 把球員（真正的遊戲模型：身高、體型、髮型、頭帶、球衣色、手上的球拍）
 * 擺成準備姿勢、3/4 側面拍一張，球拍另外拍一張，轉成 dataURL 快取起來。
 * 所有球員用同一台相機、同一個比例（看得出身高差），球拍也一樣。用完一陣子就釋放 WebGL context。
 */

const W = 176; // 輸出像素（卡片上顯示 88 × 104 CSS px，2 倍給高解析螢幕）
const H = 208;

const cache = new Map<string, string>();
let gl: THREE.WebGLRenderer | null = null;
let idleTimer: number | undefined;
let scene: THREE.Scene | null = null;

function context(): { r: THREE.WebGLRenderer; s: THREE.Scene } {
  if (!gl) {
    gl = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    gl.setPixelRatio(1);
    gl.setSize(W, H, false);
    gl.setClearColor(0x000000, 0);
  }
  if (!scene) {
    scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xe6eeff, 0x3a4452, 1.9));
    const key = new THREE.DirectionalLight(0xffffff, 1.9);
    key.position.set(3, 6, -5); // 相機那一側的右上方
    scene.add(key);
    const rim = new THREE.DirectionalLight(0x9fc4ff, 0.8);
    rim.position.set(-4, 3, 4); // 背光勾邊
    scene.add(rim);
  }
  // 一段時間沒用就釋放（手機的 WebGL context 數量有限）
  clearTimeout(idleTimer);
  idleTimer = window.setTimeout(() => {
    gl?.dispose();
    gl?.forceContextLoss();
    gl = null;
  }, 5000);
  return { r: gl, s: scene };
}

/** 拍一張：subject 放進場景、照相、拿出來 */
function shoot(subject: THREE.Object3D, cam: THREE.Camera): string {
  try {
    const { r, s } = context();
    s.add(subject);
    r.render(s, cam);
    s.remove(subject);
    return r.domElement.toDataURL('image/png');
  } catch {
    return ''; // 沒有 WebGL：卡片就不放圖
  }
}

/** 釋放一個物件底下的幾何與材質 */
function disposeTree(o: THREE.Object3D): void {
  o.traverse((x) => {
    const m = x as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry.dispose();
    const mm = m.material;
    if (Array.isArray(mm)) mm.forEach((q) => q.dispose());
    else (mm as THREE.Material).dispose();
  });
}

/** 球員相機：固定位置（所有球員同比例），前方偏右 25° 的 3/4 角度、略高往下看；最高的球員舉拍也拍得到 */
const playerCam = (() => {
  const c = new THREE.PerspectiveCamera(21, W / H, 0.1, 50);
  const a = (25 * Math.PI) / 180;
  const d = 6.4;
  c.position.set(Math.sin(a) * d, 1.6, -Math.cos(a) * d);
  c.lookAt(0, 1.08, 0);
  c.updateMatrixWorld();
  return c;
})();

/** 球拍相機：所有球拍同比例 */
const racketCam = (() => {
  const c = new THREE.PerspectiveCamera(20, W / H, 0.05, 20);
  c.position.set(0, 0.86, -1.95);
  c.lookAt(0, 0.8, 0);
  c.updateMatrixWorld();
  return c;
})();

/** 站著不動、沒在打球的假球員狀態（模型 update 用） */
function idleState(): PlayerState {
  return {
    id: 0,
    team: 0,
    side: 1,
    court: 1,
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    charge: 0,
    charging: false,
    chargeT: 0,
    swing: null,
    recover: 0,
    jumpArmed: false,
    jumpUsed: false,
    airborne: false,
    landRecover: 0,
    kit: BASE_KIT,
    takeoffAt: 0,
    vy: 0,
    bufferedFlick: null,
    bufferT: 0,
    dive: null,
    downT: 0,
    reachMul: 1,
    chase: null,
  };
}

/**
 * 球員小圖（dataURL）：character = kits.ts 的球員 id；shirt／shorts = 這張圖要穿的顏色；racket = 手上的球拍
 */
export function playerThumb(character: string, shirt: number, shorts: number, racketColor: number, racket: string): string {
  const key = `p|${character}|${shirt}|${shorts}|${racketColor}|${racket}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const model = new PlayerModel(shirt, shorts, playerStyle(character, racketColor, racket));
  const st = idleState();
  // 跑幾幀讓姿勢（手臂、髖部高度等緩動）穩定在準備姿勢
  for (let i = 0; i < 45; i++) model.update(st, 1 / 30);
  model.root.updateMatrixWorld(true);
  const url = shoot(model.root, playerCam);
  model.dispose();
  cache.set(key, url);
  return url;
}

/** 球拍小圖（dataURL）：直立、拍面轉 3/4、稍微傾斜 */
export function racketThumb(racket: string, color: number): string {
  const key = `r|${racket}|${color}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const g = makeRacket(color, racket);
  const holder = new THREE.Group();
  holder.add(g);
  g.rotation.y = -0.75; // 拍面（法線 = X）轉向鏡頭
  g.position.y = -0.24; // 以球拍中段為軸傾斜（手腕座標：握把在 0、拍頭約 0.5）
  holder.rotation.z = -0.2;
  holder.position.y = 0.8;
  holder.updateMatrixWorld(true);
  const url = shoot(holder, racketCam);
  disposeTree(holder);
  cache.set(key, url);
  return url;
}
