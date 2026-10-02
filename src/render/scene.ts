import * as THREE from 'three';
import { COURT } from '../config';
import type { Match } from '../sim/match';
import type { Vec3 } from '../sim/physics';
import { makeCourt } from './court';
import { PlayerModel } from './playerModel';

const SHUTTLE_SCALE = 2.4; // 真實羽球太小，放大一點比較看得清楚
const TRAIL_LEN = 22;

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  private models: [PlayerModel, PlayerModel];
  private shuttle = new THREE.Group();
  private shuttleShadow: THREE.Mesh;
  private trail: THREE.Line;
  private trailPts: THREE.Vector3[] = [];
  private marker: THREE.Mesh;
  private bursts: { mesh: THREE.Mesh; t: number }[] = [];
  private shakeAmt = 0;
  private camX = 0;
  private tmp = new THREE.Vector3();
  viewSide: 1 | -1 = 1; // 1 = 自己在畫面下方（z>0）

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x111a26);
    this.scene.fog = new THREE.Fog(0x111a26, 26, 48);

    this.scene.add(new THREE.HemisphereLight(0xe6eeff, 0x2a3442, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(4, 12, 6);
    this.scene.add(sun);

    this.scene.add(makeCourt(this.renderer.capabilities.getMaxAnisotropy()));

    this.models = [new PlayerModel(0x2f7fe0, 0x1b2a44), new PlayerModel(0xe0483a, 0x3a1b1b)];
    for (const m of this.models) this.scene.add(m.root);

    // 羽球：軟木頭在原點、羽毛往 +Y 展開
    const cork = new THREE.Mesh(new THREE.SphereGeometry(0.014 * SHUTTLE_SCALE, 10, 8), new THREE.MeshLambertMaterial({ color: 0xf6f1e4 }));
    const skirt = new THREE.Mesh(
      new THREE.CylinderGeometry(0.033 * SHUTTLE_SCALE, 0.013 * SHUTTLE_SCALE, 0.06 * SHUTTLE_SCALE, 14, 1, true),
      new THREE.MeshLambertMaterial({ color: 0xffffff, side: THREE.DoubleSide, transparent: true, opacity: 0.92 }),
    );
    skirt.position.y = 0.03 * SHUTTLE_SCALE + 0.006;
    this.shuttle.add(cork, skirt);
    this.scene.add(this.shuttle);

    this.shuttleShadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.075, 16),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.5, depthWrite: false }),
    );
    this.shuttleShadow.rotation.x = -Math.PI / 2;
    this.scene.add(this.shuttleShadow);

    for (let i = 0; i < TRAIL_LEN; i++) this.trailPts.push(new THREE.Vector3());
    const tg = new THREE.BufferGeometry().setFromPoints(this.trailPts);
    this.trail = new THREE.Line(tg, new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }));
    this.trail.frustumCulled = false;
    this.scene.add(this.trail);

    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(0.16, 0.24, 28),
      new THREE.MeshBasicMaterial({ color: 0xffd54a, transparent: true, opacity: 0.8, depthWrite: false }),
    );
    this.marker.rotation.x = -Math.PI / 2;
    this.marker.position.y = 0.01;
    this.marker.visible = false;
    this.scene.add(this.marker);

    this.resize();
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h);
    const aspect = w / h;
    this.camera.aspect = aspect;
    // 直式螢幕時加大視角，確保整個球場看得到
    this.camera.fov = aspect >= 1.45 ? 40 : Math.min(80, 40 * (1.45 / aspect) ** 0.8);
    this.camera.updateProjectionMatrix();
  }

  resetTrail(p: Vec3): void {
    for (const t of this.trailPts) t.set(p.x, p.y, p.z);
  }

  burst(p: Vec3, strong: boolean): void {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.05, 0.09, 24),
      new THREE.MeshBasicMaterial({ color: strong ? 0xffe066 : 0xffffff, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }),
    );
    mesh.position.set(p.x, p.y, p.z);
    mesh.lookAt(this.camera.position);
    this.scene.add(mesh);
    this.bursts.push({ mesh, t: 0 });
    if (strong) this.shakeAmt = Math.max(this.shakeAmt, 0.12);
  }

  update(match: Match, dt: number, showHint: boolean, humanId: 0 | 1): void {
    const vs = this.viewSide;
    const me = match.players[humanId];

    // 鏡頭：在自己這側後上方，稍微跟著自己左右移動
    this.camX += (me.pos.x * 0.22 - this.camX) * Math.min(1, dt * 3);
    const shake = this.shakeAmt;
    this.shakeAmt = Math.max(0, this.shakeAmt - dt * 0.6);
    const sx = (Math.random() - 0.5) * shake;
    const sy = (Math.random() - 0.5) * shake;
    this.camera.position.set(this.camX + sx, 10.2 + sy, vs * 13.8);
    this.camera.lookAt(this.camX * 0.6, 0, vs * 0.6);

    match.players.forEach((p, i) => this.models[i].update(p, dt));

    // 羽球
    const sh = match.shuttle;
    this.shuttle.position.set(sh.pos.x, sh.pos.y, sh.pos.z);
    const sp = Math.hypot(sh.vel.x, sh.vel.y, sh.vel.z);
    if (sh.mode === 'held') {
      this.shuttle.quaternion.identity();
    } else if (sh.mode === 'down') {
      // 落地後側躺
      this.shuttle.quaternion.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2.4);
      this.shuttle.position.y = 0.02;
    } else if (sp > 0.3) {
      // 軟木頭朝前進方向
      this.tmp.set(-sh.vel.x, -sh.vel.y, -sh.vel.z).normalize();
      this.shuttle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.tmp);
    }

    this.shuttleShadow.position.set(sh.pos.x, 0.008, sh.pos.z);
    const sc = 1 + Math.min(1.5, sh.pos.y * 0.25);
    this.shuttleShadow.scale.set(sc, sc, sc);
    (this.shuttleShadow.material as THREE.MeshBasicMaterial).opacity = 0.55 / sc;

    // 拖尾
    const flying = sh.mode === 'flight' || sh.mode === 'netfall';
    this.trail.visible = flying;
    if (flying) {
      for (let i = TRAIL_LEN - 1; i > 0; i--) this.trailPts[i].copy(this.trailPts[i - 1]);
      this.trailPts[0].set(sh.pos.x, sh.pos.y, sh.pos.z);
      this.trail.geometry.setFromPoints(this.trailPts);
    } else this.resetTrail(sh.pos);

    // 落點提示（只提示打向自己的球）
    const pred = sh.prediction;
    const incoming = flying && sh.lastHitter !== null && sh.lastHitter !== humanId;
    if (showHint && incoming && pred?.landing) {
      const L = pred.landing;
      this.marker.visible = true;
      this.marker.position.set(L.x, 0.012, L.z);
      const out = Math.abs(L.x) > COURT.singlesHalfWidth + 0.03 || Math.abs(L.z) > COURT.halfLength + 0.03;
      (this.marker.material as THREE.MeshBasicMaterial).color.set(out ? 0xff5a5a : 0xffd54a);
    } else this.marker.visible = false;

    // 擊球特效
    for (const b of this.bursts) {
      b.t += dt;
      const s = 1 + b.t * 14;
      b.mesh.scale.set(s, s, s);
      (b.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.9 - b.t * 3.5);
    }
    this.bursts = this.bursts.filter((b) => {
      if (b.t > 0.3) {
        this.scene.remove(b.mesh);
        b.mesh.geometry.dispose();
        (b.mesh.material as THREE.Material).dispose();
        return false;
      }
      return true;
    });
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /** 3D 座標 → 螢幕像素 */
  project(p: Vec3): { x: number; y: number } {
    this.tmp.set(p.x, p.y, p.z).project(this.camera);
    return { x: (this.tmp.x * 0.5 + 0.5) * window.innerWidth, y: (-this.tmp.y * 0.5 + 0.5) * window.innerHeight };
  }
}
