import { PackedSplats } from '@sparkjsdev/spark';
import { SPLAT_TEX_WIDTH } from '../config';

/** SH 各段の 1 splat あたりのワード数 (Spark の ensureSplatsSh と一致させること) */
export const SH_WORDS_PER_SPLAT: Record<1 | 2 | 3, number> = { 1: 2, 2: 4, 3: 4 };

/** packedArray の 1 splat あたりのワード数 */
export const PACKED_WORDS_PER_SPLAT = 4;

/** Spark はテクスチャ幅の倍数でしか容量を認識しないため切り上げる */
export function alignCapacity(n: number): number {
  return Math.max(SPLAT_TEX_WIDTH, Math.ceil(n / SPLAT_TEX_WIDTH) * SPLAT_TEX_WIDTH);
}

/**
 * 指定インデックスの splat だけを抜き出した PackedSplats を作る。
 *
 * Spark 標準の PackedSplats.extractSplats() は内部で getSplat()/pushSplat() の
 * 往復をしており SH を落とすため使えない。ここでは packedArray と sh1/sh2/sh3 を
 * 「固定ワード数のまとまり」として不透明なままコピーする。量子化のビット配置を
 * 一切解釈しないので、可逆かつ Spark の量子化方式の変更に影響されない。
 *
 * @param src   コピー元
 * @param keep  昇順のソース側インデックス
 * @param maxSh このサブセットで保持する SH の最大次数
 */
export function buildSubset(
  src: PackedSplats,
  keep: Uint32Array,
  maxSh: 0 | 1 | 2 | 3,
): PackedSplats {
  const n = keep.length;
  const srcPacked = src.packedArray;
  if (!srcPacked) throw new Error('buildSubset: source packedArray is null');

  const capacity = alignCapacity(n);
  const packedArray = new Uint32Array(capacity * PACKED_WORDS_PER_SPLAT);
  for (let d = 0; d < n; d++) {
    const s = keep[d]! * PACKED_WORDS_PER_SPLAT;
    const t = d * PACKED_WORDS_PER_SPLAT;
    packedArray[t] = srcPacked[s]!;
    packedArray[t + 1] = srcPacked[s + 1]!;
    packedArray[t + 2] = srcPacked[s + 2]!;
    packedArray[t + 3] = srcPacked[s + 3]!;
  }

  const extra: Record<string, Uint32Array> = {};
  for (let level = 1; level <= maxSh; level++) {
    const key = `sh${level}`;
    const srcSh = (src.extra as Record<string, unknown>)[key];
    if (!(srcSh instanceof Uint32Array)) continue;
    const words = SH_WORDS_PER_SPLAT[level as 1 | 2 | 3];
    const dstSh = new Uint32Array(capacity * words);
    for (let d = 0; d < n; d++) {
      const s = keep[d]! * words;
      const t = d * words;
      for (let w = 0; w < words; w++) dstSh[t + w] = srcSh[s + w]!;
    }
    extra[key] = dstSh;
  }

  const dst = new PackedSplats({
    packedArray,
    numSplats: n,
    ...(src.splatEncoding ? { splatEncoding: src.splatEncoding } : {}),
    extra,
  });

  // 切り上げを誤ると numSplats が 0 に丸められる。Spark 側の定数が変わった場合に
  // 黙って壊れないよう実行時に検出する。
  if (dst.numSplats !== n) {
    throw new Error(
      `buildSubset: numSplats mismatch (expected ${n}, got ${dst.numSplats}). ` +
        `SPLAT_TEX_WIDTH=${SPLAT_TEX_WIDTH} が Spark の実装と一致していない可能性があります。`,
    );
  }

  dst.setMaxSh(maxSh);
  dst.needsUpdate = true;
  return dst;
}

/**
 * 元データが持つ SH 次数を調べる。
 * SOG/RAD 由来のコードブック方式 (sh*Codes) は本アプリのコピー方式では扱えないため
 * 0 を返してフォールバックさせる。
 */
export function detectSourceMaxSh(src: PackedSplats): 0 | 1 | 2 | 3 {
  const extra = src.extra as Record<string, unknown>;
  for (const key of ['sh1Codes', 'sh2Codes', 'sh3Codes']) {
    if (extra[key]) {
      console.warn(
        `[subset] コードブック方式の SH (${key}) を検出しました。SH なしで描画します。`,
      );
      return 0;
    }
  }
  if (extra['sh3'] instanceof Uint32Array) return 3;
  if (extra['sh2'] instanceof Uint32Array) return 2;
  if (extra['sh1'] instanceof Uint32Array) return 1;
  return 0;
}
