import * as THREE from 'three';
import type { Environment } from './environment';
import {
  blobShadows,
  canvasTexture,
  disposeWith,
  flyingBirds,
  GLSL_NOISE,
  merge,
  paintFaces,
  Parts,
  rand,
  range,
  setSeed,
  solid,
  sway,
  Wind,
  type Blob,
} from './envKit';

/**
 * 海灘：鏡頭看過去左邊是海、右邊是沙灘（晴天）。球場在木棧台上，棧台左半邊架在淺水上。
 * 沙灘＋海是同一張大平面、一個 shader：乾沙／濕沙、海水由淺綠到深藍、往岸邊推進的湧浪、
 * 跟著浪進退的白色浪花線、細碎的波光。右邊沙灘上有椰子樹（隨風擺）、海灘傘、躺椅、毛巾、救生員椅；
 * 海上有浮球繩、小帆船，海鷗在天上繞圈。
 */

const SAND_Y = -0.35; // 沙灘／海面高度（棧台頂 = 球場 = 0）
const DECK = { x: 4.75, z: 9.25 }; // 球員最遠跑到 |x| 3.6、|z| 8.2，加上身體與球拍還在棧台上

/** 岸線：x < shoreX(z) 是海。球場那段往外凸（棧台左半邊在淺水上），遠處慢慢往右彎成海灣 */
function shoreX(z: number): number {
  const q = (z / 11) * (z / 11);
  return -1.0 - 2.0 * Math.exp(-q * q) + 0.25 * Math.sin(z * 0.23 + 1.0) - 0.03 * Math.min(z, 0);
}
const GLSL_SHORE = /* glsl */ `
float shoreX( float z ) {
	float q = ( z / 11.0 ) * ( z / 11.0 );
	return -1.0 - 2.0 * exp( -q * q ) + 0.25 * sin( z * 0.23 + 1.0 ) - 0.03 * min( z, 0.0 );
}
`;

const UMBRELLA: [number, number][] = [
  [0xe2483d, 0xfff6ea],
  [0x2f7fd0, 0xfff6ea],
  [0xf2c230, 0xffffff],
  [0x1aa7a0, 0xfff6ea],
  [0xf08a24, 0x2f7fd0],
];
const TOWEL = [0xe2483d, 0x2f7fd0, 0xf2c230, 0x1aa7a0, 0xe8578e, 0x7a4fa0];

