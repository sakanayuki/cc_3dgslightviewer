import { BACKGROUND_COLORS, DEFAULT_BACKGROUND, LEVELS } from '../config';
import { S, formatCount } from './strings';

export interface ControlPanelCallbacks {
  onLevelChange: (level: number) => void;
  onBackgroundChange: (color: string) => void;
  onOpenAnother: () => void;
  onToggleVr: () => void;
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
    this.vrButton.addEventListener('click', () => this.cb.onToggleVr());

    actions.append(openAnother, this.vrButton);
    this.root.append(levelRow, bgRow, this.note, hr, this.info, this.fileName, actions);
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

  setVrAvailable(available: boolean): void {
    this.vrButton.hidden = !available;
  }

  /** VR 中は解像度を変更できない (設計書 11.1) */
  setVrActive(active: boolean): void {
    this.vrButton.textContent = active ? S.buttonExitVr : S.buttonEnterVr;
    this.select.disabled = active;
    this.note.hidden = !active;
    this.note.textContent = active ? S.vrResolutionLocked : '';
  }
}
