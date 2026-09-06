import { LEVELS } from '../config';
import type { Ranking } from '../types';

/**
 * 指定レベルで採用する splat のインデックスを昇順で返す。
 * 昇順であることは subset.ts のメモリアクセス局所性の前提。
 */
export function selectIndices(ranking: Ranking, level: number): Uint32Array {
  const { levelOf, numSplats } = ranking;
  let count = 0;
  for (let i = 0; i < numSplats; i++) {
    if (levelOf[i]! <= level) count++;
  }
  const out = new Uint32Array(count);
  let w = 0;
  for (let i = 0; i < numSplats; i++) {
    if (levelOf[i]! <= level) out[w++] = i;
  }
  return out;
}

/** レベル定義を取得する。範囲外は最も近いものにクランプする */
export function getLevel(level: number): (typeof LEVELS)[number] {
  const clamped = Math.max(0, Math.min(LEVELS.length - 1, Math.trunc(level)));
  return LEVELS[clamped]!;
}

/** そのレベルで実際に使う SH 次数 (元ファイルの次数を超えない) */
export function effectiveMaxSh(level: number, sourceMaxSh: number): 0 | 1 | 2 | 3 {
  return Math.min(getLevel(level).maxSh, sourceMaxSh) as 0 | 1 | 2 | 3;
}
