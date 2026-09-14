# 3DGS Light Viewer 設計書

ブラウザ上で 3D Gaussian Splatting (3DGS) ファイルを閲覧する軽量ビューアの設計書。
本書は**実装委託用**であり、記載内容だけで追加質問なしに実装着手できる粒度を目標とする。

- 対象リポジトリ: `sakanayuki/cc_3dgslightviewer`
- 公開先: https://sakanayuki.github.io/cc_3dgslightviewer/
- 本書バージョン: 1.8 (AR の光源推定を追加)
- 最終更新: 2026-09-06

---

## 1. 目的とスコープ

### 1.1 目的

ローカルの 3DGS ファイルを、**インストール不要・アップロード不要**でブラウザにドラッグするだけで閲覧できるようにする。
低スペックPCおよび Meta Quest 2 でも実用的に動作することを最優先とする。

### 1.2 スコープに含むもの

| # | 項目 |
|---|---|
| F-1 | ローカルファイル (`.ply` / `.splat`) の読み込み。ファイル選択ダイアログとドラッグ&ドロップの両方 |
| F-2 | 読み込んだデータが**一切ネットワークに出ない**こと（CSPで機械的に保証） |
| F-3 | 解像度5段階（最低 / 低 / 中 / 高 / オリジナル）の切り替え。既定は「中」 |
| F-4 | 画面右上の XYZ 軸ギズモ表示。軸クリックで視点スナップ |
| F-5 | WebXR VRモード（Meta Quest 2 対応）。Questコントローラでの移動・操作 |
| F-9 | Android スマートフォンでの AR モード。背面カメラの映像に 3DGS を重ねて表示する |
| F-10 | AR で推定した環境光を splat に反映し、現実に馴染んだ見た目にする |
| F-6 | 背景色の切り替え。VR では背景をパススルーカメラに切り替えられる |
| F-7 | 読み込み進捗バーとエラー表示 |
| F-8 | GitHub Actions による GitHub Pages への自動デプロイ |

### 1.3 スコープに含まないもの（将来拡張）

**iOS の AR 対応**（iOS Safari は WebXR に一切対応していないため。詳細は 11.5 を参照）/
`.sog` 形式対応 / PWAオフライン対応 / スクリーンショット保存 / 直近ファイルの記憶 /
VR内での解像度変更UI / 一人称ウォークモード / 姿勢補正UI / 複数ファイル同時表示 / 多言語対応。

詳細と再有効化の手順は「18. 将来拡張」を参照。

---

## 2. 技術選定

### 2.1 採用スタック

| 領域 | 採用 | バージョン |
|---|---|---|
| 3DGSレンダラ | **Spark** (`@sparkjsdev/spark`) | `^2.1.0` |
| 3Dエンジン | **three.js** | `^0.185.1`（Spark の peer 要件は `>=0.180.0`） |
| 言語 | **TypeScript** | `^5.9.0` |
| ビルド | **Vite** | `^8.2.2` |
| UI | **Vanilla TS**（フレームワークなし） | — |
| テスト | **Vitest** | `^5.0.0` |
| 表示言語 | **日本語固定** | — |

> TypeScript は当初 7.x を想定していたが、`typescript-eslint` 8.x が 7 系に未対応のため
> 5.9 系で確定した。他は想定どおり。

外部依存は `three` / `@sparkjsdev/spark`（と Spark の依存 `fflate`）のみ。**CDN は一切使用せず、全て同一オリジンにバンドルする。**

### 2.2 Spark を採用した理由

1. **`.ply`（通常/圧縮）と `.splat` の両方を標準対応**し、`getSplatFileType()` によるバイト内容ベースの自動判定を持つ。
2. **WebGL2 のみで WebXR が動作する**。`SharedArrayBuffer` を必要としないため、GitHub Pages が COOP/COEP ヘッダを付与できない制約と無関係に動く。
   - 比較検討した `mkkellogg/GaussianSplats3D` は高速化パスが `SharedArrayBuffer` 依存で、GitHub Pages 上では無効化される。加えて VR 時の描画不正 issue が未解決であり、本要件の中核である Quest 2 対応でリスクが高いと判断した。
3. **`SparkXr` クラスが VR に必要な要素を揃えている**: `mode:"vr"`、`referenceSpaceType`、`fixedFoveation`、`frameBufferScaleFactor`、コントローラのスティック入力抽象（`getMove` / `getRotate` の差し替え可能）。Quest 2 の性能調整に直結する `fixedFoveation` と `frameBufferScaleFactor` を持つ点が決め手。
4. **`PackedSplats` のメモリ表現が公開されており**、間引き（デシメーション）を自前で正確に実装できる（詳細は 7章）。
5. `three.js` のシーングラフにそのまま乗るため、ギズモ・カメラ・XRリグを標準的な three.js の作法で書ける。

### 2.3 Spark の内部データ表現（実装の前提知識）

`PackedSplats` は以下の構造を持つ。**本設計の間引き実装はこの構造に依存する。**

| 配列 | 型 | 1 splat あたり | 内容 |
|---|---|---|---|
| `packedArray` | `Uint32Array` | **4 ワード = 16 バイト** | 位置・スケール・回転・不透明度・DC色 |
| `extra.sh1` | `Uint32Array` | **2 ワード = 8 バイト** | SH 次数1 |
| `extra.sh2` | `Uint32Array` | **4 ワード = 16 バイト** | SH 次数2 |
| `extra.sh3` | `Uint32Array` | **4 ワード = 16 バイト** | SH 次数3 |

- 合計: SH次数0 で 16 B/splat、SH次数3 フルで **56 B/splat**。
- 量子化の基準値は `splatEncoding`（`rgbMin/rgbMax`、`lnScaleMin/lnScaleMax`、`sh1Max` 等）に保持される。
  **サブセットを作る際は `splatEncoding` を必ず引き継ぐこと。**引き継がないと色とスケールが壊れる。
- 配列長はテクスチャ都合で `getTextureSize()` により切り上げられる。`numSplats` が実データ数、`packedArray.length / 4` は確保容量であり**一致しない**。
- **`packedArray` の容量は `SPLAT_TEX_WIDTH`（= 2^11 = 2048）splat の倍数でなければならない。**
  `PackedSplats.initialize()` は
  `maxSplats = floor(floor(packedArray.length / 4) / SPLAT_TEX_WIDTH) * SPLAT_TEX_WIDTH`
  と切り**下げ**るため、2048 未満の配列を渡すと `maxSplats` も `numSplats` も 0 になり、
  例外も出さずに何も描画されない。Spark はこの定数を公開していないので、
  `config.ts` の `SPLAT_TEX_WIDTH` に持ち、`subset.ts` で
  「構築後の `numSplats` が期待値と一致するか」を実行時に検証して黙って壊れないようにする。
  （実装時のスパイクで判明。最初はこれを知らず `numSplats = 0` になった）

---

## 3. 全体アーキテクチャ

```
┌─────────────────────────────────────────────────────────────┐
│ index.html  (CSP meta / #app / #canvas)                      │
└─────────────────────────────────────────────────────────────┘
                              │
┌─────────────────────────────▼───────────────────────────────┐
│ main.ts        起動・依存の配線・イベント結線                  │
└──┬──────────────┬───────────────┬──────────────┬────────────┘
   │              │               │              │
┌──▼───────┐ ┌────▼─────────┐ ┌───▼────────┐ ┌───▼──────────┐
│   ui/    │ │   core/      │ │  camera/   │ │    vr/       │
│          │ │              │ │            │ │              │
│FileDrop  │ │SplatLoader   │ │OrbitCamera │ │VrSession     │
│Control   │ │Service       │ │Controller  │ │Locomotion    │
│Panel     │ │importance.ts │ │autoFit.ts  │ │GrabController│
│Progress  │ │subset.ts     │ │            │ │              │
│Overlay   │ │levels.ts     │ └───┬────────┘ └───┬──────────┘
└──┬───────┘ │Viewer.ts     │     │              │
   │         └────┬─────────┘     │              │
   │              │               │              │
   └──────────────▼───────────────▼──────────────▼────────────┐
                  │  three.js Scene + SparkRenderer            │
                  │    ├─ worldRoot (Group)  ← VRグラブ操作対象 │
                  │    │    └─ SplatMesh                       │
                  │    └─ rig (Group)        ← VR移動対象      │
                  │         └─ camera                          │
                  └────────────────────────────────────────────┘
                                  │
                  ┌───────────────▼──────────────┐
                  │ gizmo/AxisGizmo.ts           │
                  │  (別Scene / 右上ビューポート) │
                  └──────────────────────────────┘
```

### 3.1 シーングラフの設計方針

VR での「移動」と「グラブ」を破綻なく両立させるため、**2つの Group を分離する**。

