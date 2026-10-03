import * as THREE from 'three';
import type { Environment } from './environment';
import {
  blobShadows,
  canvasTexture,
  disposeWith,
  merge,
  paint,
  paintFaces,
  Parts,
  pathPlane,
  platform,
  rand,
  range,
  setSeed,
  sway,
  Wind,
  type Blob,
} from './envKit';

/**
 * 市場：球場擺在熱鬧的露天市場中間（白天、暖色調）。
 * 遠端：面向球場的一排攤位＋背對背的第二排，再後面是一排騎樓店面；兩側各一排攤位、後面也是店面；
 * 鏡頭前（直向時搖桿底下）是停好的機車、一箱箱蔬果和塑膠椅。
 * 條紋遮陽棚、手繪風招牌（只有色塊與圖案，沒有字）、紅燈籠、燈泡串、三角彩旗。
 * 所有不會動的東西合併成一個頂點色幾何（1 個 draw call）；會動的只有燈籠（每幀改矩陣）和彩旗（shader 擺動）。
 */

// 遮陽棚配色（主色、條紋色）
const CANOPY: [number, number][] = [
  [0xe2483d, 0xfff4e6], // 紅白
  [0x2f7fd0, 0xf4f8ff], // 藍白
  [0x34a35a, 0xf3fff0], // 綠白
  [0xf08a24, 0xfff1d6], // 橘白
  [0xf2c230, 0xfffbe8], // 黃白
  [0x1aa7a0, 0xeafffb], // 青白
  [0xe8578e, 0xfff0f5], // 粉白
  [0xd8402f, 0xf6c443], // 紅黃
];
const CLOTH = [0x3d6fb6, 0xc23b32, 0x2e8b57, 0xe0a030, 0x7a4fa0, 0xf2efe6];
// 蔬果：橘子、番茄、青菜、香蕉、茄子、西瓜、辣椒、芭樂、地瓜
const GOODS = [0xf28c28, 0xd8322a, 0x6fb43c, 0xf2d03b, 0x7b3f8c, 0x3f8f3a, 0xe85a3a, 0xa8c84a, 0x9a4f2e];
const WOOD = 0x8a5a36;
const CRATE = 0xa8743f;
const POLE = 0x5c5550;
const SKIN = [0xe8b994, 0xd09a70, 0xa8744e];
const SHIRT = [0x3b6fb0, 0xd94b3d, 0xf2f2f2, 0x4f9a5a, 0xf0b33a, 0x8a5cb0, 0x2b2b2b, 0xe86f9a, 0x6fc0d8];
const PANTS = [0x2c3440, 0x3e4a5c, 0x5a4a3a, 0x222222, 0x6a7a8a];
const WALLS = [0xf1e3c8, 0xd9e8d6, 0xf3d4cf, 0xf6e7a8, 0xcfe0ec, 0xe9d2b4, 0xf0efe8, 0xe3c7d8];
const SCOOTER = [0xd83a30, 0x2f6fc0, 0xf2f2f2, 0x7fc8b0, 0x1f1f1f, 0xf0c030, 0x9aa6b4];

const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)];

/** 招牌：位置（世界座標的矩陣）＋圖案編號 */
interface Sign {
  m: THREE.Matrix4;
  w: number;
  h: number;
  design: number;
}

