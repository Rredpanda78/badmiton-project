import * as THREE from 'three';
import { GAME } from '../config';
import type { PlayerState } from '../sim/match';
import { chargeZones } from '../sim/shots';

const ZONES = chargeZones();
const ARM_LEN = 1.06; // 肩膀到拍面中心的距離

const UP = new THREE.Vector3(0, 1, 0);
// 手臂方向（模型面向 -z，右手在 +x）
const POSE_READY = new THREE.Vector3(0.45, 0.6, -0.65).normalize();
const POSE_WIND = new THREE.Vector3(0.45, 0.75, 0.5).normalize();
const POSE_FOLLOW = new THREE.Vector3(-0.55, -0.35, -0.75).normalize();
const SHOULDER = new THREE.Vector3(0.24, 1.42, 0);

const qFrom = (dir: THREE.Vector3) => new THREE.Quaternion().setFromUnitVectors(UP, dir);
const Q_READY = qFrom(POSE_READY);
const Q_WIND = qFrom(POSE_WIND);
const Q_FOLLOW = qFrom(POSE_FOLLOW);

/** 簡單的低多邊形球員：身體、頭、腿、持拍手 */
export class PlayerModel {
  readonly root = new THREE.Group();
  private body = new THREE.Group();
  private legL: THREE.Mesh;
  private legR: THREE.Mesh;
  private aura: THREE.Mesh;
  private auraMat: THREE.MeshBasicMaterial;
  private auraT = 0;
  private shadow: THREE.Mesh;
  private jumpMark: THREE.Mesh;
  private jumpMat: THREE.MeshBasicMaterial;
  private arm = new THREE.Group();
  private runPhase = 0;
  private tmpQ = new THREE.Quaternion();
  private tmpV = new THREE.Vector3();

