import * as THREE from 'three';
import {
  blobShadows,
  disposeWith,
  fallingParticles,
  groundPetals,
  groundPlane,
  gustParticles,
  hedgeRow,
  pathPlane,
  petalTexture,
  platform,
  range,
  sakuraGrove,
  scatter,
  setSeed,
  stoneLanterns,
  sway,
  Wind,
  type Blob,
} from './envKit';
import { beach } from './beach';
import { market } from './market';
import { nightGarden } from './nightGarden';
import { paddy } from './paddy';

export { hedgeRow } from './envKit';

/** 場地外的場景：室內球館／竹林／櫻花園／夜櫻／市場／稻田／海灘。全部程序產生，不用外部素材。 */
export interface Environment {
  group: THREE.Group;
  background: number;
  fog: [number, number, number]; // 顏色、近、遠
  sky: number; // 半球光（天空）
  ground: number; // 半球光（地面）
  sun: number; // 主光源顏色
  update(dt: number): void;
}

/** buildVenue 認得的場地（'night' = 夜櫻庭園、'paddy' = 稻田） */
export const VENUE_IDS = ['indoor', 'bamboo', 'sakura', 'night', 'market', 'paddy', 'beach'] as const;
export type VenueId = (typeof VENUE_IDS)[number];

function indoor(): Environment {
  const group = new THREE.Group();
  group.add(groundPlane(0x24313f));
  return { group, background: 0x111a26, fog: [0x111a26, 26, 48], sky: 0xe6eeff, ground: 0x2a3442, sun: 0xffffff, update() {} };
}

function bamboo(): Environment {
  setSeed(7);
  const wind = new Wind(4);
  const group = new THREE.Group();
  group.add(groundPlane(0x56763f), platform(), pathPlane(0xb9b19a)); // 碎石小徑（球場四周淺色地面）

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
  // 竹竿分 6 節，搖擺時會彎成弧線（葉子跟著同一個彎曲函數，不會脫離竹竿）
  const stalkGeo = new THREE.CylinderGeometry(0.075, 0.095, 1, 7, 6);
  stalkGeo.translate(0, 0.5, 0);
  const stalkMat = new THREE.MeshLambertMaterial({ map: tex });
  sway(stalkMat, wind, 0.0016);
  const stalks = new THREE.InstancedMesh(stalkGeo, stalkMat, spots.length);
  const leafMat = new THREE.MeshLambertMaterial({ color: 0x5f9e46, flatShading: true });
  sway(leafMat, wind, 0.0016, 0, 0.035);
  const leaves = new THREE.InstancedMesh(new THREE.ConeGeometry(0.9, 2.6, 5), leafMat, spots.length * 2);
  disposeWith(stalkMat, tex, stalks);
  disposeWith(leafMat, leaves);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const e = new THREE.Euler();
  const shadows: Blob[] = [];
  const emitters: THREE.Vector3[] = [];
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
    // 竹叢下的斑駁陰影（很淡，疊在一起就是林下的暗處）
    shadows.push({ x: pt.x - 0.7, z: pt.z - 1, r: 1.0 + (i % 4) * 0.12 });
    if (i % 3 === 0 && pt.z < 4 && pt.x < 10) emitters.push(new THREE.Vector3(pt.x, h * 0.55, pt.z));
  });
  group.add(blobShadows(shadows, 0.13), stalks, leaves);

  group.add(
    stoneLanterns([
      [-5.4, -8.8],
      [5.4, -8.8],
      [-5.6, 3],
      [5.6, 3],
    ]),
  );

  group.add(hedgeRow([0x4f8a3a, 0x5f9e46, 0x3f7a32], 9.4, 3, wind));
  const leafTex = petalTexture();
  const fx = fallingParticles(70, 0x7fb85a, 0.11, 12, 0.5, wind, leafTex);
  const gust = gustParticles(130, 0x8cc466, 0.15, emitters, wind, leafTex);
  group.add(fx.points, gust.points);
  return {
    group,
    background: 0xcfe0cf,
    fog: [0xcfe0cf, 20, 52],
    sky: 0xf0fff0,
    ground: 0x4d6b3a,
    sun: 0xfff3d6,
    update(dt) {
      wind.update(dt);
      fx.update(dt);
      gust.update(dt);
    },
  };
}

function sakura(): Environment {
  setSeed(11);
  const wind = new Wind(3);
  const group = new THREE.Group();
  group.add(groundPlane(0x79a359), platform(), pathPlane(0xd9cbb8));

  const spots = scatter(30, { x: 5.2, z: 9.6 }, 22, -1);
  const grove = sakuraGrove(spots, [0xf7b7cf, 0xf9cde0, 0xf29bbd, 0xfbe0ea], 0x5b3a2c, wind);
  group.add(blobShadows(grove.shadows, 0.2), grove.trunks, grove.blobs);

  // 地上的落花
  const tex = petalTexture();
  group.add(groundPetals(600, 0xf6c3d6, 0.14, tex));

  group.add(
    stoneLanterns([
      [-5.4, -8.8],
      [5.4, -8.8],
    ]),
  );

  group.add(hedgeRow([0x5f9e46, 0xf29bbd, 0x6aa84f, 0xf7b7cf], 9.4, 5, wind));
  const fx = fallingParticles(260, 0xffc4da, 0.13, 13, 0.6, wind, tex);
  const gust = gustParticles(
    240,
    0xffb8d2,
    0.17,
    grove.canopy.filter((c) => c.z < 6),
    wind,
    tex,
  );
  group.add(fx.points, gust.points);
  return {
    group,
    background: 0xeadbe6,
    fog: [0xeadbe6, 22, 55],
    sky: 0xfff0f6,
    ground: 0x6d8c4f,
    sun: 0xffe8d8,
    update(dt) {
      wind.update(dt);
      fx.update(dt);
      gust.update(dt);
    },
  };
}

/**
 * 依名稱建場地：'indoor' | 'bamboo' | 'sakura' | 'night'（夜櫻）| 'market' | 'paddy'（稻田）| 'beach'。
 * 不認得的名稱一律退回室內。
 */
export function buildVenue(v: string): Environment {
  if (v === 'bamboo') return bamboo();
  if (v === 'sakura') return sakura();
  if (v === 'night') return nightGarden();
  if (v === 'market') return market();
  if (v === 'paddy') return paddy();
  if (v === 'beach') return beach();
  return indoor();
}
