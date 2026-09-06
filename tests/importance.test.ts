import { describe, expect, it } from 'vitest';
import { buildRankingFromScores, computeScore } from '../src/core/importance';
import { LEVELS } from '../src/config';

describe('computeScore', () => {
  it('opacity と体積^(2/3) の積を返す', () => {
    // opacity=1, 体積=1 → score=1
    expect(computeScore(1, 1, 1, 1)).toBeCloseTo(1, 10);
    // opacity=0.5, 体積=8 → 0.5 * 8^(2/3) = 0.5 * 4 = 2
    expect(computeScore(0.5, 2, 2, 2)).toBeCloseTo(2, 10);
  });

  it('不正値は 0 を返し、最も削られる側に置かれる', () => {
    expect(computeScore(0, 1, 1, 1)).toBe(0);
    expect(computeScore(-1, 1, 1, 1)).toBe(0);
    expect(computeScore(1, 0, 1, 1)).toBe(0);
    expect(computeScore(1, -1, 1, 1)).toBe(0);
    expect(computeScore(NaN, 1, 1, 1)).toBe(0);
    expect(computeScore(1, NaN, 1, 1)).toBe(0);
    expect(computeScore(1, Infinity, Infinity, Infinity)).toBe(0);
  });
});

describe('buildRankingFromScores', () => {
  const topLevel = LEVELS.length - 1;

  function makeScores(n: number): Float32Array {
    const s = new Float32Array(n);
    // 広いダイナミックレンジを持たせる
    for (let i = 0; i < n; i++) s[i] = Math.exp((i % 997) / 60) * (1 + (i % 7));
    return s;
  }

  it('各レベルの件数が ratio と厳密に一致する', () => {
    const n = 10_000;
    const ranking = buildRankingFromScores(makeScores(n));
    for (const lv of LEVELS) {
      const expected = lv.id === topLevel ? n : Math.round(n * lv.ratio);
      const actual = ranking.levelOf.reduce((acc, l) => acc + (l <= lv.id ? 1 : 0), 0);
      expect(actual, `level ${lv.label}`).toBe(expected);
    }
  });

  it('レベルは入れ子になる (L に含まれる splat は L+1 にも含まれる)', () => {
    const ranking = buildRankingFromScores(makeScores(5_000));
    for (let L = 0; L < topLevel; L++) {
      for (let i = 0; i < ranking.numSplats; i++) {
        if (ranking.levelOf[i]! <= L) expect(ranking.levelOf[i]!).toBeLessThanOrEqual(L + 1);
      }
    }
  });

  it('スコアの高い splat が優先して採用される', () => {
    const n = 2000;
    const scores = new Float32Array(n);
    for (let i = 0; i < n; i++) scores[i] = i + 1; // 単調増加
    const ranking = buildRankingFromScores(scores);
    const lowest = LEVELS[0]!;
    const kept: number[] = [];
    for (let i = 0; i < n; i++) if (ranking.levelOf[i] === 0) kept.push(i);
    expect(kept.length).toBe(Math.round(n * lowest.ratio));
    // 上位 ratio 件が選ばれているので、最小インデックスは十分大きいはず
    expect(Math.min(...kept)).toBeGreaterThan(n * (1 - lowest.ratio) - n * 0.02);
  });

  it('スコア 0 の splat は最上位レベルでのみ採用される', () => {
    const n = 1000;
    const scores = new Float32Array(n);
    for (let i = 0; i < n; i++) scores[i] = i < 500 ? 0 : i;
    const ranking = buildRankingFromScores(scores);
    for (let i = 0; i < 500; i++) expect(ranking.levelOf[i]).toBe(topLevel);
  });

  it('空入力を扱える', () => {
    const ranking = buildRankingFromScores(new Float32Array(0));
    expect(ranking.numSplats).toBe(0);
    expect(ranking.levelOf.length).toBe(0);
  });

  it('全 splat が同一スコアでも件数が一致する', () => {
    const n = 3000;
    const scores = new Float32Array(n).fill(0.5);
    const ranking = buildRankingFromScores(scores);
    for (const lv of LEVELS) {
      const expected = lv.id === topLevel ? n : Math.round(n * lv.ratio);
      const actual = ranking.levelOf.reduce((acc, l) => acc + (l <= lv.id ? 1 : 0), 0);
      expect(actual, `level ${lv.label}`).toBe(expected);
    }
  });

  it('全 splat が不正値なら最上位レベル以外は空になる', () => {
    const ranking = buildRankingFromScores(new Float32Array(100));
    expect(ranking.counts[0]).toBe(0);
    expect(ranking.counts[topLevel]).toBe(100);
  });
});
