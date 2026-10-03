import * as THREE from 'three';
import type { HairStyle } from '../sim/kits';
import { bodyMaterial, gloss, lathe, merge, paint, skinTo, uvAt } from './geo';
import { racketFrame, racketStrings } from './racket';

/**
 * 球員的骨架與身體零件。
 * 骨架 = 一組有名字的樞紐（THREE.Bone，原點在關節、+Y 沿骨頭指向下一個關節），父子關係照 Mixamo 的人形骨架：
 *   hips → spine → chest → neck → head（→ ponytail）
 *   chest → shoulderL/R → upperArmL/R → forearmL/R → handL/R（右手掛球拍）
 *   hips → upperLegL/R → lowerLegL/R → footL/R
 * 身體 = 一個蒙皮網格（SkinnedMesh）：每個零件在自己樞紐的座標裡建好、綁到那根骨頭（關節附近少量混合權重），
 * 全部合併成一個幾何、一個材質 → 整個人一個 draw call（拍線另外一片半透明）。
 * 零件的幾何只跟樞紐的座標有關、跟「誰在轉樞紐」無關：之後可以把同一組樞紐接到 Mixamo 骨架上播動作擷取。
 */

export const PART_NAMES = [
  'hips',
  'spine',
  'chest',
  'neck',
  'head',
  'shoulderL',
  'upperArmL',
  'forearmL',
  'handL',
  'shoulderR',
  'upperArmR',
  'forearmR',
  'handR',
  'upperLegL',
  'lowerLegL',
  'footL',
  'upperLegR',
  'lowerLegR',
  'footR',
] as const;
export type PartName = (typeof PART_NAMES)[number];

/** 對應的 Mixamo 骨頭名稱（之後接動作擷取用） */
export const MIXAMO_NAMES: Record<PartName, string> = {
  hips: 'mixamorig:Hips',
  spine: 'mixamorig:Spine',
  chest: 'mixamorig:Spine2',
  neck: 'mixamorig:Neck',
  head: 'mixamorig:Head',
  shoulderL: 'mixamorig:LeftShoulder',
  upperArmL: 'mixamorig:LeftArm',
  forearmL: 'mixamorig:LeftForeArm',
  handL: 'mixamorig:LeftHand',
  shoulderR: 'mixamorig:RightShoulder',
  upperArmR: 'mixamorig:RightArm',
  forearmR: 'mixamorig:RightForeArm',
  handR: 'mixamorig:RightHand',
  upperLegL: 'mixamorig:LeftUpLeg',
  lowerLegL: 'mixamorig:LeftLeg',
  footL: 'mixamorig:LeftFoot',
  upperLegR: 'mixamorig:RightUpLeg',
  lowerLegR: 'mixamorig:RightLeg',
  footR: 'mixamorig:RightFoot',
};

// ---- 骨架尺寸（公尺）。root 原點 = 腳底中心，模型面向 -z、右手在 +x ----
export const THIGH = 0.41;
export const SHIN = 0.41;
export const ANKLE = 0.075; // 腳踝離地高度
export const UPPER_ARM = 0.29;
export const FOREARM = 0.27;
export const HAND_TO_HEAD = 0.38; // 手腕到拍面中心（手伸直時肩膀到拍面中心 = 0.56 + 0.38 = 0.94）
export const WAIST = 0.1; // 腰（上身旋轉軸）在髖關節上方
export const CHEST_Y = 0.24; // 胸椎（Spine2）在腰上方
export const NECK_Y = 0.6; // 頸根（腰座標）
export const HEAD_Y = 0.675; // 頭的轉軸（腰座標）
export const SHOULDER_X = 0.24; // 肩關節（腰座標）
export const SHOULDER_Y = 0.46;
export const HIP_W = 0.1; // 髖關節左右間距的一半
export const STAND_H = 0.86; // 站直時髖關節高度

export interface BodyOpts {
  shirt: number;
  shorts: number;
  skin: number;
  hair: HairStyle;
  hairColor: number;
  band: number; // 頭帶、護腕、髮圈、鞋側條（隊伍色）
  headband: boolean;
  accent: number; // 球衣配色（領口、側邊條、袖口）
  number?: number;
  build: number; // 體型寬度倍率
  racketColor: number;
  racket: string;
}

