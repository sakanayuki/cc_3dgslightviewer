import * as THREE from 'three';
import { VR_FIXED_FOVEATION, VR_FRAMEBUFFER_SCALE } from '../config';
import { GrabController } from './GrabController';
import { Locomotion } from './Locomotion';

/** xr-standard のボタン番号: 1 = squeeze (グリップ) */
const BUTTON_SQUEEZE = 1;

export interface VrSessionOptions {
  renderer: THREE.WebGLRenderer;
  /** 移動対象。カメラの親 */
  rig: THREE.Group;
  /** グラブ対象。SplatMesh の親 */
  worldRoot: THREE.Group;
  onEnter: () => void;
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
  private supported = false;

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

  /** WebXR VR に対応しているかを調べる。対応していなければボタンを出さない */
  async checkSupport(): Promise<boolean> {
    const xr = navigator.xr;
    if (!xr) return false;
    try {
      this.supported = await xr.isSessionSupported('immersive-vr');
    } catch {
      this.supported = false;
    }
    return this.supported;
  }

  get isSupported(): boolean {
    return this.supported;
  }

  get isActive(): boolean {
    return this.session !== undefined;
  }

  /** スティック移動の速度 [m/s] を設定する */
  setMoveSpeed(metersPerSecond: number): void {
    this.locomotion.moveSpeed = metersPerSecond;
  }

  async enter(): Promise<void> {
    if (this.session || !navigator.xr) return;
    const session = await navigator.xr.requestSession('immersive-vr', {
      optionalFeatures: ['local-floor', 'bounded-floor'],
    });
    this.session = session;
    session.addEventListener('end', () => {
      this.session = undefined;
      this.locomotion.reset();
      this.grab.reset();
      this.options.onExit();
    });
    await this.renderer.xr.setSession(session);
    this.options.onEnter();
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
