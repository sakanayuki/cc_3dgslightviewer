/**
 * ブラウザ実機での受け入れ確認スクリプト。
 *
 * ビルド済みの dist/ をローカルで配信し、Chromium を Playwright で駆動して
 * 「描画されるか」「5段階が期待どおりの件数になるか」「外部通信が発生しないか」
 * などを実際の画面から検証する。CI には組み込んでいない (Playwright と
 * Chromium が必要なため)。手元で通したいときだけ実行する。
 *
 *   npm run build
 *   npm i -D playwright && npx playwright install chromium   # 未導入の場合
 *   node tools/make-test-ply.mjs /tmp/verify_sh3.ply 30000 3 slab
 *   node tools/make-test-ply.mjs /tmp/verify_sh0.ply 20000 0 slab
 *   node tools/verify-browser.mjs
 *
 * Chromium のパスは CHROMIUM_PATH 環境変数で上書きできる。
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';

const DIST = join(process.cwd(), 'dist');
const BASE = '/cc_3dgslightviewer/';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm' };
const ok = (b) => (b ? 'OK' : '*** NG ***');
let failures = 0;
const check = (label, cond, extra = '') => {
  if (!cond) failures++;
  console.log(`  ${label.padEnd(42)} ${ok(cond)} ${extra}`);
};

const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.startsWith(BASE)) p = p.slice(BASE.length - 1);
  let f = normalize(join(DIST, p));
  if (!f.startsWith(DIST)) { res.writeHead(403).end(); return; }
  if (!existsSync(f) || statSync(f).isDirectory()) f = join(DIST, 'index.html');
  res.writeHead(200, { 'Content-Type': MIME[extname(f)] ?? 'application/octet-stream' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const launchOptions = {
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
};
if (process.env.CHROMIUM_PATH) launchOptions.executablePath = process.env.CHROMIUM_PATH;
const browser = await chromium.launch(launchOptions);
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));
const external = [];
page.on('request', (r) => {
  const u = r.url();
  if (!u.startsWith(`http://localhost:${port}`) && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(`${r.method()} ${u}`);
});

/** スクリーンショットをページ内の 2D canvas でデコードして統計を取る */
async function shotStats(clip) {
  const buf = await page.screenshot(clip ? { clip } : {});
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let nonBlack = 0, sum = [0, 0, 0], centroidX = 0, centroidY = 0, weight = 0;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let i = 0; i < d.length; i += 4) {
      const px = (i / 4) % c.width, py = Math.floor(i / 4 / c.width);
      sum[0] += d[i]; sum[1] += d[i + 1]; sum[2] += d[i + 2];
      const lum = d[i] + d[i + 1] + d[i + 2];
      if (lum > 24) {
        nonBlack++; centroidX += px * lum; centroidY += py * lum; weight += lum;
        if (px < x0) x0 = px; if (px > x1) x1 = px;
        if (py < y0) y0 = py; if (py > y1) y1 = py;
      }
    }
    const n = d.length / 4;
    return {
      width: c.width, height: c.height, pixels: n, nonBlack,
      mean: sum.map((v) => Math.round(v / n)),
      centroid: weight ? [Math.round(centroidX / weight), Math.round(centroidY / weight)] : null,
      bbox: x1 >= 0 ? [x1 - x0 + 1, y1 - y0 + 1] : null,
    };
  }, buf.toString('base64'));
}

/** Spark のソートは非同期なので、描画が現れるまで待つ */
async function waitForRender(clip, minPixels = 3000, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let last = await shotStats(clip);
  while (Date.now() < deadline && last.nonBlack < minPixels) {
    await page.waitForTimeout(400);
    last = await shotStats(clip);
  }
  return last;
}

await page.goto(`http://localhost:${port}${BASE}`, { waitUntil: 'load' });
await page.waitForTimeout(1200);

console.log('=== 1. 初期表示 ===');
check('ドロップゾーンが表示される', await page.locator('.dropzone').isVisible());
check('外部送信しない旨が明示される',
  (await page.locator('.dropzone__privacy').innerText()).includes('外部に送信されることはありません'));