export interface Rig {
  bones: Record<PartName, THREE.Bone>;
  list: THREE.Bone[]; // 全部骨頭（含馬尾）
  ponytail: THREE.Bone | null;
  mesh: THREE.SkinnedMesh;
  strings: THREE.Mesh; // 拍線（掛在右手）
  texture: THREE.CanvasTexture;
  hipW: number; // 髖關節左右間距的一半（含體型）
  shoulderX: number; // 肩關節 x（含體型）
}

// 貼圖：上面 70% 是球衣（u：0 左側、0.25 背後、0.5 右側、0.75 前面；v：1 領口、0.3 下襬），下面是白色格（頂點色零件指到這裡）
const TEX_W = 512;
const TEX_H = 256;
const SHIRT_V0 = 0.3;
const SWATCH_U = 0.5;
const SWATCH_V = 0.08;

const hexStr = (n: number) => '#' + n.toString(16).padStart(6, '0');
const mix = (a: number, b: number, k: number) => {
  const ch = (s: number) => Math.round(((a >> s) & 255) * (1 - k) + ((b >> s) & 255) * k);
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
};
const smooth = (t: number) => {
  const u = t < 0 ? 0 : t > 1 ? 1 : t;
  return u * u * (3 - 2 * u);
};

/** 球衣貼圖：領口、兩側配色條、袖口線、背號（前胸小號碼） */
function bodyTexture(shirt: number, accent: number, num?: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = TEX_W;
  c.height = TEX_H;
  const g = c.getContext('2d')!;
  g.scale(TEX_W / 256, TEX_H / 128); // 以下用 256×128 的座標畫
  g.fillStyle = hexStr(shirt);
  g.fillRect(0, 0, 256, 128);
  const shirtH = 128 * (1 - SHIRT_V0); // 球衣區高度（v 0.3..1）
  g.fillStyle = hexStr(accent);
  g.fillRect(0, 0, 256, 3.5); // 領口
  // 側邊條（u = 0／0.5，接縫在 u = 0，所以兩端各畫一半），從腋下到下襬
  const y0 = shirtH * 0.17;
  const y1 = shirtH * 0.97;
  g.fillRect(0, y0, 5, y1 - y0);
  g.fillRect(251, y0, 5, y1 - y0);
  g.fillRect(123, y0, 10, y1 - y0);
  // 肩線（領口兩側往肩膀的斜條）
  g.globalAlpha = 0.55;
  g.fillRect(0, 3.5, 256, 1.2);
  g.globalAlpha = 1;
  if (num !== undefined) {
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(0,0,0,0.3)';
    g.font = 'bold 36px sans-serif';
    g.strokeText(String(num), 64, shirtH * 0.42);
    g.fillStyle = '#ffffff';
    g.fillText(String(num), 64, shirtH * 0.42);
    g.font = 'bold 11px sans-serif';
    g.lineWidth = 2;
    g.strokeText(String(num), 206, shirtH * 0.24);
    g.fillText(String(num), 206, shirtH * 0.24);
  }
  // 白色格（頂點色零件的 UV 指到這裡）；上面留一段球衣色當緩衝（mipmap 不會把白色混進下襬）
  g.fillStyle = '#ffffff';
  g.fillRect(0, 128 * (1 - SWATCH_V * 2.2), 256, 128);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

/** 零件收集器：上色、光澤、UV、蒙皮權重，再轉到 root 座標 */
class Parts {
  readonly geos: THREE.BufferGeometry[] = [];
  constructor(private readonly index: Map<THREE.Bone, number>) {}
  /** color = null：保留幾何原本的頂點色（已經分段上色的零件） */
  add(
    geo: THREE.BufferGeometry,
    bone: THREE.Bone,
    color: number | null,
    g: number,
    blend?: (x: number, y: number, z: number) => [THREE.Bone, number] | null,
    keepUV = false,
  ): void {
    if (color !== null) paint(geo, color);
    gloss(geo, g);
    if (!keepUV) uvAt(geo, SWATCH_U, SWATCH_V);
    const idx = this.index;
    skinTo(
      geo,
      idx.get(bone)!,
      blend
        ? (x, y, z) => {
            const r = blend(x, y, z);
            return r ? [idx.get(r[0])!, r[1]] : null;
          }
        : undefined,
    );
    geo.applyMatrix4(bone.matrixWorld);
    this.geos.push(geo);
  }
}

const Z = new THREE.Vector3(0, 0, 1);
const FLIP = new THREE.Quaternion().setFromAxisAngle(Z, Math.PI); // 骨頭 +Y 朝下（手腳的靜止姿勢）

export function buildRig(o: BodyOpts): Rig {
  const b = Math.min(1.25, Math.max(0.8, o.build));
  const limb = 1 + (b - 1) * 0.8; // 四肢粗細
  const bw = 1 + (b - 1) * 0.9; // 肩寬
  const hipW = HIP_W * (1 + (b - 1) * 0.6);
  const shoulderX = SHOULDER_X * bw;

  // ---------- 骨架（靜止姿勢 = 站直、手臂垂下；root 座標）----------
  const list: THREE.Bone[] = [];
  const index = new Map<THREE.Bone, number>();
  const mk = (name: string, parent: THREE.Bone | null, x: number, y: number, z: number, flip = false): THREE.Bone => {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.set(x, y, z);
    if (flip) bone.quaternion.copy(FLIP);
    parent?.add(bone);
    index.set(bone, list.length);
    list.push(bone);
    return bone;
  };
  const hips = mk('hips', null, 0, STAND_H, 0);
  const spine = mk('spine', hips, 0, WAIST, 0);
  const chest = mk('chest', spine, 0, CHEST_Y, 0);
  const neck = mk('neck', chest, 0, NECK_Y - CHEST_Y, 0);
  const head = mk('head', neck, 0, HEAD_Y - NECK_Y, 0);
  const arm = (s: 1 | -1, L: string) => {
    const sh = mk('shoulder' + L, chest, s * 0.05, SHOULDER_Y - CHEST_Y, 0);
    const up = mk('upperArm' + L, sh, s * (shoulderX - 0.05), 0, 0, true);
    const fo = mk('forearm' + L, up, 0, UPPER_ARM, 0);
    const ha = mk('hand' + L, fo, 0, FOREARM, 0);
    return [sh, up, fo, ha] as const;
  };
  const leg = (s: 1 | -1, L: string) => {
    const up = mk('upperLeg' + L, hips, s * hipW, 0, 0, true);
    const lo = mk('lowerLeg' + L, up, 0, THIGH, 0);
    const ft = mk('foot' + L, lo, 0, SHIN, 0, true); // 兩次翻轉 = 腳掌座標正立（Y 上、腳尖 -Z）
    return [up, lo, ft] as const;
  };
  const [shL, upArmL, foreL, handL] = arm(-1, 'L');
  const [shR, upArmR, foreR, handR] = arm(1, 'R');
  const [upLegL, lowLegL, footL] = leg(-1, 'L');
  const [upLegR, lowLegR, footR] = leg(1, 'R');
  const bones: Record<PartName, THREE.Bone> = {
    hips,
    spine,
    chest,
    neck,
    head,
    shoulderL: shL,
    upperArmL: upArmL,
    forearmL: foreL,
    handL,
    shoulderR: shR,
    upperArmR: upArmR,
    forearmR: foreR,
    handR,
    upperLegL: upLegL,
    lowerLegL: lowLegL,
    footL,
    upperLegR: upLegR,
    lowerLegR: lowLegR,
    footR,
  };
  for (const n of PART_NAMES) bones[n].userData.mixamo = MIXAMO_NAMES[n];
  const HC = new THREE.Vector3(0, 0.085, 0.006); // 頭髮球心（頭座標）
  let ponytail: THREE.Bone | null = null;
  if (o.hair === 'ponytail') ponytail = mk('ponytail', head, 0, HC.y + 0.06, 0.1);
  hips.updateMatrixWorld(true); // 綁定姿勢的世界矩陣（hips 還沒有父物件 = root 座標）

  const P = new Parts(index);
  const skin = o.skin;
  const white = 0xf4f4f2;
  const sock = 0xf4f4f2;

  // ---------- 髖：短褲的骨盆部分（上面被球衣下襬蓋住） ----------
  P.add(
    lathe(
      [
        [-0.1, 0.09],
        [-0.075, 0.165],
        [-0.03, 0.188],
        [0.04, 0.19],
        [0.1, 0.18],
        [0.14, 0.17],
        [0.15, 0.0],
      ],
      18,
    ).scale(b, 1, 0.76 * (1 + (b - 1) * 0.5)),
    hips,
    o.shorts,
    0.3,
  );

  // ---------- 上身：球衣（旋轉體，下襬到頸根；UV 照高度重算，貼圖有領口、側條、背號）----------
  {
    const torso = lathe(
      [
        [-0.09, 0.172],
        [-0.04, 0.164],
        [0.02, 0.158],
        [0.1, 0.168],
        [0.2, 0.186],
        [0.3, 0.202],
        [0.38, 0.214],
        [0.44, 0.224],
        [0.49, 0.2],
        [0.53, 0.138],
        [0.57, 0.082],
        [0.605, 0.06],
      ],
      24,
      -Math.PI / 2,
    );
    const uv = torso.attributes.uv;
    const pos = torso.attributes.position;
    for (let i = 0; i < uv.count; i++) uv.setY(i, SHIRT_V0 + (1 - SHIRT_V0) * ((pos.getY(i) + 0.09) / 0.695));
    torso.scale(bw, 1, 0.64 * (1 + (b - 1) * 0.5));
    P.add(
      torso,
      spine,
      0xffffff,
      0.6,
      // 下襬跟著髖、上半截跟著胸椎（腰扭轉時布料平順）
      (_x, y) => (y < 0.03 ? [hips, 0.55 * smooth((0.03 - y) / 0.12)] : y > 0.26 ? [chest, smooth((y - 0.26) / 0.12)] : null),
      true,
    );
  }

  // ---------- 脖子 ----------
  P.add(new THREE.CylinderGeometry(0.05, 0.056, 0.13, 10).translate(0, 0.045, 0.004).scale(limb, 1, limb), neck, skin, 0.25);

  // ---------- 頭：臉（旋轉體）＋五官＋耳朵＋頭髮／頭帶 ----------
  {
    const face = lathe(
      [
        [-0.05, 0.001],
        [-0.04, 0.046],
        [-0.02, 0.072],
        [0.01, 0.09],
        [0.04, 0.102],
        [0.08, 0.109],
        [0.12, 0.107],
        [0.155, 0.091],
        [0.18, 0.06],
        [0.196, 0.001],
      ],
      20,
    ).scale(1, 1, 1.08);
    face.translate(0, 0, 0.008);
    P.add(face, head, skin, 0.25);
    // 耳朵
    for (const s of [-1, 1]) P.add(new THREE.SphereGeometry(0.017, 8, 6).scale(0.45, 1, 0.9).translate(s * 0.106, 0.065, 0.012), head, skin, 0.25);
    // 眼睛：白眼球（扁）＋深色瞳孔（卡通大瞳）
    for (const s of [-1, 1]) {
      P.add(new THREE.SphereGeometry(0.019, 10, 8).scale(1.1, 0.78, 0.55).translate(s * 0.037, 0.058, -0.098), head, 0xf6f6f6, 0.9);
      P.add(new THREE.SphereGeometry(0.0105, 8, 6).scale(1, 1.15, 0.6).translate(s * 0.038, 0.056, -0.111), head, 0x201714, 1);
    }
    // 眉毛（外側略高）
    for (const s of [-1, 1]) {
      P.add(new THREE.BoxGeometry(0.04, 0.0085, 0.009).rotateZ(-s * 0.14).translate(s * 0.039, 0.086, -0.104), head, mix(o.hairColor, 0x000000, 0.3), 0.3);
    }
    // 鼻子、嘴
    P.add(new THREE.SphereGeometry(0.0115, 8, 6).scale(0.85, 1.1, 1).translate(0, 0.04, -0.111), head, skin, 0.25);
    P.add(new THREE.BoxGeometry(0.03, 0.0055, 0.006).translate(0, 0.012, -0.093), head, mix(skin, 0x8a3a3a, 0.6), 0.4);
    buildHair(P, head, ponytail, o, HC);
  }

  // ---------- 手臂（上臂：三角肌＋袖子；前臂：護腕；手：連指手套形＋拇指）----------
  const armParts = (up: THREE.Bone, fo: THREE.Bone, ha: THREE.Bone) => {
    // 袖子（球衣色）：肩頭圓、袖口有配色線
    P.add(new THREE.SphereGeometry(0.066, 12, 8).scale(limb, 0.95, limb).translate(0, 0.02, 0), up, o.shirt, 0.6);
    P.add(
      lathe(
        [
          [0.02, 0.064],
          [0.09, 0.06],
          [0.112, 0.058],
        ],
        12,
      ).scale(limb, 1, limb),
      up,
      o.shirt,
      0.6,
    );
    P.add(new THREE.CylinderGeometry(0.059, 0.057, 0.012, 12, 1, true).translate(0, 0.118, 0).scale(limb, 1, limb), up, o.accent, 0.5);
    // 上臂（皮膚）＋手肘球
    P.add(
      lathe(
        [
          [0.1, 0.05],
          [0.18, 0.047],
          [0.26, 0.042],
          [UPPER_ARM + 0.01, 0.04],
        ],
        10,
      ).scale(limb, 1, limb),
      up,
      skin,
      0.25,
    );
    P.add(new THREE.SphereGeometry(0.043, 10, 8).scale(limb, 1, limb).translate(0, UPPER_ARM, 0), up, skin, 0.25);
    // 前臂：手肘下方略粗、往手腕收細；護腕（隊伍色＋白線）
    P.add(
      lathe(
        [
          [-0.005, 0.041],
          [0.06, 0.046],
          [0.15, 0.038],
          [FOREARM - 0.05, 0.031],
          [FOREARM + 0.005, 0.029],
        ],
        10,
      ).scale(limb, 1, limb),
      fo,
      skin,
      0.25,
    );
    P.add(new THREE.CylinderGeometry(0.036, 0.038, 0.05, 10, 1, true).translate(0, FOREARM - 0.03, 0).scale(limb, 1, limb), fo, o.band, 0.3);
    P.add(new THREE.CylinderGeometry(0.0375, 0.0375, 0.01, 10, 1, true).translate(0, FOREARM - 0.03, 0).scale(limb, 1, limb), fo, white, 0.3);
    // 手：扁的連指手套形（厚度沿 X = 手掌法線；拍面也朝 ±X）＋拇指（在 -Z 那一側）
    P.add(new THREE.CapsuleGeometry(0.031, 0.045, 3, 8).scale(0.62, 1, 1.2).translate(0, 0.048, 0), ha, skin, 0.3);
    P.add(
      new THREE.CapsuleGeometry(0.0125, 0.03, 2, 6)
        .rotateX(-0.95)
        .translate(0, 0.035, -0.032),
      ha,
      skin,
      0.3,
    );
  };
  armParts(upArmL, foreL, handL);
  armParts(upArmR, foreR, handR);

  // ---------- 腿（大腿：短褲管＋大腿；小腿：小腿肚＋襪子；腳：球鞋）----------
  const legParts = (up: THREE.Bone, lo: THREE.Bone, ft: THREE.Bone) => {
    // 短褲管（短褲色），褲管口略開
    P.add(
      lathe(
        [
          [-0.02, 0.1],
          [0.1, 0.1],
          [0.19, 0.102],
          [0.2, 0.07],
        ],
        12,
      ).scale(limb, 1, limb),
      up,
      o.shorts,
      0.3,
    );
    // 大腿＋膝蓋球
    P.add(
      lathe(
        [
          [0.0, 0.078],
          [0.15, 0.078],
          [0.3, 0.066],
          [THIGH + 0.01, 0.058],
        ],
        12,
      ).scale(limb, 1, limb),
      up,
      skin,
      0.25,
    );
    P.add(new THREE.SphereGeometry(0.06, 10, 8).scale(limb, 1, limb).translate(0, THIGH, 0), up, skin, 0.25);
    // 小腿：小腿肚、往腳踝收細；下面一截白襪（隊伍色滾邊），襪子一部分跟著腳（腳踩遠一點時小腿會拉長、不裂開）
    const shin = lathe(
      [
        [-0.01, 0.058],
        [0.1, 0.064],
        [0.22, 0.052],
        [SHIN - 0.11, 0.044],
        [SHIN - 0.1, 0.049],
        [SHIN - 0.02, 0.045],
        [SHIN + 0.03, 0.042],
      ],
      12,
    ).scale(limb, 1, limb);
    {
      const pos = shin.attributes.position;
      const col = paint(shin, skin).attributes.color as THREE.BufferAttribute;
      const cs = new THREE.Color(sock);
      const cb = new THREE.Color(o.band);
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i);
        if (y >= SHIN - 0.105) {
          const c = y < SHIN - 0.085 ? cb : cs;
          col.setXYZ(i, c.r, c.g, c.b);
        }
      }
    }
    P.add(shin, lo, null, 0.15, (_x, y) => (y > SHIN - 0.15 ? [ft, 0.6 * smooth((y - (SHIN - 0.15)) / 0.15)] : null));
    // 球鞋（腳掌座標：原點腳踝、Y 上、腳尖 -Z）：膠底（圓角）、白鞋面、翹起的鞋頭、鞋領、鞋舌、隊伍色側條、後跟片
    const soleY = -ANKLE;
    P.add(new THREE.CapsuleGeometry(0.048, 0.17, 2, 10).rotateX(Math.PI / 2).scale(1, 0.25, 1).translate(0, soleY + 0.012, -0.03), ft, 0xc9a070, 0.4); // 鞋底
    P.add(new THREE.CapsuleGeometry(0.046, 0.12, 3, 10).rotateX(Math.PI / 2).scale(1, 0.72, 1).translate(0, soleY + 0.047, -0.03), ft, white, 0.8); // 鞋身
    P.add(new THREE.SphereGeometry(0.04, 10, 8).scale(1.08, 0.72, 1.3).translate(0, soleY + 0.05, -0.115), ft, white, 0.8); // 鞋頭（略翹）
    P.add(new THREE.CylinderGeometry(0.044, 0.047, 0.04, 10, 1, true).translate(0, -0.006, 0.012), ft, white, 0.6); // 鞋領（包住腳踝）
    P.add(new THREE.BoxGeometry(0.034, 0.012, 0.07).rotateX(0.25).translate(0, soleY + 0.08, -0.06), ft, 0xe8e8e4, 0.5); // 鞋舌／鞋帶
    P.add(new THREE.BoxGeometry(0.066, 0.04, 0.02).translate(0, soleY + 0.038, 0.066), ft, 0x2a2a2e, 0.6); // 後跟片
    for (const s of [-1, 1]) P.add(new THREE.BoxGeometry(0.003, 0.014, 0.06).rotateX(-0.3).translate(s * 0.0465, soleY + 0.044, -0.035), ft, o.band, 0.6); // 側條
  };
  legParts(upLegL, lowLegL, footL);
  legParts(upLegR, lowLegR, footR);

  // ---------- 球拍：拍框合進身體（綁在右手），拍線另外一片半透明 ----------
  P.add(racketFrame(o.racketColor, o.racket), handR, null, 1);
  const strings = racketStrings(o.racket);
  handR.add(strings);

  // ---------- 蒙皮網格 ----------
  const texture = bodyTexture(o.shirt, o.accent, o.number);
  const geo = merge(P.geos);
  const skeleton = new THREE.Skeleton(list); // 用目前（綁定姿勢）的世界矩陣算反矩陣
  const mesh = new THREE.SkinnedMesh(geo, bodyMaterial(texture));
  mesh.bind(skeleton, new THREE.Matrix4()); // 幾何已經在 root 座標
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  mesh.frustumCulled = false; // 魚躍、弓步會伸出綁定姿勢的包圍球
  return { bones, list, ponytail, mesh, strings, texture, hipW, shoulderX };
}

