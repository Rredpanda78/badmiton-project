import * as THREE from 'three';
import { GAME } from '../config';
import type { PlayerState } from '../sim/match';

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
    const shadow = new THREE.Mesh(
      new THREE.CircleGeometry(0.42, 20),
      new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.32, depthWrite: false }),
    );
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.y = 0.006;
    this.root.add(shadow);
    this.root.add(this.body);
  }

  update(p: PlayerState, dt: number): void {
    this.root.position.set(p.pos.x, 0, p.pos.z);
    this.root.rotation.y = p.side === 1 ? 0 : Math.PI;
    this.root.updateMatrixWorld();

    const speed = Math.hypot(p.vel.x, p.vel.z);
    this.runPhase += dt * (4 + speed * 3.2);
    const k = Math.min(1, speed / 3);
    this.legL.rotation.x = Math.sin(this.runPhase) * 0.7 * k;
    this.legR.rotation.x = -Math.sin(this.runPhase) * 0.7 * k;
    this.body.position.y = Math.abs(Math.sin(this.runPhase)) * 0.05 * k;
    // 往移動方向微傾
    const lx = p.vel.x * p.side;
    const lz = p.vel.z * p.side;
    this.body.rotation.z = -lx * 0.04;
    this.body.rotation.x = lz * 0.03;

    // 手臂
    let target: THREE.Quaternion;
    const s = p.swing;
    if (s) {
      if (s.contacted && s.contactPoint) {
        const dir = this.localDir(s.contactPoint);
        const qc = qFrom(dir);
        if (s.t <= s.contactT) target = this.tmpQ.copy(Q_WIND).slerp(qc, s.contactT > 0 ? s.t / s.contactT : 1);
        else {
          const u = Math.min(1, (s.t - s.contactT) / Math.max(0.05, GAME.swingDuration - s.contactT));
          target = this.tmpQ.copy(qc).slerp(Q_FOLLOW, u);
        }
      } else {
        const u = Math.min(1, s.t / GAME.swingDuration);
        target = this.tmpQ.copy(Q_WIND).slerp(Q_FOLLOW, u * u * (3 - 2 * u));
      }
      this.arm.quaternion.copy(target);
    } else {
      target = p.charging ? Q_WIND : Q_READY;
      this.arm.quaternion.slerp(target, Math.min(1, dt * (p.charging ? 14 : 8)));
    }
  }

  /** 世界座標中的接觸點 → 手臂局部方向 */
  private localDir(world: { x: number; y: number; z: number }): THREE.Vector3 {
    const v = this.tmpV.set(world.x, world.y, world.z);
    this.root.worldToLocal(v);
    v.sub(SHOULDER);
    if (v.lengthSq() < 1e-6) v.set(0, 1, 0);
    return v.normalize().clone();
  }
}
