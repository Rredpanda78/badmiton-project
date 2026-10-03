import * as THREE from 'three';
import { COURT } from '../config';
import { merge, paint } from './geo';

const PX = 128; // 每公尺像素
const MAT_W = 7.6;
const MAT_L = 15.6;
const NET_SAG = 0.05; // 網子中間比柱子邊低多少（真實約 2.6 cm，放大一點才看得出來）
const TAPE_H = 0.06; // 網頂白色布邊高度
const UMPIRE_X = -(COURT.doublesHalfWidth + 1.25); // 主審椅（網子延長線上、左側）
const JUDGE: [number, number] = [COURT.doublesHalfWidth + 0.7, 0.35]; // 發球裁判凳（右側網柱旁）

/**
 * 球場：地墊（canvas 貼圖：白線、紋理、接縫、包邊）＋接觸陰影＋網子＋網柱／裁判椅。
 * 全部 4 個 draw call：地墊、陰影（外框＋腳下軟影）、網面＋布邊（不打光）、所有實心配件（頂點色合併成一個幾何）。
 */
export function makeCourt(maxAniso: number): THREE.Object3D {
  const group = new THREE.Group();
  group.add(makeMat(maxAniso), makeLines(), makeShadows(), makeNet(), makeFixtures(), makeGuyLines());
  return group;
}

// ---------- 網柱的拉繩：柱頂往外拉到地上的錨點（兩條線，一個 draw call；觸網時會跟著微微晃）----------
function makeGuyLines(): THREE.LineSegments {
  const W = COURT.doublesHalfWidth;
  const top = netTopAt(W) + 0.03;
  const pts: number[] = [];
  for (const x of [-W, W]) pts.push(x, top, 0, x + Math.sign(x) * 0.62, 0.02, 0);
  const geo = new THREE.BufferGeometry();
  const attr = new THREE.Float32BufferAttribute(pts, 3);
  attr.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', attr);
  const mesh = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: 0xd8dde3, transparent: true, opacity: 0.75 }));
  mesh.name = 'guyLines';
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * 觸網：羽球打到網子或布邊時，網子上緣以擊中點為中心前後擺動（越往下越不動，兩側越遠越小），約 0.4 秒內衰減；
 * 網柱的拉繩也跟著微微晃。只改既有 buffer 的頂點位置（網面＋布邊約 500 個頂點），沒有新的 draw call。
 */
export class NetWobble {
  private net: THREE.Mesh | null;
  private guy: THREE.LineSegments | null;
  private base: Float32Array = new Float32Array(0); // 網子原本的頂點
  private weight: Float32Array = new Float32Array(0); // 每個頂點擺多少（0 = 底部 … 1 = 上緣）
  private guyBase: Float32Array = new Float32Array(0);
  private t = 1; // 從擊中起算的秒數（> DUR = 靜止）
  private x0 = 0;
  private amp = 0;
  private static readonly DUR = 0.45;

  constructor(court: THREE.Object3D) {
    this.net = (court.getObjectByName('net') as THREE.Mesh | undefined) ?? null;
    this.guy = (court.getObjectByName('guyLines') as THREE.LineSegments | undefined) ?? null;
    if (this.net) {
      const p = this.net.geometry.attributes.position as THREE.BufferAttribute;
      p.setUsage(THREE.DynamicDrawUsage);
      this.base = new Float32Array(p.array as Float32Array);
      this.weight = new Float32Array(p.count);
      const depth = 0.76;
      for (let i = 0; i < p.count; i++) {
        const x = this.base[i * 3];
        const y = this.base[i * 3 + 1];
        const w = Math.max(0, Math.min(1, (y - (netTopAt(x) - depth)) / depth));
        this.weight[i] = w * w;
      }
    }
    if (this.guy) this.guyBase = new Float32Array((this.guy.geometry.attributes.position as THREE.BufferAttribute).array as Float32Array);
  }

  /** 羽球打到網子：x = 擊中點（沿網子）、amp = 擺幅（m） */
  hit(x: number, amp = 0.045): void {
    this.x0 = x;
    this.amp = this.t < NetWobble.DUR ? Math.max(amp, this.amp) : amp;
    this.t = 0;
  }

