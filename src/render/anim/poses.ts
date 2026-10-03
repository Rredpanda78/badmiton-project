import * as THREE from 'three';

/**
 * 揮拍姿勢表。方向都在「胸口座標」：模型面向 -z、右手 +x、上 +y。
 * 持拍手是沿 +Y 延伸的一節（用四元數把 +Y 轉到該方向）。
 * 身體扭轉 yaw：正 = 胸口轉向左邊（右肩往前），負 = 轉向右邊（右肩往後、側身）。
 */
export const OVERHEAD = 0; // 頭頂：高遠／殺球／切球
export const FH_DRIVE = 1; // 正手平抽
export const BH_DRIVE = 2; // 反手平抽
export const FH_UNDER = 3; // 正手下手：挑球／放網
export const BH_UNDER = 4; // 反手下手
export type SwingType = 0 | 1 | 2 | 3 | 4;

const UP = new THREE.Vector3(0, 1, 0);
const v = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z).normalize();
const q = (x: number, y: number, z: number) => new THREE.Quaternion().setFromUnitVectors(UP, v(x, y, z));

/** [準備（引拍）, 擊球, 隨揮] */
type Key3 = readonly [number, number, number];

export interface SwingPose {
  wind: THREE.Quaternion; // 引拍
  contact: THREE.Quaternion; // 不知道擊球點時的預設擊球方向
  follow: THREE.Quaternion; // 隨揮
  yaw: Key3; // 身體總扭轉
  pitch: Key3; // 上身前傾（正 = 往前彎）
  roll: Key3; // 上身側彎（正 = 往左倒）
  lUpPrep: THREE.Vector3; // 非持拍手：上臂、前臂方向（手臂沿 -Y）
  lForePrep: THREE.Vector3;
  lUpHit: THREE.Vector3;
  lForeHit: THREE.Vector3;
  bend: Key3; // 持拍手手肘彎曲（弧度；0 = 打直，擊球那一刻幾乎打直、拍面才搆到擊球點）
  elbowPrep: THREE.Vector3; // 手肘從「肩膀→拍頭」這條線往哪邊凸出（胸口座標）
  elbowHit: THREE.Vector3;
  elbowFollow: THREE.Vector3;
}

