import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  SH_COEFF_COUNT,
  ambientIrradiance,
  evaluateIrradiance,
  exposureFromAmbient,
  luminance,
  neutralSh,
  shToIrradianceMatrices,
  smoothSh,
} from '../src/ar/lightEstimation';

/** 球面上に散らした方向。等方性の検証に使う */
const DIRECTIONS = [
  new THREE.Vector3(1, 0, 0),
  new THREE.Vector3(-1, 0, 0),
  new THREE.Vector3(0, 1, 0),
  new THREE.Vector3(0, -1, 0),
  new THREE.Vector3(0, 0, 1),
  new THREE.Vector3(0, 0, -1),
  new THREE.Vector3(1, 1, 1).normalize(),
  new THREE.Vector3(-1, 2, -3).normalize(),
];

/** DC 項だけの SH (一様な環境光) */
function dcSh(r: number, g: number, b: number): Float32Array {
  const sh = new Float32Array(SH_COEFF_COUNT * 3);
  sh[0] = r;
  sh[1] = g;
  sh[2] = b;
  return sh;
}

describe('neutralSh', () => {
  it('どの方向でも放射照度が 1.0 になる', () => {
    const m = shToIrradianceMatrices(neutralSh());
    for (const d of DIRECTIONS) {
      const e = evaluateIrradiance(m, d);
      expect(e.x, `${d.toArray()}`).toBeCloseTo(1, 6);
      expect(e.y).toBeCloseTo(1, 6);
      expect(e.z).toBeCloseTo(1, 6);
    }
  });
});

describe('shToIrradianceMatrices', () => {
  it('DC のみなら全方向で同じ値になる (等方)', () => {
    const m = shToIrradianceMatrices(dcSh(2, 2, 2));
    const values = DIRECTIONS.map((d) => evaluateIrradiance(m, d).x);
    for (const v of values) expect(v).toBeCloseTo(values[0]!, 6);
  });

  it('DC の値は 0.886227 倍で放射照度になる', () => {
    const m = shToIrradianceMatrices(dcSh(1, 1, 1));
    expect(evaluateIrradiance(m, new THREE.Vector3(0, 1, 0)).x).toBeCloseTo(0.886227, 5);
  });

  it('チャンネルごとに独立している', () => {
    const m = shToIrradianceMatrices(dcSh(1, 0, 0));
    const e = evaluateIrradiance(m, new THREE.Vector3(0, 0, 1));
    expect(e.x).toBeGreaterThan(0.5);
    expect(e.y).toBeCloseTo(0, 6);
    expect(e.z).toBeCloseTo(0, 6);
  });

  it('L10 (Z方向の1次項) は +Z を明るく -Z を暗くする', () => {
    const sh = new Float32Array(SH_COEFF_COUNT * 3);
    sh[0] = sh[1] = sh[2] = 1; // DC
    // index 2 = L10 (Z)
    sh[2 * 3] = 0.5;
    sh[2 * 3 + 1] = 0.5;
    sh[2 * 3 + 2] = 0.5;
    const m = shToIrradianceMatrices(sh);
    const up = evaluateIrradiance(m, new THREE.Vector3(0, 0, 1)).x;
    const down = evaluateIrradiance(m, new THREE.Vector3(0, 0, -1)).x;
    expect(up).toBeGreaterThan(down);
  });

  it('放射照度行列は対称である (2次形式として妥当)', () => {
    const sh = new Float32Array(SH_COEFF_COUNT * 3);
    for (let i = 0; i < sh.length; i++) sh[i] = Math.sin(i) * 0.3;
    const [mR] = shToIrradianceMatrices(sh);
    const e = mR.elements;
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        expect(e[c * 4 + r], `(${r},${c})`).toBeCloseTo(e[r * 4 + c]!, 10);
      }
    }
  });

  it('渡した行列に書き込む (毎フレーム確保しない)', () => {
    const target: [THREE.Matrix4, THREE.Matrix4, THREE.Matrix4] = [
      new THREE.Matrix4(),
      new THREE.Matrix4(),
      new THREE.Matrix4(),
    ];
    const out = shToIrradianceMatrices(dcSh(1, 1, 1), target);
    expect(out).toBe(target);
    expect(out[0]).toBe(target[0]);
  });
});

describe('ambientIrradiance / luminance', () => {
  it('DC 項から平均放射照度を求める', () => {
    const a = ambientIrradiance(dcSh(1, 2, 3));
    expect(a.x).toBeCloseTo(0.886227, 5);
    expect(a.y).toBeCloseTo(0.886227 * 2, 5);
    expect(a.z).toBeCloseTo(0.886227 * 3, 5);
  });

  it('平均放射照度は全方向の放射照度の平均に一致する', () => {
    const sh = new Float32Array(SH_COEFF_COUNT * 3);
    for (let i = 0; i < sh.length; i++) sh[i] = i === 0 || i === 1 || i === 2 ? 1 : Math.cos(i) * 0.2;
    const m = shToIrradianceMatrices(sh);
    // 球面上を細かくサンプリングして平均を取る
    let sum = 0;
    let count = 0;
    const N = 40;
    for (let i = 0; i < N; i++) {
      const z = 1 - (2 * (i + 0.5)) / N;
      const r = Math.sqrt(Math.max(0, 1 - z * z));
      for (let j = 0; j < N; j++) {
        const phi = (2 * Math.PI * (j + 0.5)) / N;
        sum += evaluateIrradiance(m, new THREE.Vector3(r * Math.cos(phi), r * Math.sin(phi), z)).x;
        count++;
      }
    }
    expect(sum / count).toBeCloseTo(ambientIrradiance(sh).x, 3);
  });

  it('輝度は Rec.709 の重みを使う', () => {
    expect(luminance(new THREE.Vector3(1, 0, 0))).toBeCloseTo(0.2126, 6);
    expect(luminance(new THREE.Vector3(0, 1, 0))).toBeCloseTo(0.7152, 6);
    expect(luminance(new THREE.Vector3(0, 0, 1))).toBeCloseTo(0.0722, 6);
    expect(luminance(new THREE.Vector3(1, 1, 1))).toBeCloseTo(1, 6);
  });
});