export function market(): Environment {
  setSeed(23);
  const wind = new Wind(5);
  const group = new THREE.Group();
  group.add(paving(), platform(0xa49a8c), pathPlane(0xb9765a)); // 球場四周：紅磚色的水泥地

  const P = new Parts();
  const signs: Sign[] = [];
  const shadows: Blob[] = [];

  // ---- 遠端：第一排面向球場、第二排背對背面向後面的走道 ----
  for (let i = 0; i < 8; i++) {
    const x = -9.1 + i * 2.6;
    stall(P, x, -11.6, 0, signs, i !== 3);
    shadows.push({ x: x - 0.3, z: -11.9, r: 1.45 });
  }
  for (let i = 0; i < 9; i++) {
    const x = -10.4 + i * 2.6;
    stall(P, x, -13.65, Math.PI, null, true);
    shadows.push({ x: x - 0.3, z: -14.1, r: 1.45 });
  }
  // ---- 兩側：面向球場 ----
  for (let i = 0; i < 6; i++) {
    const z = -8.4 + i * 2.6;
    stall(P, -7.05, z, Math.PI / 2, signs, true);
    stall(P, 7.05, z, -Math.PI / 2, signs, true);
    shadows.push({ x: -7.0, z: z - 0.3, r: 1.4 }, { x: 6.7, z: z - 0.3, r: 1.4 });
  }
  // ---- 後面的騎樓店面 ----
  let x = -34;
  while (x < 34) {
    const w = range(4.2, 6.4);
    shophouse(P, x + w / 2, -19.6, 0, w, 2 + Math.floor(rand() * 2), signs);
    x += w + 0.05;
  }
  for (const side of [-1, 1]) {
    let z = -18.8;
    while (z < 9) {
      const w = range(4.2, 6.2);
      shophouse(P, side * 12.8, z + w / 2, (-side * Math.PI) / 2, w, 2 + Math.floor(rand() * 2), signs);
      z += w + 0.05;
    }
  }
  // ---- 走道上的大洋傘小吃攤 ----
  for (const [px, pz] of [
    [-10.2, -8.4],
    [10.0, -8.6],
    [-10.0, -2.5],
    [10.0, 1.5],
    [-10.0, 5.2],
    [-11.4, -16.9],
    [11.6, -16.8],
  ] as [number, number][]) {
    parasolCart(P, px, pz, range(0, Math.PI * 2));
    shadows.push({ x: px - 0.4, z: pz - 0.5, r: 1.5 });
  }
  // ---- 逛市場的人 ----
  const people: [number, number, number][] = [
    // 遠端攤位前（背對球場）
    [-7.6, -10.0, Math.PI],
    [-2.9, -9.95, Math.PI + 0.3],
    [3.2, -10.05, Math.PI - 0.2],
    [8.2, -9.95, Math.PI],
    // 後面走道
    [-11.0, -15.6, 0.4],
    [-6.4, -16.6, -1.2],
    [-2.2, -15.8, 2.6],
    [1.8, -17.1, 1.4],
    [5.6, -15.9, -2.2],
    [9.8, -16.8, 0.9],
    [-8.2, -17.6, 3.0],
    // 兩側攤位前（背對球場）
    [-5.65, -6.9, -Math.PI / 2],
    [-5.7, 1.2, -Math.PI / 2 + 0.3],
    [5.65, -4.4, Math.PI / 2],
    [5.7, 3.4, Math.PI / 2 - 0.2],
    // 兩側後面的走道
    [-9.6, -6.0, 0.2],
    [-10.4, 0.6, 2.2],
    [9.7, -5.2, -1.4],
    [10.6, 3.6, 2.8],
    [-10.0, 7.6, 1.0],
  ];
  for (const [px, pz, ry] of people) {
    P.at(px, pz, ry);
    person(P, 0, 0, rand() < 0.35);
    shadows.push({ x: px - 0.15, z: pz - 0.2, r: 0.42 });
  }
  // ---- 鏡頭前：機車、菜籃、塑膠椅 ----
  const scooters: [number, number, number][] = [
    // 側停成一排（從上面看得出車身側面）
    [-6.2, 10.25, 1.3],
    [-4.75, 10.15, 1.42],
    [-3.3, 10.3, 1.35],
    [3.3, 10.25, -1.38],
    [4.75, 10.15, -1.3],
    [6.2, 10.3, -1.42],
    // 兩側走道也停幾台
    [-9.4, -12.2, 1.5],
    [-8.9, 8.6, 0.3],
    [9.2, 7.8, -0.4],
    [9.6, -12.6, -1.6],
  ];
  for (const [px, pz, ry] of scooters) {
    P.at(px, pz, ry);
    scooter(P);
    shadows.push({ x: px - 0.1, z: pz - 0.15, r: 0.55 });
  }
  frontGoods(P);
  shadows.push({ x: -1.5, z: 10.0, r: 0.75 }, { x: 1.3, z: 10.05, r: 0.7 }, { x: -0.05, z: 10.05, r: 0.6 });

  // ---- 燈泡串＋燈籠＋彩旗 ----
  const deco = decorations(P, wind);

  const stallMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  group.add(blobShadows(shadows, 0.2), new THREE.Mesh(P.build(), stallMat));
  group.add(signMesh(signs), deco.wires, deco.bulbs, deco.lanterns, deco.bunting);

  return {
    group,
    background: 0xf3e3c6,
    fog: [0xf3e3c6, 26, 62],
    sky: 0xfff3df,
    ground: 0x8c7a66,
    sun: 0xffe6bf,
    sunDir: [-0.45, 1, -0.55], // 遮陽棚縫裡的午後陽光：仰角約 55°
    fill: [0xffe9cf, 0.7], // 棚子、地磚的暖色反射光
    update(dt) {
      wind.update(dt);
      deco.update();
    },
  };
}

