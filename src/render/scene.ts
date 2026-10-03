import * as THREE from 'three';
import { CAMERA, COURT, GAME, type Venue } from '../config';
import { timeUntilInReach, type Match } from '../sim/match';
import { v3, type Vec3 } from '../sim/physics';
import { makeCourt } from './court';
import { buildVenue, type Environment } from './environment';
import { PlayerModel, playerStyle } from './playerModel';
import { makeShuttleMesh } from './shuttle';

/** 球員外觀：球衣顏色＋（可選）角色造型與球拍顏色 */
export interface Look {
  shirt: number;
  shorts: number;
  id?: string;
  racketColor?: number;
}

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
  private reachRing: THREE.Mesh;
  private serveBoxLine: THREE.LineLoop;
  private target: THREE.Mesh;
  private baseFov = 40;
  private fovPunch = 0;
  private bursts: { mesh: THREE.Mesh; t: number }[] = [];
  private shakeAmt = 0;
  private camX = 0;
  private hemi: THREE.HemisphereLight;
  private sun: THREE.DirectionalLight;
  private env: Environment | null = null;
  private venue: Venue | null = null;
  private pose = CAMERA.landscape;
  private reserve = 0;
  private tmp = new THREE.Vector3();
  viewSide: 1 | -1 = 1; // 1 = 自己在畫面下方（z>0）

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    container.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x111a26);
    this.scene.fog = new THREE.Fog(0x111a26, 26, 48);

    this.hemi = new THREE.HemisphereLight(0xe6eeff, 0x2a3442, 1.6);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.6);
    this.sun.position.set(4, 12, 6);
    this.scene.add(this.sun);

    this.scene.add(makeCourt(this.renderer.capabilities.getMaxAnisotropy()));
    this.setVenue('indoor');

    this.models = [new PlayerModel(0x2f7fe0, 0x1b2a44), new PlayerModel(0xe0483a, 0x3a1b1b)];
    for (const m of this.models) this.scene.add(m.root);

    // 羽球：軟木頭在原點、羽毛往 +Y 展開
    this.shuttle.add(makeShuttleMesh(SHUTTLE_SCALE));
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

    this.reachRing = new THREE.Mesh(
      new THREE.RingGeometry(GAME.reach - 0.03, GAME.reach, 48),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2, depthWrite: false }),
    );
    this.reachRing.rotation.x = -Math.PI / 2;
    this.reachRing.visible = false;
    this.scene.add(this.reachRing);

    this.serveBoxLine = new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()]),
      new THREE.LineBasicMaterial({ color: 0x8fd3ff, transparent: true, opacity: 0.6 }),
    );
    this.serveBoxLine.frustumCulled = false;
    this.serveBoxLine.visible = false;
    this.scene.add(this.serveBoxLine);

    // 訓練關卡的目標區（對面場地上的黃色半透明區塊）
    this.target = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: 0xffd54a, transparent: true, opacity: 0.22, depthWrite: false }),
    );
    this.target.rotation.x = -Math.PI / 2;
    this.target.visible = false;
    this.scene.add(this.target);

    this.resize();
  }

  /**
   * 依螢幕方向擺鏡頭，並自動算視角讓整個球場剛好塞滿畫面。
   * 手機直向時，畫面下方保留 reserve 比例給兩個拇指搖桿，球場只畫在上面那塊。
   */
  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (!w || !h) return; // 分頁隱藏時尺寸可能是 0
    this.renderer.setSize(w, h);
    const portrait = h > w * 1.05;
    this.pose = portrait ? CAMERA.portrait : CAMERA.landscape;
    this.reserve = portrait && matchMedia('(pointer: coarse)').matches ? 0.22 : 0;

    // 先把球場塞進「上方區域」(寬 w、高 hc)
    const hc = h * (1 - this.reserve);
    const fitFov = this.fitFov(w / hc);
    // 再把可視範圍往下延伸 reserve 區（對稱視錐 + view offset，只取上半部顯示）
    const hf = 2 * h - hc;
    const tanF = Math.tan(((fitFov / 2) * Math.PI) / 180) * (hf / hc);
    this.camera.fov = this.baseFov = (2 * Math.atan(tanF) * 180) / Math.PI;
    this.camera.aspect = w / hf;
    if (this.reserve > 0) this.camera.setViewOffset(w, hf, 0, h - hc, w, h);
    else this.camera.clearViewOffset();
    this.camera.updateProjectionMatrix();
  }

  /** 畫面下方保留給搖桿的比例（UI 用） */
  get bottomReserve(): number {
    return this.reserve;
  }

  private fitFov(aspect: number): number {
    const cam = this.camera;
    const vs = this.viewSide;
    cam.clearViewOffset();
    cam.aspect = aspect;
    this.placeCamera(0, 0, 0);
    const pts: THREE.Vector3[] = [];
    for (const sx of [-1, 1]) {
      pts.push(new THREE.Vector3(sx * 3.1, 0, vs * 7.3)); // 自己底線後方
      pts.push(new THREE.Vector3(sx * 3.1, 0, -vs * 7.0)); // 對面底線
      pts.push(new THREE.Vector3(sx * 2.7, 2.2, -vs * 6.9)); // 對手站在底線時的頭
      pts.push(new THREE.Vector3(sx * 2.7, 2.0, vs * 7.2)); // 自己站在底線時的頭
    }
    const p = new THREE.Vector3();
    let lo = 10;
    let hi = 120;
    for (let i = 0; i < 22; i++) {
      const mid = (lo + hi) / 2;
      cam.fov = mid;
      cam.updateProjectionMatrix();
      const fits = pts.every((q) => {
        p.copy(q).project(cam);
        return Math.abs(p.x) <= 0.98 && p.y <= 0.84 && p.y >= -0.97;
      });
      if (fits) hi = mid;
      else lo = mid;
    }
    return hi;
  }

  private placeCamera(camX: number, sx: number, sy: number): void {
    const vs = this.viewSide;
    this.camera.position.set(camX + sx, this.pose.y + sy, vs * this.pose.z);
    this.camera.lookAt(camX * 0.6, 0, vs * this.pose.lookZ);
    this.camera.updateMatrixWorld();
  }

  /** 訓練關卡目標區；null = 不顯示 */
  setTarget(t: { x0: number; x1: number; z0: number; z1: number } | null): void {
    this.target.visible = !!t;
    if (!t) return;
    this.target.position.set((t.x0 + t.x1) / 2, 0.009, (t.z0 + t.z1) / 2);
    this.target.scale.set(Math.abs(t.x1 - t.x0), Math.abs(t.z1 - t.z0), 1);
  }

  /** 換場地（室內／竹林／櫻花園） */
  setVenue(v: Venue): void {
    if (v === this.venue) return;
    this.venue = v;
    if (this.env) {
      this.scene.remove(this.env.group);
      this.env.group.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
    }
    const env = (this.env = buildVenue(v));
    this.scene.add(env.group);
    (this.scene.background as THREE.Color).set(env.background);
    const fog = this.scene.fog as THREE.Fog;
    fog.color.set(env.fog[0]);
    fog.near = env.fog[1];
    fog.far = env.fog[2];
    this.hemi.color.set(env.sky);
    this.hemi.groundColor.set(env.ground);
    this.sun.color.set(env.sun);
  }

  /** 換球員外觀（球衣顏色） */
  setLooks(looks: [Look, Look]): void {
    looks.forEach((l, i) => {
      this.scene.remove(this.models[i].root);
      this.models[i].dispose();
      this.models[i] = new PlayerModel(l.shirt, l.shorts, l.id ? playerStyle(l.id, l.racketColor) : undefined);
      this.scene.add(this.models[i].root);
    });
  }

  resetTrail(p: Vec3): void {
    for (const t of this.trailPts) t.set(p.x, p.y, p.z);
  }

  /** 擊球特效：品質越好越大越金，殺球加鏡頭震動與視角衝擊 */
  burst(p: Vec3, quality: number, smash: boolean, jump: boolean): void {
    const perfect = quality >= 0.9;
    const poor = quality < 0.74;
    const color = jump ? 0x7ff7ff : perfect ? 0xffd54a : poor ? 0x9aa4b0 : 0xffffff;
    const size = jump ? 1.8 : smash ? 1.4 : perfect ? 1.25 : poor ? 0.7 : 1;
    this.addFx(p, color, size, false);
    if (perfect || smash || jump) this.addFx(p, 0xffffff, size * 0.6, false, 0.06);
    if (smash || jump) {
      this.shakeAmt = Math.max(this.shakeAmt, jump ? 0.18 : 0.12);
      this.fovPunch = jump ? 3.5 : 2;
    }
  }

  /** 落地揚塵 */
  dust(p: Vec3): void {
    this.addFx(v3(p.x, 0.02, p.z), 0xd7dee8, 2.2, true);
  }

  private addFx(p: Vec3, color: number, size: number, flat: boolean, delay = 0): void {
    const mesh = new THREE.Mesh(
      new THREE.RingGeometry(0.05 * size, 0.09 * size, 28),
      new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, side: THREE.DoubleSide, depthWrite: false }),
    );
    mesh.position.set(p.x, p.y, p.z);
    if (flat) mesh.rotation.x = -Math.PI / 2;
    else mesh.lookAt(this.camera.position);
    this.scene.add(mesh);
    this.bursts.push({ mesh, t: -delay });
  }

  update(match: Match, dt: number, showHint: boolean, humanId: 0 | 1): void {
    const me = match.players[humanId];

    // 鏡頭：在自己這側後上方，稍微跟著自己左右移動
    this.camX += (me.pos.x * this.pose.follow - this.camX) * Math.min(1, dt * 3);
    const shake = this.shakeAmt;
    this.shakeAmt = Math.max(0, this.shakeAmt - dt * 0.6);
    this.placeCamera(this.camX, (Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    if (this.target.visible) (this.target.material as THREE.MeshBasicMaterial).opacity = 0.32 + Math.sin(match.time * 4) * 0.08;
    if (this.fovPunch > 0 || this.camera.fov !== this.baseFov) {
      this.fovPunch = Math.max(0, this.fovPunch - dt * 25);
      this.camera.fov = this.baseFov - this.fovPunch;
      this.camera.updateProjectionMatrix();
    }

    match.players.forEach((p, i) => this.models[i].update(p, dt, match.shuttle.pos));
    this.env?.update(dt);

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

    // 落點提示：對方打來的球（黃／紅）；自己剛打出去的球短暫顯示白色虛影
    const pred = sh.prediction;
    const incoming = flying && sh.lastHitter !== null && sh.lastHitter !== humanId;
    const mineJustHit = flying && sh.lastHitter === humanId && match.time - sh.launchTime < 0.45;
    if (showHint && (incoming || mineJustHit) && pred?.landing) {
      const L = pred.landing;
      this.marker.visible = true;
      this.marker.position.set(L.x, 0.012, L.z);
      const out = Math.abs(L.x) > COURT.singlesHalfWidth + 0.03 || Math.abs(L.z) > COURT.halfLength + 0.03;
      const mat = this.marker.material as THREE.MeshBasicMaterial;
      mat.color.set(out ? 0xff5a5a : incoming ? 0xffd54a : 0xffffff);
      mat.opacity = incoming ? 0.8 : 0.45;
    } else this.marker.visible = false;

    // 擊球範圍圈：球打過來時顯示；羽球即將進入範圍（現在划剛好）時變綠
    const rr = this.reachRing.material as THREE.MeshBasicMaterial;
    if (incoming && match.phase === 'rally') {
      const tIn = timeUntilInReach(match, humanId);
      const now = tIn !== null && tIn <= GAME.idealContactT + 0.05;
      this.reachRing.visible = true;
      this.reachRing.position.set(me.pos.x, 0.011, me.pos.z);
      this.reachRing.scale.setScalar(me.reachMul);
      rr.color.set(now ? 0x5dff8a : 0xffffff);
      rr.opacity = now ? 0.75 : 0.18;
    } else this.reachRing.visible = false;

    // 發球時自己能站的區域
    const box = match.serveBox(humanId);
    this.serveBoxLine.visible = !!box;
    if (box) {
      const y = 0.013;
      const pts = [
        new THREE.Vector3(box.x0, y, box.z0),
        new THREE.Vector3(box.x1, y, box.z0),
        new THREE.Vector3(box.x1, y, box.z1),
        new THREE.Vector3(box.x0, y, box.z1),
      ];
      this.serveBoxLine.geometry.setFromPoints(pts);
      (this.serveBoxLine.material as THREE.LineBasicMaterial).opacity = 0.5 + Math.sin(match.time * 6) * 0.2;
    }

    // 特效動畫
    for (const b of this.bursts) {
      b.t += dt;
      if (b.t < 0) continue;
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
