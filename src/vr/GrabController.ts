import * as THREE from 'three';
import { VR_SCALE_MAX, VR_SCALE_MIN } from '../config';

const UP = new THREE.Vector3(0, 1, 0);

/** 掴んだ瞬間の worldRoot とコントローラの状態 */
interface GrabState {
  twoHanded: boolean;
  rootPosition: THREE.Vector3;
  rootQuaternion: THREE.Quaternion;
  rootScale: number;
  /** 片手時: 掴んだ手の位置 */
  anchor: THREE.Vector3;
  /** 両手時: 手間距離・中点・方位角 */
  baseDistance: number;
  baseMid: THREE.Vector3;
  baseAzimuth: number;
}

function azimuth(a: THREE.Vector3, b: THREE.Vector3): number {
  return Math.atan2(b.z - a.z, b.x - a.x);
}

/**
 * VR のグラブ操作。操作対象は worldRoot (SplatMesh の親) = 世界側が動く。
 *
 * - 片手グリップ: 平行移動
 * - 両手グリップ: 平行移動 + Yaw 回転 + 中点基準の拡縮
 *
 * 回転を Yaw のみに制限しているのは、Pitch/Roll を許すと即座に方向感覚を失うため。
 * 片手↔両手の遷移時は必ず基準値を取り直す (取り直さないと世界が飛ぶ)。
 */
export class GrabController {
  private state: GrabState | null = null;

  constructor(
    private readonly worldRoot: THREE.Group,
    private readonly controllers: readonly [THREE.XRTargetRaySpace, THREE.XRTargetRaySpace],
  ) {}

  /** 各コントローラの squeeze 状態を渡して毎フレーム呼ぶ */
  update(squeezing: readonly [boolean, boolean]): void {
    const activeCount = (squeezing[0] ? 1 : 0) + (squeezing[1] ? 1 : 0);
    if (activeCount === 0) {
      this.state = null;
      return;
    }

    const posA = new THREE.Vector3();
    const posB = new THREE.Vector3();
    this.controllers[0].getWorldPosition(posA);
    this.controllers[1].getWorldPosition(posB);

    const twoHanded = activeCount === 2;
    const primary = squeezing[0] ? posA : posB;

    if (!this.state || this.state.twoHanded !== twoHanded) {
      this.state = {
        twoHanded,
        rootPosition: this.worldRoot.position.clone(),
        rootQuaternion: this.worldRoot.quaternion.clone(),
        rootScale: this.worldRoot.scale.x,
        anchor: primary.clone(),
        baseDistance: Math.max(1e-6, posA.distanceTo(posB)),
        baseMid: posA.clone().add(posB).multiplyScalar(0.5),
        baseAzimuth: azimuth(posA, posB),
      };
      return;
    }

    if (twoHanded) this.applyTwoHanded(posA, posB, this.state);
    else this.applyOneHanded(primary, this.state);
  }

  private applyOneHanded(pos: THREE.Vector3, s: GrabState): void {
    this.worldRoot.position.copy(s.rootPosition).add(pos.clone().sub(s.anchor));
  }

  private applyTwoHanded(posA: THREE.Vector3, posB: THREE.Vector3, s: GrabState): void {
    const mid = posA.clone().add(posB).multiplyScalar(0.5);
    const distance = Math.max(1e-6, posA.distanceTo(posB));

    const scale = THREE.MathUtils.clamp(
      s.rootScale * (distance / s.baseDistance),
      VR_SCALE_MIN,
      VR_SCALE_MAX,
    );
    const yawQuat = new THREE.Quaternion().setFromAxisAngle(
      UP,
      azimuth(posA, posB) - s.baseAzimuth,
    );

    // 掴んだ瞬間の中点を不動点として回転・拡縮し、そのあと中点の移動分を足す
    const offset = s.rootPosition
      .clone()
      .sub(s.baseMid)
      .multiplyScalar(scale / s.rootScale)
      .applyQuaternion(yawQuat);

    this.worldRoot.position.copy(mid).add(offset);
    this.worldRoot.quaternion.copy(yawQuat).multiply(s.rootQuaternion);
    this.worldRoot.scale.setScalar(scale);
  }

  reset(): void {
    this.state = null;
    this.worldRoot.position.set(0, 0, 0);
    this.worldRoot.quaternion.identity();
    this.worldRoot.scale.setScalar(1);
  }
}