/** 燈泡串、紅燈籠、三角彩旗（電線用 LineSegments，燈泡／燈籠各一個 InstancedMesh；柱子放進靜態道具） */
function decorations(Pp: Parts, wind: Wind) {
  // [x0, z0, x1, z1, 高度, 下垂, 彩旗?]
  const spans: [number, number, number, number, number, number, boolean][] = [];
  for (let i = 0; i < 3; i++) spans.push([-10.4 + i * 6.93, -10.05, -3.47 + i * 6.93, -10.05, 3.15, 0.35, false]);
  for (let i = 0; i < 5; i++) spans.push([-13 + i * 5.2, -17.3, -7.8 + i * 5.2, -17.3, 3.5, 0.4, true]);
  for (const sx of [-1, 1]) for (let i = 0; i < 3; i++) spans.push([sx * 5.55, -9.6 + i * 5.2, sx * 5.55, -4.4 + i * 5.2, 3.25, 0.25, false]);
  const wire: number[] = [];
  const bulbs: THREE.Vector3[] = [];
  const hangs: THREE.Vector3[] = [];
  const flags: number[] = [];
  const flagCol: number[] = [];
  const posts = new Set<string>();
  const FLAG = [0xe23d33, 0xf4c430, 0x2f7fd0, 0x3aa65a, 0xf08a24, 0xffffff, 0xe8578e];
  const c = new THREE.Color();
  for (const [x0, z0, x1, z1, h, sag, bunting] of spans) {
    const sy = (t: number) => h - sag * 4 * t * (1 - t);
    const L = Math.hypot(x1 - x0, z1 - z0);
    const dx = (x1 - x0) / L;
    const dz = (z1 - z0) / L;
    for (const [px, pz] of [
      [x0, z0],
      [x1, z1],
    ]) {
      const k = `${px.toFixed(2)},${pz.toFixed(2)}`;
      if (!posts.has(k)) {
        posts.add(k);
        Pp.at(px, pz).box(0.06, h + 0.1, 0.06, 0, (h + 0.1) / 2, 0, POLE);
      }
    }
    const SEG = 12;
    for (let i = 0; i < SEG; i++) {
      const a = i / SEG;
      const b = (i + 1) / SEG;
      wire.push(x0 + (x1 - x0) * a, sy(a), z0 + (z1 - z0) * a, x0 + (x1 - x0) * b, sy(b), z0 + (z1 - z0) * b);
    }
    const nb = Math.round(L / 0.5);
    for (let i = 1; i < nb; i++) {
      const t = i / nb;
      const p = new THREE.Vector3(x0 + (x1 - x0) * t, sy(t), z0 + (z1 - z0) * t);
      if (!bunting && i % 4 === 2) hangs.push(p);
      else bulbs.push(p);
    }
    if (bunting) {
      const nf = Math.round(L / 0.36);
      for (let i = 0; i < nf; i++) {
        const t = (i + 0.5) / nf;
        const px = x0 + (x1 - x0) * t;
        const pz = z0 + (z1 - z0) * t - 0.02;
        const py = sy(t) - 0.03;
        flags.push(px - dx * 0.14, py, pz - dz * 0.14, px, py - 0.32, pz, px + dx * 0.14, py, pz + dz * 0.14);
        c.set(FLAG[i % FLAG.length]);
        for (let k = 0; k < 3; k++) flagCol.push(c.r, c.g, c.b);
      }
    }
  }
  const wg = new THREE.BufferGeometry();
  wg.setAttribute('position', new THREE.Float32BufferAttribute(wire, 3));
  const wires = new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x3a3330 }));

  // 燈泡：白天也亮著的暖白小球
  const bulbMat = new THREE.MeshBasicMaterial({ color: 0xfff1c2 });
  const bulbMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.06, 0), bulbMat, bulbs.length);
  disposeWith(bulbMat, bulbMesh);
  const m = new THREE.Matrix4();
  bulbs.forEach((p, i) => bulbMesh.setMatrixAt(i, m.makeTranslation(p.x, p.y - 0.07, p.z)));

  // 彩旗：一個幾何，隨風飄（shader 擺動，不加 draw call）
  const fg = new THREE.BufferGeometry();
  fg.setAttribute('position', new THREE.Float32BufferAttribute(flags, 3));
  fg.setAttribute('color', new THREE.Float32BufferAttribute(flagCol, 3));
  fg.computeVertexNormals();
  const flagMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  sway(flagMat, wind, 0.04, 2.6, 0.035);
  const bunting = new THREE.Mesh(fg, flagMat);

  // 紅燈籠：原點 = 掛點；繩、金色上蓋、紅色燈身（橫向竹骨明暗）、下蓋、流蘇
  const lanGeo = merge([
    paint(new THREE.CylinderGeometry(0.008, 0.008, 0.08, 4).translate(0, -0.04, 0), 0x1c1410),
    paint(new THREE.CylinderGeometry(0.07, 0.085, 0.05, 10).translate(0, -0.105, 0), 0xd9a530),
    lanternBody(),
    paint(new THREE.CylinderGeometry(0.085, 0.07, 0.05, 10).translate(0, -0.575, 0), 0xd9a530),
    paint(new THREE.CylinderGeometry(0.012, 0.03, 0.16, 5).translate(0, -0.68, 0), 0xe0302a),
  ]);
  const lanMat = new THREE.MeshLambertMaterial({ vertexColors: true, emissive: 0x5a0c06 });
  const lanMesh = new THREE.InstancedMesh(lanGeo, lanMat, hangs.length);
  lanMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  disposeWith(lanMat, lanMesh);
  const phase = hangs.map(() => rand() * Math.PI * 2);
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const one = new THREE.Vector3(1, 1, 1);
  const place = () => {
    const t = wind.time.value;
    const g = wind.gust.value;
    for (let i = 0; i < hangs.length; i++) {
      const ph = phase[i];
      e.set(Math.sin(t * 1.1 + ph * 1.7) * 0.05, 0, Math.sin(t * 1.5 + ph) * 0.06 + g * 0.3 * (0.75 + 0.25 * Math.sin(t * 3.3 + ph)));
      lanMesh.setMatrixAt(i, m.compose(hangs[i], q.setFromEuler(e), one));
    }
    lanMesh.instanceMatrix.needsUpdate = true;
  };
  place();
  return { wires, bulbs: bulbMesh, lanterns: lanMesh, bunting, update: place };
}

