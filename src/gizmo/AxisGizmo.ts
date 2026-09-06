import * as THREE from 'three';
import { GIZMO_MARGIN, GIZMO_SIZE } from '../config';

const AXES = [
  { name: 'X', dir: new THREE.Vector3(1, 0, 0), color: 0xff4d4d, positive: true },
  { name: 'X', dir: new THREE.Vector3(-1, 0, 0), color: 0xff4d4d, positive: false },
  { name: 'Y', dir: new THREE.Vector3(0, 1, 0), color: 0x4dff88, positive: true },
  { name: 'Y', dir: new THREE.Vector3(0, -1, 0), color: 0x4dff88, positive: false },
  { name: 'Z', dir: new THREE.Vector3(0, 0, 1), color: 0x4d9dff, positive: true },
  { name: 'Z', dir: new THREE.Vector3(0, 0, -1), color: 0x4d9dff, positive: false },
] as const;

const AXIS_LENGTH = 1;
const BALL_RADIUS = 0.22;
const CAMERA_DISTANCE = 4;

function makeLabelTexture(text: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#0b0b0b';
  ctx.font = 'bold 44px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 32, 34);
  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * 画面右上に XYZ 軸を表示するギズモ。
 *
 * メインシーンとは別の Scene / OrthographicCamera を持ち、メイン描画の後に
 * 右上のビューポートへ重ねて描画する。splat は半透明で深度を安定して書かないため、
 * 描画前の clearDepth() が必須。
 */
export class AxisGizmo {
  readonly scene = new THREE.Scene();
  private readonly camera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 100);
  private readonly balls: THREE.Mesh[] = [];
  private readonly raycaster = new THREE.Raycaster();
  private readonly disposables: { dispose(): void }[] = [];
  visible = true;

  constructor() {
    const ballGeom = new THREE.SphereGeometry(BALL_RADIUS, 16, 12);
    this.disposables.push(ballGeom);

    for (const axis of AXES) {
      const end = axis.dir.clone().multiplyScalar(AXIS_LENGTH);

      if (axis.positive) {
        const lineGeom = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(0, 0, 0),
          end,
        ]);
        const lineMat = new THREE.LineBasicMaterial({ color: axis.color });
        this.scene.add(new THREE.Line(lineGeom, lineMat));
        this.disposables.push(lineGeom, lineMat);
      }

      const mat = new THREE.MeshBasicMaterial({
        color: axis.color,
        transparent: !axis.positive,
        opacity: axis.positive ? 1 : 0.4,
      });
      const ball = new THREE.Mesh(ballGeom, mat);
      ball.position.copy(end);
      ball.userData['direction'] = axis.dir.clone();
      this.scene.add(ball);
      this.balls.push(ball);
      this.disposables.push(mat);

      if (axis.positive) {
        const tex = makeLabelTexture(axis.name);
        const spriteMat = new THREE.SpriteMaterial({ map: tex, depthTest: false });
        const sprite = new THREE.Sprite(spriteMat);
        sprite.scale.setScalar(BALL_RADIUS * 1.8);
        sprite.position.copy(end);
        this.scene.add(sprite);
        this.disposables.push(tex, spriteMat);
      }
    }
  }

  /** ギズモが占める矩形 (CSS ピクセル、左上原点) */
  getRect(canvasWidth: number): { left: number; top: number; size: number } {
    return { left: canvasWidth - GIZMO_SIZE - GIZMO_MARGIN, top: GIZMO_MARGIN, size: GIZMO_SIZE };
  }

  /** メインカメラの姿勢に追従させる */
  sync(mainCamera: THREE.PerspectiveCamera): void {
    const dir = new THREE.Vector3();
    mainCamera.getWorldDirection(dir);
    this.camera.position.copy(dir).multiplyScalar(-CAMERA_DISTANCE);
    this.camera.up.copy(mainCamera.up);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateMatrixWorld();
  }

  /** メインシーン描画後に呼ぶ。renderer の状態は呼び出し前に復元する */
  render(renderer: THREE.WebGLRenderer, mainCamera: THREE.PerspectiveCamera): void {
    if (!this.visible) return;
    this.sync(mainCamera);

    const size = new THREE.Vector2();
    renderer.getSize(size);
    const px = GIZMO_SIZE;
    const x = size.x - px - GIZMO_MARGIN;
    // WebGL のビューポートは左下原点
    const y = size.y - px - GIZMO_MARGIN;

    const prevAutoClear = renderer.autoClear;
    renderer.autoClear = false;
    renderer.clearDepth(); // splat に埋もれないために必須
    renderer.setViewport(x, y, px, px);
    renderer.setScissor(x, y, px, px);
    renderer.setScissorTest(true);
    renderer.render(this.scene, this.camera);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, size.x, size.y);
    renderer.autoClear = prevAutoClear;
  }

  /**
   * ギズモ矩形内のクリックを判定する。
   * @returns ヒットした軸方向。ギズモ外またはヒットなしなら null
   */
  pick(clientX: number, clientY: number, canvasRect: DOMRect): THREE.Vector3 | null {
    if (!this.visible) return null;
    const rect = this.getRect(canvasRect.width);
    const lx = clientX - canvasRect.left - rect.left;
    const ly = clientY - canvasRect.top - rect.top;
    if (lx < 0 || ly < 0 || lx > rect.size || ly > rect.size) return null;

    const ndc = new THREE.Vector2((lx / rect.size) * 2 - 1, -((ly / rect.size) * 2 - 1));
    this.raycaster.setFromCamera(ndc, this.camera);
    const hits = this.raycaster.intersectObjects(this.balls, false);
    const first = hits[0];
    if (!first) return null;
    return (first.object.userData['direction'] as THREE.Vector3).clone();
  }

  /** クリック位置がギズモ矩形内かどうか (OrbitControls へ渡すかの判定に使う) */
  containsPoint(clientX: number, clientY: number, canvasRect: DOMRect): boolean {
    if (!this.visible) return false;
    const rect = this.getRect(canvasRect.width);
    const lx = clientX - canvasRect.left - rect.left;
    const ly = clientY - canvasRect.top - rect.top;
    return lx >= 0 && ly >= 0 && lx <= rect.size && ly <= rect.size;
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
  }
}
