import * as THREE from 'three';
import type { Environment } from './environment';
import {
  blobShadows,
  disposeWith,
  flyingBirds,
  GLSL_NOISE,
  paintFaces,
  Parts,
  rand,
  range,
  sakuraGrove,
  setSeed,
  sway,
  Wind,
  type Blob,
  type Spot,
} from './envKit';

/**
 * 稻田：球場在一塊墊高的土台上，四周是灌了水的水田（黃昏前的暖光）。
 * 一排排秧苗（InstancedMesh，風吹過去會一波一波地擺）、倒映天空的水面（shader：菲涅耳＋細碎漣漪）、
 * 田埂與通往農舍的土路、農舍與樹、稻草人、站在田裡啄食的白鷺、偶爾飛過的白鷺。
 */

const WATER_Y = -0.42; // 水面高度（球場在 0）
// 土台：上緣與下緣。盡量窄（球員最遠跑到 |x| 3.6、|z| 8.2），直向手機時球場旁邊才看得到稻田
const MOUND = { x: 5.2, zNear: 8.95, zFar: -8.95, bx: 5.5, bzNear: 9.25, bzFar: -9.25 };
// 農舍前的院子（墊高的土埕）
const YARD = { x0: 2.0, x1: 9.6, z0: -19.6, z1: -14.0 };
// 田埂：沿 z 的直線（x 座標）、沿 x 的直線（z 座標）
const RIDGE_X = [-34, -23, -13.5, -MOUND.bx, MOUND.bx, 14, 24, 34];
const RIDGE_Z = [-46, -34, -25, -19.6, -14.0, MOUND.bzFar, MOUND.bzNear, 18, 30];
const PATH_W = 1.1; // 中間那條土路（x = 0）

export function paddy(): Environment {
  setSeed(31);
  const wind = new Wind(4);
  const group = new THREE.Group();
  // 球場四周的土路（比其他場地的小徑窄一點）
  const path = new THREE.Mesh(new THREE.PlaneGeometry(10.0, 17.6), new THREE.MeshLambertMaterial({ color: 0xb59a6a }));
  path.rotation.x = -Math.PI / 2;
  path.position.y = 0.001;
  group.add(water(wind), mound(), path);

  const P = new Parts();
  const shadows: Blob[] = [];
  ridges(P);
  farmhouse(P, shadows);

  // 樹：農舍旁、遠處的樹林、兩側遠角
  const treeSpots: Spot[] = [
    { x: 9.0, z: -15.4 },
    { x: 2.9, z: -19.0 },
    { x: 8.6, z: -19.2 },
    { x: -9.5, z: -27.5 },
    { x: -3.5, z: -29.0 },
    { x: 5.5, z: -28.0 },
    { x: 13.0, z: -26.5 },
    { x: -17.0, z: -21.0 },
    { x: 19.5, z: -15.0 },
    { x: -21.0, z: -8.0 },
    { x: -15.5, z: -31.0 },
    { x: 18.0, z: -32.0 },
  ];
  const grove = sakuraGrove(treeSpots, [0x5f9e46, 0x6aa84f, 0x4f8a3a, 0x7cb35a], 0x5b4636, wind);
  for (const s of grove.shadows) shadows.push(s);
  // 樹跟院子一樣站在 y = -0.1；不在院子裡的樹底下墊一塊長草的小土墩
  grove.trunks.position.y = grove.blobs.position.y = -0.1;
  for (const t of treeSpots) {
    const inYard = t.x > YARD.x0 && t.x < YARD.x1 && t.z > YARD.z0 && t.z < YARD.z1;
    if (!inYard) P.at(t.x, t.z).cyl(1.0, 1.25, 0.6, 9, 0, -0.7, 0, 0x6f9444);
  }

  const rice = riceField(wind, treeSpots);
  const scare = scarecrows(wind);
  const egrets = standingEgrets();
  const flyers = flyingBirds(
    [
      // 低低地飛過田上（鏡頭往下看，太高會出畫面）
      { cx: -4.0, cz: -15.5, r: 4.0, y: 2.2, speed: 3.0, dir: 1, phase: 0 },
      { cx: -4.0, cz: -15.5, r: 4.6, y: 2.5, speed: 3.0, dir: 1, phase: 0.45 },
      { cx: 12.5, cz: -4.0, r: 4.0, y: 2.8, speed: 2.8, dir: -1, phase: 2.0 },
    ],
    { body: 0xf8f8f4, wing: 0xf4f4ee, tip: 0xe8e8e0, beak: 0xe8b830 },
    1.25,
    wind,
  );

  const staticMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const shade = blobShadows(shadows, 0.18);
  shade.position.y = -0.1; // 貼在院子／土墩上
  group.add(
    shade,
    new THREE.Mesh(P.build(), staticMat),
    grove.trunks,
    grove.blobs,
    rice,
    scare,
    egrets.mesh,
    flyers.mesh,
  );

  return {
    group,
    background: 0xefdcb4,
    fog: [0xefdcb4, 26, 72],
    sky: 0xfff0d4,
    ground: 0x5d6b3a,
    sun: 0xffdcaa,
    update(dt) {
      wind.update(dt);
      egrets.update(wind.time.value);
      flyers.update();
    },
  };
}

