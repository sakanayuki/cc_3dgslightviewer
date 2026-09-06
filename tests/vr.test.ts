import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { computeVrOrientation, computeVrPlacement } from '../src/vr/placement';
import { GrabController } from '../src/vr/GrabController';
import {
  DEFAULT_RIGHT,
  DEFAULT_UP,
  VR_MODEL_DISTANCE,
  VR_MODEL_HEIGHT,
  VR_SCALE_MAX,
  VR_TARGET_RADIUS,
} from '../src/config';

const XR_UP = new THREE.Vector3(0, 1, 0);

describe('computeVrOrientation', () => {
  it('モデルの上方向を XR の上 (+Y) へ移す', () => {
    const q = computeVrOrientation(DEFAULT_UP);
    const moved = DEFAULT_UP.clone().applyQuaternion(q);
    expect(moved.distanceTo(XR_UP)).toBeLessThan(1e-6);
  });

  it('モデルの +X を XR の右 (+X) へ移す', () => {
    const q = computeVrOrientation(DEFAULT_UP);
    const moved = DEFAULT_RIGHT.clone().applyQuaternion(q);
    expect(moved.distanceTo(DEFAULT_RIGHT)).toBeLessThan(1e-6);
  });

  it('DEFAULT_UP = (0,-1,0) では X 軸まわりの 180 度回転になる', () => {
    const q = computeVrOrientation(DEFAULT_UP);
    const expected = new THREE.Quaternion().setFromAxisAngle(DEFAULT_RIGHT, Math.PI);
    expect(Math.abs(q.dot(expected))).toBeCloseTo(1, 6); // 符号違いは同じ回転
  });

  it('up が +Y のときは回転しない', () => {
    const q = computeVrOrientation(XR_UP);
    expect(XR_UP.clone().applyQuaternion(q).distanceTo(XR_UP)).toBeLessThan(1e-6);
    expect(DEFAULT_RIGHT.clone().applyQuaternion(q).distanceTo(DEFAULT_RIGHT)).toBeLessThan(1e-6);
  });

  it('up が +X (DEFAULT_RIGHT と平行) でも破綻しない', () => {
    const up = new THREE.Vector3(1, 0, 0);
    const q = computeVrOrientation(up);
    expect(up.clone().applyQuaternion(q).distanceTo(XR_UP)).toBeLessThan(1e-6);
  });

  it('正しい回転行列である (行列式 = 1)', () => {
    const q = computeVrOrientation(DEFAULT_UP);
    const m = new THREE.Matrix4().makeRotationFromQuaternion(q);
    expect(m.determinant()).toBeCloseTo(1, 6);
  });
});

describe('computeVrPlacement', () => {
  const bounds = {
    center: new THREE.Vector3(12, -34, 56),
    radius: 20,
    up: DEFAULT_UP.clone(),
    upEstimated: false,
  };

  it('モデル中心が目の前の既定位置に来る', () => {
    const p = computeVrPlacement(bounds);
    // three.js の合成順 T * R * S に合わせて中心を変換する
    const placed = bounds.center
      .clone()
      .multiplyScalar(p.scale)
      .applyQuaternion(p.quaternion)
      .add(p.position);
    expect(placed.x).toBeCloseTo(0, 5);
    expect(placed.y).toBeCloseTo(VR_MODEL_HEIGHT, 5);
    expect(placed.z).toBeCloseTo(-VR_MODEL_DISTANCE, 5);
  });

  it('見かけの半径が実寸に正規化される', () => {
    const p = computeVrPlacement(bounds);
    expect(bounds.radius * p.scale).toBeCloseTo(VR_TARGET_RADIUS, 6);
  });

  it('半径が 0 でも破綻しない', () => {
    const p = computeVrPlacement({ ...bounds, radius: 0 });
    expect(Number.isFinite(p.scale)).toBe(true);
    expect(Number.isFinite(p.position.x)).toBe(true);
  });
});

/** テスト用のコントローラ 2 本。親に付けて matrixWorld を更新できるようにする */
function makeRig(): {
  root: THREE.Group;
  world: THREE.Group;
  hands: [THREE.Object3D, THREE.Object3D];
  grab: GrabController;
  sync: () => void;
} {
  const root = new THREE.Group();
  const world = new THREE.Group();
  const hands: [THREE.Object3D, THREE.Object3D] = [new THREE.Object3D(), new THREE.Object3D()];
  root.add(hands[0], hands[1]);
  const grab = new GrabController(world, hands);
  return { root, world, hands, grab, sync: () => root.updateMatrixWorld(true) };
}

/** 角度を連続化しながら積算する (360 度を越えた回転量を測るため) */
function makeAngleAccumulator(initial: number) {
  let prev = initial;
  let total = 0;
  return (angle: number): number => {
    let d = angle - prev;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    total += d;
    prev = angle;
    return total;
  };
}

