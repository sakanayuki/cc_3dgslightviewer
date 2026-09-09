import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { ExtSplats } from '@sparkjsdev/spark';
import {
  EXT_WORDS_PER_SPLAT,
  SH_ARRAYS,
  SH_WORDS_PER_SPLAT,
  alignCapacity,
  buildSubset,
  detectSourceMaxSh,
} from '../src/core/subset';
import { SPLAT_TEX_WIDTH } from '../src/config';

function makeSource(n: number): ExtSplats {
  const src = new ExtSplats();
  for (let i = 0; i < n; i++) {
    src.pushSplat(
      // 実データに近い「広がりに対して非常に小さい splat」を再現する
      new THREE.Vector3(i * 1e-5 - 0.5, -i * 2e-5 + 0.5, i * 3e-6),
      new THREE.Vector3(0.0008 + i * 1e-9, 0.0009, 0.0003),
      new THREE.Quaternion(0, 0, 0, 1),
      0.2 + (i % 10) * 0.07,
      new THREE.Color((i % 100) / 100, 0.5, 0.25),
    );
  }
  return src;
}

/** SH 配列を捏造して付ける。値の中身は問わず、コピーの正しさだけを見る */
function attachFakeSh(src: ExtSplats, level: 1 | 2 | 3): Record<string, Uint32Array> {
  const capacity = src.extArrays[0].length / EXT_WORDS_PER_SPLAT;
  const made: Record<string, Uint32Array> = {};
  for (const key of SH_ARRAYS[level]) {
    const arr = new Uint32Array(capacity * SH_WORDS_PER_SPLAT);
    for (let i = 0; i < arr.length; i++) arr[i] = (i * 2654435761 + key.length) >>> 0;
    (src.extra as Record<string, unknown>)[key] = arr;
    made[key] = arr;
  }
  return made;
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
      const expected = {
        x: a.center.x, y: a.center.y, z: a.center.z,
        opacity: a.opacity, r: a.color.r, sx: a.scales.x,
      };
      const b = dst.getSplat(d);
      expect(b.center.x).toBe(expected.x);
      expect(b.center.y).toBe(expected.y);
      expect(b.center.z).toBe(expected.z);
      expect(b.opacity).toBe(expected.opacity);
      expect(b.color.r).toBe(expected.r);
      expect(b.scales.x).toBe(expected.sx);
    }
  });

  it('位置が float32 のまま保たれる (float16 に落ちない)', () => {
    // これが今回の不具合の核心。16 バイト形式では位置が float16 に量子化され、
    // 広がりに対して splat が小さいデータで斑点状の抜けが出る。
    const src = new ExtSplats();
    const truth = [-0.4993896484375123, 0.2500152587890625, -0.1234567165374756];
    src.pushSplat(
      new THREE.Vector3(truth[0]!, truth[1]!, truth[2]!),
      new THREE.Vector3(0.0008, 0.0008, 0.0003),
      new THREE.Quaternion(0, 0, 0, 1),
      0.9,
      new THREE.Color(0.5, 0.5, 0.5),
    );
    const dst = buildSubset(src, Uint32Array.from([0]), 0);
    const got = dst.getSplat(0);
    // float32 での往復なので、Math.fround との一致まで要求できる
    expect(got.center.x).toBe(Math.fround(truth[0]!));
    expect(got.center.y).toBe(Math.fround(truth[1]!));
    expect(got.center.z).toBe(Math.fround(truth[2]!));
  });

  it('extArrays の両方がワード単位でそのままコピーされる', () => {
    const src = makeSource(3000);
    const keep = Uint32Array.from([0, 1, 7, 999, 2999]);
    const dst = buildSubset(src, keep, 0);
    for (let arr = 0; arr < 2; arr++) {
      for (let d = 0; d < keep.length; d++) {
        for (let w = 0; w < EXT_WORDS_PER_SPLAT; w++) {
          expect(dst.extArrays[arr]![d * EXT_WORDS_PER_SPLAT + w]).toBe(
            src.extArrays[arr]![keep[d]! * EXT_WORDS_PER_SPLAT + w],
          );
        }
      }
    }
  });

  it('SH 各段が正しくコピーされる (次数3は sh3a / sh3b の2枚)', () => {
    const src = makeSource(4096);
    const all = {
      ...attachFakeSh(src, 1),
      ...attachFakeSh(src, 2),
      ...attachFakeSh(src, 3),
    };
    expect(Object.keys(all).sort()).toEqual(['sh1', 'sh2', 'sh3a', 'sh3b']);

    const keep = Uint32Array.from([3, 10, 500, 4095]);
    const dst = buildSubset(src, keep, 3);
    const extra = dst.extra as Record<string, Uint32Array>;

    for (const [key, srcArr] of Object.entries(all)) {
      const dstArr = extra[key]!;
      expect(dstArr, key).toBeInstanceOf(Uint32Array);
      for (let d = 0; d < keep.length; d++) {
        for (let w = 0; w < SH_WORDS_PER_SPLAT; w++) {
          expect(dstArr[d * SH_WORDS_PER_SPLAT + w], `${key}[${d}][${w}]`).toBe(
            srcArr[keep[d]! * SH_WORDS_PER_SPLAT + w],
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
    expect(extra['sh3a']).toBeUndefined();
    expect(extra['sh3b']).toBeUndefined();
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
    // Spark は extArrays の長さを SPLAT_TEX_WIDTH の倍数で切り下げて容量を
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

  it('sh3a / sh3b が揃っていなければ次数3とは判定しない', () => {
    const src = makeSource(2048);
    attachFakeSh(src, 2);
    attachFakeSh(src, 3);
    delete (src.extra as Record<string, unknown>)['sh3b'];
    expect(detectSourceMaxSh(src)).toBe(2);
  });

  it('コードブック方式の SH は 0 にフォールバックする', () => {
    const src = makeSource(2048);
    attachFakeSh(src, 3);
    (src.extra as Record<string, unknown>)['sh3Codes'] = new Uint32Array(4);
    expect(detectSourceMaxSh(src)).toBe(0);
  });
});
