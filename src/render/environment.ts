import * as THREE from 'three';
import type { Venue } from '../config';

/** 場地外的場景：室內球館／竹林／櫻花園。全部程序產生，不用外部素材。 */
export interface Environment {
  group: THREE.Group;
  background: number;
  fog: [number, number, number]; // 顏色、近、遠
  sky: number; // 半球光（天空）
  ground: number; // 半球光（地面）
  sun: number; // 主光源顏色
  update(dt: number): void;
}

let seed = 1;
const rand = () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};
const range = (a: number, b: number) => a + (b - a) * rand();

/** 在球場外圍（避開鏡頭正前方）隨機撒點 */
function scatter(n: number, inner: { x: number; z: number }, outer: number, avoidNearSide = 10): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  let guard = 0;
  while (out.length < n && guard++ < n * 50) {
    const x = range(-outer, outer);
    const z = range(-outer * 1.4, outer);
    if (Math.abs(x) < inner.x && Math.abs(z) < inner.z) continue;
    // 鏡頭在 z>0 那側後上方：靠近鏡頭的區域不要放高的東西擋畫面
    if (z > avoidNearSide && Math.abs(x) < 14) continue;
    out.push({ x, z });
  }
  return out;
}

function groundPlane(color: number, size = 90): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshLambertMaterial({ color }));
  m.rotation.x = -Math.PI / 2;
  return m;
}

/** 戶外場地：球場墊下面的木平台 */
function platform(): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(9.2, 0.12, 17.4), new THREE.MeshLambertMaterial({ color: 0x8d6a48 }));
  m.position.y = -0.068; // 頂面略低於球場墊，避免 z-fighting 蓋住球場
  return m;
}

/** 飄落粒子（花瓣／竹葉） */
function fallingParticles(count: number, color: number, size: number, area: number, fall: number): { points: THREE.Points; update(dt: number): void } {
  const pos = new Float32Array(count * 3);
  const phase = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = range(-area, area);
    pos[i * 3 + 1] = range(0, 9);
    pos[i * 3 + 2] = range(-area * 1.3, area * 0.8);
    phase[i] = range(0, Math.PI * 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color, size, transparent: true, opacity: 0.9, depthWrite: false });
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  let t = 0;
  return {
    points,
    update(dt: number) {
      t += dt;
      for (let i = 0; i < count; i++) {
        const k = i * 3;
        pos[k] += (Math.sin(t * 0.9 + phase[i]) * 0.35 + 0.25) * dt;
        pos[k + 1] -= fall * (0.7 + 0.3 * Math.sin(phase[i])) * dt;
        pos[k + 2] += Math.cos(t * 0.7 + phase[i]) * 0.2 * dt;
        if (pos[k + 1] < 0.02) {
          pos[k] = range(-area, area);
          pos[k + 1] = range(7, 9.5);
          pos[k + 2] = range(-area * 1.3, area * 0.8);
        }
      }
      geo.attributes.position.needsUpdate = true;
    },
  };
}

function indoor(): Environment {
  const group = new THREE.Group();
  group.add(groundPlane(0x24313f));
  return { group, background: 0x111a26, fog: [0x111a26, 26, 48], sky: 0xe6eeff, ground: 0x2a3442, sun: 0xffffff, update() {} };
}

function bamboo(): Environment {
  seed = 7;
  const group = new THREE.Group();
  group.add(groundPlane(0x56763f));
  group.add(platform());

  // 碎石小徑（球場四周淺色地面）
  const path = new THREE.Mesh(new THREE.PlaneGeometry(10.6, 18.6), new THREE.MeshLambertMaterial({ color: 0xb9b19a }));
  path.rotation.x = -Math.PI / 2;
  path.position.y = 0.001;
  group.add(path);

  // 竹節貼圖：一段段的深色環
  const c = document.createElement('canvas');
  c.width = 8;
  c.height = 128;
  const g = c.getContext('2d')!;
  const grad = g.createLinearGradient(0, 0, 8, 0);
  grad.addColorStop(0, '#4f8a3a');
  grad.addColorStop(0.5, '#7fbf5a');
  grad.addColorStop(1, '#4a7f36');
  g.fillStyle = grad;
  g.fillRect(0, 0, 8, 128);
  g.fillStyle = '#3c6a2c';
  g.fillRect(0, 0, 8, 5);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1, 9);

  const spots = scatter(320, { x: 4.4, z: 9.2 }, 22, -0.5);
  const stalkGeo = new THREE.CylinderGeometry(0.075, 0.095, 1, 7);
  stalkGeo.translate(0, 0.5, 0);
  const stalks = new THREE.InstancedMesh(stalkGeo, new THREE.MeshLambertMaterial({ map: tex }), spots.length);
  const leafGeo = new THREE.ConeGeometry(0.9, 2.6, 5);
  const leaves = new THREE.InstancedMesh(leafGeo, new THREE.MeshLambertMaterial({ color: 0x5f9e46, flatShading: true }), spots.length * 2);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const e = new THREE.Euler();
  spots.forEach((pt, i) => {
    const h = range(7, 13);
    e.set(range(-0.06, 0.06), 0, range(-0.06, 0.06));
    q.setFromEuler(e);
    m.compose(p.set(pt.x, 0, pt.z), q, s.set(1, h, 1));
    stalks.setMatrixAt(i, m);
    for (let j = 0; j < 2; j++) {
      e.set(range(-0.5, 0.5), range(0, 6), range(-0.5, 0.5));
      q.setFromEuler(e);
      const ls = range(0.7, 1.2);
      m.compose(p.set(pt.x + range(-0.6, 0.6), h * range(0.65, 0.95), pt.z + range(-0.6, 0.6)), q, s.set(ls, ls, ls));
      leaves.setMatrixAt(i * 2 + j, m);
    }
  });
  group.add(stalks, leaves);

  // 石燈籠
  for (const [x, z] of [
    [-5.4, -8.8],
    [5.4, -8.8],
    [-5.6, 3],
    [5.6, 3],
  ]) group.add(lantern(x, z));

  group.add(hedgeRow([0x4f8a3a, 0x5f9e46, 0x3f7a32], 9.4, 3));
  const fx = fallingParticles(70, 0x7fb85a, 0.09, 12, 0.5);
  group.add(fx.points);
  return { group, background: 0xcfe0cf, fog: [0xcfe0cf, 20, 52], sky: 0xf0fff0, ground: 0x4d6b3a, sun: 0xfff3d6, update: fx.update };
}