export const SWING_POSES: readonly SwingPose[] = [
  // OVERHEAD：側身、拍子在腦後 → 轉身向前 → 往左下方收拍；左手先指球，擊球時收回胸前
  {
    wind: q(0.35, 0.75, 0.6),
    contact: q(0.15, 0.95, -0.25),
    follow: q(-0.55, -0.35, -0.75),
    yaw: [-1.1, -0.15, 0.5],
    pitch: [-0.2, 0.05, 0.32],
    roll: [-0.15, 0.18, 0.05],
    lUpPrep: v(-0.1, 0.85, -0.5), // root 座標（實際會改成指向羽球）
    lForePrep: v(-0.1, 0.9, -0.45),
    lUpHit: v(-0.05, -0.7, -0.7),
    lForeHit: v(0.6, 0.05, -0.8),
    bend: [0.95, 0.05, 0.45], // 引拍：手肘朝前上方、拍子垂在腦後
    elbowPrep: v(0.75, 0.25, -0.45),
    elbowHit: v(0.8, 0.1, -0.2),
    elbowFollow: v(0.7, 0.35, 0.25),
  },
  // FH_DRIVE：右側引拍、左手往左側平衡
  {
    wind: q(0.85, 0.35, 0.45),
    contact: q(0.9, 0.2, -0.4),
    follow: q(-0.55, 0.15, -0.8),
    yaw: [-0.75, -0.15, 0.4],
    pitch: [0.08, 0.12, 0.15],
    roll: [0, 0, 0],
    lUpPrep: v(-0.75, -0.2, -0.6),
    lForePrep: v(-0.4, 0.2, -0.9),
    lUpHit: v(-0.8, -0.45, -0.3),
    lForeHit: v(-0.7, -0.2, -0.65),
    bend: [0.7, 0.1, 0.45],
    elbowPrep: v(0.3, -0.9, 0.25),
    elbowHit: v(0.3, -0.9, 0.1),
    elbowFollow: v(0.3, -0.85, -0.3),
  },
  // BH_DRIVE：拍子收到左肩、右肩朝前，往右揮出
  {
    wind: q(-0.7, 0.55, 0.25),
    contact: q(-0.8, 0.2, -0.55),
    follow: q(0.7, 0.3, -0.6),
    yaw: [0.85, 0.5, 0.1],
    pitch: [0.1, 0.12, 0.1],
    roll: [0, 0, 0],
    lUpPrep: v(0.2, -0.75, -0.6),
    lForePrep: v(0.8, 0.2, -0.55),
    lUpHit: v(-0.45, -0.6, 0.65),
    lForeHit: v(-0.4, -0.5, 0.75),
    bend: [0.85, 0.1, 0.4],
    elbowPrep: v(0.6, -0.5, -0.55),
    elbowHit: v(0.4, -0.8, -0.3),
    elbowFollow: v(0.3, -0.9, 0),
  },
  // FH_UNDER：拍子低後方 → 往前上方送；身體壓低前傾，左手往後伸平衡
  {
    wind: q(0.65, -0.5, 0.5),
    contact: q(0.55, -0.45, -0.7),
    follow: q(-0.1, 0.75, -0.65),
    yaw: [-0.45, -0.2, 0.05],
    pitch: [0.28, 0.35, 0.25],
    roll: [-0.1, -0.15, -0.05],
    lUpPrep: v(-0.6, -0.4, 0.7),
    lForePrep: v(-0.5, -0.2, 0.85),
    lUpHit: v(-0.6, -0.4, 0.7),
    lForeHit: v(-0.5, -0.2, 0.85),
    bend: [0.35, 0.1, 0.35],
    elbowPrep: v(0.8, 0.1, 0.35),
    elbowHit: v(0.85, 0.2, 0.1),
    elbowFollow: v(0.6, 0.3, -0.3),
  },
  // BH_UNDER
  {
    wind: q(-0.6, -0.45, 0.35),
    contact: q(-0.55, -0.45, -0.7),
    follow: q(0.35, 0.6, -0.7),
    yaw: [0.65, 0.5, 0.3],
    pitch: [0.28, 0.35, 0.25],
    roll: [0.1, 0.15, 0.05],
    lUpPrep: v(-0.2, -0.75, 0.6),
    lForePrep: v(-0.1, -0.6, 0.8),
    lUpHit: v(-0.2, -0.75, 0.6),
    lForeHit: v(-0.1, -0.6, 0.8),
    bend: [0.4, 0.1, 0.35],
    elbowPrep: v(0.6, 0.5, 0.1),
    elbowHit: v(0.7, 0.4, -0.1),
    elbowFollow: v(0.3, 0.6, 0.2),
  },
];

/** 持拍手：非揮拍時的姿勢 */
export const ARM_READY = q(0.45, 0.6, -0.65); // 拍子舉在身前
export const ARM_RUN = q(0.5, 0.4, -0.6);
export const ARM_RELAX = q(0.3, -0.75, -0.55); // 死球時放下
/** 持拍手手肘：非揮拍時的彎曲與方向（胸口座標） */
export const BEND_READY = 0.62;
export const BEND_RUN = 0.72;
export const BEND_RELAX = 0.25;
export const ELBOW_READY = v(0.55, -0.7, 0.45); // 手肘在身側偏後、朝下
export const ELBOW_RELAX = v(0.3, -0.3, 0.9);
export const ELBOW_DIVE = v(0.6, -0.6, 0);

/** 非持拍手（胸口座標，沿 -Y） */
export const L_READY_UP = v(-0.3, -0.82, -0.5);
export const L_READY_FORE = v(0.2, 0.3, -0.93);
export const L_RELAX_UP = v(-0.15, -1, 0.05);
export const L_RELAX_FORE = v(-0.05, -0.97, -0.2);
export const L_LUNGE_UP = v(-0.55, -0.3, 0.75);
export const L_LUNGE_FORE = v(-0.5, -0.15, 0.85);

/** 依揮拍進度 k 取值：0 = 引拍、1 = 擊球、2 = 隨揮結束 */
export function poseAt(k3: Key3, k: number): number {
  if (k <= 1) {
    const u = Math.max(0, k);
    return k3[0] + (k3[1] - k3[0]) * u * u;
  }
  const u = 1 - Math.min(1, k - 1);
  return k3[1] + (k3[2] - k3[1]) * (1 - u * u * u);
}
