import * as THREE from 'three';
import { merge, paint } from './geo';

/**
 * 球拍模型（球員手上、選單小圖共用）。座標 = 持拍手（手腕）：原點在手腕、+Y 沿握把往拍頭，拍面法線 ±X。
 * 握把約在 y -0.01～0.14、拍面中心約 y 0.38（HAND_TO_HEAD）。外型照球拍的取捨（kits.ts 的 RACKETS id）：
 * - balance 均衡拍：標準橢圓拍框
 * - attack 攻擊拍（頭重）：拍頭大一點、拍框粗，拍頭頂端加一圈配重（深色）
 * - speed 速度拍（頭輕）：細框、窄長的流線拍頭、細拍桿
 * - control 控制拍：拍頭小而圓、拍線比較密、握把粗一點
 */
interface Shape {
  r: number; // 拍框半徑（高）
  xs: number; // 拍框寬／高
  tube: number; // 拍框粗細
  shaft: number; // 拍桿半徑
  grip: number; // 握把半徑
  cy: number; // 拍面中心高度（手腕座標）
  weight: boolean; // 頭重配重
  grid: number; // 拍線間距（越小越密）
}

const SHAPES: Record<string, Shape> = {
  balance: { r: 0.115, xs: 0.82, tube: 0.0115, shaft: 0.0072, grip: 0.0165, cy: 0.38, weight: false, grid: 0.019 },
  attack: { r: 0.121, xs: 0.84, tube: 0.015, shaft: 0.0082, grip: 0.0165, cy: 0.39, weight: true, grid: 0.019 },
  speed: { r: 0.117, xs: 0.74, tube: 0.0085, shaft: 0.006, grip: 0.0155, cy: 0.385, weight: false, grid: 0.021 },
  control: { r: 0.106, xs: 0.9, tube: 0.0115, shaft: 0.0072, grip: 0.0185, cy: 0.37, weight: false, grid: 0.014 },
};

const GRIP_TOP = 0.14; // 握把上緣

/** 拍面中心高度（手腕座標） */
export function racketHeadY(kind = 'balance'): number {
  return (SHAPES[kind] ?? SHAPES.balance).cy;
}

/** 顏色往黑調（k = 0..1） */
const darken = (c: number, k: number) => {
  const ch = (v: number) => Math.round(v * (1 - k));
  return (ch((c >> 16) & 255) << 16) | (ch((c >> 8) & 255) << 8) | ch(c & 255);
};

/** 拍線貼圖：橢圓裡一格一格的網線（外面透明）；同一種間距共用一張 */
const gridTex = new Map<number, THREE.CanvasTexture>();
function stringTexture(cells: number): THREE.CanvasTexture {
  let t = gridTex.get(cells);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.save();
  g.beginPath();
  g.ellipse(64, 64, 63, 63, 0, 0, Math.PI * 2);
  g.clip();
  g.fillStyle = 'rgba(255,255,255,0.16)';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(255,255,255,0.9)';
  g.lineWidth = 1.4;
  const step = 128 / cells;
  g.beginPath();
  for (let i = step / 2; i < 128; i += step) {
    g.moveTo(i, 0);
    g.lineTo(i, 128);
    g.moveTo(0, i);
    g.lineTo(128, i);
  }
  g.stroke();
  g.restore();
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  gridTex.set(cells, t);
  return t;
}

/**
 * 拍框＋拍桿＋握把（纏把布）：一個頂點色幾何（手腕座標），可以合進球員的蒙皮網格。
 * @param color 拍框顏色（拍線維持淺色）
 * @param kind 球拍 id（kits.ts 的 RACKETS）；不認得就用均衡拍
 */
export function racketFrame(color: number, kind = 'balance'): THREE.BufferGeometry {
  const s = SHAPES[kind] ?? SHAPES.balance;
  const throatY = s.cy - s.r; // 拍框最下緣
  const shaftLen = throatY - GRIP_TOP + 0.012;
  const ring = (tube: number, arc = Math.PI * 2, rot = 0) =>
    new THREE.TorusGeometry(s.r, tube, 6, 26, arc).rotateZ(rot).scale(s.xs, 1, 1).rotateY(Math.PI / 2).translate(0, s.cy, 0);
  const parts: THREE.BufferGeometry[] = [];
  // 握把：八角柱，纏把布一圈一圈（兩種深淺交錯、略有粗細）
  const wraps = 7;
  const seg = (GRIP_TOP - 0.0) / wraps;
  for (let i = 0; i < wraps; i++) {
    const even = i % 2 === 0;
    const r = s.grip * (even ? 1 : 0.955);
    parts.push(paint(new THREE.CylinderGeometry(r, r, seg + 0.002, 8, 1, true).translate(0, seg * (i + 0.5), 0), even ? 0x2c2c2e : 0x3b3b3e));
  }
  parts.push(paint(new THREE.CylinderGeometry(s.grip * 1.15, s.grip * 1.15, 0.014, 8).translate(0, -0.006, 0), 0x1e1e20)); // 握把尾蓋
  parts.push(paint(new THREE.CylinderGeometry(s.grip * 0.7, s.grip, 0.012, 8).translate(0, GRIP_TOP + 0.005, 0), 0x1e1e20)); // 握把頂
  // 拍桿＋T 字接頭（拍桿進拍框處略粗）
  parts.push(paint(new THREE.CylinderGeometry(s.shaft, s.shaft * 1.1, shaftLen, 6).translate(0, GRIP_TOP + shaftLen / 2, 0), color));
  parts.push(paint(new THREE.CylinderGeometry(s.shaft * 1.05, s.shaft * 2.2, 0.03, 6).translate(0, throatY - 0.004, 0), darken(color, 0.2)));
  // 拍框
  parts.push(paint(ring(s.tube), color));
  if (s.weight) {
    // 頭重：拍頭頂端一段加粗的配重（深一點的顏色）
    const arc = Math.PI * 0.55;
    parts.push(paint(ring(s.tube * 1.45, arc, Math.PI / 2 - arc / 2), darken(color, 0.35)));
  }
  if (kind === 'speed') {
    // 頭輕：拍框兩側的細白線（流線感）
    parts.push(paint(ring(s.tube * 1.08, Math.PI * 0.35, -Math.PI * 0.175), 0xf4f4f2));
    parts.push(paint(ring(s.tube * 1.08, Math.PI * 0.35, Math.PI - Math.PI * 0.175), 0xf4f4f2));
  }
  return merge(parts);
}

/** 拍線：一片橢圓網格貼圖（半透明，兩面），掛在持拍手上 */
export function racketStrings(kind = 'balance'): THREE.Mesh {
  const s = SHAPES[kind] ?? SHAPES.balance;
  const rr = s.r - s.tube * 0.5;
  const geo = new THREE.PlaneGeometry(2 * rr * s.xs, 2 * rr).rotateY(Math.PI / 2).translate(0, s.cy, 0);
  const m = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ map: stringTexture(Math.round((2 * s.r) / s.grid)), transparent: true, side: THREE.DoubleSide, depthWrite: false }),
  );
  m.renderOrder = 1;
  return m;
}

/** 整支球拍（選單小圖用）：拍框＋拍線 */
export function makeRacket(color: number, kind = 'balance', mat?: THREE.Material): THREE.Group {
  const g = new THREE.Group();
  g.add(new THREE.Mesh(racketFrame(color, kind), mat ?? new THREE.MeshPhongMaterial({ vertexColors: true, shininess: 40, specular: 0x444444 })));
  g.add(racketStrings(kind));
  return g;
}
