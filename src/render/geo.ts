import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const _col = new THREE.Color();

/** 整個幾何塗成單一頂點色（之後可以跟其他零件合併成一個 draw call） */
export function paint(geo: THREE.BufferGeometry, hex: number): THREE.BufferGeometry {
  _col.set(hex);
  const n = geo.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    a[i * 3] = _col.r;
    a[i * 3 + 1] = _col.g;
    a[i * 3 + 2] = _col.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
  return geo;
}

/** 合併零件（全部要有相同的 attribute 組合，例如都先 paint 過） */
export function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  if (!g) throw new Error('mergeGeometries failed');
  return g;
}

/** 頂點光澤（bodyMaterial 的 gloss 屬性：1 = 材質的 specular 全開、0 = 全霧面） */
export function gloss(geo: THREE.BufferGeometry, g: number): THREE.BufferGeometry {
  const n = geo.attributes.position.count;
  geo.setAttribute('gloss', new THREE.BufferAttribute(new Float32Array(n).fill(g), 1));
  return geo;
}

/** 整個幾何的 UV 指到貼圖的同一點（顏色靠頂點色，貼圖那一點是白色） */
export function uvAt(geo: THREE.BufferGeometry, u: number, v: number): THREE.BufferGeometry {
  const n = geo.attributes.position.count;
  const a = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    a[i * 2] = u;
    a[i * 2 + 1] = v;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(a, 2));
  return geo;
}

/**
 * 蒙皮權重：整個幾何綁到第 i 根骨頭；blend(x, y, z)（幾何自己的座標）可以把一部分權重分給另一根骨頭
 * （回傳 [骨頭編號, 權重]），關節附近的皮才會跟著拉伸、不裂開。
 */
export function skinTo(geo: THREE.BufferGeometry, i: number, blend?: (x: number, y: number, z: number) => [number, number] | null): THREE.BufferGeometry {
  const p = geo.attributes.position;
  const n = p.count;
  const idx = new Uint16Array(n * 4);
  const w = new Float32Array(n * 4);
  for (let k = 0; k < n; k++) {
    const b = blend ? blend(p.getX(k), p.getY(k), p.getZ(k)) : null;
    idx[k * 4] = i;
    if (b && b[1] > 0) {
      idx[k * 4 + 1] = b[0];
      w[k * 4] = 1 - b[1];
      w[k * 4 + 1] = b[1];
    } else w[k * 4] = 1;
  }
  geo.setAttribute('skinIndex', new THREE.BufferAttribute(idx, 4));
  geo.setAttribute('skinWeight', new THREE.BufferAttribute(w, 4));
  return geo;
}

/** 旋轉體：pts = [y, 半徑] 由下往上（繞 Y 軸） */
export function lathe(pts: [number, number][], segs = 12, phiStart = 0): THREE.LatheGeometry {
  return new THREE.LatheGeometry(
    pts.map(([y, r]) => new THREE.Vector2(r, y)),
    segs,
    phiStart,
    Math.PI * 2,
  );
}

/**
 * 球員材質：Phong（球衣略有光澤）＋頂點色＋貼圖（球衣：領口、側條、背號；其他零件指到白色那一格），
 * 加一點邊緣光（Fresnel，偏冷色）讓人物從球場底色跳出來；光澤強度由頂點屬性 gloss 決定（鞋、球拍亮，皮膚、襪子霧）。
 */
export function bodyMaterial(map: THREE.Texture): THREE.MeshPhongMaterial {
  const m = new THREE.MeshPhongMaterial({ map, vertexColors: true, specular: new THREE.Color(0x3a3a3a), shininess: 26 });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float gloss;\nvarying float vGloss;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvGloss = gloss;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vGloss;')
      .replace('#include <specularmap_fragment>', '#include <specularmap_fragment>\nspecularStrength *= vGloss;')
      .replace(
        '#include <opaque_fragment>',
        `float rim = pow(1.0 - saturate(dot(normal, geometryViewDir)), 3.0);
        outgoingLight += rim * 0.22 * vec3(0.78, 0.86, 1.0) * (0.35 + 0.65 * diffuseColor.rgb);
        #include <opaque_fragment>`,
      );
  };
  m.customProgramCacheKey = () => 'player-body';
  return m;
}