check('対応形式が .ply / .splat と表示される',
  (await page.locator('.dropzone__formats').innerText()).includes('.ply / .splat'));
check('パネルは非表示', await page.locator('.panel').isHidden());

console.log('\n=== 2. SH次数3 PLY (30,000 splats) の読み込み ===');
await page.locator('input[type=file]').setInputFiles('/tmp/verify_sh3.ply');
await page.waitForSelector('.panel:not([hidden])', { timeout: 60000 });
await page.waitForTimeout(800);
check('既定レベルが「中」', (await page.locator('#level-select').inputValue()) === '2');
check('splat 数が 25% = 7,500', (await page.locator('.panel__info').innerText()).startsWith('7,500'));
check('ファイル名が表示される', (await page.locator('.panel__filename').innerText()) === 'verify_sh3.ply');

// 描画領域のみを見る (パネル・ギズモを除いた中央部)
const viewClip = { x: 300, y: 100, width: 680, height: 560 };
const s2 = await waitForRender(viewClip, 5000);
check('splat が描画されている', s2.nonBlack > 5000, `非黒 ${s2.nonBlack}px`);

console.log('\n=== 3. 自動フィット ===');
check('モデルが画面中央付近に収まる',
  s2.centroid && Math.abs(s2.centroid[0] - 340) < 130 && Math.abs(s2.centroid[1] - 280) < 130,
  `重心 ${JSON.stringify(s2.centroid)} (中心は [340,280])`);

console.log('\n=== 4. 解像度5段階 ===');
const expected = [1500, 3600, 7500, 15000, 30000];
const counts = [];
for (let lv = 0; lv < 5; lv++) {
  await page.selectOption('#level-select', String(lv));
  await page.waitForFunction(
    (w) => document.querySelector('.panel__info')?.textContent?.replace(/[^0-9]/g, '') === String(w),
    expected[lv], { timeout: 60000 });
  const stats = await waitForRender(viewClip, 1000);
  counts.push(stats.nonBlack);
  check(`レベル${lv}: ${expected[lv].toLocaleString('ja-JP')} splats`, true, `描画 ${stats.nonBlack}px`);
}
check('レベルが上がるほど描画密度が増える',
  counts.every((c, i) => i === 0 || c >= counts[i - 1] * 0.95),
  counts.join(' -> '));

console.log('\n=== 5. レベル切替でカメラが動かない ===');
await page.selectOption('#level-select', '4');
await page.waitForTimeout(800);
const a = await shotStats(viewClip);
await page.selectOption('#level-select', '3');
await page.waitForTimeout(1200);
const b = await shotStats(viewClip);
check('切替前後で重心が変わらない',
  Math.abs(a.centroid[0] - b.centroid[0]) < 12 && Math.abs(a.centroid[1] - b.centroid[1]) < 12,
  `${JSON.stringify(a.centroid)} -> ${JSON.stringify(b.centroid)}`);

console.log('\n=== 6. 背景色の切り替え ===');
const bgClip = { x: 600, y: 5, width: 60, height: 40 };  // モデルもUIも無い上端
const bgBefore = await shotStats(bgClip);
await page.locator('.swatch').nth(1).click();  // 白
await page.waitForTimeout(500);
const bgWhite = await shotStats(bgClip);
await page.locator('.swatch').nth(2).click();  // 灰
await page.waitForTimeout(500);
const bgGray = await shotStats(bgClip);
await page.locator('.swatch').nth(0).click();  // 黒
await page.waitForTimeout(500);
const bgBlack = await shotStats(bgClip);
check('黒 -> 白', bgWhite.mean[0] > 200, `mean ${bgWhite.mean}`);
check('白 -> 灰', bgGray.mean[0] > 100 && bgGray.mean[0] < 190, `mean ${bgGray.mean}`);
check('灰 -> 黒', bgBlack.mean[0] < 30, `mean ${bgBlack.mean} (初期 ${bgBefore.mean})`);

