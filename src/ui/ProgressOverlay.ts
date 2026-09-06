import { S, formatBytes } from './strings';
import type { LoadPhase, LoadProgress } from '../types';

const PHASE_LABEL: Record<LoadPhase, string> = {
  reading: S.phaseReading,
  analyzing: S.phaseAnalyzing,
  preparing: S.phasePreparing,
};

/** 読み込み進捗とエラーを表示するモーダルオーバーレイ */
export class ProgressOverlay {
  readonly root: HTMLElement;
  private readonly title: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly barWrap: HTMLElement;
  private readonly detail: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  private onClose: (() => void) | null = null;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'overlay';
    this.root.hidden = true;

    const box = document.createElement('div');
    box.className = 'overlay__box';

    this.title = document.createElement('div');
    this.title.className = 'overlay__title';

    this.barWrap = document.createElement('div');
    this.barWrap.className = 'overlay__bar';
    this.bar = document.createElement('div');
    this.bar.className = 'overlay__bar-fill';
    this.barWrap.append(this.bar);

    this.detail = document.createElement('div');
    this.detail.className = 'overlay__detail';

    this.closeButton = document.createElement('button');
    this.closeButton.className = 'button';
    this.closeButton.textContent = S.close;
    this.closeButton.hidden = true;
    this.closeButton.addEventListener('click', () => {
      this.hide();
      this.onClose?.();
    });

    box.append(this.title, this.barWrap, this.detail, this.closeButton);
    this.root.append(box);
  }

  showProgress(fileName: string, fileSize: number, progress: LoadProgress): void {
    this.root.hidden = false;
    this.root.classList.remove('overlay--error');
    this.closeButton.hidden = true;
    this.barWrap.hidden = false;

    const pct = progress.ratio === undefined ? null : Math.round(progress.ratio * 100);
    this.title.textContent =
      pct === null ? PHASE_LABEL[progress.phase] : `${PHASE_LABEL[progress.phase]} ${pct}%`;
    this.bar.style.width = pct === null ? '100%' : `${pct}%`;
    this.bar.classList.toggle('overlay__bar-fill--indeterminate', pct === null);
    this.detail.textContent = `${fileName} (${formatBytes(fileSize)})`;
  }

  showError(message: string, onClose: () => void): void {
    this.root.hidden = false;
    this.root.classList.add('overlay--error');
    this.barWrap.hidden = true;
    this.title.textContent = message;
    this.detail.textContent = '';
    this.closeButton.hidden = false;
    this.onClose = onClose;
  }

  hide(): void {
    this.root.hidden = true;
  }
}
