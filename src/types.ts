import type * as THREE from 'three';

/** 読み込み進捗のフェーズ */
export type LoadPhase = 'reading' | 'analyzing' | 'preparing';

export interface LoadProgress {
  phase: LoadPhase;
  /** 0..1。不明なときは undefined */
  ratio?: number;
}

/** 重要度ランキングの結果。初回ロード時に一度だけ計算して常駐させる */
export interface Ranking {
  /** 各 splat が採用される最小レベル。levelOf[i] <= level なら採用 */
  levelOf: Uint8Array;
  /** ランキング作成時の splat 総数。再パース結果の検証に使う */
  numSplats: number;
  /** 各レベルの実際の採用件数 */
  counts: number[];
}

/** 自動フィット用に推定したシーンの形状 */
export interface SceneBounds {
  center: THREE.Vector3;
  /** パーセンタイル境界ボックスの外接球半径 */
  radius: number;
  up: THREE.Vector3;
  /** up を推定で決めたか (false なら既定値を使った) */
  upEstimated: boolean;
}

/** 現在読み込まれているモデルの状態 */
export interface LoadedModel {
  file: File;
  ranking: Ranking;
  bounds: SceneBounds;
  /** 元ファイルが持っていた SH の次数 */
  sourceMaxSh: 0 | 1 | 2 | 3;
  /** 現在描画中のレベル */
  level: number;
  /** 現在描画中の splat 数 */
  renderedSplats: number;
}

export class ViewerError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ViewerError';
  }
}
