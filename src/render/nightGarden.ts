import * as THREE from 'three';
import type { Environment } from './environment';
import {
  blobShadows,
  disposeWith,
  fallingParticles,
  glowTexture,
  groundPetals,
  groundPlane,
  gustParticles,
  hedgeRow,
  lightPools,
  lightWash,
  merge,
  paint,
  pathPlane,
  petalTexture,
  platform,
  rand,
  range,
  sakuraGrove,
  scatter,
  setSeed,
  stoneLanterns,
  Wind,
  type Blob,
} from './envKit';

/**
 * 夜櫻庭園：深藍夜空、被燈照亮的櫻花、沿著球場兩側與後方掛成一串串的紙燈籠（自發光＋光暈＋地上的光池）、
 * 螢火蟲、陣風花瓣。燈光全用 unlit 材質與加法混色假裝，不加真的光源（手機上很省）。
 */
export function nightGarden(): Environment {
  setSeed(19);
  const wind = new Wind(4);
  const group = new THREE.Group();
  group.add(groundPlane(0x223f30), platform(0x7a5a44), pathPlane(0x5f5c66));
  // 球場上方的探照燈：兩排、每排 4 盞，暖白光把球場照亮（乘法混色：白線更白、綠地墊更亮，不是蓋一層霧）
  const floods: Blob[] = [];
  for (const x of [-2.3, 2.3]) for (const z of [-6.2, -2.1, 2.1, 6.2]) floods.push({ x, z, r: 4.6 });
  group.add(lightWash(floods, 0xffdcae, 0.55));

  // 櫻花樹：花團帶一點自發光（夜裡被打光的感覺）
  const spots = scatter(28, { x: 5.6, z: 9.8 }, 22, -1);
  const grove = sakuraGrove(spots, [0xf7c4d8, 0xfad6e4, 0xf2a9c6, 0xfde6ef], 0x3a2824, wind, 0x4a1c34);
  group.add(blobShadows(grove.shadows, 0.28, 0x02030a), grove.trunks, grove.blobs);
  const tex = petalTexture();
  group.add(groundPetals(500, 0xd29ab4, 0.14, tex));

  const glows: GlowSpec[] = [];
  const pools: Blob[] = [];

  // 石燈籠（遠端兩角）
  const stones: [number, number][] = [
    [-5.4, -8.8],
    [5.4, -8.8],
  ];
  group.add(stoneLanterns(stones, 0xffd27a));
  for (const [x, z] of stones) {
    glows.push({ x, y: 1.12, z, color: 0xffb84a, size: 2.4 });
    pools.push({ x, z, r: 1.3 });
  }
  // 畫面下方小徑邊的紙罩地燈（行燈）
  const andons: [number, number][] = [
    [-5.6, 8.85],
    [-1.9, 8.9],
    [1.9, 8.9],
    [5.6, 8.85],
  ];
  group.add(andonLamps(andons));
  const small: GlowSpec[] = [];
  for (const [x, z] of andons) {
    small.push({ x, y: 0.55, z, color: 0xffc070, size: 1.5 });
    pools.push({ x, z: z - 0.25, r: 1.2 });
  }

  const strings = lanternStrings(wind);
  for (const l of strings.lanterns) pools.push({ x: l.x, z: l.z, r: 1.25 });
  group.add(lightPools(pools, 0xff9a4a, 0.24), strings.group);

  // 光暈：點精靈只能有一種大小，所以大燈（燈籠、石燈籠）一組、小地燈一組；燈籠排在前面（會跟著晃）
  const glowAll: GlowSpec[] = [...strings.lanterns.map((l) => ({ x: l.x, y: l.y - 0.4, z: l.z, color: l.color, size: 2.6 })), ...glows];
  const halo = glowPoints(glowAll);
  const haloSmall = glowPoints(small);
  group.add(halo.points, haloSmall.points);

  group.add(hedgeRow([0x2c4a30, 0xd98aa8, 0x335a38, 0xe7a3bd], 9.4, 5, wind));
  const flies = fireflies(36);
  const fx = fallingParticles(200, 0xe7a7c2, 0.13, 13, 0.55, wind, tex, 0.85);
  const gust = gustParticles(
    150,
    0xf0b6cf,
    0.14,
    grove.canopy.filter((c) => c.z < 6),
    wind,
    tex,
    0.9,
  );
  group.add(flies.points, fx.points, gust.points);

  return {
    group,
    background: 0x0b1433,
    fog: [0x0d1738, 17, 46],
    sky: 0x4f5c9c, // 月光（環境光）偏藍
    ground: 0x262036,
    sun: 0xd4dcff, // 主光（投影）= 月光，偏冷的藍白（太藍地墊會變灰，探照燈的光池再把它拉回暖綠）
    sunDir: [-0.6, 1, -0.5], // 月亮在左前方、仰角約 52°：影子長一點
    sunPower: 1.35,
    fill: [0xffb36b, 0.85], // 補光 = 燈籠的暖色調
    update(dt) {
      wind.update(dt);
      strings.update(halo);
      halo.flicker(wind.time.value);
      haloSmall.flicker(wind.time.value + 3.7);
      flies.update(wind.time.value);
      fx.update(dt);
      gust.update(dt);
    },
  };
}

