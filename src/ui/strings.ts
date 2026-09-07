/** 画面に出る日本語文言の集約。多言語化する場合はここを辞書化する */
export const S = {
  appTitle: '3DGS Light Viewer',

  dropTitle: '3DGS ファイルをここにドロップ',
  dropOr: 'または',
  dropButton: 'ファイルを選択',
  dropFormats: '対応形式: .ply / .splat',
  dropPrivacy1: 'ファイルはブラウザ内でのみ処理され',
  dropPrivacy2: '外部に送信されることはありません',

  phaseReading: '読み込み中',
  phaseAnalyzing: '解析中',
  phasePreparing: '描画準備中',

  labelResolution: '解像度',
  labelBackground: '背景色',
  buttonOpenAnother: '別のファイルを開く',
  buttonEnterVr: 'VRで見る',
  buttonExitVr: 'VRを終了',
  buttonEnterAr: 'ARで見る',
  buttonExitAr: 'ARを終了',
  vrResolutionLocked: 'VR中は解像度を変更できません。VRを終了してから変更してください。',
  arResolutionLocked: 'AR中は解像度を変更できません。ARを終了してから変更してください。',

  labelXrBackground: 'VR背景',
  xrBackgroundOpaque: '背景色',
  xrBackgroundPassthrough: 'パススルー',
  xrPassthroughUnsupported: 'この端末はパススルー (immersive-ar) に対応していません。',
  arHint: 'カメラ映像に3DGSを重ねて表示します。',
  errXrStartFailed: 'VR を開始できませんでした。ヘッドセットで開いているかご確認ください。',
  errArStartFailed:
    'AR を開始できませんでした。カメラの使用を許可しているかご確認ください。',

  splatsSuffix: ' splats',
  close: '閉じる',

  errUnsupportedExt:
    'このファイル形式には対応していません。.ply または .splat を選択してください。',
  errUndetectable:
    'ファイルを 3DGS データとして解釈できませんでした。ファイルが壊れている可能性があります。',
  errParse: (detail: string) => `ファイルの解析に失敗しました。(詳細: ${detail})`,
  errOutOfMemory:
    'ファイルが大きすぎて読み込めませんでした。より小さいファイルを試すか、他のタブを閉じて再度お試しください。',
  errEmpty: 'このファイルには表示できる splat が含まれていませんでした。',
  errNoWebgl2:
    'お使いのブラウザは WebGL2 に対応していないため、このビューアを利用できません。',
} as const;

export function formatCount(n: number): string {
  return n.toLocaleString('ja-JP');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
