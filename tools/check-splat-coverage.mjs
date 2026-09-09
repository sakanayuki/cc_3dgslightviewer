/**
 * 3DGS ファイルの「被覆」を検査する。
 *
 *   node tools/check-splat-coverage.mjs <file.splat | file.ply>
 *
 * 何を見るか:
 *   隣り合う splat の中心間距離が、splat の大きさ σ に対して離れすぎていると、
 *   面が覆いきれず背景が透けて見える。細かい亀裂・斑点状の抜けとして現れる。
 *
 *   判定量は「最近傍距離 / σ」。σ は splat の面内方向の大きさ
 *   (大きい方 2 軸の相乗平均) を使う。
 *
 *     ≦ 1.0  隣と 1σ 以内で重なる     … 面が塞がる
 *     > 1.5  隣まで 1.5σ 以上離れる   … 隙間が見える
 *
 *   この値はモデル全体を拡大・縮小しても変わらない (距離と σ が同率で変わるため)。
 *   改善するには σ を大きくするか、splat を増やして間隔を詰める必要がある。
 */
import { readFileSync } from 'node:fs';

const TARGET_P90 = 1.0;
const BANDS = [
  { limit: 1.0, verdict: '良好', note: '面がしっかり塞がる' },
  { limit: 1.2, verdict: '許容', note: 'ほぼ塞がる' },
  { limit: 1.5, verdict: '注意', note: '条件によっては抜けが見える' },
  { limit: Infinity, verdict: '破綻', note: '亀裂状・斑点状の抜けが出る' },
];

function quantile(sorted, p) {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/** .splat: 1 splat 32 バイト (位置 f32x3 / スケール f32x3 / 色 u8x4 / 回転 u8x4) */
function readSplat(buf) {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = Math.floor(buf.byteLength / 32);
  const pos = new Float64Array(n * 3);
  const scale = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const o = i * 32;
    for (let k = 0; k < 3; k++) {
      pos[i * 3 + k] = view.getFloat32(o + k * 4, true);
      scale[i * 3 + k] = view.getFloat32(o + 12 + k * 4, true);
    }
  }
  return { n, pos, scale };
}

/** .ply (binary_little_endian): INRIA 3DGS 形式。scale_* は自然対数で入っている */
function readPly(buf) {
  const marker = 'end_header\n';
  const headEnd = buf.indexOf(marker, 0, 'ascii');
  if (headEnd < 0) throw new Error('PLY ヘッダが見つかりません');
  const header = buf.toString('ascii', 0, headEnd);
  if (!/format\s+binary_little_endian/.test(header)) {
    throw new Error('binary_little_endian の PLY のみ対応しています');
  }
  const n = Number(/element\s+vertex\s+(\d+)/.exec(header)?.[1]);
  const SIZE = { float: 4, float32: 4, double: 8, uchar: 1, uint8: 1, char: 1, int: 4, uint: 4, short: 2, ushort: 2 };
  let stride = 0;
  const field = {};
  for (const m of header.matchAll(/property\s+(\w+)\s+(\S+)/g)) {
    const size = SIZE[m[1]];
    if (!size) throw new Error(`未対応の型: ${m[1]}`);
    field[m[2]] = { at: stride, type: m[1] };
    stride += size;
  }
  for (const need of ['x', 'y', 'z', 'scale_0', 'scale_1', 'scale_2']) {
    if (!field[need]) throw new Error(`必要なプロパティがありません: ${need}`);
  }
  const body = headEnd + marker.length;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const get = (i, name) => {
    const f = field[name];
    const at = body + i * stride + f.at;
    return f.type === 'double' ? view.getFloat64(at, true) : view.getFloat32(at, true);
  };
  const pos = new Float64Array(n * 3);
  const scale = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = get(i, 'x');
    pos[i * 3 + 1] = get(i, 'y');
    pos[i * 3 + 2] = get(i, 'z');
    for (let k = 0; k < 3; k++) scale[i * 3 + k] = Math.exp(get(i, `scale_${k}`));
  }
  return { n, pos, scale };
}

/** 面内方向の σ = 大きい方 2 軸の相乗平均 */
function inPlaneSigma(scale, i) {
  const s = [scale[i * 3], scale[i * 3 + 1], scale[i * 3 + 2]].sort((a, b) => a - b);
  return Math.sqrt(s[1] * s[2]);
}

