import * as THREE from 'three';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';
import { GIZMO_SNAP_DURATION_MS } from '../config';
import { computeInitialView, resolveUpFor } from './autoFit';
import type { SceneBounds } from '../types';

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/**
 * カメラ操作。回転・平行移動・ズームと、ギズモからの軸スナップを扱う。
 *
 * OrbitControls ではなく TrackballControls を使っている。OrbitControls は
 * 内部状態を極座標 (theta, phi) で持ち phi を [0, π] にクランプするため、
 * 真上・真下を越えて回そうとすると 90 度や 180 度で止まってしまう。
 * TrackballControls は視線ベクトルと up をクォータニオンで回すだけで
 * 特異点が無く、どの方向にも回し続けられる。
 */
export class CameraController {
  readonly controls: TrackballControls;
  /** シーン本来の上方向。軸スナップ時の基準に使う */
  private preferredUp = new THREE.Vector3(0, -1, 0);
  private snap: {
    fromPosition: THREE.Vector3;
    toPosition: THREE.Vector3;
    fromUp: THREE.Vector3;
    toUp: THREE.Vector3;
    startedAt: number;
  } | null = null;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
  ) {
    this.controls = new TrackballControls(camera, domElement);
    this.controls.rotateSpeed = 3.0;
    this.controls.zoomSpeed = 1.2;
    this.controls.panSpeed = 0.8;
    this.controls.staticMoving = false;
    this.controls.dynamicDampingFactor = 0.15;
    // 中ボタンもホイールと役割が重複しないよう平行移動に割り当てる
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.PAN,
      RIGHT: THREE.MOUSE.PAN,
    };
    // 'A'/'S'/'D' による状態強制はビューアでは不要なので、使わないコードを割り当てる
    this.controls.keys = ['', '', ''];
  }

  /** シーン全体が画面に収まる位置へカメラを移動する */
  fit(bounds: SceneBounds): void {
    const view = computeInitialView(bounds, this.camera.fov);
    this.preferredUp.copy(bounds.up).normalize();
    this.snap = null;

    this.camera.up.copy(this.preferredUp);
    this.camera.position.copy(view.position);
    this.camera.near = view.near;
    this.camera.far = view.far;
    this.camera.updateProjectionMatrix();
    this.camera.lookAt(view.target);

    this.controls.target.copy(view.target);
    // TrackballControls はズーム量の基準にシーンの大きさを使う
    this.controls.minDistance = bounds.radius * 1e-3;
    this.controls.maxDistance = bounds.radius * 1e3;
    this.controls.update();
  }

  /**
   * 注視点と距離を保ったまま、指定方向からの視点へアニメーションで移動する。
   * ギズモの軸クリックから呼ばれる。
   */
  snapToDirection(direction: THREE.Vector3): void {
    const target = this.controls.target;
    const distance = this.camera.position.distanceTo(target);
    const dir = direction.clone().normalize();
    this.snap = {
      fromPosition: this.camera.position.clone(),
      toPosition: target.clone().addScaledVector(dir, distance),
      fromUp: this.camera.up.clone(),
      toUp: resolveUpFor(dir, this.preferredUp),
      startedAt: performance.now(),
    };
    this.controls.enabled = false;
  }

  update(): void {
    if (this.snap) {
      const s = this.snap;
      const t = Math.min(1, (performance.now() - s.startedAt) / GIZMO_SNAP_DURATION_MS);
      const e = easeInOutCubic(t);
      this.camera.position.lerpVectors(s.fromPosition, s.toPosition, e);
      this.camera.up.copy(s.fromUp).lerp(s.toUp, e).normalize();
      this.camera.lookAt(this.controls.target);
      if (t >= 1) {
        this.camera.up.copy(s.toUp);
        this.snap = null;
        this.controls.enabled = true;
      }
      // アニメーション中は TrackballControls に位置を上書きさせない
      return;
    }
    this.controls.update();
  }

  /** ウィンドウサイズが変わったら呼ぶ。TrackballControls は画面寸法を保持している */
  handleResize(): void {
    this.controls.handleResize();
  }

  setEnabled(enabled: boolean): void {
    this.controls.enabled = enabled;
    if (!enabled) this.snap = null;
  }

  dispose(): void {
    this.controls.dispose();
  }
}
