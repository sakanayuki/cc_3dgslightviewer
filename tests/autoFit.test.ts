import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import {
  computeBounds,
  computeInitialView,
  computeViewDirection,
  resolveUpFor,
} from '../src/camera/autoFit';
import { DEFAULT_ELEVATION_DEG, DEFAULT_RIGHT, DEFAULT_UP } from '../src/config';

/**
 * lookAt の基底における画面右と画面上を求める。
 * three.js のカメラは -Z を向くので、z = 位置 - 注視点。
 */
function screenAxes(position: THREE.Vector3, target: THREE.Vector3, up: THREE.Vector3) {
  const z = position.clone().sub(target).normalize();
  const x = new THREE.Vector3().crossVectors(up, z).normalize();
  const y = new THREE.Vector3().crossVectors(z, x).normalize();
  return { right: x, up: y };
}

describe('computeViewDirection', () => {
  it('DEFAULT_RIGHT (+X) が厳密に画面右を向く', () => {
    const dir = computeViewDirection(DEFAULT_UP, DEFAULT_ELEVATION_DEG);
    const { right } = screenAxes(dir, new THREE.Vector3(), DEFAULT_UP);
    expect(right.x).toBeCloseTo(1, 6);
    expect(right.y).toBeCloseTo(0, 6);
    expect(right.z).toBeCloseTo(0, 6);
  });

  it('-Y が画面上を向く', () => {
    const dir = computeViewDirection(DEFAULT_UP, DEFAULT_ELEVATION_DEG);
    const { up } = screenAxes(dir, new THREE.Vector3(), DEFAULT_UP);
    // 仰角のぶん Z 成分は入るが、上方向の主成分は -Y でなければならない
    expect(up.y).toBeLessThan(-0.5);
    expect(Math.abs(up.x)).toBeLessThan(1e-6);
  });

  it('仰角を変えても +X が画面右を向く性質は保たれる', () => {
    for (const deg of [0, 10, 25, 45, 70]) {
      const dir = computeViewDirection(DEFAULT_UP, deg);
      const { right } = screenAxes(dir, new THREE.Vector3(), DEFAULT_UP);
      expect(right.x, `仰角 ${deg}度`).toBeCloseTo(1, 6);
    }
  });

  it('仰角のぶん up 側へ持ち上がる (-Y 上なら見下ろす位置になる)', () => {
    const flat = computeViewDirection(DEFAULT_UP, 0);
    const tilted = computeViewDirection(DEFAULT_UP, 25);
    expect(flat.dot(DEFAULT_UP)).toBeCloseTo(0, 6);
    expect(tilted.dot(DEFAULT_UP)).toBeGreaterThan(0);
  });

  it('up が +X と平行でも破綻しない', () => {
    const dir = computeViewDirection(new THREE.Vector3(1, 0, 0), DEFAULT_ELEVATION_DEG);
    expect(Number.isFinite(dir.x) && Number.isFinite(dir.y) && Number.isFinite(dir.z)).toBe(true);
    expect(dir.length()).toBeCloseTo(1, 6);
  });
});

describe('computeInitialView', () => {
  it('シーンが画面に収まる距離にカメラを置く', () => {
    const bounds = {
      center: new THREE.Vector3(3, -4, 5),
      radius: 10,
      up: DEFAULT_UP.clone(),
      upEstimated: false,
    };
    const view = computeInitialView(bounds, 60);
    const distance = view.position.distanceTo(view.target);
    // radius / sin(fov/2) * margin = 10 / 0.5 * 1.2 = 24
    expect(distance).toBeCloseTo(24, 4);
    expect(view.target.equals(bounds.center)).toBe(true);
    expect(view.near).toBeLessThan(view.far);
  });

  it('注視点がずれていても +X が画面右を向く', () => {
    const bounds = {
      center: new THREE.Vector3(-100, 42, 7),
      radius: 2,
      up: DEFAULT_UP.clone(),
      upEstimated: false,
    };
    const view = computeInitialView(bounds, 60);
    const { right } = screenAxes(view.position, view.target, bounds.up);
    expect(right.x).toBeCloseTo(1, 6);
  });
});

describe('resolveUpFor', () => {
  it('視線が up と平行でなければ up をそのまま使う', () => {
    const up = resolveUpFor(new THREE.Vector3(1, 0, 0), DEFAULT_UP);
    expect(up.equals(DEFAULT_UP.clone().normalize())).toBe(true);
  });

  it('真上/真下から見るとき退化せず、+X が画面右を向く', () => {
    for (const dir of [new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, -1, 0)]) {
      const up = resolveUpFor(dir, DEFAULT_UP);
      expect(Math.abs(up.dot(dir))).toBeLessThan(1e-6); // 視線と直交している
      const { right } = screenAxes(dir, new THREE.Vector3(), up);
      expect(right.distanceTo(DEFAULT_RIGHT)).toBeLessThan(1e-6);
    }
  });
});

describe('computeBounds', () => {
  it('外れ値をパーセンタイルで除外する', () => {
    const n = 1000;
    const centers = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      centers[i * 3] = (i / n) * 2 - 1;
      centers[i * 3 + 1] = (i / n) * 2 - 1;
      centers[i * 3 + 2] = (i / n) * 2 - 1;
    }
    // 遠方の外れ値を混ぜる
    centers[0] = -100000;
    centers[(n - 1) * 3] = 100000;
    const bounds = computeBounds(centers);
    expect(bounds.radius).toBeLessThan(10);
  });

  it('空入力でも破綻しない', () => {
    const bounds = computeBounds(new Float32Array(0));
    expect(bounds.radius).toBe(1);
    expect(Number.isFinite(bounds.center.x)).toBe(true);
  });

  it('既定では up 推定を行わず DEFAULT_UP を返す', () => {
    const n = 500;
    const centers = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      centers[i * 3] = Math.sin(i) * 10;
      centers[i * 3 + 1] = Math.cos(i) * 0.1; // 薄い板
      centers[i * 3 + 2] = Math.sin(i * 2) * 10;
    }
    const bounds = computeBounds(centers);
    expect(bounds.upEstimated).toBe(false);
    expect(bounds.up.equals(DEFAULT_UP)).toBe(true);
  });
});
