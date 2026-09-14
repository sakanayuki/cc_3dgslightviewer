import * as THREE from 'three';
import type { SplatMesh } from '@sparkjsdev/spark';
import {
  AR_LIGHT_EXPOSURE_GAMMA,
  AR_LIGHT_EXPOSURE_MAX,
  AR_LIGHT_EXPOSURE_MIN,
  AR_LIGHT_FADE_SECONDS,
  AR_LIGHT_SMOOTHING,
} from '../config';
import { ArLightModifier } from './arLightModifier';
import {
  SH_COEFF_COUNT,
  ambientIrradiance,
  exposureFromAmbient,
  luminance,
  neutralSh,
  shToIrradianceMatrices,
  smoothSh,
} from './lightEstimation';

/**
 * WebXR の光源推定を受け取り、splat 群に反映する。
 *
 * 取得できるのは環境光の球面調和関数 (次数2・RGB) で、これを splat ごとの
 * 法線方向で評価して色に乗算する。詳しい方針は arLightModifier.ts を参照。
 *
 * light-estimation に対応しない端末では probe の取得に失敗するので、
 * その場合は何もしない (従来どおりの見た目のまま)。
 */
export class ArLight {
  private readonly modifier = new ArLightModifier();
  private readonly sh = neutralSh();
  private readonly matrices = shToIrradianceMatrices(neutralSh());
  private readonly ambient = new THREE.Vector3();

  private probe: XRLightProbe | null = null;
  private available = false;
  private wanted = false;
  /** 入場時に観測した明るさ。露出はこれを基準にした相対値にする */
  private referenceLuminance = 0;
  /** 0→1 に補間する適用率。切替のちらつきを防ぐ */
  private fade = 0;
  private seenEstimate = false;

  /** この端末で光源推定が使えたか (セッション開始後に確定する) */
  get isAvailable(): boolean {
    return this.available;
  }

  /** ユーザー設定の ON/OFF */
  setWanted(wanted: boolean): void {
    this.wanted = wanted;
  }

  /**
   * セッション開始時に呼ぶ。光源プローブを要求する。
   * 非対応端末では例外になるので握って無効化する。
   */
  async start(session: XRSession, mesh: SplatMesh | null): Promise<void> {
    this.reset();
    if (typeof session.requestLightProbe !== 'function') {
      console.warn('[ArLight] この端末は光源推定 (light-estimation) に対応していません。');
      return;
    }
    try {
      this.probe = await session.requestLightProbe();
    } catch (e) {
      console.warn('[ArLight] 光源プローブを取得できませんでした。', e);
      this.probe = null;
      return;
    }
    this.available = true;
    if (mesh) this.modifier.attach(mesh);
  }

  /** SplatMesh が差し替わったら付け替える */
  attachTo(mesh: SplatMesh): void {
    if (this.available) this.modifier.attach(mesh);
  }

  /** セッション終了時に呼ぶ */
  stop(): void {
    this.modifier.detach();
    this.reset();
  }

  private reset(): void {
    this.probe = null;
    this.available = false;
    this.referenceLuminance = 0;
    this.fade = 0;
    this.seenEstimate = false;
    this.sh.set(neutralSh());
    shToIrradianceMatrices(this.sh, this.matrices);
  }

  /** 毎フレーム、XRFrame を渡して呼ぶ */
  update(frame: XRFrame | undefined, deltaTime: number): void {
    if (!this.available || !this.probe || !frame) return;

    const estimate = frame.getLightEstimate?.(this.probe);
    const coeffs = estimate?.sphericalHarmonicsCoefficients;
    if (coeffs && coeffs.length >= SH_COEFF_COUNT * 3) {
      if (!this.seenEstimate) {
        // 初回は平滑化せずそのまま入れる (中立値から徐々に寄せると色が狂う)
        this.sh.set(coeffs.subarray(0, SH_COEFF_COUNT * 3));
        this.seenEstimate = true;
      } else {
        smoothSh(this.sh, coeffs, AR_LIGHT_SMOOTHING);
      }
      shToIrradianceMatrices(this.sh, this.matrices);
      ambientIrradiance(this.sh, this.ambient);
      if (this.referenceLuminance <= 0) {
        this.referenceLuminance = luminance(this.ambient);
      }
    }

    // ON/OFF を時間で補間する
    const target = this.wanted && this.seenEstimate ? 1 : 0;
    const rate = AR_LIGHT_FADE_SECONDS > 0 ? deltaTime / AR_LIGHT_FADE_SECONDS : 1;
    this.fade += Math.sign(target - this.fade) * Math.min(rate, Math.abs(target - this.fade));

    if (this.fade <= 0) {
      this.modifier.disable();
      return;
    }

    const ambientY = luminance(this.ambient);
    const exposure = exposureFromAmbient(
      ambientY,
      this.referenceLuminance,
      AR_LIGHT_EXPOSURE_GAMMA,
      AR_LIGHT_EXPOSURE_MIN,
      AR_LIGHT_EXPOSURE_MAX,
    );
    this.modifier.setLight(this.matrices, ambientY, exposure, this.fade);
  }

  /** デバッグ・表示用の現在の推定値 */
  get estimate(): { ambient: THREE.Vector3; exposure: number; active: number } {
    const ambientY = luminance(this.ambient);
    return {
      ambient: this.ambient.clone(),
      exposure: exposureFromAmbient(
        ambientY,
        this.referenceLuminance,
        AR_LIGHT_EXPOSURE_GAMMA,
        AR_LIGHT_EXPOSURE_MIN,
        AR_LIGHT_EXPOSURE_MAX,
      ),
      active: this.fade,
    };
  }
}
