import * as THREE from 'three';

/** SH 係数の個数 (次数2 = 9係数 × RGB) */
export const SH_COEFF_COUNT = 9;

/**
 * 球面調和関数の放射輝度係数から、ランバート面の放射照度を求める係数
 * (Ramamoorthi & Hanrahan 2001)。
 */
const C1 = 0.429043;
const C2 = 0.511664;
const C3 = 0.743125;
const C4 = 0.886227;
const C5 = 0.247708;

/** WebXR / three.js の SH 係数の並び: 0=L00, 1=L1-1, 2=L10, 3=L11, 4=L2-2, 5=L2-1, 6=L20, 7=L21, 8=L22 */
const L00 = 0, L1M1 = 1, L10 = 2, L11 = 3, L2M2 = 4, L2M1 = 5, L20 = 6, L21 = 7, L22 = 8;

/** 放射照度が一定 (真っ白な環境) になる SH。効果を無効化したいときの中立値 */
export function neutralSh(): Float32Array {
  const sh = new Float32Array(SH_COEFF_COUNT * 3);
  // 放射照度が 1.0 になるよう DC 項を置く
  const dc = 1 / C4;
  sh[0] = dc;
  sh[1] = dc;
  sh[2] = dc;
  return sh;
}

/**
 * SH 係数を「放射照度行列」に畳む。
 *
 * 放射照度は法線 n の 2 次形式で書けるので、チャンネルごとに 4x4 行列 1 枚に
 * まとめられる。シェーダ側は E = dot(n4, M * n4) （n4 = vec4(n, 1)）の
 * 一行で評価できる。
 *
 * @param sh     27 要素 (9 係数 × RGB)
 * @param target 書き込み先 [R, G, B]
 */
export function shToIrradianceMatrices(
  sh: Float32Array | number[],
  target: [THREE.Matrix4, THREE.Matrix4, THREE.Matrix4] = [
    new THREE.Matrix4(),
    new THREE.Matrix4(),
    new THREE.Matrix4(),
  ],
): [THREE.Matrix4, THREE.Matrix4, THREE.Matrix4] {
  for (let ch = 0; ch < 3; ch++) {
    const c = (i: number): number => sh[i * 3 + ch] ?? 0;
    // Matrix4.set は行優先で受け取る。放射照度行列は対称なので転置を気にしなくてよい。
    target[ch]!.set(
      C1 * c(L22), C1 * c(L2M2), C1 * c(L21), C2 * c(L11),
      C1 * c(L2M2), -C1 * c(L22), C1 * c(L2M1), C2 * c(L1M1),
      C1 * c(L21), C1 * c(L2M1), C3 * c(L20), C2 * c(L10),
      C2 * c(L11), C2 * c(L1M1), C2 * c(L10), C4 * c(L00) - C5 * c(L20),
    );
  }
  return target;
}

/** 全方向を平均した放射照度 (= DC 項のみの寄与)。白色点と明るさの基準になる */
export function ambientIrradiance(
  sh: Float32Array | number[],
  target = new THREE.Vector3(),
): THREE.Vector3 {
  return target.set(C4 * (sh[0] ?? 0), C4 * (sh[1] ?? 0), C4 * (sh[2] ?? 0));
}

/** Rec.709 の輝度 */
export function luminance(c: THREE.Vector3): number {
  return 0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z;
}

/**
 * 法線方向 n での放射照度を CPU 側で評価する (テストと表示用)。
 * シェーダ側と同じ式であることをテストで突き合わせる。
 */
export function evaluateIrradiance(
  matrices: readonly [THREE.Matrix4, THREE.Matrix4, THREE.Matrix4],
  normal: THREE.Vector3,
  target = new THREE.Vector3(),
): THREE.Vector3 {
  const n = new THREE.Vector4(normal.x, normal.y, normal.z, 1);
  const out = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    const m = matrices[ch]!.elements; // column-major
    // Mn を求めてから n との内積を取る
    let acc = 0;
    for (let row = 0; row < 4; row++) {
      let mv = 0;
      for (let col = 0; col < 4; col++) mv += m[col * 4 + row]! * n.getComponent(col);
      acc += n.getComponent(row) * mv;
    }
    out[ch] = acc;
  }
  return target.set(out[0]!, out[1]!, out[2]!);
}

/** SH 係数を指数移動平均で滑らかにする。推定はフレームごとに揺れるため必須 */
export function smoothSh(
  current: Float32Array,
  next: Float32Array | number[],
  alpha: number,
): void {
  const a = Math.max(0, Math.min(1, alpha));
  for (let i = 0; i < current.length; i++) {
    current[i] = current[i]! * (1 - a) + (next[i] ?? 0) * a;
  }
}

/**
 * 環境の明るさから露出倍率を求める。
 *
 * ARCore が返す SH の絶対スケールは端末依存で仕様上保証がないため、
 * 「入場時に観測した明るさ」を基準にした**相対値**として扱う。こうすると
 * 絶対校正なしでも「明るい場所から暗い場所へ移ると暗くなる」という
 * 妥当な振る舞いになり、起動時に大外しすることがない。
 *
 * さらに gamma で圧縮し上下にクランプして、元データの見た目を壊さないようにする。
 */
export function exposureFromAmbient(
  ambientLuminance: number,
  referenceLuminance: number,
  gamma: number,
  min: number,
  max: number,
): number {
  if (!(ambientLuminance > 0) || !(referenceLuminance > 0)) return 1;
  const ratio = ambientLuminance / referenceLuminance;
  const compressed = Math.pow(ratio, gamma);
  if (!Number.isFinite(compressed)) return 1;
  return Math.max(min, Math.min(max, compressed));
}
