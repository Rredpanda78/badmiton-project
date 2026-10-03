import * as THREE from 'three';
import {
  blobShadows,
  disposeWith,
  fallingParticles,
  groundPetals,
  groundPlane,
  gustParticles,
  hedgeRow,
  lightWash,
  merge,
  paint,
  Parts,
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
  sun: number; // 主光源顏色（會投影：太陽／月亮／天花板燈）
  /** 主光從哪個方向照過來（往光源的向量，scene.ts 會正規化）；省略 = 左前上方、仰角約 57°。影子落在反方向：右邊、偏向鏡頭 */
  sunDir?: [number, number, number];
  sunPower?: number; // 主光強度（省略 = 1.6）
  fill?: [number, number]; // 補光（從鏡頭這側打、不投影）：顏色、強度；省略 = 淡藍白 0.7
  update(dt: number): void;
}

/** buildVenue 認得的場地（'night' = 夜櫻庭園、'paddy' = 稻田） */
export const VENUE_IDS = ['indoor', 'bamboo', 'sakura', 'night', 'market', 'paddy', 'beach'] as const;
export type VenueId = (typeof VENUE_IDS)[number];

/** 室內球館的天花板燈：兩排、每排 3 盞，高 9.6 m（直向鏡頭只在畫面最上緣看得到遠端那排、回放的低角度鏡頭看得到全部） */
const LAMP_Y = 9.6;
const LAMP_SPOTS: [number, number][] = [
  [-2.9, -5.4],
  [2.9, -5.4],
  [-2.9, 0],
  [2.9, 0],
  [-2.9, 5.4],
  [2.9, 5.4],
];

/**
 * 室內球館：深色地板、天花板、天花板燈（深灰燈罩＋自發光燈片＋往下散開的淡光錐，加法混色）、
 * 燈下的光池（乘法混色把地墊照亮）。主光從近乎正上方打下來（影子短、在腳邊），像體育館的燈。
 */
function indoor(): Environment {
  const group = new THREE.Group();
  group.add(groundPlane(0x24313f));
  // 天花板：一大片深色平面（面朝下），遠處被霧吃掉，近處看得出房間有頂
  const ceiling = new THREE.Mesh(new THREE.PlaneGeometry(46, 60), new THREE.MeshLambertMaterial({ color: 0x1a2230 }));
  ceiling.rotation.x = Math.PI / 2;
  ceiling.position.y = LAMP_Y + 0.9;
  group.add(ceiling);
  group.add(...indoorLamps(), lightWash(LAMP_SPOTS.map(([x, z]) => ({ x, z, r: 4.4 })), 0xfff0d6, 0.3));
  return {
    group,
    background: 0x111a26,
    fog: [0x111a26, 26, 48],
    sky: 0xe6eeff,
    ground: 0x2a3442,
    sun: 0xfff1dc, // 天花板燈：微暖的白
    sunDir: [-0.22, 1, -0.3], // 近乎正上方（仰角約 70°）
    sunPower: 1.5,
    fill: [0xdde6f5, 0.75],
    update() {},
  };
}

/** 天花板燈：燈罩（1 個 Lambert mesh）、燈片（1 個不受光的亮 mesh）、光錐（1 個加法混色 mesh，頂點 alpha 往下淡出） */
function indoorLamps(): THREE.Mesh[] {
  const housing = new Parts();
  const panels: THREE.BufferGeometry[] = [];
  const cones: THREE.BufferGeometry[] = [];
  const CONE_H = 4.2;
  for (const [x, z] of LAMP_SPOTS) {
    housing.at(x, z, 0, LAMP_Y);
    housing.box(1.3, 0.14, 1.3, 0, 0.07, 0, 0x2a3442);
    housing.box(0.08, 0.9, 0.08, 0, 0.59, 0, 0x1c2531); // 吊桿
    panels.push(paint(new THREE.BoxGeometry(1.1, 0.03, 1.1).translate(x, LAMP_Y - 0.015, z), 0xfff2dc));
    // 光錐：燈片往下 CONE_H 公尺、半徑從 0.55 張到 1.9，alpha 從 0.11 淡到 0（開口圓柱，兩面都畫）
    const cone = new THREE.CylinderGeometry(0.55, 1.9, CONE_H, 14, 1, true).translate(x, LAMP_Y - CONE_H / 2, z);
    const p = cone.attributes.position;
    const col = new Float32Array(p.count * 4);
    for (let i = 0; i < p.count; i++) {
      const u = (p.getY(i) - (LAMP_Y - CONE_H)) / CONE_H; // 0 = 錐底、1 = 燈片
      col.set([1, 0.92, 0.76, 0.11 * u * u], i * 4);
    }
    cone.setAttribute('color', new THREE.BufferAttribute(col, 4));
    cones.push(cone);
  }
  const housingMesh = new THREE.Mesh(housing.build(), new THREE.MeshLambertMaterial({ vertexColors: true }));
  const panelMesh = new THREE.Mesh(merge(panels), new THREE.MeshBasicMaterial({ vertexColors: true }));
  const coneMesh = new THREE.Mesh(
    merge(cones),
    new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, fog: false }),
  );
  coneMesh.renderOrder = -1;
  return [housingMesh, panelMesh, coneMesh];
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
    // 竹叢下的斑駁陰影（很淡，疊在一起就是林下的暗處；往光源反方向 +x、+z 偏）
    shadows.push({ x: pt.x + 0.7, z: pt.z + 1, r: 1.0 + (i % 4) * 0.12 });
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
    sunDir: [-0.55, 1, -0.45], // 竹林間漏下來的陽光：仰角約 55°
    sunPower: 1.5,
    fill: [0xd9ead2, 0.7], // 綠色的反射光
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
    sunDir: [-0.5, 1, -0.4], // 春天近午的太陽：仰角約 57°
    fill: [0xffe4ee, 0.7], // 櫻花的粉色反射光
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
