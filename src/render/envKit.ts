import * as THREE from 'three';
import { merge, paint } from './geo';

/**
 * 場景共用小工具：可重現的亂數、程序貼圖、風（樹梢搖擺＋陣風）、樹影、飄落花瓣、石燈籠。
 * 全部一次建好；每幀只改 uniform／既有 buffer，不配置記憶體。
 */

// ---------- 可重現的亂數（同一個場地每次長得一樣）----------
let seed = 1;
export const setSeed = (n: number): void => {
  seed = Math.max(1, Math.floor(n));
};
export const rand = (): number => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};
export const range = (a: number, b: number): number => a + (b - a) * rand();

export interface Spot {
  x: number;
  z: number;
}

/** 在球場外圍（避開鏡頭正前方）隨機撒點 */
export function scatter(n: number, inner: Spot, outer: number, avoidNearSide = 10): Spot[] {
  const out: Spot[] = [];
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

export function groundPlane(color: number, size = 90): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshLambertMaterial({ color }));
  m.rotation.x = -Math.PI / 2;
  return m;
}

/** 戶外場地：球場墊下面的木平台 */
export function platform(color = 0x8d6a48): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(9.2, 0.12, 17.4), new THREE.MeshLambertMaterial({ color }));
  m.position.y = -0.068; // 頂面略低於球場墊，避免 z-fighting 蓋住球場
  return m;
}

/** 球場四周的淺色小徑 */
export function pathPlane(color: number): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(10.6, 18.6), new THREE.MeshLambertMaterial({ color }));
  m.rotation.x = -Math.PI / 2;
  m.position.y = 0.001;
  return m;
}

// ---------- 幾何小工具 ----------
export { merge, paint } from './geo';

/** 材質被 dispose 時一起釋放貼圖／InstancedMesh 的 instance buffer（scene.ts 只會 dispose 幾何與材質） */
export function disposeWith(mat: THREE.Material, ...extra: { dispose(): void }[]): void {
  mat.addEventListener('dispose', () => {
    for (const e of extra) e.dispose();
  });
}

// ---------- 程序貼圖 ----------
export function canvasTexture(w: number, h: number, draw: (g: CanvasRenderingContext2D) => void): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function radialTexture(stops: [number, string][]): THREE.CanvasTexture {
  return canvasTexture(64, 64, (g) => {
    const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    for (const [o, c] of stops) grad.addColorStop(o, c);
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  });
}

/** 柔邊黑色圓（樹影） */
export const shadowTexture = (): THREE.CanvasTexture =>
  radialTexture([
    [0, 'rgba(0,0,0,1)'],
    [0.45, 'rgba(0,0,0,0.7)'],
    [1, 'rgba(0,0,0,0)'],
  ]);

/** 柔邊白色光暈（燈籠光、螢火蟲、地上的光池） */
export const glowTexture = (): THREE.CanvasTexture =>
  radialTexture([
    [0, 'rgba(255,255,255,1)'],
    [0.18, 'rgba(255,255,255,0.75)'],
    [0.5, 'rgba(255,255,255,0.2)'],
    [1, 'rgba(255,255,255,0)'],
  ]);

/** 花瓣形狀（點精靈用，白色，由材質顏色上色） */
export const petalTexture = (): THREE.CanvasTexture =>
  canvasTexture(32, 32, (g) => {
    // 細長橢圓、尖端一個小缺口（不要畫成愛心）
    g.fillStyle = '#fff';
    g.beginPath();
    g.moveTo(16, 30);
    g.bezierCurveTo(7, 24, 8, 6, 14.5, 3);
    g.lineTo(16, 6);
    g.lineTo(17.5, 3);
    g.bezierCurveTo(24, 6, 25, 24, 16, 30);
    g.fill();
  });

// ---------- 風 ----------
/**
 * 微風一直在吹；每隔 7–15 秒來一陣強風（約 3–4 秒）。
 * time／gust 是 shader uniform 物件，同一個場地的所有搖擺材質共用。
 */