export function beach(): Environment {
  setSeed(41);
  const wind = new Wind(4);
  const group = new THREE.Group();
  const wash = { value: 0 };
  group.add(sandAndSea(wind, wash), deck());

  const P = new Parts();
  const shadows: Blob[] = [];
  deckPosts(P);

  // ---- 沙灘（右邊）：海灘傘＋毛巾／躺椅 ----
  for (const [x, z, ry] of [
    [9.0, -1.8, 0.4],
    [11.4, -10.2, -0.3],
    [3.9, -16.6, 0.9],
    [8.2, -18.6, 2.0],
    [13.8, 1.2, 1.2],
    [7.4, 5.8, -0.6],
    [16.0, -8.0, 0.1],
  ] as [number, number, number][]) {
    umbrellaSpot(P, x, z, ry);
    shadows.push({ x: x - 0.25, z: z - 0.35, r: 1.35 });
  }
  lifeguardChair(P, 6.4, -10.2);
  shadows.push({ x: 6.1, z: -10.6, r: 0.9 });
  surfboards(P, 7.9, -6.6);
  nearCamera(P, shadows);

  // ---- 椰子樹 ----
  // 球場旁邊的樹冠不能伸到球場上空（會擋到高球）：近的往外斜，遠端的才往海那邊斜
  const palmSpots: [number, number, number, number][] = [
    // x, z, 傾斜方向（ry：樹幹往 (cos ry, -sin ry) 彎）, 大小
    [9.0, -3.2, 0.5, 1.0],
    [9.8, -7.9, Math.PI - 0.3, 1.12],
    [7.6, -14.2, Math.PI + 0.2, 0.95],
    [12.2, -14.6, Math.PI - 0.6, 1.1],
    [14.6, -3.5, Math.PI + 0.9, 1.05],
    [12.4, 4.0, Math.PI + 0.3, 0.92],
    [17.0, -12.0, Math.PI - 0.2, 1.15],
    [10.6, -22.0, Math.PI + 0.4, 1.05],
    [15.8, -21.0, Math.PI - 0.5, 0.95],
    [5.6, -23.0, Math.PI + 0.7, 1.1],
    [1.4, -14.6, Math.PI - 0.15, 1.05], // 往海那邊斜出去的那棵
  ];
  const palms = palmTrees(palmSpots, wind);
  // 樹冠的影子：樹冠中心再往背光那側（-x、-z）偏一點
  for (const [x, z, ry, s] of palmSpots) shadows.push({ x: x + 1.7 * s * Math.cos(ry) - 0.8, z: z - 1.7 * s * Math.sin(ry) - 1.0, r: 1.6 * s });

  // ---- 海上：浮球繩、小帆船；天上：海鷗 ----
  const buoys = buoyLine(wind);
  const boats = sailboats(wind);
  const gulls = flyingBirds(
    [
      // 鏡頭往下看，看得到的高度有限：遠處要飛低一點才進得了畫面
      { cx: -4.6, cz: -14.0, r: 3.4, y: 2.6, speed: 3.4, dir: 1, phase: 0 },
      { cx: -5.0, cz: -14.5, r: 4.0, y: 2.9, speed: 3.4, dir: 1, phase: 2.6 },
      { cx: -10.5, cz: -2.0, r: 3.2, y: 3.3, speed: 3.0, dir: -1, phase: 1.0 },
      { cx: 9.5, cz: -8.5, r: 3.4, y: 3.1, speed: 3.2, dir: -1, phase: 4.0 },
    ],
    { body: 0xfafafa, wing: 0xc9ced4, tip: 0x2a2a2a, beak: 0xf0b030 },
    1.15,
    wind,
  );

  const shade = blobShadows(shadows, 0.2, 0x3a2a10);
  shade.position.y = SAND_Y;
  const propMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  group.add(shade, new THREE.Mesh(P.build(), propMat), palms.trunks, palms.crowns, buoys.mesh, buoys.rope, boats.mesh, gulls.mesh);

  return {
    group,
    background: 0xbfe3f2,
    fog: [0xc6e6f3, 30, 85],
    sky: 0xf4fbff,
    ground: 0xe9d6a8,
    sun: 0xfff4dc,
    sunDir: [-0.35, 1, -0.3], // 正午的海邊：太陽高（仰角約 65°），影子短而濃
    sunPower: 1.7,
    fill: [0xeaf6ff, 0.8], // 沙灘、海面的反射光很亮
    update(dt) {
      wind.update(dt);
      const t = wind.time.value;
      // 浪一波一波推上沙灘又退回（約 8 秒一次；衝上來快、退下去慢）
      const ph = (t / 8) * Math.PI * 2;
      wash.value = 0.2 + 0.5 * Math.sin(ph + 0.45 * Math.sin(ph));
      buoys.update(t);
      boats.update(t);
      gulls.update();
    },
  };
}

