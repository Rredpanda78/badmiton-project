import * as THREE from 'three';
import { GAME } from '../config';
import type { PlayerState, Swing } from '../sim/match';
import type { Family } from '../sim/shots';
import { chargeZones } from '../sim/shots';
import { clamp, damp, easeIn, easeOut, lerp, smooth01, solveTwoBone } from './anim/ik';
import {
  ARM_READY,
  ARM_RELAX,
  ARM_RUN,
  BH_UNDER,
  FH_UNDER,
  L_LUNGE_FORE,
  L_LUNGE_UP,
  L_READY_FORE,
  L_READY_UP,
  L_RELAX_FORE,
  L_RELAX_UP,
  OVERHEAD,
  poseAt,
  SWING_POSES,
  type SwingType,
} from './anim/poses';

const ZONES = chargeZones();
const ARM_LEN = 1.06; // 肩膀到拍面中心的距離

// ---- 骨架尺寸（公尺）。root 原點 = 腳底中心，模型面向 -z、右手在 +x ----
const THIGH = 0.41;
const SHIN = 0.41;
const ANKLE = 0.075; // 腳踝離地高度
const LEG = THIGH + SHIN;
const HIP_W = 0.1; // 髖關節左右間距的一半
const STAND_H = 0.86; // 站直時髖關節高度
const READY_H = 0.75; // 準備姿勢（膝蓋微蹲）
const RUN_H = 0.79;
const LUNGE_H = 0.52;
const LUNGE_F = 0.56; // 弓步：前腳（右）在身體前方多遠
const LUNGE_B = 0.5; // 後腳（左）在身體後方多遠（後腳打直）
const AIR_H = 0.84;
const WAIST = 0.1; // 腰（上身旋轉軸）在髖關節上方
const UPPER_ARM = 0.29;
const FOREARM = 0.27;

// 胸口座標
const SHOULDER_R = new THREE.Vector3(0.24, 0.46, 0);
const SHOULDER_L = new THREE.Vector3(-0.24, 0.46, 0);
const NECK = new THREE.Vector3(0, 0.62, 0);
const DOWN = new THREE.Vector3(0, -1, 0);

/** 一隻腳的落腳狀態：著地時固定在世界座標不動（不會滑），換步時沿弧線移到下一個落點 */
class Foot {
  planted = true;
  wx = 0; // 腳目前的世界 x/z
  wz = 0;
  fromX = 0;
  fromZ = 0;
  toX = 0;
  toZ = 0;
  u = 1; // 換步進度 0..1
  dur = 0.2;
  lift = 0.06;
  forced = false; // 指定落點（弓步），不跟著身體重新瞄準
  gap = -1; // 這一步是否限制兩腳不交叉（起步時決定）
  runK = 0; // 這一步的「跑步感」：腳跟先離地、腳跟先著地
  h = 0; // 離地高度
  yaw = 0;
  yawFrom = 0;
  yawTo = 0;
  pitch = 0;
  pivoting = false;
  homeX = 0; // 理想站位（世界，不含移動預判）
  homeZ = 0;
  homeYaw = 0;
  readonly local = new THREE.Vector3(); // 腳踝在 root 座標
  readonly hip = new THREE.Vector3();
  readonly knee = new THREE.Vector3();
  readonly ankle = new THREE.Vector3();
  constructor(
    readonly sign: 1 | -1, // -1 左腳、+1 右腳
    readonly thigh: THREE.Mesh,
    readonly shin: THREE.Mesh,
    readonly shoe: THREE.Mesh,
  ) {}
}

// 每幀共用的暫存（不在 update 裡配置記憶體）
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();

/**
 * 程序式動畫的低多邊形球員：
 * - 腳會「踩住」地面（世界座標固定），依速度決定步幅與步頻，膝蓋用兩節骨 IK
 * - 依移動方向切換步法：往前跑＋最後一步弓步、側併步、後退側身併步／交叉步、對手擊球時分腿跳（split step）
 * - 髖部與上身會轉向羽球或移動方向，加減速時前傾／後仰，步伐帶上下起伏
 * - 揮拍依擊球點分成頭頂／正反手平抽／下手，有轉體與隨揮；空中跳殺做剪刀腳；落地屈膝緩衝
 */
export class PlayerModel {
  readonly root = new THREE.Group();
  private pelvis = new THREE.Group();
  private chest = new THREE.Group();
  private head = new THREE.Group();
  private armR = new THREE.Group();
  private upperL: THREE.Mesh;
  private foreL: THREE.Mesh;
  private feet: [Foot, Foot];
  private aura: THREE.Mesh;
  private auraMat: THREE.MeshBasicMaterial;
  private auraT = 0;
  private shadow: THREE.Mesh;
  private jumpMark: THREE.Mesh;
  private jumpMat: THREE.MeshBasicMaterial;

  // ---- 動畫狀態 ----
  private inited = false;
  private lastX = 0;
  private lastZ = 0;
  private lastSide = 1;
  private clock = 0;
  private pvx = 0;
  private pvz = 0;
  private accX = 0;
  private accZ = 0;
  private dirX = 0;
  private dirZ = -1;
  private moveK = 0;
  private peak = 0;
  private peakX = 0;
  private peakZ = -1;
  private idleT = 0;
  private psi = 0; // 身體總扭轉
  private hipY = READY_H;
  private yOut = READY_H; // 實際髖部高度（上一幀）
  private crouch = 0; // 彈簧：落地緩衝
  private crouchV = 0;
  private offX = 0; // 髖部水平位移（擊球探身）
  private offZ = 0;
  private offY = 0;
  private wide = 0; // 分腿跳後寬站姿剩餘時間
  private splitPending = false;
  private lastStep: Foot | null = null;
  private wasAir = false;
  private scissor = 0;
  private relaxK = 0;
  // 弓步
  private lunging = false;
  private lungeT = 0;
  private lungeCool = 0;
  private lungeX = 0;
  private lungeZ = -1;
  private lungeYaw = 0;
  private lungeHold = false;
  private lungeBack = false; // 正在從弓步往回蹬
  private L = 0;
  // 揮拍
  private curSwing: Swing | null = null;
  private swingHit = false;
  private swingType: SwingType = OVERHEAD;
  private poseType: SwingType = OVERHEAD;
  private lastKp = 0;
  private kLast = 0;
  private wPose = 0;
  private swingStartQ = new THREE.Quaternion();
  private cpL = new THREE.Vector3(); // 擊球點（root 座標）
  // 羽球
  private shL = new THREE.Vector3(); // 羽球（root 座標）
  private shPrev = new THREE.Vector3();
  private shHave = false;
  private shSpeed = 0;
  private shToward = false;
  private shRest = 0;
  // 上半身
  private qC = new THREE.Quaternion(); // 胸口 → root 的旋轉
  private qCi = new THREE.Quaternion();
  private mC = new THREE.Matrix4();
  private shoulderR = new THREE.Vector3();
  private shoulderL = new THREE.Vector3();
  private lU = new THREE.Vector3(-0.3, -0.82, -0.5).normalize();
  private lF = new THREE.Vector3(0.2, 0.3, -0.93).normalize();
  private headYaw = 0;
  private headPitch = 0;