- `rig: THREE.Group` — カメラを子に持つ。**スティック移動とスナップ回転はこの `rig` を動かす**（プレイヤー側が動く）。
- `worldRoot: THREE.Group` — `SplatMesh` を子に持つ。**両手グラブによる平行移動・回転・拡縮はこの `worldRoot` を動かす**（世界側が動く）。

この分離により、「歩いて近づく」操作と「掴んで引き寄せる」操作が互いの座標系を壊さない。
非VR時は `rig` は原点固定で、`OrbitControls` がカメラを直接操作する。

---

## 4. ファイル構成

```
.
├── .github/
│   └── workflows/
│       └── deploy.yml
├── docs/
│   └── design.md               ← 本書
├── public/
│   └── .nojekyll
├── src/
│   ├── main.ts                 起動エントリ・配線
│   ├── config.ts               全チューニング定数（後述）
│   ├── types.ts                共有型定義
│   ├── styles.css
│   ├── core/
│   │   ├── Viewer.ts           renderer/scene/ループの所有者
│   │   ├── SplatLoaderService.ts  ファイル→PackedSplats（パース・再パース）
│   │   ├── importance.ts       重要度スコアと levelOf 配列の構築
│   │   ├── levels.ts           5段階レベルの定義と選択インデックス生成
│   │   └── subset.ts           SH保持サブセット構築
│   ├── camera/
│   │   ├── CameraController.ts 回転・平行移動・ズームと軸スナップ
│   │   └── autoFit.ts          バウンディング推定と初期視点算出
│   ├── gizmo/
│   │   └── AxisGizmo.ts
│   ├── ar/
│   │   ├── ArLight.ts          光源推定の受け取りと反映
│   │   ├── arLightModifier.ts  splat ごとに環境光を乗算する dyno モディファイア
│   │   ├── lightEstimation.ts  SH → 放射照度行列などの純粋な計算
│   │   └── webxr-light-estimation.d.ts
│   ├── vr/
│   │   ├── VrSession.ts        WebXR セッションの管理 (VR / パススルー)
│   │   ├── placement.ts        VR 入場時のモデルの向き・位置・スケール
│   │   ├── Locomotion.ts       スティック移動＋スナップ回転
│   │   └── GrabController.ts   片手/両手グラブ
│   └── ui/
│       ├── FileDropZone.ts
│       ├── ControlPanel.ts
│       ├── ProgressOverlay.ts
│       └── strings.ts          日本語文言の集約
├── tests/
│   ├── importance.test.ts
│   ├── levels.test.ts
│   └── subset.test.ts
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
└── eslint.config.js
```

---

## 5. 解像度5段階の定義

### 5.1 レベル表

| Level | 名称 | 採用率 | SH次数 | 備考 |
|---|---|---|---|---|
| 0 | 最低 | 5% | 0 | |
| 1 | 低 | 12% | 0 | |
| 2 | **中** | **25%** | 1 | **既定値** |
| 3 | 高 | 50% | 元ファイルの次数 | |
| 4 | オリジナル | 100% | 元ファイルの次数 | |

- **採用率は splat 数に対する比率**であり、レベルは**入れ子**（Level L に含まれる splat は必ず Level L+1 にも含まれる）。
- SH次数は「**元ファイルの次数を上限とする**」。元が次数0の `.splat` ファイルでは全レベルが次数0になる。
- `config.ts` に以下として定義する:

```ts
export const LEVELS = [
  { id: 0, label: '最低',       ratio: 0.05, maxSh: 0 },
  { id: 1, label: '低',         ratio: 0.12, maxSh: 0 },
  { id: 2, label: '中',         ratio: 0.25, maxSh: 1 },
  { id: 3, label: '高',         ratio: 0.50, maxSh: 3 },
  { id: 4, label: 'オリジナル', ratio: 1.00, maxSh: 3 },
] as const;

export const DEFAULT_LEVEL = 2;
```

`maxSh` の実効値は `Math.min(level.maxSh, sourceMaxSh)` とする。

---

## 6. 重要度順デシメーション

### 6.1 スコア定義

```
score_i = opacity_i × (s_x · s_y · s_z)^(2/3)
```

- `(体積)^(2/3)` は投影断面積に比例するため、「画面上でどれだけの面積を占めるか × どれだけ濃いか」の近似になる。
- 小さく薄い splat から先に削られるため、低レートでも形状と輪郭が保たれる。
- **数値ガード**: `opacity` または各 `scale` が `NaN` / 負 / 0 の場合は `score = 0` とし、必ず最も削られる側に置く。`score` が `0` または非有限の splat は **Level 4（オリジナル）でのみ採用**する。
- 指数 `2/3` は `config.ts` の `IMPORTANCE_AREA_EXPONENT` として外出しし、調整可能にする。

### 6.2 ランキング手法（ヒストグラム法・O(N)）

300万件の全ソートは 1〜2 秒かかるため採用しない。代わりに**ヒストグラムによる閾値決定**を用いる。
これは近似ではなく、**各レベルの splat 数は指定値と厳密に一致する**。

```
Pass A: 全 splat をスキャンし score_i を計算して Float32Array に保持。
        同時に有限かつ正の score の log10 の min / max を求める。
Pass B: log10(score) を BINS(=1024) 分割したヒストグラムを作る。
Pass C: 各レベル L の目標件数 T_L = round(N × ratio_L) について、
        ヒストグラムを高い bin から累積し、
          - T_L を超える直前までの bin 群 → 無条件採用
          - 境界 bin b_L → 残り R_L 件だけ、splat インデックス昇順に採用
        を決定する。
Pass D: 全 splat を再度走査し、levelOf[i] = その splat が採用される最小レベル を確定。
```

- 出力は `levelOf: Uint8Array(N)`（1 バイト/splat、300万件で 3 MB）。**これは初回ロード時に一度だけ計算し、常駐させる。**
- 入れ子性の証明: レベルが上がると閾値 bin は単調に下がるため、`bin_i > b_L` で採用された splat は `b_{L+1} ≤ b_L` より必ず `bin_i > b_{L+1}` を満たし、上位レベルでも採用される。境界 bin 内のインデックス昇順選択も各レベルで独立に成立する。
- スコア用 `Float32Array`（300万件で 12 MB）は Pass D 完了後に解放してよい。

### 6.3 選択インデックスの生成

```ts
// levels.ts
export function selectIndices(levelOf: Uint8Array, level: number): Uint32Array
```

`levelOf[i] <= level` を満たす `i` を**昇順**に詰めた `Uint32Array` を返す。
昇順であることは 7章のサブセット構築の前提条件である（メモリアクセス局所性のため）。

---

## 7. SH保持サブセット構築（`subset.ts`）

### 7.1 方針

Spark 標準の `PackedSplats.extractSplats()` は **SH を落とす**（内部で `getSplat()` → `pushSplat()` の往復をしており、DC色のみが残る）実装である。
本アプリは SH をレベル連動で保持する必要があるため、**自前で実装する**。

**重要な設計上の利点**: 量子化の内部ビット配置を一切解釈する必要がない。
`packedArray` は 4 ワード固定、`sh1`/`sh2`/`sh3` はそれぞれ 2/4/4 ワード固定なので、
**該当ワード群を不透明なまま丸ごとコピーするだけ**でよい。
そのため実装は約40行で済み、可逆（デコード誤差ゼロ）で、Spark の量子化方式が変わっても壊れない。

### 7.2 シグネチャと処理

```ts
// subset.ts
export function buildSubset(
  src: PackedSplats,
  keep: Uint32Array,   // 昇順のソース側インデックス
  maxSh: 0 | 1 | 2 | 3,
): PackedSplats
```

処理手順:

1. `n = keep.length` とする。
2. `packedArray` を新規に `Uint32Array(n * 4)` で確保し、
   各 `d`（0..n-1）について `src.packedArray` の `keep[d]*4 .. keep[d]*4+3` を `d*4 ..` へコピー。
3. `level = 1..maxSh` の各段について、`src.extra['sh'+level]` が存在すれば
   同様に `wordsPerSplat`（sh1=2, sh2=4, sh3=4）単位でコピーし `extra` に格納。
4. 以下のオプションで `PackedSplats` を構築する:

```ts
new PackedSplats({
  packedArray,
  numSplats: n,
  splatEncoding: src.splatEncoding,  // 必須。省略すると色とスケールが壊れる
  extra,
})
```

5. 生成後に `dst.setMaxSh(maxSh)` を呼ぶ。

### 7.3 スパイクの結果（実装済み）

設計時にドキュメント化されていなかった `PackedSplats` の挙動は、実装前のスパイクで
すべて確認済み。結果は以下のとおり。

