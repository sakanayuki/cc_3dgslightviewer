import * as THREE from 'three';
import { dyno } from '@sparkjsdev/spark';
import type { GsplatModifier, SplatMesh } from '@sparkjsdev/spark';

/**
 * 推定した環境光を splat ごとに適用する Spark の dyno モディファイア。
 *
 * 3DGS は撮影時の光が色に焼き込まれているため、物理的に正しいリライティングは
 * できない。ここでやるのは「元の色 × 推定した環境光」の乗算で、
 *
 *   - 環境光の色味 (ホワイトバランス)
 *   - 法線方向による回り込みの差 (環境 SH の方向成分)
 *   - 環境の明るさに応じた露出
 *
 * を反映する。乗数は平均が 1.0 になるよう正規化してあるので、
 * 元データの見た目を保ったまま差分だけが乗る。
 *
 * 法線は splat の共分散の最小軸 (Spark の gsplatNormal) を使い、
 * カメラ側を向くよう符号を揃える。splat の法線には一貫した向きが無いため、
 * これをしないと裏側の環境光を拾ってしまう。
 */
export class ArLightModifier {
  /** 放射照度行列 (R/G/B) */
  private readonly matR = dyno.dynoMat4(new THREE.Matrix4(), 'arLightMatR');
  private readonly matG = dyno.dynoMat4(new THREE.Matrix4(), 'arLightMatG');
  private readonly matB = dyno.dynoMat4(new THREE.Matrix4(), 'arLightMatB');
  /** 平均放射照度の輝度の逆数。これを掛けて乗数の平均を 1.0 に正規化する */
  private readonly invAmbient = dyno.dynoFloat(1, 'arLightInvAmbient');
  private readonly exposure = dyno.dynoFloat(1, 'arLightExposure');
  /** 0 = 無効 (乗数 1.0)、1 = 全適用。切替時にこの値を補間する */
  private readonly strength = dyno.dynoFloat(0, 'arLightStrength');

  /** 適用対象。レベル切替などで SplatMesh が差し替わったら付け替える */
  private attached: SplatMesh | null = null;

  /**
   * 毎フレームの更新値を書き込む。シェーダは再コンパイルされない。
   */
  setLight(
    matrices: readonly [THREE.Matrix4, THREE.Matrix4, THREE.Matrix4],
    ambientLuminance: number,
    exposure: number,
    strength: number,
  ): void {
    this.matR.value.copy(matrices[0]);
    this.matG.value.copy(matrices[1]);
    this.matB.value.copy(matrices[2]);
    this.invAmbient.value = ambientLuminance > 1e-6 ? 1 / ambientLuminance : 0;
    this.exposure.value = exposure;
    this.strength.value = strength;
  }

  /** 効果を切る (乗数を 1.0 にする)。シェーダは付けたままでよい */
  disable(): void {
    this.strength.value = 0;
  }

  attach(mesh: SplatMesh): void {
    if (this.attached === mesh) return;
    // gsplatNormal をビュー空間で評価して符号を揃えるために必要
    mesh.enableWorldToView = true;
    mesh.worldModifier = this.build(mesh);
    mesh.updateGenerator();
    this.attached = mesh;
  }

  detach(): void {
    const mesh = this.attached;
    this.attached = null;
    if (!mesh) return;
    this.strength.value = 0;
    mesh.worldModifier = undefined;
    mesh.updateGenerator();
  }

  private build(mesh: SplatMesh): GsplatModifier {
    const worldToView = mesh.context.worldToView;
    const apply = new dyno.Dyno<
      {
        rgb: 'vec3';
        normal: 'vec3';
        matR: 'mat4';
        matG: 'mat4';
        matB: 'mat4';
        invAmbient: 'float';
        exposure: 'float';
        strength: 'float';
      },
      { rgb: 'vec3' }
    >({
      inTypes: {
        rgb: 'vec3',
        normal: 'vec3',
        matR: 'mat4',
        matG: 'mat4',
        matB: 'mat4',
        invAmbient: 'float',
        exposure: 'float',
        strength: 'float',
      },
      outTypes: { rgb: 'vec3' },
      globals: () => [
        `
// 放射照度は法線の 2 次形式なので 4x4 行列 1 枚で評価できる
float arLightEval(mat4 m, vec4 n) {
  return dot(n, m * n);
}

vec3 arLightApply(
  vec3 rgb, vec3 normal,
  mat4 matR, mat4 matG, mat4 matB,
  float invAmbient, float exposure, float strength
) {
  vec4 n4 = vec4(normal, 1.0);
  vec3 irradiance = vec3(
    arLightEval(matR, n4),
    arLightEval(matG, n4),
    arLightEval(matB, n4)
  );
  // 平均輝度で割ることで、ホワイトバランスと方向成分だけが残る
  vec3 lit = max(irradiance * invAmbient * exposure, vec3(0.0));
  return rgb * mix(vec3(1.0), lit, strength);
}
        `.trim(),
      ],
      statements: ({ inputs, outputs }) => [
        `${outputs.rgb} = arLightApply(${inputs.rgb}, ${inputs.normal}, ` +
          `${inputs.matR}, ${inputs.matG}, ${inputs.matB}, ` +
          `${inputs.invAmbient}, ${inputs.exposure}, ${inputs.strength});`,
      ],
    });

    return dyno.dynoBlock(
      { gsplat: dyno.Gsplat },
      { gsplat: dyno.Gsplat },
      ({ gsplat }) => {
        if (!gsplat) throw new Error('ArLightModifier: no gsplat input');

        // splat の法線 (共分散の最小軸)。向きは一貫していないのでカメラ側に揃える
        let normal = dyno.gsplatNormal(gsplat);
        const viewGsplat = worldToView.applyGsplat(gsplat);
        const viewCenter = dyno.splitGsplat(viewGsplat).outputs.center;
        const viewNormal = dyno.gsplatNormal(viewGsplat);
        const facingAway = dyno.greaterThanEqual(
          dyno.dot(viewCenter, viewNormal),
          dyno.dynoConst('float', 0),
        );
        normal = dyno.select(facingAway, dyno.neg(normal), normal);

        const { rgba } = dyno.splitGsplat(gsplat).outputs;
        const rgb = dyno.swizzle(rgba, 'rgb');
        const lit = apply.apply({
          rgb,
          normal,
          matR: this.matR,
          matG: this.matG,
          matB: this.matB,
          invAmbient: this.invAmbient,
          exposure: this.exposure,
          strength: this.strength,
        }).rgb;

        return { gsplat: dyno.combineGsplat({ gsplat, rgb: lit }) };
      },
    );
  }
}