/** 沙灘＋海：一張平面、一個 shader（乾濕沙、深淺海水、湧浪、浪花線、波光），1 個 draw call */
function sandAndSea(wind: Wind, wash: { value: number }): THREE.Mesh {
  const geo = new THREE.PlaneGeometry(220, 200);
  geo.rotateX(-Math.PI / 2);
  geo.translate(0, SAND_Y, -40);
  const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const u = {
    bTime: wind.time,
    bWash: wash,
    bDry: { value: new THREE.Color(0xf2dfb2) },
    bWet: { value: new THREE.Color(0xc8ab7c) },
    bShallow: { value: new THREE.Color(0x3fc4c0) },
    bDeep: { value: new THREE.Color(0x1a64a8) },
    bFoam: { value: new THREE.Color(0xffffff) },
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u);
    sh.vertexShader = 'varying vec2 vBeach;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\n\tvBeach = position.xz;');
    sh.fragmentShader =
      'uniform float bTime;\nuniform float bWash;\nuniform vec3 bDry;\nuniform vec3 bWet;\nuniform vec3 bShallow;\nuniform vec3 bDeep;\nuniform vec3 bFoam;\nvarying vec2 vBeach;\n' +
      GLSL_NOISE +
      GLSL_SHORE +
      sh.fragmentShader
        .replace(
          '#include <color_fragment>',
          /* glsl */ `#include <color_fragment>
	vec2 bp = vBeach;
	float d = bp.x - shoreX( bp.y ); // > 0 沙灘、< 0 海（離岸線幾公尺）
	float n1 = kNoise( bp * 0.7 );
	float n2 = kNoise( bp * 6.0 );
	// 沙：靠水邊是濕沙
	vec3 sand = mix( bWet, bDry, smoothstep( 0.7, 2.4, d + 0.5 * n1 ) ) * ( 0.93 + 0.09 * n1 + 0.05 * n2 );
	// 海：越深越藍；跟岸線平行、往岸邊推進的湧浪亮帶
	float depth = clamp( -d / 16.0, 0.0, 1.0 );
	vec3 sea = mix( bShallow, bDeep, smoothstep( 0.0, 0.85, depth ) );
	float crest = smoothstep( 0.6, 1.0, sin( d * 1.1 + bTime * 1.3 + n1 * 2.5 ) );
	sea = mix( sea, bFoam, crest * ( 0.18 - 0.1 * depth ) );
	// 水邊跟著浪進退，邊緣不規則
	float e = d - ( bWash + 0.28 * ( kNoise( vec2( bp.y * 0.9, bTime * 0.3 ) ) - 0.5 ) );
	float inWater = smoothstep( 0.04, -0.04, e );
	// 剛被浪蓋過的淺水看得到底下的沙
	vec3 water = mix( mix( bWet, bShallow, 0.5 ), sea, smoothstep( -0.05, -1.8, e ) );
	vec3 col = mix( sand, water, inWater );
	// 浪花：水邊一條白邊＋外面一道碎浪
	float lace = kNoise( vec2( bp.y * 2.6, bp.x * 2.6 - bTime * 0.5 ) );
	float foam = smoothstep( 0.32, 0.0, abs( e + 0.12 ) ) * ( 0.5 + 0.5 * lace );
	foam += smoothstep( 0.22, 0.0, abs( e + 0.75 + 0.12 * sin( bTime * 0.8 + bp.y * 0.7 ) ) ) * 0.45 * lace;
	col = mix( col, bFoam, clamp( foam, 0.0, 0.92 ) );
	diffuseColor.rgb = col;
	// 波光：只在比較深的水面
	float gl = kNoise( bp * vec2( 1.7, 3.4 ) + vec2( bTime * 0.4, -bTime * 0.6 ) ) * kNoise( bp * 2.9 - vec2( bTime * 0.25, bTime * 0.35 ) );
	vec3 beachGlow = bFoam * smoothstep( 0.56, 0.8, gl ) * smoothstep( 0.02, 0.15, depth ) * 0.5 * inWater;`,
        )
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += beachGlow;');
  };
  mat.customProgramCacheKey = () => 'beach1';
  return new THREE.Mesh(geo, mat);
}