| 確認項目 | 結果 |
|---|---|
| `packedArray` / `numSplats` / `splatEncoding` / `extra` をコンストラクタに渡して描画できるか | **可**。ただし容量を 2048 splat 単位に切り上げること（2.3 参照） |
| ワード単位コピーが可逆か | **可逆**。2,500 件で `getSplat()` の全成分が完全一致（誤差 0） |
| `extra.sh1/sh2/sh3` を渡して SH が反映されるか | **反映される**。`setMaxSh()` は構築後の呼び出しで有効 |
| `sh1Codes` 等のコードブック方式 SH | `.ply` / `.splat` では発生しない。検出したら `maxSh = 0` にフォールバックし警告を出す実装を入れてある |
| `extractSplats()` が SH を落とすか | **落とす**。`getSplat()` → `pushSplat()` の往復で DC 色のみが残る実装だった（自前実装が必要という判断は正しかった） |

これらは `tests/subset.test.ts` で回帰テストとして固定している。

## 8. ロードと解像度切替のフロー

### 8.1 採用方式: レベル毎の再パース

**常駐メモリを最小化するため、解像度を変更するたびに元の `File` から再パースする。**
各時点でメモリに残るのは「現在表示中のレベルのサブセット」のみ。

#### 想定規模の前提

上限の目安は「**〜500 MB / 〜300万 splat**」だが、この2つは 1:1 で対応しない。実装時の見積りには注意すること。

| 形式 | 1 splat あたり | 500 MB のとき | 300万 splat のとき |
|---|---|---|---|
| `.ply`（SH次数3・未圧縮） | 約 248 B（62 float） | **約 200万 splat** | 約 745 MB |
| `.ply`（SH次数0） | 約 68 B | 約 770万 splat | 約 204 MB |
| `.splat` | 32 B | 上限に達しない | 約 96 MB |

つまり **`.ply` では 500 MB のファイルサイズ側が先に効き、`.splat` では 300万 splat 側が先に効く**。
どちらか一方でも超えるファイルは「大きい」として扱い、進捗表示を必ず出すこと。

#### 前提となるメモリ実測値（300万splat / SH次数3 の場合）

| 保持内容 | サイズ |
|---|---|
| `packedArray` (16 B/splat) | 48 MB |
| SH フル (40 B/splat) | 120 MB |
| **フル常駐の合計** | **168 MB** |
| Level 0（5%・SH次数0）のサブセット | 約 2.4 MB |
| Level 2（25%・SH次数1）のサブセット | 約 18 MB |
| `levelOf`（常駐） | 3 MB |
| 生ファイルバイト列 | パース中のみ。完了後に解放 |

#### トレードオフ（承知の上で採用）

この方式は**切り替えのたびに数秒の再パースが発生する**。
また再パース時は一時的にフルデータ（168 MB）とサブセットが同時に存在するため、
**切替の瞬間のピークメモリは常駐方式と同等になる**。定常時のメモリのみが削減される。

この判断を後から覆せるよう、`config.ts` に切り替えフラグを置く:

```ts
/**
 * true にすると初回パース結果をメモリに常駐させ、レベル切替を再パースなしで行う。
 * 定常メモリは増える（300万splatで約168MB）が、切替が即時になる。
 */
export const KEEP_FULL_IN_MEMORY = false;
```

`SplatLoaderService` はこのフラグの両系統を実装し、`true` の場合は
`this.fullSplats` をキャッシュして再パースをスキップする。**分岐はこのサービス内に閉じ込め、他モジュールからは見えないようにすること。**

### 8.2 初回ロードのシーケンス

```
[ユーザー] ファイルをドロップ / 選択
     │
     ▼
1. 形式判定
   file.slice(0, 65536).arrayBuffer() → getSplatFileType(bytes)
   併せて getSplatFileTypeFromPath(file.name) でも判定
   → PLY / SPLAT 以外なら即エラー表示して中断（大きなファイルを読む前に弾く）
     │
     ▼
2. パース                                       進捗: 「読み込み中 xx%」
   SplatLoader.loadInternalAsync({
     stream: file.stream(),
     streamLength: file.size,
     fileName: file.name,
     onProgress,
   })
   → PackedSplats（フル）
     │
     ▼
3. 重要度スコアリング                            進捗: 「解析中 xx%」
   forEachSplat() で全 splat を走査 → 6章の Pass A〜D
   → levelOf: Uint8Array（常駐）
   ※ forEachSplat が渡すオブジェクトは使い回される。保持せず即座に数値を読むこと。
     │
     ▼
4. バウンディング推定                            進捗: 「解析中」
   9章のパーセンタイル法で center / radius / up を算出（常駐）
     │
     ▼
5. サブセット構築（既定レベル=中）                進捗: 「描画準備中」
   selectIndices(levelOf, 2) → buildSubset(full, keep, maxSh)
     │
     ▼
6. フルデータを解放
   full.dispose()（KEEP_FULL_IN_MEMORY が false のとき）
     │
     ▼
7. SplatMesh 生成 → worldRoot に追加 → カメラ自動フィット → 進捗オーバーレイを閉じる
```

**進捗表示は 4 フェーズ**（読み込み / 解析 / 描画準備 / 完了）とし、フェーズ名と百分率を出す。
スコアリングのループは 100ms ごとに `await new Promise(r => setTimeout(r, 0))` で UI スレッドに制御を返し、進捗バーが固まらないようにすること。

### 8.3 レベル切替のシーケンス

```
[ユーザー] 解像度セレクタを変更
     │
     ▼
1. UIを操作不可にし、進捗オーバーレイを表示
2. KEEP_FULL_IN_MEMORY が false なら再パース（8.2 の手順2のみ。スコアリングは不要）
   ※ levelOf は初回に計算済みで再利用する
   ※ 再パース結果の numSplats が初回と一致することを検証する。
      不一致ならスコアリングをやり直す（パーサの非決定性に対する防御）
3. selectIndices(levelOf, newLevel) → buildSubset()
4. 旧 SplatMesh を worldRoot から外して dispose()
5. 新 SplatMesh を追加。カメラは動かさない（視点を維持する）
6. フルデータを解放、オーバーレイを閉じる
```

**カメラを動かさないこと**が重要。レベル間の画質比較のためには視点が固定されている必要がある。

---

## 9. カメラと自動フィット

### 9.1 操作方式

`three/addons/controls/TrackballControls.js` を使用する。

| 操作 | 割り当て |
|---|---|
| 左ドラッグ | 回転（**制限なし。何回転でも続けられる**） |
| 右ドラッグ / 中ドラッグ | 平行移動 |
| ホイール | ズーム |
| タッチ1本 | 回転 |
| タッチ2本 | ズーム＋平行移動 |

`staticMoving = false`、`dynamicDampingFactor = 0.15`。

**OrbitControls を使わない理由**: OrbitControls はカメラ姿勢を極座標 (theta, phi) で保持し、
`phi` を `[0, π]` にクランプする。このため真上・真下を越えて回そうとすると
**90 度や 180 度で回転が止まる**。TrackballControls は視線ベクトルと `up` を
クォータニオンで回すだけで極の特異点が無く、どの方向にも回し続けられる。

その代わり `up` はドラッグに追従して動く（純粋な水平ドラッグではロールしないが、
斜めドラッグでは少しロールが乗る）。向きを戻したいときはギズモの軸クリックを使う。

### 9.2 バウンディング推定（`autoFit.ts`）

3DGS には遠方の外れ値 splat が必ず混入するため、単純な min/max では破綻する。**パーセンタイルを使う**。

1. 全 splat から最大 `AUTOFIT_SAMPLE_COUNT`（既定 100,000）件を等間隔サンプリングして中心座標を集める。
2. 軸ごとに 1 パーセンタイル値と 99 パーセンタイル値を求める（サンプルのソートでよい。10万件なら数十ms）。
3. `center` = 各軸の中点、`size` = 各軸の (p99 - p01)、`radius` = `size` の長さ / 2。
4. `radius` が 0 または非有限なら `radius = 1` にフォールバック。

### 9.3 初期視点

**既定の向きは「-Y 軸が画面上、+X 軸が画面右」**とする。方向はハードコードせず、
この条件から導出する。

`lookAt` の基底では、視線方向の逆ベクトル `z`（= カメラ位置 − 注視点）に対し
画面右が `x = normalize(cross(up, z))` になる。したがって

```
w = normalize(cross(DEFAULT_RIGHT, up))
```

とおくと `cross(up, w) = DEFAULT_RIGHT`（`DEFAULT_RIGHT ⊥ up` のとき）となり、`z = w` が求める方向。
さらに `z` を `up` 方向へ仰角ぶん傾けても `z` は `span{w, up}` に留まるため
`cross(up, z) = cos(仰角) × DEFAULT_RIGHT` のままで、**見下ろす角度を付けても
+X は画面右を向き続ける**。

```
direction = normalize(w × cos(仰角) + up × sin(仰角))   // 仰角 = DEFAULT_ELEVATION_DEG = 25°
distance  = radius / sin(fov / 2) × AUTOFIT_MARGIN      // AUTOFIT_MARGIN = 1.2
camera.up       = up
camera.position = center + direction × distance
controls.target = center
camera.near = radius / 1000
camera.far  = radius × 100
```