  update(dt: number): void {
    if (this.t >= NetWobble.DUR) return;
    const net = this.net;
    if (!net) return;
    this.t += dt;
    const p = net.geometry.attributes.position as THREE.BufferAttribute;
    const arr = p.array as Float32Array;
    const done = this.t >= NetWobble.DUR;
    // 5.5 Hz 的擺動、0.14 秒的時間常數衰減；擊中點附近最大、沿網子每 0.8 m 衰減 e 倍
    const osc = done ? 0 : this.amp * Math.sin(2 * Math.PI * 5.5 * this.t) * Math.exp(-this.t / 0.14);
    const dip = done ? 0 : this.amp * 0.35 * Math.min(1, this.t / 0.05) * Math.exp(-this.t / 0.25);
    for (let i = 0; i < p.count; i++) {
      const w = this.weight[i];
      const k = i * 3;
      if (w === 0) {
        arr[k + 2] = this.base[k + 2];
        continue;
      }
      const g = w * Math.exp(-Math.abs(this.base[k] - this.x0) / 0.8);
      arr[k + 1] = this.base[k + 1] - dip * g;
      arr[k + 2] = this.base[k + 2] + osc * g;
    }
    p.needsUpdate = true;
    if (this.guy) {
      const gp = this.guy.geometry.attributes.position as THREE.BufferAttribute;
      const ga = gp.array as Float32Array;
      ga.set(this.guyBase);
      // 兩條拉繩的頂端（第 0、2 個頂點）跟著柱頂的拉力微微前後晃
      for (const vi of [0, 2]) {
        const g = Math.exp(-Math.abs(this.guyBase[vi * 3] - this.x0) / 2.5);
        ga[vi * 3 + 2] = this.guyBase[vi * 3 + 2] + osc * 0.35 * g;
      }
      gp.needsUpdate = true;
    }
  }
}

// ---------- 白線 ----------

const LINE_W = 0.065; // 最近那條底線的線寬（真實 4 cm，加粗比較好認）
const LINE_COMP = 0.6; // 遠處加粗的程度：0 = 照真實透視（遠線細到快看不見）、1 = 螢幕上一樣粗
const REF_CAM = { y: 10.8, z: 13.2 }; // 以直向鏡頭估算遠近

/**
 * 球場白線：幾何長條（多重取樣抗鋸齒，每條邊緣一致），全部同樣白。
 * 遠處的線照透視會細很多（橫線再加上斜看又更扁），所以依離鏡頭距離加粗一部分，看起來比較均勻。
 */