/** 木棧台：頂面木板貼圖、側面深色木頭 */
function deck(): THREE.Mesh {
  const tex = canvasTexture(256, 256, (g) => {
    for (let i = 0; i < 8; i++) {
      const v = 0.88 + Math.random() * 0.2;
      g.fillStyle = `rgb(${Math.round(196 * v)},${Math.round(150 * v)},${Math.round(102 * v)})`;
      g.fillRect(i * 32, 0, 32, 256);
      // 木紋
      for (let k = 0; k < 6; k++) {
        g.fillStyle = `rgba(110,70,40,${0.08 + Math.random() * 0.1})`;
        g.fillRect(i * 32 + 3 + Math.random() * 26, 0, 1.5, 256);
      }
      // 木板接縫（錯開）
      g.fillStyle = 'rgba(70,45,25,0.7)';
      g.fillRect(i * 32, ((i * 97) % 256) | 0, 32, 2);
    }
    g.fillStyle = 'rgba(60,38,22,0.85)';
    for (let i = 0; i < 8; i++) g.fillRect(i * 32, 0, 2, 256);
  });
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set((DECK.x * 2) / 1.6, (DECK.z * 2) / 3.2);
  tex.anisotropy = 8;
  const top = new THREE.MeshLambertMaterial({ map: tex });
  disposeWith(top, tex);
  const side = new THREE.MeshLambertMaterial({ color: 0x7a5434 });
  const H = 0.42;
  const m = new THREE.Mesh(new THREE.BoxGeometry(DECK.x * 2, H, DECK.z * 2), [side, side, top, side, side, side]);
  m.position.y = -0.008 - H / 2; // 頂面略低於球場墊
  return m;
}

/** 棧台下的木樁、右邊下到沙灘的台階 */
function deckPosts(P: Parts): void {
  P.at(0, 0);
  for (let z = -DECK.z + 0.3; z <= DECK.z - 0.29; z += (DECK.z * 2 - 0.6) / 8) {
    for (const x of [-DECK.x + 0.15, DECK.x - 0.15]) P.cyl(0.1, 0.11, 0.9, 7, x, -1.3, z, 0x5a3a24);
  }
  P.box(0.5, 0.2, 2.0, DECK.x + 0.25, -0.13, 1.6, 0x9a7048);
  P.box(0.5, 0.2, 2.0, DECK.x + 0.75, -0.25, 1.6, 0x9a7048);
}

/** 海灘傘＋底下的毛巾或躺椅 */
function umbrellaSpot(P: Parts, x: number, z: number, ry: number): void {
  P.at(x, z, ry, SAND_Y);
  const [ca, cb] = UMBRELLA[Math.floor(rand() * UMBRELLA.length)];
  const tilt = 0.18;
  P.box(0.05, 2.4, 0.05, 0, 1.15, 0, 0xe8e8e8, 0, 0, tilt);
  const umb = paintFaces(new THREE.ConeGeometry(1.25, 0.42, 10, 1, true), (cx, _cy, cz) => {
    const k = Math.floor(((Math.atan2(cz, cx) + Math.PI) / (Math.PI * 2)) * 10 + 1e-3);
    return k % 2 ? cb : ca;
  });
  umb.rotateZ(tilt);
  umb.translate(-Math.sin(tilt) * 2.25, 2.25, 0);
  P.raw(umb);
  if (rand() < 0.5) {
    // 兩條毛巾
    for (const ox of [-0.55, 0.6]) {
      const [t1, t2] = [TOWEL[Math.floor(rand() * TOWEL.length)], 0xffffff];
      const tw = paintFaces(new THREE.BoxGeometry(0.85, 0.02, 1.8, 1, 1, 6), (_x, _y, cz) => (Math.floor((cz + 0.9) / 0.3 + 1e-3) % 2 ? t2 : t1));
      tw.rotateY(range(-0.15, 0.15));
      tw.translate(ox, 0.015, 0.4);
      P.raw(tw);
    }
  } else {
    // 兩張白色躺椅
    for (const ox of [-0.6, 0.65]) {
      P.box(0.62, 0.08, 1.3, ox, 0.3, 0.55, 0xf2f2f2);
      P.box(0.62, 0.08, 0.6, ox, 0.5, -0.32, 0xf2f2f2, -0.6);
      P.box(0.5, 0.05, 1.2, ox, 0.36, 0.5, TOWEL[Math.floor(rand() * TOWEL.length)]);
      for (const lz of [0.05, 1.1]) for (const lx of [-0.26, 0.26]) P.box(0.04, 0.3, 0.04, ox + lx, 0.15, lz, 0xd8d8d8);
    }
  }
}

