import type { PackedSplats } from '@sparkjsdev/spark';
import { DEFAULT_LEVEL } from './config';
import { computeBounds, sampleCenters } from './camera/autoFit';
import { effectiveMaxSh, selectIndices } from './core/levels';
import { buildSubset, detectSourceMaxSh } from './core/subset';
import {
  FullSplatsProvider,
  buildRankingAsync,
  detectFileType,
  parseFile,
  toViewerError,
} from './core/SplatLoaderService';
import { Viewer } from './core/Viewer';
import { ControlPanel } from './ui/ControlPanel';
import { FileDropZone } from './ui/FileDropZone';
import { ProgressOverlay } from './ui/ProgressOverlay';
import { S } from './ui/strings';
import { ViewerError } from './types';
import type { LoadProgress, LoadedModel, XrMode } from './types';
import './styles.css';

class App {
  private readonly viewer: Viewer;
  private readonly overlay = new ProgressOverlay();
  private readonly panel: ControlPanel;
  private readonly dropZone: FileDropZone;

  private model: LoadedModel | null = null;
  private provider: FullSplatsProvider | null = null;
  private busy = false;

  constructor(root: HTMLElement, canvas: HTMLCanvasElement) {
    this.viewer = new Viewer(canvas, (active) => this.panel.setVrActive(active));

    this.panel = new ControlPanel({
      onLevelChange: (level) => void this.changeLevel(level),
      onBackgroundChange: (color) => this.viewer.setBackground(color),
      onOpenAnother: () => this.reset(),
      onToggleVr: (mode) => void this.toggleVr(mode),
    });

    this.dropZone = new FileDropZone((file) => void this.load(file));
    this.dropZone.attachGlobalDragDrop(document.body);

    root.append(this.dropZone.root, this.panel.root, this.overlay.root);

    this.viewer.start();
    void this.viewer.checkXrSupport().then((support) => this.panel.setXrSupport(support));
  }

  private progress = (p: LoadProgress): void => {
    const file = this.model?.file ?? this.pendingFile;
    if (file) this.overlay.showProgress(file.name, file.size, p);
  };

  private pendingFile: File | null = null;

  /** ファイルを読み込んで既定レベルで表示する (設計書 8.2) */
  private async load(file: File): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.pendingFile = file;
    this.dropZone.setVisible(false);
    this.overlay.showProgress(file.name, file.size, { phase: 'reading', ratio: 0 });

    let full: PackedSplats | null = null;
    try {
      // 1. 形式判定 (大きなファイルを読む前に弾く)
      const fileType = await detectFileType(file);

      // 2. パース
      full = await parseFile(file, fileType, this.progress);

      // 3. 重要度スコアリング
      const ranking = await buildRankingAsync(full, this.progress);

      // 4. バウンディング推定
      this.progress({ phase: 'analyzing', ratio: 1 });
      const bounds = computeBounds(sampleCenters(full));
      const sourceMaxSh = detectSourceMaxSh(full);

      // 5. サブセット構築 (既定レベル)
      this.progress({ phase: 'preparing' });
      await new Promise((r) => setTimeout(r, 0));
      const subset = buildSubset(
        full,
        selectIndices(ranking, DEFAULT_LEVEL),
        effectiveMaxSh(DEFAULT_LEVEL, sourceMaxSh),
      );

      this.provider = new FullSplatsProvider(file, fileType);
      this.provider.adoptInitial(full);

      this.model = {
        file,
        ranking,
        bounds,
        sourceMaxSh,
        level: DEFAULT_LEVEL,
        renderedSplats: subset.numSplats,
      };

      // 6. 描画 + 自動フィット
      this.viewer.setSplats(subset);
      this.viewer.fitTo(bounds);

      this.panel.setModel(file.name, subset.numSplats, DEFAULT_LEVEL);
      this.panel.setVisible(true);
      this.overlay.hide();
    } catch (e) {
      this.failed(toViewerError(e));
    } finally {
      // release() は常駐モードでキャッシュ対象なら破棄しない
      if (full) {
        if (this.provider) this.provider.release(full);
        else full.dispose();
      }
      this.pendingFile = null;
      this.busy = false;
    }
  }

  /** 解像度レベルを切り替える (設計書 8.3) */
  private async changeLevel(level: number): Promise<void> {
    const model = this.model;
    const provider = this.provider;
    if (!model || !provider || this.busy || level === model.level) return;

    this.busy = true;
    this.panel.setBusy(true);
    this.overlay.showProgress(model.file.name, model.file.size, { phase: 'reading', ratio: 0 });

    let full: PackedSplats | null = null;
    try {
      full = await provider.acquire(this.progress);

      // 再パース結果が初回と食い違ったらランキングを作り直す (パーサの非決定性への防御)
      let ranking = model.ranking;
      if (full.numSplats !== ranking.numSplats) {
        console.warn(
          `[main] 再パースで splat 数が変化しました (${ranking.numSplats} -> ${full.numSplats})。ランキングを再計算します。`,
        );
        ranking = await buildRankingAsync(full, this.progress);
        model.ranking = ranking;
      }

      this.progress({ phase: 'preparing' });
      await new Promise((r) => setTimeout(r, 0));
      const subset = buildSubset(
        full,
        selectIndices(ranking, level),
        effectiveMaxSh(level, model.sourceMaxSh),
      );

      // カメラは動かさない。レベル間の画質比較のため視点を維持する
      this.viewer.setSplats(subset);
      model.level = level;
      model.renderedSplats = subset.numSplats;
      this.panel.setModel(model.file.name, subset.numSplats, level);
      this.overlay.hide();
    } catch (e) {
      this.failed(toViewerError(e));
    } finally {
      if (full) provider.release(full);
      this.panel.setBusy(false);
      this.busy = false;
    }
  }

  private async toggleVr(mode: XrMode): Promise<void> {
    try {
      if (this.viewer.vr.isActive) await this.viewer.vr.exit();
      else await this.viewer.vr.enter(mode);
    } catch (e) {
      console.error('[main] VR セッションの開始に失敗しました', e);
      this.overlay.showError(S.errXrStartFailed, () => this.overlay.hide());
    }
  }

  private failed(error: ViewerError): void {
    console.error('[main]', error.message, error.cause ?? '');
    this.viewer.clearSplats();
    this.panel.setVisible(false);
    this.overlay.showError(error.message, () => this.reset());
  }

  private reset(): void {
    this.viewer.clearSplats();
    this.provider?.dispose();
    this.provider = null;
    this.model = null;
    this.panel.setVisible(false);
    this.overlay.hide();
    this.dropZone.setVisible(true);
  }
}

function boot(): void {
  const root = document.getElementById('app');
  const canvas = document.getElementById('canvas') as HTMLCanvasElement | null;
  if (!root || !canvas) throw new Error('#app / #canvas が見つかりません');
  try {
    new App(root, canvas);
  } catch (e) {
    const message = e instanceof ViewerError ? e.message : S.errNoWebgl2;
    root.innerHTML = `<div class="overlay"><div class="overlay__box"><div class="overlay__title"></div></div></div>`;
    root.querySelector('.overlay__title')!.textContent = message;
  }
}

boot();
