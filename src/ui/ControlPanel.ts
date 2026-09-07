import { BACKGROUND_COLORS, DEFAULT_BACKGROUND, LEVELS } from '../config';
import { S, formatCount } from './strings';
import type { XrMode, XrSupport } from '../types';

export interface ControlPanelCallbacks {
  onLevelChange: (level: number) => void;
  onBackgroundChange: (color: string) => void;
  onOpenAnother: () => void;
  onToggleVr: (mode: XrMode) => void;
}

/** 左下のコントロールパネル */
export class ControlPanel {
  readonly root: HTMLElement;
  private readonly select: HTMLSelectElement;
  private readonly info: HTMLElement;
  private readonly fileName: HTMLElement;
  private readonly note: HTMLElement;
  private readonly vrButton: HTMLButtonElement;
  private readonly bgButtons: HTMLButtonElement[] = [];
  private readonly xrRow: HTMLElement;
  private readonly xrSelect: HTMLSelectElement;
  private readonly xrNote: HTMLElement;
  private support: XrSupport = { vr: false, passthrough: false };

  constructor(private readonly cb: ControlPanelCallbacks) {
    this.root = document.createElement('div');
    this.root.className = 'panel';
    this.root.hidden = true;

    // 解像度
    const levelRow = document.createElement('div');
    levelRow.className = 'panel__row';
    const levelLabel = document.createElement('label');
    levelLabel.textContent = S.labelResolution;
    levelLabel.className = 'panel__label';
    this.select = document.createElement('select');
    this.select.className = 'panel__select';
    LEVELS.forEach((lv) => {
      const opt = document.createElement('option');
      opt.value = String(lv.id);
      opt.textContent = lv.label;
      this.select.append(opt);
    });
    this.select.addEventListener('change', () => {
      this.cb.onLevelChange(Number(this.select.value));
    });
    levelLabel.htmlFor = 'level-select';
    this.select.id = 'level-select';
    levelRow.append(levelLabel, this.select);

    // 背景色
    const bgRow = document.createElement('div');
    bgRow.className = 'panel__row';
    const bgLabel = document.createElement('span');
    bgLabel.textContent = S.labelBackground;
    bgLabel.className = 'panel__label';
    const bgGroup = document.createElement('div');
    bgGroup.className = 'panel__swatches';
    BACKGROUND_COLORS.forEach((c, i) => {
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = c.value;
      b.title = c.label;
      b.setAttribute('aria-label', `${S.labelBackground}: ${c.label}`);
      b.addEventListener('click', () => {
        this.setActiveBackground(i);
        this.cb.onBackgroundChange(c.value);
      });
      this.bgButtons.push(b);
      bgGroup.append(b);
    });
    bgRow.append(bgLabel, bgGroup);
    this.setActiveBackground(DEFAULT_BACKGROUND);

    // VR 背景 (通常 / パススルー)
    this.xrRow = document.createElement('div');
    this.xrRow.className = 'panel__row';
    this.xrRow.hidden = true;
    const xrLabel = document.createElement('label');
    xrLabel.textContent = S.labelXrBackground;
    xrLabel.className = 'panel__label';
    xrLabel.htmlFor = 'xr-background-select';
    this.xrSelect = document.createElement('select');
    this.xrSelect.className = 'panel__select';
    this.xrSelect.id = 'xr-background-select';
    for (const [value, label] of [
      ['vr', S.xrBackgroundOpaque],
      ['passthrough', S.xrBackgroundPassthrough],
    ] as const) {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = label;
      this.xrSelect.append(opt);
    }
    this.xrRow.append(xrLabel, this.xrSelect);

    this.xrNote = document.createElement('p');
    this.xrNote.className = 'panel__note panel__note--muted';
    this.xrNote.hidden = true;

    // 注記 (VR中の制限など)
    this.note = document.createElement('p');
    this.note.className = 'panel__note';
    this.note.hidden = true;

    const hr = document.createElement('hr');
    hr.className = 'panel__hr';

    this.info = document.createElement('div');
    this.info.className = 'panel__info';
    this.fileName = document.createElement('div');
    this.fileName.className = 'panel__filename';

    const actions = document.createElement('div');
    actions.className = 'panel__actions';
    const openAnother = document.createElement('button');
    openAnother.className = 'button';
    openAnother.textContent = S.buttonOpenAnother;
    openAnother.addEventListener('click', () => this.cb.onOpenAnother());

    this.vrButton = document.createElement('button');
    this.vrButton.className = 'button button--vr';
    this.vrButton.textContent = S.buttonEnterVr;
    this.vrButton.hidden = true;
    this.vrButton.addEventListener('click', () => this.cb.onToggleVr(this.xrMode));

    actions.append(openAnother, this.vrButton);
    this.root.append(
      levelRow,
      bgRow,
      this.xrRow,
      this.xrNote,
      this.note,
      hr,
      this.info,
      this.fileName,
      actions,
    );
  }