  constructor(shirt: number, shorts: number) {
    const skin = new THREE.MeshLambertMaterial({ color: 0xf0c7a0 });
    const shirtM = new THREE.MeshLambertMaterial({ color: shirt });
    const shortsM = new THREE.MeshLambertMaterial({ color: shorts });
    const shoeM = new THREE.MeshLambertMaterial({ color: 0xf2f2f2 });

    // ---- 髖部（root 的子物件，原點 = 髖關節中心）----
    const hips = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.17, 0.22, 10), shortsM);
    hips.position.y = 0.05;
    this.pelvis.add(hips);
    this.pelvis.rotation.order = 'YXZ';
    this.pelvis.position.y = READY_H;

    // ---- 上身（腰部旋轉）----
    this.chest.position.y = WAIST;
    this.chest.rotation.order = 'YXZ';
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.42, 4, 10), shirtM);
    torso.position.y = 0.24;
    torso.scale.z = 0.7;
    this.chest.add(torso);
    this.head.position.copy(NECK);
    this.head.rotation.order = 'YXZ';
    const headM = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 10), skin);
    headM.position.y = 0.08;
    this.head.add(headM);
    // 頭髮蓋住頭頂與後腦，看得出臉朝哪
    const hair = new THREE.Mesh(
      new THREE.SphereGeometry(0.137, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2),
      new THREE.MeshLambertMaterial({ color: 0x2a1d14 }),
    );
    hair.position.y = 0.09;
    hair.rotation.x = 0.5;
    this.head.add(hair);
    this.chest.add(this.head);
    this.pelvis.add(this.chest);
    this.root.add(this.pelvis);

    // ---- 腿：大腿、小腿、鞋各自擺在 root 座標（由 IK 決定）----
    const thighGeo = new THREE.CapsuleGeometry(0.068, THIGH, 3, 8);
    thighGeo.translate(0, -THIGH / 2, 0);
    const shortLegGeo = new THREE.CapsuleGeometry(0.088, 0.12, 3, 8);
    shortLegGeo.translate(0, -0.08, 0);
    const shinGeo = new THREE.CapsuleGeometry(0.054, SHIN, 3, 8);
    shinGeo.translate(0, -SHIN / 2, 0);
    const shoeGeo = new THREE.BoxGeometry(0.105, 0.075, 0.25);
    shoeGeo.translate(0, -ANKLE / 2, -0.05);
    const mkFoot = (sign: 1 | -1) => {
      const thigh = new THREE.Mesh(thighGeo, skin);
      thigh.add(new THREE.Mesh(shortLegGeo, shortsM));
      const shin = new THREE.Mesh(shinGeo, skin);
      const shoe = new THREE.Mesh(shoeGeo, shoeM);
      shoe.rotation.order = 'YXZ';
      this.root.add(thigh, shin, shoe);
      return new Foot(sign, thigh, shin, shoe);
    };
    this.feet = [mkFoot(-1), mkFoot(1)];

    // ---- 左手（兩節：上臂＋前臂，沿 -Y）----
    const sleeveGeo = new THREE.CapsuleGeometry(0.062, 0.06, 3, 8);
    sleeveGeo.translate(0, -0.05, 0);
    const upperGeo = new THREE.CapsuleGeometry(0.045, UPPER_ARM, 3, 8);
    upperGeo.translate(0, -UPPER_ARM / 2, 0);
    const foreGeo = new THREE.CapsuleGeometry(0.04, FOREARM, 3, 8);
    foreGeo.translate(0, -FOREARM / 2, 0);
    this.upperL = new THREE.Mesh(upperGeo, skin);
    this.upperL.add(new THREE.Mesh(sleeveGeo, shirtM));
    this.foreL = new THREE.Mesh(foreGeo, skin);
    this.root.add(this.upperL, this.foreL);

    // ---- 右手＋球拍：沿 +Y 方向延伸，用四元數指向目標 ----
    const armGeo = new THREE.CylinderGeometry(0.045, 0.04, 0.55, 8);
    armGeo.translate(0, 0.275, 0);
    this.armR.add(new THREE.Mesh(armGeo, skin));
    const sleeveR = new THREE.Mesh(new THREE.CapsuleGeometry(0.062, 0.06, 3, 8), shirtM);
    sleeveR.position.y = 0.05;
    this.armR.add(sleeveR);
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.3, 6), new THREE.MeshLambertMaterial({ color: 0x222222 }));
    handle.position.y = 0.68;
    this.armR.add(handle);
    const frame = new THREE.Mesh(new THREE.TorusGeometry(0.115, 0.012, 6, 20), new THREE.MeshLambertMaterial({ color: shirt }));
    frame.scale.set(0.82, 1, 1);
    frame.rotation.y = Math.PI / 2;
    frame.position.y = 0.94;
    this.armR.add(frame);
    const strings = new THREE.Mesh(
      new THREE.CircleGeometry(0.11, 16),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
    );
    strings.scale.set(0.82, 1, 1);
    strings.rotation.y = Math.PI / 2;
    strings.position.y = 0.94;
    this.armR.add(strings);
    this.armR.quaternion.copy(ARM_READY);
    this.root.add(this.armR);

    // 腳下影子
    const shadow = (this.shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.42, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false }),
    ));
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.006;
    this.root.add(shadow);

    // 跳殺待命標記（青色小圈）
    this.jumpMat = new THREE.MeshBasicMaterial({ color: 0x5ff3ff, transparent: true, opacity: 0, depthWrite: false });
    this.jumpMark = new THREE.Mesh(new THREE.RingGeometry(0.22, 0.3, 28), this.jumpMat);
    this.jumpMark.rotation.x = -Math.PI / 2;
    this.root.add(this.jumpMark);
    // 蓄力光圈：按下就亮起，蓄越多越大越亮，進入出界區變紅
    this.auraMat = new THREE.MeshBasicMaterial({ color: 0xffd54a, transparent: true, opacity: 0, depthWrite: false });
    this.aura = new THREE.Mesh(new THREE.RingGeometry(0.46, 0.56, 36), this.auraMat);
    this.aura.rotation.x = -Math.PI / 2;
    this.aura.position.y = 0.012;
    this.root.add(this.aura);
  }

  /**
   * @param dt 真實時間（秒）。動畫內部換成模擬時間，跟遊戲的慢動作倍率同步。
   * @param shuttle 羽球世界座標（可省略）：有的話會看球、轉身面向球、對手擊球時做分腿跳
   */
  update(p: PlayerState, dt: number, shuttle?: { x: number; y: number; z: number }): void {
    const ta = Math.max(0, dt) * GAME.simSpeed;
    const side = p.side;
    this.clock += ta;
    this.root.position.set(p.pos.x, p.pos.y, p.pos.z);
    this.root.rotation.y = side === 1 ? 0 : Math.PI;
    this.root.updateMatrixWorld();
    // 影子、光圈留在地上；跳越高影子越小
    const ground = -p.pos.y + 0.006;
    this.shadow.position.y = ground;
    const ss = 1 - Math.min(0.4, p.pos.y * 0.8);
    this.shadow.scale.set(ss, ss, ss);
    this.aura.position.y = ground + 0.006;
    this.jumpMark.position.y = ground + 0.008;
    this.updateFx(p, dt);

    if (!this.inited || side !== this.lastSide || Math.hypot(p.pos.x - this.lastX, p.pos.z - this.lastZ) > 0.9) this.reset(p);
    this.lastX = p.pos.x;
    this.lastZ = p.pos.z;
    this.lastSide = side;

    // ---------- 移動狀態（root 座標：-z 往前、+x 往右）----------
    const vx = p.vel.x * side;
    const vz = p.vel.z * side;
    const speed = Math.hypot(vx, vz);
    if (ta > 0) {
      this.accX = damp(this.accX, clamp((vx - this.pvx) / ta, -60, 60), 12, ta);
      this.accZ = damp(this.accZ, clamp((vz - this.pvz) / ta, -60, 60), 12, ta);
    }
    this.pvx = vx;
    this.pvz = vz;
    if (speed > 0.25) {
      this.dirX = vx / speed;
      this.dirZ = vz / speed;
    }
    const moveK = (this.moveK = damp(this.moveK, smooth01((speed - 0.35) / 2.4), 12, ta));
    // 從靜止起步：沒有羽球資訊時用一個小蹲當作啟動
    if (speed < 0.3) this.idleT += ta;
    else if (speed > 1) {
      if (!shuttle && this.idleT > 0.25 && !p.airborne) this.crouchV -= 0.55;
      this.idleT = 0;
    }

    // ---------- 羽球 ----------
    let shOK = false;
    if (shuttle) {
      shOK = true;
      this.shL.set((shuttle.x - p.pos.x) * side, shuttle.y - p.pos.y, (shuttle.z - p.pos.z) * side);
      if (this.shHave && ta > 0) {
        const dx = shuttle.x - this.shPrev.x;
        const dy = shuttle.y - this.shPrev.y;
        const dz = shuttle.z - this.shPrev.z;
        const sp = Math.hypot(dx, dy, dz) / ta;
        if (sp < 150) {
          // 太大 = 發球前重新擺位（瞬移），忽略
          if (sp > 0.01) this.shSpeed = sp;
          if (sp > 6) {
            const toward = side * dz > 0;
            // 羽球從對面改成朝自己飛 = 對手剛擊球 → 分腿跳
            if (toward && !this.shToward && shuttle.z * side < 0.6) this.splitPending = true;
            this.shToward = toward;
          }
          this.shRest = sp < 0.05 && shuttle.y < 0.05 ? this.shRest + ta : 0;
        }
      }
      if (ta > 0) {
        this.shPrev.set(shuttle.x, shuttle.y, shuttle.z);
        this.shHave = true;
      }
    } else {
      this.shHave = false;
      this.shRest = 0;
    }
    const shNear = shOK && Math.hypot(this.shL.x, this.shL.z) < 3.5;
    const relaxK = (this.relaxK = damp(this.relaxK, this.shRest > 0.4 ? 1 : 0, 3, ta));

    // ---------- 揮拍 ----------
    const s = p.swing;
    if (s !== this.curSwing) {
      this.curSwing = s;
      this.swingHit = false;
      this.kLast = 0;
      if (s) {
        this.swingStartQ.copy(this.armR.quaternion);
        this.swingType = this.classify(shNear ? this.shL : null, s.family, p.airborne || s.airborne);
      }
    }
    if (s && s.contacted && s.contactPoint) {
      const cp = s.contactPoint;
      this.cpL.set((cp.x - p.pos.x) * side, cp.y - p.pos.y, (cp.z - p.pos.z) * side);
      if (!this.swingHit) {
        this.swingHit = true;
        this.swingType = this.classify(this.cpL, s.family, p.airborne || s.airborne);
      }
    }
    // 揮拍進度 k：0 = 引拍、1 = 擊球、2 = 隨揮結束
    let k = 2;
    if (s) {
      if (s.contacted) {
        const tc = Math.max(s.contactT, 0.06);
        k = s.t <= tc ? s.t / tc : 1 + Math.min(1, (s.t - tc) / Math.max(0.05, GAME.swingDuration - tc));
      } else if (s.whiffed || s.t > s.window) {
        k = 1 + Math.min(1, (s.t - s.window) / 0.14);
      } else {
        k = Math.min(s.airborne ? 0.2 : 0.8, (s.t / GAME.idealContactT) * 0.8);
        if (shNear) {
          // 羽球越靠近肩膀，拍子越往擊球位置揮
          const d = Math.hypot(this.shL.x - 0.24, this.shL.y - 1.35, this.shL.z);
          k = Math.max(k, 0.92 * (1 - clamp((d - 0.9) / (Math.max(4, this.shSpeed) * 0.08), 0, 1)));
        }
      }
      k = this.kLast = Math.max(k, this.kLast);
    }
    let poseType: SwingType;
    let kp: number;
    if (s) {
      poseType = this.swingType;
      kp = k;
    } else if (p.charging) {
      poseType = this.classify(shNear ? this.shL : null, 'up', p.airborne);
      kp = 0;
    } else {
      poseType = this.poseType;
      kp = this.lastKp;
    }
    this.poseType = poseType;
    this.lastKp = kp;
    this.wPose = damp(this.wPose, s ? 1 : p.charging ? 0.8 : 0, s ? 22 : p.charging ? 7 : 3.5, ta);
    const wPose = this.wPose;
    const P = SWING_POSES[poseType];
    const under = poseType === FH_UNDER || poseType === BH_UNDER;

    // ---------- 弓步 ----------
    this.lungeCool -= ta;
    if (speed >= this.peak) {
      this.peak = speed;
      this.peakX = this.dirX;
      this.peakZ = this.dirZ;
    } else this.peak = Math.max(speed, this.peak - ta * 5);
    if (!this.lunging && !p.airborne && this.lungeCool <= 0) {
      if (this.peak > 3.4 && speed < Math.min(3, this.peak - 1.5)) {
        // 往前（或側向）衝刺後急停 → 最後一步跨成弓步
        if (-this.peakZ > -0.3 && (Math.abs(p.pos.z) < 3.8 || p.charging || s)) this.startLunge(p, this.peakX, this.peakZ);
        this.peak = speed;
      } else if (s && !s.whiffed && s.t < 0.12 && (this.swingType === FH_UNDER || this.swingType === BH_UNDER)) {
        // 低點擊球且球在身前偏遠 → 跨步去接
        const ref = s.contacted ? this.cpL : shNear ? this.shL : null;
        if (ref) {
          const h = Math.hypot(ref.x, ref.z);
          if (h > 0.55 && ref.z < 0.1 && vx * ref.x + vz * ref.z > -h) this.startLunge(p, ref.x / h, ref.z / h);
        }
      }
    }
    if (this.lunging) {
      this.lungeT += ta;
      let hold = this.lungeT < 0.3 || (s !== null && this.lungeT < 0.6);
      const along = vx * this.lungeX + vz * this.lungeZ;
      this.lungeBack = speed > 1.2 && along < -0.3 * speed;
      if (this.lungeBack) hold = false; // 已經往回蹬
      if (speed > 3.2 && along > 0.7 * speed) hold = false; // 其實沒停，繼續跑
      if (p.airborne) hold = false;
      if (!hold && this.lungeHold) this.feet[1].forced = false; // 跨到一半就收回：改成跟著身體
      this.lungeHold = hold;
      this.L = damp(this.L, hold ? 1 : 0, hold ? 16 : 6, ta);
      if (!hold && this.L < 0.05) {
        this.lunging = false;
        this.lungeCool = 0.2;
        this.L = 0;
      }
    }
    const L = this.L;

    // ---------- 身體朝向 ----------
    // a：移動方向（0 = 往前、負 = 往右、±π = 往後）
    const a = Math.atan2(-this.dirX, -this.dirZ);
    const aa = Math.abs(a);
    let psiMove: number;
    if (aa <= 1) psiMove = a * 0.75; // 往前跑：身體朝跑的方向
    else if (aa <= 2.1) psiMove = Math.sign(a) * lerp(0.75, 0.45, (aa - 1) / 1.1); // 側併步：大致面向網
    else psiMove = lerp(Math.sign(a) * 0.45, -1, (aa - 2.1) / (Math.PI - 2.1)); // 後退：右肩往後側身
    let psiT = shOK ? clamp(Math.atan2(-this.shL.x, Math.max(0.3, -this.shL.z)) * 0.5, -0.35, 0.35) : 0;
    psiT = lerp(psiT, psiMove, moveK);
    if (L > 0) psiT = lerp(psiT, this.lungeYaw, L);
    psiT = lerp(psiT, poseAt(P.yaw, kp), wPose);
    this.psi = damp(this.psi, psiT, s ? 22 : 9, ta);
    const yawP = this.psi * lerp(0.8, 0.45, wPose);
    const twist = this.psi - yawP;
    const cy = Math.cos(yawP);
    const sy = Math.sin(yawP);

    // ---------- 站位（每隻腳的理想位置）----------
    const back = clamp((this.dirZ - 0.5) / 0.4, 0, 1) * moveK;
    const cross = back * smooth01((speed - 4) / 1.5); // 快速後退 → 交叉步
    this.wide = Math.max(0, this.wide - ta);
    let w = lerp(lerp(0.21, 0.15, relaxK), 0.11, moveK) + (this.wide > 0 ? 0.05 : 0);
    w = lerp(w, 0.05, cross);
    const zL = lerp(lerp(0.03, 0, moveK), -0.08, cross);
    const zR = lerp(lerp(-0.07, 0, moveK), 0.06, cross);
    const splay = lerp(0.22, 0.08, moveK);
    // 頭頂球側身：右腳往後
    const wOver = poseType === OVERHEAD && !p.airborne ? wPose * (kp < 1 ? 1 : Math.max(0, 2 - kp) * 0.6) : 0;
    const lyaw = Math.atan2(-this.lungeX, -this.lungeZ);
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      const pz = f.sign > 0 ? zR : zL;
      const px = f.sign * w;
      let hx = px * cy + pz * sy;
      let hz = -px * sy + pz * cy;
      if (f.sign > 0) {
        hx += 0.03 * wOver;
        hz += 0.16 * wOver;
      } else hz -= 0.08 * wOver;
      let hyaw = yawP - f.sign * splay;
      if (L > 0) {
        const lx = this.lungeX;
        const lz = this.lungeZ;
        // 弓步：右腳在前（沿移動方向），左腳在後
        const tx = f.sign > 0 ? lx * LUNGE_F - lz * 0.08 : -lx * LUNGE_B + lz * 0.1;
        const tz = f.sign > 0 ? lz * LUNGE_F + lx * 0.08 : -lz * LUNGE_B - lx * 0.1;
        hx = lerp(hx, tx, L);
        hz = lerp(hz, tz, L);
        hyaw = lerp(hyaw, f.sign > 0 ? lyaw : lyaw + 1, L);
      }
      f.homeX = p.pos.x + side * hx;
      f.homeZ = p.pos.z + side * hz;
      f.homeYaw = hyaw;
    }

    // ---------- 步伐參數 ----------
    const lat = Math.abs(this.dirX * cy - this.dirZ * sy); // 移動方向與骨盆左右軸的夾角 → 併步程度
    let dur = lerp(clamp(0.27 - 0.022 * speed, 0.13, 0.27), clamp(0.19 - 0.01 * speed, 0.13, 0.19), lat);
    let lift = lerp(0.05 + 0.017 * speed, 0.045, lat);
    if (moveK < 0.3) {
      dur = lerp(0.16, dur, moveK / 0.3);
      lift = lerp(0.035, lift, moveK / 0.3);
    }
    const runK = moveK * (1 - lat);
    const gap = cross > 0.5 || lat < 0.5 ? -1 : 0.12; // 併步（側向移動）時兩腳不交叉

    const fl = this.feet[0];
    const fr = this.feet[1];
    if (!p.airborne) {
      if (this.wasAir) this.land();
      // 進行中的步伐
      for (let i = 0; i < 2; i++) {
        const f = this.feet[i];
        if (f.planted) continue;
        if (!f.forced && this.wide <= 0) {
          // 起步加速時，這一步也跟著加快、抬高
          f.dur = Math.min(f.dur, dur);
          f.lift = Math.max(f.lift, lift);
          f.runK = Math.max(f.runK, runK);
        }
        f.u = Math.min(1, f.u + ta / f.dur);
        if (!f.forced) {
          // 跟著身體重新瞄準落點，但每幀移動有上限（避免落點突然跳）
          const ox = f.toX;
          const oz = f.toZ;
          this.stepTarget(f, this.feet[1 - i], p, f.dur, f.u, f.gap, cy, sy);
          const dx = f.toX - ox;
          const dz = f.toZ - oz;
          const dl = Math.hypot(dx, dz);
          const maxD = (speed + 2) * ta * 1.5;
          if (dl > maxD) {
            f.toX = ox + (dx * maxD) / dl;
            f.toZ = oz + (dz * maxD) / dl;
          }
        }
        const e = smooth01(f.u);
        f.wx = lerp(f.fromX, f.toX, e);
        f.wz = lerp(f.fromZ, f.toZ, e);
        f.h = f.lift * Math.sin(Math.PI * f.u);
        f.yaw = lerp(f.yawFrom, f.yawTo, e);
        f.pitch = Math.sin(Math.PI * f.u) * lerp(-0.55, 0.35, f.u) * f.runK;
        if (f.u >= 1) {
          f.planted = true;
          f.h = 0;
          f.pitch = 0;
          f.forced = false;
          this.crouchV -= 0.12 + 0.07 * speed; // 著地吸收
        }
      }
      // 著地的腳：身體轉很多時腳掌才跟著轉（以前腳掌為軸）
      for (let i = 0; i < 2; i++) {
        const f = this.feet[i];
        if (!f.planted) continue;
        const d = f.homeYaw - f.yaw;
        if (Math.abs(d) > 0.6) f.pivoting = true;
        if (f.pivoting) {
          f.yaw = damp(f.yaw, f.homeYaw, 8, ta);
          if (Math.abs(d) < 0.15) f.pivoting = false;
        }
      }
      // 分腿跳：兩腳同時離地，落成較寬的站姿
      if (this.splitPending) {
        this.splitPending = false;
        if (fl.planted && fr.planted && !s && !this.lunging && p.landRecover <= 0) {
          this.wide = 0.45;
          for (let i = 0; i < 2; i++) {
            const f = this.feet[i];
            this.beginStep(f, f.wx, f.wz, 0.13, 0.055, f.homeYaw, false, 0);
            this.stepTarget(f, this.feet[1 - i], p, 0.13, 0, -1, cy, sy);
            f.toX += f.sign * cy * 0.05 * side;
            f.toZ -= f.sign * sy * 0.05 * side;
          }
        }
      }
      // 該換哪隻腳：離理想位置最遠、超過門檻的那隻（另一隻要踩穩；快跑時另一隻快落地就可以起步 → 有騰空期）
      {
        let thr = lerp(0.13, 0.085, moveK);
        if (s && !s.whiffed && !(s.contacted && s.t > s.contactT + 0.05)) thr = 0.42; // 揮拍時腳踩穩
        const back = this.lunging && this.lungeBack;
        const overlap = back ? 0 : speed > 3 && !this.lungeHold ? 0.7 : 1;
        let best: Foot | null = null;
        let bestE = 0;
        for (let i = 0; i < 2; i++) {
          const f = this.feet[i];
          const o = this.feet[1 - i];
          if (!f.planted || (!o.planted && o.u < overlap)) continue;
          // 弓步中前腳撐住；蹬回時先收前腳（右腳），後腳等一下
          let ft = thr;
          if (this.lunging && this.lungeHold) ft = f.sign > 0 ? 0.28 : 0.3;
          else if (back) ft = f.sign > 0 ? 0.12 : 0.6;
          const e = Math.hypot(f.homeX - f.wx, f.homeZ - f.wz) - (f === this.lastStep ? 0.03 : 0);
          if (e > ft && e > bestE) {
            best = f;
            bestE = e;
          }
        }
        if (best) {
          // 弓步時後腳是往後拖一小步（幾乎不抬腳）
          const drag = this.lunging && this.lungeHold && best.sign < 0;
          this.beginStep(best, 0, 0, drag ? 0.14 : dur, drag ? 0.02 : lift, best.homeYaw, false, drag ? 0 : runK);
          this.stepTarget(best, best === fl ? fr : fl, p, dur, 0, gap, cy, sy);
        }
      }
      // 安全網：腳離髖部太遠（伸不到）就立刻跨
      for (let i = 0; i < 2; i++) {
        const f = this.feet[i];
        if (!f.planted) continue;
        const lx = (f.wx - p.pos.x) * side - (this.offX + f.sign * HIP_W * cy);
        const lz = (f.wz - p.pos.z) * side - (this.offZ - f.sign * HIP_W * sy);
        // 快跑時後腳拖太遠就先蹬起（兩腳同時離地＝跑步的騰空期），不讓髖部被拉低
        if (Math.hypot(lx, lz) > (this.lunging ? 0.88 : speed > 3 ? 0.56 : 0.8)) {
          this.beginStep(f, 0, 0, Math.min(dur, 0.16), lift, f.homeYaw, false, runK);
          this.stepTarget(f, this.feet[1 - i], p, Math.min(dur, 0.16), 0, -1, cy, sy);
        }
      }
      for (let i = 0; i < 2; i++) {
        const f = this.feet[i];
        f.local.set((f.wx - p.pos.x) * side, ANKLE + f.h, (f.wz - p.pos.z) * side);
      }
    } else {
      // ---------- 空中：剪刀腳 ----------
      if (!this.wasAir) {
        this.wasAir = true;
        this.scissor = 0;
        for (let i = 0; i < 2; i++) {
          this.feet[i].planted = false;
          this.feet[i].forced = true;
          this.feet[i].u = 1;
        }
      }
      this.scissor = damp(this.scissor, (s && s.contacted) || p.vy < -0.6 ? 1 : 0, 16, ta);
      const sc = this.scissor;
      const ext = p.vy < 0 ? clamp(p.pos.y / 0.25, 0, 1) : 1; // 快落地時腳伸直準備著地
      for (let i = 0; i < 2; i++) {
        const f = this.feet[i];
        // 起跳時右腳在後、左腳在前；擊球後交換（右腳往前踢）
        const rx = f.sign * 0.1;
        const ry = f.sign > 0 ? lerp(-0.42, -0.56, sc) : lerp(-0.64, -0.44, sc);
        const rz = f.sign > 0 ? lerp(0.4, -0.34, sc) : lerp(-0.2, 0.38, sc);
        const ax = this.offX + rx * cy + rz * sy;
        const az = this.offZ - rx * sy + rz * cy;
        const hx = (f.homeX - p.pos.x) * side;
        const hz = (f.homeZ - p.pos.z) * side;
        const tx = lerp(hx, ax, ext);
        const ty = lerp(ANKLE, AIR_H + this.crouch + ry, ext);
        const tz = lerp(hz, az, ext);
        const r = 1 - Math.exp(-18 * ta);
        f.local.x += (tx - f.local.x) * r;
        f.local.y += (Math.max(ANKLE, ty) - f.local.y) * r;
        f.local.z += (tz - f.local.z) * r;
        f.wx = p.pos.x + side * f.local.x;
        f.wz = p.pos.z + side * f.local.z;
        f.h = f.local.y - ANKLE;
        f.yaw = damp(f.yaw, yawP - f.sign * 0.1, 6, ta);
        f.pitch = damp(f.pitch, -0.35 * ext, 8, ta);
      }
    }

    // ---------- 擊球探身（沿用：接觸點太遠時手臂伸長、身體往那邊探）----------
    let stretch = 1;
    let offTX = 0;
    let offTZ = 0;
    let offTY = 0;
    if (s && s.contacted && s.contactPoint) {
      const dir = _v1.subVectors(this.cpL, this.shoulderR);
      const dist = dir.length();
      const windT = Math.max(s.contactT, 0.06);
      const near = 1 - Math.min(1, Math.abs(s.t - windT) / 0.12);
      stretch = 1 + (Math.min(1.35, Math.max(1, dist / ARM_LEN)) - 1) * near;
      const over = Math.max(0, dist - ARM_LEN) * near;
      const hl = Math.hypot(dir.x, dir.z) || 1;
      offTX = (dir.x / hl) * Math.min(0.3, over);
      offTZ = (dir.z / hl) * Math.min(0.3, over);
      if (dir.y > 0.5 * dist) offTY = Math.min(0.12, over * 0.5);
    }
    offTX += this.lungeX * 0.15 * L; // 弓步：重心往前腳移
    offTZ += this.lungeZ * 0.15 * L;
    this.offX = damp(this.offX, offTX, 25, ta);
    this.offZ = damp(this.offZ, offTZ, 25, ta);
    this.offY = damp(this.offY, offTY, 25, ta);

    // ---------- 髖部高度 ----------
    let hT = lerp(lerp(READY_H, RUN_H, moveK), STAND_H, relaxK);
    if (this.wide > 0) hT -= 0.03;
    if (p.jumpArmed && !p.airborne) hT -= 0.07; // 跳殺待命：蹲低蓄勢
    if (p.landRecover > 0) hT -= 0.13 * clamp(p.landRecover / GAME.jump.landRecover, 0, 1);
    if (under) hT -= 0.05 * wPose;
    hT = lerp(hT, LUNGE_H, L);
    if (p.airborne) hT = AIR_H;
    this.hipY = damp(this.hipY, hT, 10, ta);
    // 彈簧（落地緩衝）
    for (let rem = ta; rem > 1e-6; rem -= 1 / 120) {
      const h = Math.min(rem, 1 / 120);
      this.crouchV += (-260 * this.crouch - 26 * this.crouchV) * h;
      this.crouch += this.crouchV * h;
    }
    let y = this.hipY + this.crouch;
    if (!p.airborne) {
      y += Math.min(fl.h, fr.h) + Math.max(fl.h, fr.h) * 0.22 * runK; // 兩腳都離地（分腿跳）時整個人離地；跑步時跨步中身體略高
      y += 0.006 * Math.sin(this.clock * 9) * (1 - moveK) * (1 - relaxK); // 待機時輕微彈動
      // 踩住的腳必須搆得到：必要時髖部降低（弓步、大跨步自然蹲低）。空中的腳伸不到就由 IK 收回來
      for (let i = 0; i < 2; i++) {
        const f = this.feet[i];
        const hx = this.offX + f.sign * HIP_W * cy;
        const hz = this.offZ - f.sign * HIP_W * sy;
        const hd = Math.hypot(f.local.x - hx, f.local.z - hz);
        // 跨步中的腳越接近落地，限制越強（髖部提前慢慢降，不會落地瞬間一沉）
        const free = f.planted ? 0 : 1 - f.u;
        const reach = LEG * 0.985 + free * free * 0.5;
        y = Math.min(y, f.local.y + Math.sqrt(Math.max(0, reach * reach - hd * hd)));
      }
      y = Math.max(y, 0.48);
      // 上下都限速（往下較快）：遠處的腳一落地／離地，髖部不會瞬間沉下或彈起；短暫的落差由小腿伸長補
      if (y > this.yOut) y = Math.min(y, this.yOut + ta * 3);
      else y = Math.max(y, this.yOut - ta * 5);
    }
    this.yOut = y;

    // ---------- 骨盆與上身 ----------
    // 加速時往加速方向傾（減速時後仰），跑動時略往前傾
    let leanF = clamp(-this.accZ * 0.0045, -0.2, 0.24) + clamp(-vz * 0.018, -0.12, 0.12);
    let leanR = clamp(this.accX * 0.0045, -0.18, 0.18) + clamp(vx * 0.012, -0.08, 0.08);
    if (p.airborne) leanF = leanR = 0;
    const lf = -leanR * sy + leanF * cy; // 換到骨盆座標
    const lr = leanR * cy + leanF * sy;
    this.pelvis.position.set(this.offX, y, this.offZ);
    this.pelvis.rotation.set(-lf * 0.45, yawP, -lr * 0.45);
    const pitchC = 0.1 * (1 - relaxK) + 0.06 * moveK + 0.3 * L + poseAt(P.pitch, kp) * wPose;
    this.chest.position.y = WAIST + this.offY;
    this.chest.rotation.set(-(pitchC + lf * 0.55), twist, -lr * 0.55 + poseAt(P.roll, kp) * wPose);
    this.pelvis.updateMatrix();
    this.chest.updateMatrix();
    this.mC.multiplyMatrices(this.pelvis.matrix, this.chest.matrix);
    this.qC.multiplyQuaternions(this.pelvis.quaternion, this.chest.quaternion);
    this.qCi.copy(this.qC).invert();
    this.shoulderR.copy(SHOULDER_R).applyMatrix4(this.mC);
    this.shoulderL.copy(SHOULDER_L).applyMatrix4(this.mC);

    // ---------- 腿（兩節骨 IK）----------
    const pfx = -Math.sin(yawP);
    const pfz = -Math.cos(yawP);
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      f.hip.set(f.sign * HIP_W, 0, 0).applyMatrix4(this.pelvis.matrix);
      // 膝蓋朝腳尖方向、略往外
      _pole.set(-Math.sin(f.yaw) + pfx * 0.3 + f.sign * cy * 0.15, 0, -Math.cos(f.yaw) + pfz * 0.3 - f.sign * sy * 0.15);
      solveTwoBone(f.hip, f.local, THIGH, SHIN, _pole, f.knee, f.ankle);
      f.thigh.position.copy(f.hip);
      f.thigh.quaternion.setFromUnitVectors(DOWN, _v1.subVectors(f.knee, f.hip).normalize());
      // 踩住的腳：鞋子留在原地（小腿稍微拉長補縫）；空中的腳：跟著 IK 收回
      const foot = f.planted ? f.local : f.ankle;
      const sv = _v1.subVectors(foot, f.knee);
      const len = sv.length();
      f.shin.position.copy(f.knee);
      if (len > 1e-4) f.shin.quaternion.setFromUnitVectors(DOWN, sv.multiplyScalar(1 / len));
      f.shin.scale.y = clamp(len / SHIN, 0.85, 1.15);
      f.shoe.position.copy(foot);
      f.shoe.rotation.set(f.pitch, f.yaw, 0);
    }

    // ---------- 持拍手 ----------
    this.armR.position.copy(this.shoulderR);
    if (s) {
      const qW = _q1.multiplyQuaternions(this.qC, P.wind);
      if (s.t < 0.05) qW.slerpQuaternions(this.swingStartQ, _q3.copy(qW), s.t / 0.05);
      const qHit = _q2;
      if (s.contacted && s.contactPoint) this.aimFromShoulder(qHit, this.cpL);
      else if (shNear) this.aimFromShoulder(qHit, this.shL);
      else qHit.multiplyQuaternions(this.qC, P.contact);
      if (k <= 1) this.armR.quaternion.slerpQuaternions(qW, qHit, easeIn(k));
      else {
        const qF = _q3.multiplyQuaternions(this.qC, P.follow);
        // 網前小球（下壓族、低點）：隨揮很短
        if (under && s.family === 'down') qF.slerpQuaternions(qHit, _q1.copy(qF), 0.35);
        this.armR.quaternion.slerpQuaternions(qHit, qF, easeOut(k - 1));
      }
    } else {
      let target: THREE.Quaternion;
      if (p.charging) target = _q1.multiplyQuaternions(this.qC, P.wind);
      else {
        _q2.copy(ARM_READY).slerp(ARM_RUN, moveK * 0.7).slerp(ARM_RELAX, relaxK);
        target = _q1.multiplyQuaternions(this.qC, _q2);
      }
      this.armR.quaternion.slerp(target, 1 - Math.exp(-(p.charging ? 22 : 13) * ta));
    }
    this.armR.scale.y += (stretch - this.armR.scale.y) * Math.min(1, ta * 48);

    // ---------- 非持拍手 ----------
    this.updateLeftArm(P, poseType, kp, wPose, moveK, relaxK, L, runK, shOK, ta);

    // ---------- 頭：看羽球 ----------
    const neck = _v1.copy(NECK).applyMatrix4(this.mC);
    const look = shOK ? _v2.subVectors(this.shL, neck) : _v2.set(0, -0.2, -1);
    look.applyQuaternion(this.qCi);
    let hy = Math.atan2(-look.x, -look.z);
    if (Math.abs(hy) > 1.9) hy = 0; // 在背後就不硬轉
    const hp = Math.atan2(look.y, Math.hypot(look.x, look.z));
    this.headYaw = damp(this.headYaw, clamp(hy, -1.1, 1.1), 12, ta);
    this.headPitch = damp(this.headPitch, clamp(hp, -0.5, 0.75), 12, ta);
    this.head.rotation.set(this.headPitch, this.headYaw, 0);
  }

  /** 揮拍種類：看擊球點（或接近中的羽球）的高度與左右 */
  private classify(ref: THREE.Vector3 | null, family: Family, air: boolean): SwingType {
    if (air) return OVERHEAD;
    if (ref) {
      if (ref.y >= 1.75) return OVERHEAD;
      const fh = ref.x > -0.08;
      if (ref.y < 1.05) return fh ? FH_UNDER : BH_UNDER;
      return fh ? 1 : 2;
    }
    return family === 'side' ? 1 : OVERHEAD;
  }

  /** 從右肩指向 root 座標的某點 */
  private aimFromShoulder(out: THREE.Quaternion, target: THREE.Vector3): void {
    const d = _v3.subVectors(target, this.shoulderR);
    if (d.lengthSq() < 1e-6) d.set(0, 1, 0);
    out.setFromUnitVectors(_pole.set(0, 1, 0), d.normalize());
  }

  private startLunge(p: PlayerState, dx: number, dz: number): void {
    this.lunging = true;
    this.lungeHold = true;
    this.lungeT = 0;
    this.lungeX = dx;
    this.lungeZ = dz;
    this.lungeYaw = clamp(Math.atan2(-dx, -dz), -1.3, 1.3);
    // 右腳（持拍腳）大跨一步、腳跟先著地
    const f = this.feet[1];
    const tx = dx * LUNGE_F - dz * 0.08;
    const tz = dz * LUNGE_F + dx * 0.08;
    // 落點以「預計停下來的位置」為準（模擬裡減速約 40 m/s²）
    const stop = Math.hypot(p.vel.x, p.vel.z) / 80;
    this.beginStep(f, 0, 0, 0.17, 0.08, Math.atan2(-dx, -dz), true, 0.6);
    f.toX = p.pos.x + p.side * tx + p.vel.x * stop;
    f.toZ = p.pos.z + p.side * tz + p.vel.z * stop;
  }

  private beginStep(f: Foot, tx: number, tz: number, dur: number, lift: number, yawTo: number, forced: boolean, runK: number): void {
    f.planted = false;
    f.u = 0;
    f.fromX = f.wx;
    f.fromZ = f.wz;
    f.toX = tx;
    f.toZ = tz;
    f.dur = dur;
    f.lift = lift;
    f.forced = forced;
    f.runK = runK;
    f.yawFrom = f.yaw;
    f.yawTo = yawTo;
    f.pivoting = false;
    this.lastStep = f;
  }

  /**
   * 落點 = 理想站位 + 速度 × 預判時間（落地時腳會在髖部前方一點，身體再越過它）。
   * gap >= 0 時不讓兩腳交叉（併步）。
   */
  private stepTarget(f: Foot, other: Foot, p: PlayerState, dur: number, u: number, gap: number, cy: number, sy: number): void {
    f.gap = gap;
    const lead = dur * (1.5 - u);
    let tx = f.homeX + p.vel.x * lead;
    let tz = f.homeZ + p.vel.z * lead;
    if (gap >= 0) {
      const side = p.side;
      let lx = (tx - p.pos.x) * side;
      let lz = (tz - p.pos.z) * side;
      const ox = ((other.planted ? other.wx : other.toX) - p.pos.x) * side;
      const oz = ((other.planted ? other.wz : other.toZ) - p.pos.z) * side;
      const xt = lx * cy - lz * sy; // 骨盆左右軸上的位置
      const xo = ox * cy - oz * sy;
      const need = f.sign > 0 ? xo + gap - xt : xt - (xo - gap);
      if (need > 0) {
        const shift = f.sign * need;
        lx += shift * cy;
        lz -= shift * sy;
        tx = p.pos.x + side * lx;
        tz = p.pos.z + side * lz;
      }
    }
    // 落點離「落地時的身體位置」不能太遠，否則腿伸不到、髖部會被拉低
    const rem = dur * (1 - u);
    const cx = tx - (p.pos.x + p.vel.x * rem);
    const cz = tz - (p.pos.z + p.vel.z * rem);
    const cd = Math.hypot(cx, cz);
    if (cd > 0.55) {
      tx -= cx * (1 - 0.55 / cd);
      tz -= cz * (1 - 0.55 / cd);
    }
    f.toX = tx;
    f.toZ = tz;
  }

  /** 落地：兩腳踩在目前位置，膝蓋吸收衝擊 */
  private land(): void {
    this.wasAir = false;
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      f.planted = true;
      f.forced = false;
      f.h = 0;
      f.pitch = 0;
      f.u = 1;
    }
    this.crouchV -= 1.7;
  }

  private updateLeftArm(
    P: (typeof SWING_POSES)[number],
    poseType: SwingType,
    kp: number,
    wPose: number,
    moveK: number,
    relaxK: number,
    L: number,
    runK: number,
    shOK: boolean,
    ta: number,
  ): void {
    const fl = this.feet[0];
    const fr = this.feet[1];
    // 跑步：與右腳反向擺動
    const sw = clamp((fr.local.z - fl.local.z) / 0.7, -1, 1) * runK;
    const tu = _v1.set(-0.22, -0.9, 0.5 * sw).normalize().multiplyScalar(moveK);
    tu.addScaledVector(L_READY_UP, (1 - moveK) * (1 - relaxK)).addScaledVector(L_RELAX_UP, relaxK * (1 - moveK));
    const tf = _v2.set(0.05, 0.05, -1).normalize().multiplyScalar(moveK);
    tf.addScaledVector(L_READY_FORE, (1 - moveK) * (1 - relaxK)).addScaledVector(L_RELAX_FORE, relaxK * (1 - moveK));
    tu.normalize().lerp(L_LUNGE_UP, L);
    tf.normalize().lerp(L_LUNGE_FORE, L);
    tu.normalize().applyQuaternion(this.qC);
    tf.normalize().applyQuaternion(this.qC);
    if (wPose > 0.01) {
      // 揮拍姿勢（root 座標）
      const pu = _v3.copy(kp < 1 ? P.lUpPrep : P.lUpHit);
      const hitW = kp < 1 ? easeIn(kp) : 1;
      if (poseType === OVERHEAD && kp < 1) {
        // 頭頂球準備：左手指向羽球
        if (shOK && this.shL.y > this.shoulderL.y) pu.subVectors(this.shL, this.shoulderL).normalize();
        if (pu.y < 0.4) pu.setY(0.4).normalize();
        pu.lerp(_pole.copy(P.lUpHit).applyQuaternion(this.qC), hitW).normalize();
        tu.lerp(pu, wPose);
        tf.lerp(_pole.copy(pu).lerp(_v3.copy(P.lForeHit).applyQuaternion(this.qC), hitW), wPose);
      } else {
        pu.copy(P.lUpPrep).lerp(P.lUpHit, hitW).normalize().applyQuaternion(this.qC);
        tu.lerp(pu, wPose);
        pu.copy(P.lForePrep).lerp(P.lForeHit, hitW).normalize().applyQuaternion(this.qC);
        tf.lerp(pu, wPose);
      }
    }
    const r = 1 - Math.exp(-16 * ta);
    if (tu.lengthSq() > 1e-4) this.lU.lerp(tu.normalize(), r).normalize();
    if (tf.lengthSq() > 1e-4) this.lF.lerp(tf.normalize(), r).normalize();
    this.upperL.position.copy(this.shoulderL);
    this.upperL.quaternion.setFromUnitVectors(DOWN, this.lU);
    this.foreL.position.copy(this.shoulderL).addScaledVector(this.lU, UPPER_ARM);
    this.foreL.quaternion.setFromUnitVectors(DOWN, this.lF);
  }

  /** 蓄力光圈與跳殺標記（與原本相同） */
  private updateFx(p: PlayerState, dt: number): void {
    if (p.charging) {
      this.auraT += dt;
      const pulse = 1 + Math.sin(this.auraT * 14) * 0.04;
      const s = (0.85 + p.charge * 0.55) * pulse * (this.auraT < 0.12 ? 1.25 - this.auraT * 2 : 1);
      this.aura.scale.set(s, s, s);
      this.auraMat.opacity = 0.55 + p.charge * 0.4;
      this.auraMat.color.set(p.charge >= ZONES.out ? 0xff4a4a : p.charge >= ZONES.deep ? 0x2fe07a : p.charge >= ZONES.net ? 0x9be37b : 0xffa34a);
    } else {
      this.auraT = 0;
      this.auraMat.opacity = Math.max(0, this.auraMat.opacity - dt * 5);
    }
    const armed = p.jumpArmed && !p.airborne;
    this.jumpMat.opacity += ((armed ? 0.9 : 0) - this.jumpMat.opacity) * Math.min(1, dt * 12);
  }

  /** 第一次或瞬移（發球前重新站位）時，直接擺成準備姿勢 */
  private reset(p: PlayerState): void {
    this.inited = true;
    const side = p.side;
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      const hx = f.sign * 0.21;
      const hz = f.sign > 0 ? -0.07 : 0.03;
      f.wx = f.homeX = p.pos.x + side * hx;
      f.wz = f.homeZ = p.pos.z + side * hz;
      f.planted = !p.airborne;
      f.forced = false;
      f.u = 1;
      f.h = 0;
      f.pitch = 0;
      f.yaw = f.yawTo = f.homeYaw = -f.sign * 0.22;
      f.pivoting = false;
      f.local.set(hx, ANKLE, hz);
    }
    this.psi = 0;
    this.hipY = this.yOut = READY_H;
    this.crouch = this.crouchV = 0;
    this.lunging = false;
    this.L = 0;
    this.peak = 0;
    this.offX = this.offZ = this.offY = 0;
    this.wide = 0;
    this.splitPending = false;
    this.wasAir = p.airborne;
    this.scissor = 0;
    this.accX = this.accZ = 0;
    this.pvx = p.vel.x * side;
    this.pvz = p.vel.z * side;
    this.shHave = false;
    this.shToward = false;
  }
}