/** 紅色燈身：頂點色做出一圈圈竹骨的明暗 */
function lanternBody(): THREE.BufferGeometry {
  const body = new THREE.SphereGeometry(0.17, 12, 10);
  body.scale(1, 1.25, 1);
  body.translate(0, -0.34, 0);
  const p = body.attributes.position;
  const a = new Float32Array(p.count * 3);
  const red = new THREE.Color(0xd8281e);
  for (let i = 0; i < p.count; i++) {
    const y = (p.getY(i) + 0.34) / 0.21; // -1..1
    const row = Math.round((y + 1) * 5);
    const v = (1 - 0.3 * y * y) * (row % 2 ? 0.85 : 1);
    a[i * 3] = red.r * v;
    a[i * 3 + 1] = red.g * v;
    a[i * 3 + 2] = red.b * v;
  }
  body.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return body;
}

/** 地面：灰色水泥地磚（canvas 貼圖重複鋪） */
function paving(): THREE.Mesh {
  const tex = canvasTexture(128, 128, (g) => {
    g.fillStyle = '#a39a8f';
    g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 900; i++) {
      const v = 140 + Math.floor(Math.random() * 40);
      g.fillStyle = `rgba(${v},${v - 6},${v - 14},0.35)`;
      g.fillRect(Math.random() * 128, Math.random() * 128, 2, 2);
    }
    g.fillStyle = '#857c72';
    g.fillRect(0, 0, 128, 3);
    g.fillRect(0, 64, 128, 3);
    g.fillRect(0, 0, 3, 64);
    g.fillRect(64, 64, 3, 64);
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(36, 36);
  tex.anisotropy = 8;
  const mat = new THREE.MeshLambertMaterial({ map: tex });
  disposeWith(mat, tex);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(90, 90), mat);
  m.rotation.x = -Math.PI / 2;
  return m;
}

/** 斜頂條紋棚（含前緣垂簾）：從 (zBack, yBack) 斜到 (zFront, yFront)，寬 w */
function canopy(P: Parts, w: number, zBack: number, yBack: number, zFront: number, yFront: number, ca: number, cb: number): void {
  const n = Math.max(4, Math.round(w / 0.33));
  const sw = w / n;
  const stripe = (cx: number) => (Math.floor((cx + w / 2) / sw + 1e-4) % 2 ? cb : ca);
  const L = Math.hypot(zFront - zBack, yFront - yBack);
  const roof = paintFaces(new THREE.BoxGeometry(w, 0.03, L, n, 1, 1), stripe);
  roof.rotateX(Math.atan2(yBack - yFront, zFront - zBack));
  roof.translate(0, (yBack + yFront) / 2, (zBack + zFront) / 2);
  P.raw(roof);
  const val = paintFaces(new THREE.BoxGeometry(w, 0.22, 0.02, n, 1, 1), stripe);
  val.translate(0, yFront - 0.11, zFront + 0.01);
  P.raw(val);
}

/**
 * 一個攤位（自己的座標：寬沿 x、客人那側是 +z）：攤台、四根柱子、條紋遮陽棚、
 * 木箱裡堆成小山的蔬果、後面的貨架、地上的竹籃、老闆。signs 不是 null 就在棚子前緣上方立一塊招牌。
 */