/** 水面：一大片平面；倒映天空（越斜看越亮）、微風吹出的細碎漣漪 */
function water(wind: Wind): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(200, 200);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, WATER_Y, -30);
  const mat = new THREE.MeshLambertMaterial({ color: 0x4f6236 });
  const skyLow = { value: new THREE.Color(0x6a9cb0) }; // 近處：偏藍的天色
  const skyHigh = { value: new THREE.Color(0xd2e2e4) }; // 遠處斜看：亮的天空反光
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.wTime = wind.time;
    sh.uniforms.wSkyLow = skyLow;
    sh.uniforms.wSkyHigh = skyHigh;
    sh.vertexShader = 'varying vec2 vWater;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvWater = position.xz;');
    sh.fragmentShader =
      'uniform float wTime;\nuniform vec3 wSkyLow;\nuniform vec3 wSkyHigh;\nvarying vec2 vWater;\n' +
      GLSL_NOISE +
      sh.fragmentShader.replace(
        '#include <opaque_fragment>',
        /* glsl */ `{
		// 菲涅耳：越斜看越像鏡子；漣漪讓倒影一點一點地閃
		float fres = pow( 1.0 - clamp( dot( normalize( vViewPosition ), normal ), 0.0, 1.0 ), 1.5 );
		float rip = kNoise( vWater * 1.4 + vec2( wTime * 0.22, wTime * 0.15 ) ) + 0.5 * kNoise( vWater * 3.3 - vec2( wTime * 0.35, -wTime * 0.28 ) );
		vec3 refl = mix( wSkyLow, wSkyHigh, smoothstep( 0.12, 0.5, fres ) ) * ( 0.84 + 0.2 * rip );
		outgoingLight = mix( outgoingLight, refl, 0.3 + 0.55 * fres );
	}
	#include <opaque_fragment>`,
      );
  };
  mat.customProgramCacheKey = () => 'paddyWater1';
  return new THREE.Mesh(geo, mat);
}