`up = (0,-1,0)` の場合、`w = (0,0,-1)` となり camera は -Z 側から +Z を見る位置に付く。
`near` / `far` を radius から導出することで、スケールが 0.01 の scene でも 10000 の scene でも破綻しない。

`DEFAULT_RIGHT` が `up` と平行になる場合（`up = ±X`）は外積が 0 になるため、
基準軸を `(0,0,1)` に退避させる。

### 9.4 上方向の推定

3DGS の `.ply` は学習パイプラインによって上方向がまちまちで、特に INRIA 実装系は **Y軸が下向き**であることが多い。

- **既定値**: `up = (0, -1, 0)`（`config.ts` の `DEFAULT_UP` として外出し）。**常にこれを使う。**
- **自動推定は既定で無効**（`ENABLE_UP_ESTIMATION = false`）。推定は本質的にヒューリスティックで
  外すことがあり、ファイルごとに初期の向きが変わってしまう。向きが固定されているほうが
  扱いやすいため既定は無効とし、コードは残して切り替えられるようにしてある。
- **自動推定（オプション、既定は無効）**: サンプリングした中心座標に対して主成分分析を行い、**最も分散の小さい主成分**を鉛直軸の候補とする。
  - 採用条件: `第3主成分の固有値 / 第2主成分の固有値 < UP_ESTIMATE_CONFIDENCE`（既定 0.35）。
    この比が大きい（＝形状が等方的で平面性が乏しい）場合は推定を信用せず、既定値を使う。
  - 向き（±）の決定: 推定軸の正負のうち、**splat 密度が低い側**を上とする（屋外スキャンでは空側が疎になる）。
  - `config.ts` の `ENABLE_UP_ESTIMATION`（既定 `true`）で無効化できるようにする。

> **実装者への注記**: この推定は本質的にヒューリスティックであり、外すケースは必ずある。
> 外した場合の救済手段（上下反転ボタン）は MVP スコープ外だが、実装コストが小さく効果が大きいため、
> 早期の追加を推奨する。「18. 将来拡張」参照。

---

## 10. XYZ軸ギズモ（`AxisGizmo.ts`）

### 10.1 描画方式

**メインシーンとは別の `THREE.Scene` と `THREE.OrthographicCamera` を用意し、右上のビューポートに重ねて描画する。**

```ts
// メインシーンの描画後に実行
renderer.autoClear = false;
renderer.clearDepth();                                  // 必須
renderer.setViewport(x, y, GIZMO_SIZE, GIZMO_SIZE);
renderer.setScissor(x, y, GIZMO_SIZE, GIZMO_SIZE);
renderer.setScissorTest(true);
renderer.render(gizmoScene, gizmoCamera);
renderer.setScissorTest(false);
renderer.setViewport(0, 0, w, h);
renderer.autoClear = true;
```

**`clearDepth()` は必須**。splat は半透明で深度を安定して書かないため、これを省くとギズモが splat に埋もれる。

### 10.2 見た目と仕様

- サイズ: 120 × 120 px、右上マージン 12 px。
- 構成: 原点から伸びる3本の線 + 6個の球（+X, -X, +Y, -Y, +Z, -Z）。
- 色: X = `#ff4d4d`、Y = `#4dff88`、Z = `#4d9dff`。負方向の球は同色の 40% 不透明度とし、輪郭のみとする。
- ラベル: 正方向の球に `X` / `Y` / `Z` を `CanvasTexture` の `Sprite` で表示。
- 姿勢: 毎フレーム `gizmoCamera.position` をメインカメラの視線方向の逆向き × 固定距離に置き、`lookAt(0,0,0)`、`up` はメインカメラの `up` に同期させる。

### 10.3 クリックによる視点スナップ

1. `pointerdown` の座標がギズモのビューポート矩形内かを判定。矩形外なら `OrbitControls` に委ね、何もしない。
2. 矩形内なら、矩形内での正規化デバイス座標を計算して `Raycaster` で `gizmoScene` の6個の球に対して交差判定。
3. ヒットしたら、`controls.target` と現在のカメラ距離を保ったまま、カメラ位置をその軸方向へ移動する。
   `GIZMO_SNAP_DURATION_MS`（既定 400ms）かけて `easeInOutCubic` で補間する。
   補間中は `controls.enabled = false` とし、さらに **`controls.update()` を呼ばない**
   （呼ぶと補間した位置が上書きされる）。完了後に両方戻す。
4. **`up` も同時に補間する。** 視線方向が `up` と平行になる真上・真下からの視点では
   `lookAt` が退化するため、`resolveUpFor()` で退避先を決める:
   - `|dot(視線, DEFAULT_UP)| < 0.99` なら `DEFAULT_UP` をそのまま使う
   - 平行なら `normalize(cross(視線, DEFAULT_RIGHT))` を使う。これにより
     **真上・真下から見たときも +X が画面右を向く**
5. VRセッション中はギズモを非表示にし、クリック判定も行わない。

クリックは canvas の **キャプチャ段階**で受け、ギズモ矩形内なら `stopImmediatePropagation()` する。
カメラ操作も同じ canvas にリスナーを張るため、`stopPropagation()` では同一要素の
他リスナーを止められず、ギズモ上のドラッグでシーンが回ってしまう。

---

## 11. VRモード

### 11.1 セッション設定（`VrSession.ts`）

```ts
new SparkXr({
  renderer,
  mode: 'vr',
  referenceSpaceType: 'local-floor',
  button: { enterVrText: 'VRで見る', exitVrText: 'VRを終了' },
  fixedFoveation: 1.0,          // Quest 2 では最大に。周辺解像度を落として大幅に負荷軽減
  frameBufferScaleFactor: 0.8,  // Quest 2 の既定値。config.ts で調整可能に
  enableHands: false,           // ハンドトラッキングは非対応（コントローラのみ）
  onEnterXr: () => { /* ギズモ非表示、OrbitControls無効化、UIパネル非表示 */ },
  onExitXr: () => { /* 上記を復帰 */ },
});
```

- `xrSupported()` が `false` の環境では VR ボタン自体を表示しない。
- **VRセッション中は解像度を変更できない。** UIパネルに「VR中は解像度を変更できません。VRを終了してから変更してください。」と表示する。

### 11.2 移動（`Locomotion.ts`）

操作対象は `rig`（カメラの親 Group）。

| 入力 | 動作 |
|---|---|
| 左スティック | 水平移動。**頭の向いている方位を基準**とする（`moveHeading: true` 相当） |
| 右スティック 左右 | **スナップ回転**。30° 刻み |
| 右スティック 上下 | 未使用 |
| 左トリガー | 移動速度 ×3（ダッシュ） |
| 右トリガー | 移動速度 ×0.3（微調整） |

- 移動速度は **実寸の毎秒移動量** `VR_MOVE_SPEED_MPS`（既定 1.5 m/s）で持つ。
  11.5 でモデルを実寸に正規化するため、シーン半径からの相対値にする必要がない。
- **スナップ回転の実装**: Spark の既定 `getRotate` は連続回転なので、`getRotate: () => new THREE.Vector3(0,0,0)` で無効化し、自前で実装する。
  右スティックの X が `0.7` を超えた瞬間に 30° 回転させ、`0.3` を下回るまで再発火させない（ラッチ方式）。
  これによりVR酔いを抑える。
- 回転はカメラの現在位置を中心に行う（`rig` を頭の位置周りで回す）。単に `rig.rotation.y` を足すと、頭が原点から離れているとき体が振り回される。

### 11.3 グラブ（`GrabController.ts`）

操作対象は `worldRoot`。入力は各コントローラの **squeeze（グリップ）** ボタン。

| 操作 | 動作 |
|---|---|
| 片手グリップ | 掴んだ手に世界が完全に追従する（平行移動 + **3軸すべての回転**） |
| 両手グリップ | 平行移動 + 手を結ぶ軸の向きの変化ぶんの回転 + 中点基準の拡縮 |

**回転に軸の制限を設けない。** 当初は両手回転を Yaw のみに落としていたが、
`atan2(dz, dx)` で XZ 平面へ投影する方式だったため、手を縦に回すと **90 度付近で
投影が退化し、180 度で元に戻ってしまい「回転し続けられない」**状態になっていた。

**フレーム間の差分を積み上げる方式にする。** 掴んだ瞬間の姿勢を基準にする絶対差分では、
基準ベクトルと現在ベクトルが反平行になる点（180 度）で回転軸が定まらず不連続が生じる。
フレーム間の差分は常に微小角なので特異点が無く、何回転でも連続して回せる。