/** 救生員高腳椅（面向海）＋紅旗 */
function lifeguardChair(P: Parts, x: number, z: number): void {
  P.at(x, z, -Math.PI / 2, SAND_Y);
  const W = 0xf4f4f0;
  for (const lx of [-0.45, 0.45]) {
    P.box(0.09, 2.0, 0.09, lx, 1.0, -0.45, W, 0.12);
    P.box(0.09, 2.0, 0.09, lx, 1.0, 0.45, W, -0.12);
  }
  for (let i = 0; i < 4; i++) P.box(0.95, 0.05, 0.08, 0, 0.35 + i * 0.4, 0.5 - i * 0.03, W);
  P.box(1.1, 0.08, 1.0, 0, 1.95, 0, 0xd8402f);
  P.box(1.0, 0.7, 0.08, 0, 2.35, -0.48, 0xd8402f);
  P.box(1.0, 0.06, 0.08, 0, 2.3, 0.45, W);
  P.box(0.05, 1.6, 0.05, 0.5, 2.75, -0.45, 0xd8d8d8);
  // 旗子：正反兩面各一個三角形
  P.add(tris([0.5, 3.5, -0.45, 0.5, 3.1, -0.45, 1.15, 3.3, -0.45, 0.5, 3.1, -0.45, 0.5, 3.5, -0.45, 1.15, 3.3, -0.45]), 0xe8302a);
}

/** 直接用頂點座標做三角形 */
function tris(xyz: number[]): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(xyz, 3));
  g.computeVertexNormals();
  return g;
}

/** 插在沙裡的衝浪板 */
function surfboards(P: Parts, x: number, z: number): void {
  const cols: [number, number][] = [
    [0xf2c230, 0xe2483d],
    [0x2f9fd0, 0xffffff],
    [0xe8578e, 0x1aa7a0],
  ];
  cols.forEach(([a, b], i) => {
    P.at(x + i * 0.55, z + i * 0.2, -0.3 + i * 0.25, SAND_Y);
    const g = paintFaces(new THREE.SphereGeometry(1, 10, 8).scale(0.27, 1.05, 0.05), (_x, cy) => (Math.abs(cy - 0.1) < 0.12 ? b : a));
    g.rotateZ(0.1 - i * 0.1);
    g.translate(0, 0.85, 0);
    P.raw(g);
  });
}

