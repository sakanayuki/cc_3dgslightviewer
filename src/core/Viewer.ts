import * as THREE from 'three';
import { PackedSplats, SparkRenderer, SplatMesh } from '@sparkjsdev/spark';
import { BACKGROUND_COLORS, DEFAULT_BACKGROUND } from '../config';
import { OrbitCameraController } from '../camera/OrbitCameraController';
import { AxisGizmo } from '../gizmo/AxisGizmo';
import { VrSession } from '../vr/VrSession';
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
  readonly orbit: OrbitCameraController;
  readonly vr: VrSession;

  private readonly sparkRenderer: SparkRenderer;
  private mesh: SplatMesh | null = null;
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

    this.orbit = new OrbitCameraController(this.camera, canvas);
    this.setBackground(BACKGROUND_COLORS[DEFAULT_BACKGROUND]!.value);

    this.vr = new VrSession({
      renderer: this.renderer,
      rig: this.rig,
      worldRoot: this.worldRoot,
      onEnter: () => {
        this.vrActive = true;
        this.gizmo.visible = false;
        this.orbit.setEnabled(false);
        onVrChange(true);
      },
      onExit: () => {
        this.vrActive = false;
        this.gizmo.visible = true;
        this.orbit.setEnabled(true);
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
    if (dir) this.orbit.snapToDirection(dir);
  }

  resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / Math.max(1, h);
    this.camera.updateProjectionMatrix();
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

  /** 自動フィット。VR の移動速度もシーンのスケールに合わせる */
  fitTo(bounds: SceneBounds): void {
    this.orbit.fit(bounds);
    this.vr.setSceneRadius(bounds.radius);
    this.worldRoot.position.set(0, 0, 0);
    this.worldRoot.quaternion.identity();
    this.worldRoot.scale.setScalar(1);
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
      this.orbit.update();
    }

    this.renderer.render(this.scene, this.camera);

    // ギズモはメイン描画の後に、深度をクリアしてから重ねる
    if (!this.vrActive) this.gizmo.render(this.renderer, this.camera);
  }

  dispose(): void {
    this.renderer.setAnimationLoop(null);
    this.clearSplats();
    this.gizmo.dispose();
    this.orbit.dispose();
    this.renderer.dispose();
  }
}
