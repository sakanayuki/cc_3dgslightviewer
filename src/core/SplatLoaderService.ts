import { ExtSplats, getSplatFileType, SplatFileType } from '@sparkjsdev/spark';
import { KEEP_FULL_IN_MEMORY, PROGRESS_YIELD_INTERVAL_MS, SNIFF_BYTES } from '../config';
import { S } from '../ui/strings';
import { ViewerError } from '../types';
import type { LoadProgress, Ranking } from '../types';
import { buildRankingFromScores, computeScores } from './importance';

/** 本アプリが受け付ける形式。Spark は他形式も読めるが意図的に絞っている */
const SUPPORTED = new Set<string>([SplatFileType.PLY, SplatFileType.SPLAT]);

/** 拡張子から形式を引く。Spark は getSplatFileTypeFromPath を公開していない */
const BY_EXTENSION: Record<string, SplatFileType> = {
  ply: SplatFileType.PLY,
  splat: SplatFileType.SPLAT,
};

function typeFromName(name: string): SplatFileType | undefined {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return BY_EXTENSION[ext];
}

export type ProgressCallback = (progress: LoadProgress) => void;

async function yieldToUi(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

/**
 * ファイルの形式を判定する。大きなファイルを丸ごと読む前に弾けるよう、
 * 先頭 SNIFF_BYTES だけを読んで内容ベースで判定し、拡張子でも裏を取る。
 */
export async function detectFileType(file: File): Promise<SplatFileType> {
  const head = new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer());
  const byContent = getSplatFileType(head);
  const byPath = typeFromName(file.name);
  const type = byContent ?? byPath;

  if (!type) throw new ViewerError(S.errUndetectable);
  if (!SUPPORTED.has(type)) throw new ViewerError(S.errUnsupportedExt);
  return type;
}

/**
 * File をパースして PackedSplats にする。
 * File.stream() を使うため、巨大ファイルでも全体を一度に ArrayBuffer 化しない。
 */
export async function parseFile(
  file: File,
  fileType: SplatFileType,
  onProgress: ProgressCallback,
): Promise<ExtSplats> {
  const splats = new ExtSplats({
    stream: file.stream() as unknown as ReadableStream,
    streamLength: file.size,
    fileType,
    fileName: file.name,
    onProgress: (event: ProgressEvent) => {
      onProgress({
        phase: 'reading',
        ...(event.lengthComputable && event.total > 0
          ? { ratio: event.loaded / event.total }
          : {}),
      });
    },
  });

  try {
    await splats.initialized;
  } catch (e) {
    throw toViewerError(e);
  }

  if (splats.numSplats === 0) throw new ViewerError(S.errEmpty);
  return splats;
}

export function toViewerError(e: unknown): ViewerError {
  if (e instanceof ViewerError) return e;
  if (e instanceof RangeError || (e instanceof Error && /memory|allocat/i.test(e.message))) {
    return new ViewerError(S.errOutOfMemory, e);
  }
  const detail = e instanceof Error ? e.message : String(e);
  return new ViewerError(S.errParse(detail), e);
}

/**
 * 重要度ランキングを作る。重い同期ループなので、進捗を出しつつ
 * 定期的に UI スレッドへ制御を返す。
 */
export async function buildRankingAsync(
  splats: ExtSplats,
  onProgress: ProgressCallback,
): Promise<Ranking> {
  onProgress({ phase: 'analyzing', ratio: 0 });
  await yieldToUi();

  const scores = computeScores(splats);
  onProgress({ phase: 'analyzing', ratio: 0.6 });
  await yieldToUi();

  const ranking = buildRankingFromScores(scores);
  onProgress({ phase: 'analyzing', ratio: 1 });
  await yieldToUi();
  return ranking;
}

/**
 * フルデータの供給元。
 *
 * KEEP_FULL_IN_MEMORY が false のときは、レベル切替のたびに元 File を再パースし、
 * サブセット構築後にフルデータを解放する。定常メモリは「現在のレベルのサブセット」
 * だけになるが、切替のたびに数秒の再パースが入る (設計書 8.1)。
 * true のときは初回パース結果を保持し、再パースをスキップする。
 *
 * この分岐はこのクラス内に閉じ込め、呼び出し側からは見えないようにしている。
 */
export class FullSplatsProvider {
  private cached: ExtSplats | null = null;

  constructor(
    private readonly file: File,
    private readonly fileType: SplatFileType,
  ) {}

  /** 初回パース結果を渡す。常駐モードならここでキャッシュする */
  adoptInitial(splats: ExtSplats): void {
    if (KEEP_FULL_IN_MEMORY) this.cached = splats;
  }

  /**
   * フルデータを取得する。呼び出し側は使い終わったら必ず release() を呼ぶこと。
   */
  async acquire(onProgress: ProgressCallback): Promise<ExtSplats> {
    if (this.cached) return this.cached;
    return parseFile(this.file, this.fileType, onProgress);
  }

  /** acquire() で得たフルデータを解放する。常駐モードでは何もしない */
  release(splats: ExtSplats): void {
    if (this.cached === splats) return;
    splats.dispose();
  }

  dispose(): void {
    this.cached?.dispose();
    this.cached = null;
  }
}

export { PROGRESS_YIELD_INTERVAL_MS };