interface GlowSpec {
  x: number;
  y: number;
  z: number;
  color: number;
  size: number;
}

/** 加法混色的光暈點精靈；flicker() 讓每顆亮度各自微微閃動 */
function glowPoints(list: GlowSpec[]): {
  points: THREE.Points;
  pos: Float32Array;
  posAttr: THREE.BufferAttribute;
  flicker(t: number): void;
} {
  const n = list.length;
  const pos = new Float32Array(n * 3);
  const base = new Float32Array(n * 3);
  const col = new Float32Array(n * 3);
  const c = new THREE.Color();
  list.forEach((g, i) => {
    pos.set([g.x, g.y, g.z], i * 3);
    c.set(g.color);
    base.set([c.r, c.g, c.b], i * 3);
  });
  col.set(base);
  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  const colAttr = new THREE.BufferAttribute(col, 3);
  colAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('color', colAttr);
  const tex = glowTexture();
  // 點精靈只能一個大小：取平均（燈籠、石燈籠差不多大）
  const size = list.reduce((a, g) => a + g.size, 0) / Math.max(1, n);
  const mat = new THREE.PointsMaterial({
    size,
    map: tex,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  disposeWith(mat, tex);
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return {
    points,
    pos,
    posAttr,
    flicker(t: number) {
      for (let i = 0; i < n; i++) {
        const f = 0.86 + 0.1 * Math.sin(t * 7.1 + i * 1.7) * Math.sin(t * 2.3 + i * 0.6) + 0.04 * Math.sin(t * 13 + i);
        const k = i * 3;
        col[k] = base[k] * f;
        col[k + 1] = base[k + 1] * f;
        col[k + 2] = base[k + 2] * f;
      }
      colAttr.needsUpdate = true;
    },
  };
}

interface Lantern {
  x: number;
  y: number; // 掛點（電線上）高度
  z: number;
  color: number;
  phase: number;
}

/** 紙燈籠串：木柱＋下垂的電線＋一顆顆燈籠（燈籠全部一個 InstancedMesh，會隨風輕晃） */
function lanternStrings(wind: Wind): {
  group: THREE.Group;
  lanterns: Lantern[];
  update(halo: { pos: Float32Array; posAttr: THREE.BufferAttribute }): void;
} {
  const group = new THREE.Group();
  const H = 3.6; // 柱頂（電線）高度
  const SAG = 0.5;
  const X = 6.3;
  // [x0, z0, x1, z1, 燈籠數]
  const spans: [number, number, number, number, number][] = [
    [-X, -13, -X, -6.5, 4],
    [-X, -6.5, -X, 0, 4],
    [-X, 0, -X, 6, 3],
    [X, -13, X, -6.5, 4],
    [X, -6.5, X, 0, 4],
    [X, 0, X, 6, 3],
    [-X, -13, 0, -13.6, 4],
    [0, -13.6, X, -13, 4],
  ];
  const colors = [0xff5a3a, 0xffd9a0, 0xff9a52, 0xffe9c4, 0xff6f8f];
  const lanterns: Lantern[] = [];
  const wire: number[] = [];
  const poles = new Map<string, [number, number]>();
  const sagY = (t: number) => H - SAG * 4 * t * (1 - t);
  for (const [x0, z0, x1, z1, n] of spans) {
    poles.set(`${x0},${z0}`, [x0, z0]);
    poles.set(`${x1},${z1}`, [x1, z1]);
    const SEG = 10;
    for (let i = 0; i < SEG; i++) {
      const a = i / SEG;
      const b = (i + 1) / SEG;
      wire.push(x0 + (x1 - x0) * a, sagY(a), z0 + (z1 - z0) * a, x0 + (x1 - x0) * b, sagY(b), z0 + (z1 - z0) * b);
    }
    for (let k = 1; k <= n; k++) {
      const t = k / (n + 1);
      lanterns.push({
        x: x0 + (x1 - x0) * t,
        y: sagY(t),
        z: z0 + (z1 - z0) * t,
        color: colors[Math.floor(rand() * colors.length)],
        phase: rand() * Math.PI * 2,
      });
    }
  }

  // 電線
  const wg = new THREE.BufferGeometry();
  wg.setAttribute('position', new THREE.Float32BufferAttribute(wire, 3));
  const wm = new THREE.LineBasicMaterial({ color: 0x3a3040 });
  group.add(new THREE.LineSegments(wg, wm));

  // 木柱
  const poleGeo = new THREE.CylinderGeometry(0.06, 0.08, H + 0.15, 6);
  poleGeo.translate(0, (H + 0.15) / 2, 0);
  const poleMat = new THREE.MeshLambertMaterial({ color: 0x4a3328 });
  const pl = [...poles.values()];
  const poleMesh = new THREE.InstancedMesh(poleGeo, poleMat, pl.length);
  disposeWith(poleMat, poleMesh);
  const m = new THREE.Matrix4();
  pl.forEach(([x, z], i) => poleMesh.setMatrixAt(i, m.makeTranslation(x, 0, z)));
  group.add(poleMesh);

  // 燈籠：原點 = 掛點；繩、上蓋、紙燈身（橫向竹骨的明暗條紋）、下蓋，頂點色合成一個幾何
  const cord = paint(new THREE.CylinderGeometry(0.008, 0.008, 0.1, 4).translate(0, -0.05, 0), 0x1c1410);
  const capTop = paint(new THREE.CylinderGeometry(0.085, 0.1, 0.05, 10).translate(0, -0.125, 0), 0x241812);
  const capBot = paint(new THREE.CylinderGeometry(0.1, 0.085, 0.05, 10).translate(0, -0.675, 0), 0x241812);
  const body = new THREE.SphereGeometry(0.2, 12, 10);
  body.scale(1, 1.25, 1);
  body.translate(0, -0.4, 0);
  {
    const p = body.attributes.position;
    const a = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) {
      const y = (p.getY(i) + 0.4) / 0.25; // -1..1
      const row = Math.round((y + 1) * 5);
      const v = (1 - 0.35 * y * y) * (row % 2 ? 0.86 : 1);
      a[i * 3] = a[i * 3 + 1] = a[i * 3 + 2] = v;
    }
    body.setAttribute('color', new THREE.BufferAttribute(a, 3));
  }
  const lanGeo = merge([cord, capTop, body, capBot]);
  const lanMat = new THREE.MeshBasicMaterial({ vertexColors: true });
  const lanMesh = new THREE.InstancedMesh(lanGeo, lanMat, lanterns.length);
  lanMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  disposeWith(lanMat, lanMesh);
  const c = new THREE.Color();
  lanterns.forEach((l, i) => lanMesh.setColorAt(i, c.set(l.color)));
  group.add(lanMesh);

  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3(1, 1, 1);
  const off = new THREE.Vector3();
  const place = (t: number, g: number, halo?: { pos: Float32Array }) => {
    for (let i = 0; i < lanterns.length; i++) {
      const l = lanterns[i];
      // 微風輕晃；陣風（往 +x 吹）時往 +x 擺
      const az = Math.sin(t * 1.5 + l.phase) * 0.05 + g * 0.32 * (0.75 + 0.25 * Math.sin(t * 3.3 + l.phase));
      const ax = Math.sin(t * 1.1 + l.phase * 1.7) * 0.04;
      e.set(ax, 0, az);
      q.setFromEuler(e);
      lanMesh.setMatrixAt(i, m.compose(p.set(l.x, l.y, l.z), q, s));
      if (halo) {
        off.set(0, -0.4, 0).applyQuaternion(q);
        halo.pos[i * 3] = l.x + off.x;
        halo.pos[i * 3 + 1] = l.y + off.y;
        halo.pos[i * 3 + 2] = l.z + off.z;
      }
    }
    lanMesh.instanceMatrix.needsUpdate = true;
  };
  place(0, 0);
  return {
    group,
    lanterns,
    update(halo) {
      place(wind.time.value, wind.gust.value, halo);
      halo.posAttr.needsUpdate = true;
    },
  };
}

/** 螢火蟲：在球場外的草地上慢慢飄、一明一滅 */
function fireflies(n: number): { points: THREE.Points; update(t: number): void } {
  const home = new Float32Array(n * 3);
  const ph = new Float32Array(n);
  let i = 0;
  while (i < n) {
    const x = range(-16, 16);
    const z = range(-24, 9);
    if (Math.abs(x) < 5.6 && Math.abs(z) < 9.6) continue;
    home.set([x, range(0.4, 2.2), z], i * 3);
    ph[i] = range(0, Math.PI * 2);
    i++;
  }
  const pos = new Float32Array(home);
  const col = new Float32Array(n * 3);
  const geo = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(pos, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  const colAttr = new THREE.BufferAttribute(col, 3);
  colAttr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('color', colAttr);
  const tex = glowTexture();
  const mat = new THREE.PointsMaterial({
    size: 0.32,
    map: tex,
    vertexColors: true,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  disposeWith(mat, tex);
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  const fc = new THREE.Color(0xd9ff8a);
  return {
    points,
    update(t: number) {
      for (let j = 0; j < n; j++) {
        const k = j * 3;
        const p = ph[j];
        pos[k] = home[k] + Math.sin(t * 0.37 + p) * 0.9;
        pos[k + 1] = home[k + 1] + Math.sin(t * 0.9 + p * 2) * 0.25;
        pos[k + 2] = home[k + 2] + Math.cos(t * 0.31 + p * 1.3) * 0.9;
        const b = Math.max(0, Math.sin(t * 1.2 + p * 3));
        const v = b * b * b;
        col[k] = fc.r * v;
        col[k + 1] = fc.g * v;
        col[k + 2] = fc.b * v;
      }
      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;
    },
  };
}

/** 紙罩地燈（行燈）：木腳＋發光的紙箱，unlit 頂點色，全部一個 InstancedMesh */
function andonLamps(spots: [number, number][]): THREE.InstancedMesh {
  const wood = 0x2a1c14;
  const parts: THREE.BufferGeometry[] = [];
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) parts.push(paint(new THREE.BoxGeometry(0.03, 0.5, 0.03).translate(sx * 0.1, 0.25, sz * 0.1), wood));
  }
  parts.push(paint(new THREE.BoxGeometry(0.19, 0.24, 0.19).translate(0, 0.4, 0), 0xffe6b4)); // 紙罩（從上面看也是亮的）
  parts.push(paint(new THREE.BoxGeometry(0.24, 0.025, 0.24).translate(0, 0.27, 0), wood)); // 底框
  const mat = new THREE.MeshBasicMaterial({ vertexColors: true });
  const mesh = new THREE.InstancedMesh(merge(parts), mat, spots.length);
  disposeWith(mat, mesh);
  const m = new THREE.Matrix4();
  spots.forEach(([x, z], i) => mesh.setMatrixAt(i, m.makeTranslation(x, 0, z)));
  return mesh;
}
