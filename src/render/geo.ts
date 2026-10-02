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
