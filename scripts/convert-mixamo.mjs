// 把 Mixamo 匯出的 FBX（Y Bot 骨架、不含皮膚、30 fps）轉成遊戲用的小檔：
//   public/anim/index.json  骨架（名稱、父節點、靜止姿勢，單位公尺）＋每個動作的說明
//   public/anim/<name>.bin  每格每個節點的旋轉（4×int16 四元數），髖部另外存位移（3×float32）
// 手指、*_End 節點都丟掉（打羽球用不到），檔案小很多。
// 執行：node scripts/convert-mixamo.mjs            （讀 assets/mixamo/*.fbx，檔名 = 動作名）
//       node scripts/convert-mixamo.mjs idle run   （只轉這幾個）
// 原始 FBX 放 assets/mixamo/（.gitignore 忽略，不進 repo）；轉好的 public/anim/ 才 commit。
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import * as THREE from 'three';

const root = join(fileURLToPath(import.meta.url), '..', '..');
const SRC = join(root, 'assets', 'mixamo');
const OUT = join(root, 'public', 'anim');
const FPS = 30;
const SCALE = 0.01; // Mixamo 是公分
// 循環播放的動作（其他的播一次）
const LOOPS = new Set(['idle', 'idle_bounce', 'jog_fwd', 'jog_back', 'jog_left', 'jog_right', 'jog_fl', 'jog_fr', 'jog_bl', 'jog_br', 'run_fwd', 'run_back', 'run_left', 'run_right']);

const keep = (name) => !/Hand(Thumb|Index|Middle|Ring|Pinky)|_End$/.test(name);
const short = (name) => name.replace(/^mixamorig:?/, '');

const only = process.argv.slice(2);
const files = readdirSync(SRC)
  .filter((f) => f.toLowerCase().endsWith('.fbx'))
  .filter((f) => !only.length || only.includes(basename(f, '.fbx')));
if (!files.length) {
  console.error(`assets/mixamo/ 裡沒有 FBX`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });
const index = existsSync(join(OUT, 'index.json')) ? JSON.parse(readFileSync(join(OUT, 'index.json'), 'utf8')) : { fps: FPS, bones: [], clips: {} };

let total = 0;
for (const f of files) {
  const name = basename(f, '.fbx');
  const buf = readFileSync(join(SRC, f));
  const scene = new FBXLoader().parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), '');
  // 骨架：以第一個檔案為準（Mixamo 同一個角色的骨架都一樣），之後的檔案只檢查名稱對得上
  const bones = [];
  scene.traverse((o) => {
    if (o.isBone && keep(o.name)) bones.push(o);
  });
  const byName = new Map(bones.map((b) => [short(b.name), b]));
  const parentOf = (b) => {
    let p = b.parent;
    while (p && !(p.isBone && keep(p.name))) p = p.parent;
    return p && p.isBone ? bones.indexOf(p) : -1;
  };
  if (!index.bones.length) {
    index.bones = bones.map((b) => ({
      name: short(b.name),
      parent: parentOf(b),
      pos: b.position.toArray().map((v) => +(v * SCALE).toFixed(5)),
      rot: b.quaternion.toArray().map((v) => +v.toFixed(5)),
    }));
  } else {
    const missing = index.bones.filter((ib) => !byName.has(ib.name)).map((ib) => ib.name);
    if (missing.length) {
      console.warn(`${name}: 骨架少了 ${missing.join(', ')}，略過`);
      continue;
    }
  }
  const clip = scene.animations[0];
  if (!clip) {
    console.warn(`${name}: 沒有動畫，略過`);
    continue;
  }
  // 用 AnimationMixer 每 1/FPS 秒取樣一次（FBX 的關鍵格不一定每格都有），直接讀各節點的 local 旋轉／位移
  const mixer = new THREE.AnimationMixer(scene);
  const action = mixer.clipAction(clip);
  action.play();
  const frames = Math.max(2, Math.round(clip.duration * FPS) + 1);
  const n = index.bones.length;
  const rot = new Int16Array(frames * n * 4);
  const hip = new Float32Array(frames * 3);
  const q = new THREE.Quaternion();
  for (let fi = 0; fi < frames; fi++) {
    mixer.setTime(Math.min(clip.duration, fi / FPS));
    index.bones.forEach((ib, bi) => {
      const b = byName.get(ib.name);
      q.copy(b.quaternion).normalize();
      const o = (fi * n + bi) * 4;
      rot[o] = Math.round(q.x * 32767);
      rot[o + 1] = Math.round(q.y * 32767);
      rot[o + 2] = Math.round(q.z * 32767);
      rot[o + 3] = Math.round(q.w * 32767);
    });
    const h = byName.get(index.bones[0].name);
    hip[fi * 3] = h.position.x * SCALE;
    hip[fi * 3 + 1] = h.position.y * SCALE;
    hip[fi * 3 + 2] = h.position.z * SCALE;
  }
  const bin = new Uint8Array(rot.byteLength + hip.byteLength);
  bin.set(new Uint8Array(rot.buffer), 0);
  bin.set(new Uint8Array(hip.buffer), rot.byteLength);
  writeFileSync(join(OUT, `${name}.bin`), bin);
  index.clips[name] = { file: `${name}.bin`, frames, duration: +(clip.duration).toFixed(4), loop: LOOPS.has(name) };
  total += bin.byteLength;
  console.log(`${name.padEnd(14)} ${clip.duration.toFixed(2)}s ${frames} 格 ${(bin.byteLength / 1024).toFixed(0)} KB`);
}
writeFileSync(join(OUT, 'index.json'), JSON.stringify(index));
console.log(`骨架 ${index.bones.length} 節點，動作 ${Object.keys(index.clips).length} 個，共 ${(total / 1024).toFixed(0)} KB → public/anim/`);
