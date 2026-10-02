import * as THREE from 'three';
import { COURT } from '../config';

const PX = 128; // 每公尺像素

/** 球場地墊＋白線（用 canvas 畫成貼圖） */
export function makeCourt(maxAniso: number): THREE.Object3D {
  const group = new THREE.Group();
  const matW = 7.6;
  const matL = 15.6;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(matW * PX);
  canvas.height = Math.round(matL * PX);
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#2f7d5d';
  g.fillRect(0, 0, canvas.width, canvas.height);
  // 單打場區稍微亮一點，讓界線一眼看得出來
  const toX = (x: number) => (x + matW / 2) * PX;
  const toY = (z: number) => (z + matL / 2) * PX;
  g.fillStyle = '#35896a';
  g.fillRect(toX(-COURT.singlesHalfWidth), toY(-COURT.halfLength), COURT.singlesHalfWidth * 2 * PX, COURT.halfLength * 2 * PX);

  const lw = 0.045 * PX;
  const line = (x1: number, z1: number, x2: number, z2: number, color = '#f4f7f2') => {
    g.strokeStyle = color;
    g.lineWidth = lw;
    g.beginPath();
    g.moveTo(toX(x1), toY(z1));
    g.lineTo(toX(x2), toY(z2));
    g.stroke();
  };
  const W = COURT.doublesHalfWidth;
  const S = COURT.singlesHalfWidth;
  const L = COURT.halfLength;
  const dim = 'rgba(244,247,242,0.45)';
  // 雙打外框與後發球線（單打用不到，畫淡一點）
  line(-W, -L, -W, L, dim);
  line(W, -L, W, L, dim);
  line(-W, -COURT.doublesLongService, W, -COURT.doublesLongService, dim);
  line(-W, COURT.doublesLongService, W, COURT.doublesLongService, dim);
  // 單打實際界線
  line(-W, -L, W, -L);
  line(-W, L, W, L);
  line(-S, -L, -S, L);
  line(S, -L, S, L);
  line(-W, -COURT.shortService, W, -COURT.shortService);
  line(-W, COURT.shortService, W, COURT.shortService);
  line(0, -L, 0, -COURT.shortService);
  line(0, COURT.shortService, 0, L);

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = maxAniso;
  const mat = new THREE.MeshLambertMaterial({ map: tex });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(matW, matL), mat);
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = 0.002;
  group.add(mesh);

  // 場館地板
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshLambertMaterial({ color: 0x24313f }));
  floor.rotation.x = -Math.PI / 2;
  group.add(floor);

  group.add(makeNet());
  return group;
}

function makeNet(): THREE.Object3D {
  const group = new THREE.Group();
  const W = COURT.doublesHalfWidth;
  const top = COURT.netTop;
  const depth = 0.76;

  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 128;
  const g = canvas.getContext('2d')!;
  g.clearRect(0, 0, canvas.width, canvas.height);
  g.strokeStyle = 'rgba(20,24,30,0.85)';
  g.lineWidth = 1.5;
  const cell = 9;
  for (let x = 0; x <= canvas.width; x += cell) {
    g.beginPath();
    g.moveTo(x, 0);
    g.lineTo(x, canvas.height);
    g.stroke();
  }
  for (let y = 0; y <= canvas.height; y += cell) {
    g.beginPath();
    g.moveTo(0, y);
    g.lineTo(canvas.width, y);
    g.stroke();
  }
  g.fillStyle = '#f5f5f5';
  g.fillRect(0, 0, canvas.width, 12);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  const net = new THREE.Mesh(
    new THREE.PlaneGeometry(W * 2, depth),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthWrite: false }),
  );
  net.position.set(0, top - depth / 2, 0);
  group.add(net);

  const postMat = new THREE.MeshLambertMaterial({ color: 0xd8dde4 });
  for (const x of [-W, W]) {
    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, COURT.postTop, 10), postMat);
    post.position.set(x, COURT.postTop / 2, 0);
    group.add(post);
    const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.06, 16), postMat);
    foot.position.set(x, 0.03, 0);
    group.add(foot);
  }
  return group;
}