/** 墊高的土台：上面是草（球場與土路鋪在上面）、側面從草色漸層到泥土 */
function mound(): THREE.Mesh {
  const geo = new THREE.BoxGeometry(1, 1, 1);
  const p = geo.attributes.position;
  const col = new Float32Array(p.count * 3);
  const top = new THREE.Color(0x76a04a);
  const bot = new THREE.Color(0x6a5638);
  for (let i = 0; i < p.count; i++) {
    const up = p.getY(i) > 0;
    const sx = Math.sign(p.getX(i));
    const near = p.getZ(i) > 0;
    const z = near ? (up ? MOUND.zNear : MOUND.bzNear) : up ? MOUND.zFar : MOUND.bzFar;
    p.setXYZ(i, sx * (up ? MOUND.x : MOUND.bx), up ? -0.008 : WATER_Y - 0.3, z);
    const c = up ? top : bot;
    col[i * 3] = c.r;
    col[i * 3 + 1] = c.g;
    col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
}

/** 田埂（草頂、泥側）與中間的土路 */
function ridges(P: Parts): void {
  P.at(0, 0);
  const GRASS = 0x7da04e;
  const MUD = 0x6e5a3c;
  const DIRT = 0xb09468;
  const ridge = (x0: number, x1: number, z0: number, z1: number, topY: number, topCol: number) => {
    const w = x1 - x0;
    const d = z1 - z0;
    const h = topY - (WATER_Y - 0.3);
    const g = paintFaces(new THREE.BoxGeometry(w, h, d), (_x, cy) => (cy > h / 2 - 0.01 ? topCol : MUD));
    g.translate((x0 + x1) / 2, topY - h / 2, (z0 + z1) / 2);
    P.raw(g);
  };
  const W = 0.21;
  const zMin = RIDGE_Z[0];
  const zMax = RIDGE_Z[RIDGE_Z.length - 1];
  // 沿 z 的田埂：土台那段、院子那段要跳過
  for (const x of RIDGE_X) {
    const cuts: [number, number][] = [];
    if (Math.abs(x) <= MOUND.bx + 0.01) cuts.push([MOUND.bzFar, MOUND.bzNear]);
    if (x > YARD.x0 && x < YARD.x1) cuts.push([YARD.z0, YARD.z1]);
    let z = zMin;
    for (const [a, b] of cuts.sort((p, q) => p[0] - q[0])) {
      if (a > z) ridge(x - W, x + W, z, a, -0.24, GRASS);
      z = b;
    }
    if (z < zMax) ridge(x - W, x + W, z, zMax, -0.24, GRASS);
  }
  // 沿 x 的田埂
  for (const z of RIDGE_Z) {
    const cuts: [number, number][] = [[-PATH_W / 2, PATH_W / 2]];
    if (z >= MOUND.bzFar - 0.01 && z <= MOUND.bzNear + 0.01) cuts.push([-MOUND.bx, MOUND.bx]);
    if (z >= YARD.z0 - 0.01 && z <= YARD.z1 + 0.01) cuts.push([YARD.x0, YARD.x1]);
    let x = RIDGE_X[0];
    for (const [a, b] of cuts.sort((p, q) => p[0] - q[0])) {
      if (a > x) ridge(x, a, z - W, z + W, -0.24, GRASS);
      x = Math.max(x, b);
    }
    if (x < RIDGE_X[RIDGE_X.length - 1]) ridge(x, RIDGE_X[RIDGE_X.length - 1], z - W, z + W, -0.24, GRASS);
  }
  // 中間的土路：從土台兩端延伸出去；遠端有一條小岔路通往農舍院子
  ridge(-PATH_W / 2, PATH_W / 2, zMin, MOUND.bzFar + 0.05, -0.1, DIRT);
  ridge(-PATH_W / 2, PATH_W / 2, MOUND.bzNear - 0.05, zMax, -0.1, DIRT);
  ridge(PATH_W / 2 - 0.05, YARD.x0 + 0.05, -17.2, -16.3, -0.1, DIRT);
}

/** 秧苗：每格水田各自的行向、間距、高矮；整片一個 InstancedMesh，跟著風一波一波擺 */
function riceField(wind: Wind, avoid: Spot[]): THREE.InstancedMesh {
  // 一叢秧苗：6 片細長的葉子往外斜
  const pos: number[] = [];
  const col: number[] = [];
  const base = new THREE.Color(0x3c6620);
  const tip = new THREE.Color(0xa6cc58);
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2 + rand() * 0.7;
    const lean = range(0.18, 0.5);
    const h = range(0.78, 1.0);
    const ca = Math.cos(a);
    const sa = Math.sin(a);
    const w = 0.06;
    const px = -sa * w;
    const pz = ca * w;
    const tx = ca * Math.sin(lean) * h;
    const tz = sa * Math.sin(lean) * h;
    pos.push(ca * 0.02 - px, 0, sa * 0.02 - pz, ca * 0.02 + px, 0, sa * 0.02 + pz, tx, Math.cos(lean) * h, tz);
    col.push(base.r, base.g, base.b, base.r, base.g, base.b, tip.r, tip.g, tip.b);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();

  // 先算出所有秧苗位置
  const spots: number[] = []; // x, z, scale, r, g, b
  const zs = RIDGE_Z;
  const xs = [...RIDGE_X, 0].sort((a, b) => a - b);
  for (let j = 0; j + 1 < zs.length; j++) {
    for (let i = 0; i + 1 < xs.length; i++) {
      const x0 = xs[i];
      const x1 = xs[i + 1];
      const z0 = zs[j];
      const z1 = zs[j + 1];
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      if (Math.abs(cx) < MOUND.bx && cz > MOUND.bzFar && cz < MOUND.bzNear) continue; // 土台
      if (rand() < 0.08) continue; // 少數幾格還沒插秧，只有水（倒映天空）
      const alongZ = rand() < 0.6;
      const rowGap = range(0.46, 0.56);
      const step = range(0.36, 0.42);
      // 每格的稻子長得不一樣：大多是綠油油的，有的剛插秧（矮、嫩綠），有的開始轉黃
      const kind = rand();
      const sc = kind < 0.15 ? range(0.7, 0.85) : range(0.95, 1.3);
      const v = range(0.88, 1.08);
      const [tr, tg, tb] = kind < 0.15 ? [0.95 * v, 1.1 * v, 0.85 * v] : kind > 0.84 ? [1.3 * v, 1.12 * v, 0.55 * v] : [v, v * 0.99, v * 0.92];
      const inset = (e: number) => (Math.abs(e) < 0.01 ? PATH_W / 2 + 0.2 : 0.38);
      const ax0 = x0 + inset(x0);
      const ax1 = x1 - inset(x1);
      const az0 = z0 + 0.38;
      const az1 = z1 - 0.38;
      const [u0, u1, v0, v1] = alongZ ? [ax0, ax1, az0, az1] : [az0, az1, ax0, ax1];
      for (let u = u0; u <= u1; u += rowGap) {
        for (let v = v0; v <= v1; v += step) {
          const x = (alongZ ? u : v) + range(-0.06, 0.06);
          const z = (alongZ ? v : u) + range(-0.06, 0.06);
          // 只種看得到的地方：遠過 z=-34 看不到；兩側照橫向鏡頭的視野收窄
          if (z < -34 || z > 13.5 || Math.abs(x) > 14.5 - 0.68 * z) continue;
          if (x > YARD.x0 - 0.3 && x < YARD.x1 + 0.3 && z > YARD.z0 - 0.3 && z < YARD.z1 + 0.3) continue;
          if (Math.abs(x) < MOUND.bx + 0.2 && z > MOUND.bzFar - 0.2 && z < MOUND.bzNear + 0.15) continue;
          if (avoid.some((a) => Math.abs(a.x - x) < 1.45 && Math.abs(a.z - z) < 1.45)) continue;
          spots.push(x, z, sc * range(0.88, 1.12), tr, tg, tb);
        }
      }
    }
  }
  const n = spots.length / 6;
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  sway(mat, wind, 0.26, WATER_Y, 0.006);
  const mesh = new THREE.InstancedMesh(geo, mat, n);
  disposeWith(mat, mesh);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const k = i * 6;
    const sc = spots[k + 2];
    e.set(0, rand() * Math.PI * 2, 0);
    m.compose(p.set(spots[k], WATER_Y - 0.03, spots[k + 1]), q.setFromEuler(e), s.set(sc, sc * 0.62, sc));
    mesh.setMatrixAt(i, m);
    const jit = 0.95 + rand() * 0.1;
    mesh.setColorAt(i, c.setRGB(spots[k + 3] * jit, spots[k + 4] * jit, spots[k + 5] * jit));
  }
  return mesh;
}