function makeLines(): THREE.Mesh {
  const W = COURT.doublesHalfWidth;
  const S = COURT.singlesHalfWidth;
  const L = COURT.halfLength;
  const LS = COURT.doublesLongService;
  const SS = COURT.shortService;
  const dist = (x: number, z: number) => Math.hypot(x, REF_CAM.y, REF_CAM.z - z);
  const d0 = dist(0, L);
  // 橫線（沿 x）在螢幕上的厚度 ∝ 1/距離²；直線（沿 z）的寬度 ∝ 1/距離
  const widthAt = (x: number, z: number, across: boolean) => {
    const r = dist(x, z) / d0;
    return LINE_W * Math.min(2.4, Math.pow(across ? r * r : r, LINE_COMP));
  };
  const pos: number[] = [];
  const idx: number[] = [];
  const seg = (x1: number, z1: number, x2: number, z2: number) => {
    const len = Math.hypot(x2 - x1, z2 - z1);
    const across = Math.abs(x2 - x1) > Math.abs(z2 - z1);
    const nx = -(z2 - z1) / len;
    const nz = (x2 - x1) / len;
    const n = Math.max(1, Math.ceil(len / 0.5));
    const base = pos.length / 3;
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const x = x1 + (x2 - x1) * u;
      const z = z1 + (z2 - z1) * u;
      const h = widthAt(x, z, across) / 2;
      // 兩端各多延伸半個線寬，轉角才會補滿
      const ext = i === 0 ? -h : i === n ? h : 0;
      const ex = x + ((x2 - x1) / len) * ext;
      const ez = z + ((z2 - z1) / len) * ext;
      pos.push(ex + nx * h, 0, ez + nz * h, ex - nx * h, 0, ez - nz * h);
      if (i > 0) {
        const a = base + (i - 1) * 2;
        idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); // 逆時針（從上面看）= 正面朝上
      }
    }
  };
  // 雙打外框、後發球線（真實球場一樣是白線）
  seg(-W, -L, -W, L);
  seg(W, -L, W, L);
  seg(-W, -LS, W, -LS);
  seg(-W, LS, W, LS);
  // 單打邊線、底線、前發球線、中線
  seg(-W, -L, W, -L);
  seg(-W, L, W, L);
  seg(-S, -L, -S, L);
  seg(S, -L, S, L);
  seg(-W, -SS, W, -SS);
  seg(-W, SS, W, SS);
  seg(0, -L, 0, -SS);
  seg(0, SS, 0, L);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  const mat = new THREE.MeshLambertMaterial({ color: 0xf4f7f2, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = 0.004;
  mesh.name = 'courtLines';
  mesh.receiveShadow = true; // 白線也要接球員的影子（不然影子裡的線會亮得像發光）
  return mesh;
}

// ---------- 地墊 ----------

/** 小塊雜訊（地墊顆粒），用 pattern 鋪滿 */
function noiseTile(size: number, seed: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const img = g.createImageData(size, size);
  let s = seed;
  const rnd = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
  for (let i = 0; i < size * size; i++) {
    const v = rnd();
    const k = i * 4;
    img.data[k] = img.data[k + 1] = img.data[k + 2] = v > 0.5 ? 255 : 0;
    img.data[k + 3] = Math.round(Math.abs(v - 0.5) * 2 * 255);
  }
  g.putImageData(img, 0, 0);
  return c;
}

function makeMat(maxAniso: number): THREE.Mesh {
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(MAT_W * PX);
  canvas.height = Math.round(MAT_L * PX);
  const g = canvas.getContext('2d')!;
  const toX = (x: number) => (x + MAT_W / 2) * PX;
  const toY = (z: number) => (z + MAT_L / 2) * PX;
  const W = COURT.doublesHalfWidth;
  const S = COURT.singlesHalfWidth;
  const L = COURT.halfLength;

  g.fillStyle = '#2f7d5d';
  g.fillRect(0, 0, canvas.width, canvas.height);
  // 單打場區稍微亮一點，讓界線一眼看得出來
  g.fillStyle = '#35896a';
  g.fillRect(toX(-S), toY(-L), S * 2 * PX, L * 2 * PX);

  // 很淡的大面積明暗（中間略亮、四周略暗），地墊才不會像一張平貼紙
  const vg = g.createRadialGradient(toX(0), toY(0), PX * 2, toX(0), toY(0), PX * 9);
  vg.addColorStop(0, 'rgba(255,255,255,0.05)');
  vg.addColorStop(1, 'rgba(0,0,0,0.10)');
  g.fillStyle = vg;
  g.fillRect(0, 0, canvas.width, canvas.height);

  // 沿長邊的細紋（PVC 地墊壓紋）
  for (let x = 0; x < canvas.width; x += 3) {
    const a = 0.018 * Math.sin(x * 0.37) * Math.sin(x * 0.051);
    g.fillStyle = a > 0 ? `rgba(255,255,255,${(0.012 + a).toFixed(3)})` : `rgba(0,0,0,${(0.012 - a).toFixed(3)})`;
    g.fillRect(x, 0, 1, canvas.height);
  }
  // 顆粒
  const grain = g.createPattern(noiseTile(96, 12345), 'repeat')!;
  g.globalAlpha = 0.07;
  g.fillStyle = grain;
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.globalAlpha = 1;

  // 三捲地墊的接縫：一條暗線＋旁邊一條亮線（不放在中線上，免得被看成界線）
  for (const sx of [-1.3, 1.3]) {
    g.fillStyle = 'rgba(0,0,0,0.14)';
    g.fillRect(toX(sx) - 1.5, 0, 3, canvas.height);
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillRect(toX(sx) + 1.5, 0, 2, canvas.height);
  }

  // 網子的淡影（主光從左前上方 −x、−z 照下來，影子落在近側 +z）
  {
    const z0 = toY(0.05);
    const z1 = toY(0.95);
    const sg = g.createLinearGradient(0, z0, 0, z1);
    sg.addColorStop(0, 'rgba(0,0,0,0.02)');
    sg.addColorStop(0.7, 'rgba(0,0,0,0.1)');
    sg.addColorStop(0.82, 'rgba(0,0,0,0.14)');
    sg.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = sg;
    g.fillRect(toX(-W + 0.45), z0, W * 2 * PX, z1 - z0);
  }

  // 白線改用幾何（makeLines），貼圖縮小時才不會有的粗有的細
  // ---- 地墊包邊：外圈深色收邊＋一條亮的斜角線（看起來有厚度）----
  const b = 0.07 * PX;
  g.strokeStyle = '#1d5541';
  g.lineWidth = b * 2;
  g.strokeRect(0, 0, canvas.width, canvas.height);
  g.strokeStyle = 'rgba(255,255,255,0.16)';
  g.lineWidth = 2;
  g.strokeRect(b + 1, b + 1, canvas.width - 2 * b - 2, canvas.height - 2 * b - 2);
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.lineWidth = 3;
  g.strokeRect(1.5, 1.5, canvas.width - 3, canvas.height - 3);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  // Phong：PVC 地墊有一點點光澤（低 shininess = 很寬很淡的反光帶，主光在對面時中場略亮）；只有這一片，成本可忽略
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(MAT_W, MAT_L), new THREE.MeshPhongMaterial({ map: tex, specular: 0x2a2a2a, shininess: 14 }));
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.002;
  mesh.name = 'courtMat';
  mesh.receiveShadow = true; // 球員、球拍、羽球的即時影子落在這裡
  return mesh;
}