console.log('\n=== 7. ギズモの軸クリックで視点スナップ ===');
const gizmoClip = { x: 1280 - 132, y: 12, width: 120, height: 120 };
const gz = await shotStats(gizmoClip);
check('ギズモが描画されている', gz.nonBlack > 100, `非黒 ${gz.nonBlack}px`);
const viewA = await shotStats(viewClip);
// デバッグで確認済みの各軸ラベル球の位置 (ギズモ中心からのオフセット)
const AXIS_OFFSETS = { '+X': [-27, 10], '+Z': [25, 10], '+Y': [-1, 33] };
const shapes = { 初期: viewA.bbox };
for (const [name, [dx, dy]] of Object.entries(AXIS_OFFSETS)) {
  await page.mouse.click(1280 - 132 + 60 + dx, 12 + 60 + dy);
  await page.waitForTimeout(900);
  shapes[name] = (await shotStats(viewClip)).bbox;
}
console.log('  投影bbox:', Object.entries(shapes).map(([k, v]) => `${k}=${v?.join('x')}`).join('  '));
const ratios = Object.entries(shapes).map(([k, v]) => [k, v ? v[0] / v[1] : 0]);
const distinct = new Set(ratios.map(([, r]) => r.toFixed(1))).size;
check('軸クリックで投影形状が変わる', distinct >= 3,
  `縦横比 ${ratios.map(([k, r]) => `${k}=${r.toFixed(2)}`).join(' ')}`);

console.log('\n=== 8. SH次数0 PLY (.ply, SHなし) ===');
await page.locator('.panel__actions .button').first().click();
await page.waitForTimeout(300);
await page.locator('input[type=file]').setInputFiles('/tmp/verify_sh0.ply');
await page.waitForSelector('.panel:not([hidden])', { timeout: 60000 });
await page.waitForTimeout(800);
check('splat 数が 25% = 5,000', (await page.locator('.panel__info').innerText()).startsWith('5,000'));
const sh0 = await waitForRender(viewClip, 3000);
if (sh0.nonBlack <= 3000) await page.screenshot({ path: '/tmp/fail_sh0.png' });
check('SHなしでも描画される', sh0.nonBlack > 3000, `非黒 ${sh0.nonBlack}px 重心 ${JSON.stringify(sh0.centroid)}`);

console.log('\n=== 9. エラー処理 ===');
await page.locator('.panel__actions .button').first().click();
await page.waitForTimeout(200);
writeFileSync('/tmp/broken.ply', 'this is not a ply file at all');
await page.locator('input[type=file]').setInputFiles('/tmp/broken.ply');
await page.waitForSelector('.overlay--error', { timeout: 20000 });
check('壊れたファイルで日本語エラーが出る',
  (await page.locator('.overlay__title').innerText()).includes('解析に失敗'));
await page.locator('.overlay .button').click();
await page.waitForTimeout(300);
check('閉じるとドロップゾーンに戻る', await page.locator('.dropzone').isVisible());

writeFileSync('/tmp/broken.xyz', 'nope');
await page.locator('input[type=file]').setInputFiles('/tmp/broken.xyz');
await page.waitForSelector('.overlay--error', { timeout: 20000 });
const extErr = await page.locator('.overlay__title').innerText();
check('非対応拡張子で専用メッセージが出る', extErr.includes('対応していません') || extErr.includes('解釈できません'), extErr);

console.log('\n=== 10. 外部通信ゼロ ===');
check('外部オリジンへのリクエストなし', external.length === 0, external.join(', '));
const csp = logs.filter((l) => /Content Security Policy/i.test(l));
check('CSP 違反なし', csp.length === 0, csp.slice(0, 2).join(' | '));
const errs = logs.filter((l) => l.startsWith('[pageerror]'));
check('未捕捉の例外なし', errs.length === 0, errs.slice(0, 3).join(' | '));

await page.screenshot({ path: '/tmp/final.png' });
console.log(`\n=========== ${failures === 0 ? 'ALL CHECKS PASSED' : failures + ' CHECK(S) FAILED'} ===========`);
await browser.close();
server.close();
process.exit(failures === 0 ? 0 : 1);
