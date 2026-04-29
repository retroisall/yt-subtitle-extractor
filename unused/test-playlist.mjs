// test-playlist.mjs — 測試合輯/播放清單模式下的字幕載入
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = __dirname;

// 用有字幕的影片 + 公開播放清單參數模擬合輯情境
// Rick Astley - Never Gonna Give You Up，帶入播放清單參數
const PLAYLIST_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLH1JzQDZHEaFhBBj5rNTxDv0vJr3Pqwge&index=1';
// 合輯第二部影片（同一個播放清單，SPA 導航測試）
const VIDEO2_URL   = 'https://www.youtube.com/watch?v=jNQXAC9IVRw&list=PLH1JzQDZHEaFhBBj5rNTxDv0vJr3Pqwge&index=2';

console.log('🔧 載入套件路徑:', extensionPath);

const context = await chromium.launchPersistentContext('', {
  headless: false,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-sandbox',
  ],
});

const page = await context.newPage();

// 印出套件 log（過濾 YT-SUB）
page.on('console', msg => {
  const text = msg.text();
  if (text.includes('[YT-SUB]')) console.log(' ', text);
  if (msg.type() === 'error') console.log('  [頁面錯誤]', text);
});

let allPassed = true;

// ===== 測試 1：直接開啟合輯 URL（有 &list= 參數）=====
console.log('\n[測試 1] 開啟合輯 URL（帶 &list= 參數）...');
await page.goto(PLAYLIST_URL, { waitUntil: 'domcontentloaded' });

try {
  await page.waitForSelector('#yt-sub-demo-sidebar', { timeout: 10000 });
  console.log('  ✅ 側邊欄出現');
} catch (e) {
  console.log('  ❌ 側邊欄未出現'); allPassed = false;
  await context.close(); process.exit(1);
}

try {
  await page.waitForSelector('.yt-sub-demo-lang-btn', { timeout: 15000 });
  const btns = await page.$$eval('.yt-sub-demo-lang-btn', els => els.map(e => e.textContent.trim()));
  console.log('  ✅ 找到', btns.length, '個字幕語言:', btns.join(', '));
} catch (e) {
  const status = await page.$eval('#yt-sub-demo-status', el => el.textContent).catch(() => '?');
  console.log('  ❌ 找不到字幕按鈕，目前狀態:', status);
  allPassed = false;
}

// ===== 測試 2：在合輯模式下載入字幕內容 =====
console.log('\n[測試 2] 點選字幕並確認內容（合輯模式）...');
try {
  await page.click('.yt-sub-demo-lang-btn');
  await page.waitForSelector('.yt-sub-demo-item', { timeout: 15000 });
  const count = await page.$$eval('.yt-sub-demo-item', els => els.length);
  const first = await page.$eval('.yt-sub-demo-item .yt-sub-demo-text', el => el.textContent.trim());
  console.log('  ✅ 字幕載入成功！共', count, '句');
  console.log('  第一句:', first);
} catch (e) {
  const status = await page.$eval('#yt-sub-demo-status', el => el.textContent).catch(() => '?');
  console.log('  ❌ 字幕內容未出現，狀態:', status);
  allPassed = false;
}

// ===== 測試 3：合輯內 SPA 導航到下一支影片 =====
console.log('\n[測試 3] 在合輯內切換到第二部影片（SPA 導航）...');
await page.goto(VIDEO2_URL, { waitUntil: 'domcontentloaded' });

try {
  await page.waitForFunction(
    () => {
      const btns = document.querySelectorAll('.yt-sub-demo-lang-btn');
      return btns.length > 0;
    },
    { timeout: 20000 }
  );
  const btns = await page.$$eval('.yt-sub-demo-lang-btn', els => els.map(e => e.textContent.trim()));
  console.log('  ✅ 合輯切換後找到', btns.length, '個字幕:', btns.slice(0, 3).join(', '));
} catch (e) {
  const status = await page.$eval('#yt-sub-demo-status', el => el.textContent).catch(() => '?');
  console.log('  ❌ 合輯切換後字幕未更新，狀態:', status);
  allPassed = false;
}

console.log('\n' + (allPassed ? '✅ 全部通過！' : '❌ 有測試失敗'));
console.log('瀏覽器將在 5 秒後關閉...');
await page.waitForTimeout(5000);
await context.close();
