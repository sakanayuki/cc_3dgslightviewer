import { ExtSplats } from '@sparkjsdev/spark';
import { SPLAT_TEX_WIDTH } from '../config';

/** extArrays の各配列の 1 splat あたりのワード数 */
export const EXT_WORDS_PER_SPLAT = 4;

/**
 * SH の段ごとの配列名。ExtSplats は次数 3 を sh3a / sh3b の 2 枚に分けて持つ
 * (PackedSplats の sh3 一枚とは構成が違う)。どの配列も 4 ワード/splat。
 */
export const SH_ARRAYS: Record<1 | 2 | 3, readonly string[]> = {
  1: ['sh1'],
  2: ['sh2'],
  3: ['sh3a', 'sh3b'],
};
export const SH_WORDS_PER_SPLAT = 4;

/** Spark はテクスチャ幅の倍数でしか容量を認識しないため切り上げる */
export function alignCapacity(n: number): number {
  return Math.max(SPLAT_TEX_WIDTH, Math.ceil(n / SPLAT_TEX_WIDTH) * SPLAT_TEX_WIDTH);
}

function copyWords(
  src: Uint32Array,
  dst: Uint32Array,
  keep: Uint32Array,
  words: number,
): void {
  for (let d = 0; d < keep.length; d++) {
    const s = keep[d]! * words;
    const t = d * words;
    for (let w = 0; w < words; w++) dst[t + w] = src[s + w]!;
  }
}

/**
 * 指定インデックスの splat だけを抜き出した ExtSplats を作る。
 *
 * Spark 標準の extractSplats() は SH を落とすため使えない。ここでは extArrays と
 * SH 配列を「固定ワード数のまとまり」として不透明なままコピーする。量子化の
 * ビット配置を一切解釈しないので、可逆かつ Spark の内部表現の変更に強い。
 *
 * @param src   コピー元
 * @param keep  昇順のソース側インデックス
 * @param maxSh このサブセットで保持する SH の最大次数
 */
export function buildSubset(
  src: ExtSplats,
  keep: Uint32Array,
  maxSh: 0 | 1 | 2 | 3,
): ExtSplats {
  const n = keep.length;
  const [srcA, srcB] = src.extArrays;
  if (!srcA || !srcB) throw new Error('buildSubset: source extArrays is empty');

  const capacity = alignCapacity(n);
  const dstA = new Uint32Array(capacity * EXT_WORDS_PER_SPLAT);
  const dstB = new Uint32Array(capacity * EXT_WORDS_PER_SPLAT);
  copyWords(srcA, dstA, keep, EXT_WORDS_PER_SPLAT);
  copyWords(srcB, dstB, keep, EXT_WORDS_PER_SPLAT);

  const extra: Record<string, Uint32Array> = {};
  for (let level = 1; level <= maxSh; level++) {
    for (const key of SH_ARRAYS[level as 1 | 2 | 3]) {
      const srcSh = (src.extra as Record<string, unknown>)[key];
      if (!(srcSh instanceof Uint32Array)) continue;
      const dstSh = new Uint32Array(capacity * SH_WORDS_PER_SPLAT);
      copyWords(srcSh, dstSh, keep, SH_WORDS_PER_SPLAT);
      extra[key] = dstSh;
    }
  }

  const dst = new ExtSplats({ extArrays: [dstA, dstB], numSplats: n, extra });

  // 切り上げを誤ると numSplats が 0 に丸められる。Spark 側の定数が変わった場合に
  // 黙って壊れないよう実行時に検出する。
  if (dst.numSplats !== n) {
    throw new Error(
      `buildSubset: numSplats mismatch (expected ${n}, got ${dst.numSplats}). ` +
        `SPLAT_TEX_WIDTH=${SPLAT_TEX_WIDTH} が Spark の実装と一致していない可能性があります。`,
    );
  }

  dst.setMaxSh(maxSh);
  return dst;
}

/**
 * 元データが持つ SH 次数を調べる。
 * SOG/RAD 由来のコードブック方式 (sh*Codes) は本アプリのコピー方式では扱えないため
 * 0 を返してフォールバックさせる。
 */
export function detectSourceMaxSh(src: ExtSplats): 0 | 1 | 2 | 3 {
  const extra = src.extra as Record<string, unknown>;
  for (const key of ['sh1Codes', 'sh2Codes', 'sh3Codes']) {
    if (extra[key]) {
      console.warn(
        `[subset] コードブック方式の SH (${key}) を検出しました。SH なしで描画します。`,
      );
      return 0;
    }
  }
  if (extra['sh3a'] instanceof Uint32Array && extra['sh3b'] instanceof Uint32Array) return 3;
  if (extra['sh2'] instanceof Uint32Array) return 2;
  if (extra['sh1'] instanceof Uint32Array) return 1;
  return 0;
}
