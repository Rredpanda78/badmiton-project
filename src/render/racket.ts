import * as THREE from 'three';
import { merge, paint } from './geo';

/**
 * 球拍模型（球員手上、選單小圖共用）。座標 = 持拍手臂：沿 +Y 延伸，握把約在 y 0.52–0.68、拍面中心約 y 0.94，
 * 拍面朝 ±X。外型照球拍的取捨（kits.ts 的 RACKETS id）：
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
  cy: number; // 拍面中心高度
  weight: boolean; // 頭重配重
  grid: number; // 拍線間距（小圖用，越小越密）
}

const SHAPES: Record<string, Shape> = {
  balance: { r: 0.115, xs: 0.82, tube: 0.012, shaft: 0.0075, grip: 0.017, cy: 0.94, weight: false, grid: 0.019 },
  attack: { r: 0.121, xs: 0.84, tube: 0.016, shaft: 0.0085, grip: 0.017, cy: 0.95, weight: true, grid: 0.019 },
  speed: { r: 0.117, xs: 0.74, tube: 0.0085, shaft: 0.006, grip: 0.016, cy: 0.945, weight: false, grid: 0.021 },
  control: { r: 0.106, xs: 0.9, tube: 0.012, shaft: 0.0075, grip: 0.019, cy: 0.93, weight: false, grid: 0.014 },
};

/** 拍面中心高度（手臂座標） */
export function racketHeadY(kind = 'balance'): number {
  return (SHAPES[kind] ?? SHAPES.balance).cy;
}

/** 顏色往黑調（k = 0..1） */
const darken = (c: number, k: number) => {
  const ch = (v: number) => Math.round(v * (1 - k));
  return (ch((c >> 16) & 255) << 16) | (ch((c >> 8) & 255) << 8) | ch(c & 255);
};

/** 拍線貼圖（選單小圖用：一格一格的網線）；同一種間距共用一張 */
const gridTex = new Map<number, THREE.CanvasTexture>();
function stringTexture(cells: number): THREE.CanvasTexture {
  let t = gridTex.get(cells);
  if (t) return t;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(255,255,255,0.12)';
  g.fillRect(0, 0, 128, 128);
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  g.lineWidth = 1.2;
  const step = 128 / cells;
  g.beginPath();
  for (let i = step / 2; i < 128; i += step) {
    g.moveTo(i, 0);
    g.lineTo(i, 128);
    g.moveTo(0, i);
    g.lineTo(128, i);
  }
  g.stroke();
  t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  gridTex.set(cells, t);
  return t;
}

/**
 * @param color 拍框顏色（拍線維持淺色）
 * @param kind 球拍 id（kits.ts 的 RACKETS）；不認得就用均衡拍
 * @param mat 拍框用的頂點色材質（球員模型共用同一個）；省略就自己建一個
 * @param fine 選單小圖：拍線畫成網格（遊戲中太小，用半透明圓片就好）
 */
export function makeRacket(color: number, kind = 'balance', mat?: THREE.Material, fine = false): THREE.Group {
  const s = SHAPES[kind] ?? SHAPES.balance;
  const g = new THREE.Group();
  const throatY = s.cy - s.r; // 拍框最下緣
  const shaftLen = throatY - 0.68 + 0.01;
  const ring = (tube: number, arc = Math.PI * 2, rot = 0) =>
    new THREE.TorusGeometry(s.r, tube, 6, fine ? 40 : 20, arc).rotateZ(rot).scale(s.xs, 1, 1).rotateY(Math.PI / 2).translate(0, s.cy, 0);
  const parts = [
    paint(new THREE.CylinderGeometry(s.grip, s.grip * 0.88, 0.16, fine ? 12 : 6).translate(0, 0.6, 0), 0x262626), // 握把
    paint(new THREE.CylinderGeometry(s.grip * 1.12, s.grip * 1.12, 0.012, fine ? 12 : 6).translate(0, 0.523, 0), 0x3a3a3a), // 握把尾
    paint(new THREE.CylinderGeometry(s.shaft, s.shaft, shaftLen, 5).translate(0, 0.675 + shaftLen / 2, 0), color), // 拍桿
    paint(ring(s.tube), color),
  ];
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
  const frame = new THREE.Mesh(merge(parts), mat ?? new THREE.MeshLambertMaterial({ vertexColors: true }));
  g.add(frame);
  const stringGeo = new THREE.CircleGeometry(s.r - s.tube * 0.6, fine ? 32 : 16).scale(s.xs, 1, 1).rotateY(Math.PI / 2).translate(0, s.cy, 0);
  const strings = new THREE.Mesh(
    stringGeo,
    fine
      ? new THREE.MeshBasicMaterial({ map: stringTexture(Math.round((2 * s.r) / s.grid)), transparent: true, side: THREE.DoubleSide, depthWrite: false })
      : new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: kind === 'control' ? 0.42 : 0.35, side: THREE.DoubleSide }),
  );
  g.add(strings);
  return g;
}
