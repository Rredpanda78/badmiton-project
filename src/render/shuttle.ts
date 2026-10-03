import * as THREE from 'three';
import { merge, paint } from './geo';

/**
 * 外框寬度：頂點沿法線往外推「離鏡頭距離 × OUTLINE_K」，所以不管球飛多遠，螢幕上的框都差不多粗（約 1.5–2 px）。
 */
const OUTLINE_K = 0.002;
const FINS = 16; // 羽毛根數（真的羽球也是 16 根）

/**
 * 羽球模型（軟木頭在原點、羽毛往 +Y 展開，跟 scene.ts 原本的一樣）。
 * - 軟木頭：下半球＋一小段皮革側面；裙底一圈藍色的線圈
 * - 羽毛裙：白色的錐面（羽片）＋ 16 片放射狀的薄羽毛（錐面外側一點點、外緣奶白、內緣深色的羽莖），輪廓才有鋸齒狀的羽毛感
 * - 帶一點自發光：夜裡也是白的；外面套一層深色外框（反面的外殼，在 shader 裡依距離外推）：粉紅天空、竹林、白線上都看得清楚
 * 2 個 draw call（本體、外框）、約 300 個三角形，沒有每幀配置。
 */
export function makeShuttleMesh(scale = 2.4): THREE.Group {
  const s = scale;
  const group = new THREE.Group();
  group.name = 'shuttle';

  const corkR = 0.014 * s;
  const skirtH = 0.062 * s;
  const skirtTop = 0.037 * s;
  const skirtBot = 0.0135 * s;
  const skirtY = 0.03 * s + 0.006; // 裙子中心高度（原本的位置）
  const y0 = skirtY - skirtH / 2; // 裙底
  const y1 = skirtY + skirtH / 2; // 裙頂（羽毛尖）

  // ---- 本體：軟木頭（下半球＋側面）＋羽毛裙＋裙底的線圈＋ 16 片羽毛 ----
  const corkDome = paint(new THREE.SphereGeometry(corkR, 12, 6, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), 0xf3ead8);
  const corkSide = paint(new THREE.CylinderGeometry(corkR, corkR, corkR * 0.9, 12, 1, true).translate(0, corkR * 0.45, 0), 0xe9dcc3);
  const skirt = paint(new THREE.CylinderGeometry(skirtTop, skirtBot, skirtH, FINS, 1, true).translate(0, skirtY, 0), 0xffffff);
  // 裙子在某高度（從裙底量起）的半徑；線圈要比裙子稍微大一點才不會被蓋住
  const rAt = (h: number) => skirtBot + ((skirtTop - skirtBot) * h) / skirtH;
  const b0 = 0.0015 * s;
  const b1 = 0.0105 * s;
  const eps = 0.0008 * s;
  const band = paint(new THREE.CylinderGeometry(rAt(b1) + eps, rAt(b0) + eps, b1 - b0, FINS, 1, true).translate(0, y0 + (b0 + b1) / 2, 0), 0x3b6fd6);
  const body = new THREE.Mesh(
    merge([corkDome, corkSide, skirt, band, feathers(skirtBot + eps, skirtTop, y0 + b1, y1, 0.0045 * s)]),
    new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, emissive: 0x4a4a4a }),
  );
  group.add(body);

  // ---- 外框：封閉的外殼（球＋實心圓錐），只畫背面，頂點從球的中心往外推 ----
  const hullCork = new THREE.SphereGeometry(corkR, 10, 6);
  const hullSkirt = new THREE.CylinderGeometry(skirtTop, skirtBot, skirtH, 16, 1, false).translate(0, skirtY, 0);
  hullCork.deleteAttribute('uv');
  hullSkirt.deleteAttribute('uv');
  const hull = merge([hullCork, hullSkirt]);
  // 法線改成「從中心往外」：同一位置的頂點推的方向一樣，邊角不會裂開
  const cy = skirtY - skirtH * 0.15;
  const p = hull.attributes.position;
  const n = hull.attributes.normal;
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) {
    v.set(p.getX(i), p.getY(i) - cy, p.getZ(i)).normalize();
    n.setXYZ(i, v.x, v.y, v.z);
  }
  const outlineMat = new THREE.MeshBasicMaterial({ color: 0x0e1622, side: THREE.BackSide });
  outlineMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
      mvPosition.xyz += normalize( normalMatrix * normal ) * ( ${OUTLINE_K} * max( -mvPosition.z, 0.0 ) );
      gl_Position = projectionMatrix * mvPosition;`,
    );
  };
  outlineMat.customProgramCacheKey = () => 'shuttle-outline';
  const outline = new THREE.Mesh(hull, outlineMat);
  outline.name = 'shuttleOutline';
  group.add(outline);
  return group;
}

/**
 * 16 片羽毛：每片是一個放射狀的薄四邊形，貼著錐面從裙底（半徑 r0、高 y0）斜向裙頂（r1、y1），
 * 往外伸出 w（羽片的寬度），尖端再翹高一點；內緣（羽莖）深色、外緣奶白，頂點色漸層。
 * 從側面看，輪廓就是一排斜的鋸齒；正面看是放射狀的羽毛。
 */
function feathers(r0: number, r1: number, y0: number, y1: number, w: number): THREE.BufferGeometry {
  const pos: number[] = [];
  const col: number[] = [];
  const nor: number[] = [];
  const uvs: number[] = []; // 跟其他零件一樣要有 uv 才能 merge（沒用到，全 0）
  const idx: number[] = [];
  const quill = new THREE.Color(0xbfb59e);
  const vane = new THREE.Color(0xfffbf2);
  // 錐面的外法線（在 xz 平面裡的徑向 ＋ 一點往上）
  const slope = Math.atan2(r1 - r0, y1 - y0);
  const nr = Math.cos(slope);
  const ny = Math.sin(slope);
  for (let i = 0; i < FINS; i++) {
    const a = ((i + 0.5) / FINS) * Math.PI * 2;
    const c = Math.cos(a);
    const sn = Math.sin(a);
    const base = pos.length / 3;
    // 四個角：裙底內、裙頂內（羽莖）、裙頂外、裙底外（羽片）
    const pts: [number, number, number, THREE.Color][] = [
      [r0, y0, 0, quill],
      [r1, y1 + w * 0.4, 0, quill],
      [r1 + w * nr, y1 + w * 0.4 + w * ny, 0, vane],
      [r0 + w * 0.45 * nr, y0 + w * 0.45 * ny, 0, vane],
    ];
    for (const [r, y, , color] of pts) {
      pos.push(r * c, y, r * sn);
      nor.push(-sn, 0, c); // 切線方向：薄片兩面都打光（材質是 DoubleSide）
      col.push(color.r, color.g, color.b);
      uvs.push(0, 0);
    }
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  return g;
}
