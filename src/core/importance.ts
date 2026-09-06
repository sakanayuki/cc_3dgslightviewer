import type * as THREE from 'three';
import type { PackedSplats } from '@sparkjsdev/spark';
import {
  IMPORTANCE_AREA_EXPONENT,
  IMPORTANCE_HISTOGRAM_BINS,
  LEVELS,
} from '../config';
import type { Ranking } from '../types';

/**
 * splat の重要度スコア。
 *   score = opacity * (sx * sy * sz)^(2/3)
 * (体積)^(2/3) は投影断面積に比例するため、「画面上でどれだけの面積を占めるか
 * × どれだけ濃いか」の近似になる。小さく薄い splat から先に削られる。
 *
 * 不正値 (NaN / 負 / 0) は 0 を返し、必ず最も削られる側に置く。
 */
export function computeScore(opacity: number, sx: number, sy: number, sz: number): number {
  if (!(opacity > 0) || !(sx > 0) || !(sy > 0) || !(sz > 0)) return 0;
  const volume = sx * sy * sz;
  if (!Number.isFinite(volume)) return 0;
  const score = opacity * Math.pow(volume, IMPORTANCE_AREA_EXPONENT);
  return Number.isFinite(score) && score > 0 ? score : 0;
}

/**
 * スコア配列からレベル割り当てを作る (設計書 6.2)。
 *
 * 300万件の全ソートは 1〜2 秒かかるため、log10(score) のヒストグラムで閾値を
 * 決める O(N) 手法を使う。境界ビン内はインデックス昇順で必要数だけ採る。
 * これは近似ではなく、各レベルの件数は指定値と厳密に一致する。
 *
 * スコア 0 (不正値含む) の splat は最上位レベル (オリジナル) でのみ採用する。
 */
export function buildRankingFromScores(scores: Float32Array): Ranking {
  const n = scores.length;
  const levelOf = new Uint8Array(n);
  const topLevel = LEVELS.length - 1;
  levelOf.fill(topLevel);

  if (n === 0) {
    return { levelOf, numSplats: 0, counts: LEVELS.map(() => 0) };
  }

  // 有効スコアの log10 レンジを求める
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  let valid = 0;
  for (let i = 0; i < n; i++) {
    const s = scores[i]!;
    if (s > 0) {
      const l = Math.log10(s);
      if (l < lo) lo = l;
      if (l > hi) hi = l;
      valid++;
    }
  }

  const counts = LEVELS.map((lv) => Math.min(n, Math.round(n * lv.ratio)));
  // 最上位は必ず全件
  counts[topLevel] = n;

  if (valid === 0) {
    // 全て不正値。オリジナル以外は空になる
    for (let i = 0; i < topLevel; i++) counts[i] = 0;
    return { levelOf, numSplats: n, counts };
  }

  const bins = IMPORTANCE_HISTOGRAM_BINS;
  const span = hi - lo;
  // 全て同一スコアのときは 1 ビンに落とす
  const scale = span > 0 ? (bins - 1) / span : 0;
  const binOf = (s: number): number => {
    if (!(s > 0)) return -1;
    return Math.min(bins - 1, Math.max(0, Math.round((Math.log10(s) - lo) * scale)));
  };

  const hist = new Uint32Array(bins);
  for (let i = 0; i < n; i++) {
    const b = binOf(scores[i]!);
    if (b >= 0) hist[b]!++;
  }

  // 各レベルについて、上位ビンから累積して境界ビンと残り件数を決める
  // boundaryBin[L] より上のビンは無条件採用、boundaryBin[L] は remaining[L] 件だけ採用
  const boundaryBin = new Int32Array(LEVELS.length).fill(-1);
  const remaining = new Int32Array(LEVELS.length);
  for (let L = 0; L < topLevel; L++) {
    const target = Math.min(counts[L]!, valid);
    let acc = 0;
    let b = bins - 1;
    for (; b >= 0; b--) {
      const c = hist[b]!;
      if (acc + c >= target) break;
      acc += c;
    }
    if (b < 0) {
      // target が valid を超えることは無いのでここには来ないが、安全側に倒す
      boundaryBin[L] = 0;
      remaining[L] = 0;
    } else {
      boundaryBin[L] = b;
      remaining[L] = target - acc;
    }
    counts[L] = target;
  }

  // levelOf を確定する。レベルは入れ子なので、採用される最小のレベルを入れる。
  //
  // 境界ビンの枠は「そのレベル以上のすべて」で消費される点に注意。レベル L で
  // 採用された splat は入れ子性より L+1 以降にも必ず含まれるため、上位レベルの
  // 境界ビン枠も同時に減らさないと件数が二重計上される。
  const left = Int32Array.from(remaining);
  for (let i = 0; i < n; i++) {
    const b = binOf(scores[i]!);
    if (b < 0) continue; // 不正値は topLevel のまま
    for (let L = 0; L < topLevel; L++) {
      const bb = boundaryBin[L]!;
      let included = false;
      if (b > bb) {
        included = true;
      } else if (b === bb && left[L]! > 0) {
        left[L]!--;
        included = true;
      }
      if (!included) continue;

      levelOf[i] = L;
      // boundaryBin は L について非増加なので、上位レベルでは b >= boundaryBin[L2]。
      // b === boundaryBin[L2] のときだけ枠を消費する (b > なら無条件採用)。
      for (let L2 = L + 1; L2 < topLevel; L2++) {
        if (b === boundaryBin[L2]! && left[L2]! > 0) left[L2]!--;
      }
      break;
    }
  }

  return { levelOf, numSplats: n, counts };
}

/**
 * PackedSplats を走査してスコアを計算する。
 * forEachSplat が渡すオブジェクトは使い回されるため、保持せず即座に数値を読む。
 */
export function computeScores(splats: PackedSplats): Float32Array {
  const n = splats.numSplats;
  const scores = new Float32Array(n);
  splats.forEachSplat(
    (
      index: number,
      _center: THREE.Vector3,
      scales: THREE.Vector3,
      _quaternion: THREE.Quaternion,
      opacity: number,
    ) => {
      if (index < n) {
        scores[index] = computeScore(opacity, scales.x, scales.y, scales.z);
      }
    },
  );
  return scores;
}

export function buildRanking(splats: PackedSplats): Ranking {
  return buildRankingFromScores(computeScores(splats));
}
