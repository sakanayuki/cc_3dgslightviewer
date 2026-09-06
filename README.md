# 3DGS Light Viewer

3D Gaussian Splatting (3DGS) のファイルを、ブラウザにドロップするだけで閲覧できる軽量ビューアです。

**公開先: https://sakanayuki.github.io/cc_3dgslightviewer/**

## 特徴

- **アップロード不要・外部通信ゼロ** — ファイルはブラウザ内でのみ処理されます。CSP により外部オリジンへの通信をブラウザレベルで禁止しています
- **対応形式** — `.ply`（未圧縮 / 圧縮）、`.splat`
- **解像度5段階** — 最低 / 低 / 中 / 高 / オリジナル。低スペックPC向けに既定は「中」（25%）
- **重要度順の間引き** — 不透明度と投影面積からスコアを付け、小さく薄い splat から削るため低レートでも輪郭が保たれます
- **XYZ軸ギズモ** — 右上に表示。軸をクリックするとその方向からの視点へスナップします
- **既定の向き** — -Y 軸が画面上、+X 軸が画面右。読み込み時に自動でシーン全体が収まる位置へ移動します
- **VRモード** — WebXR 対応。Meta Quest 2 のコントローラで移動・グラブ操作ができます

## 操作方法

### デスクトップ

| 操作 | 動作 |
|---|---|
| 左ドラッグ | 回転（**上下も左右も制限なし。何回転でも続けられます**） |
| 右ドラッグ / 中ドラッグ | 平行移動 |
| ホイール | ズーム |
| ギズモの軸をクリック | その方向からの視点へスナップ |

回転は極（真上・真下）で止まらない方式（トラックボール式）です。その代わり斜めに
ドラッグすると少しロールが乗ります。向きを戻したいときはギズモの軸をクリックしてください。

### VR（Meta Quest 2）

| 入力 | 動作 |
|---|---|
| 左スティック | 水平移動（頭の向いている方位が基準） |
| 右スティック 左右 | スナップ回転（30°刻み） |
| 左トリガー | ダッシュ（速度 ×3） |
| 右トリガー | 微調整（速度 ×0.3） |
| 片手グリップ | シーンを掴んで平行移動 |
| 両手グリップ | 平行移動 + Yaw回転 + 拡縮 |

解像度の変更は VR に入る前に行ってください（VR中は変更できません）。

## 開発

```bash
npm install
npm run dev        # 開発サーバ
npm run lint       # ESLint
npm run typecheck  # tsc --noEmit
npm run test       # Vitest（純粋関数のユニットテスト）
npm run build      # 本番ビルド
```

### 動作確認用のテストデータ

大きな `.ply` はリポジトリに含めていません。合成ファイルを生成できます。

```bash
# 出力先 splat数 SH次数 形状(slab|cube)
node tools/make-test-ply.mjs /tmp/test_sh3.ply 30000 3 slab   # SH次数3
node tools/make-test-ply.mjs /tmp/test_sh0.ply 20000 0 slab   # SHなし
```

`slab` は軸ごとに寸法が異なるため、ギズモの軸スナップや自動フィットの確認に向きます。
`cube` はどの軸から見ても同じに見えるので、視点の変化を確かめる用途には使えません。

### ブラウザ実機での受け入れ確認

`tools/verify-browser.mjs` が、ビルド済み `dist/` をローカル配信して Chromium を駆動し、
描画・5段階の splat 数・カメラ固定・背景色・ギズモ・エラー処理・**外部通信ゼロ**を
実画面から検証します。CI には含めていません（Playwright と Chromium が必要なため）。

```bash
npm run build
npm i -D playwright && npx playwright install chromium   # 未導入の場合
node tools/make-test-ply.mjs /tmp/verify_sh3.ply 30000 3 slab
node tools/make-test-ply.mjs /tmp/verify_sh0.ply 20000 0 slab
node tools/verify-browser.mjs        # CHROMIUM_PATH で実行ファイルを指定可能
```

## 外部通信ゼロの検証手順

リリース前に必ず実施してください。

1. Chrome DevTools の Network タブを開き、`Preserve log` を有効にする
2. アプリを読み込み、リクエストが完了した時点で `Clear` する
3. `.ply` ファイルをドロップし、表示完了まで待つ
4. 解像度を5段階すべて切り替える
5. **Network タブに新規リクエストが1件も出ないことを確認する**
6. Console に CSP 違反の警告が出ていないことを確認する

## デプロイ

`main` への push で GitHub Actions が lint / typecheck / test / build を実行し、
GitHub Pages へ公開します。リポジトリの Settings → Pages → Source が
**GitHub Actions** になっている必要があります。

## 設計

詳細な設計判断とその根拠は [docs/design.md](docs/design.md) を参照してください。
チューニング可能な定数は [src/config.ts](src/config.ts) に集約しています。

## ライセンス

依存: [three.js](https://threejs.org/) (MIT) / [Spark](https://sparkjs.dev/) (MIT)
