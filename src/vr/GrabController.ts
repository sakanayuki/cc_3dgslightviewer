import * as THREE from 'three';
import { VR_SCALE_MAX, VR_SCALE_MIN } from '../config';

interface HandPose {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
}

interface GrabState {
  twoHanded: boolean;
  /** 片手時に掴んでいるコントローラの番号 */
  primary: number;
  poses: [HandPose, HandPose];
}

function readPose(controller: THREE.Object3D): HandPose {
  return {
    position: controller.getWorldPosition(new THREE.Vector3()),
    quaternion: controller.getWorldQuaternion(new THREE.Quaternion()),
  };
}

/**
 * VR のグラブ操作。操作対象は worldRoot (SplatMesh の親) = 世界側が動く。
 *
 * - 片手グリップ: 掴んだ手に世界が完全に追従する (平行移動 + 3軸すべての回転)
 * - 両手グリップ: 平行移動 + 手を結ぶ軸の向きの変化ぶんの回転 + 拡縮
 *
 * **回転に軸の制限を設けていない。**以前は両手回転を Yaw のみに落としていたが、
 * atan2 で XZ 平面へ投影する方式だったため、手を縦に回すと 90 度付近で投影が
 * 退化し 180 度で元に戻ってしまい「回転し続けられない」状態になっていた。
 *
 * また、掴んだ瞬間の姿勢を基準にする絶対差分ではなく、**フレーム間の差分を
 * 積み上げる方式**にしている。絶対差分では基準ベクトルと現在ベクトルが反平行に
 * なる点 (180 度) で回転軸が定まらず不連続が生じるが、フレーム間の差分は
 * 常に微小角なので特異点が無く、何回転でも連続して回せる。
 */
export class GrabController {
  private state: GrabState | null = null;

  constructor(
    private readonly worldRoot: THREE.Group,
    private readonly controllers: readonly [THREE.Object3D, THREE.Object3D],
  ) {}

  /** 各コントローラの squeeze 状態を渡して毎フレーム呼ぶ */
  update(squeezing: readonly [boolean, boolean]): void {
    const activeCount = (squeezing[0] ? 1 : 0) + (squeezing[1] ? 1 : 0);
    if (activeCount === 0) {
      this.state = null;
      return;
    }

    const poses: [HandPose, HandPose] = [
      readPose(this.controllers[0]),
      readPose(this.controllers[1]),
    ];
    const twoHanded = activeCount === 2;
    const primary = squeezing[0] ? 0 : 1;

    // 手の本数や掴んでいる手が変わったら基準を取り直す (取り直さないと世界が飛ぶ)
    if (!this.state || this.state.twoHanded !== twoHanded || this.state.primary !== primary) {
      this.state = { twoHanded, primary, poses };
      return;
    }

    if (twoHanded) this.applyTwoHanded(this.state.poses, poses);
    else this.applyOneHanded(this.state.poses[primary]!, poses[primary]!);

    this.state = { twoHanded, primary, poses };
  }

  /**
   * 掴んだ手の剛体運動をそのまま世界に適用する。
   * 手が prev から curr へ動いたときの変換 D(x) = dq * (x - prevPos) + currPos を
   * worldRoot に掛ける。回転は 3 軸とも自由で、上限も特異点も無い。
   */
  private applyOneHanded(prev: HandPose, curr: HandPose): void {
    const dq = curr.quaternion.clone().multiply(prev.quaternion.clone().invert());
    const offset = this.worldRoot.position.clone().sub(prev.position).applyQuaternion(dq);
    this.worldRoot.position.copy(curr.position).add(offset);
    this.worldRoot.quaternion.premultiply(dq).normalize();
  }

  /**
   * 両手の間隔で拡縮、中点で平行移動、手を結ぶ軸の向きの変化で回転する。
   * 回転はフレーム間の微小角なので、どの向きにも連続して回し続けられる。
   */
  private applyTwoHanded(prev: [HandPose, HandPose], curr: [HandPose, HandPose]): void {
    const vPrev = prev[1].position.clone().sub(prev[0].position);
    const vCurr = curr[1].position.clone().sub(curr[0].position);
    const lPrev = vPrev.length();
    const lCurr = vCurr.length();
    if (lPrev < 1e-5 || lCurr < 1e-5) return;

    const dq = new THREE.Quaternion().setFromUnitVectors(
      vPrev.clone().divideScalar(lPrev),
      vCurr.clone().divideScalar(lCurr),
    );

    const current = this.worldRoot.scale.x;
    const clamped = THREE.MathUtils.clamp(
      current * (lCurr / lPrev),
      VR_SCALE_MIN,
      VR_SCALE_MAX,
    );
    const s = clamped / current;

    const midPrev = prev[0].position.clone().add(prev[1].position).multiplyScalar(0.5);
    const midCurr = curr[0].position.clone().add(curr[1].position).multiplyScalar(0.5);

    const offset = this.worldRoot.position
      .clone()
      .sub(midPrev)
      .multiplyScalar(s)
      .applyQuaternion(dq);

    this.worldRoot.position.copy(midCurr).add(offset);
    this.worldRoot.quaternion.premultiply(dq).normalize();
    this.worldRoot.scale.setScalar(clamped);
  }

  /** worldRoot を初期状態に戻す (VR 終了時) */
  reset(): void {
    this.state = null;
    this.worldRoot.position.set(0, 0, 0);
    this.worldRoot.quaternion.identity();
    this.worldRoot.scale.setScalar(1);
  }
}
