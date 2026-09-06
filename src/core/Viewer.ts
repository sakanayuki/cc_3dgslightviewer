import * as THREE from 'three';
import { PackedSplats, SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { BACKGROUND_COLORS, DEFAULT_BACKGROUND } from '../config';
import { CameraController } from '../camera/CameraController';
import { AxisGizmo } from '../gizmo/AxisGizmo';
import { VrSession } from '../vr/VrSession';
import { computeVrPlacement } from '../vr/placement';
import { S } from '../ui/strings';
import { ViewerError } from '../types';
import type { SceneBounds } from '../types';

/**
 * three.js のシーンとレンダーループの所有者。
 *
 * シーングラフは 2 つの Group に分かれる (設計書 3.1):
 *   - rig:       カメラの親。VR のスティック移動とスナップ回転で動く (プレイヤー側)
 *   - worldRoot: SplatMesh の親。VR の両手グラブで動く (世界側)
 * この分離により、移動操作とグラブ操作が互いの座標系を壊さない。
 */
export class Viewer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly rig = new THREE.Group();
  readonly worldRoot = new THREE.Group();
  readonly gizmo = new AxisGizmo();
  readonly camControls: CameraController;
  readonly vr: VrSession;

  private readonly sparkRenderer: SparkRenderer;
  private mesh: SplatMesh | null = null;
  /** 直近の自動フィット結果。VR 入場時の配置計算に使う */
  private bounds: SceneBounds | null = null;
  private lastFrameTime = performance.now();
  private vrActive = false;

  constructor(
    readonly canvas: HTMLCanvasElement,
    onVrChange: (active: boolean) => void,
  ) {
    const context = canvas.getContext('webgl2');
    if (!context) throw new ViewerError(S.errNoWebgl2);

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      context,
      // Spark 公式の指示: 3DGS では画質向上に寄与せず性能を大きく落とす
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.camera = new THREE.PerspectiveCamera(60, 1, 0.01, 1000);
    this.rig.add(this.camera);
    this.scene.add(this.rig, this.worldRoot);

    this.sparkRenderer = new SparkRenderer({ renderer: this.renderer });
    this.scene.add(this.sparkRenderer);

    this.camControls = new CameraController(this.camera, canvas);
    this.setBackground(BACKGROUND_COLORS[DEFAULT_BACKGROUND]!.value);

    this.vr = new VrSession({
      renderer: this.renderer,
      rig: this.rig,
      worldRoot: this.worldRoot,
      onEnter: () => {
        this.vrActive = true;
        this.gizmo.visible = false;
        this.camControls.setEnabled(false);
        this.applyVrPlacement();
        onVrChange(true);
      },
      onExit: () => {
        this.vrActive = false;
        this.gizmo.visible = true;
        this.camControls.setEnabled(true);
        this.resetWorldRoot();
        onVrChange(false);
      },
    });

    this.resize();
    window.addEventListener('resize', () => this.resize());
    // OrbitControls も同じ canvas に pointerdown を張るため、キャプチャ段階で
    // 先に受けて stopImmediatePropagation する。stopPropagation では同一要素の
    // 他のリスナーを止められず、ギズモ上のドラッグでシーンが回ってしまう。
    canvas.addEventListener('pointerdown', (e) => this.onPointerDown(e), { capture: true });
  }

  private onPointerDown(event: PointerEvent): void {
    if (this.vrActive) return;
    const rect = this.canvas.getBoundingClientRect();
    if (!this.gizmo.containsPoint(event.clientX, event.clientY, rect)) return;
    // ギズモ矩形内の操作は OrbitControls に渡さない
    event.stopImmediatePropagation();
    event.preventDefault();
    const dir = this.gizmo.pick(event.clientX, event.clientY, rect);
    if (dir) this.camControls.snapToDirection(dir);
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
    // TrackballControls は画面寸法をキャッシュしているので更新が要る
    this.camControls.handleResize();
  }

  setBackground(color: string): void {
    this.scene.background = new THREE.Color(color);
  }

  /** 描画中の SplatMesh を差し替える。旧メッシュは破棄する */
  setSplats(splats: PackedSplats): SplatMesh {
    this.clearSplats();
    const mesh = new SplatMesh({ packedSplats: splats });
    this.worldRoot.add(mesh);
    this.mesh = mesh;
    return mesh;
  }

  clearSplats(): void {
    if (!this.mesh) return;
    this.worldRoot.remove(this.mesh);
    this.mesh.dispose();
    this.mesh = null;
  }

  /** 自動フィット */
  fitTo(bounds: SceneBounds): void {
    this.bounds = bounds;
    this.camControls.fit(bounds);
    this.resetWorldRoot();
    if (this.vrActive) this.applyVrPlacement();
  }

  private resetWorldRoot(): void {
    this.worldRoot.position.set(0, 0, 0);
    this.worldRoot.quaternion.identity();
    this.worldRoot.scale.setScalar(1);
  }

  /**
   * VR 入場時にモデルを XR 空間へ配置し直す。
   *
   * VR ではカメラ姿勢がヘッドセットから与えられるため camera.up が効かない。
   * 「-Y が上・+X が右」を VR でも成立させるには worldRoot 側を回すしかない。
   * あわせて、3DGS の単位を持たない座標スケールを実寸に正規化し、
   * 目の前の見やすい位置へ移動する。
   */
  private applyVrPlacement(): void {
    if (!this.bounds) return;
    const placement = computeVrPlacement(this.bounds);
    this.worldRoot.position.copy(placement.position);
    this.worldRoot.quaternion.copy(placement.quaternion);
    this.worldRoot.scale.setScalar(placement.scale);
  }

  start(): void {
    this.renderer.setAnimationLoop(() => this.frame());
  }

  private frame(): void {
    const now = performance.now();
    const dt = Math.min(0.1, (now - this.lastFrameTime) / 1000);
    this.lastFrameTime = now;

    if (this.vrActive) {
      this.vr.update(this.camera, dt);
    } else {
      this.camControls.update();
    }

    this.renderer.render(this.scene, this.camera);

    // ギズモはメイン描画の後に、深度をクリアしてから重ねる
    if (!this.vrActive) this.gizmo.render(this.renderer, this.camera);
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.clearSplats();
    this.gizmo.dispose();
    this.camControls.dispose();
    this.renderer.dispose();
  }
}