```
片手: 手が (p_prev, q_prev) から (p_curr, q_curr) へ動いたときの剛体変換
        dq   = q_curr * q_prev⁻¹
        D(x) = dq * (x - p_prev) + p_curr
      を worldRoot に適用する。

両手: v_prev / v_curr = 前フレーム / 現フレームの手を結ぶベクトル
        dq   = setFromUnitVectors(normalize(v_prev), normalize(v_curr))
        s    = |v_curr| / |v_prev|            （累積スケールをクランプして補正）
        D(x) = dq * (s * (x - mid_prev)) + mid_curr
```

- 累積スケールは `VR_SCALE_MIN` (0.05) / `VR_SCALE_MAX` (20) でクランプする。
  クランプに掛かったら、その分だけ `s` を補正して適用する。
- 手の本数、または片手時に掴んでいる手が変わったら基準を取り直す。
  取り直さないと世界が飛ぶ。
- 両手は手を結ぶ軸の 2 自由度ぶんしか回らないが、その軸まわりのひねりは
  片手グラブで行えるため、両方を合わせるとどの向きにも制限なく回せる。

### 11.4 Quest 2 向けの必須設定

| 項目 | 設定 | 理由 |
|---|---|---|
| `WebGLRenderer` の `antialias` | **`false`** | Spark 公式の指示。3DGS では画質向上に寄与せず、性能を大きく落とす |
| `fixedFoveation` | `1.0` | 周辺視野の解像度を落とす。Quest 2 では効果が大きい |
| `frameBufferScaleFactor` | `0.8` | レンダーターゲット解像度を下げる |
| WebGPU | **使用しない** | Quest 2 の Meta Browser では実用にならない。WebGL2 のみを対象とする |
| HTTPS | 必須 | WebXR の動作要件。GitHub Pages は HTTPS なので条件を満たす |

### 11.5 パススルー背景と AR モード

背景にカメラ映像を合成する機能は、WebXR では **`immersive-ar` セッション**として
提供される（`immersive-vr` に「パススルーを有効にする」ようなオプションは無い）。
ヘッドセットのパススルーも、スマートフォンの AR も、同じ `immersive-ar` である。
したがってモードの選択は、要求するセッション種別の切り替えになる。

| 端末 | `immersive-vr` | `immersive-ar` | UI |
|---|---|---|---|
| Meta Quest 2 | 対応 | 対応 | 「VRで見る」＋「VR背景」で背景色 / パススルーを選択 |
| Meta Quest 2 (旧ブラウザ等) | 対応 | 非対応 | 「VRで見る」のみ。理由を添えて選択肢を出さない |
| Android スマートフォン | **非対応** | 対応 | 「ARで見る」。背景は常にカメラ映像なので選択肢を出さない |
| iOS | 非対応 | 非対応 | ボタンを出さない |
| デスクトップ | 非対応 | 非対応 | ボタンを出さない |

**対応判定は `isSessionSupported('immersive-vr')` と `('immersive-ar')` を必ず別々に行い、
要求するセッション種別もそれに従って決める。** ここを取り違えると、スマートフォンで
`immersive-vr` を要求して必ず失敗する（実際にこの不具合があった）。

実装上の要点:

- **描画バッファの `alpha` は `getContext` の時点で決まる。** 既存のコンテキストを
  `WebGLRenderer` に渡す構成では、コンストラクタ引数の `alpha` は無視される
  （three.js は `context.getContextAttributes()` を読む）。
  `canvas.getContext('webgl2', { alpha: true, antialias: false, premultipliedAlpha: true })`
  として明示する。
- カメラ映像を合成する間は `scene.background = null` と `renderer.setClearAlpha(0)` にする。
  不透明な背景色を残すと映像を覆ってしまう。セッション終了時に元へ戻す。
- 端末が `immersive-ar` を受け付けても実際には合成しない場合があるため、
  セッション開始後に `session.environmentBlendMode` を確認し、`'opaque'` なら
  コンソールに警告を出す。
- Quest 2 のパススルーは**白黒・低解像度**である（ハードウェアの制約）。

**iOS を対象外とする理由**: iOS Safari は WebXR に対応しておらず `navigator.xr` 自体が
存在しない。カメラ映像を出すには `getUserMedia` と `deviceorientation` による
独自実装（3自由度のマジックウィンドウ）が必要になり、WebXR の 6 自由度トラッキングとは
別物の体験・別系統の実装になる。今回は対象外とした。

### 11.6 AR の光源推定（`ar/`）

カメラから推定した環境光を splat の色に反映し、現実に馴染んだ見た目にする。
**パススルー / AR のときだけ有効**（背景に現実が映っていないと意味がない）。

#### 何ができないか（先に書く）

**3DGS は撮影時の光が色に焼き込まれているため、物理的に正しいリライティングはできない。**
アルベドと法線が分離されていないので、影を消したり付け替えたりする術がない。
できるのは「元の色 × 推定した環境光」の乗算だけである。

そのため本実装は次の 3 つに絞る。方向性のある主光源（`primaryLightDirection`）による
ランバート陰影は**あえて使わない** — 元データの陰影と向きが食い違うと二重の影になり、
かえって不自然になるため。

1. **ホワイトバランス**: 環境光の色味を反映する（暖色の部屋では暖色になる）
2. **回り込み**: 環境 SH を splat の法線方向で評価し、向きによる差を出す
3. **露出**: 環境の明るさに応じて全体を明るく / 暗くする

#### 乗数の作り方

WebXR の `XRLightProbe` から得られるのは次数 2 の球面調和関数（9 係数 × RGB）。
ランバート面の放射照度は法線の 2 次形式で書けるので、**チャンネルごとに 4×4 行列 1 枚**に
畳める（Ramamoorthi & Hanrahan 2001）。シェーダ側は 1 行で評価できる。

```
E(n) = dot(n4, M * n4)          n4 = vec4(normal, 1)
```

乗数は平均が 1.0 になるよう正規化する。**これが「元データの見た目を壊さない」ための要**。

```
ambient   = 0.886227 * SH の DC 項        … 全方向の平均放射照度
multiplier(n) = mix(1.0, E(n) / luminance(ambient) * exposure, strength)
```

`E(n) / luminance(ambient)` は平均輝度が 1 になるので、**無彩色の環境では乗数が
ちょうど 1.0** になり見た目が変わらない。残るのは色味と方向差だけ。

#### 露出は相対値で扱う

ARCore が返す SH の絶対スケールは端末依存で仕様上の保証がない。そのため
**AR 入場時に観測した明るさを基準にした相対値**として扱う。

```
exposure = clamp(pow(現在の明るさ / 入場時の明るさ, GAMMA), MIN, MAX)
```

絶対校正なしでも「明るい場所から暗い場所へ移ると暗くなる」という妥当な振る舞いになり、
起動時に大外しすることがない。GAMMA (0.5) で圧縮し MIN/MAX (0.7〜1.4) で抑えて、
元データの見た目を壊さないようにしている。

#### splat の法線

Spark の `gsplatNormal()`（共分散の最小軸）を使う。**splat の法線には一貫した向きが
無いので、カメラ側を向くよう符号を揃える**（`modifiers/normalColor` と同じ手法）。
これをしないと裏側の環境光を拾ってしまう。

この結果、光が被写体の裏から当たっているときはカメラ側の面が暗くなる。
物理的にも妥当な挙動である。

#### 実装上の注意

- 適用は Spark の `worldModifier`（dyno パイプライン）。ユニフォームの更新だけなので
  毎フレームのシェーダ再コンパイルは起きない。`attach` / `detach` のときだけ再生成される。
- SH は毎フレーム揺れるので指数移動平均で平滑化する（`AR_LIGHT_SMOOTHING`）。
  初回の推定だけは平滑化せずそのまま入れる（中立値から寄せると色が狂う）。
- ON/OFF は `strength` を時間で補間して切り替える（急に変わるとちらつく）。
- `light-estimation` 非対応の端末では `requestLightProbe()` が失敗する。
  その場合は何もせず従来どおりの見た目のままにし、UI のチェックボックスを
  理由付きで操作不可にする。

#### 検証結果

実際に描画して測定した（4,000 splat / 384×384px / splat が乗った画素の平均）。

| 条件 | 結果 | 期待値 |
|---|---|---|
| モディファイア無し vs 付けて strength=0 | 輝度比 **1.00000**（RGB 完全一致） | 1.0 |
| 無彩色の光・strength=1 | 輝度比 **1.0000**（RGB 完全一致） | 1.0 |
| 露出 0.7 を指定 | 輝度比 **0.7100** | 0.70 |
| 暖色の光 | R/B 比 **3.15**（基準は 1.00） | 上昇 |
| 方向成分のある光 | 輝度比 0.653（法線方向で変化） | 差が出る |

上 2 行が重要で、**OFF のときと無彩色の環境では見た目が一切変わらない**ことを意味する。

### 11.7 VR 入場時のモデル配置（`placement.ts`）

