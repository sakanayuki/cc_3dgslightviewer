import { defineConfig } from 'vite';

// GitHub Pages はリポジトリ名のサブパス配下で配信されるため base を固定する。
// カスタムドメインへ移行する場合はここを '/' に変更する。
export default defineConfig({
  base: '/cc_3dgslightviewer/',
  build: {
    target: 'es2022',
    sourcemap: false,
    // Spark + three は大きく、単一チャンクで 1.5MB 前後になる。
    chunkSizeWarningLimit: 2000,
  },
});