  private setActiveBackground(index: number): void {
    this.bgButtons.forEach((b, i) => b.classList.toggle('swatch--active', i === index));
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }

  setModel(fileName: string, renderedSplats: number, level: number): void {
    this.fileName.textContent = fileName;
    this.info.textContent = formatCount(renderedSplats) + S.splatsSuffix;
    this.select.value = String(level);
  }

  setBusy(busy: boolean): void {
    this.select.disabled = busy;
  }

  /**
   * 実際に要求する XR セッションの種類。
   *
   * ヘッドセット (VR と パススルーの両対応) では「VR背景」の選択に従う。
   * スマートフォンは immersive-ar にしか対応しないため、選択に関係なく
   * 常に passthrough (= immersive-ar) を返す。ここを取り違えると、
   * スマホで immersive-vr を要求して必ず失敗する。
   */
  get xrMode(): XrMode {
    if (!this.support.vr) return 'passthrough';
    if (!this.support.passthrough) return 'vr';
    return this.xrSelect.value === 'passthrough' ? 'passthrough' : 'vr';
  }

  /** ヘッドセットの VR ではなく、スマートフォンの AR として扱うか */
  private get isArOnly(): boolean {
    return !this.support.vr && this.support.passthrough;
  }

  /**
   * 端末の XR 対応状況を反映する。
   *
   * - ヘッドセット (VR 対応)      : 「VRで見る」。両対応なら背景を選べる
   * - スマートフォン (AR のみ対応) : 「ARで見る」。背景は常にカメラ映像なので選択肢を出さない
   * - 非対応                      : ボタンごと出さない
   *
   * パススルー / AR は immersive-ar として提供されるため、VR とは別に判定する。
   */
  setXrSupport(support: XrSupport): void {
    this.support = support;
    const available = support.vr || support.passthrough;
    this.vrButton.hidden = !available;
    this.vrButton.textContent = this.isArOnly ? S.buttonEnterAr : S.buttonEnterVr;

    // 背景の選択はヘッドセットで両方に対応しているときだけ意味がある
    const canChooseBackground = support.vr && support.passthrough;
    this.xrRow.hidden = !canChooseBackground;
    if (!canChooseBackground) this.xrSelect.value = support.vr ? 'vr' : 'passthrough';

    if (!available) {
      this.xrNote.hidden = true;
      this.xrNote.textContent = '';
      return;
    }
    // AR のみなら使い方、VR のみならパススルー非対応の理由を出す
    const note = this.isArOnly
      ? S.arHint
      : support.passthrough
        ? ''
        : S.xrPassthroughUnsupported;
    this.xrNote.hidden = note === '';
    this.xrNote.textContent = note;
  }

  /** VR / AR 中は解像度を変更できない (設計書 11.1) */
  setVrActive(active: boolean): void {
    const ar = this.isArOnly;
    this.vrButton.textContent = active
      ? ar
        ? S.buttonExitAr
        : S.buttonExitVr
      : ar
        ? S.buttonEnterAr
        : S.buttonEnterVr;
    this.select.disabled = active;
    this.xrSelect.disabled = active;
    this.note.hidden = !active;
    this.note.textContent = active ? (ar ? S.arResolutionLocked : S.vrResolutionLocked) : '';
  }
}
