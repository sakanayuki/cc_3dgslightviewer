import * as THREE from 'three';
import type { PackedSplats } from '@sparkjsdev/spark';
import {
  AUTOFIT_MARGIN,
  DEFAULT_ELEVATION_DEG,
  DEFAULT_RIGHT,
  AUTOFIT_PERCENTILE_HIGH,
  AUTOFIT_PERCENTILE_LOW,
  AUTOFIT_SAMPLE_COUNT,
  DEFAULT_UP,
  ENABLE_UP_ESTIMATION,
  UP_ESTIMATE_CONFIDENCE,
} from '../config';
import type { SceneBounds } from '../types';

/**
 * splat の中心座標を最大 AUTOFIT_SAMPLE_COUNT 件まで等間隔サンプリングする。
 * 返り値は [x0,y0,z0, x1,y1,z1, ...] のフラット配列。
 */
export function sampleCenters(splats: PackedSplats): Float32Array {
  const n = splats.numSplats;
  const step = Math.max(1, Math.ceil(n / AUTOFIT_SAMPLE_COUNT));
  const count = Math.ceil(n / step);
  const out = new Float32Array(count * 3);
  let w = 0;
  splats.forEachSplat((index: number, center: THREE.Vector3) => {
    if (index % step === 0 && w < count) {
      out[w * 3] = center.x;
      out[w * 3 + 1] = center.y;
      out[w * 3 + 2] = center.z;
      w++;
    }
  });
  return w === count ? out : out.subarray(0, w * 3);
}

function percentile(sorted: Float32Array, p: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[i]!;
}

/**
 * パーセンタイル境界ボックスを求める。
 * 3DGS には遠方の外れ値 splat が必ず混入するため、単純な min/max では破綻する。
 */
export function computeBounds(centers: Float32Array): SceneBounds {
  const count = Math.floor(centers.length / 3);
  const center = new THREE.Vector3();
  const up = DEFAULT_UP.clone();

  if (count === 0) {
    return { center, radius: 1, up, upEstimated: false };
  }

  const size = new THREE.Vector3();
  for (let axis = 0; axis < 3; axis++) {
    const col = new Float32Array(count);
    for (let i = 0; i < count; i++) col[i] = centers[i * 3 + axis]!;
    col.sort();
    const lo = percentile(col, AUTOFIT_PERCENTILE_LOW);
    const hi = percentile(col, AUTOFIT_PERCENTILE_HIGH);
    center.setComponent(axis, (lo + hi) / 2);
    size.setComponent(axis, hi - lo);
  }

  let radius = size.length() / 2;
  if (!Number.isFinite(radius) || radius <= 0) radius = 1;

  const estimated = ENABLE_UP_ESTIMATION ? estimateUp(centers, center) : null;
  if (estimated) up.copy(estimated);

  return { center, radius, up, upEstimated: estimated !== null };
}

/**
 * 主成分分析で鉛直軸を推定する。最も分散の小さい主成分を鉛直候補とする。
 *
 * 形状が等方的で平面性に乏しい場合 (第3/第2固有値比が大きい) は推定を信用せず
 * null を返す。向きは splat 密度が低い側を上とする (屋外スキャンでは空側が疎)。
 */
export function estimateUp(centers: Float32Array, center: THREE.Vector3): THREE.Vector3 | null {
  const count = Math.floor(centers.length / 3);
  if (count < 100) return null;

  // 共分散行列 (対称なので 6 要素)
  let xx = 0, yy = 0, zz = 0, xy = 0, xz = 0, yz = 0;
  for (let i = 0; i < count; i++) {
    const dx = centers[i * 3]! - center.x;
    const dy = centers[i * 3 + 1]! - center.y;
    const dz = centers[i * 3 + 2]! - center.z;
    xx += dx * dx; yy += dy * dy; zz += dz * dz;
    xy += dx * dy; xz += dx * dz; yz += dy * dz;
  }
  const m = new THREE.Matrix3().set(
    xx / count, xy / count, xz / count,
    xy / count, yy / count, yz / count,
    xz / count, yz / count, zz / count,
  );

  const eig = symmetricEigen(m);
  if (!eig) return null;

  const [e0, e1, e2] = eig.values; // 降順
  if (!(e1 > 0) || !Number.isFinite(e2 / e1)) return null;
  void e0;
  if (e2 / e1 >= UP_ESTIMATE_CONFIDENCE) return null; // 平面性が乏しい → 信用しない

  const axis = eig.vectors[2]!.clone().normalize(); // 最小固有値の軸
  if (axis.lengthSq() < 0.5) return null;

  // 密度が低い側を上とする: 軸方向への射影の中央値より上下で件数を比べる
  let above = 0;
  let below = 0;
  for (let i = 0; i < count; i++) {
    const dx = centers[i * 3]! - center.x;
    const dy = centers[i * 3 + 1]! - center.y;
    const dz = centers[i * 3 + 2]! - center.z;
    const t = dx * axis.x + dy * axis.y + dz * axis.z;
    if (t > 0) above++;
    else below++;
  }
  if (above > below) axis.negate();
  return axis;
}

interface Eigen {
  values: [number, number, number];
  vectors: [THREE.Vector3, THREE.Vector3, THREE.Vector3];
}