function analyse({ n, pos, scale }, sampleSize = 30000) {
  const sigmas = [];
  let maxDist = 0;
  for (let i = 0; i < n; i++) {
    const s = inPlaneSigma(scale, i);
    if (s > 0 && Number.isFinite(s)) sigmas.push(s);
    const d = Math.hypot(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
    if (Number.isFinite(d) && d > maxDist) maxDist = d;
  }
  sigmas.sort((a, b) => a - b);
  const sigmaMedian = quantile(sigmas, 0.5);

  // 空間ハッシュで最近傍距離を求める
  const cell = sigmaMedian * 8;
  const grid = new Map();
  for (let i = 0; i < n; i++) {
    const k = `${Math.floor(pos[i * 3] / cell)},${Math.floor(pos[i * 3 + 1] / cell)},${Math.floor(pos[i * 3 + 2] / cell)}`;
    let bucket = grid.get(k);
    if (!bucket) grid.set(k, (bucket = []));
    bucket.push(i);
  }

  const step = Math.max(1, Math.floor(n / sampleSize));
  const ratios = [];
  for (let i = 0; i < n; i += step) {
    const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    let best = Infinity;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const bucket = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!bucket) continue;
          for (const j of bucket) {
            if (j === i) continue;
            const d =
              (pos[j * 3] - x) ** 2 + (pos[j * 3 + 1] - y) ** 2 + (pos[j * 3 + 2] - z) ** 2;
            if (d < best) best = d;
          }
        }
      }
    }
    const s = inPlaneSigma(scale, i);
    if (best < Infinity && s > 0) ratios.push(Math.sqrt(best) / s);
  }
  ratios.sort((a, b) => a - b);

  return {
    n,
    sigmaMedian,
    maxDist,
    samples: ratios.length,
    p50: quantile(ratios, 0.5),
    p90: quantile(ratios, 0.9),
    p99: quantile(ratios, 0.99),
    // 位置は float16 で保持されるため、その量子化誤差も参考に出す (副次的な要因)
    float16Ratio: maxDist / 2048 / sigmaMedian,
  };
}

const path = process.argv[2];
if (!path) {
  console.error('使い方: node tools/check-splat-coverage.mjs <file.splat | file.ply>');
  process.exit(2);
}
const buf = readFileSync(path);
const data = path.toLowerCase().endsWith('.ply') ? readPly(buf) : readSplat(buf);
const a = analyse(data);
const band = BANDS.find((b) => a.p90 <= b.limit);
const needed = a.p90 / TARGET_P90;

console.log(`
ファイル : ${path}
splat 数 : ${a.n.toLocaleString('ja-JP')}
splat の面内サイズ σ (中央値) : ${a.sigmaMedian.toExponential(3)}

  最近傍距離 / σ    p50 = ${a.p50.toFixed(2)}   p90 = ${a.p90.toFixed(2)}   p99 = ${a.p99.toFixed(2)}

  ★ 判定 (p90 基準) : ${band.verdict} — ${band.note}

判定基準 : p90 ≦ 1.0 良好 / ≦ 1.2 許容 / ≦ 1.5 注意 / それ以上は破綻
参考     : 位置の float16 量子化誤差 / σ = ${a.float16Ratio.toFixed(3)} (0.5 以下なら影響は小さい)
`);

if (a.p90 > TARGET_P90) {
  console.log(`必要な改善: 最近傍距離 / σ の p90 を ${a.p90.toFixed(2)} → 1.0 以下にする。次のいずれか。

  A) splat を大きくする (推奨・確認済み)
     全 splat のスケールを ${needed.toFixed(2)} 倍以上にする。
     splat 数・位置・色はそのままでよい。ディテールはわずかに柔らかくなる。

  B) splat を増やして間隔を詰める
     密度を ${(needed * needed).toFixed(1)} 倍にする
     (${a.n.toLocaleString('ja-JP')} → 約 ${Math.round(a.n * needed * needed).toLocaleString('ja-JP')} 個)。
     ディテールは保てるが、描画負荷とファイルサイズが同じ倍率で増える。
`);
} else {
  console.log('被覆は十分です。この要因による抜けは出ない見込みです。\n');
}