/**
 * 接觸陰影：地墊外緣一圈柔邊（地墊像是鋪在地上、有厚度），
 * 加上網柱底座、主審椅、發球裁判凳腳下的圓形軟影。頂點色 alpha 漸層，一個 mesh。
 */
function makeShadows(): THREE.Mesh {
  const w = MAT_W / 2;
  const l = MAT_L / 2;
  const o = 0.32;
  const pos: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const vert = (x: number, z: number, a: number) => {
    pos.push(x, 0, z);
    col.push(0, 0, 0, a);
    return pos.length / 3 - 1;
  };
  const inner = [vert(-w, -l, 0.42), vert(w, -l, 0.42), vert(w, l, 0.42), vert(-w, l, 0.42)];
  const outer = [vert(-w - o, -l - o, 0), vert(w + o, -l - o, 0), vert(w + o, l + o, 0), vert(-w - o, l + o, 0)];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    idx.push(inner[i], outer[i], outer[j], inner[i], outer[j], inner[j]);
  }
  const blob = (x: number, z: number, rx: number, rz: number, a: number) => {
    const c = vert(x, z, a);
    const N = 12;
    const first = pos.length / 3;
    for (let i = 0; i < N; i++) {
      const t = (i / N) * Math.PI * 2;
      vert(x + Math.cos(t) * rx, z + Math.sin(t) * rz, 0);
    }
    for (let i = 0; i < N; i++) idx.push(c, first + ((i + 1) % N), first + i);
  };
  const W = COURT.doublesHalfWidth;
  for (const x of [-W, W]) blob(x + 0.05, 0.04, 0.34, 0.34, 0.5);
  blob(UMPIRE_X, 0, 0.62, 0.55, 0.38);
  blob(JUDGE[0], JUDGE[1], 0.36, 0.36, 0.34);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  geo.setIndex(idx);
  const mesh = new THREE.Mesh(
    geo,
    new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide }),
  );
  mesh.position.y = 0.003; // 地墊（0.002）之上、球員影子（0.006）之下
  mesh.renderOrder = -2;
  return mesh;
}

// ---------- 網子 ----------

/** 網頂高度：中間 = netTop，往兩邊柱子拉高（下垂的弧線） */
const netTopAt = (x: number) => COURT.netTop + NET_SAG * (x / COURT.doublesHalfWidth) ** 2;

const NET_ROWS = 128; // 網面用的貼圖高度
const SWATCH = 8; // 貼圖最底下幾列：布邊用的色塊（白、淺灰、灰）