/** 農舍：院子（墊高的土埕）、白牆、紅瓦斜屋頂、門窗、簷下木柱、稻草堆、水缸、柴堆 */
function farmhouse(P: Parts, shadows: Blob[]): void {
  const cx = (YARD.x0 + YARD.x1) / 2;
  const cz = (YARD.z0 + YARD.z1) / 2;
  // 院子
  P.at(cx, cz);
  P.raw(paintFaces(new THREE.BoxGeometry(YARD.x1 - YARD.x0, 0.7, YARD.z1 - YARD.z0), (_x, cy) => (cy > 0.34 ? 0xb8a074 : 0x6e5a3c)).translate(0, -0.1 - 0.35, 0));
  // 房子（面向球場，稍微斜一點）
  const hx = 5.9;
  const hz = -17.4;
  P.at(hx, hz, -0.18, -0.1);
  const W = 4.6;
  const D = 3.2;
  const WALL = 0xeee4cf;
  P.box(W, 2.2, D, 0, 1.1, 0, WALL);
  P.box(W + 0.1, 0.25, D + 0.1, 0, 0.12, 0, 0x8a7a66); // 牆腳
  // 屋頂：三角柱（CylinderGeometry 3 邊），頂點朝上、沿 x 擺
  const roof = new THREE.CylinderGeometry(1, 1, W + 0.7, 3, 1, false, Math.PI / 2);
  roof.rotateZ(Math.PI / 2);
  roof.scale(1, 1.25 / 1.5, (D + 1.1) / Math.sqrt(3));
  roof.translate(0, 2.2 + 0.42, 0);
  P.add(roof, 0xa4482f);
  P.box(W + 0.75, 0.08, 0.12, 0, 3.5, 0, 0x7a3020); // 屋脊
  // 門、窗
  P.box(0.95, 1.7, 0.06, -0.6, 0.95, D / 2 + 0.02, 0x5a3a24);
  P.box(0.9, 0.7, 0.06, 1.3, 1.3, D / 2 + 0.02, 0x3a4450);
  P.box(1.0, 0.08, 0.1, 1.3, 0.92, D / 2 + 0.04, 0x8a5a36);
  // 簷下木柱
  for (const px of [-W / 2 + 0.15, W / 2 - 0.15]) P.box(0.12, 2.3, 0.12, px, 1.15, D / 2 + 0.4, 0x7a5232);
  // 屋旁：稻草堆、水缸、柴堆、竹籃
  P.at(hx, hz, -0.18, -0.1);
  P.add(new THREE.ConeGeometry(0.75, 1.5, 9).translate(W / 2 + 1.1, 0.75, 0.9), 0xd9b45a);
  P.add(new THREE.CylinderGeometry(0.85, 0.85, 0.3, 9).translate(W / 2 + 1.1, 0.15, 0.9), 0xc9a24a);
  P.cyl(0.32, 0.26, 0.6, 9, -W / 2 - 0.6, 0, 1.0, 0x6a4a3a);
  P.cyl(0.33, 0.33, 0.04, 9, -W / 2 - 0.6, 0.6, 1.0, 0x3a5a70);
  for (let i = 0; i < 4; i++) P.box(1.3, 0.14, 0.14, -W / 2 - 0.55, 0.08 + i * 0.13, -0.9 + (i % 2) * 0.05, 0x8a6040);
  P.cyl(0.25, 0.2, 0.25, 8, 0.4, 0, D / 2 + 1.2, 0xb98a4a);
  shadows.push({ x: hx - 0.6, z: hz - 0.8, r: 3.0 }, { x: hx + W / 2 + 0.9, z: hz + 0.6, r: 1.0 });
}

