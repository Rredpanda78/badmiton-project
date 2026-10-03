import * as THREE from 'three';
import { merge, paint } from './geo';

/**
 * 外框寬度：頂點沿法線往外推「離鏡頭距離 × OUTLINE_K」，所以不管球飛多遠，螢幕上的框都差不多粗（約 1.5–2 px）。
 */
const OUTLINE_K = 0.002;

/**
 * 羽球模型（軟木頭在原點、羽毛往 +Y 展開，跟 scene.ts 原本的一樣）。
 * - 羽毛裙比原本大一點，帶一點自發光：夜裡也是白的
 * - 外面套一層深色外框（反面的外殼，在 shader 裡依距離外推）：粉紅天空、竹林、白線上都看得清楚
 * 2 個 draw call（本體、外框），沒有每幀配置。
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

  // ---- 本體：軟木頭＋羽毛裙＋裙底的線圈 ----
  const cork = paint(new THREE.SphereGeometry(corkR, 10, 8), 0xf3ead8);
  const skirt = paint(new THREE.CylinderGeometry(skirtTop, skirtBot, skirtH, 16, 1, true).translate(0, skirtY, 0), 0xffffff);
  // 裙子在某高度（從裙底量起）的半徑；線圈要比裙子稍微大一點才不會被蓋住
  const rAt = (h: number) => skirtBot + ((skirtTop - skirtBot) * h) / skirtH;
  const b0 = 0.0015 * s;
  const b1 = 0.0105 * s;
  const eps = 0.0008 * s;
  const band = paint(
    new THREE.CylinderGeometry(rAt(b1) + eps, rAt(b0) + eps, b1 - b0, 16, 1, true).translate(0, skirtY - skirtH / 2 + (b0 + b1) / 2, 0),
    0x3b6fd6,
  );
  const body = new THREE.Mesh(
    merge([cork, skirt, band]),
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