**VR ではカメラ姿勢がヘッドセットから与えられるため `camera.up` が無視される。**
デスクトップ側の「-Y が上」は `camera.up` で実現しているので、そのままでは VR に
反映されない。XR 空間の上は常に物理的な +Y なので、**向きを合わせるにはモデル側
（`worldRoot`）を回すしかない**。

加えて、3DGS の座標スケールは学習パイプライン由来で単位を持たないため、そのまま
XR 空間に置くと「巨大すぎて中に埋もれる」か「足元の点」になる。実寸に正規化する。

VR 入場時に `worldRoot` へ以下を適用する（VR 終了時に単位変換へ戻す）。

```
回転:   モデルの up を XR の上 (+Y) へ、モデルの DEFAULT_RIGHT を XR の右 (+X) へ移す回転。
        r = DEFAULT_RIGHT を up と直交化、f = cross(r, up) として
        basis = makeBasis(r, up, f) の転置（= 逆回転）を取る。
        DEFAULT_UP = (0,-1,0) の場合、X 軸まわりの 180 度回転になる。
スケール: VR_TARGET_RADIUS / bounds.radius       （既定 1.0 m の見かけ半径）
位置:    desired - quaternion * (scale * bounds.center)
        desired = (0, VR_MODEL_HEIGHT, -VR_MODEL_DISTANCE) = (0, 1.4, -2.0)
```

Object3D の合成順は `matrix = T * R * S` なので、点 `x` は
`position + quaternion * (scale * x)` に移る。位置はこの式からモデル中心が
`desired` に来るよう逆算している。

既定では目の前 2 m に直径 2 m ほどの卓上模型として現れる。中に入りたい場合は
両手グラブで拡大する。

---

## 12. UI 仕様

### 12.1 画面構成

```
┌──────────────────────────────────────────────────┐
│                                    ┌───────────┐ │
│                                    │  ギズモ    │ │
│                                    │  120×120  │ │
│                                    └───────────┘ │
│                                                  │
│                  (3DGS 描画領域)                  │
│                                                  │
│ ┌────────────────────────┐                       │
│ │ 解像度: [中        ▼]  │          [VRで見る]   │
│ │ 背景色: [■][□][▨]     │                       │
│ │ ────────────────────── │                       │
│ │ 1,234,567 splats       │                       │
│ │ sample.ply             │                       │
│ │ [別のファイルを開く]    │                       │
│ └────────────────────────┘                       │
└──────────────────────────────────────────────────┘
```

### 12.2 初期状態（ファイル未読み込み）

画面中央にドロップゾーンを表示する。

```
        ┌─────────────────────────────────┐
        │                                 │
        │   3DGS ファイルをここにドロップ   │
        │                                 │
        │     または [ファイルを選択]      │
        │                                 │
        │      対応形式: .ply / .splat     │
        │                                 │
        │  ファイルはブラウザ内でのみ処理され │
        │  外部に送信されることはありません   │
        └─────────────────────────────────┘
```

最後の2行（外部送信しない旨）は要件の中核なので**常に明示する**。

### 12.3 コントロールパネル

- 解像度: `<select>` で5段階。VR中は `disabled` にし、理由をツールチップと補助テキストで示す。
- 背景色: 3択のボタン。`#000000`（黒）/ `#ffffff`（白）/ `#808080`（中間グレー）。既定は黒。
  `scene.background` と `renderer.setClearColor` に反映する。
- 情報表示: 現在描画中の splat 数（3桁区切り）とファイル名。
- 「別のファイルを開く」ボタン: 現在のデータを破棄してドロップゾーンに戻る。

### 12.4 進捗オーバーレイ

```
┌─────────────────────────┐
│      解析中 42%          │
│  ███████░░░░░░░░░░░░░   │
│  sample.ply (487 MB)     │
└─────────────────────────┘
```

フェーズ文言（`strings.ts` に集約）:
- `読み込み中` — ファイルのストリーム読み出しとパース
- `解析中` — 重要度スコアリングとバウンディング推定
- `描画準備中` — サブセット構築と SplatMesh 生成

### 12.5 エラー表示

| 状況 | 文言 |
|---|---|
| 非対応拡張子 | `このファイル形式には対応していません。.ply または .splat を選択してください。` |
| 形式判定失敗 | `ファイルを 3DGS データとして解釈できませんでした。ファイルが壊れている可能性があります。` |
| パース中の例外 | `ファイルの解析に失敗しました。(詳細: {message})` |
| メモリ不足 (`RangeError` / OOM) | `ファイルが大きすぎて読み込めませんでした。より小さいファイルを試すか、他のタブを閉じて再度お試しください。` |
| splat 数が 0 | `このファイルには表示できる splat が含まれていませんでした。` |
| WebGL2 非対応 | `お使いのブラウザは WebGL2 に対応していないため、このビューアを利用できません。` |

エラーは**オーバーレイ内に表示し、「閉じる」でドロップゾーンに戻る**。`alert()` は使わない。

---

## 13. 外部通信ゼロの保証

### 13.1 CSP

`index.html` の `<head>` 冒頭に以下の `<meta>` を置く。

```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'self';
  script-src 'self' 'wasm-unsafe-eval';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:;
  font-src 'self';
  connect-src 'self' blob: data:;
  worker-src 'self' blob:;
  child-src 'self' blob:;
  object-src 'none';
  base-uri 'self';
  form-action 'none';
">
```

各ディレクティブの根拠:

| ディレクティブ | 理由 |
|---|---|
| `default-src 'self'` | 外部オリジンへの一切のアクセスを既定で禁止 |
| `'wasm-unsafe-eval'` | **必須**。Spark はソートに WebAssembly を使う（`WASM_SPLAT_SORT = true`）。これがないとソートが動かない |
| `worker-src 'self' blob:` | **必須**。Spark は Worker をバンドル内の文字列から `Blob` 経由で生成する |
| `connect-src 'self' blob: data:` | Worker の blob URL に加え、**`data:` が必須**。Spark の Worker は WASM バイナリを `data:application/wasm;base64,...` から `fetch` するため、これがないとパースが「読み込み中 0%」で止まる（実機検証で判明）。`data:` / `blob:` はインライン参照でネットワークに出ないため、**外部オリジンを一切含めない限り通信ゼロは保たれる** |
| `style-src 'unsafe-inline'` | three.js / Spark が生成する VR ボタン等のインラインスタイルのため |
| `form-action 'none'` | フォーム送信経路を塞ぐ |

**注意**: `frame-ancestors` は `<meta>` では無視されるため指定しない。GitHub Pages は
カスタムヘッダを設定できないため、クリックジャッキング対策はこの構成では適用できない。
本アプリは認証も永続化も持たないため、リスクとして受容する。

### 13.2 実装規約

- **CDN の参照を禁止する。** すべての依存は `npm` でインストールし Vite でバンドルする。
- `fetch` / `XMLHttpRequest` / `WebSocket` / `navigator.sendBeacon` を新規に書かない。
  唯一の例外は Vite が同一オリジンのアセットに対して生成するコードのみ。
- 解析・エラー報告・テレメトリの類を一切入れない。
- フォントは Google Fonts 等を使わず、`system-ui` を含むシステムフォントスタックで済ませる。

### 13.3 受け入れ時の検証手順

**この手順を README に記載し、リリース前に必ず実施すること。**

1. Chrome DevTools の Network タブを開き、`Preserve log` を有効にする。
2. アプリを読み込み、リクエストが完了した時点で `Clear` する。
3. 500 MB 程度の `.ply` をドロップし、表示完了まで待つ。
4. 解像度を5段階すべて切り替える。
5. **Network タブに新規リクエストが1件も出ないことを確認する。**
6. Console に CSP 違反の警告が出ていないことを確認する。

---

## 14. ビルドとデプロイ

### 14.1 Vite 設定

```ts
// vite.config.ts
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/cc_3dgslightviewer/',   // GitHub Pages のサブパス
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 2000,  // Spark + three は大きい
  },
});
```

`public/.nojekyll`（空ファイル）を置き、Jekyll による処理を無効化する。

### 14.2 npm scripts

```json
{
  "scripts": {
    "dev": "vite",
    "build": "tsc --noEmit && vite build",
    "preview": "vite preview",
    "lint": "eslint .",
    "typecheck": "tsc --noEmit",
    "test": "vitest run"
  }
}
```

### 14.3 GitHub Actions

`.github/workflows/deploy.yml`:

