import * as THREE from 'three';
import { GAME } from '../config';
import { CHARACTERS, type Look } from '../sim/kits';
import type { PlayerState, Swing } from '../sim/match';
import type { Family } from '../sim/shots';
import { chargeZones } from '../sim/shots';
import type { ContactHint } from './anim/contact';
import { clamp, damp, easeIn, easeOut, lerp, quatXY, quatYFront, setLocal, smooth01, solveTwoBone } from './anim/ik';
import {
  ARM_READY,
  ARM_RELAX,
  ARM_RUN,
  BEND_READY,
  BEND_RELAX,
  BEND_RUN,
  BH_UNDER,
  ELBOW_DIVE,
  ELBOW_READY,
  ELBOW_RELAX,
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
import { ANKLE, buildRig, FOREARM, HAND_TO_HEAD, HEAD_Y, type PartName, type Rig, SHIN, SHOULDER_Y, THIGH, UPPER_ARM, WAIST } from './body';
import { RacketTrail, SWOOSH_JUMP, SWOOSH_NORMAL, SWOOSH_SMASH } from './swoosh';

/** 球員外觀（全部可省略，省略 = 預設的小羽；髮型、膚色等照 kits.ts 的 Character.look） */
export interface PlayerStyle extends Partial<Look> {
  racketColor?: number; // 拍框顏色（拍線維持淺色）；省略 = 球衣色
  racket?: string; // 球拍種類（kits.ts 的 RACKETS id，決定拍框外型）；省略 = 均衡拍
  band?: number; // 頭帶、護腕、髮圈、鞋側條的顏色；省略 = 球衣色（隊伍色）
}

/** 球員外觀＋球拍顏色／種類：new PlayerModel(shirt, shorts, playerStyle(characterId, racket.color, racket.id)) */
export function playerStyle(characterId: string, racketColor?: number, racket?: string): PlayerStyle {
  const s: PlayerStyle = { ...(CHARACTERS.find((c) => c.id === characterId)?.look ?? {}) };
  if (racketColor !== undefined) s.racketColor = racketColor;
  if (racket !== undefined) s.racket = racket;
  return s;
}

const ZONES = chargeZones();
const ARM_LEN = 1.06; // 肩膀到拍面中心的距離（探身用的基準）
const HEAD_NOMINAL = UPPER_ARM + FOREARM + HAND_TO_HEAD; // 手伸直時肩膀到拍面中心（0.94）

// ---- 骨架尺寸（公尺，見 body.ts）。root 原點 = 腳底中心，模型面向 -z、右手在 +x ----
const BALL = 0.13; // 前腳掌（墊腳尖的支點）在腳踝前方多遠
const HEEL = 0.08; // 腳跟在腳踝後方多遠
const LEG = THIGH + SHIN;
const STAND_H = 0.86; // 站直時髖關節高度
const READY_H = 0.75; // 準備姿勢（膝蓋微蹲）
const RUN_H = 0.79;
const LUNGE_H = 0.52;
const AIR_H = 0.84;

// ---- 擊球同步步法（時間 = 模擬秒，距離 = 模型單位 ≈ 公尺）----
// 前場／側邊：最後一步一定是右腳大跨（弓步），腳跟先著地、剛好在擊球前踩穩；後腳留在後面用腳尖拖
// 後場頭頂：擊球前右腳退到身後側身，擊球後剪刀交換（右腳往前、左腳往後）
const LUNGE_DUR = 0.17; // 弓步那一步的時間
const LUNGE_LEAD = 0.035; // 右腳跟比擊球早這麼久著地
const LUNGE_MIN = 0.34; // 右腳落點沿弓步方向至少離身體這麼遠
const LUNGE_MAX = 0.74; // 最遠
const LUNGE_STEP = 0.3; // 這一步至少跨這麼遠（從右腳原本的位置量）
const LUNGE_REACH = 0.5; // 低點擊球：擊球點在右腳前方多遠（拍子＋手臂往前伸）
const LUNGE_REACH_HI = 0.3; // 高點（網前撲球）
const SPAN_MIN = 0.58; // 弓步兩腳前後距離：太近 → 右腳跨更遠
const SPAN_MAX = 0.95; // 太遠 → 後腳往前拖
const LUNGE_HOLD = 0.17; // 擊球後撐住弓步多久才蹬回
const LUNGE_OFF_MAX = 0.36; // 弓步時骨盆最多離 root 多遠（重心移到兩腳之間）
const FRONT_DN = 3.2; // 擊球點離網這麼近 = 前場
const OVER_Y = 1.75; // 擊球點這麼高 = 頭頂球（與 classify 一致）
const SIDE_X = 0.45; // 擊球點在身體側邊這麼遠（或低於 LOW_Y）→ 跨步去接
const LOW_Y = 1.05;
const PRE_T = 0.6; // 擊球前這麼久開始準備（後場側身右腳退後、前場重心先放後面）
const RUN_PUSH = 0.45; // 跑步時後腳離地前腳跟先抬起（前腳掌蹬地）的角度

// ---- 魚躍（撲救）：一律做成往前撲（身體先轉向撲的方向）----
const DIVE_LAND_K = 0.72; // 撲出去後 dur 的這個比例胸口著地，剩下的順勢滑一小段（模擬在 dur 停住）
const DIVE_FLY_Y = 0.55; // 撲出去時髖部高度（低、幾乎水平）
const DIVE_LIE_Y = 0.17; // 趴在地上時髖部（骨盆中心）高度
const DIVE_LIE_PITCH = -1.55; // 趴下時身體前傾（-π/2 = 完全水平）
const DIVE_BACK = 0.12; // 骨盆在 root 後方多遠（頭、手、拍子往前伸過 root，搆向擊球點）
const DIVE_GET = 0.4; // downT 剩這麼多時開始爬起來（先撐成跪姿再站起），downT 歸零剛好站好
const KNEEL_Y = 0.5; // 跪姿髖部高度

// 腰座標
const HEAD_PIVOT = new THREE.Vector3(0, HEAD_Y, 0); // 頭的轉軸（看球的視線起點）
const UP = new THREE.Vector3(0, 1, 0);
const FORWARD = new THREE.Vector3(0, 0, -1);

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
  strike = false; // 弓步：腳尖翹起、腳跟先著地，著地後腳掌再放平
  dragging = false; // 後腳用腳尖在地上拖（不抬腳）
  h0 = 0; // 換步起點的離地高度（跨到一半改成弓步時，高度要接得上）
  heel = 0; // 著地後腳尖還翹著的角度（慢慢放平）
  toe = 0; // 踩住時腳跟抬起的角度（負 = 墊腳尖）
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
    readonly upperLeg: THREE.Bone, // 樞紐：髖關節（+Y 指向膝蓋）
    readonly lowerLeg: THREE.Bone, // 膝蓋（+Y 指向腳踝）
    readonly foot: THREE.Bone, // 腳踝（Y 上、腳尖 -Z）
  ) {}
}

// 每幀共用的暫存（不在 update 裡配置記憶體）
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _v4 = new THREE.Vector3();
const _v5 = new THREE.Vector3();
const _v6 = new THREE.Vector3();
const _pole = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _q3 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _sw = new THREE.Vector3();
const _sq = new THREE.Quaternion();

/** 揮拍姿勢表的手肘方向：k = 0 引拍、1 擊球、2 隨揮結束（跟 poseAt 同樣的曲線） */
function elbowAt(out: THREE.Vector3, P: (typeof SWING_POSES)[number], k: number): THREE.Vector3 {
  if (k <= 1) {
    const u = Math.max(0, k);
    return out.copy(P.elbowPrep).lerp(P.elbowHit, u * u);
  }
  const u = 1 - Math.min(1, k - 1);
  return out.copy(P.elbowHit).lerp(P.elbowFollow, 1 - u * u * u);
}

/**
 * 程序式動畫的球員（身體零件、骨架、材質在 body.ts；這裡只負責每一幀把樞紐擺到位）：
 * - 腳會「踩住」地面（世界座標固定，轉腳以前腳掌為軸），依速度決定步幅與步頻，膝蓋用兩節骨 IK
 * - 依移動方向切換步法：往前跑（後腳墊腳尖蹬地）、側併步、後退側身併步／交叉步、對手擊球時分腿跳（split step）
 * - 最後一步跟擊球同步（用 predictContact 預估的擊球時間／位置）：前場正反手、側邊防守 → 左腳先踩、右腳大跨弓步，
 *   腳跟剛好在擊球前著地、後腳留在後面墊腳尖拖，打完撐一下再蹬回；後場頭頂球 → 先側身右腳退後，擊球瞬間剪刀交換
 * - 髖部與上身會轉向羽球或移動方向，加減速時前傾／後仰，步伐帶上下起伏
 * - 揮拍依擊球點分成頭頂／正反手平抽／下手，有轉體與隨揮；持拍手「肩膀→拍頭」那條線照姿勢表／擊球點瞄準，
 *   手肘在線外彎（引拍時彎、擊球時打直）、拍面轉向揮的方向；空中跳殺做剪刀腳；落地屈膝緩衝
 */