export class Wind {
  readonly time = { value: 0 };
  readonly gust = { value: 0 };
  /** 這一幀剛開始一陣風 */
  started = false;
  private left = 0;
  private dur = 1;
  private next: number;
  constructor(firstGust = 3.5) {
    this.next = firstGust;
  }
  update(dt: number): void {
    this.time.value += dt;
    this.started = false;
    if (this.left > 0) {
      this.left = Math.max(0, this.left - dt);
      const s = Math.sin(Math.PI * (1 - this.left / this.dur));
      this.gust.value = s * s;
    } else {
      this.gust.value = 0;
      this.next -= dt;
      if (this.next <= 0) {
        this.left = this.dur = 2.8 + Math.random() * 1.4;
        this.next = 7 + Math.random() * 8;
        this.started = true;
      }
    }
  }
}

const SWAY_VERTEX = /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_INSTANCING
	mvPosition = instanceMatrix * mvPosition;
	vec2 swayP = instanceMatrix[ 3 ].xz;
#else
	vec2 swayP = vec2( 0.0 );
#endif
{
	// 越高擺越多（二次方）；相位隨位置緩慢變化，相鄰的樹一起擺；陣風時往 +x 傾
	float sh = max( mvPosition.y - swayBase, 0.0 );
	float sk = sh * sh * swayAmp * ( 1.0 + 0.6 * swayGust );
	float ph = swayTime * 1.1 + swayP.x * 0.23 + swayP.y * 0.17;
	mvPosition.x += ( sin( ph ) + 0.35 * sin( ph * 2.3 + 1.7 ) + 0.8 * swayGust ) * sk;
	mvPosition.z += cos( ph * 0.77 + 0.4 ) * 0.5 * sk;
	// 葉子細碎抖動
	float fl = swayFlutter * ( 1.0 + 2.0 * swayGust );
	mvPosition.xyz += fl * vec3(
		sin( swayTime * 5.3 + mvPosition.y * 4.0 + swayP.x ),
		0.5 * sin( swayTime * 4.1 + mvPosition.x * 3.0 ),
		cos( swayTime * 4.7 + mvPosition.z * 4.0 + swayP.y ) );
}
mvPosition = modelViewMatrix * mvPosition;
gl_Position = projectionMatrix * mvPosition;
`;

/**
 * 讓材質隨風搖擺（vertex shader 小改：只動頂點位置，不加 draw call）。
 * amp：高度 h 公尺處的位移約 amp·h²；base：從這個高度以上才開始擺；flutter：葉子細碎抖動幅度。
 */
export function sway(mat: THREE.Material, wind: Wind, amp: number, base = 0, flutter = 0): void {
  const uAmp = { value: amp };
  const uBase = { value: base };
  const uFlutter = { value: flutter };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.swayTime = wind.time;
    sh.uniforms.swayGust = wind.gust;
    sh.uniforms.swayAmp = uAmp;
    sh.uniforms.swayBase = uBase;
    sh.uniforms.swayFlutter = uFlutter;
    sh.vertexShader =
      'uniform float swayTime;\nuniform float swayGust;\nuniform float swayAmp;\nuniform float swayBase;\nuniform float swayFlutter;\n' +
      sh.vertexShader.replace('#include <project_vertex>', SWAY_VERTEX);
  };
  mat.customProgramCacheKey = () => 'sway1';
}

// ---------- 樹影 ----------
export interface Blob {
  x: number;
  z: number;
  r: number;
}

/** 樹下的柔邊影子：一個 InstancedMesh（1 個 draw call），貼地、不寫深度 */
export function blobShadows(blobs: Blob[], opacity: number, color = 0x000000): THREE.InstancedMesh {
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  const tex = shadowTexture();
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, blobs.length));
  mesh.count = blobs.length;
  disposeWith(mat, tex, mesh);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  blobs.forEach((b, i) => {
    mesh.setMatrixAt(i, m.compose(p.set(b.x, 0.004, b.z), q, s.set(b.r * 2, 1, b.r * 2 * 0.85)));
  });
  mesh.renderOrder = -1; // 先畫，讓其他半透明物件疊在上面
  return mesh;
}

/** 地上的暖色光池（加法混色，假裝燈籠照亮地面） */
export function lightPools(blobs: Blob[], color: number, opacity: number): THREE.InstancedMesh {
  const geo = new THREE.PlaneGeometry(1, 1);
  geo.rotateX(-Math.PI / 2);
  const tex = glowTexture();
  const mat = new THREE.MeshBasicMaterial({
    map: tex,
    color,
    transparent: true,
    opacity,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -2,
  });
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, blobs.length));
  mesh.count = blobs.length;
  disposeWith(mat, tex, mesh);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const p = new THREE.Vector3();
  const s = new THREE.Vector3();
  blobs.forEach((b, i) => mesh.setMatrixAt(i, m.compose(p.set(b.x, 0.005, b.z), q, s.set(b.r * 2, 1, b.r * 2))));
  mesh.renderOrder = -1;
  return mesh;
}

// ---------- 飄落粒子 ----------
export interface Fx {
  update(dt: number): void;
}

/** 一直在飄的花瓣／竹葉；陣風時一起往 +x 吹 */
export function fallingParticles(
  count: number,
  color: number,
  size: number,
  area: number,
  fall: number,
  wind: Wind,
  tex: THREE.Texture,
  opacity = 0.9,
): { points: THREE.Points } & Fx {
  const pos = new Float32Array(count * 3);
  const phase = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = range(-area, area);
    pos[i * 3 + 1] = range(0, 9);
    pos[i * 3 + 2] = range(-area * 1.3, area * 0.8);
    phase[i] = range(0, Math.PI * 2);
  }
  const geo = new THREE.BufferGeometry();
  const attr = new THREE.BufferAttribute(pos, 3);
  attr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', attr);
  const mat = new THREE.PointsMaterial({ color, size, map: tex, transparent: true, opacity, depthWrite: false, alphaTest: 0.05 });
  disposeWith(mat, tex);
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  return {
    points,
    update(dt: number) {
      const t = wind.time.value;
      const g = wind.gust.value;
      for (let i = 0; i < count; i++) {
        const k = i * 3;
        pos[k] += (Math.sin(t * 0.9 + phase[i]) * 0.35 + 0.25 + g * 3.2) * dt;
        pos[k + 1] -= fall * (0.7 + 0.3 * Math.sin(phase[i]) - g * 0.35) * dt;
        pos[k + 2] += Math.cos(t * 0.7 + phase[i]) * 0.2 * dt;
        if (pos[k + 1] < 0.02 || pos[k] > area + 2) {
          pos[k] = range(-area, area);
          pos[k + 1] = range(7, 9.5);
          pos[k + 2] = range(-area * 1.3, area * 0.8);
        }
      }
      attr.needsUpdate = true;
    },
  };
}

/**
 * 陣風花瓣：一陣風來時，從樹冠一口氣吹出一大把花瓣／葉子橫越畫面，落地後消失。
 * 平常整組隱藏（不佔 draw call）。
 */
export function gustParticles(
  count: number,
  color: number,
  size: number,
  emitters: THREE.Vector3[],
  wind: Wind,
  tex: THREE.Texture,
  opacity = 0.95,
): { points: THREE.Points } & Fx {
  const pos = new Float32Array(count * 3).fill(-50);
  const vel = new Float32Array(count * 3);
  const delay = new Float32Array(count).fill(-1); // < 0 = 停用
  const phase = new Float32Array(count);
  for (let i = 0; i < count; i++) phase[i] = range(0, Math.PI * 2);
  const geo = new THREE.BufferGeometry();
  const attr = new THREE.BufferAttribute(pos, 3);
  attr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', attr);
  const mat = new THREE.PointsMaterial({ color, size, map: tex, transparent: true, opacity, depthWrite: false, alphaTest: 0.05 });
  disposeWith(mat, tex);
  const points = new THREE.Points(geo, mat);
  points.frustumCulled = false;
  points.visible = false;
  let live = 0;
  return {
    points,
    update(dt: number) {
      if (wind.started && emitters.length) {
        // 還在飛的那些繼續飛，只重新吹出已經落地的
        for (let i = 0; i < count; i++) {
          if (delay[i] >= 0) continue;
          const e = emitters[Math.floor(Math.random() * emitters.length)];
          const k = i * 3;
          pos[k] = e.x + (Math.random() - 0.5) * 2.6;
          pos[k + 1] = e.y + (Math.random() - 0.5) * 1.4;
          pos[k + 2] = e.z + (Math.random() - 0.5) * 2.6;
          vel[k] = 1.5 + Math.random() * 2;
          vel[k + 1] = Math.random() * 0.5;
          vel[k + 2] = (Math.random() - 0.5) * 1.2;
          delay[i] = Math.random() * 1.6;
          live++;
        }
        points.visible = live > 0;
      }
      if (!live) return;
      const t = wind.time.value;
      const g = wind.gust.value;
      const r = 1 - Math.exp(-1.6 * dt);
      for (let i = 0; i < count; i++) {
        if (delay[i] < 0) continue;
        const k = i * 3;
        if (delay[i] > 0) {
          delay[i] = Math.max(0, delay[i] - dt);
          continue;
        }
        // 速度往「風速」靠近；花瓣翻飛（左右、上下小擺動）
        vel[k] += (0.6 + 4.6 * g - vel[k]) * r;
        vel[k + 1] += (-0.55 + 0.5 * g - vel[k + 1]) * r;
        pos[k] += (vel[k] + Math.sin(t * 3.1 + phase[i]) * 0.5) * dt;
        pos[k + 1] += (vel[k + 1] + Math.sin(t * 4.3 + phase[i] * 2) * 0.35) * dt;
        pos[k + 2] += (vel[k + 2] + Math.cos(t * 2.7 + phase[i]) * 0.4) * dt;
        if (pos[k + 1] < 0.02 || pos[k] > 30) {
          pos[k] = pos[k + 1] = pos[k + 2] = -50;
          delay[i] = -1;
          live--;
        }
      }
      if (live <= 0) {
        live = 0;
        points.visible = false;
      }
      attr.needsUpdate = true;
    },
  };
}

// ---------- 石燈籠（全部燈籠合成 2 個 draw call）----------
export function stoneLanterns(spots: [number, number][], glowColor = 0xffd98a): THREE.Group {
  const g = new THREE.Group();
  const parts: [number, number, number, number][] = [
    // 寬、高、深、y
    [0.5, 0.15, 0.5, 0.075],
    [0.16, 0.7, 0.16, 0.5],
    [0.42, 0.12, 0.42, 0.91],
    [0.32, 0.3, 0.32, 1.12],
    [0.6, 0.12, 0.6, 1.33],
    [0.36, 0.1, 0.36, 1.43],
    [0.12, 0.08, 0.12, 1.52],
  ];
  const stoneGeo = merge(
    parts.map(([w, h, d, y]) => {
      const b = new THREE.BoxGeometry(w, h, d);
      b.translate(0, y, 0);
      return b;
    }),
  );
  const stoneMat = new THREE.MeshLambertMaterial({ color: 0x9a9690 });
  const stone = new THREE.InstancedMesh(stoneGeo, stoneMat, spots.length);
  const glowGeo = new THREE.BoxGeometry(0.22, 0.18, 0.34);
  glowGeo.translate(0, 1.12, 0);
  const glowMat = new THREE.MeshBasicMaterial({ color: glowColor });
  const glow = new THREE.InstancedMesh(glowGeo, glowMat, spots.length);
  disposeWith(stoneMat, stone);
  disposeWith(glowMat, glow);
  const m = new THREE.Matrix4();
  spots.forEach(([x, z], i) => {
    m.makeTranslation(x, 0, z);
    stone.setMatrixAt(i, m);
    glow.setMatrixAt(i, m);
  });
  g.add(stone, glow);
  return g;
}

// ---------- 櫻花樹 ----------
export interface Grove {
  trunks: THREE.InstancedMesh;
  blobs: THREE.InstancedMesh;
  canopy: THREE.Vector3[]; // 樹冠中心（陣風花瓣從這裡吹出）
  shadows: Blob[];
}

/** 一片櫻花樹：樹幹＋每棵 6 團花（各一個 InstancedMesh），隨風搖擺 */
export function sakuraGrove(spots: Spot[], pinks: number[], trunkColor: number, wind: Wind, emissive = 0x000000): Grove {
  const trunkGeo = new THREE.CylinderGeometry(0.16, 0.28, 1, 7, 3);
  trunkGeo.translate(0, 0.5, 0);
  const trunkMat = new THREE.MeshLambertMaterial({ color: trunkColor });
  sway(trunkMat, wind, 0.006, 0.6);
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, spots.length);
  const blobMat = new THREE.MeshLambertMaterial({ flatShading: true, emissive });
  sway(blobMat, wind, 0.006, 0.6, 0.025);
  const blobs = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), blobMat, spots.length * 6);
  disposeWith(trunkMat, trunks);
  disposeWith(blobMat, blobs);
  const cols = pinks.map((x) => new THREE.Color(x));
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const p = new THREE.Vector3();
  const canopy: THREE.Vector3[] = [];
  const shadows: Blob[] = [];
  spots.forEach((pt, i) => {
    const h = range(2.6, 4);
    m.compose(p.set(pt.x, 0, pt.z), q.identity(), s.set(1, h, 1));
    trunks.setMatrixAt(i, m);
    for (let j = 0; j < 6; j++) {
      const r = range(1.1, 1.9);
      m.compose(p.set(pt.x + range(-1.6, 1.6), h + range(-0.2, 1.6), pt.z + range(-1.6, 1.6)), q.identity(), s.set(r, r * 0.8, r));
      blobs.setMatrixAt(i * 6 + j, m);
      blobs.setColorAt(i * 6 + j, cols[Math.floor(rand() * cols.length)]);
    }
    canopy.push(new THREE.Vector3(pt.x, h + 0.8, pt.z));
    // 影子稍微往光源反方向（太陽在 +x +z 上方）偏；不吃亂數，樹的排列跟以前一樣
    shadows.push({ x: pt.x - h * 0.18, z: pt.z - h * 0.25, r: 2.1 + (i % 3) * 0.2 });
  });
  return { trunks, blobs, canopy, shadows };
}

/** 散落在球場外地面上的花瓣（靜止的點精靈） */
export function groundPetals(count: number, color: number, size: number, tex: THREE.Texture): THREE.Points {
  const pp = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
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
  const mat = new THREE.PointsMaterial({ color, size, map: tex, transparent: true, alphaTest: 0.05, depthWrite: false });
  disposeWith(mat, tex);
  return new THREE.Points(pg, mat);
}

/** 鏡頭前方（畫面下方、搖桿底下）的低矮灌木帶，不會擋到球場；給 wind 就會輕輕晃 */
export function hedgeRow(colors: number[], z0: number, seedN: number, wind?: Wind): THREE.InstancedMesh {
  setSeed(seedN);
  const n = 46;
  const mat = new THREE.MeshLambertMaterial({ flatShading: true });
  if (wind) sway(mat, wind, 0.05, 0, 0.012);
  const mesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.5, 1), mat, n);
  disposeWith(mat, mesh);
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

// ---------- 合併靜態零件（一整個場地的道具 = 1 個 draw call）----------
const _mat4 = new THREE.Matrix4();
const _eul = new THREE.Euler();
const _vec = new THREE.Vector3();
const _fc = new THREE.Color();

/** 轉成非索引、拿掉 uv、塗單色：任何形狀的零件都能 merge 在一起 */
export function solid(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (g !== geo) geo.dispose();
  if (g.getAttribute('uv')) g.deleteAttribute('uv');
  if (g.getAttribute('uv1')) g.deleteAttribute('uv1');
  return paint(g, hex);
}

/** 依每個三角形的中心點（零件自己的座標）決定顏色：條紋遮陽棚、彩色洋傘、海灘球 */
export function paintFaces(geo: THREE.BufferGeometry, fn: (x: number, y: number, z: number) => number): THREE.BufferGeometry {
  const g = solid(geo, 0xffffff);
  const p = g.attributes.position;
  const c = g.attributes.color;
  for (let i = 0; i + 2 < p.count; i += 3) {
    const x = (p.getX(i) + p.getX(i + 1) + p.getX(i + 2)) / 3;
    const y = (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3;
    const z = (p.getZ(i) + p.getZ(i + 1) + p.getZ(i + 2)) / 3;
    _fc.set(fn(x, y, z));
    for (let k = 0; k < 3; k++) c.setXYZ(i + k, _fc.r, _fc.g, _fc.b);
  }
  return g;
}

/**
 * 靜態道具收集器：at() 設定目前的擺放座標系（位置＋繞 Y 轉），之後加的零件都放進這個座標系；
 * build() 把全部零件合併成一個頂點色幾何。
 */
export class Parts {
  private readonly list: THREE.BufferGeometry[] = [];
  private readonly frame = new THREE.Matrix4();

  at(x: number, z: number, ry = 0, y = 0, s = 1): this {
    this.frame.makeRotationY(ry).scale(_vec.set(s, s, s)).setPosition(x, y, z);
    return this;
  }
  /** 已經上好色（solid / paintFaces）的零件 */
  raw(g: THREE.BufferGeometry): THREE.BufferGeometry {
    g.applyMatrix4(this.frame);
    this.list.push(g);
    return g;
  }
  add(geo: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
    return this.raw(solid(geo, color));
  }
  /** 盒子：先依 rx/ry/rz 旋轉、再移到 (x, y, z) */
  box(w: number, h: number, d: number, x: number, y: number, z: number, color: number, rx = 0, ry = 0, rz = 0): THREE.BufferGeometry {
    const g = new THREE.BoxGeometry(w, h, d);
    if (rx || ry || rz) g.applyMatrix4(_mat4.makeRotationFromEuler(_eul.set(rx, ry, rz)));
    return this.add(g.translate(x, y, z), color);
  }
  /** 直立圓柱（seg 邊形），底部在 y */
  cyl(rTop: number, rBot: number, h: number, seg: number, x: number, y: number, z: number, color: number): THREE.BufferGeometry {
    return this.add(new THREE.CylinderGeometry(rTop, rBot, h, seg).translate(x, y + h / 2, z), color);
  }
  /** 低面數圓球（可壓扁） */
  ball(r: number, x: number, y: number, z: number, color: number, sx = 1, sy = 1, sz = 1, detail = 1): THREE.BufferGeometry {
    return this.add(new THREE.IcosahedronGeometry(r, detail).scale(sx, sy, sz).translate(x, y, z), color);
  }
  get count(): number {
    return this.list.length;
  }
  build(): THREE.BufferGeometry {
    return merge(this.list.splice(0));
  }
}

// ---------- shader 用的雜訊（沒有 sin，手機上精度比較穩）----------
export const GLSL_NOISE = /* glsl */ `
float kHash( vec2 p ) {
	p = fract( p * vec2( 123.34, 456.21 ) );
	p += dot( p, p + 45.32 );
	return fract( p.x * p.y );
}
float kNoise( vec2 p ) {
	vec2 i = floor( p );
	vec2 f = fract( p );
	vec2 u = f * f * ( 3.0 - 2.0 * f );
	return mix( mix( kHash( i ), kHash( i + vec2( 1.0, 0.0 ) ), u.x ), mix( kHash( i + vec2( 0.0, 1.0 ) ), kHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
`;

// ---------- 飛鳥（海鷗、白鷺）----------
export interface BirdPath {
  cx: number; // 繞圈中心
  cz: number;
  r: number; // 半徑
  y: number; // 高度
  speed: number; // 公尺／秒
  dir: 1 | -1; // 繞圈方向
  phase: number;
}

/**
 * 一群繞圈滑翔的鳥：一個 InstancedMesh（1 個 draw call）。
 * 拍翅膀在 vertex shader 裡做（離身體越遠的頂點上下擺越多），一下拍、一下滑翔；每幀只更新幾個 instance 矩陣。
 */
export function flyingBirds(
  paths: BirdPath[],
  colors: { body: number; wing: number; tip: number; beak: number },
  span: number,
  wind: Wind,
): { mesh: THREE.InstancedMesh; update(): void } {
  // 鳥的座標：往 +z 飛、翅膀沿 x 展開，翼展 = 1（之後整個縮放成 span）
  const wing = (s: 1 | -1): THREE.BufferGeometry[] => {
    const rf = [0.03 * s, 0, 0.07];
    const rb = [0.03 * s, 0, -0.08];
    const ef = [0.25 * s, 0.03, 0.05];
    const eb = [0.25 * s, 0.03, -0.09];
    const tip = [0.5 * s, 0, -0.13];
    const tri = (pts: number[][], color: number) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3));
      g.computeVertexNormals();
      return paint(g, color);
    };
    return [tri([rf, ef, rb], colors.wing), tri([rb, ef, eb], colors.wing), tri([ef, tip, eb], colors.tip)];
  };
  const body = new THREE.OctahedronGeometry(1, 0).scale(0.05, 0.045, 0.22);
  const head = new THREE.IcosahedronGeometry(0.05, 0).translate(0, 0.03, 0.21);
  const beak = new THREE.ConeGeometry(0.016, 0.08, 4).rotateX(Math.PI / 2).translate(0, 0.025, 0.29);
  const tail = new THREE.ConeGeometry(0.05, 0.14, 3).rotateX(-Math.PI / 2).scale(1, 0.3, 1).translate(0, 0, -0.24);
  const geo = merge([
    solid(body, colors.body),
    solid(head, colors.body),
    solid(beak, colors.beak),
    solid(tail, colors.body),
    ...wing(1),
    ...wing(-1),
  ]).scale(span, span, span);
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.birdTime = wind.time;
    sh.vertexShader =
      'uniform float birdTime;\n' +
      sh.vertexShader.replace(
        '#include <begin_vertex>',
        /* glsl */ `#include <begin_vertex>
#ifdef USE_INSTANCING
	float bph = float( gl_InstanceID ) * 2.13;
#else
	float bph = 0.0;
#endif
	// 一陣子拍翅、一陣子滑翔
	float bflap = sin( birdTime * 8.5 + bph ) * ( 0.12 + 0.88 * smoothstep( -0.2, 0.4, sin( birdTime * 0.45 + bph ) ) );
	transformed.y += bflap * abs( transformed.x ) * 1.1;`,
      );
  };
  mat.customProgramCacheKey = () => 'birds1';
  const mesh = new THREE.InstancedMesh(geo, mat, paths.length);
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.frustumCulled = false;
  disposeWith(mat, mesh);
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler(0, 0, 0, 'YXZ');
  const p = new THREE.Vector3();
  const s = new THREE.Vector3(1, 1, 1);
  const update = () => {
    const t = wind.time.value;
    for (let i = 0; i < paths.length; i++) {
      const b = paths[i];
      const a = b.phase + (t * b.speed * b.dir) / b.r;
      p.set(b.cx + b.r * Math.cos(a), b.y + 0.35 * Math.sin(t * 0.6 + i * 1.7), b.cz + b.r * Math.sin(a));
      // 朝切線方向飛，往圓心那側傾斜
      e.set(0, Math.atan2(-Math.sin(a) * b.dir, Math.cos(a) * b.dir), 0.3 * b.dir);
      mesh.setMatrixAt(i, m.compose(p, q.setFromEuler(e), s));
    }
    mesh.instanceMatrix.needsUpdate = true;
  };
  update();
  return { mesh, update };
}