/** 鏡頭前（直向時搖桿底下）：沙上的毛巾、拖鞋、沙堡、海灘球、水桶、冰桶、海星 */
function nearCamera(P: Parts, shadows: Blob[]): void {
  // 毛巾
  P.at(0.55, 10.2, 0.25, SAND_Y);
  P.raw(paintFaces(new THREE.BoxGeometry(0.9, 0.02, 1.9, 1, 1, 8), (_x, _y, cz) => (Math.floor((cz + 0.95) / 0.2375 + 1e-3) % 2 ? 0xffffff : 0xe2483d)).translate(0, 0.012, 0));
  // 拖鞋
  P.at(-0.5, 9.85, -0.3, SAND_Y);
  for (const ox of [-0.08, 0.08]) P.box(0.1, 0.03, 0.27, ox, 0.015, 0, 0x2f7fd0);
  // 沙堡
  P.at(2.1, 10.15, 0.2, SAND_Y);
  P.cyl(0.42, 0.5, 0.25, 10, 0, 0, 0, 0xd9bf8a);
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    P.cyl(0.11, 0.13, 0.32, 7, Math.cos(a) * 0.3, 0.22, Math.sin(a) * 0.3, 0xd9bf8a);
  }
  P.cyl(0.17, 0.2, 0.32, 8, 0, 0.25, 0, 0xd9bf8a);
  P.add(new THREE.ConeGeometry(0.16, 0.22, 8).translate(0, 0.68, 0), 0xd9bf8a);
  P.box(0.01, 0.2, 0.01, 0, 0.88, 0, 0x6a6a6a);
  P.box(0.14, 0.08, 0.01, 0.07, 0.94, 0, 0xe2483d);
  // 水桶＋鏟子
  P.at(2.75, 9.75, 0, SAND_Y);
  P.cyl(0.13, 0.1, 0.22, 9, 0, 0, 0, 0x2fa0e0);
  P.box(0.06, 0.02, 0.32, 0.25, 0.02, 0.05, 0xf2c230, 0, 0.6);
  // 海灘球（6 片彩色）
  P.at(-1.15, 10.45, 0, SAND_Y);
  const ballCols = [0xe2483d, 0xffffff, 0x2f7fd0, 0xffffff, 0xf2c230, 0xffffff];
  P.raw(
    paintFaces(new THREE.IcosahedronGeometry(0.2, 2), (cx, _cy, cz) => ballCols[Math.floor(((Math.atan2(cz, cx) + Math.PI) / (Math.PI * 2)) * 6) % 6]).translate(
      0,
      0.2,
      0,
    ),
  );
  // 冰桶
  P.at(3.4, 10.3, -0.3, SAND_Y);
  P.box(0.6, 0.38, 0.4, 0, 0.19, 0, 0x2f7fd0);
  P.box(0.62, 0.07, 0.42, 0, 0.41, 0, 0xffffff);
  // 海星、貝殼
  P.at(-1.75, 9.95, 0.5, SAND_Y);
  for (let i = 0; i < 5; i++) P.add(new THREE.BoxGeometry(0.05, 0.03, 0.15).translate(0, 0.015, 0.07).rotateY((i / 5) * Math.PI * 2), 0xf07a3a);
  P.at(1.4, 9.65, 0, SAND_Y);
  P.ball(0.05, 0, 0.02, 0, 0xf6e6e0, 1, 0.5, 1, 0);
  P.ball(0.04, 0.4, 0.02, 0.3, 0xe8c8b8, 1, 0.5, 1, 0);
  shadows.push({ x: 2.0, z: 10.0, r: 0.6 }, { x: 3.3, z: 10.15, r: 0.45 });
}

