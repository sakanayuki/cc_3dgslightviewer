import * as THREE from 'three';

// ── レベル定義 ────────────────────────────────────────────────
export interface LevelDef {
  readonly id: number;
  readonly label: string;
  /** 採用する splat の割合 (0..1) */
  readonly ratio: number;
  /** このレベルで使う SH の最大次数。実効値は元ファイルの次数との min を取る */
  readonly maxSh: 0 | 1 | 2 | 3;
}

export const LEVELS: readonly LevelDef[] = [
  { id: 0, label: '最低', ratio: 0.05, maxSh: 0 },
  { id: 1, label: '低', ratio: 0.12, maxSh: 0 },
  { id: 2, label: '中', ratio: 0.25, maxSh: 1 },
  { id: 3, label: '高', ratio: 0.5, maxSh: 3 },
  { id: 4, label: 'オリジナル', ratio: 1.0, maxSh: 3 },
];

export const DEFAULT_LEVEL = 2;

// ── 間引き ────────────────────────────────────────────────────
/** score = opacity * (sx*sy*sz)^この指数。2/3 は投影断面積の近似 */
export const IMPORTANCE_AREA_EXPONENT = 2 / 3;
export const IMPORTANCE_HISTOGRAM_BINS = 1024;

// ── メモリ戦略 ─────────────────────────────────────────────────
/**
 * true にすると初回パース結果をメモリに常駐させ、レベル切替を再パースなしで行う。
 * 定常メモリは増える (300万splat・SH次数3 で約168MB) が、切替が即時になる。
 * false ではレベル切替のたびに元 File を再パースする (設計書 8.1)。
 */
export const KEEP_FULL_IN_MEMORY = false;

/**
 * Spark の PackedSplats はテクスチャ幅 (SPLAT_TEX_WIDTH = 2^11) の倍数でしか
 * 容量を認識しない。packedArray をこの単位に切り上げないと numSplats が 0 に
 * 丸められる。Spark はこの定数を公開していないため、ここで持つ。
 * 値が変わっていないことは subset.ts の実行時ガードで検出する。
 */
export const SPLAT_TEX_WIDTH = 2048;

// ── カメラ ────────────────────────────────────────────────────
export const AUTOFIT_SAMPLE_COUNT = 100_000;
export const AUTOFIT_PERCENTILE_LOW = 0.01;
export const AUTOFIT_PERCENTILE_HIGH = 0.99;
export const AUTOFIT_MARGIN = 1.2;
/** 3DGS の PLY は INRIA 系の慣習で Y 軸が下向きのことが多い */
export const DEFAULT_UP = new THREE.Vector3(0, -1, 0);
export const ENABLE_UP_ESTIMATION = true;
/** 第3主成分/第2主成分の固有値比がこれ未満なら推定を採用する */
export const UP_ESTIMATE_CONFIDENCE = 0.35;

// ── ギズモ ────────────────────────────────────────────────────
export const GIZMO_SIZE = 120;
export const GIZMO_MARGIN = 12;
export const GIZMO_SNAP_DURATION_MS = 400;

// ── VR ────────────────────────────────────────────────────────
/** シーン半径に対する毎秒移動量。スケール差に追従させるため比率で持つ */
export const VR_MOVE_SPEED_RATIO = 0.15;
export const VR_SNAP_ANGLE_DEG = 30;
export const VR_SNAP_ON_THRESHOLD = 0.7;
export const VR_SNAP_OFF_THRESHOLD = 0.3;
export const VR_SCALE_MIN = 0.05;
export const VR_SCALE_MAX = 20;
export const VR_FIXED_FOVEATION = 1.0;
export const VR_FRAMEBUFFER_SCALE = 0.8;
export const VR_STICK_DEADZONE = 0.15;

// ── UI ────────────────────────────────────────────────────────
export const BACKGROUND_COLORS = [
  { label: '黒', value: '#000000' },
  { label: '白', value: '#ffffff' },
  { label: '灰', value: '#808080' },
] as const;
export const DEFAULT_BACKGROUND = 0;

/** 重い同期ループがこの間隔を超えたら UI スレッドに制御を返す */
export const PROGRESS_YIELD_INTERVAL_MS = 100;

/** 形式判定のために先頭から読むバイト数 */
export const SNIFF_BYTES = 65_536;