function stall(P: Parts, x: number, z: number, ry: number, signs: Sign[] | null, vendor: boolean): void {
  P.at(x, z, ry);
  const [ca, cb] = pick(CANOPY);
  P.box(2.2, 0.76, 0.72, 0, 0.38, 0.4, pick(CLOTH)); // 攤台（桌布）
  P.box(2.3, 0.05, 0.82, 0, 0.785, 0.4, WOOD);
  for (const sx of [-1.14, 1.14]) {
    P.box(0.06, 2.2, 0.06, sx, 1.1, 1.2, POLE);
    P.box(0.06, 2.58, 0.06, sx, 1.29, -0.85, POLE);
  }
  canopy(P, 2.6, -0.92, 2.58, 1.26, 2.18, ca, cb);
  // 攤台上三箱蔬果
  for (let i = 0; i < 3; i++) {
    const gx = -0.72 + i * 0.72;
    P.box(0.64, 0.14, 0.56, gx, 0.88, 0.42, CRATE);
    P.ball(0.27, gx, 0.96, 0.42, pick(GOODS), 1.15, 0.45, 0.95);
  }
  // 後面的貨架＋一排箱子
  P.box(2.1, 0.9, 0.36, 0, 0.45, -0.66, WOOD);
  for (let i = 0; i < 4; i++) P.ball(0.21, -0.78 + i * 0.52, 0.95, -0.66, pick(GOODS), 1.1, 0.5, 0.75, 0);
  // 前面地上的竹籃（有的放大顆西瓜）
  if (rand() < 0.7) {
    const bx = range(-0.8, 0.8);
    P.cyl(0.26, 0.2, 0.26, 8, bx, 0, 1.0, 0xb98a4a);
    P.ball(0.22, bx, 0.3, 1.0, pick(GOODS), 1, 0.5, 1);
  }
  if (rand() < 0.4) P.ball(0.2, range(-0.9, 0.9), 0.17, 1.05, 0x3a7a32, 1.15, 0.85, 0.9);
  if (vendor) person(P, range(-0.55, 0.55), -0.25, rand() < 0.4);
  if (signs) {
    // 棚子前緣上方的招牌：往後仰，正對鏡頭比較好看
    P.box(0.05, 0.42, 0.05, -0.5, 2.36, 1.05, 0x3a2a1c);
    P.box(0.05, 0.42, 0.05, 0.5, 2.36, 1.05, 0x3a2a1c);
    P.box(1.36, 0.5, 0.04, 0, 2.7, 1.04, 0x3a2a1c, -0.38);
    signs.push({ m: signFrame(x, z, ry, 0, 2.7, 1.07, -0.38), w: 1.26, h: 0.42, design: Math.floor(rand() * 8) });
  }
}

const _sm = new THREE.Matrix4();
/** 招牌平面的世界矩陣：先往後仰 tilt，再放到攤位座標 (lx, ly, lz)，再套攤位的位置與方向 */
function signFrame(x: number, z: number, ry: number, lx: number, ly: number, lz: number, tilt: number): THREE.Matrix4 {
  const m = new THREE.Matrix4().makeRotationY(ry).setPosition(x, 0, z);
  return m.multiply(_sm.makeTranslation(lx, ly, lz)).multiply(new THREE.Matrix4().makeRotationX(tilt));
}

/** 站著的人（自己的座標：面向 +z）。hat = 斗笠 */
function person(P: Parts, x: number, z: number, hat: boolean): void {
  const shirt = pick(SHIRT);
  const skin = pick(SKIN);
  P.box(0.3, 0.78, 0.2, x, 0.39, z, pick(PANTS));
  P.add(new THREE.CylinderGeometry(0.15, 0.17, 0.62, 7).translate(x, 1.08, z), shirt);
  P.box(0.08, 0.52, 0.1, x - 0.21, 1.1, z + 0.02, shirt, 0, 0, -0.12);
  P.box(0.08, 0.52, 0.1, x + 0.21, 1.1, z + 0.02, shirt, 0, 0, 0.12);
  P.ball(0.12, x, 1.52, z, skin);
  if (hat) P.add(new THREE.ConeGeometry(0.32, 0.17, 10).translate(x, 1.66, z), 0xdcc48c);
  else P.ball(0.125, x, 1.56, z - 0.02, rand() < 0.8 ? 0x241c18 : 0x8a8a8a, 1, 0.75, 1);
}