/** 稻草人：一根竿子、橫木、舊衣服、麻布頭、斗笠；材質跟著風輕輕晃 */
function scarecrows(wind: Wind): THREE.Mesh {
  const P = new Parts();
  for (const [x, z, ry, shirt] of [
    [-3.2, -12.9, 0.3, 0x4f6fa8],
    [-11.5, -5.5, 0.9, 0xb8463a],
    [11.8, 3.5, -0.7, 0x5a8a4a],
  ] as [number, number, number, number][]) {
    P.at(x, z, ry, WATER_Y - 0.15);
    P.box(0.07, 2.25, 0.07, 0, 1.12, 0, 0x7a5a3a);
    P.box(1.5, 0.06, 0.06, 0, 1.55, 0, 0x7a5a3a);
    P.box(0.5, 0.62, 0.24, 0, 1.38, 0, shirt);
    P.box(1.15, 0.17, 0.17, 0, 1.56, 0, shirt);
    P.box(0.46, 0.18, 0.22, 0, 1.0, 0, 0x6a5040); // 褲頭
    for (const sx of [-0.7, 0.7]) P.add(new THREE.ConeGeometry(0.09, 0.22, 5).rotateZ((sx > 0 ? -1 : 1) * Math.PI / 2).translate(sx, 1.56, 0), 0xe0c070);
    P.ball(0.17, 0, 1.86, 0, 0xd9c7a0);
    P.add(new THREE.ConeGeometry(0.42, 0.22, 10).translate(0, 2.06, 0), 0xdcc48c);
  }
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  sway(mat, wind, 0.012, WATER_Y + 0.4, 0);
  return new THREE.Mesh(P.build(), mat);
}