  constructor(shirt: number, shorts: number) {
    const skin = new THREE.MeshLambertMaterial({ color: 0xf0c7a0 });
    const shirtM = new THREE.MeshLambertMaterial({ color: shirt });
    const shortsM = new THREE.MeshLambertMaterial({ color: shorts });
    const shoeM = new THREE.MeshLambertMaterial({ color: 0xf2f2f2 });

    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.2, 0.42, 4, 10), shirtM);
    torso.position.y = 1.2;
    torso.scale.z = 0.7;
    this.body.add(torso);
    const hips = new THREE.Mesh(new THREE.CylinderGeometry(0.19, 0.17, 0.2, 10), shortsM);
    hips.position.y = 0.88;
    this.body.add(hips);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.13, 14, 10), skin);
    head.position.y = 1.66;
    this.body.add(head);
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.135, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2), new THREE.MeshLambertMaterial({ color: 0x2a1d14 }));
    hair.position.y = 1.68;
    this.body.add(hair);

    const legGeo = new THREE.CylinderGeometry(0.065, 0.055, 0.8, 8);
    legGeo.translate(0, -0.4, 0);
    const shoeGeo = new THREE.BoxGeometry(0.11, 0.07, 0.22);
    shoeGeo.translate(0, -0.8, -0.04);
    const mkLeg = (x: number) => {
      const leg = new THREE.Mesh(legGeo, skin);
      leg.add(new THREE.Mesh(shoeGeo, shoeM));
      leg.position.set(x, 0.84, 0);
      this.body.add(leg);
      return leg;
    };
    this.legL = mkLeg(-0.1);
    this.legR = mkLeg(0.1);

    // 左手（不動）
    const armGeo = new THREE.CylinderGeometry(0.045, 0.04, 0.55, 8);
    armGeo.translate(0, 0.275, 0);
    const lArm = new THREE.Mesh(armGeo, skin);
    lArm.position.set(-0.24, 1.42, 0);
    lArm.quaternion.copy(qFrom(new THREE.Vector3(-0.35, -0.8, -0.3).normalize()));
    this.body.add(lArm);

    // 右手＋球拍：沿 +Y 方向延伸，用四元數指向目標
    this.arm.position.copy(SHOULDER);
    this.arm.add(new THREE.Mesh(armGeo, skin));
    const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.014, 0.3, 6), new THREE.MeshLambertMaterial({ color: 0x222222 }));
    handle.position.y = 0.68;
    this.arm.add(handle);
    const frame = new THREE.Mesh(new THREE.TorusGeometry(0.115, 0.012, 6, 20), new THREE.MeshLambertMaterial({ color: shirt }));
    frame.scale.set(0.82, 1, 1);
    frame.rotation.y = Math.PI / 2;
    frame.position.y = 0.94;
    this.arm.add(frame);
    const strings = new THREE.Mesh(
      new THREE.CircleGeometry(0.11, 16),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, side: THREE.DoubleSide }),
    );
    strings.scale.set(0.82, 1, 1);
    strings.rotation.y = Math.PI / 2;
    strings.position.y = 0.94;
    this.arm.add(strings);
    this.arm.quaternion.copy(Q_READY);
    this.body.add(this.arm);

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
    this.root.add(this.body);
  }

  update(p: PlayerState, dt: number): void {
    this.root.position.set(p.pos.x, p.pos.y, p.pos.z);
    this.root.rotation.y = p.side === 1 ? 0 : Math.PI;
    this.root.updateMatrixWorld();
    // 影子、光圈留在地上；跳越高影子越小
    const ground = -p.pos.y + 0.006;
    this.shadow.position.y = ground;
    const ss = 1 - Math.min(0.4, p.pos.y * 0.8);
    this.shadow.scale.set(ss, ss, ss);
    this.aura.position.y = ground + 0.006;
    this.jumpMark.position.y = ground + 0.008;

    const speed = Math.hypot(p.vel.x, p.vel.z);
    this.runPhase += dt * (4 + speed * 3.2);
    const k = p.airborne ? 0 : Math.min(1, speed / 3);
    const tuck = p.airborne ? 0.55 : 0;
    this.legL.rotation.x = Math.sin(this.runPhase) * 0.7 * k - tuck;
    this.legR.rotation.x = -Math.sin(this.runPhase) * 0.7 * k + tuck * 0.4;
    // 往移動方向微傾
    const lx = p.vel.x * p.side;
    const lz = p.vel.z * p.side;
    this.body.rotation.z = -lx * 0.04;
    this.body.rotation.x = lz * 0.03;
    let bodyX = 0;
    let bodyZ = 0;
    let bodyY = Math.abs(Math.sin(this.runPhase)) * 0.05 * k;

    // 蓄力光圈：顏色跟蓄力條一致（掛網區橘、好球區綠、出界區紅）
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
    // 跳殺待命：腳下青色小圈＋微微蹲低
    const armed = p.jumpArmed && !p.airborne;
    this.jumpMat.opacity += ((armed ? 0.9 : 0) - this.jumpMat.opacity) * Math.min(1, dt * 12);
    if (armed) bodyY -= 0.06;

    // 手臂
    let target: THREE.Quaternion;
    let stretch = 1;
    const s = p.swing;
    if (s) {
      if (s.contacted && s.contactPoint) {
        const { dir, dist } = this.localDir(s.contactPoint);
        const qc = qFrom(dir);
        // 至少播 0.06 秒的揮拍，避免一划就打到時手臂瞬移
        const windT = Math.max(s.contactT, 0.06);
        if (s.t <= windT) target = this.tmpQ.copy(Q_WIND).slerp(qc, s.t / windT);
        else {
          const u = Math.min(1, (s.t - windT) / Math.max(0.05, GAME.swingDuration - windT));
          target = this.tmpQ.copy(qc).slerp(Q_FOLLOW, u);
        }
        // 接觸點太遠：手臂伸長、身體往那邊探
        const near = 1 - Math.min(1, Math.abs(s.t - windT) / 0.12);
        stretch = 1 + (Math.min(1.35, Math.max(1, dist / ARM_LEN)) - 1) * near;
        const over = Math.max(0, dist - ARM_LEN) * near;
        const hl = Math.hypot(dir.x, dir.z) || 1;
        bodyX = (dir.x / hl) * Math.min(0.3, over);
        bodyZ = (dir.z / hl) * Math.min(0.3, over);
        if (dir.y > 0.5) bodyY += Math.min(0.12, over * 0.5);
      } else {
        const u = Math.min(1, s.t / GAME.swingDuration);
        target = this.tmpQ.copy(Q_WIND).slerp(Q_FOLLOW, u * u * (3 - 2 * u));
      }
      this.arm.quaternion.copy(target);
    } else {
      target = p.charging ? Q_WIND : Q_READY;
      this.arm.quaternion.slerp(target, Math.min(1, dt * (p.charging ? 14 : 8)));
    }
    this.arm.scale.y += (stretch - this.arm.scale.y) * Math.min(1, dt * 30);
    this.body.position.set(bodyX, bodyY, bodyZ);
  }

  /** 世界座標中的接觸點 → 手臂局部方向與距離 */
  private localDir(world: { x: number; y: number; z: number }): { dir: THREE.Vector3; dist: number } {
    const v = this.tmpV.set(world.x, world.y, world.z);
    this.root.worldToLocal(v);
    v.sub(SHOULDER);
    const dist = v.length();
    if (dist < 1e-3) v.set(0, 1, 0);
    return { dir: v.normalize().clone(), dist };
  }
}
