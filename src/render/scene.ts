import * as THREE from 'three';
import { CAMERA, COURT, GAME, type Quality, type Venue } from '../config';
import { ballTaker } from '../ai/doubles';
import { flickNow, timeUntilInReach, type Match, type MatchEvent, type PlayerId } from '../sim/match';
import { v3, type Vec3 } from '../sim/physics';
import { predictContact, type ContactHint } from './anim/contact';
import { makeCourt } from './court';
import { buildVenue, type Environment } from './environment';
import { FxSystem } from './fx';
import { PlayerModel, playerStyle } from './playerModel';
import type { CamPose } from './replay';
import { makeShuttleMesh } from './shuttle';

/** 球員外觀：球衣顏色＋（可選）角色造型與球拍顏色 */
export interface Look {
  shirt: number;
  shorts: number;
  id?: string;
  racketColor?: number;
  racket?: string; // 球拍種類（拍框外型）
}

const SHUTTLE_SCALE = 2.4; // 真實羽球太小，放大一點比較看得清楚
const TRAIL_LEN = 22;

// ---------- 即時影子 ----------
/** 畫質 → 影子貼圖邊長（0 = 不開即時影子，只用腳下的圓形假影） */
const SHADOW_SIZE: Record<Quality, number> = { high: 2048, medium: 1024, low: 0 };
/** 畫質 → 影子邊緣柔化半徑（貼圖像素；three 的 PCF 是 5 點取樣的圓盤）：中的像素大一倍，半徑小一點、世界尺寸差不多 */
const SHADOW_RADIUS: Record<Quality, number> = { high: 4, medium: 2.5, low: 0 };
/** 影子相機要框住的範圍：球場（13.4 × 6.1 m）四周各多 1.2 m，高到跳殺時的拍頭 */
const SHADOW_BOX = { x: COURT.doublesHalfWidth + 1.2, y: 3.4, z: COURT.halfLength + 1.2 };
const SUN_DIST = 30; // 平行光擺多遠（只影響影子相機的位置，方向才重要）
/** 主光預設方向（往光源）：左前上方，仰角約 57°，影子落在球員右邊、偏向鏡頭這側（看得到、能把人踩在地上） */
const DEFAULT_SUN_DIR: [number, number, number] = [-0.5, 1, -0.4];
const DEFAULT_FILL: [number, number] = [0xdfe8ff, 0.7]; // 補光顏色、強度
/** 腳下的圓形假影：沒有即時影子時的不透明度（playerModel 的原值）、有即時影子時留一點點當接地的暗處 */
const BLOB_FULL = 0.32;
const BLOB_UNDER_REAL = 0.1;
const _box = new THREE.Vector3();

/** 依裝置挑預設畫質：手機（粗指標或短邊不到 700 px）中、其他高 */
export function defaultQuality(): Quality {
  const phone = matchMedia('(pointer: coarse)').matches || Math.min(screen.width, screen.height) < 700;
  return phone ? 'medium' : 'high';
}