/** 椰子樹：彎彎的樹幹（一個 InstancedMesh）＋一束下垂的羽狀葉＋椰子（另一個），用同一組矩陣，隨風擺 */
function palmTrees(spots: [number, number, number, number][], wind: Wind): { trunks: THREE.InstancedMesh; crowns: THREE.InstancedMesh } {
  const H = 6.2;
  const LEAN = 1.7;
  // 樹幹：圓柱往 +x 彎（二次曲線），一節一節深淺交錯
  const trunk = new THREE.CylinderGeometry(0.13, 0.21, H, 7, 10);
  trunk.translate(0, H / 2, 0);
  {
    const p = trunk.attributes.position;
    const col = new Float32Array(p.count * 3);
    const a = new THREE.Color(0x8a6a48);
    const b = new THREE.Color(0x6e5236);
    for (let i = 0; i < p.count; i++) {
      const y = p.getY(i);
      const t = y / H;
      p.setX(i, p.getX(i) + LEAN * t * t);
      const c = Math.round(t * 10) % 2 ? a : b;
      col.set([c.r, c.g, c.b], i * 3);
    }
    trunk.setAttribute('color', new THREE.BufferAttribute(col, 3));
    trunk.computeVertexNormals();
  }
  // 樹冠：8 片羽狀葉（V 字折、往外拱再下垂）＋ 3 顆椰子
  const top = new THREE.Vector3(LEAN, H, 0);
  const pos: number[] = [];
  const col: number[] = [];
  const c1 = new THREE.Color();
  const c2 = new THREE.Color();
  const K = 8;
  const M = 6;
  for (let k = 0; k < K; k++) {
    const az = (k / K) * Math.PI * 2 + range(-0.2, 0.2);
    const dx = Math.cos(az);
    const dz = Math.sin(az);
    const L = range(2.4, 2.9);
    const el = range(0.45, 0.75);
    c1.set(k % 2 ? 0x4f8f2e : 0x5a9a34);
    c2.set(k % 2 ? 0x3a7a28 : 0x427f2a);
    const st: THREE.Vector3[][] = [];
    for (let i = 0; i <= M; i++) {
      const s = i / M;
      const hor = L * s * Math.cos(el);
      const ver = L * (Math.sin(el) * s - 0.95 * s * s);
      const w = 0.5 * Math.pow(Math.sin(Math.PI * Math.min(1, s * 1.15)), 0.7) + 0.02;
      const cx = top.x + dx * hor;
      const cz = top.z + dz * hor;
      const cy = top.y + ver;
      // 葉子兩側往下折
      st.push([
        new THREE.Vector3(cx - dz * w, cy - w * 0.4, cz + dx * w),
        new THREE.Vector3(cx, cy, cz),
        new THREE.Vector3(cx + dz * w, cy - w * 0.4, cz - dx * w),
      ]);
    }
    for (let i = 0; i < M; i++) {
      const [l0, m0, r0] = st[i];
      const [l1, m1, r1] = st[i + 1];
      for (const [p0, p1, p2, q0, q1, q2] of [
        [l0, m0, l1, c2, c1, c2],
        [l1, m0, m1, c2, c1, c1],
        [m0, r0, m1, c1, c2, c1],
        [m1, r0, r1, c1, c2, c2],
      ] as [THREE.Vector3, THREE.Vector3, THREE.Vector3, THREE.Color, THREE.Color, THREE.Color][]) {
        pos.push(p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z);
        col.push(q0.r, q0.g, q0.b, q1.r, q1.g, q1.b, q2.r, q2.g, q2.b);
      }
    }
  }
  const fronds = new THREE.BufferGeometry();
  fronds.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  fronds.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  fronds.computeVertexNormals();
  const nuts = [0, 1, 2].map((i) => solid(new THREE.IcosahedronGeometry(0.14, 0).translate(top.x + Math.cos(i * 2.1) * 0.18, top.y - 0.22, Math.sin(i * 2.1) * 0.18), 0x6a4a22));
  const crownGeo = merge([fronds, ...nuts]);

  const trunkMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  sway(trunkMat, wind, 0.0042, 0.4);
  const crownMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });
  sway(crownMat, wind, 0.0042, 0.4, 0.03);
  const trunks = new THREE.InstancedMesh(trunk, trunkMat, spots.length);
  const crowns = new THREE.InstancedMesh(crownGeo, crownMat, spots.length);
  disposeWith(trunkMat, trunks);
  disposeWith(crownMat, crowns);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  spots.forEach(([x, z, ry, sc], i) => {
    m.compose(p.set(x, SAND_Y, z), q.setFromEuler(e.set(0, ry, 0)), s.set(sc, sc, sc));
    trunks.setMatrixAt(i, m);
    crowns.setMatrixAt(i, m);
  });
  return { trunks, crowns };
}

