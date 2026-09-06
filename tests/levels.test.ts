import { describe, expect, it } from 'vitest';
import { effectiveMaxSh, getLevel, selectIndices } from '../src/core/levels';
import { LEVELS } from '../src/config';
import type { Ranking } from '../src/types';

function ranking(levelOf: number[]): Ranking {
  return {
    levelOf: Uint8Array.from(levelOf),
    numSplats: levelOf.length,
    counts: LEVELS.map(() => 0),
  };
}

describe('selectIndices', () => {
  it('levelOf <= level の splat を昇順で返す', () => {
    const r = ranking([2, 0, 4, 1, 0, 3]);
    expect(Array.from(selectIndices(r, 0))).toEqual([1, 4]);
    expect(Array.from(selectIndices(r, 1))).toEqual([1, 3, 4]);
    expect(Array.from(selectIndices(r, 2))).toEqual([0, 1, 3, 4]);
    expect(Array.from(selectIndices(r, 4))).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('必ず昇順になる (subset のメモリアクセス局所性の前提)', () => {
    const n = 1000;
    const levelOf = Array.from({ length: n }, (_, i) => i % LEVELS.length);
    const out = selectIndices(ranking(levelOf), 2);
    for (let i = 1; i < out.length; i++) expect(out[i]!).toBeGreaterThan(out[i - 1]!);
  });

  it('空入力を扱える', () => {
    expect(selectIndices(ranking([]), 4).length).toBe(0);
  });

  it('1 件だけの入力を扱える', () => {
    expect(Array.from(selectIndices(ranking([0]), 0))).toEqual([0]);
    expect(selectIndices(ranking([4]), 0).length).toBe(0);
  });
});

describe('getLevel', () => {
  it('範囲外はクランプする', () => {
    expect(getLevel(-5).id).toBe(0);
    expect(getLevel(99).id).toBe(LEVELS.length - 1);
    expect(getLevel(2).id).toBe(2);
  });
});

describe('effectiveMaxSh', () => {
  it('元ファイルの次数を超えない', () => {
    // レベル3(高) は maxSh=3 だが、元が次数1ならば 1 になる
    expect(effectiveMaxSh(3, 1)).toBe(1);
    expect(effectiveMaxSh(3, 3)).toBe(3);
    // レベル0(最低) は常に 0
    expect(effectiveMaxSh(0, 3)).toBe(0);
    // .splat のように SH を持たないファイルは全レベルで 0
    for (let l = 0; l < LEVELS.length; l++) expect(effectiveMaxSh(l, 0)).toBe(0);
  });
});