export class GameRenderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100);
  private models: PlayerModel[]; // 索引 = 球員編號（單打 2 個、雙打 4 個）
  private hints: ContactHint[] = [0, 1, 2, 3].map(() => ({ t: 0, x: 0, y: 0, z: 0, d: 0 }));
  private youMark: THREE.Group; // 雙打：自己頭上的小箭頭＋腳下的圈（四個人才認得出自己）
  private shuttle = new THREE.Group();
  private shuttleShadow: THREE.Mesh;
  private trail: THREE.Line;
  private trailPts: THREE.Vector3[] = [];
  private marker: THREE.Mesh;
  private reachRing: THREE.Mesh;
  private shOffset = new THREE.Vector3(); // 線上：對方擊球時的位置修正（慢慢歸零）
  private shSerial = -1;
  private serveBoxLine: THREE.LineLoop;
  private target: THREE.Mesh;
  private baseFov = 40;
  private fovPunch = 0;
  private fx: FxSystem; // 擊球／殺球特效（render/fx.ts）
  // 鏡頭震動：振幅隨時間平方衰減，幾個高頻正弦疊起來（比每幀亂數順、看得清楚）
  private shakeAmp = 0;
  private shakeDur = 0.25;
  private shakeT = 1;
  private shakePh = [0, 0, 0, 0];
  private camX = 0;
  private hemi: THREE.HemisphereLight;
  private sun: THREE.DirectionalLight; // 主光：會投影（太陽／月亮／天花板燈），方向、顏色依場地
  private fill: THREE.DirectionalLight; // 補光：從鏡頭這側打過來、不投影（主光在對面，球員朝鏡頭的那面才不會黑成一片）
  private sunDir = new THREE.Vector3(...DEFAULT_SUN_DIR).normalize();
  private sunVs: 1 | -1 = 1; // 擺主光時的 viewSide（線上換邊要重擺，影子才一樣朝向鏡頭）
  private quality: Quality = 'high';
  private shadowsOn = true;
  private env: Environment | null = null;
  private venue: Venue | null = null;
  private pose = CAMERA.landscape;
  private reserve = 0;
  private tmp = new THREE.Vector3();
  /** 得分回放的電影鏡頭（null = 一般比賽鏡頭）；回放時落點提示、擊球範圍圈、發球區、雙打箭頭都不畫 */
  private cine: CamPose | null = null;
  private cineDt = 0; // 回放時鏡頭震動用真實時間衰減（動畫的 dt 是慢動作）
  viewSide: 1 | -1 = 1; // 1 = 自己在畫面下方（z>0）

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    // 即時影子：只有球員、球拍、羽球會投影，只有球場地墊和旁邊的地面會接影子（setQuality 決定貼圖大小／關掉）
    // three r186 已拿掉 PCFSoft，PCF 本身就是 5 點圓盤取樣、柔化半徑用 shadow.radius 調
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    container.appendChild(this.renderer.domElement);
    this.scene.background = new THREE.Color(0x111a26);
    this.scene.fog = new THREE.Fog(0x111a26, 26, 48);

    this.hemi = new THREE.HemisphereLight(0xe6eeff, 0x2a3442, 1.6);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 1.6);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(SHADOW_SIZE.high, SHADOW_SIZE.high);
    this.sun.shadow.radius = SHADOW_RADIUS.high;
    this.sun.shadow.bias = -0.0004; // 地墊是平的、正對著光：一點負偏移去掉條紋狀的影子痤瘡
    this.sun.shadow.normalBias = 0.02; // 沿法線往外推一點（約 2 個貼圖像素），球員腳邊不會浮一條亮縫
    this.scene.add(this.sun, this.sun.target);
    this.fill = new THREE.DirectionalLight(DEFAULT_FILL[0], DEFAULT_FILL[1]);
    this.scene.add(this.fill);

    this.scene.add(makeCourt(this.renderer.capabilities.getMaxAnisotropy()));
    this.setVenue('indoor');

    this.models = [new PlayerModel(0x2f7fe0, 0x1b2a44), new PlayerModel(0xe0483a, 0x3a1b1b)];
    for (const m of this.models) {
      this.scene.add(m.root);
      this.applyShadowFlags(m);
    }

    // 羽球：軟木頭在原點、羽毛往 +Y 展開（本體投影，外框不用）
    const shuttleMesh = makeShuttleMesh(SHUTTLE_SCALE);
    (shuttleMesh.children[0] as THREE.Mesh).castShadow = true;
    this.shuttle.add(shuttleMesh);
    this.scene.add(this.shuttle);

    // 特效（殺球殘影共用羽球本體的幾何）
    this.fx = new FxSystem((shuttleMesh.children[0] as THREE.Mesh).geometry, this.camera, {
      shake: (amp, dur) => this.shake(amp, dur),
      punch: (deg) => (this.fovPunch = Math.max(this.fovPunch, deg)),
    });
    this.scene.add(this.fx.group);
    // 特效平常是隱藏的，shader 會等第一次殺球才編譯（手機上會卡一下）：先編好
    this.renderer.compile(this.fx.group, this.camera, this.scene);

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

    // 雙打的「你」標記：頭上一個朝下的黃色箭頭（會上下浮動）＋腳下一個黃圈
    this.youMark = new THREE.Group();
    const markMat = new THREE.MeshBasicMaterial({ color: 0xffd54a, transparent: true, opacity: 0.95, depthWrite: false });
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.15, 0.3, 4), markMat);
    arrow.rotation.x = Math.PI; // 尖端朝下
    arrow.name = 'arrow';
    this.youMark.add(arrow);
    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.42, 0.5, 40),
      new THREE.MeshBasicMaterial({ color: 0xffd54a, transparent: true, opacity: 0.55, depthWrite: false }),
    );
    ring.rotation.x = -Math.PI / 2;
    ring.name = 'ring';
    this.youMark.add(ring);
    this.youMark.visible = false;
    this.scene.add(this.youMark);

    this.resize();
  }

  /**
   * 依螢幕方向擺鏡頭，並自動算視角讓整個球場剛好塞滿畫面。
   * 手機直向時，畫面下方保留 reserve 比例給兩個拇指搖桿，球場只畫在上面那塊。
   */
  /** 效能保險：先降影子（高 → 中 → 關），再降解析度（2 → 1.5 → 1.2 → 1）；已經最低就回傳 false */
  lowerQuality(): boolean {
    if (this.quality !== 'low') {
      this.setQuality(this.quality === 'high' ? 'medium' : 'low');
      return true;
    }
    const pr = this.renderer.getPixelRatio();
    const next = pr > 1.5 ? 1.5 : pr > 1.2 ? 1.2 : pr > 1 ? 1 : 0;
    if (!next) return false;
    this.renderer.setPixelRatio(next);
    this.resize();
    return true;
  }

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
    if (this.cine) this.fullFrame(); // 回放中轉向：電影鏡頭照樣用整個畫面
    this.camera.updateProjectionMatrix();
  }

  /** 電影鏡頭：整個畫面（不保留搖桿區）、正常寬高比 */
  private fullFrame(): void {
    this.camera.clearViewOffset();
    this.camera.aspect = window.innerWidth / Math.max(1, window.innerHeight);
  }

  /**
   * 進入得分回放：之後 update() 收到的是回放的檢視用比賽、鏡頭照 setCinematic 擺。
   * 特效、球員動作（步法、揮拍、拖尾）全部重來，不沿用比賽中的狀態。
   */
  beginReplay(view: Match): void {
    this.cine = { pos: v3(), look: v3(0, 0, -1), fov: this.baseFov };
    this.resetLive();
    this.resetTrail(view.shuttle.pos); // 拖尾從回放的起點開始（不要從比賽的落點拉一條線過來）
    this.fullFrame();
    this.camera.updateProjectionMatrix();
  }

  /** 這一幀的電影鏡頭；realDt = 真實時間（鏡頭震動衰減用） */
  setCinematic(pose: CamPose, realDt: number): void {
    if (!this.cine) return;
    this.cine.pos = pose.pos;
    this.cine.look = pose.look;
    this.cine.fov = pose.fov;
    this.cineDt = realDt;
  }

  /** 離開回放：回到一般鏡頭（視角、搖桿區重新算），回放留下的特效、動作、拖尾清掉，接回比賽目前的狀態 */
  endReplay(live: Match): void {
    this.cine = null;
    this.resetLive();
    this.resetTrail(live.shuttle.pos);
    this.shuttle.position.set(live.shuttle.pos.x, live.shuttle.pos.y, live.shuttle.pos.z);
    this.resize();
  }

  get inReplay(): boolean {
    return !!this.cine;
  }

  private resetLive(): void {
    this.fx.clear();
    for (const m of this.models) m.snap();
    this.shakeAmp = 0;
    this.shakeT = 1;
    this.fovPunch = 0;
    this.camera.fov = this.baseFov;
    this.marker.visible = this.reachRing.visible = this.serveBoxLine.visible = this.youMark.visible = false;
  }

  /** 畫面下方保留給搖桿的比例（UI 用） */
  get bottomReserve(): number {
    return this.reserve;
  }

  /**
   * 畫質（設定「畫質」與自動降級共用）：high／medium = 即時影子 2048／1024 貼圖，low = 不開即時影子、腳下只有圓形假影。
   * 換貼圖大小要把舊的 render target 丟掉讓 three 重建；開關主光的投影會讓所有受光材質換 shader（這裡先編好，不在下一幀卡）。
   */
  setQuality(q: Quality): void {
    if (q === this.quality) return;
    this.quality = q;
    const size = SHADOW_SIZE[q];
    const sh = this.sun.shadow;
    if (size > 0 && sh.mapSize.x !== size) {
      sh.mapSize.set(size, size);
      sh.map?.dispose();
      sh.map = null;
      sh.radius = SHADOW_RADIUS[q];
      sh.normalBias = size >= 2048 ? 0.02 : 0.035; // 貼圖像素變大，偏移也要跟著大
    }
    this.sun.castShadow = size > 0;
    this.shadowsOn = size > 0;
    for (const m of this.models) this.applyShadowFlags(m);
    this.renderer.compile(this.scene, this.camera);
  }

  get currentQuality(): Quality {
    return this.quality;
  }

  /**
   * 球員模型的投影旗標：身體、衣服、頭髮、球拍都投影；腳下的假影、蓄力光圈、跳殺標記、揮拍拖尾
   * （都是不寫深度的半透明 MeshBasic）不投影。有即時影子時假影只留一點點當接地的暗處。
   * （playerModel.ts 不改：這裡走訪它建好的 mesh）
   */
  private applyShadowFlags(m: PlayerModel): void {
    const on = this.shadowsOn;
    m.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = mesh.material as THREE.MeshBasicMaterial;
      if (mat.isMeshBasicMaterial && mat.transparent && !mat.depthWrite) {
        if (mesh.geometry.type === 'CircleGeometry') mat.opacity = on ? BLOB_UNDER_REAL : BLOB_FULL; // 腳下的圓影
        return;
      }
      mesh.castShadow = on;
    });
  }

  /**
   * 擺主光、補光，並把影子相機框到剛好蓋住球場＋邊緣＋跳起來的高度（在光的座標系裡取 8 個角的包圍盒）。
   * 線上換邊（viewSide = -1）時整個鏡像，影子一樣落在偏向鏡頭的那側。
   */
  private placeSun(): void {
    const vs = (this.sunVs = this.viewSide);
    const d = this.sunDir;
    this.sun.position.set(d.x * SUN_DIST, d.y * SUN_DIST, d.z * vs * SUN_DIST);
    this.fill.position.set(3, 6, 9 * vs);
    const cam = this.sun.shadow.camera;
    cam.position.copy(this.sun.position);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    const inv = cam.matrixWorld.clone().invert();
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const sx of [-1, 1]) {
      for (const sy of [0, 1]) {
        for (const sz of [-1, 1]) {
          _box.set(sx * SHADOW_BOX.x, sy * SHADOW_BOX.y, sz * SHADOW_BOX.z).applyMatrix4(inv);
          x0 = Math.min(x0, _box.x);
          x1 = Math.max(x1, _box.x);
          y0 = Math.min(y0, _box.y);
          y1 = Math.max(y1, _box.y);
          z0 = Math.min(z0, _box.z);
          z1 = Math.max(z1, _box.z);
        }
      }
    }
    cam.left = x0;
    cam.right = x1;
    cam.bottom = y0;
    cam.top = y1;
    cam.near = -z1 - 0.5;
    cam.far = -z0 + 0.5;
    cam.updateProjectionMatrix();
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

  /** 換場地（見 environment.ts 的 VENUE_IDS）；舊場地的幾何、材質、貼圖整個釋放 */
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
    this.sun.intensity = env.sunPower ?? 1.6;
    this.sunDir.set(...(env.sunDir ?? DEFAULT_SUN_DIR)).normalize();
    const [fc, fi] = env.fill ?? DEFAULT_FILL;
    this.fill.color.set(fc);
    this.fill.intensity = fi;
    this.placeSun();
  }

  /** 換球員外觀（球衣顏色）；looks[i] = i 號球員（單打 2 個、雙打 4 個） */
  setLooks(looks: Look[]): void {
    for (const m of this.models) {
      this.scene.remove(m.root);
      m.dispose();
    }
    this.models = looks.map((l) => new PlayerModel(l.shirt, l.shorts, l.id ? playerStyle(l.id, l.racketColor, l.racket) : undefined));
    for (const m of this.models) {
      this.scene.add(m.root);
      this.applyShadowFlags(m);
    }
    this.fx.clear(); // 新的一場：上一場的焦痕、拖尾清掉
  }

  resetTrail(p: Vec3): void {
    for (const t of this.trailPts) t.set(p.x, p.y, p.z);
  }

  /** 擊球特效（一般球）：品質越好越大越金；殺球的特效在 fxEvent（render/fx.ts） */
  burst(p: Vec3, quality: number, smash: boolean, jump: boolean): void {
    if (smash || jump) return;
    const perfect = quality >= 0.9;
    const poor = quality < 0.74;
    const color = perfect ? 0xffd54a : poor ? 0x9aa4b0 : 0xffffff;
    const size = perfect ? 1.25 : poor ? 0.7 : 1;
    this.fx.ring(p, color, size, false);
    if (perfect) {
      this.fx.ring(p, 0xffffff, size * 0.6, false, 0.06);
      this.fx.sparkle(p, color);
    }
  }

  /** 落地揚塵 */
  dust(p: Vec3): void {
    this.fx.ring(v3(p.x, 0.02, p.z), 0xd7dee8, 2.2, true);
  }

  /**
   * 比賽事件 → 畫面特效（main.ts 的 handleEvent 每個事件呼叫一次）。
   * 殺球（往下壓且超過 120 km/h，或跳殺）：擊球點爆閃、震波、音爆圈、火花、螢幕閃光＋集中線、鏡頭震動；
   * 飛行中能量拖尾＋殘影；落地炸開（地面震波、碎屑、焦痕，得分更大）。
   * live = false（主選單示範）不閃螢幕、震動減半。跟擊中停頓無關（線上沒有停頓也一樣）。
   */
  fxEvent(e: MatchEvent, match: Match, live = true): void {
    switch (e.type) {
      case 'hit': {
        const smash = !e.serve && ((e.family === 'down' && e.speedKmh > 120) || e.jump);
        if (!smash) {
          this.fx.endFlight();
          break;
        }
        const chance = e.name === '機會殺球';
        // 機會殺球的 jump 旗標不代表真的跳起來：看擊球的人是不是在空中
        const electric = chance ? !!match.players[e.player]?.airborne : e.jump;
        const near = e.pos.z * this.viewSide > 0;
        this.fx.smash({ pos: e.pos, vel: e.vel, kmh: e.speedKmh, perfect: e.grade === '完美', electric, chance, near, live });
        break;
      }
      case 'land':
        this.fx.land(e.pos, e.inBounds);
        break;
      case 'net':
        this.fx.net(e.pos);
        break;
    }
  }

  /** 鏡頭震動 amp 公尺、dur 秒（比現在還在震的小就忽略） */
  shake(amp: number, dur = 0.25): void {
    const env = Math.max(0, 1 - this.shakeT / this.shakeDur);
    if (amp < this.shakeAmp * env * env) return;
    this.shakeAmp = amp;
    this.shakeDur = dur;
    this.shakeT = 0;
    for (let i = 0; i < 4; i++) this.shakePh[i] = Math.random() * Math.PI * 2;
  }

  update(match: Match, dt: number, showHint: boolean, humanId: PlayerId): void {
    const me = match.players[humanId];
    // 比賽人數跟模型數不同（例如還沒 setLooks）就補上預設外觀
    while (this.models.length < match.players.length) {
      const m = new PlayerModel(0x8a96a8, 0x2a2f38);
      this.models.push(m);
      this.scene.add(m.root);
      this.applyShadowFlags(m);
    }
    this.models.forEach((m, i) => (m.root.visible = i < match.players.length));
    if (this.sunVs !== this.viewSide) this.placeSun();

    const cine = this.cine;
    // 鏡頭：在自己這側後上方，稍微跟著自己左右移動（回放：照回放算好的電影鏡頭）
    if (!cine) this.camX += (me.pos.x * this.pose.follow - this.camX) * Math.min(1, dt * 3);
    const sdt = cine ? this.cineDt : dt;
    this.shakeT += sdt;
    const env = Math.max(0, 1 - this.shakeT / this.shakeDur);
    const amp = this.shakeAmp * env * env * (cine ? 0.6 : 1);
    const st = this.shakeT;
    const ph = this.shakePh;
    const sx = amp * (Math.sin(st * 57 + ph[0]) * 0.65 + Math.sin(st * 103 + ph[1]) * 0.35);
    const sy = amp * (Math.sin(st * 49 + ph[2]) * 0.65 + Math.sin(st * 89 + ph[3]) * 0.35);
    if (cine) {
      this.camera.position.set(cine.pos.x + sx, cine.pos.y + sy, cine.pos.z);
      this.camera.lookAt(cine.look.x, cine.look.y, cine.look.z);
      this.camera.updateMatrixWorld();
      this.fovPunch = Math.max(0, this.fovPunch - sdt * 25);
      this.camera.fov = cine.fov - this.fovPunch;
      this.camera.updateProjectionMatrix();
    } else {
      this.placeCamera(this.camX, sx, sy);
      if (this.fovPunch > 0 || this.camera.fov !== this.baseFov) {
        this.fovPunch = Math.max(0, this.fovPunch - dt * 25);
        this.camera.fov = this.baseFov - this.fovPunch;
        this.camera.updateProjectionMatrix();
      }
    }
    if (this.target.visible) (this.target.material as THREE.MeshBasicMaterial).opacity = 0.32 + Math.sin(match.time * 4) * 0.08;

    // 步法動畫：預估每位球員多久後、在哪裡擊球（唯讀）；發球階段：1 = 發球的人、2 = 接發球的人（雙打的夥伴 = 0）
    // 雙打：只有分到這一球的人做擊球步法，另一人照常移動
    const lh = match.shuttle.lastHitter;
    const taker = match.doubles && lh !== null ? (ballTaker(match, match.teamOf(lh) === 0 ? 1 : 0)?.id ?? null) : null;
    match.players.forEach((p, i) => {
      const serve = match.phase === 'serve' ? (match.server === p.id ? 1 : match.receiver === p.id ? 2 : 0) : 0;
      const hint = !match.doubles || p.id === taker ? predictContact(match, p.id, this.hints[i]) : null;
      this.models[i].update(p, dt, match.shuttle.pos, hint, serve);
    });
    // 雙打：標出自己
    this.youMark.visible = match.doubles && !cine;
    if (this.youMark.visible) {
      const bob = Math.sin(performance.now() / 260) * 0.06;
      this.youMark.position.set(me.pos.x, 0, me.pos.z);
      this.youMark.getObjectByName('arrow')!.position.y = 2.3 + me.pos.y + bob;
      this.youMark.getObjectByName('ring')!.position.y = 0.014;
    }
    this.env?.update(dt);

    // 羽球
    const sh = match.shuttle;
    // 線上：收到對方擊球時，球從本機看到的位置滑順地接到對方的擊球點（不要瞬移），約 0.1 秒收斂
    // （4 人房：別支手機上的人打的都算，包含本機搶先的那一下被別人的取代）
    const remoteHit = match.remoteMask !== null ? sh.lastHitter !== null && match.isRemote(sh.lastHitter) : sh.lastHitter === match.remote;
    if ((match.remote !== null || match.remoteMask !== null) && match.hitSerial !== this.shSerial && remoteHit && this.shSerial >= 0) {
      this.shOffset.set(this.shuttle.position.x - sh.pos.x, this.shuttle.position.y - sh.pos.y, this.shuttle.position.z - sh.pos.z);
      if (this.shOffset.length() > 2.5) this.shOffset.set(0, 0, 0);
    }
    this.shSerial = match.hitSerial;
    this.shOffset.multiplyScalar(Math.exp(-dt / 0.05));
    this.shuttle.position.set(sh.pos.x + this.shOffset.x, sh.pos.y + this.shOffset.y, sh.pos.z + this.shOffset.z);
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
    this.trail.visible = flying && !this.fx.smashing; // 殺球有自己的能量拖尾
    if (flying) {
      for (let i = TRAIL_LEN - 1; i > 0; i--) this.trailPts[i].copy(this.trailPts[i - 1]);
      this.trailPts[0].set(sh.pos.x, sh.pos.y, sh.pos.z);
      this.trail.geometry.setFromPoints(this.trailPts);
    } else this.resetTrail(sh.pos);

    // 落點提示：對方打來的球（黃／紅）；自己剛打出去的球短暫顯示白色虛影
    const pred = sh.prediction;
    const incoming = flying && sh.lastHitter !== null && !match.hitByTeam(me.team);
    const mineJustHit = flying && sh.lastHitter === humanId && match.time - sh.launchTime < 0.45;
    if (showHint && !cine && (incoming || mineJustHit) && pred?.landing) {
      const L = pred.landing;
      this.marker.visible = true;
      this.marker.position.set(L.x, 0.012, L.z);
      const out = Math.abs(L.x) > match.halfWidth + 0.03 || Math.abs(L.z) > COURT.halfLength + 0.03;
      const mat = this.marker.material as THREE.MeshBasicMaterial;
      mat.color.set(out ? 0xff5a5a : incoming ? 0xffd54a : 0xffffff);
      mat.opacity = incoming ? 0.8 : 0.45;
    } else this.marker.visible = false;

    // 擊球範圍圈：球打過來時顯示；羽球即將進入範圍（現在划剛好）時變綠
    const rr = this.reachRing.material as THREE.MeshBasicMaterial;
    // 雙打：分給隊友的球不顯示（除非球真的會飛進自己的範圍）
    const tIn = incoming && match.phase === 'rally' && !cine ? timeUntilInReach(match, humanId) : null;
    const mineToTake = !match.doubles || taker === humanId || tIn !== null;
    if (incoming && match.phase === 'rally' && mineToTake && !cine) {
      const now = tIn !== null && flickNow(match, humanId, 0.05);
      this.reachRing.visible = true;
      this.reachRing.position.set(me.pos.x, 0.011, me.pos.z);
      this.reachRing.scale.setScalar(me.reachMul);
      rr.color.set(now ? 0x5dff8a : 0xffffff);
      rr.opacity = now ? 0.75 : 0.18;
    } else this.reachRing.visible = false;

    // 發球時自己能站的區域
    const box = cine ? null : match.serveBox(humanId);
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

    // 特效動畫（鏡頭已經擺好，粒子才能面向鏡頭）
    this.fx.update(dt, sh, this.camera, window.innerWidth / Math.max(1, window.innerHeight));
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