function makeNet(): THREE.Mesh {
  const W = COURT.doublesHalfWidth;
  const depth = 0.76;

  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = NET_ROWS + SWATCH;
  const g = canvas.getContext('2d')!;
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.strokeStyle = 'rgba(20,24,30,0.85)';
  g.lineWidth = 1.5;
  const cell = 9;
  for (let x = 0; x <= canvas.width; x += cell) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, NET_ROWS);
    g.stroke();
  }
  for (let y = 0; y <= NET_ROWS; y += cell) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(canvas.width, y);
    g.stroke();
  }
  // 兩側的邊條與底下的繩子
  g.fillStyle = 'rgba(236,240,244,0.9)';
  g.fillRect(0, 0, 7, NET_ROWS);
  g.fillRect(canvas.width - 7, 0, 7, NET_ROWS);
  g.fillStyle = 'rgba(20,24,30,0.95)';
  g.fillRect(0, NET_ROWS - 4, canvas.width, 4);
  // 布邊色塊：上面最亮、正反面、底面偏灰（不受燈光影響，任何場地都是清楚的白）
  g.clearRect(0, NET_ROWS, canvas.width, SWATCH);
  ['#ffffff', '#eceeec', '#b4bac2'].forEach((c, i) => {
    g.fillStyle = c;
    g.fillRect(i * 256, NET_ROWS, 256, SWATCH);
  });
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;

  // 網面細分成一欄欄，上緣跟著下垂；貼圖只取上面 NET_ROWS 列
  const SEG = 24;
  const net = new THREE.PlaneGeometry(W * 2, depth, SEG, 1);
  const p = net.attributes.position;
  const uv = net.attributes.uv;
  const v0 = SWATCH / canvas.height;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i);
    const yTop = netTopAt(x) - TAPE_H * 0.5;
    p.setY(i, p.getY(i) > 0 ? yTop : yTop - depth + TAPE_H * 0.5 + NET_SAG * 0.3 * (1 - (x / W) ** 2));
    uv.setY(i, v0 + uv.getY(i) * (1 - v0));
  }
  const tape = netTape((k) => [(k * 256 + 128) / canvas.width, SWATCH / 2 / canvas.height]);
  const mesh = new THREE.Mesh(
    merge([net, tape]),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false }),
  );
  mesh.name = 'net';
  return mesh;
}

/**
 * 沿著網頂弧線的白色布邊（扁長方體管：前、後、上、下四面）。
 * 不打光：每一面的 uv 指到網子貼圖底下的色塊（0 = 上面、1 = 正反面、2 = 底面）。
 */