```yaml
name: Deploy to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: true

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run test
      - run: npm run build
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v3
        with:
          path: dist

  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

### 14.4 リポジトリ設定（手動作業）

**実装者はこの設定をリポジトリ管理者に依頼すること。**

- Settings → Pages → Build and deployment → Source を **GitHub Actions** に設定する。
  （`Deploy from a branch` のままだとワークフローが失敗する）

---

## 15. 品質保証

### 15.1 テスト方針

> **前提の明示**: テスト方針は明示的な指定がなかったため、以下を提案として設計に含めている。
> 過剰であれば E2E を落とすなど調整してよい。

**ユニットテスト（Vitest）** — 純粋関数のみを対象とし、DOM も WebGL も使わない。

| ファイル | 検証内容 |
|---|---|
| `importance.test.ts` | スコア計算の数値ガード（NaN/負/0 → score 0）、ヒストグラム閾値決定が各レベルの件数を厳密に満たすこと、`levelOf` の入れ子性 |
| `levels.test.ts` | `selectIndices` が昇順かつ件数一致であること、境界（N=0, N=1, ratio=1.0） |
| `subset.test.ts` | ワード単位コピーが正しいこと（ダミーの `Uint32Array` を作り、選択インデックスに対応するワード群が一致することを検証）、SH 各段の `wordsPerSplat` が 2/4/4 であること |

**E2E は CI に含めない。** ただし手元で通せるブラウザ実機検証スクリプトを
`tools/verify-browser.mjs` に用意した（Playwright + Chromium が必要）。
ビルド済み `dist/` をローカル配信し、Chromium を駆動して以下を実画面から検証する。
CSP の `data:` 不足はこのスクリプトで発見した。

- 初期表示（ドロップゾーン、外部送信しない旨の明示）
- 読み込み後の splat 数と既定レベル
- 5段階すべての splat 数が定義どおりか
- レベル切替でカメラが動かないこと
- 背景色3色の切り替え
- ギズモの軸クリックで投影形状が変わること
- SH なしファイルの描画
- 壊れたファイル / 非対応拡張子のエラー表示
- **外部オリジンへのリクエストが 0 件であること、CSP 違反が 0 件であること**
- XR 対応状況に応じた UI と、**実際に要求するセッション種別**（`navigator.xr` を
  差し替えて検証する。`requestSession` に渡された種別を記録するため、実機が無くても
  「スマートフォンで `immersive-ar` を要求しているか」まで確認できる）。
  XR非対応 / VRのみ / ARのみ / 両対応 の 4 通りを検証する

テスト用の合成 PLY は `tools/make-test-ply.mjs` で生成する。`slab`（軸ごとに寸法が
異なる板状）と `cube`（等方）を選べる。**`cube` はどの軸から見ても同じに見えるため、
視点変化の検証には使えない**（実際にこれで誤検知した）。

### 15.2 手動確認項目

- [ ] 未圧縮 `.ply`（SH次数3）が読める
- [ ] 圧縮 `.ply`（SuperSplat/gsplat 系）が読める
- [ ] `.splat` が読める
- [ ] 5段階すべてが切り替わり、splat 数が表示値どおりに変化する
- [ ] レベル切替でカメラが動かない
- [ ] ギズモの各軸クリックで視点がスナップする
- [ ] 背景色3色が切り替わる
- [ ] 13.3 のネットワーク検証を通過する
- [ ] Quest 2 実機で VR に入れる
- [ ] Quest 2 でスティック移動・スナップ回転・片手グラブ・両手グラブが動く
- [ ] Quest 2 で「中」レベルが 60fps 以上で動く

### 15.3 性能目標

| 環境 | 条件 | 目標 |
|---|---|---|
| デスクトップ（内蔵GPU相当） | 中（25%）レベル | 60 fps |
| Quest 2 | 低（12%）レベル | 72 fps |
| Quest 2 | 中（25%）レベル | 60 fps 以上 |
| 初回表示 | 500 MB の `.ply` | 15 秒以内 |

### 15.4 テストデータについて

500 MB クラスの `.ply` は**リポジトリにコミットしない**。
`tests/fixtures/` には合成した極小ファイル（数十 splat）のみを置き、
大きいファイルでの確認は手動確認項目として扱う。

---

## 16. 実装順序

各フェーズの終わりで動作確認できるように分割してある。

| # | フェーズ | 内容 | 完了条件 |
|---|---|---|---|
| 1 | 骨組み | Vite + TS + ESLint + CSP付き `index.html` + GitHub Actions | 空の黒画面が Pages にデプロイされる |
| 2 | 表示 | `Viewer.ts`、`SparkRenderer`、ファイル入力、Spark でそのまま全件描画 | `.ply` をドロップすると（間引きなしで）表示される |
| 3 | カメラ | `autoFit.ts` + `OrbitCameraController` | どんなファイルでも開いた瞬間に全体が画面に収まる |
| 4 | 間引き | `importance.ts` + `levels.ts` + `subset.ts` + 解像度UI | 5段階が切り替わり、splat 数が想定どおり |
| 5 | 進捗/エラー | `ProgressOverlay` + エラーハンドリング + 再パース経路 | 500MBファイルで進捗が滑らかに出る |
| 6 | ギズモ | `AxisGizmo.ts` | 軸表示とクリックスナップが動く |
| 7 | VR | `VrSession` + `Locomotion` + `GrabController` | Quest 2 実機で移動とグラブが動く |
| 8 | 仕上げ | 背景色、文言整理、README、13.3 の検証 | 全手動確認項目を通過 |

フェーズ 1〜8 は実装済み。`PackedSplats` の挙動スパイク（7.3）はフェーズ2の直後に実施し、
容量の 2048 単位切り上げという想定外の制約を発見した。ここを潰さないままフェーズ4に
進むと「例外は出ないが何も描画されない」状態になっていた。

---

## 17. 設定定数一覧（`config.ts`）

```ts
// ── レベル定義 ────────────────────────────────
export const LEVELS = [ /* 5章参照 */ ];
export const DEFAULT_LEVEL = 2;

// ── 間引き ────────────────────────────────────
export const IMPORTANCE_AREA_EXPONENT = 2 / 3;
export const IMPORTANCE_HISTOGRAM_BINS = 1024;

// ── メモリ戦略 ─────────────────────────────────
export const KEEP_FULL_IN_MEMORY = false;   // 8.1 参照

// ── カメラ ────────────────────────────────────
export const AUTOFIT_SAMPLE_COUNT = 100_000;
export const AUTOFIT_PERCENTILE_LOW = 0.01;
export const AUTOFIT_PERCENTILE_HIGH = 0.99;
export const AUTOFIT_MARGIN = 1.2;
export const DEFAULT_UP = new THREE.Vector3(0, -1, 0);
export const ENABLE_UP_ESTIMATION = true;
export const UP_ESTIMATE_CONFIDENCE = 0.35;

// ── ギズモ ────────────────────────────────────
export const GIZMO_SIZE = 120;
export const GIZMO_MARGIN = 12;
export const GIZMO_SNAP_DURATION_MS = 400;

// ── VR ────────────────────────────────────────
export const VR_MOVE_SPEED_RATIO = 0.15;     // radius に対する毎秒移動量
export const VR_SNAP_ANGLE_DEG = 30;
export const VR_SNAP_ON_THRESHOLD = 0.7;
export const VR_SNAP_OFF_THRESHOLD = 0.3;
export const VR_SCALE_MIN = 0.05;
export const VR_SCALE_MAX = 20;
export const VR_FIXED_FOVEATION = 1.0;
export const VR_FRAMEBUFFER_SCALE = 0.8;