describe('正規化した乗数', () => {
  /** シェーダと同じ式: irradiance / 平均輝度 */
  function multiplier(sh: Float32Array, dir: THREE.Vector3): THREE.Vector3 {
    const m = shToIrradianceMatrices(sh);
    const y = luminance(ambientIrradiance(sh));
    return evaluateIrradiance(m, dir).multiplyScalar(1 / y);
  }

  it('無彩色の環境では明るさに関係なく乗数が 1 になる', () => {
    for (const level of [0.2, 1, 5, 50]) {
      const mul = multiplier(dcSh(level, level, level), new THREE.Vector3(0, 1, 0));
      expect(mul.x, `level=${level}`).toBeCloseTo(1, 5);
      expect(mul.y).toBeCloseTo(1, 5);
      expect(mul.z).toBeCloseTo(1, 5);
    }
  });

  it('暖色の環境では赤が強く青が弱い乗数になる (ホワイトバランス)', () => {
    const mul = multiplier(dcSh(1.4, 1.0, 0.6), new THREE.Vector3(0, 1, 0));
    expect(mul.x).toBeGreaterThan(1);
    expect(mul.z).toBeLessThan(1);
    // 輝度で正規化しているので、緑はおおむね 1 付近に留まる
    expect(mul.y).toBeGreaterThan(0.8);
    expect(mul.y).toBeLessThan(1.2);
  });

  it('方向性のある環境では法線によって乗数が変わる', () => {
    const sh = dcSh(1, 1, 1);
    sh[2 * 3] = 0.4; // L10 (Z)
    sh[2 * 3 + 1] = 0.4;
    sh[2 * 3 + 2] = 0.4;
    const up = multiplier(sh, new THREE.Vector3(0, 0, 1));
    const down = multiplier(sh, new THREE.Vector3(0, 0, -1));
    expect(up.x).toBeGreaterThan(down.x);
  });
});

describe('smoothSh', () => {
  it('alpha=1 なら即座に置き換わる', () => {
    const cur = dcSh(0, 0, 0);
    smoothSh(cur, dcSh(1, 2, 3), 1);
    expect(cur[0]).toBeCloseTo(1, 6);
    expect(cur[2]).toBeCloseTo(3, 6);
  });

  it('alpha=0 なら変化しない', () => {
    const cur = dcSh(5, 5, 5);
    smoothSh(cur, dcSh(1, 1, 1), 0);
    expect(cur[0]).toBe(5);
  });

  it('繰り返すと目標値に収束する', () => {
    const cur = dcSh(0, 0, 0);
    for (let i = 0; i < 200; i++) smoothSh(cur, dcSh(2, 2, 2), 0.08);
    expect(cur[0]).toBeCloseTo(2, 4);
  });

  it('alpha は 0〜1 にクランプされる', () => {
    const cur = dcSh(0, 0, 0);
    smoothSh(cur, dcSh(1, 1, 1), 5);
    expect(cur[0]).toBeCloseTo(1, 6);
    const cur2 = dcSh(3, 3, 3);
    smoothSh(cur2, dcSh(1, 1, 1), -2);
    expect(cur2[0]).toBe(3);
  });
});

describe('exposureFromAmbient', () => {
  const G = 0.5;
  const MIN = 0.7;
  const MAX = 1.4;

  it('基準と同じ明るさなら 1.0', () => {
    expect(exposureFromAmbient(1, 1, G, MIN, MAX)).toBeCloseTo(1, 6);
    expect(exposureFromAmbient(7, 7, G, MIN, MAX)).toBeCloseTo(1, 6);
  });

  it('明るくなると 1 より大きく、暗くなると小さくなる', () => {
    expect(exposureFromAmbient(4, 1, G, MIN, MAX)).toBeGreaterThan(1);
    expect(exposureFromAmbient(0.25, 1, G, MIN, MAX)).toBeLessThan(1);
  });

  it('gamma で圧縮される (4倍明るくて2倍)', () => {
    expect(exposureFromAmbient(4, 1, 0.5, 0, 10)).toBeCloseTo(2, 6);
    expect(exposureFromAmbient(4, 1, 1, 0, 10)).toBeCloseTo(4, 6);
    expect(exposureFromAmbient(4, 1, 0, 0, 10)).toBeCloseTo(1, 6);
  });

  it('上下にクランプされる', () => {
    expect(exposureFromAmbient(10000, 1, G, MIN, MAX)).toBe(MAX);
    expect(exposureFromAmbient(1e-6, 1, G, MIN, MAX)).toBe(MIN);
  });

  it('不正な入力では 1.0 を返す (効果なし)', () => {
    expect(exposureFromAmbient(0, 1, G, MIN, MAX)).toBe(1);
    expect(exposureFromAmbient(1, 0, G, MIN, MAX)).toBe(1);
    expect(exposureFromAmbient(NaN, 1, G, MIN, MAX)).toBe(1);
    expect(exposureFromAmbient(-5, 1, G, MIN, MAX)).toBe(1);
  });
});
