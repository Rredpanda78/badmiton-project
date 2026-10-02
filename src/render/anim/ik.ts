import * as THREE from 'three';

export const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** 指數平滑：與幀率無關的「往目標靠近」 */
export const damp = (cur: number, target: number, rate: number, dt: number) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
export const smooth01 = (t: number) => {
  const u = clamp(t, 0, 1);
  return u * u * (3 - 2 * u);
};
export const easeOut = (t: number) => {
  const u = 1 - clamp(t, 0, 1);
  return 1 - u * u * u;
};
export const easeIn = (t: number) => {
  const u = clamp(t, 0, 1);
  return u * u;
};
/** 角度差（-π..π） */
export const angleDiff = (a: number, b: number) => {
  let d = a - b;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return d;
};

const _u = new THREE.Vector3();
const _n = new THREE.Vector3();

/**
 * 兩節骨 IK（髖 → 膝 → 踝）：解出膝蓋位置。
 * pole = 膝蓋應該朝的方向（通常是腳尖方向）。目標太遠時會把腳踝拉回可及範圍，結果寫進 ankle。
 * 不配置記憶體。
 */
export function solveTwoBone(
  hip: THREE.Vector3,
  target: THREE.Vector3,
  l1: number,
  l2: number,
  pole: THREE.Vector3,
  knee: THREE.Vector3,
  ankle: THREE.Vector3,
): void {
  const u = _u.subVectors(target, hip);
  let d = u.length();
  const maxD = (l1 + l2) * 0.999;
  const minD = Math.abs(l1 - l2) + 0.05;
  if (d < 1e-5) {
    u.set(0, -1, 0);
    d = minD;
  } else u.multiplyScalar(1 / d);
  d = clamp(d, minD, maxD);
  ankle.copy(hip).addScaledVector(u, d);
  // 膝蓋彎曲方向：pole 去掉沿著 u 的分量
  const n = _n.copy(pole).addScaledVector(u, -pole.dot(u));
  if (n.lengthSq() < 1e-6) n.set(0, 0, -1).addScaledVector(u, u.z);
  if (n.lengthSq() < 1e-6) n.set(1, 0, 0);
  n.normalize();
  const cosA = clamp((l1 * l1 + d * d - l2 * l2) / (2 * l1 * d), -1, 1);
  const sinA = Math.sqrt(1 - cosA * cosA);
  knee.copy(hip).addScaledVector(u, l1 * cosA).addScaledVector(n, l1 * sinA);
}