function netTape(swatch: (k: number) => [number, number]): THREE.BufferGeometry {
  const W = COURT.doublesHalfWidth;
  const SEG = 24;
  const t = 0.011; // 半厚
  const h = TAPE_H;
  const pos: number[] = [];
  const nor: number[] = [];
  const uvs: number[] = [];
  const idx: number[] = [];
  const quad = (a: number[], b: number[], c: number[], d: number[], n: number[], k: number) => {
    const base = pos.length / 3;
    pos.push(...a, ...b, ...c, ...d);
    const [u, v] = swatch(k);
    for (let i = 0; i < 4; i++) {
      nor.push(...n);
      uvs.push(u, v);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };
  for (let i = 0; i < SEG; i++) {
    const x0 = -W + (2 * W * i) / SEG;
    const x1 = -W + (2 * W * (i + 1)) / SEG;
    const y0 = netTopAt(x0) + 0.006;
    const y1 = netTopAt(x1) + 0.006;
    quad([x0, y0, t], [x0, y0 - h, t], [x1, y1 - h, t], [x1, y1, t], [0, 0, 1], 1); // 前
    quad([x1, y1, -t], [x1, y1 - h, -t], [x0, y0 - h, -t], [x0, y0, -t], [0, 0, -1], 1); // 後
    quad([x0, y0, -t], [x0, y0, t], [x1, y1, t], [x1, y1, -t], [0, 1, 0], 0); // 上
    quad([x0, y0 - h, t], [x0, y0 - h, -t], [x1, y1 - h, -t], [x1, y1 - h, t], [0, -1, 0], 2); // 下
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  return geo;
}

// ---------- 實心配件：網柱、裁判椅、發球裁判凳（全部合併成一個 draw call）----------

const box = (w: number, h: number, d: number, x: number, y: number, z: number, color: number) =>
  paint(new THREE.BoxGeometry(w, h, d).translate(x, y, z), color);
const cyl = (r0: number, r1: number, h: number, x: number, y: number, z: number, color: number, seg = 10) =>
  paint(new THREE.CylinderGeometry(r0, r1, h, seg).translate(x, y, z), color);

function makeFixtures(): THREE.Mesh {
  const W = COURT.doublesHalfWidth;
  const postH = netTopAt(W) + 0.03;
  const parts: THREE.BufferGeometry[] = [];
  const frame = 0xaeb7c2;
  const navy = 0x22324a;

  // 網柱：淺灰柱身、深藍頂蓋（圓頂）、布邊夾、配重底座
  const post = 0xdfe4ea;
  const accent = 0x24344d;
  for (const x of [-W, W]) {
    parts.push(cyl(0.032, 0.036, postH, x, postH / 2, 0, post));
    parts.push(cyl(0.05, 0.042, 0.05, x, postH + 0.02, 0, accent));
    parts.push(paint(new THREE.SphereGeometry(0.03, 8, 4, 0, Math.PI * 2, 0, Math.PI / 2).translate(x, postH + 0.045, 0), accent));
    parts.push(box(0.05, 0.05, 0.06, x - Math.sign(x) * 0.03, netTopAt(W) - 0.01, 0, accent));
    parts.push(cyl(0.17, 0.19, 0.07, x, 0.035, 0, accent, 18));
    parts.push(cyl(0.12, 0.15, 0.04, x, 0.09, 0, 0x3a4a63, 18));
  }

  // 主審椅：網子延長線上、左側雙打邊線外，面向球場（鏡頭在底線後方高處，椅子落在畫面邊緣、不擋球場）
  {
    const cx = UMPIRE_X;
    const legH = 1.22;
    for (const dx of [-0.26, 0.26]) {
      for (const dz of [-0.26, 0.26]) parts.push(box(0.045, legH, 0.045, cx + dx, legH / 2, dz, frame));
    }
    for (const dz of [-0.26, 0.26]) parts.push(box(0.56, 0.035, 0.035, cx, 0.42, dz, frame)); // 橫撐
    for (const dx of [-0.26, 0.26]) parts.push(box(0.035, 0.035, 0.56, cx + dx, 0.42, 0, frame));
    parts.push(box(0.26, 0.035, 0.5, cx + 0.22, 0.62, 0, frame)); // 腳踏板（朝球場那側）
    for (const y of [0.3, 0.62, 0.94]) parts.push(box(0.035, 0.035, 0.5, cx - 0.3, y, 0, frame)); // 後面的梯子
    parts.push(box(0.6, 0.07, 0.6, cx, legH + 0.035, 0, navy)); // 座位
    parts.push(box(0.06, 0.48, 0.56, cx - 0.27, legH + 0.31, 0, navy)); // 椅背
    for (const dz of [-0.28, 0.28]) {
      parts.push(box(0.04, 0.22, 0.04, cx + 0.2, legH + 0.18, dz, frame));
      parts.push(box(0.44, 0.04, 0.06, cx, legH + 0.29, dz, navy)); // 扶手
    }
  }

  // 發球裁判凳：右側網柱旁的矮椅，面向球場
  {
    const [cx, cz] = JUDGE;
    for (const dx of [-0.15, 0.15]) {
      for (const dz of [-0.15, 0.15]) parts.push(box(0.035, 0.45, 0.035, cx + dx, 0.225, cz + dz, frame));
    }
    parts.push(box(0.38, 0.05, 0.38, cx, 0.47, cz, navy));
    parts.push(box(0.04, 0.32, 0.36, cx + 0.17, 0.66, cz, navy));
  }

  const mesh = new THREE.Mesh(merge(parts), new THREE.MeshLambertMaterial({ vertexColors: true }));
  mesh.name = 'courtFixtures';
  return mesh;
}