/**
 * 3x3 対称行列の固有値・固有ベクトルをヤコビ法で求める。固有値は降順。
 * three.js に対称行列用の分解がないため自前で持つ。
 */
export function symmetricEigen(mat: THREE.Matrix3): Eigen | null {
  const a = mat.elements.slice(); // column-major だが対称なので影響なし
  const m = [
    [a[0]!, a[1]!, a[2]!],
    [a[3]!, a[4]!, a[5]!],
    [a[6]!, a[7]!, a[8]!],
  ];
  for (const row of m) for (const v of row) if (!Number.isFinite(v)) return null;

  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];

  for (let sweep = 0; sweep < 32; sweep++) {
    let off = 0;
    for (let p = 0; p < 3; p++) {
      for (let q = p + 1; q < 3; q++) off += m[p]![q]! * m[p]![q]!;
    }
    if (off < 1e-20) break;

    for (let p = 0; p < 2; p++) {
      for (let q = p + 1; q < 3; q++) {
        const apq = m[p]![q]!;
        if (Math.abs(apq) < 1e-24) continue;
        const theta = (m[q]![q]! - m[p]![p]!) / (2 * apq);
        const t =
          Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < 3; k++) {
          const mkp = m[k]![p]!;
          const mkq = m[k]![q]!;
          m[k]![p] = c * mkp - s * mkq;
          m[k]![q] = s * mkp + c * mkq;
        }
        for (let k = 0; k < 3; k++) {
          const mpk = m[p]![k]!;
          const mqk = m[q]![k]!;
          m[p]![k] = c * mpk - s * mqk;
          m[q]![k] = s * mpk + c * mqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k]![p]!;
          const vkq = v[k]![q]!;
          v[k]![p] = c * vkp - s * vkq;
          v[k]![q] = s * vkp + c * vkq;
        }
      }
    }
  }

  const order = [0, 1, 2].sort((i, j) => m[j]![j]! - m[i]![i]!);
  const values = order.map((i) => m[i]![i]!) as [number, number, number];
  const vectors = order.map(
    (i) => new THREE.Vector3(v[0]![i]!, v[1]![i]!, v[2]![i]!),
  ) as [THREE.Vector3, THREE.Vector3, THREE.Vector3];
  return { values, vectors };
}

/**
 * up を保ったまま、DEFAULT_RIGHT が画面右を向くカメラ位置の方向を求める。
 *
 * lookAt の基底では、視線方向の逆ベクトル z (= カメラ位置 - 注視点) に対し
 * 画面右が x = normalize(cross(up, z)) になる。したがって
 *   w = normalize(cross(right, up))
 * とおくと cross(up, w) = right - up*(up・right) = right (right ⊥ up のとき) となり、
 * z = w が求める方向。さらに z を up 方向へ仰角ぶん傾けても、z は span{w, up} に
 * 留まるため cross(up, z) = cos(仰角) * right のまま向きは変わらない。
 * つまり見下ろす角度を付けても right は画面右を向き続ける。
 */
export function computeViewDirection(up: THREE.Vector3, elevationDeg: number): THREE.Vector3 {
  const u = up.clone().normalize();

  // right が up と平行だと外積が 0 になるので、別の基準軸に退避する
  let right = DEFAULT_RIGHT.clone();
  if (Math.abs(right.dot(u)) > 0.99) right = new THREE.Vector3(0, 0, 1);
  // right を up と直交させる
  right.addScaledVector(u, -right.dot(u)).normalize();

  const w = new THREE.Vector3().crossVectors(right, u).normalize();
  const theta = THREE.MathUtils.degToRad(elevationDeg);
  return w.multiplyScalar(Math.cos(theta)).addScaledVector(u, Math.sin(theta)).normalize();
}

/** バウンディングからカメラの初期位置・near/far を算出する */
export function computeInitialView(
  bounds: SceneBounds,
  fovDeg: number,
): { position: THREE.Vector3; target: THREE.Vector3; near: number; far: number } {
  const fov = THREE.MathUtils.degToRad(fovDeg);
  const distance = (bounds.radius / Math.sin(fov / 2)) * AUTOFIT_MARGIN;
  const dir = computeViewDirection(bounds.up, DEFAULT_ELEVATION_DEG);
  return {
    position: bounds.center.clone().addScaledVector(dir, distance),
    target: bounds.center.clone(),
    near: Math.max(1e-4, bounds.radius / 1000),
    far: bounds.radius * 100,
  };
}

/**
 * 指定方向からシーンを見るときの上方向を決める。
 *
 * 視線方向が up と平行になる (真上/真下から見る) と lookAt が退化するため、
 * その場合は DEFAULT_RIGHT が画面右を向く上方向へ退避する。
 */
export function resolveUpFor(direction: THREE.Vector3, preferred: THREE.Vector3): THREE.Vector3 {
  const d = direction.clone().normalize();
  const p = preferred.clone().normalize();
  if (Math.abs(d.dot(p)) < 0.99) return p;

  const fallback = new THREE.Vector3().crossVectors(d, DEFAULT_RIGHT);
  if (fallback.lengthSq() < 1e-8) fallback.crossVectors(d, new THREE.Vector3(0, 0, 1));
  return fallback.normalize();
}
