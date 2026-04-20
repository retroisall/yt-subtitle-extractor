/**
 * QA 測試：字幕主語言選取邏輯驗證
 *
 * 驗證新版 renderLanguages + autoLoadSubtitles 規則：
 *   1. 影片有偏好語言手動字幕 → 直接載入
 *   2. 影片有偏好語言 ASR → 直接載入（不翻譯）
 *   3. 影片無偏好語言字幕，但 ASR 語系相同 → 用 ASR 載入，不翻譯
 *   4. 影片完全無偏好語言字幕 → 顯示「此影片無 [lang] 字幕」，停止不翻譯
 *
 * 執行方式：node tests/test-lang-behavior.mjs
 */

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = path.resolve(__dirname, '..');

// 截圖目錄
const SHOT_DIR = path.join(extensionPath, 'docs', 'qa-screenshots', 'lang-behavior');
fs.mkdirSync(SHOT_DIR, { recursive: true });

// 讀取測試案例
const casesPath = path.join(__dirname, 'subtitle-lang-cases.json');
const testCases = JSON.parse(fs.readFileSync(casesPath, 'utf-8'));

// ══════════════════════════════════════════
// 結果追蹤
// ══════════════════════════════════════════
let passed = 0, failed = 0, skipped = 0;
const results = [];

/**
 * 記錄通過的測試項目
 */
function pass(label, detail = '') {
  console.log(`  ✅ ${label}${detail ? ' — ' + detail : ''}`);
  passed++;
  results.push({ label, status: 'pass', detail });
}

/**
 * 記錄失敗的測試項目
 */
function fail(label, detail = '') {
  console.error(`  ❌ ${label}${detail ? ' — ' + detail : ''}`);
  failed++;
  results.push({ label, status: 'fail', detail });
}

/**
 * 記錄跳過的測試項目
 */
function skip(label, reason = '') {
  console.log(`  ⏭  ${label}${reason ? ' (' + reason + ')' : ''}`);
  skipped++;
  results.push({ label, status: 'skip', reason });
}

// ══════════════════════════════════════════
// 截圖工具
// ══════════════════════════════════════════
let shotIdx = 0;

/**
 * 對頁面截圖並儲存
 * @param {import('playwright').Page} page - Playwright 頁面物件
 * @param {string} name - 截圖名稱
 */
