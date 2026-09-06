import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GIZMO_SNAP_DURATION_MS } from '../config';
import { computeInitialView } from './autoFit';
import type { SceneBounds } from '../types';

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

/** OrbitControls のラッパ。自動フィットと軸スナップのアニメーションを持つ */
export class OrbitCameraController {
  readonly controls: OrbitControls;
  private snap: {
    from: THREE.Vector3;
    to: THREE.Vector3;
    startedAt: number;
  } | null = null;

  constructor(
    private readonly camera: THREE.PerspectiveCamera,
    domElement: HTMLElement,
  ) {
    this.controls = new OrbitControls(camera, domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = true;
  }

  /** シーン全体が画面に収まる位置へカメラを移動する */
  fit(bounds: SceneBounds): void {
    const view = computeInitialView(bounds, this.camera.fov);
    this.camera.up.copy(bounds.up);
    this.camera.position.copy(view.position);
    this.camera.near = view.near;
    this.camera.far = view.far;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(view.target);
    this.controls.update();
  }

  /**
   * 注視点と距離を保ったまま、指定方向からの視点へアニメーションで移動する。
   * ギズモの軸クリックから呼ばれる。
   */
  snapToDirection(direction: THREE.Vector3): void {
    const target = this.controls.target;
    const distance = this.camera.position.distanceTo(target);
    const to = target.clone().addScaledVector(direction.clone().normalize(), distance);
    this.snap = { from: this.camera.position.clone(), to, startedAt: performance.now() };
    this.controls.enabled = false;
  }

  update(): void {
    if (this.snap) {
      const t = Math.min(1, (performance.now() - this.snap.startedAt) / GIZMO_SNAP_DURATION_MS);
      this.camera.position.lerpVectors(this.snap.from, this.snap.to, easeInOutCubic(t));
      this.camera.lookAt(this.controls.target);
      if (t >= 1) {
        this.snap = null;
        this.controls.enabled = true;
      }
    }
    this.controls.update();
  }

  setEnabled(enabled: boolean): void {
    this.controls.enabled = enabled;
    if (!enabled) this.snap = null;
  }

  dispose(): void {
    this.controls.dispose();
  }
}