/** 停著的機車（自己的座標：車頭朝 +z） */
function scooter(P: Parts): void {
  const body = pick(SCOOTER);
  for (const wz of [-0.55, 0.55]) P.add(new THREE.CylinderGeometry(0.22, 0.22, 0.1, 10).rotateZ(Math.PI / 2).translate(0, 0.22, wz), 0x1e1e1e);
  P.box(0.32, 0.12, 0.8, 0, 0.36, 0.02, body); // 踏板
  P.box(0.4, 0.34, 0.66, 0, 0.56, -0.34, body); // 後車身
  P.box(0.32, 0.09, 0.58, 0, 0.77, -0.32, 0x1c1c1c); // 坐墊
  P.box(0.38, 0.6, 0.1, 0, 0.66, 0.5, body, -0.22); // 前擋
  P.box(0.06, 0.36, 0.06, 0, 0.98, 0.6, 0x2a2a2a);
  P.box(0.64, 0.05, 0.06, 0, 1.15, 0.6, 0x1c1c1c); // 把手
  P.box(0.16, 0.09, 0.07, 0, 1.06, 0.66, 0xfff2c8); // 大燈
  if (rand() < 0.5) P.box(0.34, 0.24, 0.3, 0, 0.95, -0.7, 0x2a2a2a); // 後箱
}

/** 鏡頭前中間：疊起來的蔬果箱、竹籃、紅色塑膠椅 */
function frontGoods(P: Parts): void {
  P.at(0, 10.15, 0.05);
  // 疊起來的蔬果箱
  for (const [bx, bz, lvl] of [
    [-1.75, 0, 0],
    [-1.1, 0.05, 0],
    [-1.42, -0.02, 1],
    [1.05, 0.1, 0],
    [1.7, 0.0, 0],
  ] as [number, number, number][]) {
    const y = lvl * 0.3;
    P.box(0.62, 0.3, 0.46, bx, y + 0.15, bz, CRATE);
    P.ball(0.25, bx, y + 0.32, bz, pick(GOODS), 1.15, 0.45, 0.85);
  }
  // 竹籃
  for (const [bx, bz, col] of [
    [-0.35, 0.15, 0x6fb43c],
    [0.35, -0.1, 0xf28c28],
  ] as [number, number, number][]) {
    P.cyl(0.3, 0.22, 0.32, 9, bx, 0, bz, 0xb98a4a);
    P.ball(0.27, bx, 0.36, bz, col, 1, 0.45, 1);
  }
  // 塑膠椅
  for (const [sx, sz, col] of [
    [2.4, -0.2, 0xd8322a],
    [-2.45, 0.25, 0x2f6fc0],
  ] as [number, number, number][]) {
    P.box(0.34, 0.05, 0.34, sx, 0.44, sz, col);
    for (const lx of [-0.13, 0.13]) for (const lz of [-0.13, 0.13]) P.box(0.04, 0.42, 0.04, sx + lx, 0.21, sz + lz, col);
  }
}

/** 大洋傘＋小吃推車（自己的座標） */
function parasolCart(P: Parts, x: number, z: number, ry: number): void {
  P.at(x, z, ry);
  const [ca, cb] = pick(CANOPY);
  // 推車
  P.box(1.3, 0.75, 0.7, 0, 0.55, 0, 0xd8d4cc);
  P.box(1.36, 0.06, 0.76, 0, 0.95, 0, 0x9aa0a6);
  P.box(1.0, 0.25, 0.04, 0, 1.12, -0.32, 0xc8e4f0); // 玻璃櫃
  for (const wx of [-0.5, 0.5]) P.add(new THREE.CylinderGeometry(0.17, 0.17, 0.06, 8).rotateX(Math.PI / 2).translate(wx, 0.17, 0.38), 0x2a2a2a);
  P.cyl(0.12, 0.12, 0.08, 8, -0.3, 0.98, 0.05, 0x8a8a8a); // 鍋
  // 洋傘：8 片交錯配色
  P.box(0.05, 2.35, 0.05, 0.75, 1.17, 0, 0x6a6a6a);
  const umb = paintFaces(new THREE.ConeGeometry(1.2, 0.45, 8, 1, true), (cx, _cy, cz) => {
    const k = Math.floor(((Math.atan2(cz, cx) + Math.PI) / (Math.PI * 2)) * 8 + 1e-3);
    return k % 2 ? cb : ca;
  });
  umb.translate(0.75, 2.45, 0);
  P.raw(umb);
  P.ball(0.05, 0.75, 2.72, 0, 0x6a6a6a, 1, 1, 1, 0);
  // 旁邊兩張塑膠椅
  for (const [sx, sz, col] of [
    [-0.4, 0.95, 0xd8322a],
    [0.6, 1.05, 0x2f6fc0],
  ] as [number, number, number][]) {
    P.box(0.34, 0.05, 0.34, sx, 0.44, sz, col);
    for (const lx of [-0.13, 0.13]) for (const lz of [-0.13, 0.13]) P.box(0.04, 0.42, 0.04, sx + lx, 0.21, sz + lz, col);
  }
}