function sakura(): Environment {
  seed = 11;
  const group = new THREE.Group();
  group.add(groundPlane(0x79a359));
  group.add(platform());

  const path = new THREE.Mesh(new THREE.PlaneGeometry(10.6, 18.6), new THREE.MeshLambertMaterial({ color: 0xd9cbb8 }));
  path.rotation.x = -Math.PI / 2;
  path.position.y = 0.001;
  group.add(path);

  const spots = scatter(30, { x: 5.2, z: 9.6 }, 22, -1);
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.28, 1, 7);
  trunkGeo.translate(0, 0.5, 0);
  const trunks = new THREE.InstancedMesh(trunkGeo, new THREE.MeshLambertMaterial({ color: 0x5b3a2c }), spots.length);
  const blobGeo = new THREE.IcosahedronGeometry(1, 1);
  const blobs = new THREE.InstancedMesh(blobGeo, new THREE.MeshLambertMaterial({ flatShading: true }), spots.length * 6);
  const pinks = [0xf7b7cf, 0xf9cde0, 0xf29bbd, 0xfbe0ea].map((x) => new THREE.Color(x));
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  spots.forEach((pt, i) => {
    const h = range(2.6, 4);
    m.compose(p.set(pt.x, 0, pt.z), q.identity(), s.set(1, h, 1));
    trunks.setMatrixAt(i, m);
    for (let j = 0; j < 6; j++) {
      const r = range(1.1, 1.9);
      m.compose(p.set(pt.x + range(-1.6, 1.6), h + range(-0.2, 1.6), pt.z + range(-1.6, 1.6)), q.identity(), s.set(r, r * 0.8, r));
      blobs.setMatrixAt(i * 6 + j, m);
      blobs.setColorAt(i * 6 + j, pinks[Math.floor(rand() * pinks.length)]);
    }
  });
  group.add(trunks, blobs);

  // 地上的落花
  const petalCount = 600;
  const pp = new Float32Array(petalCount * 3);
  for (let i = 0; i < petalCount; i++) {
    let x: number;
    let z: number;
    do {
      x = range(-22, 22);
      z = range(-30, 18);
    } while (Math.abs(x) < 4.4 && Math.abs(z) < 8.4);
    pp.set([x, 0.02, z], i * 3);
  }
  const pg = new THREE.BufferGeometry();
  pg.setAttribute('position', new THREE.BufferAttribute(pp, 3));
  group.add(new THREE.Points(pg, new THREE.PointsMaterial({ color: 0xf6c3d6, size: 0.12, depthWrite: false })));

  for (const [x, z] of [
    [-5.4, -8.8],
    [5.4, -8.8],
  ]) group.add(lantern(x, z));

  group.add(hedgeRow([0x5f9e46, 0xf29bbd, 0x6aa84f, 0xf7b7cf], 9.4, 5));
  const fx = fallingParticles(260, 0xffc4da, 0.1, 13, 0.6);
  group.add(fx.points);
  return { group, background: 0xeadbe6, fog: [0xeadbe6, 22, 55], sky: 0xfff0f6, ground: 0x6d8c4f, sun: 0xffe8d8, update: fx.update };
}

/** 石燈籠 */
function lantern(x: number, z: number): THREE.Group {
  const g = new THREE.Group();
  const stone = new THREE.MeshLambertMaterial({ color: 0x9a9690 });
  const parts: [number, number, number, number][] = [
    // 寬、高、深、y
    [0.5, 0.15, 0.5, 0.075],
    [0.16, 0.7, 0.16, 0.5],
    [0.42, 0.12, 0.42, 0.91],
    [0.32, 0.3, 0.32, 1.12],
    [0.6, 0.12, 0.6, 1.33],
  ];
  for (const [w, h, d, y] of parts) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), stone);
    b.position.y = y;
    g.add(b);
  }
  const glow = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.18, 0.34), new THREE.MeshBasicMaterial({ color: 0xffd98a }));
  glow.position.y = 1.12;
  g.add(glow);
  g.position.set(x, 0, z);
  return g;
}

export function buildVenue(v: Venue): Environment {
  if (v === 'bamboo') return bamboo();
  if (v === 'sakura') return sakura();
  return indoor();
}

/** 鏡頭前方（畫面下方、搖桿底下）的低矮灌木帶，不會擋到球場 */
export function hedgeRow(colors: number[], z0: number, seedN: number): THREE.InstancedMesh {
  seed = seedN;
  const n = 46;
  const mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.5, 1), new THREE.MeshLambertMaterial({ flatShading: true }), n);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const c = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const r = range(0.5, 1.0);
    m.compose(p.set(range(-9, 9), r * 0.25, z0 + range(0, 2.2)), q.identity(), s.set(r * 1.3, r * 0.7, r));
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, c.set(colors[i % colors.length]));
  }
  return mesh;
}