/** 站在田裡的白鷺：慢慢走、偶爾低頭啄食（每幀更新幾個 instance 矩陣） */
function standingEgrets(): { mesh: THREE.InstancedMesh; update(t: number): void } {
  const P = new Parts();
  const WHITE = 0xf6f6f0;
  P.at(0, 0);
  P.ball(0.16, 0, 0.55, 0, WHITE, 0.75, 0.72, 1.55);
  P.box(0.05, 0.32, 0.05, 0, 0.76, 0.2, WHITE, 0.45);
  P.box(0.045, 0.24, 0.045, 0, 0.95, 0.24, WHITE, -0.35);
  P.ball(0.058, 0, 1.07, 0.29, WHITE, 0.9, 0.9, 1.3, 0);
  P.add(new THREE.ConeGeometry(0.02, 0.17, 4).rotateX(Math.PI / 2).translate(0, 1.06, 0.43), 0xe8b830);
  P.box(0.14, 0.04, 0.24, 0, 0.53, -0.28, WHITE, 0.35);
  for (const lx of [-0.045, 0.045]) P.box(0.022, 0.44, 0.022, lx, 0.22, 0, 0x2a2a2a);
  const geo = P.build().scale(1.2, 1.2, 1.2);
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  const homes: [number, number][] = [
    [-7.6, -11.6],
    [7.4, -12.4],
    [2.6, -22.5],
    [-9.8, -3.0],
    [10.2, 1.0],
    [2.4, -11.4],
  ];
  const mesh = new THREE.InstancedMesh(geo, mat, homes.length);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  disposeWith(mat, mesh);
  const ph = homes.map(() => rand() * Math.PI * 2);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler(0, 0, 0, 'YXZ');
  const p = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const update = (t: number) => {
    for (let i = 0; i < homes.length; i++) {
      const a = ph[i];
      const [hx, hz] = homes[i];
      // 小範圍慢慢踱步；面向走的方向
      const wx = Math.sin(t * 0.07 + a) * 0.6;
      const wz = Math.cos(t * 0.05 + a * 1.3) * 0.6;
      const dx = Math.cos(t * 0.07 + a) * 0.07;
      const dz = -Math.sin(t * 0.05 + a * 1.3) * 0.05;
      const peck = Math.pow(Math.max(0, Math.sin(t * 0.8 + a * 3)), 10);
      e.set(peck * 0.75, Math.atan2(dx, dz), 0);
      mesh.setMatrixAt(i, m.compose(p.set(hx + wx, WATER_Y - 0.12, hz + wz), q.setFromEuler(e), one));
    }
    mesh.instanceMatrix.needsUpdate = true;
  };
  update(0);
  return { mesh, update };
}