/** 髮型＋頭帶（頂點色，綁在頭上）；馬尾綁在自己的骨頭上（會甩） */
function buildHair(P: Parts, head: THREE.Bone, ponytail: THREE.Bone | null, o: BodyOpts, C: THREE.Vector3): void {
  const hairC = o.hairColor;
  const kind = o.hair;
  // 半球（往後傾 tilt：蓋住頭頂與後腦，看得出臉朝哪），比頭略大、前後略長
  const dome = (r: number, tilt: number, cover: number, color: number, sx = 1, sy = 1, sz = 1.07, dz = 0) =>
    P.add(new THREE.SphereGeometry(r, 16, 9, 0, Math.PI * 2, 0, cover).scale(sx, sy, sz).rotateX(tilt).translate(C.x, C.y, C.z + dz), head, color, 0.45);
  // 從球心往 (polar a, azimuth b) 方向長出的錐（刺蝟頭）
  const m4 = new THREE.Matrix4();
  const qd = new THREE.Quaternion();
  const dir = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const one = new THREE.Vector3(1, 1, 1);
  const tmp = new THREE.Vector3();
  const spike = (a: number, az: number, len: number) => {
    dir.set(Math.sin(a) * Math.sin(az), Math.cos(a), Math.sin(a) * Math.cos(az));
    qd.setFromUnitVectors(up, dir);
    const g = new THREE.ConeGeometry(0.03, len, 5);
    g.applyMatrix4(m4.compose(tmp.copy(dir).multiplyScalar(0.1 + len / 2).add(C), qd, one));
    P.add(g, head, hairC, 0.45);
  };
  if (kind === 'buzz') {
    dome(0.115, 0.42, Math.PI * 0.5, hairC, 1, 1, 1.06);
  } else if (kind === 'spiky') {
    dome(0.119, 0.35, Math.PI / 2, hairC);
    spike(0.12, 0, 0.1);
    for (let i = 0; i < 6; i++) spike(0.6, (i / 6) * Math.PI * 2 + 0.3, 0.095);
    for (const az of [-1.4, -0.7, 0, 0.7, 1.4]) spike(1.08, az, 0.08);
    spike(0.95, Math.PI - 0.35, 0.075);
    spike(0.95, Math.PI + 0.35, 0.075);
  } else if (kind === 'undercut') {
    // 兩側、後腦削短（髮色混膚色的「青皮」），頭頂一撮往後梳的厚髮
    dome(0.113, 0.45, Math.PI * 0.5, mix(hairC, o.skin, 0.5), 1, 1, 1.06);
    dome(0.122, 0.12, Math.PI * 0.36, hairC, 0.9, 1.16, 1.2, 0.012);
  } else {
    // short／ponytail：頭頂與後腦的短髮＋瀏海
    dome(0.12, kind === 'ponytail' ? 0.42 : 0.5, Math.PI / 2, hairC);
    dome(0.121, -0.3, Math.PI * 0.3, hairC, 1, 0.9, 1.0, -0.004); // 瀏海
  }
  if (o.headband) {
    // 頭帶（隊伍色）：繞頭一圈，前高後低
    P.add(new THREE.TorusGeometry(0.112, 0.012, 6, 24).rotateX(Math.PI / 2).scale(1, 1, 1.06).rotateX(-0.12).translate(C.x, C.y + 0.012, C.z), head, o.band, 0.3);
  }
  if (ponytail) {
    // 髮圈（隊伍色）＋水滴形髮束（中段最粗、尾端收尖），掛點 = 馬尾骨頭原點、往 -Y 垂下
    P.add(new THREE.TorusGeometry(0.03, 0.012, 6, 10).rotateX(Math.PI / 2).translate(0, -0.02, 0), ponytail, o.band, 0.3);
    P.add(
      new THREE.LatheGeometry(
        [
          [0, -0.27],
          [0.012, -0.255],
          [0.03, -0.21],
          [0.044, -0.15],
          [0.05, -0.09],
          [0.044, -0.04],
          [0.026, -0.01],
          [0, 0],
        ].map(([x, y]) => new THREE.Vector2(x, y)),
        9,
      ).scale(1, 1, 0.8),
      ponytail,
      hairC,
      0.45,
    );
  }
}
