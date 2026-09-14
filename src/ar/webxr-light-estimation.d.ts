/**
 * WebXR Lighting Estimation API の型定義。
 * TypeScript の DOM ライブラリにまだ含まれていないため、使う範囲だけ宣言する。
 * 仕様: https://immersive-web.github.io/lighting-estimation/
 */

interface XRLightProbe extends EventTarget {
  readonly probeSpace: XRSpace;
  onreflectionchange: ((this: XRLightProbe, ev: Event) => unknown) | null;
}

interface XRLightEstimate {
  /** 9 係数 × RGB = 27 要素。次数2の球面調和関数による環境光の放射輝度 */
  readonly sphericalHarmonicsCoefficients: Float32Array;
  readonly primaryLightDirection: DOMPointReadOnly;
  readonly primaryLightIntensity: DOMPointReadOnly;
}

interface XRLightProbeInit {
  reflectionFormat?: 'srgba8' | 'rgba16f';
}

interface XRSession {
  requestLightProbe?(options?: XRLightProbeInit): Promise<XRLightProbe>;
  readonly preferredReflectionFormat?: 'srgba8' | 'rgba16f';
}

interface XRFrame {
  getLightEstimate?(lightProbe: XRLightProbe): XRLightEstimate | null;
}