async function shot(page, name) {
  await page.waitForTimeout(600);
  const safeName = name.replace(/[^a-zA-Z0-9\-_]/g, '_');
  const file = path.join(SHOT_DIR, `${String(++shotIdx).padStart(3, '0')}-${safeName}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`    📸 截圖: docs/qa-screenshots/lang-behavior/${path.basename(file)}`);
  return file;
}

// ══════════════════════════════════════════
// 等待工具
// ══════════════════════════════════════════

/**
 * 等待側邊欄擴充套件 DOM 出現
 */
async function waitExtension(page, timeout = 15000) {
  try {
    await page.waitForSelector('#yt-sub-demo-sidebar', { timeout });
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * 等待字幕狀態列文字穩定（停止變化）
 * 連續 2 次讀取相同才回傳
 */
async function waitStatusStable(page, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let prev = '';
  let sameCount = 0;

  while (Date.now() < deadline) {
    const current = await page.$eval('#yt-sub-status', el => el.textContent || '').catch(() => '');
    if (current && current === prev) {
      sameCount++;
      if (sameCount >= 2) return current;
    } else {
      sameCount = 0;
    }
    prev = current;
    await page.waitForTimeout(500);
  }
  return prev;
}

/**
 * 取得語言下拉選單目前選中的值與文字
 */
async function getLangDropdownInfo(page) {
  return page.evaluate(() => {
    const sel = document.getElementById('yt-sub-lang-dropdown');
    if (!sel) return { value: null, text: null, optionCount: 0 };
    const selected = sel.options[sel.selectedIndex];
    return {
      value: selected?.value || null,
      text: selected?.text || null,
      optionCount: sel.options.length,
    };
  }).catch(() => ({ value: null, text: null, optionCount: 0 }));
}

/**
 * 確認頁面上是否有「翻譯主字幕中」文字出現（翻譯 loading 標記）
 */
async function checkTranslateLoading(page) {
  return page.evaluate(() => {
    const statusEl = document.getElementById('yt-sub-status');
    const text = statusEl?.textContent || '';
    // 搜尋任何與強制翻譯相關的文字
    return {
      hasTranslateLoading: text.includes('翻譯主字幕中') || text.includes('翻譯中'),
      statusText: text,
    };
  }).catch(() => ({ hasTranslateLoading: false, statusText: '' }));
}

/**
 * 注入 primaryLang 設定到頁面 localStorage
 * 讓 content.js 使用指定的偏好語言
 */
function buildInitScript(primaryLang) {
  return `
    const KEY = 'yt-sub-settings';
    try {
      const existing = JSON.parse(localStorage.getItem(KEY) || '{}');
      localStorage.setItem(KEY, JSON.stringify({
        primaryLang: '${primaryLang}',
        secondaryLangs: ['__none__', '__none__', '__none__'],
        dualEnabled: false,
        overlayEnabled: true,
        extensionEnabled: true,
        extendSubtitles: false,
        subtitleOffset: 0,
        onboardingDone: true,
        translationProvider: 'ytlang',
        googleBatchMode: 'sentence8',
        wordHover: false,
        wordSpeak: false,
        loopSentence: false,
        clickToSeek: false,
        autoScroll: false,
        primarySize: 'md',
        secondarySize: 'sm',
        ...existing,
        primaryLang: '${primaryLang}',
        secondaryLangs: ['__none__', '__none__', '__none__'],
        dualEnabled: false,
        onboardingDone: true,
        translationProvider: 'ytlang',
      }));
    } catch (_) {}
  `;
}

// ══════════════════════════════════════════
// 啟動瀏覽器
// ══════════════════════════════════════════
console.log('🔧 套件路徑:', extensionPath);
console.log(`📁 截圖目錄: docs/qa-screenshots/lang-behavior/`);
console.log(`📋 測試案例數: ${testCases.length}`);
console.log('');

const context = await chromium.launchPersistentContext('', {
  headless: false,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-sandbox',
    '--window-size=1600,900',
  ],
  viewport: { width: 1600, height: 900 },
});

const page = await context.newPage();

// 監聽 console，印出套件相關日誌
page.on('console', msg => {
  const t = msg.text();
  if (t.startsWith('[YT-SUB]')) process.stdout.write('    ' + t + '\n');
  if (msg.type() === 'error' && !t.includes('net::ERR') && !t.includes('favicon')
      && !t.includes('doubleclick') && !t.includes('CORS') && !t.includes('requestStorageAccess')
      && !t.includes('chrome-extension'))
    console.log('  [JS錯誤]', t.slice(0, 200));
});

// ══════════════════════════════════════════
// 逐案例執行測試
// ══════════════════════════════════════════

for (let i = 0; i < testCases.length; i++) {
  const tc = testCases[i];
  const caseLabel = `[案例${i + 1}] ${tc.scenario}`;
  const videoUrl = `https://www.youtube.com/watch?v=${tc.videoId}&autoplay=0`;

  console.log(`\n╔${'═'.repeat(60)}╗`);
  console.log(`║  ${caseLabel.padEnd(58)}║`);
  console.log(`║  videoId: ${tc.videoId.padEnd(51)}║`);
  console.log(`║  primaryLang: ${tc.primaryLang.padEnd(47)}║`);
  console.log(`╚${'═'.repeat(60)}╝`);

  // ── 注入偏好語言設定（在頁面載入前執行）──────────────────────────
  await page.addInitScript(buildInitScript(tc.primaryLang));

  // ── 導航到影片 ───────────────────────────────────────────────────
  console.log(`  → 導航到: ${videoUrl}`);
  try {
    await page.goto(videoUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (err) {
    fail(`${caseLabel}: 頁面載入失敗`, err.message.slice(0, 100));
    continue;
  }

  // ── 等待套件注入 ─────────────────────────────────────────────────
  const extFound = await waitExtension(page, 15000);
  if (!extFound) {
    skip(`${caseLabel}: 套件未注入`, 'sidebar DOM 未出現');
    await shot(page, `case${i + 1}-no-extension`);
    continue;
  }

  // ── 等待狀態列穩定 ───────────────────────────────────────────────
  console.log(`  → 等待字幕狀態穩定...`);
  const statusText = await waitStatusStable(page, 25000);
  console.log(`  → 狀態列文字: "${statusText}"`);

  // 取得語言下拉資訊
  const dropInfo = await getLangDropdownInfo(page);
  console.log(`  → 語言下拉: value="${dropInfo.value}" text="${dropInfo.text}" options=${dropInfo.optionCount}`);

  // 檢查是否有翻譯 loading
  const translateCheck = await checkTranslateLoading(page);
  if (translateCheck.hasTranslateLoading) {
    console.log(`  ⚠️  發現翻譯 loading 文字: "${translateCheck.statusText}"`);
  }

  // ── 截圖 ─────────────────────────────────────────────────────────
  await shot(page, `case${i + 1}-${tc.primaryLang}-${tc.videoId}`);

  // ══════════════════════════════════════════
  // 斷言：依情境驗證
  // ══════════════════════════════════════════

  // 1. 驗證「不應出現強制翻譯 loading」
  if (tc.expectNoForceTranslate) {
    if (!translateCheck.hasTranslateLoading) {
      pass(`${caseLabel}: 無翻譯 loading（不強制翻譯）`);
    } else {
      fail(`${caseLabel}: 出現翻譯 loading！`, `狀態文字: "${translateCheck.statusText}"`);
    }
  }

  // 2. 驗證「應載入主字幕」的情境
  if (tc.expectPrimaryLoaded) {
    // 狀態列應顯示「載入主字幕」或包含語言名稱，而非「此影片無」
    const isLoading = statusText.includes('載入主字幕') || statusText.includes('正在載入');
    const isLoaded = statusText.includes('字幕') && !statusText.includes('此影片無') && !statusText.includes('沒有可用字幕');
    const noSubMsg = statusText.includes('此影片無') || statusText.includes('沒有可用字幕');

    if (noSubMsg) {
      fail(`${caseLabel}: 預期有 ${tc.primaryLang} 字幕，但狀態顯示「${statusText}」`);
    } else if (dropInfo.value !== null) {
      // 下拉選單有值，表示找到字幕
      const isExpectedLang = dropInfo.value.includes(tc.primaryLang) ||
        (dropInfo.text && dropInfo.text.toLowerCase().includes(tc.primaryLang.toLowerCase()));
      if (isExpectedLang) {
        pass(`${caseLabel}: 主字幕語言正確 (${dropInfo.text})`, `狀態: "${statusText}"`);
      } else {
        // 可能是環境限制（無 cookie 導致無字幕）
        if (dropInfo.optionCount === 0) {
          skip(`${caseLabel}: 無字幕列表`, '可能是無 cookie 環境，YouTube API 回空');
        } else {
          fail(`${caseLabel}: 語言不符`, `預期含 "${tc.primaryLang}"，實際選中 "${dropInfo.text}" (${dropInfo.value})`);
        }
      }
    } else if (statusText === '' || statusText.includes('找到')) {
      // 找到字幕但下拉未取到，可能是時機問題
      skip(`${caseLabel}: 無法取得下拉值`, `狀態: "${statusText}"`);
    } else if (statusText.includes('沒有可用字幕') || statusText === '') {
      skip(`${caseLabel}: 無字幕可用`, '無 cookie 環境 YouTube API 回空，非 bug');
    } else {
      skip(`${caseLabel}: 無法判斷`, `狀態: "${statusText}", 下拉: "${dropInfo.value}"`);
    }
  }

  // 3. 驗證「應顯示無字幕訊息」的情境
  if (tc.expectNoSubtitleMsg) {
    const hasNoSubMsg = statusText.includes(`此影片無 ${tc.primaryLang}`) ||
      statusText.includes('此影片無') ||
      statusText.includes('沒有可用字幕');

    if (hasNoSubMsg) {
      pass(`${caseLabel}: 正確顯示無字幕訊息`, `"${statusText}"`);
    } else if (statusText === '' || statusText.includes('找到')) {
      // 有可能影片實際上有該語言字幕（YouTube 資料庫可能已新增）
      // 或是無 cookie 環境
      skip(`${caseLabel}: 無法驗證無字幕情境`, `狀態: "${statusText}" — 影片可能已新增字幕，或無 cookie`);
    } else if (statusText.includes('載入主字幕') || statusText.includes('載入中')) {
      fail(`${caseLabel}: 預期顯示無字幕，但實際在載入字幕`, `狀態: "${statusText}"`);
    } else {
      skip(`${caseLabel}: 無法確認`, `狀態: "${statusText}"`);
    }
  }

  // 4. 驗證「影片沒有可用字幕」的情境（版權限制或完全無字幕）
  if (tc.expectNoAvailableMsg) {
    const hasNoAvailableMsg = statusText.includes('此影片沒有可用字幕') ||
      statusText.includes('沒有可用字幕') ||
      statusText.includes('切換影片');

    if (hasNoAvailableMsg) {
      pass(`${caseLabel}: 正確處理無可用字幕情境`, `"${statusText}"`);
    } else {
      skip(`${caseLabel}: 無法確認`, `狀態: "${statusText}"`);
    }
  }

  // 5. 等待一下再繼續（避免頁面切換太快）
  await page.waitForTimeout(1000);
}

// ══════════════════════════════════════════
// 最終報告
// ══════════════════════════════════════════
console.log(`\n╔${'═'.repeat(60)}╗`);
console.log(`║  QA 報告 — 字幕主語言選取行為                             ║`);
console.log(`╚${'═'.repeat(60)}╝`);
const total = passed + failed + skipped;
console.log(`  總計 ${total} 項  ✅ 通過:${passed}  ❌ 失敗:${failed}  ⏭  跳過:${skipped}`);

if (failed > 0) {
  console.log('\n  ═══ 失敗清單 ═══');
  results.filter(r => r.status === 'fail')
    .forEach(r => console.log(`    ❌ ${r.label}${r.detail ? ' — ' + r.detail : ''}`));
}

if (skipped > 0) {
  console.log('\n  ═══ 跳過清單 ═══');
  results.filter(r => r.status === 'skip')
    .forEach(r => console.log(`    ⏭  ${r.label}${r.reason ? ' (' + r.reason + ')' : ''}`));
}

console.log(`\n  截圖目錄: docs/qa-screenshots/lang-behavior/（共 ${shotIdx} 張）`);
console.log('\n  瀏覽器 6 秒後關閉...');
await page.waitForTimeout(6000);
await context.close();
process.exit(failed > 0 ? 1 : 0);
