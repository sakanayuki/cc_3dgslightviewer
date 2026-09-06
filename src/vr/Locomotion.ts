import * as THREE from 'three';
import {
  VR_MOVE_SPEED_MPS,
  VR_SNAP_ANGLE_DEG,
  VR_SNAP_OFF_THRESHOLD,
  VR_SNAP_ON_THRESHOLD,
  VR_STICK_DEADZONE,
} from '../config';

/** Quest コントローラの軸番号 (xr-standard: 2=stick X, 3=stick Y) */
const AXIS_X = 2;
const AXIS_Y = 3;
/** xr-standard のボタン: 0=trigger, 1=squeeze */
const BUTTON_TRIGGER = 0;

function deadzone(v: number): number {
  return Math.abs(v) < VR_STICK_DEADZONE ? 0 : v;
}

/**
 * VR の移動。操作対象は rig (カメラの親 Group) = プレイヤー側が動く。
 *
 * - 左スティック: 頭の向いている方位を基準とした水平移動
 * - 右スティック左右: スナップ回転 (VR酔い対策のため連続回転にしない)
 * - 左トリガー: ダッシュ / 右トリガー: 微調整
 */
export class Locomotion {
  /**
   * 移動速度 [m/s]。VR 入場時にモデルを実寸へ正規化するため、
   * シーン半径からの相対値ではなく実際の毎秒移動量で持つ。
   */
  moveSpeed = VR_MOVE_SPEED_MPS;
  private snapLatched = false;

  constructor(private readonly rig: THREE.Group) {}

  update(session: XRSession | undefined, camera: THREE.Camera, dt: number): void {
    if (!session) return;

    let left: XRInputSource | undefined;
    let right: XRInputSource | undefined;
    for (const src of session.inputSources) {
      if (src.handedness === 'left') left = src;
      else if (src.handedness === 'right') right = src;
    }

    this.updateMove(left, right, camera, dt);
    this.updateSnapTurn(right, camera);
  }

  private updateMove(
    left: XRInputSource | undefined,
    right: XRInputSource | undefined,
    camera: THREE.Camera,
    dt: number,
  ): void {
    const pad = left?.gamepad;
    if (!pad) return;
    const x = deadzone(pad.axes[AXIS_X] ?? 0);
    const y = deadzone(pad.axes[AXIS_Y] ?? 0);
    if (x === 0 && y === 0) return;

    let speed = this.moveSpeed;
    if (pressed(left, BUTTON_TRIGGER)) speed *= 3;
    if (pressed(right, BUTTON_TRIGGER)) speed *= 0.3;

    // 頭の向いている方位 (水平成分) を基準にする
    const forward = new THREE.Vector3();
    camera.getWorldDirection(forward);
    forward.y = 0;
    if (forward.lengthSq() < 1e-8) return;
    forward.normalize();
    const rightDir = new THREE.Vector3().crossVectors(forward, new THREE.Vector3(0, 1, 0)).normalize();

    // スティック Y は前方向が負
    this.rig.position.addScaledVector(forward, -y * speed * dt);
    this.rig.position.addScaledVector(rightDir, x * speed * dt);
  }

  private updateSnapTurn(right: XRInputSource | undefined, camera: THREE.Camera): void {
    const pad = right?.gamepad;
    if (!pad) {
      this.snapLatched = false;
      return;
    }
    const x = pad.axes[AXIS_X] ?? 0;

    if (!this.snapLatched && Math.abs(x) >= VR_SNAP_ON_THRESHOLD) {
      this.snapLatched = true;
      this.rotateAroundHead(camera, THREE.MathUtils.degToRad(VR_SNAP_ANGLE_DEG) * -Math.sign(x));
    } else if (this.snapLatched && Math.abs(x) <= VR_SNAP_OFF_THRESHOLD) {
      this.snapLatched = false;
    }
  }

  /**
   * 頭の位置を中心に rig を回す。単に rig.rotation.y を足すと、頭が rig 原点から
   * 離れているときに体が振り回されてしまう。
   */
  private rotateAroundHead(camera: THREE.Camera, angle: number): void {
    const head = new THREE.Vector3();
    camera.getWorldPosition(head);
    const pivot = new THREE.Vector3(head.x, this.rig.position.y, head.z);

    const offset = this.rig.position.clone().sub(pivot);
    offset.applyAxisAngle(new THREE.Vector3(0, 1, 0), angle);
    this.rig.position.copy(pivot).add(offset);
    this.rig.rotation.y += angle;
  }

  reset(): void {
    this.rig.position.set(0, 0, 0);
    this.rig.rotation.set(0, 0, 0);
    this.snapLatched = false;
  }
}

export function pressed(src: XRInputSource | undefined, button: number): boolean {
  return src?.gamepad?.buttons[button]?.pressed ?? false;
}