/**
 * 騎樓店面（自己的座標：店面在 z=0、面向 +z，房子往 -z 延伸）：一樓店面＋條紋雨遮＋招牌，
 * 樓上窗戶、陽台、冷氣、直立招牌、屋頂水塔。
 */
function shophouse(P: Parts, x: number, z: number, ry: number, w: number, floors: number, signs: Sign[]): void {
  P.at(x, z, ry);
  const wall = pick(WALLS);
  const G = 3.0; // 一樓高
  const F = 2.7; // 樓上每層
  const H = G + (floors - 1) * F;
  P.box(w, H, 6, 0, H / 2, -3, wall);
  P.box(w + 0.1, 0.18, 6.1, 0, H + 0.09, -3, 0xbdb5aa); // 女兒牆頂
  // 一樓：暗色店內＋捲起來的鐵捲門＋店內貨架
  P.box(w - 0.6, 2.35, 0.06, 0, 1.18, 0.03, 0x3b3430);
  P.box(w - 0.6, 0.32, 0.16, 0, 2.5, 0.08, 0x9aa0a6);
  P.box(w - 1.0, 0.9, 0.5, 0, 0.45, 0.3, CRATE);
  for (let i = 0; i < 3; i++) P.ball(0.24, -w / 3 + (i * w) / 3, 0.95, 0.3, pick(GOODS), 1.2, 0.5, 0.9, 0);
  const [ca, cb] = pick(CANOPY);
  canopy(P, w - 0.2, 0.05, 2.95, 1.35, 2.55, ca, cb);
  // 雨遮上方的橫招牌
  P.box(w * 0.7, 0.62, 0.05, 0, 3.35, 0.04, 0x3a2a1c);
  signs.push({ m: signFrame(x, z, ry, 0, 3.35, 0.075, 0), w: w * 0.7 - 0.1, h: 0.52, design: Math.floor(rand() * 8) });
  // 樓上
  const n = Math.max(1, Math.floor(w / 1.7));
  for (let f = 1; f < floors; f++) {
    const y0 = G + (f - 1) * F;
    P.box(w - 0.3, 0.12, 0.7, 0, y0 + 0.06, 0.35, 0xd8d2c8);
    P.box(w - 0.3, 0.55, 0.05, 0, y0 + 0.39, 0.68, rand() < 0.5 ? 0x5a6470 : 0xe8e4dc);
    for (let j = 0; j < n; j++) {
      const wx = -w / 2 + ((j + 0.5) * w) / n;
      P.box(1.0, 1.3, 0.06, wx, y0 + 1.35, 0.03, 0xf2efe8);
      P.box(0.82, 1.1, 0.08, wx, y0 + 1.35, 0.04, 0x41566b);
      if (rand() < 0.45) P.box(0.7, 0.45, 0.32, wx + (j % 2 ? -0.62 : 0.62), y0 + 2.2, 0.17, 0xe8e8e8);
    }
  }
  if (rand() < 0.55) P.box(0.12, 1.7, 0.6, w / 2 - 0.35, G + 1.3, 0.4, pick([0xd8322a, 0xf2c230, 0x2f7fd0, 0x2e8b57]));
  if (rand() < 0.6) P.cyl(0.45, 0.45, 0.95, 8, range(-w / 4, w / 4), H + 0.18, -2.8, rand() < 0.5 ? 0xb8c0c8 : 0x3f6fa8);
}

/** 所有招牌合成一個幾何，共用一張圖案貼圖（4×2 格） */
function signMesh(list: Sign[]): THREE.Mesh {
  const parts = list.map((s) => {
    const g = new THREE.PlaneGeometry(s.w, s.h);
    const uv = g.attributes.uv;
    const u0 = (s.design % 4) / 4;
    const v0 = 1 - (Math.floor(s.design / 4) + 1) / 2;
    for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + uv.getX(i) * 0.25, v0 + uv.getY(i) * 0.5);
    return g.applyMatrix4(s.m);
  });
  const tex = signAtlas();
  tex.anisotropy = 4;
  const mat = new THREE.MeshLambertMaterial({ map: tex });
  disposeWith(mat, tex);
  return new THREE.Mesh(merge(parts), mat);
}