export class PlayerModel {
  readonly root = new THREE.Group();
  /** 樞紐（骨頭）：原點在關節、+Y 沿骨頭指向下一個關節，父子關係照 Mixamo 人形骨架（body.ts 的 MIXAMO_NAMES） */
  readonly parts: Record<PartName, THREE.Bone>;
  private readonly rig: Rig;
  private hips: THREE.Bone; // 骨盆：root 的子物件，原點 = 髖關節中心
  private spine: THREE.Bone; // 腰：上身旋轉軸（肩膀、頭都在它底下）
  private neck: THREE.Bone;
  private head: THREE.Bone;
  private upArmL: THREE.Bone;
  private foreArmL: THREE.Bone;
  private upArmR: THREE.Bone;
  private foreArmR: THREE.Bone;
  private handR: THREE.Bone;
  private feet: [Foot, Foot];
  private aura: THREE.Mesh;
  private auraMat: THREE.MeshBasicMaterial;
  private auraT = 0;
  private shadow: THREE.Mesh;
  private jumpMark: THREE.Mesh;
  private jumpMat: THREE.MeshBasicMaterial;
  private trail = new RacketTrail();
  // 外觀（身高用整體縮放：模型內部單位 = 公尺 / h）
  private readonly h: number;
  private readonly ih: number;
  private readonly hipW: number;
  private readonly shR0 = new THREE.Vector3();
  private readonly shL0 = new THREE.Vector3();
  // 持拍手：qArm = 肩膀→拍頭那條線的方向（root 座標，+Y = 那條線）；手肘在線外彎、手腕回到線上，拍子沿線
  private qArm = new THREE.Quaternion();
  private stretch = 1; // 探身：整條手臂＋拍子伸長倍率
  private bend = BEND_READY; // 手肘彎曲（弧度）
  private elbow = new THREE.Vector3(0.5, -0.7, 0.4); // 手肘凸出的方向（root 座標）
  private faceN = new THREE.Vector3(0, 0, -1); // 拍面法線（root 座標，垂直於拍子）：揮拍時朝揮的方向
  private headRel = new THREE.Vector3(); // 拍頭相對肩膀（上一幀，root 座標）
  private headHave = false;
  private wristY = UPPER_ARM + FOREARM; // 手腕在肩膀→拍頭線上的距離（彎手肘時變短）
  // 馬尾（彈簧甩動）
  private ponytail: THREE.Bone | null;
  private ptX = 0;
  private ptVX = 0;
  private ptZ = 0;
  private ptVZ = 0;
  private lastHeadYaw = 0;

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
  private lungeX = 0; // 弓步方向（root 座標單位向量）
  private lungeZ = -1;
  private lungeAng = 0; // 弓步方向的角度（0 = 往前、正 = 往左）
  private lungeYaw = 0; // 骨盆朝向
  private lungeFootYaw = 0; // 右腳腳尖朝向
  private lungeRX = 0; // 右腳落點（世界）
  private lungeRZ = 0;
  private lungeLX = 0; // 右腳落點相對身體（root 座標，跨步途中落點跟著身體走）
  private lungeLZ = 0;
  private rearWX = 0; // 後腳該在的位置（世界）
  private rearWZ = 0;
  private lungeDepth = 1; // 蹲多低（0..1）
  private lungeSwing: Swing | null = null; // 弓步期間的那一拍（拍子收完才蹬回）
  private lungeHold = false;
  private lungeBack = false; // 正在從弓步往回蹬
  private recoverT = 0; // 剛放掉弓步：右腳先蹬回
  private L = 0;
  // 擊球預估（步法時機）
  private contactAt = -1; // 預計擊球的時刻（this.clock）
  private hc = new THREE.Vector3(); // 預計擊球點（root 座標）
  private dX = 0; // lungeDir() 的結果
  private dZ = -1;
  private dA = 0;
  private prepOver = 0; // 後場頭頂球準備（右腳退後、側身）
  private prepFront = 0; // 前場弓步前：重心先放後腳
  private scissorSwing: Swing | null = null; // 已經做過地面剪刀交換的那一拍
  // 魚躍
  private diving = false; // 魚躍／趴地／爬起來中（腳不踩地，整個身體照時間擺姿勢）
  private dvYaw = 0; // 撲的方向（骨盆朝向，已就近換算到起跳時朝向 ±π 內）
  private dvYaw0 = 0; // 起跳時的骨盆朝向、前傾、上身扭轉／側彎、髖高、骨盆位移
  private dvPitch0 = 0;
  private dvArch0 = 0;
  private dvTwist0 = 0;
  private dvRoll0 = 0;
  private dvY0 = READY_H;
  private dvOffX0 = 0;
  private dvOffZ0 = 0;
  private dvG = 0; // 爬起來的進度（0..1）
  private readonly dvFoot = [new THREE.Vector3(), new THREE.Vector3()]; // 起跳時腳的位置（x,z 世界；y = root 座標高度）
  private readonly dvFootYaw = [0, 0];
  private readonly dvLie = [new THREE.Vector3(), new THREE.Vector3()]; // 趴著時腳的位置（root 座標，爬起來的起點）
  // 發球
  private serveK = 0; // 發球站姿權重（右腳在前、左腳在後）
  // 跳殺步法（起跳那一刻決定）
  private jumpStyle = 0; // 0 = 原地雙腳起跳、1 = 右腳蹬（交換步）、2 = 左腳蹬（馬來步，往左後／頭頂區）
  private jumpTake: Foot | null = null; // 單腳起跳的那隻腳
  private jumpFirst: Foot | null = null; // 單腳起跳：先著地的腳（另一隻）
  private airT = 0; // 起跳後經過的時間
  private landT = 0; // 落地後這段時間不換步（第二隻腳還在落下）
  private gvx = 0; // 最後在地上時的速度（root 座標，起跳時拿來判斷是不是邊跑邊跳）
  private gvz = 0;
  private readonly hold = [false, false]; // 這隻腳踩在地上（起跳蹬地、落地先著地），世界座標固定
  private readonly holdLand = [false, false]; // true = 落地先著地；false = 起跳蹬地（腿伸直就離地）
  private readonly holdX = [0, 0];
  private readonly holdZ = [0, 0];
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

  constructor(shirt: number, shorts: number, style: PlayerStyle = {}) {
    // ---- 體型：身高 = 整體縮放；體型 = 肩寬、髖寬、四肢粗細（body.ts）----
    const h = (this.h = clamp(style.height ?? 1, 0.85, 1.15));
    this.ih = 1 / h;
    const rig = (this.rig = buildRig({
      shirt,
      shorts,
      skin: style.skin ?? 0xf0c7a0,
      hair: style.hair ?? 'short',
      hairColor: style.hairColor ?? 0x2a1d14,
      band: style.band ?? shirt,
      headband: !!style.headband,
      accent: style.accent ?? 0xffffff,
      number: style.number,
      build: style.build ?? 1,
      racketColor: style.racketColor ?? shirt,
      racket: style.racket ?? 'balance',
    }));
    const b = (this.parts = rig.bones);
    this.hips = b.hips;
    this.spine = b.spine;
    this.neck = b.neck;
    this.head = b.head;
    this.upArmL = b.upperArmL;
    this.foreArmL = b.forearmL;
    this.upArmR = b.upperArmR;
    this.foreArmR = b.forearmR;
    this.handR = b.handR;
    this.ponytail = rig.ponytail;
    this.hipW = rig.hipW;
    this.shR0.set(rig.shoulderX, SHOULDER_Y, 0);
    this.shL0.set(-rig.shoulderX, SHOULDER_Y, 0);
    this.hips.rotation.order = 'YXZ';
    this.hips.position.y = READY_H;
    this.spine.rotation.order = 'YXZ';
    this.spine.position.y = WAIST;
    this.neck.rotation.order = 'YXZ';
    this.head.rotation.order = 'YXZ';
    if (this.ponytail) this.ponytail.rotation.order = 'XZY';
    this.feet = [new Foot(-1, b.upperLegL, b.lowerLegL, b.footL), new Foot(1, b.upperLegR, b.lowerLegR, b.footR)];
    this.root.add(this.hips, rig.mesh);
    this.root.scale.setScalar(h);
    this.qArm.copy(ARM_READY);
    // 揮拍拖尾（頂點是世界座標，見 update 最後）
    this.root.add(this.trail.mesh);

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
    this.aura.visible = this.jumpMark.visible = false;
    this.jumpMark.scale.setScalar(this.ih); // 提示圈大小不跟著身高變
  }

  /**
   * 一條腿的樞紐：大腿指向膝蓋、小腿指向腳（踩住的腳伸不到時小腿拉長，襪子那段跟著腳、不裂開）、腳掌照 pitch／yaw。
   * f.hip、f.knee（root 座標）要先用 solveTwoBone 算好；foot = 腳踝位置（root 座標）；pole = 膝蓋朝的方向
   */
  private poseLeg(f: Foot, foot: THREE.Vector3, pole: THREE.Vector3, pitch: number, yaw: number): void {
    const yT = _v5.subVectors(f.knee, f.hip).normalize();
    quatYFront(_q1, yT, pole); // 大腿（root 座標）
    setLocal(f.upperLeg, this.hips.quaternion, _q1);
    const yS = _v6.subVectors(foot, f.knee);
    const len = yS.length();
    if (len > 1e-4) yS.multiplyScalar(1 / len);
    else yS.copy(yT);
    quatYFront(_q2, yS, pole); // 小腿
    setLocal(f.lowerLeg, _q1, _q2);
    f.foot.position.y = clamp(len, SHIN * 0.8, SHIN * 1.35);
    _q3.setFromEuler(_e.set(pitch, yaw, 0, 'YXZ')); // 腳掌（root 座標）
    setLocal(f.foot, _q2, _q3);
  }

  /**
   * 持拍手：肩膀→拍頭的線 = qArm 的 +Y（擊球時瞄準擊球點）；手肘往 elbow 的方向凸出 bend 弧度、手腕回到線上，
   * 拍子沿線（手腕回正）；整條線伸長 stretch 倍（探身）。拍面法線 faceN：揮拍時朝拍頭移動的方向、平常朝身體正前方。
   */
  private poseRightArm(ta: number): void {
    const u = _v1.set(0, 1, 0).applyQuaternion(this.qArm);
    const s = this.stretch;
    // 手肘方向：去掉沿線的分量；伸長（探身）時手臂打直
    const d = _v2.copy(this.elbow).addScaledVector(u, -this.elbow.dot(u));
    if (d.lengthSq() < 1e-6) d.set(0, 0, 1).applyQuaternion(this.qArm);
    d.normalize();
    const a = this.bend * clamp(1 - (s - 1) * 3, 0, 1);
    const sa = Math.sin(a);
    const ca = Math.cos(a);
    const yW = (this.wristY = UPPER_ARM * ca + Math.sqrt(Math.max(0, FOREARM * FOREARM - UPPER_ARM * UPPER_ARM * sa * sa)));
    const yU = _v3.copy(u).multiplyScalar(ca).addScaledVector(d, sa); // 上臂方向
    const yF = _v4.copy(u).multiplyScalar(yW).addScaledVector(yU, -UPPER_ARM).normalize(); // 前臂：手肘 → 手腕
    const front = _v5.copy(d).negate(); // 手肘彎的那一面
    quatYFront(_q1, yU, front); // 上臂（root 座標）
    setLocal(this.upArmR, this.qC, _q1);
    this.upArmR.scale.y = s;
    quatYFront(_q2, yF, front); // 前臂
    setLocal(this.foreArmR, _q1, _q2);
    // 拍面法線：揮拍時朝拍頭（相對肩膀）移動的方向，其他時候朝身體正前方；都取垂直於拍子的分量
    const headRel = _v6.copy(u).multiplyScalar(s * (yW + HAND_TO_HEAD));
    const nT = _v5;
    let swinging = false;
    if (this.headHave && ta > 0) {
      nT.subVectors(headRel, this.headRel);
      swinging = nT.length() / ta > 1.2;
    }
    if (!swinging) nT.copy(FORWARD).applyQuaternion(this.qC);
    this.headRel.copy(headRel);
    this.headHave = true;
    nT.addScaledVector(u, -nT.dot(u));
    if (nT.lengthSq() < 1e-6) nT.set(1, 0, 0).applyQuaternion(this.qArm);
    nT.normalize();
    if (nT.dot(this.faceN) < 0) nT.negate(); // 拍線兩面一樣：取跟現在比較接近的那一面
    this.faceN.lerp(nT, 1 - Math.exp(-14 * ta));
    this.faceN.addScaledVector(u, -this.faceN.dot(u));
    if (this.faceN.lengthSq() < 1e-6) this.faceN.copy(nT);
    this.faceN.normalize();
    // 手：沿線（手腕回正）、手掌法線 = 拍面法線
    quatXY(_q3, this.faceN, u);
    setLocal(this.handR, _q2, _q3);
  }

  /** 非持拍手：上臂沿 lU、前臂沿 lF（root 座標），手肘彎的那一面朝前臂；手跟著前臂 */
  private poseLeftArm(): void {
    const fwd = _v5.copy(FORWARD).applyQuaternion(this.qC);
    const front = _v6.copy(this.lF).addScaledVector(this.lU, -this.lF.dot(this.lU)).addScaledVector(fwd, 0.3);
    quatYFront(_q1, this.lU, front);
    setLocal(this.upArmL, this.qC, _q1);
    quatYFront(_q2, this.lF, front);
    setLocal(this.foreArmL, _q1, _q2);
  }

  /** 頭：脖子分擔一部分轉頭／抬頭 */
  private poseHead(pitch: number, yaw: number): void {
    this.neck.rotation.set(pitch * 0.35, yaw * 0.35, 0);
    this.head.rotation.set(pitch * 0.65, yaw * 0.65, 0);
  }

  /** 下一幀直接擺成準備姿勢、步法和揮拍狀態全部重來（回放進出時用，不要沿用另一段的動作） */
  snap(): void {
    this.inited = false;
    this.curSwing = null;
    this.lungeSwing = null;
    this.scissorSwing = null;
  }

