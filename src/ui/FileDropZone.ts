import { S } from './strings';

/** 初期状態で表示する、ファイルのドロップ / 選択を受け付ける領域 */
export class FileDropZone {
  readonly root: HTMLElement;
  private readonly input: HTMLInputElement;

  constructor(private readonly onFile: (file: File) => void) {
    this.root = document.createElement('div');
    this.root.className = 'dropzone';

    const box = document.createElement('div');
    box.className = 'dropzone__box';

    const title = document.createElement('p');
    title.className = 'dropzone__title';
    title.textContent = S.dropTitle;

    const or = document.createElement('p');
    or.className = 'dropzone__or';
    or.textContent = S.dropOr;

    const button = document.createElement('button');
    button.className = 'button button--primary';
    button.textContent = S.dropButton;

    this.input = document.createElement('input');
    this.input.type = 'file';
    this.input.accept = '.ply,.splat';
    this.input.hidden = true;
    button.addEventListener('click', () => this.input.click());
    this.input.addEventListener('change', () => {
      const file = this.input.files?.[0];
      if (file) this.onFile(file);
      this.input.value = '';
    });

    const formats = document.createElement('p');
    formats.className = 'dropzone__formats';
    formats.textContent = S.dropFormats;

    const privacy = document.createElement('p');
    privacy.className = 'dropzone__privacy';
    privacy.append(S.dropPrivacy1, document.createElement('br'), S.dropPrivacy2);

    box.append(title, or, button, this.input, formats, privacy);
    this.root.append(box);
  }

  /** ページ全体でのドラッグ&ドロップを受け付ける */
  attachGlobalDragDrop(target: HTMLElement): void {
    const stop = (e: DragEvent): void => {
      e.preventDefault();
      e.stopPropagation();
    };
    target.addEventListener('dragover', (e) => {
      stop(e);
      this.root.classList.add('dropzone--active');
    });
    target.addEventListener('dragleave', (e) => {
      stop(e);
      this.root.classList.remove('dropzone--active');
    });
    target.addEventListener('drop', (e) => {
      stop(e);
      this.root.classList.remove('dropzone--active');
      const file = e.dataTransfer?.files?.[0];
      if (file) this.onFile(file);
    });
  }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
  }
}