describe('GrabController - 回転の連続性', () => {
  it('片手グラブで 720 度回しても止まらない', () => {
    const { world, hands, grab, sync } = makeRig();
    hands[0].position.set(0, 1.2, -0.4);
    sync();
    grab.update([true, false]); // 基準取り

    const probe = () => {
      const v = new THREE.Vector3(1, 0, 0).applyQuaternion(world.quaternion);
      return Math.atan2(v.z, v.x);
    };
    const accumulate = makeAngleAccumulator(probe());

    const step = THREE.MathUtils.degToRad(10);
    let total = 0;
    for (let i = 1; i <= 72; i++) {
      hands[0].quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), -step * i);
      sync();
      grab.update([true, false]);
      total = accumulate(probe());
    }
    // 720 度ぶん回っているはず (符号は回転の向き)
    expect(Math.abs(THREE.MathUtils.radToDeg(total))).toBeCloseTo(720, 0);
  });

  it('両手グラブで縦方向に 720 度回しても止まらない (90/180 度で退化しない)', () => {
    // これが報告された不具合の再現。以前は atan2(dz, dx) で XZ 平面へ投影して
    // Yaw のみを取り出していたため、手を縦に回すと 90 度付近で退化し
    // 180 度で元に戻ってしまっていた。
    const { world, hands, grab, sync } = makeRig();
    const mid = new THREE.Vector3(0, 1.3, -0.5);
    const place = (angle: number) => {
      const half = new THREE.Vector3(0, Math.sin(angle), Math.cos(angle)).multiplyScalar(0.25);
      hands[0].position.copy(mid).sub(half);
      hands[1].position.copy(mid).add(half);
      sync();
    };

    place(0);
    grab.update([true, true]);

    const probe = () => {
      const v = new THREE.Vector3(0, 1, 0).applyQuaternion(world.quaternion);
      return Math.atan2(v.y, v.z);
    };
    const accumulate = makeAngleAccumulator(probe());

    const step = THREE.MathUtils.degToRad(5);
    let total = 0;
    for (let i = 1; i <= 144; i++) {
      place(step * i);
      grab.update([true, true]);
      total = accumulate(probe());
    }
    expect(Math.abs(THREE.MathUtils.radToDeg(total))).toBeCloseTo(720, 0);
  });

  it('90 度と 180 度の通過時も回転が進み続ける', () => {
    const { world, hands, grab, sync } = makeRig();
    const mid = new THREE.Vector3(0, 1.3, -0.5);
    const place = (angle: number) => {
      const half = new THREE.Vector3(0, Math.sin(angle), Math.cos(angle)).multiplyScalar(0.25);
      hands[0].position.copy(mid).sub(half);
      hands[1].position.copy(mid).add(half);
      sync();
    };
    place(0);
    grab.update([true, true]);

    const samples: number[] = [];
    const step = THREE.MathUtils.degToRad(5);
    for (let i = 1; i <= 54; i++) {
      // 0 度から 270 度まで通過させる
      place(step * i);
      grab.update([true, true]);
      const v = new THREE.Vector3(0, 1, 0).applyQuaternion(world.quaternion);
      samples.push(Math.atan2(v.y, v.z));
    }
    // 隣り合うサンプルが常に変化していること (どこかで固まらない)
    for (let i = 1; i < samples.length; i++) {
      let d = samples[i]! - samples[i - 1]!;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      expect(Math.abs(THREE.MathUtils.radToDeg(d)), `step ${i}`).toBeGreaterThan(1);
    }
  });
});

describe('GrabController - 平行移動と拡縮', () => {
  it('片手グラブで世界が手に追従する', () => {
    const { world, hands, grab, sync } = makeRig();
    hands[1].position.set(0, 1, -1);
    sync();
    grab.update([false, true]);
    hands[1].position.set(0.5, 1.25, -1);
    sync();
    grab.update([false, true]);
    expect(world.position.x).toBeCloseTo(0.5, 6);
    expect(world.position.y).toBeCloseTo(0.25, 6);
  });

  it('両手の間隔で拡縮する', () => {
    const { world, hands, grab, sync } = makeRig();
    hands[0].position.set(-0.2, 1, -1);
    hands[1].position.set(0.2, 1, -1);
    sync();
    grab.update([true, true]);
    hands[0].position.set(-0.4, 1, -1);
    hands[1].position.set(0.4, 1, -1);
    sync();
    grab.update([true, true]);
    expect(world.scale.x).toBeCloseTo(2, 5);
  });

  it('拡大の上限でクランプされる', () => {
    const { world, hands, grab, sync } = makeRig();
    for (let i = 0; i < 30; i++) {
      const d = 0.05 * Math.pow(1.5, i);
      hands[0].position.set(-d, 1, -1);
      hands[1].position.set(d, 1, -1);
      sync();
      grab.update([true, true]);
    }
    expect(world.scale.x).toBeLessThanOrEqual(VR_SCALE_MAX + 1e-6);
  });

  it('掴んでいる手が変わったら基準を取り直し、世界が飛ばない', () => {
    const { world, hands, grab, sync } = makeRig();
    hands[0].position.set(-1, 1, -1);
    hands[1].position.set(1, 1, -1);
    sync();
    grab.update([true, false]);
    hands[0].position.set(-0.9, 1, -1);
    sync();
    grab.update([true, false]);
    const afterLeft = world.position.clone();

    // 右手に持ち替える。位置が大きく離れていても飛ばないこと
    grab.update([false, true]);
    expect(world.position.distanceTo(afterLeft)).toBeLessThan(1e-9);
  });

  it('手を離すと worldRoot は動かない', () => {
    const { world, hands, grab, sync } = makeRig();
    hands[0].position.set(0, 1, -1);
    sync();
    grab.update([true, false]);
    hands[0].position.set(0, 1.5, -1);
    sync();
    grab.update([true, false]);
    const held = world.position.clone();

    grab.update([false, false]);
    hands[0].position.set(3, 3, 3);
    sync();
    grab.update([false, false]);
    expect(world.position.distanceTo(held)).toBeLessThan(1e-9);
  });
});