  /** 換人時釋放 GPU 資源（幾何、材質、球衣貼圖、骨架、拖尾） */
  dispose(): void {
    const mats = new Set<THREE.Material>();
    const geos = new Set<THREE.BufferGeometry>();
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      geos.add(m.geometry);
      const mm = m.material;
      if (Array.isArray(mm)) mm.forEach((x) => mats.add(x));
      else mats.add(mm);
    });
    geos.forEach((g) => g.dispose());
    mats.forEach((m) => m.dispose());
    this.rig.mesh.skeleton.dispose();
    this.rig.texture.dispose();
  }

  /**
   * @param dt 真實時間（秒）。動畫內部換成模擬時間，跟遊戲的慢動作倍率同步。
   * @param shuttle 羽球世界座標（可省略）：有的話會看球、轉身面向球、對手擊球時做分腿跳
   * @param hint 預估的擊球（predictContact，可省略）：有的話最後一步會跟擊球同步（前場／側邊右腳弓步、後場剪刀腳）
   * @param serve 發球階段：1 = 這位是發球的人（右腳在前的發球站姿、不跨步）、2 = 接發球（準備姿勢、不跨步）
   */
  update(p: PlayerState, dt: number, shuttle?: { x: number; y: number; z: number }, hint?: ContactHint | null, serve: 0 | 1 | 2 = 0): void {
    const ta = Math.max(0, dt) * GAME.simSpeed;
    const side = p.side;
    const H = this.h; // 世界公尺 → 模型內部單位：除以 H
    const iH = this.ih;
    this.clock += ta;
    this.root.position.set(p.pos.x, p.pos.y, p.pos.z);
    this.root.rotation.y = side === 1 ? 0 : Math.PI;
    this.root.updateMatrixWorld();
    // 影子、光圈留在地上；跳越高影子越小
    const ground = -p.pos.y * iH + 0.006;
    this.shadow.position.y = ground;
    const ss = 1 - Math.min(0.4, p.pos.y * 0.8);
    this.shadow.scale.set(ss, ss, ss);
    this.aura.position.y = ground + 0.006;
    this.jumpMark.position.y = ground + 0.008;
    this.updateFx(p, dt);

    // 一幀移動超過 0.5 m（跑步最快一幀約 0.07 m）= 發球前重新站位的瞬移 → 直接擺好
    if (!this.inited || side !== this.lastSide || Math.hypot(p.pos.x - this.lastX, p.pos.z - this.lastZ) > 0.5) this.reset(p, serve === 1);
    this.lastX = p.pos.x;
    this.lastZ = p.pos.z;
    this.lastSide = side;

    // ---------- 移動狀態（root 座標：-z 往前、+x 往右）----------
    const vx = p.vel.x * side;
    const vz = p.vel.z * side;
    const speed = Math.hypot(vx, vz);
    if (!p.airborne) {
      this.gvx = vx;
      this.gvz = vz;
    }
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
      this.shL.set((shuttle.x - p.pos.x) * side * iH, (shuttle.y - p.pos.y) * iH, (shuttle.z - p.pos.z) * side * iH);
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

    // ---------- 魚躍（撲出去／趴在地上／爬起來）：整個身體另外擺，結束那一幀交回一般步法 ----------
    if ((p.dive || p.downT > 0 || this.diving) && this.updateDive(p, ta, shOK)) return;

    // ---------- 揮拍 ----------
    const s = p.swing;
    if (s !== this.curSwing) {
      this.curSwing = s;
      this.swingHit = false;
      this.kLast = 0;
      if (s) {
        this.swingStartQ.copy(this.qArm);
        this.swingType = this.classify(shNear ? this.shL : null, s.family, p.airborne || s.airborne);
        this.trail.reset();
      }
    }
    if (s && s.contacted && s.contactPoint) {
      const cp = s.contactPoint;
      this.cpL.set((cp.x - p.pos.x) * side * iH, (cp.y - p.pos.y) * iH, (cp.z - p.pos.z) * side * iH);
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

    // ---------- 擊球預估：決定最後一步的步法 ----------
    // plan 1 = 前場（正反手網前）或側邊（防守、遠球）：右腳弓步、腳跟剛好在擊球前著地
    // plan 2 = 後場頭頂球：擊球前右腳退到身後側身，擊球後剪刀交換
    const air = p.airborne || p.jumpArmed; // 跳殺有自己的空中剪刀腳
    // 發球：發球的人右腳在前站好、只移重心不跨步；接發球的人準備姿勢。發完球（揮拍結束）才回到一般步法
    const serving = serve === 1 || !!(s && s.isServe);
    const serveMode = serve !== 0 || serving;
    this.serveK = damp(this.serveK, serving ? 1 : 0, 8, ta);
    let hT = Infinity; // 還有多久擊球（模擬秒）
    let plan = 0;
    let front = false;
    if (hint && !air && !serveMode) {
      const hc = this.hc.set((hint.x - p.pos.x) * side * iH, (hint.y - p.pos.y) * iH, (hint.z - p.pos.z) * side * iH);
      hT = hint.t;
      this.contactAt = this.clock + hT;
      front = Math.abs(hint.z) < FRONT_DN;
      // 羽球根本到不了身邊（追不到）就不擺步法
      if (hint.d <= GAME.reach + 0.4 && hT < PRE_T + 0.3) {
        if (hc.y >= OVER_Y && !front) plan = 2;
        else if (front || Math.abs(hc.x) > SIDE_X || hc.y < LOW_Y) plan = 1;
      }
      if (plan === 1) this.lungeDir(hc.x, hc.z, front, vx, vz, speed);
    }
    this.prepOver = damp(this.prepOver, plan === 2 && !(s && s.contacted) ? smooth01((PRE_T - hT) / 0.3) : 0, 7, ta);
    this.prepFront = damp(this.prepFront, plan === 1 && !this.lunging && hT > LUNGE_DUR + LUNGE_LEAD && hT < PRE_T && speed < 1.8 ? 1 : 0, 6, ta);

    // ---------- 弓步 ----------
    this.lungeCool -= ta;
    this.recoverT -= ta;
    if (speed >= this.peak) {
      this.peak = speed;
      this.peakX = this.dirX;
      this.peakZ = this.dirZ;
    } else this.peak = Math.max(speed, this.peak - ta * 5);
    // 已出拍（馬上就要擊球）但弓步已經放掉 → 重新跨
    const swingSoon = s !== null && !s.contacted && !s.whiffed;
    if (plan === 1 && !air && ((!this.lunging && this.lungeCool <= 0) || (swingSoon && this.lunging && !this.lungeHold))) {
      // 跟擊球同步：右腳跟在擊球前 LUNGE_LEAD 著地（來不及就跨快一點）
      if (hT <= LUNGE_DUR + LUNGE_LEAD) this.startLunge(p, Math.max(0.08, hT - LUNGE_LEAD), hint!.x, hint!.z, front, this.hc.y, s);
    } else if (!this.lunging && !air && this.lungeCool <= 0 && !serveMode) {
      if (!hint) {
        // 備案（沒有擊球預估）：往前／側向衝刺後急停 → 最後一步跨成弓步；低點擊球且球在身前偏遠 → 跨步去接
        if (this.peak > 3.4 && speed < Math.min(3, this.peak - 1.5)) {
          if (-this.peakZ > -0.3 && (Math.abs(p.pos.z) < 3.8 || p.charging || s)) this.lungeToward(p, this.peakX, this.peakZ, s);
          this.peak = speed;
        } else if (s && !s.whiffed && s.t < 0.12 && (this.swingType === FH_UNDER || this.swingType === BH_UNDER)) {
          const ref = s.contacted ? this.cpL : shNear ? this.shL : null;
          if (ref) {
            const h = Math.hypot(ref.x, ref.z);
            if (h > 0.55 && ref.z < 0.1 && vx * ref.x + vz * ref.z > -h) this.lungeToward(p, ref.x / h, ref.z / h, s);
          }
        }
      }
    }
    if (this.lunging) {
      this.lungeT += ta;
      if (s && !this.lungeSwing) this.lungeSwing = s;
      const ls = this.lungeSwing;
      // 撐住弓步：有出拍 → 擊球後再撐 LUNGE_HOLD（揮空 → 揮完）；還沒出拍 → 等到預計擊球後一下。放掉後就不再撐
      let hold =
        this.lungeHold &&
        (ls
          ? ls === s && (ls.contacted ? ls.t < ls.contactT + LUNGE_HOLD : ls.t < ls.window + 0.05)
          : this.clock < this.contactAt + 0.2 && this.lungeT < 1);
      const along = vx * this.lungeX + vz * this.lungeZ;
      const hit = ls !== null && ls.contacted;
      // 已經往回蹬：擊球後撐一下（隨揮）才放；出拍了還沒打到、或球還在來（預估要接）就先撐住；不接了才放
      const settled = ls ? (hit && ls.t > ls.contactT + 0.09) || ls.whiffed || ls !== s : plan !== 1 || this.clock > this.contactAt + 0.05;
      this.lungeBack = speed > 1.2 && along < -0.3 * speed && settled;
      if (this.lungeBack) hold = false;
      // 其實沒停，繼續跑：身體越過前腳（擊球前骨盆可以多撐一小段）
      const rootPast = ((p.pos.x - this.lungeRX) * this.lungeX + (p.pos.z - this.lungeRZ) * this.lungeZ) * side * iH;
      if (speed > 3.2 && along > 0.7 * speed && this.feet[1].planted && (hit || rootPast > 0.15)) hold = false;
      // 打完了而且身體已經往別處走遠：不再撐（骨盆不要被拖在後面）
      if (hit && Math.hypot(p.pos.x - this.lungeRX, p.pos.z - this.lungeRZ) * iH > LUNGE_MAX + 0.2) hold = false;
      if (p.airborne) hold = false;
      if (!hold && this.lungeHold) {
        this.feet[1].forced = false; // 跨到一半就收回：改成跟著身體
        this.recoverT = 0.3; // 蹬回：右腳先收
      }
      this.lungeHold = hold;
      this.L = damp(this.L, hold ? 1 : 0, hold ? 16 : 6, ta);
      if (!hold && this.L < 0.05) {
        this.lunging = false;
        this.lungeCool = 0.2;
        this.L = 0;
        this.lungeSwing = null;
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
    psiT = lerp(psiT, -0.85, this.prepOver * (1 - wPose)); // 後場頭頂球：先側身（右肩往後）
    psiT = lerp(psiT, poseAt(P.yaw, kp), wPose);
    this.psi = damp(this.psi, psiT, s ? 22 : 9, ta);
    let yawP = this.psi * lerp(0.8, 0.45, wPose);
    if (L > 0) yawP = lerp(yawP, this.lungeYaw, 0.7 * L); // 弓步：骨盆跟著腿的方向，上身照揮拍轉
    const twist = clamp(this.psi - yawP, -1.2, 1.2);
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
    // 頭頂球側身：右腳往後（後場頭頂球在擊球前就先退好）
    const wOver = Math.max(poseType === OVERHEAD && !p.airborne ? wPose * (kp < 1 ? 1 : Math.max(0, 2 - kp) * 0.6) : 0, this.prepOver);
    // 弓步：右腳 = 落點（世界固定）；後腳原地踩住，除非兩腳前後太近／太遠、左右偏太多才拖過去
    let lrX = 0;
    let lrZ = 0;
    let rearX = 0;
    let rearZ = 0;
    if (L > 0) {
      lrX = (this.lungeRX - p.pos.x) * side * iH;
      lrZ = (this.lungeRZ - p.pos.z) * side * iH;
      const fl = this.feet[0];
      const qx = ((fl.planted ? fl.wx : fl.toX) - p.pos.x) * side * iH - lrX;
      const qz = ((fl.planted ? fl.wz : fl.toZ) - p.pos.z) * side * iH - lrZ;
      const dX = this.lungeX;
      const dZ = this.lungeZ;
      const al = clamp(qx * dX + qz * dZ, -SPAN_MAX, -SPAN_MIN); // 沿弓步方向（負 = 在前腳後面）
      const la = clamp(-qx * dZ + qz * dX, -0.42, -0.04); // 往右為正：後腳在前腳左後方
      rearX = lrX + dX * al - dZ * la;
      rearZ = lrZ + dZ * al + dX * la;
      this.rearWX = p.pos.x + side * rearX * H;
      this.rearWZ = p.pos.z + side * rearZ * H;
    }
    const rearYaw = clamp(this.lungeAng * 0.5 + 0.6, -0.4, 1.2); // 後腳腳尖朝外
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      const pz = f.sign > 0 ? zR : zL;
      const px = f.sign * w;
      let hx = px * cy + pz * sy;
      let hz = -px * sy + pz * cy;
      if (f.sign > 0) {
        hx += 0.05 * wOver;
        hz += 0.2 * wOver;
      } else {
        hz -= 0.1 * wOver;
        // 前場弓步前：左腳先往後放（重心在後腳，等右腳跨出去）
        hx -= this.dX * 0.16 * this.prepFront;
        hz -= this.dZ * 0.16 * this.prepFront;
      }
      let hyaw = yawP - f.sign * splay;
      if (this.serveK > 0) {
        // 發球站姿：右腳在前、左腳在後（腳尖朝外），大致面向網；走動時照一般步伐
        const k = this.serveK * (1 - moveK);
        hx = lerp(hx, f.sign > 0 ? 0.13 : -0.15, k);
        hz = lerp(hz, f.sign > 0 ? -0.2 : 0.2, k);
        hyaw = lerp(hyaw, f.sign > 0 ? -0.1 : 0.55, k);
      }
      if (L > 0) {
        hx = lerp(hx, f.sign > 0 ? lrX : rearX, L);
        hz = lerp(hz, f.sign > 0 ? lrZ : rearZ, L);
        hyaw = lerp(hyaw, f.sign > 0 ? this.lungeFootYaw : rearYaw, L);
      }
      f.homeX = p.pos.x + side * hx * H;
      f.homeZ = p.pos.z + side * hz * H;
      f.homeYaw = hyaw;
    }

    // ---------- 步伐參數 ----------
    const lat = Math.abs(this.dirX * cy - this.dirZ * sy); // 移動方向與骨盆左右軸的夾角 → 併步程度
    let dur = lerp(clamp(0.27 - 0.022 * speed, 0.13, 0.27), clamp(0.19 - 0.01 * speed, 0.13, 0.19), lat);
    let lift = lerp(0.05 + 0.022 * speed, 0.045, lat); // 往前跑：腳抬得比較高（後踢）
    if (moveK < 0.3) {
      dur = lerp(0.16, dur, moveK / 0.3);
      lift = lerp(0.035, lift, moveK / 0.3);
    }
    const runK = moveK * (1 - lat);
    const gap = cross > 0.5 || lat < 0.5 ? -1 : 0.12; // 併步（側向移動）時兩腳不交叉

    const fl = this.feet[0];
    const fr = this.feet[1];
    if (!p.airborne) {
      if (this.wasAir) this.land(p, cy, sy);
      this.landT -= ta;
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
        if (f.strike && this.lunging && this.lungeHold && f.u < 1) {
          // 弓步要在擊球前踩穩：擊球比預估早就把這一步加快（只加快、不放慢）
          const want = Math.max(0.04, s && s.contacted ? 0 : hT - LUNGE_LEAD * 0.5);
          if (want < (1 - f.u) * f.dur) f.dur = want / (1 - f.u);
          // 落點跟著身體走（身體沒照預期減速時，右腳還是落在身體前方同一個位置）
          const rem = Math.min((1 - f.u) * f.dur, speed / 80);
          f.toX = this.lungeRX = p.pos.x + p.vel.x * rem + side * this.lungeLX * H;
          f.toZ = this.lungeRZ = p.pos.z + p.vel.z * rem + side * this.lungeLZ * H;
        }
        f.u = Math.min(1, f.u + ta / f.dur);
        if (!f.forced) {
          // 跟著身體重新瞄準落點，但每幀移動有上限（避免落點突然跳）
          const ox = f.toX;
          const oz = f.toZ;
          if (f.sign < 0 && this.lunging && this.lungeHold && this.L > 0.3) {
            // 弓步中還在空中的左腳（倒數第二步）：落在前腳後面該在的位置，不再往前衝
            f.toX = this.rearWX;
            f.toZ = this.rearWZ;
          } else this.stepTarget(f, this.feet[1 - i], p, f.dur, f.u, f.gap, cy, sy);
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
        f.yaw = lerp(f.yawFrom, f.yawTo, e);
        if (f.dragging) {
          // 後腳拖步：腳尖不離地（墊著腳尖往前滑），終點跟著前腳更新
          if (this.lunging && this.lungeHold) {
            f.toX = this.rearWX;
            f.toZ = this.rearWZ;
            f.wx = lerp(f.fromX, f.toX, e);
            f.wz = lerp(f.fromZ, f.toZ, e);
          }
          f.h = 0;
          f.toe = damp(f.toe, -0.6, 10, ta);
          f.pitch = f.toe;
        } else {
          // 跑步：腳跟先往後上踢、再往前伸（弧線最高點提前）
          const ua = f.runK > 0 ? Math.pow(f.u, 1 - 0.3 * f.runK) : f.u;
          f.h = f.lift * Math.sin(Math.PI * ua) + f.h0 * (1 - e);
          // 起步時的墊腳尖角度接過來，慢慢換成這一步的擺動
          const lift0 = f.toe * Math.max(0, 1 - f.u * 3);
          if (f.strike) {
            // 弓步：前半蹬地（腳尖向下），後半腳尖翹起、腳跟先著地
            f.pitch = lift0 + (f.u < 0.2 ? -0.3 * (f.u / 0.2) : lerp(-0.3, 0.42, smooth01((f.u - 0.2) / 0.75)));
          } else f.pitch = lift0 + Math.sin(Math.PI * f.u) * lerp(-0.55, 0.35, f.u) * f.runK;
        }
        if (f.u >= 1) {
          f.planted = true;
          f.h = 0;
          f.heel = f.strike ? f.pitch : 0; // 腳跟著地 → 腳掌再放平
          f.toe = f.dragging ? f.toe : 0;
          f.forced = false;
          f.strike = false;
          f.dragging = false;
          f.h0 = 0;
          this.crouchV -= 0.12 + 0.07 * speed; // 著地吸收
        }
      }
      // 著地的腳：身體轉很多時腳掌才跟著轉（以前腳掌為軸：腳跟繞著轉，前腳掌不在地上滑）
      for (let i = 0; i < 2; i++) {
        const f = this.feet[i];
        if (!f.planted) continue;
        const d = f.homeYaw - f.yaw;
        if (Math.abs(d) > 0.6) f.pivoting = true;
        if (f.pivoting) {
          const ny = damp(f.yaw, f.homeYaw, 8, ta);
          const k = BALL * side * H;
          f.wx += k * (Math.sin(ny) - Math.sin(f.yaw));
          f.wz += k * (Math.cos(ny) - Math.cos(f.yaw));
          f.yaw = ny;
          if (Math.abs(d) < 0.15) f.pivoting = false;
        }
      }
      // 腳掌角度：剛著地的弓步腳慢慢放平；弓步後腳、跑步時身後那隻腳墊腳尖
      for (let i = 0; i < 2; i++) {
        const f = this.feet[i];
        if (!f.planted) continue;
        let toeT = 0;
        if (f.sign < 0 && L > 0) toeT = -0.62 * L * (0.5 + 0.5 * this.lungeDepth);
        else if (runK > 0.2) {
          const behind = -((f.local.x - this.offX) * this.dirX + (f.local.z - this.offZ) * this.dirZ);
          toeT = -RUN_PUSH * runK * smooth01((behind - 0.12) / 0.3);
        }
        f.heel = damp(f.heel, 0, 11, ta);
        f.toe = damp(f.toe, toeT, 12, ta);
        f.pitch = f.heel + f.toe;
      }
      // 後場頭頂球（地面）：擊球瞬間剪刀交換 —— 右腳往前踢、左腳往後，兩腳短暫離地
      if (s && s.contacted && s !== this.scissorSwing && this.swingType === OVERHEAD && !s.airborne && !this.lunging) {
        this.scissorSwing = s;
        const cpz = s.contactPoint ? Math.abs(s.contactPoint.z) : 0;
        if (cpz >= FRONT_DN && fr.planted && fl.planted && fr.local.z > fl.local.z - 0.05) {
          const t = 0.17;
          const bx = p.pos.x + p.vel.x * t;
          const bz = p.pos.z + p.vel.z * t;
          this.beginStep(fr, bx + side * 0.15 * H, bz - side * 0.2 * H, t, 0.1, 0.1, true, 0.5);
          this.beginStep(fl, bx - side * 0.2 * H, bz + side * 0.2 * H, t - 0.02, 0.06, 0.45, true, 0);
          this.lastStep = fr;
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
            f.toX += f.sign * cy * 0.05 * side * H;
            f.toZ -= f.sign * sy * 0.05 * side * H;
          }
        }
      }
      // 該換哪隻腳：離理想位置最遠、超過門檻的那隻（另一隻要踩穩；快跑時另一隻快落地就可以起步 → 有騰空期）
      {
        let thr = lerp(0.13, 0.085, moveK);
        if (s && !s.whiffed && !(s.contacted && s.t > s.contactT + 0.05)) thr = 0.42; // 揮拍時腳踩穩
        const back = (this.lunging && this.lungeBack) || this.recoverT > 0;
        const overlap = back ? 0 : speed > 3 && !this.lungeHold ? 0.7 : 1;
        const holding = this.lunging && this.lungeHold;
        // 弓步快開始了：讓左腳先跨（倒數第二步），右腳留著當最後一步
        const saveRight = plan === 1 && !this.lunging && hT < LUNGE_DUR + LUNGE_LEAD + 0.24;
        let best: Foot | null = null;
        let bestE = 0;
        for (let i = 0; i < 2; i++) {
          const f = this.feet[i];
          const o = this.feet[1 - i];
          if (!f.planted || (!o.planted && o.u < overlap) || this.landT > 0) continue; // 單腳落地：第二隻腳落下前不換步
          // 弓步中前腳撐住、後腳只在兩腳太近／太遠時拖一下；蹬回時先收前腳（右腳），後腳等一下
          let ft = thr;
          let e = Math.hypot(f.homeX - f.wx, f.homeZ - f.wz) - (f === this.lastStep ? 0.03 : 0);
          if (holding) {
            // 右腳還在跨的時候左腳是蹬地的腳，不動；右腳踩穩後才把後腳拖到位
            ft = f.sign > 0 ? 0.5 : fr.planted ? 0.07 : 0.6;
            if (f.sign < 0 && this.L > 0.5) e = Math.hypot(this.rearWX - f.wx, this.rearWZ - f.wz);
          } else if (back) ft = f.sign > 0 ? 0.12 : 0.6;
          else if (saveRight && f.sign > 0) ft = Math.max(ft, 0.32);
          if (e > ft && e > bestE) {
            best = f;
            bestE = e;
          }
        }
        if (best) {
          if (holding && best.sign < 0 && bestE < 0.55) {
            // 弓步時後腳用腳尖往前（或往後）拖，不抬腳
            this.dragRear(best);
          } else {
            // 弓步前的倒數第二步（左腳）：要在右腳跨出去之前踩到地
            let d = dur;
            if (plan === 1 && !this.lunging && best.sign < 0 && hT > LUNGE_DUR + LUNGE_LEAD) d = Math.min(d, Math.max(0.08, hT - LUNGE_DUR - LUNGE_LEAD));
            this.beginStep(best, 0, 0, d, lift, best.homeYaw, false, runK);
            this.stepTarget(best, best === fl ? fr : fl, p, d, 0, gap, cy, sy);
          }
        }
      }
      // 安全網：腳離髖部太遠（伸不到）就立刻跨
      for (let i = 0; i < 2; i++) {
        const f = this.feet[i];
        if (!f.planted || this.landT > 0) continue;
        const lx = (f.wx - p.pos.x) * side * iH - (this.offX + f.sign * this.hipW * cy);
        const lz = (f.wz - p.pos.z) * side * iH - (this.offZ - f.sign * this.hipW * sy);
        // 快跑時後腳拖太遠就先蹬起（兩腳同時離地＝跑步的騰空期），不讓髖部被拉低
        if (Math.hypot(lx, lz) > (this.lunging ? 0.76 : speed > 3 ? 0.56 : 0.8)) {
          if (f.sign < 0 && this.lunging && this.lungeHold) this.dragRear(f); // 弓步：後腳被身體帶著往前拖
          else {
            this.beginStep(f, 0, 0, Math.min(dur, 0.16), lift, f.homeYaw, false, runK);
            this.stepTarget(f, this.feet[1 - i], p, Math.min(dur, 0.16), 0, -1, cy, sy);
          }
        }
      }
      for (let i = 0; i < 2; i++) {
        const f = this.feet[i];
        f.local.set((f.wx - p.pos.x) * side * iH, ANKLE + f.h, (f.wz - p.pos.z) * side * iH);
        // 腳掌有角度時，以著地的那一點為軸（墊腳尖 = 前腳掌、腳尖翹起 = 腳跟），腳踝跟著抬高／前後移
        const pp = f.pitch;
        if (pp !== 0) {
          const pz = pp < 0 ? -BALL : HEEL;
          const sp = Math.sin(pp);
          const cp = Math.cos(pp);
          const dzs = pz + ANKLE * sp - pz * cp; // 沿鞋子的前後軸（+ = 往腳跟）
          f.local.x += dzs * Math.sin(f.yaw);
          f.local.y += -ANKLE + ANKLE * cp + pz * sp;
          f.local.z += dzs * Math.cos(f.yaw);
        }
      }
    } else {
      // ---------- 空中：跳殺 ----------
      // 原地（幾乎沒在動）= 雙腳一起蹬、雙腳落地；邊跑邊跳 = 單腳蹬地、空中換腳、另一隻腳先著地：
      //   往左（頭頂區）= 馬來步：左腳蹬（右腳先退、身體轉側），落地右腳先、左腳再落；其他方向 = 交換步：右腳蹬、左腳先落地
      if (!this.wasAir) this.beginJump();
      this.airT += ta;
      const st = this.jumpStyle;
      this.scissor = damp(this.scissor, (s && s.contacted) || p.vy < -0.6 ? 1 : 0, 16, ta);
      const sc = this.scissor;
      const ext = p.vy < 0 ? clamp(p.pos.y / 0.25, 0, 1) : 1; // 快落地時腳伸直準備著地
      const landK = p.vy < 0 ? smooth01((0.34 - p.pos.y) / 0.22) : 0; // 單腳起跳：先著地的腳提早伸到地面
      const gy = ANKLE - p.pos.y * iH; // 地面（root 座標）
      for (let i = 0; i < 2; i++) {
        const f = this.feet[i];
        if (this.hold[i]) {
          // 踩在地上（世界固定）：起跳蹬地時腳跟抬起、腿伸直就離地；落地先著地的腳腳掌放平
          const land = this.holdLand[i];
          f.pitch = damp(f.pitch, land ? 0 : -0.55, land ? 14 : 10, ta);
          const pz = f.pitch < 0 ? -BALL : HEEL;
          const sp = Math.sin(f.pitch);
          const cp = Math.cos(f.pitch);
          const dzs = pz + ANKLE * sp - pz * cp;
          f.local.set(
            (this.holdX[i] - p.pos.x) * side * iH + dzs * Math.sin(f.yaw),
            gy - ANKLE + ANKLE * cp + pz * sp,
            (this.holdZ[i] - p.pos.z) * side * iH + dzs * Math.cos(f.yaw),
          );
          f.wx = this.holdX[i];
          f.wz = this.holdZ[i];
          f.h = 0;
          if (!land && (f.hip.distanceTo(f.local) > LEG * 0.995 || this.airT > 0.12)) {
            this.hold[i] = false; // 腿蹬直了：腳離地，從伸直的位置接著收進空中姿勢
            f.local.copy(f.ankle);
          }
          continue;
        }
        let rx = f.sign * 0.1;
        let ry: number;
        let rz: number;
        let e = ext;
        const first = st !== 0 && f === this.jumpFirst;
        if (st === 0) {
          // 雙腳：腳收在身體下方，只有一點點剪刀
          rx = f.sign * 0.12;
          ry = -0.5;
          rz = f.sign > 0 ? lerp(0.1, -0.06, sc) : lerp(-0.02, 0.08, sc);
        } else {
          // 單腳：蹬地腳先伸直拖在後面、另一腳膝蓋往前上提；擊球後交換（蹬地腳往前、另一腳往後準備先著地）
          const take = f === this.jumpTake;
          ry = take ? lerp(-0.44, -0.56, sc) : lerp(-0.5, -0.44, sc);
          rz = take ? lerp(0.4, -0.3, sc) : lerp(-0.22, 0.36, sc);
          e = first ? 1 - landK : Math.max(ext, 0.55); // 後著地的腳還留在空中
        }
        const ax = this.offX + rx * cy + rz * sy;
        const az = this.offZ - rx * sy + rz * cy;
        let hx: number;
        let hz: number;
        if (first) {
          // 先著地的腳：落在身體後方
          hx = this.offX + f.sign * 0.12 * cy + 0.22 * sy;
          hz = this.offZ - f.sign * 0.12 * sy + 0.22 * cy;
        } else {
          hx = (f.homeX - p.pos.x) * side * iH;
          hz = (f.homeZ - p.pos.z) * side * iH;
        }
        const tx = lerp(hx, ax, e);
        const ty = lerp(gy, AIR_H + this.crouch + ry, e);
        const tz = lerp(hz, az, e);
        const r = 1 - Math.exp(-(first && landK > 0 ? 34 : 18) * ta);
        f.local.x += (tx - f.local.x) * r;
        f.local.y += (Math.max(gy, ty) - f.local.y) * r;
        f.local.z += (tz - f.local.z) * r;
        f.wx = p.pos.x + side * f.local.x * H;
        f.wz = p.pos.z + side * f.local.z * H;
        f.h = f.local.y - ANKLE;
        f.yaw = damp(f.yaw, yawP - f.sign * 0.1, 6, ta);
        f.pitch = damp(f.pitch, first ? lerp(-0.35, 0, landK) : -0.35 * e, 8, ta);
        if (first && landK > 0.97 && f.local.y < gy + 0.03) {
          // 先著地：這隻腳踩住（之後 root 落地時另一隻腳再落下）
          this.hold[i] = true;
          this.holdLand[i] = true;
          this.holdX[i] = f.wx;
          this.holdZ[i] = f.wz;
        }
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
    if (L > 0) {
      // 弓步：重心在兩腳之間、偏前腳（骨盆可以離 root 一小段）
      const fl0 = this.feet[0];
      const lx = ((fl0.planted ? fl0.wx : fl0.toX) - p.pos.x) * side * iH;
      const lz = ((fl0.planted ? fl0.wz : fl0.toZ) - p.pos.z) * side * iH;
      let gx = lrX * 0.6 + lx * 0.4;
      let gz = lrZ * 0.6 + lz * 0.4;
      const gl = Math.hypot(gx, gz);
      if (gl > LUNGE_OFF_MAX) {
        gx *= LUNGE_OFF_MAX / gl;
        gz *= LUNGE_OFF_MAX / gl;
      }
      offTX = lerp(offTX, gx + offTX * 0.3, L);
      offTZ = lerp(offTZ, gz + offTZ * 0.3, L);
    }
    // 前場弓步前：重心先放後面（等右腳跨出去）
    offTX -= this.dX * 0.08 * this.prepFront;
    offTZ -= this.dZ * 0.08 * this.prepFront;
    // 發球：引拍時重心在後腳，揮拍時移到前腳（只移重心，腳不動）
    if (this.serveK > 0) offTZ += this.serveK * (1 - moveK) * lerp(0.05, -0.07, s ? smooth01(Math.min(k, 1.4) / 1.4) : 0);
    // 骨盆水平位移：快但不瞬間（擊球那一下探身不會「抖」一格）
    this.offX = damp(this.offX, offTX, 15, ta);
    this.offZ = damp(this.offZ, offTZ, 15, ta);
    this.offY = damp(this.offY, offTY, 25, ta);

    // ---------- 髖部高度 ----------
    let hipT = lerp(lerp(READY_H, RUN_H, moveK), STAND_H, relaxK);
    if (this.wide > 0) hipT -= 0.03;
    if (p.jumpArmed && !p.airborne) hipT -= 0.07; // 跳殺待命：蹲低蓄勢
    if (p.landRecover > 0) hipT -= 0.13 * clamp(p.landRecover / GAME.jump.landRecover, 0, 1);
    if (under) hipT -= 0.05 * wPose * (1 - 0.7 * this.serveK); // 發球站得比較直
    hipT -= 0.035 * this.prepFront; // 準備跨步：膝蓋再彎一點
    hipT = lerp(hipT, lerp(0.66, LUNGE_H, this.lungeDepth), L); // 跨越遠蹲越低
    // 空中：快落地時髖部放低一點，先著地的那隻腳才搆得到地面
    if (p.airborne) hipT = lerp(AIR_H, READY_H + 0.02, p.vy < 0 ? smooth01((0.34 - p.pos.y) / 0.22) : 0);
    this.hipY = damp(this.hipY, hipT, p.airborne && p.vy < 0 ? 22 : 10, ta);
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
        const hx = this.offX + f.sign * this.hipW * cy;
        const hz = this.offZ - f.sign * this.hipW * sy;
        const hd = Math.hypot(f.local.x - hx, f.local.z - hz);
        // 跨步中的腳越接近落地，限制越強（髖部提前慢慢降，不會落地瞬間一沉）
        const free = f.planted ? 0 : 1 - f.u;
        const reach = LEG * 0.985 + free * free * 0.5;
        y = Math.min(y, f.local.y + Math.sqrt(Math.max(0, reach * reach - hd * hd)));
      }
      y = Math.max(y, 0.48);
      // 上下都限速（往下較快）：遠處的腳一落地／離地，髖部不會瞬間沉下或彈起；短暫的落差由小腿伸長補
      if (y > this.yOut) y = Math.min(y, this.yOut + ta * 3);
      else y = Math.max(y, this.yOut - ta * 3.5);
    }
    this.yOut = y;

    // ---------- 骨盆與上身 ----------
    // 加速時往加速方向傾（減速時後仰），跑動時略往前傾
    let leanF = clamp(-this.accZ * 0.0045, -0.2, 0.24) + clamp(-vz * 0.018, -0.12, 0.12);
    let leanR = clamp(this.accX * 0.0045, -0.18, 0.18) + clamp(vx * 0.012, -0.08, 0.08);
    if (p.airborne) leanF = leanR = 0;
    const lf = -leanR * sy + leanF * cy; // 換到骨盆座標
    const lr = leanR * cy + leanF * sy;
    this.hips.position.set(this.offX, y, this.offZ);
    this.hips.rotation.set(-lf * 0.45, yawP, -lr * 0.45);
    // 弓步時上身大致挺直（前傾不要太多）
    const pitchC = 0.1 * (1 - relaxK) + 0.06 * moveK + 0.14 * L * this.lungeDepth + poseAt(P.pitch, kp) * wPose * (1 - 0.35 * L) * (1 - 0.45 * this.serveK);
    this.spine.position.y = WAIST + this.offY;
    this.spine.rotation.set(-(pitchC + lf * 0.55), twist, -lr * 0.55 + poseAt(P.roll, kp) * wPose);
    this.hips.updateMatrix();
    this.spine.updateMatrix();
    this.mC.multiplyMatrices(this.hips.matrix, this.spine.matrix);
    this.qC.multiplyQuaternions(this.hips.quaternion, this.spine.quaternion);
    this.qCi.copy(this.qC).invert();
    this.shoulderR.copy(this.shR0).applyMatrix4(this.mC);
    this.shoulderL.copy(this.shL0).applyMatrix4(this.mC);

    // ---------- 腿（兩節骨 IK）----------
    const pfx = -Math.sin(yawP);
    const pfz = -Math.cos(yawP);
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      f.hip.set(f.sign * this.hipW, 0, 0).applyMatrix4(this.hips.matrix);
      // 膝蓋朝腳尖方向、略往外
      _pole.set(-Math.sin(f.yaw) + pfx * 0.3 + f.sign * cy * 0.15, 0, -Math.cos(f.yaw) + pfz * 0.3 - f.sign * sy * 0.15);
      solveTwoBone(f.hip, f.local, THIGH, SHIN, _pole, f.knee, f.ankle);
      // 踩住的腳：鞋子留在原地（小腿稍微拉長補縫）；空中的腳：跟著 IK 收回
      this.poseLeg(f, f.planted ? f.local : f.ankle, _pole, f.pitch, f.yaw);
    }

    // ---------- 持拍手 ----------
    let bendT: number;
    const elbowT = _v4; // 手肘方向（胸口座標）
    if (s) {
      const qW = _q1.multiplyQuaternions(this.qC, P.wind);
      if (s.t < 0.05) qW.slerpQuaternions(this.swingStartQ, _q3.copy(qW), s.t / 0.05);
      const qHit = _q2;
      if (s.contacted && s.contactPoint) this.aimFromShoulder(qHit, this.cpL);
      else if (shNear) this.aimFromShoulder(qHit, this.shL);
      else qHit.multiplyQuaternions(this.qC, P.contact);
      if (k <= 1) this.qArm.slerpQuaternions(qW, qHit, easeIn(k));
      else {
        const qF = _q3.multiplyQuaternions(this.qC, P.follow);
        // 網前小球（下壓族、低點）：隨揮很短
        if (under && s.family === 'down') qF.slerpQuaternions(qHit, _q1.copy(qF), 0.35);
        this.qArm.slerpQuaternions(qHit, qF, easeOut(k - 1));
      }
      bendT = poseAt(P.bend, k);
      elbowAt(elbowT, P, k);
    } else {
      let target: THREE.Quaternion;
      if (p.charging) {
        target = _q1.multiplyQuaternions(this.qC, P.wind);
        bendT = P.bend[0];
        elbowT.copy(P.elbowPrep);
      } else {
        _q2.copy(ARM_READY).slerp(ARM_RUN, moveK * 0.7).slerp(ARM_RELAX, relaxK);
        target = _q1.multiplyQuaternions(this.qC, _q2);
        bendT = lerp(lerp(BEND_READY, BEND_RUN, moveK * 0.7), BEND_RELAX, relaxK);
        elbowT.copy(ELBOW_READY).lerp(ELBOW_RELAX, relaxK);
      }
      this.qArm.slerp(target, 1 - Math.exp(-(p.charging ? 22 : 13) * ta));
    }
    this.stretch += (stretch - this.stretch) * Math.min(1, ta * 48);
    this.bend = damp(this.bend, bendT, s ? 20 : 8, ta);
    this.elbow.lerp(elbowT.applyQuaternion(this.qC), 1 - Math.exp(-(s ? 16 : 8) * ta));
    this.poseRightArm(ta);

    // ---------- 非持拍手 ----------
    this.updateLeftArm(P, poseType, kp, wPose, moveK, relaxK, L, runK, shOK, ta);

    // ---------- 頭：看羽球 ----------
    const neck = _v1.copy(HEAD_PIVOT).applyMatrix4(this.mC);
    const look = shOK ? _v2.subVectors(this.shL, neck) : _v2.set(0, -0.2, -1);
    look.applyQuaternion(this.qCi);
    let hy = Math.atan2(-look.x, -look.z);
    if (Math.abs(hy) > 1.9) hy = 0; // 在背後就不硬轉
    const hp = Math.atan2(look.y, Math.hypot(look.x, look.z));
    this.headYaw = damp(this.headYaw, clamp(hy, -1.1, 1.1), 12, ta);
    this.headPitch = damp(this.headPitch, clamp(hp, -0.5, 0.75), 12, ta);
    this.poseHead(this.headPitch, this.headYaw);

    // ---------- 馬尾：彈簧甩動（加減速往反方向甩、轉頭時慢半拍）----------
    if (this.ponytail) {
      const yaw = this.headYaw + this.psi;
      const yawV = ta > 0 ? clamp((yaw - this.lastHeadYaw) / ta, -8, 8) : 0;
      this.lastHeadYaw = yaw;
      const tX =
        -0.35 + clamp(this.accZ * 0.01, -0.45, 0.3) - 0.3 * moveK + clamp(this.crouchV * 0.12, -0.3, 0.3) + (p.airborne ? clamp(p.vy * 0.06, -0.3, 0.2) : 0);
      const tZ = clamp(-this.accX * 0.01, -0.45, 0.45);
      for (let rem = ta; rem > 1e-6; rem -= 1 / 120) {
        const hh = Math.min(rem, 1 / 120);
        this.ptVX += (90 * (tX - this.ptX) - 7 * this.ptVX) * hh;
        this.ptVZ += (90 * (tZ - this.ptZ) - 7 * this.ptVZ - yawV * 1.5) * hh;
        this.ptX = clamp(this.ptX + this.ptVX * hh, -1.3, 0.1);
        this.ptZ = clamp(this.ptZ + this.ptVZ * hh, -0.6, 0.6);
      }
      // 抵銷抬頭／低頭：髮束靠重力往下垂，不跟著頭翹起來
      this.ponytail.rotation.set(this.ptX - this.headPitch, 0, this.ptZ);
    }

    // ---------- 揮拍拖尾（殺球更亮、跳殺青色）----------
    if (s) {
      const down = s.family === 'down';
      this.trail.setStyle(down && (p.airborne || s.airborne) ? SWOOSH_JUMP : down && poseType === OVERHEAD ? SWOOSH_SMASH : SWOOSH_NORMAL);
    }
    const swishing = s !== null && k >= 0.45 && k <= 1.6 && wPose > 0.5;
    _sw.copy(this.shoulderR).applyMatrix4(this.root.matrixWorld);
    _sq.multiplyQuaternions(this.root.quaternion, this.qArm);
    this.trail.step(ta, swishing, _sw, _sq, (this.stretch * H * (this.wristY + HAND_TO_HEAD)) / HEAD_NOMINAL);
    const tm = this.trail.mesh;
    if (tm.visible) {
      // 拖尾頂點是世界座標：抵銷 root 的變換
      tm.matrix.copy(this.root.matrixWorld).invert();
      tm.matrixWorldNeedsUpdate = true;
    }
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

  /**
   * 弓步方向（root 座標單位向量，寫進 dX/dZ/dA）：朝擊球點；前場往網的方向偏（斜前方跨），
   * 移動中再偏向移動方向（跑過去順勢跨出）。正手往右前、反手往左前（右腳交叉跨到左邊），側邊防守可以接近正側面。
   */
  private lungeDir(cx: number, cz: number, front: boolean, vx: number, vz: number, speed: number): void {
    let dx = cx;
    let dz = cz - (front ? 0.5 : 0.12);
    if (speed > 1.2) {
      const k = (Math.min(1, speed / 3) * 0.6) / speed;
      dx += vx * k;
      dz += vz * k;
    }
    const a = clamp(Math.atan2(-dx, -dz), -1.95, 1.95);
    this.dA = a;
    this.dX = -Math.sin(a);
    this.dZ = -Math.cos(a);
  }

  /** 沒有擊球預估時的弓步（備案）：假設擊球點在 (dx, dz) 方向 */
  private lungeToward(p: PlayerState, dx: number, dz: number, s: Swing | null): void {
    const k = 0.95 * this.h * p.side;
    this.startLunge(p, 0.17, p.pos.x + dx * k, p.pos.z + dz * k, false, 0.9, s);
  }

  /**
   * 右腳弓步（最後一步）：dur 秒後腳跟著地。(cwx, cwz) = 擊球點（世界）。
   * 落點沿弓步方向：擊球點往回 LUNGE_REACH（手臂＋拍子往前伸），但至少比後腳前 SPAN_MIN、至少跨 LUNGE_STEP；
   * 右腳正在跨步的話直接把這一步改成弓步（從半空接著走，不會瞬移）。
   */
  private startLunge(p: PlayerState, dur: number, cwx: number, cwz: number, front: boolean, cy: number, s: Swing | null): void {
    const high = cy >= 1.45;
    const side = p.side;
    const H = this.h;
    const iH = this.ih;
    const vx = p.vel.x * side;
    const vz = p.vel.z * side;
    const speed = Math.hypot(vx, vz);
    // 右腳著地時 root 的位置（模擬裡減速約 40 m/s²：最多再滑 v²/80）
    const tau = Math.min(dur, speed / 80);
    const rx = p.pos.x + p.vel.x * tau;
    const rz = p.pos.z + p.vel.z * tau;
    const cx = (cwx - rx) * side * iH;
    const cz = (cwz - rz) * side * iH;
    this.lungeDir(cx, cz, front, vx, vz, speed);
    const dX = this.dX;
    const dZ = this.dZ;
    const fr = this.feet[1];
    const fl = this.feet[0];
    const along = (wx: number, wz: number) => ((wx - rx) * dX + (wz - rz) * dZ) * side * iH;
    const rAl = along(fr.wx, fr.wz);
    const lAl = fl.planted ? along(fl.wx, fl.wz) : along(fl.toX, fl.toZ);
    const cAl = cx * dX + cz * dZ;
    let F = Math.max(cAl - (high ? LUNGE_REACH_HI : LUNGE_REACH), lAl + SPAN_MIN, rAl + LUNGE_STEP);
    F = clamp(Math.min(F, cAl + 0.05), LUNGE_MIN, LUNGE_MAX); // 不要跨過擊球點太多
    // 跨越遠蹲越低；擊球點越高（平抽、網前撲球）蹲得越淺
    this.lungeDepth = clamp((F - 0.2) / 0.45, 0.35, 1) * lerp(1, 0.5, clamp((cy - 0.7) / 0.9, 0, 1));
    // 右腳落在弓步線右側一點（兩腳前後錯開，左右也留約一個髖寬，不要踩成一直線）
    const tx = dX * F - dZ * 0.1;
    const tz = dZ * F + dX * 0.1;
    this.lungeLX = tx;
    this.lungeLZ = tz;
    this.lungeRX = rx + side * tx * H;
    this.lungeRZ = rz + side * tz * H;
    this.lungeX = dX;
    this.lungeZ = dZ;
    this.lungeAng = this.dA;
    this.lungeYaw = clamp(this.dA * 0.75, -1.1, 1.1);
    this.lungeFootYaw = this.dA - 0.12; // 腳尖朝跨步方向、略朝外
    this.lunging = true;
    this.lungeHold = true;
    this.lungeT = 0;
    this.lungeSwing = s;
    this.rearWX = fl.wx;
    this.rearWZ = fl.wz;
    // 左腳是蹬地的那隻：剛抬起就放回去、快落地就讓它趕快踩下（不要兩腳一起騰空跳進弓步）
    if (!fl.planted && !fl.forced) {
      if (fl.u < 0.3) {
        // 原地放下（從目前高度降下來，不瞬移）
        fl.fromX = fl.toX = fl.wx;
        fl.fromZ = fl.toZ = fl.wz;
        fl.yawFrom = fl.yawTo = fl.yaw;
        fl.lift = fl.h;
        fl.h0 = 0;
        fl.runK = 0;
        fl.u = 0.5;
        fl.dur = 0.1;
        fl.forced = true;
      } else fl.dur = Math.min(fl.dur, 0.06 / (1 - fl.u));
    }
    const h0 = fr.planted ? 0 : fr.h;
    this.beginStep(fr, this.lungeRX, this.lungeRZ, dur, 0.05 + 0.05 * this.lungeDepth, this.lungeFootYaw, true, 0.3);
    fr.h0 = h0;
    fr.strike = true;
  }

  /** 弓步的後腳：墊著腳尖在地上拖到該在的位置（不抬腳） */
  private dragRear(f: Foot): void {
    this.beginStep(f, this.rearWX, this.rearWZ, 0.18, 0, f.homeYaw, true, 0);
    f.dragging = true;
  }

  private beginStep(f: Foot, tx: number, tz: number, dur: number, lift: number, yawTo: number, forced: boolean, runK: number): void {
    f.planted = false;
    f.strike = false;
    f.dragging = false;
    f.h0 = 0;
    f.toe += f.heel; // 腳掌角度接續到這一步
    f.heel = 0;
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

  /**
   * 起跳那一刻：依起跳前的速度決定步法 —— 幾乎沒動 = 雙腳起跳；往左（頭頂區）= 馬來步（左腳蹬）；其他 = 交換步（右腳蹬）。
   * 蹬地的腳先留在地上（腿伸直才離地），另一隻腳馬上收起來。
   */
  private beginJump(): void {
    this.wasAir = true;
    this.scissor = 0;
    this.airT = 0;
    this.landT = 0;
    const fl = this.feet[0];
    const fr = this.feet[1];
    const sp = Math.hypot(this.gvx, this.gvz);
    const st = sp < 1.5 ? 0 : this.gvx < -0.35 * sp ? 2 : 1;
    let take: Foot | null = st === 0 ? null : st === 1 ? fr : fl;
    // 指定的蹬地腳剛好在空中（跑步騰空）而另一隻踩著 → 改用踩著的那隻蹬
    if (take && !take.planted) {
      const o = take === fr ? fl : fr;
      if (o.planted) take = o;
    }
    this.jumpStyle = st;
    this.jumpTake = take;
    this.jumpFirst = take ? (take === fr ? fl : fr) : null;
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      this.hold[i] = f.planted && (st === 0 || f === take);
      this.holdLand[i] = false;
      this.holdX[i] = f.wx;
      this.holdZ[i] = f.wz;
      f.planted = false;
      f.forced = true;
      f.strike = f.dragging = false;
      f.u = 1;
    }
    this.lunging = this.lungeHold = false;
    this.L = 0;
    this.lungeSwing = null;
  }

  /**
   * 落地：雙腳起跳 → 兩腳一起踩、膝蓋吸收衝擊；單腳起跳 → 先著地的腳已經踩住，
   * 另一隻腳從空中落到身體前方（交換步／馬來步的第二步）
   */
  private land(p: PlayerState, cy: number, sy: number): void {
    this.wasAir = false;
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      f.forced = false;
      f.strike = f.dragging = false;
      f.heel = f.toe = 0;
      f.h0 = 0;
      if (this.jumpStyle !== 0 && f === this.jumpTake) {
        const h = Math.max(0, f.local.y - ANKLE);
        const lx = this.offX + f.sign * 0.12 * cy - 0.2 * sy;
        const lz = this.offZ - f.sign * 0.12 * sy - 0.2 * cy;
        this.beginStep(f, p.pos.x + p.side * lx * this.h, p.pos.z + p.side * lz * this.h, 0.1, 0, f.yaw, true, 0);
        f.h0 = h;
        f.pitch = 0;
        this.landT = 0.13;
        continue;
      }
      if (this.hold[i]) {
        f.wx = this.holdX[i];
        f.wz = this.holdZ[i];
      }
      f.planted = true;
      f.h = 0;
      f.pitch = 0;
      f.u = 1;
    }
    this.hold[0] = this.hold[1] = false;
    this.peak = 0; // 起跳前的衝刺不算「急停」（不要落地就弓步）
    this.crouchV -= this.jumpStyle === 0 ? 1.7 : 1.4;
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
    this.poseLeftArm();
  }

  /** 蓄力光圈與跳殺標記（與原本相同） */
  private updateFx(p: PlayerState, dt: number): void {
    if (p.charging) {
      this.auraT += dt;
      const pulse = 1 + Math.sin(this.auraT * 14) * 0.04;
      const s = (0.85 + p.charge * 0.55) * pulse * (this.auraT < 0.12 ? 1.25 - this.auraT * 2 : 1) * this.ih; // 不跟著身高放大
      this.aura.scale.set(s, s, s);
      this.auraMat.opacity = 0.55 + p.charge * 0.4;
      this.auraMat.color.set(p.charge >= ZONES.out ? 0xff4a4a : p.charge >= ZONES.deep ? 0x2fe07a : p.charge >= ZONES.net ? 0x9be37b : 0xffa34a);
    } else {
      this.auraT = 0;
      this.auraMat.opacity = Math.max(0, this.auraMat.opacity - dt * 5);
    }
    const armed = p.jumpArmed && !p.airborne;
    this.jumpMat.opacity += ((armed ? 0.9 : 0) - this.jumpMat.opacity) * Math.min(1, dt * 12);
    // 看不見就不畫（省 draw call）
    this.aura.visible = this.auraMat.opacity > 0.01;
    this.jumpMark.visible = this.jumpMat.opacity > 0.01;
  }

  /**
   * 魚躍（撲救）動畫：不管往哪個方向撲，一律做成「往前撲」——
   * 起跳時身體轉向撲的方向、壓低前傾，幾乎水平地撲出去；持拍手連拍子往前伸直（羽球在前面就搆向它，
   * 擊到時往上小挑一下），另一隻手往前準備撐地，兩腳拖在後面；撲出去 DIVE_LAND_K 時胸口著地、順勢滑一小段；
   * 趴著等 downT；最後 DIVE_GET 秒先撐成跪姿再一腳一腳站起來，downT 歸零時剛好站好，交回一般步法。
   * 只看 p.dive.t／dx／dz、p.downT 與 GAME.dive（線上對手也一樣）。回傳 false = 已結束，這一幀照一般動畫。
   */
  private updateDive(p: PlayerState, ta: number, shOK: boolean): boolean {
    const dv = p.dive;
    if (!dv && p.downT <= 0) {
      // 結束：爬起來有做完 → 直接接手；被中斷（得分後重新站位等）→ 擺回準備姿勢
      const done = this.dvG > 0.85;
      this.endDive(p);
      if (!done) this.reset(p);
      return false;
    }
    const side = p.side;
    const H = this.h;
    const iH = this.ih;
    if (!this.diving) this.beginDive(p);
    const dur = GAME.dive.dur;
    const land = dur * DIVE_LAND_K;
    const t = dv ? Math.min(dv.t, dur) : dur;
    const g = dv ? 0 : clamp(1 - p.downT / DIVE_GET, 0, 1); // 爬起來的進度
    this.dvG = g;
    const u1 = smooth01(g / 0.45); // 趴 → 跪
    const u2 = smooth01((g - 0.45) / 0.55); // 跪 → 站
    const kIn = smooth01(t / 0.08); // 起跳：轉身、前傾
    const kLie = smooth01((t - land + 0.06) / 0.08); // 快著地 → 趴平
    const a = this.dvYaw;
    const fx = -Math.sin(a); // 撲的方向（root 座標）
    const fz = -Math.cos(a);
    const rx = -fz; // 撲的方向的右手邊
    const rz = fx;

    // ---------- 骨盆與上身 ----------
    let py: number;
    if (t < 0.06) py = lerp(this.dvY0, DIVE_FLY_Y + 0.03, smooth01(t / 0.06));
    else if (t < 0.13) py = lerp(DIVE_FLY_Y + 0.03, DIVE_FLY_Y, smooth01((t - 0.06) / 0.07));
    else py = lerp(DIVE_FLY_Y, DIVE_LIE_Y, smooth01((t - 0.13) / (land - 0.13)));
    let pitch = lerp(this.dvPitch0, -1.35, smooth01(t / 0.12));
    pitch = lerp(pitch, DIVE_LIE_PITCH, smooth01((t - 0.12) / (land - 0.12)));
    let along = -DIVE_BACK * smooth01(t / 0.1);
    let arch = lerp(lerp(this.dvArch0, 0.12, kIn), 0.2, kLie); // 正 = 抬胸
    let yaw = lerp(this.dvYaw0, a, kIn);
    let twist = this.dvTwist0 * (1 - kIn);
    const roll = this.dvRoll0 * (1 - kIn);
    const yawS = 0.8 * a; // 站好時的骨盆朝向（交回一般動畫時 psi = a）
    if (g > 0) {
      const standY = lerp(READY_H, STAND_H, this.relaxK);
      py = lerp(lerp(DIVE_LIE_Y, KNEEL_Y, u1), standY, u2);
      pitch = lerp(lerp(DIVE_LIE_PITCH, -0.6, u1), 0, u2);
      along = lerp(lerp(-DIVE_BACK, -0.3, u1), 0, u2);
      arch = lerp(lerp(0.2, 0.05, u1), -0.1 * (1 - this.relaxK), u2);
      yaw = lerp(a, yawS, u2);
      twist = (a - yawS) * u2;
    }
    const ox = lerp(this.dvOffX0, 0, kIn) + fx * along;
    const oz = lerp(this.dvOffZ0, 0, kIn) + fz * along;
    this.hips.position.set(ox, py, oz);
    this.hips.rotation.set(pitch, yaw, 0);
    this.spine.position.y = WAIST;
    this.spine.rotation.set(arch, twist, roll);
    this.hips.updateMatrix();
    this.spine.updateMatrix();
    this.mC.multiplyMatrices(this.hips.matrix, this.spine.matrix);
    this.qC.multiplyQuaternions(this.hips.quaternion, this.spine.quaternion);
    this.qCi.copy(this.qC).invert();
    this.shoulderR.copy(this.shR0).applyMatrix4(this.mC);
    this.shoulderL.copy(this.shL0).applyMatrix4(this.mC);
    this.hipY = this.yOut = py;
    this.offX = ox;
    this.offZ = oz;

    // ---------- 腿：不踩地，跟著身體（起跳時腳先留在原地蹬、再拖到身後；爬起來時收成跪姿再踩回站姿）----------
    const bodyFront = _v4.set(0, 0, -1).applyQuaternion(this.hips.quaternion); // 身體正面（趴著時朝下）
    const cS = Math.cos(yawS);
    const sS = Math.sin(yawS);
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      f.planted = false;
      // 拖在身後的腳（骨盆座標：沿腿往下、趴著時腳背貼地）
      const tgt = _v2.set(f.sign * 0.12, -0.8, lerp(0.05, -0.05, kLie)).applyMatrix4(this.hips.matrix);
      let shoeP = pitch - 1.2; // 腳背打直（腳尖朝後）
      let shoeY = a;
      let uf = 0;
      if (dv) {
        // 起跳：左腳先離地、右腳最後蹬
        const wl = smooth01((t - (f.sign > 0 ? 0.03 : 0)) / 0.1);
        const s0 = this.dvFoot[i];
        const lx = (s0.x - p.pos.x) * side * iH;
        const lz = (s0.z - p.pos.z) * side * iH;
        tgt.set(lerp(lx, tgt.x, wl), lerp(s0.y, tgt.y, wl) + 0.08 * Math.sin(Math.PI * wl), lerp(lz, tgt.z, wl));
        shoeP = lerp(0, shoeP, wl);
        shoeY = lerp(this.dvFootYaw[i], a, wl);
        this.dvLie[i].copy(tgt);
      } else if (g <= 0) this.dvLie[i].copy(tgt);
      else {
        // 爬起來：先收成跪姿（小腿貼地、腳尖在後），再一腳一腳踩到站姿位置（右腳先）
        uf = f.sign > 0 ? smooth01(u2 / 0.65) : smooth01((u2 - 0.3) / 0.65);
        const lie = this.dvLie[i];
        const kx = fx * -0.6 + rx * f.sign * 0.14;
        const kz = fz * -0.6 + rz * f.sign * 0.14;
        const px = f.sign * 0.21;
        const pz = f.sign > 0 ? -0.07 : 0.03;
        tgt.set(lerp(lie.x, kx, u1), lerp(lie.y, ANKLE + 0.03, u1), lerp(lie.z, kz, u1));
        tgt.set(lerp(tgt.x, px * cS + pz * sS, uf), lerp(tgt.y, ANKLE, uf) + 0.09 * Math.sin(Math.PI * uf), lerp(tgt.z, -px * sS + pz * cS, uf));
        shoeP = lerp(lerp(DIVE_LIE_PITCH - 1.2, -1.9, u1), 0, uf);
        shoeY = lerp(a, yawS - f.sign * 0.22, uf);
      }
      // 膝蓋：撲出去／跪著朝身體正面，站起來時朝腳尖
      _pole.copy(bodyFront).lerp(_v3.set(-Math.sin(shoeY), 0, -Math.cos(shoeY)), uf);
      f.hip.set(f.sign * this.hipW, 0, 0).applyMatrix4(this.hips.matrix);
      solveTwoBone(f.hip, tgt, THIGH, SHIN, _pole, f.knee, f.ankle);
      f.local.copy(tgt);
      f.wx = p.pos.x + side * tgt.x * H;
      f.wz = p.pos.z + side * tgt.z * H;
      f.h = Math.max(0, tgt.y - ANKLE);
      f.yaw = shoeY;
      f.pitch = shoeP;
      this.poseLeg(f, f.ankle, _pole, shoeP, shoeY);
    }

    // ---------- 持拍手：往前伸直；羽球在前面就搆向它；擊到時往上挑一下 ----------
    const s = p.swing;
    const dir = _v1.set(fx + rx * 0.12, -0.15, fz + rz * 0.12).normalize();
    if (s && s.dive && s.contacted && s.contactPoint) {
      const cp = s.contactPoint;
      const to = _v2.set((cp.x - p.pos.x) * side * iH, (cp.y - p.pos.y) * iH, (cp.z - p.pos.z) * side * iH).sub(this.shoulderR);
      if (to.lengthSq() > 1e-4) dir.lerp(to.normalize(), 0.7).normalize();
      const fl = Math.sin(Math.PI * clamp((s.t - s.contactT) / 0.15, 0, 1));
      dir.y += 0.6 * fl; // 手腕往上一挑把球撈起來
      dir.normalize();
    } else if (dv && shOK) {
      const to = _v2.subVectors(this.shL, this.shoulderR);
      const d = to.length();
      if (d > 0.05 && to.x * fx + to.z * fz > 0.2 * d) dir.lerp(to.multiplyScalar(1 / d), 0.7 * (1 - clamp((d - 1) / 1.4, 0, 1))).normalize();
    }
    if (g > 0) dir.lerp(_v2.set(fx * 0.35 + rx * 0.15, -0.9, fz * 0.35 + rz * 0.15).normalize(), u1).normalize();
    const qT = _q1.setFromUnitVectors(UP, dir);
    if (u2 > 0) qT.slerp(_q2.multiplyQuaternions(this.qC, ARM_READY), u2);
    this.qArm.slerp(qT, 1 - Math.exp(-28 * ta));
    this.stretch += (lerp(1.04, 1, Math.max(u1, 1 - kIn)) - this.stretch) * Math.min(1, ta * 20);
    this.bend = damp(this.bend, lerp(0.12, BEND_READY, u2), 12, ta);
    this.elbow.lerp(_v4.copy(ELBOW_DIVE).lerp(ELBOW_READY, u2).applyQuaternion(this.qC), 1 - Math.exp(-10 * ta));
    this.poseRightArm(ta);

    // ---------- 非持拍手：往前伸、準備撐地；趴著時手掌貼地；爬起來時放下 ----------
    const tu = _v2.set(fx * 0.6 - rx * 0.35, -0.55, fz * 0.6 - rz * 0.35);
    const tf = _v3.set(fx * 0.85 - rx * 0.1, -0.45, fz * 0.85 - rz * 0.1);
    tu.lerp(_v4.set(fx * 0.45 - rx * 0.35, -0.8, fz * 0.45 - rz * 0.35), kLie);
    tf.lerp(_v4.set(fx * 0.9, -0.25, fz * 0.9), kLie);
    if (g > 0) {
      tu.lerp(_v4.set(fx * 0.1 - rx * 0.15, -1, fz * 0.1 - rz * 0.15), u1);
      tf.lerp(_v4.set(fx * 0.3 - rx * 0.1, -0.9, fz * 0.3 - rz * 0.1), u1);
      tu.normalize().lerp(_v4.copy(L_READY_UP).applyQuaternion(this.qC), u2);
      tf.normalize().lerp(_v4.copy(L_READY_FORE).applyQuaternion(this.qC), u2);
    }
    const r = 1 - Math.exp(-18 * ta);
    this.lU.lerp(tu.normalize(), r).normalize();
    this.lF.lerp(tf.normalize(), r).normalize();
    this.poseLeftArm();

    // ---------- 頭：抬頭看前面 ----------
    this.headPitch = damp(this.headPitch, lerp(lerp(0, 1.1, kIn), 0.15, g), 14, ta);
    this.headYaw = damp(this.headYaw, 0, 14, ta);
    this.poseHead(this.headPitch, this.headYaw);
    if (this.ponytail) {
      this.ptX = damp(this.ptX, lerp(-0.35, -1.1, kIn * (1 - g)), 10, ta);
      this.ptZ = damp(this.ptZ, 0, 10, ta);
      this.ptVX = this.ptVZ = 0;
      this.ponytail.rotation.set(this.ptX - this.headPitch, 0, this.ptZ);
    }

    // ---------- 影子：拉成橢圓，跟著身體 ----------
    const prone = g > 0 ? 1 - u2 : smooth01(t / 0.15);
    this.shadow.position.x = ox + fx * 0.4 * prone;
    this.shadow.position.z = oz + fz * 0.4 * prone;
    this.shadow.rotation.z = Math.atan2(-fz, fx);
    const sh = 1 - Math.min(0.3, Math.max(0, py - DIVE_LIE_Y) * 0.5);
    this.shadow.scale.set((1 + 0.8 * prone) * sh, (1 - 0.15 * prone) * sh, 1);

    // ---------- 擊到時的拍子拖尾 ----------
    const swish = !!(s && s.dive && s.contacted && s.t - s.contactT < 0.14);
    this.trail.setStyle(SWOOSH_NORMAL);
    _sw.copy(this.shoulderR).applyMatrix4(this.root.matrixWorld);
    _sq.multiplyQuaternions(this.root.quaternion, this.qArm);
    this.trail.step(ta, swish, _sw, _sq, (this.stretch * H * (this.wristY + HAND_TO_HEAD)) / HEAD_NOMINAL);
    const tm = this.trail.mesh;
    if (tm.visible) {
      tm.matrix.copy(this.root.matrixWorld).invert();
      tm.matrixWorldNeedsUpdate = true;
    }
    return true;
  }

  /** 撲出去的第一幀：記下起跳時的姿勢（之後從這裡平順地轉成撲出去的姿勢） */
  private beginDive(p: PlayerState): void {
    this.diving = true;
    this.dvG = 0;
    this.dvYaw0 = this.hips.rotation.y;
    this.dvPitch0 = this.hips.rotation.x;
    this.dvArch0 = this.spine.rotation.x;
    this.dvTwist0 = this.spine.rotation.y;
    this.dvRoll0 = this.spine.rotation.z;
    this.dvY0 = this.hips.position.y;
    this.dvOffX0 = this.hips.position.x;
    this.dvOffZ0 = this.hips.position.z;
    const d = p.dive;
    // 撲的方向 → 骨盆朝向（就近轉：往後撲時從比較近的那一側轉過去）
    let a = d ? Math.atan2(-d.dx * p.side, -d.dz * p.side) : this.dvYaw0;
    while (a - this.dvYaw0 > Math.PI) a -= Math.PI * 2;
    while (a - this.dvYaw0 < -Math.PI) a += Math.PI * 2;
    this.dvYaw = a;
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      this.dvFoot[i].set(f.wx, f.local.y, f.wz);
      this.dvFootYaw[i] = f.yaw;
      this.dvLie[i].copy(f.local);
    }
    this.lunging = this.lungeHold = false;
    this.L = 0;
    this.lungeSwing = null;
  }

  /** 爬起來站好：腳在站姿位置踩住、骨盆／朝向接上一般動畫（不會跳） */
  private endDive(p: PlayerState): void {
    this.diving = false;
    this.dvG = 0;
    const side = p.side;
    const yawS = 0.8 * this.dvYaw;
    const cy = Math.cos(yawS);
    const sy = Math.sin(yawS);
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      const px = f.sign * 0.21;
      const pz = f.sign > 0 ? -0.07 : 0.03;
      const hx = px * cy + pz * sy;
      const hz = -px * sy + pz * cy;
      f.wx = f.homeX = p.pos.x + side * hx * this.h;
      f.wz = f.homeZ = p.pos.z + side * hz * this.h;
      f.planted = true;
      f.forced = false;
      f.strike = f.dragging = false;
      f.u = 1;
      f.h = f.h0 = 0;
      f.pitch = f.heel = f.toe = 0;
      f.yaw = f.yawTo = f.homeYaw = yawS - f.sign * 0.22;
      f.pivoting = false;
      f.local.set(hx, ANKLE, hz);
    }
    this.psi = this.dvYaw;
    this.hipY = this.yOut = this.hips.position.y;
    this.crouch = this.crouchV = 0;
    this.offX = this.hips.position.x;
    this.offZ = this.hips.position.z;
    this.offY = 0;
    this.lunging = this.lungeHold = false;
    this.L = 0;
    this.lungeSwing = null;
    this.recoverT = 0;
    this.prepOver = this.prepFront = 0;
    this.wide = 0;
    this.splitPending = false;
    this.peak = 0;
    this.wasAir = false;
    this.scissor = 0;
    this.lastStep = null;
    this.wPose = 0;
    this.shadow.position.x = this.shadow.position.z = 0;
    this.shadow.rotation.z = 0;
  }

  /** 第一次或瞬移（發球前重新站位）時，直接擺成準備姿勢（發球的人：右腳在前的發球站姿） */
  private reset(p: PlayerState, serveStance = false): void {
    this.inited = true;
    this.diving = false;
    this.hold[0] = this.hold[1] = false;
    this.landT = 0;
    this.serveK = serveStance ? 1 : 0;
    this.dvG = 0;
    this.shadow.position.x = this.shadow.position.z = 0;
    this.shadow.rotation.z = 0;
    const side = p.side;
    for (let i = 0; i < 2; i++) {
      const f = this.feet[i];
      const hx = serveStance ? (f.sign > 0 ? 0.13 : -0.15) : f.sign * 0.21;
      const hz = serveStance ? (f.sign > 0 ? -0.2 : 0.2) : f.sign > 0 ? -0.07 : 0.03;
      f.wx = f.homeX = p.pos.x + side * hx * this.h;
      f.wz = f.homeZ = p.pos.z + side * hz * this.h;
      f.planted = !p.airborne;
      f.forced = false;
      f.strike = f.dragging = false;
      f.u = 1;
      f.h = f.h0 = 0;
      f.pitch = f.heel = f.toe = 0;
      f.yaw = f.yawTo = f.homeYaw = serveStance ? (f.sign > 0 ? -0.1 : 0.55) : -f.sign * 0.22;
      f.pivoting = false;
      f.local.set(hx, ANKLE, hz);
    }
    this.psi = 0;
    this.hipY = this.yOut = READY_H;
    this.crouch = this.crouchV = 0;
    this.lunging = false;
    this.lungeHold = false;
    this.lungeSwing = null;
    this.scissorSwing = null;
    this.recoverT = 0;
    this.prepOver = this.prepFront = 0;
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
    this.trail.reset();
    this.headHave = false;
    this.faceN.set(0, 0, -1);
    this.ptX = -0.35;
    this.ptZ = this.ptVX = this.ptVZ = 0;
  }
}