// ── UI ────────────────────────────────────────
export const BACKGROUND_COLORS = ['#000000', '#ffffff', '#808080'];
export const PROGRESS_YIELD_INTERVAL_MS = 100;
```

---

## 18. 将来拡張

優先度順。いずれも本設計を壊さずに追加できる。

| # | 項目 | 実装の勘所 |
|---|---|---|
| 1 | **上下反転ボタン** | `worldRoot` を X 軸周りに 180° 回すだけ。9.4 の推定が外れた場合の救済として効果が大きく、実装は数行。**早期の追加を強く推奨する** |
| 2 | 解像度切替の即時化 | `config.ts` の `KEEP_FULL_IN_MEMORY` を `true` にする。8.1 参照 |
| 3 | `.sog` 対応 | Spark は既に `PCSOGS` / `PCSOGSZIP` を対応済み。形式判定のホワイトリストに追加するだけで動く見込み。ただし SOG は SH がコードブック方式（`sh1Codes` 等）のため、7.3 のフォールバックが発動する。SH 保持のサブセット化には追加実装が必要 |
| 4 | スクリーンショット保存 | `preserveDrawingBuffer: true` が必要になり常時の性能が落ちるため、保存時だけ再描画する方式にすること |
| 5 | 直近ファイルの記憶 | File System Access API のハンドルを IndexedDB に保存。端末にデータが残る旨の説明が必要 |
| 6 | VR内での解像度変更UI | 空間UIパネルの実装が必要。11.1 の「VR中は変更不可」の制約が外れる |
| 7 | 一人称ウォークモード | Spark の `SparkControls`（`FpsMovement` + `PointerControls`）がそのまま使える |
| 8 | PWA オフライン対応 | Service Worker の更新戦略（古い版の居座り対策）を必ず設計すること |
| 9 | 多言語対応 | `ui/strings.ts` に文言を集約済みなので、辞書化は容易 |

---

## 19. 既知の制約: データ側に起因する亀裂状の抜け

一部のファイルで、面に細かい亀裂状・斑点状の抜けが出ることがある。
**これはビューア側の不具合ではなく、データ側の被覆不足である。**

原因は「隣り合う splat の間隔に対して splat が小さく、面を覆いきれていない」こと。
実測（351,605 splats の `.splat`）:

| 条件 | 最近傍距離/σ (p90) | 顔中央部の平均透過率 | 見た目 |
|---|---|---|---|
| 元データ | 1.51 | 2.5% | 亀裂がはっきり見える |
| σ を 1.5 倍 | 0.97 | 0.1% | 亀裂が消える |
| σ を 2.0 倍 | 0.73 | 0.0% | 亀裂が消える |

**判定基準は「最近傍距離 / σ の p90 が 1.0 以下」。**
`tools/check-splat-coverage.mjs` で `.splat` / `.ply` を検査できる。
データ提供者に渡す説明は `docs/splat-data-requirements.md` にまとめてある。

### 調査で否定した仮説（再挑戦しないこと）

**位置の float16 量子化は原因ではない。**
Spark の既定表現 `PackedSplats` は位置を float16 で保持し、このファイルでは
量子化誤差が σ の最大 34.8% に達する。そのため一度は位置を float32 で保持する
`ExtSplats`（+ `SparkRenderer` の `accumExtSplats: true`）へ切り替えたが、

- 同一データ・同一カメラで描画を比較したところ、**亀裂はまったく変化しなかった**
  （画素差の最大 8.6%、97.8% の画素で差 2% 以下）
- メモリが 16→32 B/splat（SH 込みで 56→96 B/splat）に増え、テクスチャ帯域も倍になり、
  **実機で描画が重くなって再生できなくなった**

ため取り消した。float16 量子化自体は実在するが副次的な要因で、
`|座標| / σ` が極端に大きいデータでのみ効いてくる。参考値として
`check-splat-coverage.mjs` が併せて表示する。

## 19. 決定ログ

設計中に行った主要な判断と、その根拠・トレードオフ。

| # | 決定 | 根拠 | 承知しているトレードオフ |
|---|---|---|---|
| D-1 | `.sog` をスコープ外にする | 依頼者の判断。対応形式を絞ることでライブラリ選定の自由度が上がった | SOG の圧縮率（PLY比 15〜20倍）の恩恵を受けられない |
| D-2 | Spark を採用 | 2.2 の5点。特に `SharedArrayBuffer` 非依存と `fixedFoveation` の存在 | 比較的新しいライブラリであり、内部実装への依存が一部発生する（7.3 で緩和） |
| D-3 | 重要度順の間引き | 低レートでも形状と輪郭が保たれる | ランダム法よりスコアリングの1パスが増える |
| D-4 | ヒストグラム法でランキング | 300万件の全ソート（1〜2秒）を回避しつつ、件数は厳密に一致する | ビン数（1024）が少なすぎると境界 bin の偏りが出る。実装時に確認すること |
| D-5 | **レベル毎に再パース** | 依頼者の判断。定常メモリを最小化する | 切替のたびに数秒待つ。**かつ切替時のピークメモリは常駐方式と同等**（8.1 参照）。`KEEP_FULL_IN_MEMORY` で覆せるようにした |
| D-6 | SH をレベル連動 | 低レベルでのメモリ削減幅が最大になる（SH は 40 B/splat、基本データの 2.5 倍） | 「高」と「オリジナル」以外は見た目が元と異なる |
| D-7 | `extractSplats()` を使わず自前実装 | Spark の `extractSplats()` は SH を落とす（実装を確認済み）ため D-6 と両立しない | Spark の内部配列レイアウトに依存する。ただしワード単位の不透明コピーなので量子化方式の変更には影響されない |
| D-8 | VR は移動と閲覧に専念（VR内UIなし） | 依頼者の判断。空間UIの実装コストが大きい | VR中に重いと感じたら一度 VR を抜ける必要がある |
| D-9 | `rig` と `worldRoot` を分離 | スティック移動とグラブ操作が互いの座標系を壊さないため | Group が1つ増える |
| D-10 | CSP で外部通信を機械的に禁止 | 依頼者の判断。要件の中核を規約ではなくブラウザに強制させる | `'wasm-unsafe-eval'` と `worker-src blob:` の許可が必要で、CSP としては最強ではない |
| D-11 | 進捗バーで待たせる（先行描画しない） | 依頼者の判断。実装が単純で振る舞いが読みやすい | 500MB ファイルでは十数秒の待ちが発生する |
| D-12 | 既定の向きを「-Y が上・+X が右」に固定 | 依頼者の指示。当初の方向 `(1, 0.6, 1)` では画面右ベクトルが `(-0.707, 0, 0.707)` となり **+X が左**を向いていた | 方向をハードコードせず条件から導出するため、算出コードがやや長い |
| D-13 | up の自動推定を既定で無効化 | D-12 で向きを明示指定されたため、推定が働くと指定した既定が守られない。推定は外すことがあり、ファイルごとに初期の向きが変わる | データ由来の傾きは自動補正されない。`ENABLE_UP_ESTIMATION` で戻せる |
| D-15 | VR 入場時に worldRoot の向き・位置・スケールを合わせる | VR では `camera.up` が無視されるため、モデル側を回さないと「-Y が上・+X が右」が成立しない。またモデル座標をそのまま XR 空間に置くと位置もスケールも破綻する | VR とデスクトップで `worldRoot` の状態が変わる。VR 終了時に単位変換へ戻す必要がある |
| D-23 | 主光源によるランバート陰影は入れない | 3DGS は元の陰影が焼き込まれているため、向きの違う陰影を足すと二重の影になり不自然になる。依頼者の判断でもある | 立体感の増し方は控えめ。必要なら `primaryLightDirection` が取れているので後から足せる |
| D-24 | 乗数を平均 1.0 に正規化する | 推定光をそのまま掛けると暗い部屋で二重に暗くなる。正規化すれば無彩色の環境では乗数がちょうど 1.0 になり、元データの見た目を壊さない | 環境の絶対的な明るさは反映されない。そこは露出項で別に扱う |
| D-25 | 露出は入場時を基準にした相対値 | ARCore の SH の絶対スケールは端末依存で仕様上の保証がない。相対値なら絶対校正なしでも妥当に振る舞い、起動時に大外ししない | AR に入った瞬間の明るさには合わない（原理的に合わせられない） |
| D-22 | 亀裂状の抜けはデータ側で直す | 原因は splat の被覆不足で、ビューア側では splat を大きくする以外に手が無い。それはデータの意図を書き換える操作なのでビューアが勝手にやるべきではない | 該当データはデータ提供者に再出力を依頼する必要がある。判定ツールと依頼文書を用意した |
| D-19 | XR ボタンの文言と要求するセッション種別を端末の対応状況から決める | スマートフォンは `immersive-ar` にしか対応しないため、`immersive-vr` を要求すると必ず失敗する。文言も「VR」では実態と合わない | 端末ごとに UI の見え方が変わる。検証は `navigator.xr` を差し替えて行う |
| D-20 | iOS の AR を対象外とする | 依頼者の判断。iOS Safari は WebXR 非対応で `navigator.xr` が存在せず、`getUserMedia` + `deviceorientation` による別系統の実装が必要になる | iPhone では AR ボタンが出ない |
| D-17 | パススルーを `immersive-ar` セッションとして実装 | WebXR にはパススルーを直接指定する API が無く、`immersive-ar` の環境ブレンドとして提供される | セッション種別が変わるため、VR とパススルーは入り直さないと切り替えられない |
| D-18 | 描画バッファの属性を `getContext` 側で指定 | 既存コンテキストを渡す構成では `WebGLRenderer` の `alpha` 等が無視され、パススルーで透過できない | `antialias` などもここで指定する必要があり、設定箇所が 1 か所に寄る |
| D-16 | グラブ回転の軸制限を撤廃し、フレーム間差分の積み上げに変更 | 依頼者の指摘。Yaw のみへの投影が 90 度で退化し 180 度で元に戻っていた。絶対差分では 180 度に特異点が残るため、フレーム間差分にした | 片手グラブが平行移動のみから 6 自由度の追従に変わり、意図せず回してしまう可能性がある。両手グラブは軸まわりのひねりを取らない |
| D-14 | OrbitControls → TrackballControls | 依頼者の指示。OrbitControls は極角 `phi` を `[0, π]` にクランプするため 90/180 度で回転が止まる。TrackballControls は特異点が無く回し続けられる | `up` がドラッグに追従して動き、斜めドラッグで少しロールが乗る。向きを戻す手段としてギズモの軸クリックがある |
