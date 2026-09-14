import * as THREE from 'three';
import { VR_FIXED_FOVEATION, VR_FRAMEBUFFER_SCALE } from '../config';
import { GrabController } from './GrabController';
import { Locomotion } from './Locomotion';
import type { XrMode, XrSupport } from '../types';

/** XR モードと WebXR のセッション種別の対応 */
const SESSION_MODE: Record<XrMode, XRSessionMode> = {
  vr: 'immersive-vr',
  passthrough: 'immersive-ar',
};

/** xr-standard のボタン番号: 1 = squeeze (グリップ) */
const BUTTON_SQUEEZE = 1;

export interface VrSessionOptions {
  renderer: THREE.WebGLRenderer;
  /** 移動対象。カメラの親 */
  rig: THREE.Group;
  /** グラブ対象。SplatMesh の親 */
  worldRoot: THREE.Group;
  onEnter: (mode: XrMode) => void;
  onExit: () => void;
}

/**
 * WebXR VR セッションの管理。
 *
 * Spark の SparkXr は使わず three.js の WebXRManager を直接使う。SparkXr の
 * コントローラ抽象は連続回転が前提で、本アプリで必要なスナップ回転と両手グラブを
 * 実装するには結局 XRInputSource を直接触ることになるため。
 * Quest 2 向けの負荷設定 (foveation / framebufferScale) は WebXRManager 側にある。
 */
export class VrSession {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly locomotion: Locomotion;
  private readonly grab: GrabController;
  private readonly controllers: readonly [THREE.XRTargetRaySpace, THREE.XRTargetRaySpace];
  private readonly options: VrSessionOptions;
  private session: XRSession | undefined;
  private mode: XrMode = 'vr';
  private support: XrSupport = { vr: false, passthrough: false };

  constructor(options: VrSessionOptions) {
    this.options = options;
    this.renderer = options.renderer;

    this.renderer.xr.enabled = true;
    this.renderer.xr.setFoveation(VR_FIXED_FOVEATION);
    this.renderer.xr.setFramebufferScaleFactor(VR_FRAMEBUFFER_SCALE);
    this.renderer.xr.setReferenceSpaceType('local-floor');

    const c0 = this.renderer.xr.getController(0);
    const c1 = this.renderer.xr.getController(1);
    options.rig.add(c0, c1);
    this.controllers = [c0, c1];

    this.locomotion = new Locomotion(options.rig);
    this.grab = new GrabController(options.worldRoot, this.controllers);
  }


  /**
   * 対応している XR セッションを調べる。
   * パススルーは immersive-ar として提供される。Quest 2 では利用できるが、
   * 対応していない端末もあるため VR とは別に判定する。
   */
  async checkSupport(): Promise<XrSupport> {
    const xr = navigator.xr;
    if (!xr) return this.support;
    const probe = async (m: XRSessionMode): Promise<boolean> => {
      try {
        return await xr.isSessionSupported(m);
      } catch {
        return false;
      }
    };
    this.support = {
      vr: await probe('immersive-vr'),
      passthrough: await probe('immersive-ar'),
    };
    return this.support;
  }

  get isSupported(): boolean {
    return this.support.vr || this.support.passthrough;
  }

  get supportsPassthrough(): boolean {
    return this.support.passthrough;
  }

  /** 実行中のセッションの種類 */
  get activeMode(): XrMode {
    return this.mode;
  }

  get isActive(): boolean {
    return this.session !== undefined;
  }

  /** 実行中のセッション。光源推定などセッション固有の機能から使う */
  get activeSession(): XRSession | undefined {
    return this.session;
  }

  /** スティック移動の速度 [m/s] を設定する */
  setMoveSpeed(metersPerSecond: number): void {
    this.locomotion.moveSpeed = metersPerSecond;
  }

  async enter(mode: XrMode): Promise<void> {
    if (this.session || !navigator.xr) return;
    const session = await navigator.xr.requestSession(SESSION_MODE[mode], {
      // light-estimation は対応端末でのみ有効になる。optional なので
      // 非対応端末でもセッション自体は張れる。
      optionalFeatures: ['local-floor', 'bounded-floor', 'light-estimation'],
    });
    this.mode = mode;
    this.session = session;
    session.addEventListener('end', () => {
      this.session = undefined;
      this.locomotion.reset();
      this.grab.reset();
      this.options.onExit();
    });
    await this.renderer.xr.setSession(session);

    // 端末が immersive-ar を受け付けても実際には合成しない場合があるため、
    // 実際のブレンドモードを見て確認する ('opaque' なら背景は透けない)。
    if (mode === 'passthrough' && session.environmentBlendMode === 'opaque') {
      console.warn(
        '[VrSession] この端末は immersive-ar に対応していますが、environmentBlendMode が ' +
          "'opaque' のためパススルーは合成されません。",
      );
    }
    this.options.onEnter(mode);
  }

  async exit(): Promise<void> {
    await this.session?.end();
  }

  /** 毎フレーム呼ぶ */
  update(camera: THREE.Camera, dt: number): void {
    if (!this.session) return;
    this.locomotion.update(this.session, camera, dt);

    // GrabController はコントローラ 0/1 の Object3D を参照するため、squeeze も
    // handedness ではなく inputSources の並び順 (= getController の index) で取る。
    const squeezing: [boolean, boolean] = [false, false];
    const sources = Array.from(this.session.inputSources);
    for (let i = 0; i < Math.min(2, sources.length); i++) {
      squeezing[i] = sources[i]?.gamepad?.buttons[BUTTON_SQUEEZE]?.pressed ?? false;
    }
    this.grab.update(squeezing);
  }
}
