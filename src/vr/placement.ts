import * as THREE from 'three';
import {
  DEFAULT_RIGHT,
  VR_MODEL_DISTANCE,
  VR_MODEL_HEIGHT,
  VR_TARGET_RADIUS,
} from '../config';
import type { SceneBounds } from '../types';

/** XR の基準空間 (local-floor) での上方向。物理的な上で、変更できない */
const XR_UP = new THREE.Vector3(0, 1, 0);
/** XR 基準空間での右方向。入場時にユーザーが向いている方向を基準とする */
const XR_RIGHT = new THREE.Vector3(1, 0, 0);

/**
 * モデルを XR 空間で正しい向きに置くための回転を求める。
 *
 * デスクトップでは camera.up にシーンの上方向を入れて「-Y が上」を実現しているが、
 * **VR ではカメラ姿勢がヘッドセットから与えられるため camera.up は無視される**。
 * XR 空間の上は常に物理的な +Y なので、向きを合わせるにはモデル側 (worldRoot) を
 * 回すしかない。
 *
 * モデルの上方向を XR の上 (+Y) へ、モデルの DEFAULT_RIGHT を XR の右 (+X) へ
 * 移す回転を返す。DEFAULT_UP = (0,-1,0) の場合は X 軸まわりの 180 度回転になる。
 */
export function computeVrOrientation(up: THREE.Vector3): THREE.Quaternion {
  const u = up.clone().normalize();

  // モデル側の右方向。up と平行なら別の軸に退避する
  let r = DEFAULT_RIGHT.clone();
  if (Math.abs(r.dot(u)) > 0.99) r = new THREE.Vector3(0, 0, 1);
  r.addScaledVector(u, -r.dot(u)).normalize();

  // 右手系になるよう第3軸を作る (cross(x, y) = z)
  const f = new THREE.Vector3().crossVectors(r, u).normalize();

  // basis は (1,0,0)->r, (0,1,0)->u, (0,0,1)->f を与える回転。
  // 欲しいのはその逆 (r->XR右, u->XR上) なので転置する。
  const basis = new THREE.Matrix4().makeBasis(r, u, f);
  const inverse = basis.clone().transpose();
  return new THREE.Quaternion().setFromRotationMatrix(inverse);
}

export interface VrPlacement {
  quaternion: THREE.Quaternion;
  scale: number;
  position: THREE.Vector3;
}

/**
 * VR 入場時に worldRoot へ適用する配置を求める。
 *
 * three.js の Object3D は matrix = T * R * S の順で合成されるため、
 * 点 x は position + quaternion * (scale * x) に移る。モデル中心が
 * 目の前の既定位置に来るよう position を逆算する。
 */
export function computeVrPlacement(bounds: SceneBounds): VrPlacement {
  const quaternion = computeVrOrientation(bounds.up);
  const scale = VR_TARGET_RADIUS / Math.max(1e-6, bounds.radius);
  const desiredCenter = new THREE.Vector3(0, VR_MODEL_HEIGHT, -VR_MODEL_DISTANCE);
  const movedCenter = bounds.center.clone().multiplyScalar(scale).applyQuaternion(quaternion);
  return { quaternion, scale, position: desiredCenter.sub(movedCenter) };
}

export { XR_UP, XR_RIGHT };