/** 手繪風招牌：底色＋邊框＋簡單圖案（水果、魚、碗、紅蘿蔔、西瓜、茶壺、星星、包子），沒有任何文字 */
function signAtlas(): THREE.CanvasTexture {
  const bgs = ['#d9322b', '#f2c230', '#2f6fb8', '#2f9a52', '#fff3dc', '#f07f2a', '#1f1f1f', '#e8578e'];
  const ink = ['#fff3dc', '#c0301e', '#fff3dc', '#fff3dc', '#2f9a52', '#fff3dc', '#f2c230', '#fff3dc'];
  return canvasTexture(512, 128, (g) => {
    for (let i = 0; i < 8; i++) {
      g.save();
      g.translate((i % 4) * 128, Math.floor(i / 4) * 64);
      g.fillStyle = bgs[i];
      g.fillRect(0, 0, 128, 64);
      g.strokeStyle = ink[i];
      g.lineWidth = 3;
      g.strokeRect(5, 5, 118, 54);
      // 右邊幾塊圓角色塊（像畫上去的裝飾，不是字）
      g.fillStyle = ink[i];
      for (let k = 0; k < 3; k++) g.fillRect(64 + k * 18, 22 + (k % 2) * 4, 13, 20 - (k % 2) * 6);
      g.fillRect(64, 47, 50, 3);
      icon(g, i);
      g.restore();
    }
  });
}

function icon(g: CanvasRenderingContext2D, i: number): void {
  const cx = 34;
  const cy = 32;
  const circle = (x: number, y: number, r: number, c: string) => {
    g.fillStyle = c;
    g.beginPath();
    g.arc(x, y, r, 0, Math.PI * 2);
    g.fill();
  };
  switch (i) {
    case 0: // 橘子
      circle(cx, cy + 2, 15, '#f7a128');
      g.fillStyle = '#3f9a3a';
      g.beginPath();
      g.ellipse(cx + 6, cy - 14, 8, 4, -0.5, 0, Math.PI * 2);
      g.fill();
      break;
    case 1: // 魚
      g.fillStyle = '#2f6fb8';
      g.beginPath();
      g.ellipse(cx, cy, 18, 9, 0, 0, Math.PI * 2);
      g.fill();
      g.beginPath();
      g.moveTo(cx + 14, cy);
      g.lineTo(cx + 26, cy - 9);
      g.lineTo(cx + 26, cy + 9);
      g.fill();
      circle(cx - 9, cy - 2, 2.5, '#fff');
      break;
    case 2: // 冒煙的碗
      g.fillStyle = '#fff3dc';
      g.beginPath();
      g.arc(cx, cy + 2, 17, 0, Math.PI);
      g.fill();
      g.strokeStyle = '#fff3dc';
      g.lineWidth = 2.5;
      for (let k = -1; k <= 1; k++) {
        g.beginPath();
        g.moveTo(cx + k * 7, cy - 3);
        g.bezierCurveTo(cx + k * 7 - 5, cy - 9, cx + k * 7 + 5, cy - 13, cx + k * 7, cy - 19);
        g.stroke();
      }
      break;
    case 3: // 紅蘿蔔
      g.fillStyle = '#f27a1a';
      g.beginPath();
      g.moveTo(cx - 10, cy - 10);
      g.lineTo(cx + 10, cy - 10);
      g.lineTo(cx, cy + 20);
      g.fill();
      g.fillStyle = '#b8f070';
      g.fillRect(cx - 6, cy - 20, 4, 10);
      g.fillRect(cx + 2, cy - 22, 4, 12);
      break;
    case 4: // 西瓜片
      g.fillStyle = '#2f9a52';
      g.beginPath();
      g.arc(cx, cy - 6, 20, 0, Math.PI);
      g.fill();
      g.fillStyle = '#e8403a';
      g.beginPath();
      g.arc(cx, cy - 6, 16, 0, Math.PI);
      g.fill();
      for (let k = -2; k <= 2; k++) circle(cx + k * 6, cy + 1 + Math.abs(k), 1.6, '#222');
      break;
    case 5: // 茶壺
      circle(cx, cy + 3, 14, '#7a3f1e');
      g.fillStyle = '#7a3f1e';
      g.fillRect(cx - 5, cy - 15, 10, 6);
      g.beginPath();
      g.moveTo(cx + 12, cy);
      g.lineTo(cx + 24, cy - 10);
      g.lineTo(cx + 22, cy - 4);
      g.lineTo(cx + 13, cy + 8);
      g.fill();
      break;
    case 6: // 星星＋紅圈
      circle(cx, cy, 17, '#d9322b');
      g.fillStyle = '#f2c230';
      g.beginPath();
      for (let k = 0; k < 10; k++) {
        const r = k % 2 ? 5 : 12;
        const a = (k / 10) * Math.PI * 2 - Math.PI / 2;
        g.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
      }
      g.fill();
      break;
    default: // 蒸籠裡的包子
      g.fillStyle = '#b8864a';
      g.fillRect(cx - 22, cy + 4, 44, 12);
      circle(cx - 12, cy + 2, 8, '#fffaf0');
      circle(cx + 2, cy + 1, 8, '#fffaf0');
      circle(cx + 15, cy + 3, 7, '#fffaf0');
  }
}
