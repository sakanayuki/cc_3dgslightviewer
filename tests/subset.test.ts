import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { PackedSplats } from '@sparkjsdev/spark';
import {
  PACKED_WORDS_PER_SPLAT,
  SH_WORDS_PER_SPLAT,
  alignCapacity,
  buildSubset,
  detectSourceMaxSh,
} from '../src/core/subset';
import { SPLAT_TEX_WIDTH } from '../src/config';

function makeSource(n: number): PackedSplats {
  const src = new PackedSplats();
  for (let i = 0; i < n; i++) {
    src.pushSplat(
      new THREE.Vector3(i, i * 2, i * 3),
      new THREE.Vector3(0.1 + i * 0.0001, 0.2, 0.3),
      new THREE.Quaternion(0, 0, 0, 1),
      0.2 + (i % 10) * 0.07,
      new THREE.Color((i % 100) / 100, 0.5, 0.25),
    );
  }
  return src;
}

/** SH 配列を捏造して付ける。値の中身は問わず、コピーの正しさだけを見る */
function attachFakeSh(src: PackedSplats, level: 1 | 2 | 3): Uint32Array {
  const words = SH_WORDS_PER_SPLAT[level];
  const capacity = src.packedArray!.length / PACKED_WORDS_PER_SPLAT;
  const arr = new Uint32Array(capacity * words);
  for (let i = 0; i < arr.length; i++) arr[i] = (i * 2654435761) >>> 0;
  (src.extra as Record<string, unknown>)[`sh${level}`] = arr;
  return arr;
}

describe('alignCapacity', () => {
  it('SPLAT_TEX_WIDTH の倍数に切り上げる', () => {
    expect(alignCapacity(1)).toBe(SPLAT_TEX_WIDTH);
    expect(alignCapacity(SPLAT_TEX_WIDTH)).toBe(SPLAT_TEX_WIDTH);
    expect(alignCapacity(SPLAT_TEX_WIDTH + 1)).toBe(SPLAT_TEX_WIDTH * 2);
    expect(alignCapacity(0)).toBe(SPLAT_TEX_WIDTH);
  });
});

describe('buildSubset', () => {
  it('選択した splat の内容が可逆にコピーされる', () => {
    const n = 5000;
    const src = makeSource(n);
    const keep = new Uint32Array(Math.floor(n / 2));
    for (let i = 0; i < keep.length; i++) keep[i] = i * 2;

    const dst = buildSubset(src, keep, 0);
    expect(dst.numSplats).toBe(keep.length);

    for (let d = 0; d < keep.length; d++) {
      const a = src.getSplat(keep[d]!);
      const b = dst.getSplat(d);
      expect(b.center.x).toBe(a.center.x);
      expect(b.center.y).toBe(a.center.y);
      expect(b.center.z).toBe(a.center.z);
      expect(b.opacity).toBe(a.opacity);
      expect(b.color.r).toBe(a.color.r);
      expect(b.scales.x).toBe(a.scales.x);
    }
  });

  it('packedArray がワード単位でそのままコピーされる', () => {
    const src = makeSource(3000);
    const keep = Uint32Array.from([0, 1, 7, 999, 2999]);
    const dst = buildSubset(src, keep, 0);
    for (let d = 0; d < keep.length; d++) {
      for (let w = 0; w < PACKED_WORDS_PER_SPLAT; w++) {
        expect(dst.packedArray![d * PACKED_WORDS_PER_SPLAT + w]).toBe(
          src.packedArray![keep[d]! * PACKED_WORDS_PER_SPLAT + w],
        );
      }
    }
  });

  it('SH 各段が正しいワード数でコピーされる', () => {
    const src = makeSource(4096);
    const sh1 = attachFakeSh(src, 1);
    const sh2 = attachFakeSh(src, 2);
    const sh3 = attachFakeSh(src, 3);
    const keep = Uint32Array.from([3, 10, 500, 4095]);

    const dst = buildSubset(src, keep, 3);
    const extra = dst.extra as Record<string, Uint32Array>;

    for (const [level, srcArr] of [
      [1, sh1],
      [2, sh2],
      [3, sh3],
    ] as const) {
      const words = SH_WORDS_PER_SPLAT[level];
      const dstArr = extra[`sh${level}`]!;
      expect(dstArr).toBeInstanceOf(Uint32Array);
      for (let d = 0; d < keep.length; d++) {
        for (let w = 0; w < words; w++) {
          expect(dstArr[d * words + w], `sh${level}[${d}][${w}]`).toBe(
            srcArr[keep[d]! * words + w],
          );
        }
      }
    }
  });

  it('maxSh より上の SH はコピーしない', () => {
    const src = makeSource(4096);
    attachFakeSh(src, 1);
    attachFakeSh(src, 2);
    attachFakeSh(src, 3);
    const dst = buildSubset(src, Uint32Array.from([0, 1, 2]), 1);
    const extra = dst.extra as Record<string, unknown>;
    expect(extra['sh1']).toBeInstanceOf(Uint32Array);
    expect(extra['sh2']).toBeUndefined();
    expect(extra['sh3']).toBeUndefined();
    expect(dst.maxSh).toBe(1);
  });

  it('全件選択でも動く', () => {
    const n = 2048;
    const src = makeSource(n);
    const keep = new Uint32Array(n);
    for (let i = 0; i < n; i++) keep[i] = i;
    expect(buildSubset(src, keep, 0).numSplats).toBe(n);
  });

  it('SPLAT_TEX_WIDTH 未満の少数でも numSplats が 0 に丸められない', () => {
    // Spark は packedArray.length を SPLAT_TEX_WIDTH の倍数で切り下げて容量を
    // 決めるため、切り上げを忘れると numSplats が 0 になる。
    const src = makeSource(100);
    const dst = buildSubset(src, Uint32Array.from([0, 5, 9]), 0);
    expect(dst.numSplats).toBe(3);
  });
});

describe('detectSourceMaxSh', () => {
  it('存在する最大の SH 段を返す', () => {
    const src = makeSource(2048);
    expect(detectSourceMaxSh(src)).toBe(0);
    attachFakeSh(src, 1);
    expect(detectSourceMaxSh(src)).toBe(1);
    attachFakeSh(src, 2);
    expect(detectSourceMaxSh(src)).toBe(2);
    attachFakeSh(src, 3);
    expect(detectSourceMaxSh(src)).toBe(3);
  });

  it('コードブック方式の SH は 0 にフォールバックする', () => {
    const src = makeSource(2048);
    attachFakeSh(src, 3);
    (src.extra as Record<string, unknown>)['sh3Codes'] = new Uint32Array(4);
    expect(detectSourceMaxSh(src)).toBe(0);
  });
});