/** 游泳區浮球繩：沿著球場左邊的海面，浮球隨浪上下（每幀更新矩陣） */
function buoyLine(wind: Wind): { mesh: THREE.InstancedMesh; rope: THREE.LineSegments; update(t: number): void } {
  const pts: THREE.Vector3[] = [];
  // 離岸線約 3.3 公尺，跟著岸線彎
  for (let z = 9.6; z > -24; z -= 1.5) {
    const x = shoreX(z) - 3.3;
    pts.push(new THREE.Vector3(Math.abs(z) < 10.8 ? Math.min(x, -6.0) : x, SAND_Y + 0.04, z)); // 棧台旁邊至少離 1 公尺
  }
  const rope: number[] = [];
  for (let i = 0; i + 1 < pts.length; i++) rope.push(pts[i].x, pts[i].y, pts[i].z, pts[i + 1].x, pts[i + 1].y, pts[i + 1].z);
  const rg = new THREE.BufferGeometry();
  rg.setAttribute('position', new THREE.Float32BufferAttribute(rope, 3));
  const ropeLine = new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0xf4f4f0, transparent: true, opacity: 0.7 }));
  const mat = new THREE.MeshLambertMaterial({ flatShading: true });
  const mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.16, 1).scale(1, 0.8, 1), mat, pts.length);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  disposeWith(mat, mesh);
  const cols = [0xe8302a, 0xf4f4f0, 0xf2b630];
  const c = new THREE.Color();
  pts.forEach((_, i) => mesh.setColorAt(i, c.set(cols[i % 3])));
  const m = new THREE.Matrix4();
  const update = (t: number) => {
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      mesh.setMatrixAt(i, m.makeTranslation(p.x, p.y + 0.05 * Math.sin(t * 1.3 + p.z * 0.6), p.z));
    }
    mesh.instanceMatrix.needsUpdate = true;
  };
  update(wind.time.value);
  return { mesh, rope: ropeLine, update };
}

/** 小帆船：白色船身＋藍色飾條＋白帆，隨浪上下、左右搖（3 艘、一個 InstancedMesh） */
function sailboats(wind: Wind): { mesh: THREE.InstancedMesh; update(t: number): void } {
  const P = new Parts();
  P.at(0, 0);
  const hull = new THREE.BoxGeometry(1.1, 0.42, 2.9, 1, 1, 2);
  {
    const p = hull.attributes.position;
    for (let i = 0; i < p.count; i++) {
      if (p.getZ(i) > 1) p.setX(i, p.getX(i) * 0.08); // 船頭尖
      if (p.getY(i) < 0) p.setX(i, p.getX(i) * 0.6); // 船底窄
    }
    hull.computeVertexNormals();
  }
  P.add(hull.translate(0, 0.12, 0), 0xf6f6f2);
  P.box(1.0, 0.05, 1.6, 0, 0.3, -0.4, 0x9a7048);
  P.box(1.12, 0.08, 1.5, 0, 0.18, -0.45, 0x2f6fc0);
  P.box(0.06, 3.0, 0.06, 0, 1.8, 0.35, 0xd8d8d8);
  P.box(0.05, 0.05, 1.6, 0, 0.62, -0.42, 0xd8d8d8);
  P.add(tris([0, 3.2, 0.32, 0, 0.68, 0.32, 0, 0.68, -1.15]), 0xfafafa); // 帆
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true, side: THREE.DoubleSide });
  const homes: [number, number, number][] = [
    [-7.4, -19.5, 0.6],
    [-16.5, -27.0, -0.4],
    [-19.0, -8.0, 2.4],
  ];
  const mesh = new THREE.InstancedMesh(P.build(), mat, homes.length);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  disposeWith(mat, mesh);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const one = new THREE.Vector3(1, 1, 1);
  const update = (t: number) => {
    for (let i = 0; i < homes.length; i++) {
      const [x, z, ry] = homes[i];
      e.set(0.04 * Math.sin(t * 0.9 + i * 2), ry, 0.06 * Math.sin(t * 1.1 + i));
      mesh.setMatrixAt(i, m.compose(p.set(x, SAND_Y - 0.08 + 0.06 * Math.sin(t * 1.3 + i * 1.7), z), q.setFromEuler(e), one));
    }
    mesh.instanceMatrix.needsUpdate = true;
  };
  update(wind.time.value);
  return { mesh, update };
}
