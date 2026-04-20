/**
 * test-nav-btn-real.mjs
 * 真實場景下測試「下一句」(>) 按鈕功能
 *
 * 規則：
 * - 禁止注入假字幕，禁止 mock 任何資料
 * - 必須等擴充功能真正從 YouTube 載入字幕後再測試
 * - 字幕 30 秒內未載入：記錄實際錯誤，不改用假資料
 *
 * 判定標準：
 * - 5 次點擊，每次時間都有前進（diff > 0.1s）
 * - console log 顯示 nextIdx 遞增、same=false
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

// 擴充功能路徑（絕對路徑）
const EXT_PATH = 'd:\\dev\\chrome字幕套件開發';
const TARGET_URL = 'https://www.youtube.com/watch?v=3Io-WIiMKpA&t=22s';
const REPORT_PATH = 'd:\\dev\\chrome字幕套件開發\\docs\\qa-nav-btn-real.txt';
const CLICK_COUNT = 5;
const SUBTITLE_TIMEOUT_MS = 30000; // 字幕載入最長等待時間

/**
 * 等待指定毫秒
 */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 預設 localStorage 設定，確保 overlay 啟用、onboarding 完成
 * 注意：只設定 UI 狀態，不注入任何字幕資料
 */
function buildInitScript() {
  return `
    try {
      const KEY = 'yt-sub-settings';
      localStorage.setItem(KEY, JSON.stringify({
        primaryLang: 'en',
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
      }));
    } catch (_) {}
  `;
}

/**
 * 等待 #yt-sub-list 裡出現至少 1 個 .yt-sub-item
 * timeout 單位毫秒，逾時則回傳 false
 */
async function waitForRealSubtitles(page, timeout = SUBTITLE_TIMEOUT_MS) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const count = await page.$$eval(
      '#yt-sub-list .yt-sub-item',
      els => els.length
    ).catch(() => 0);
    if (count > 0) return count;
    await sleep(800);
  }
  return 0;
}

/**
 * 從 console log 解析 [YT-SUB][NAV] 的 nextIdx
 * 格式：> clicked base= X → nextIdx= Y same= false/true
 */
function parseNavIdx(logText) {
  const m = logText.match(/nextIdx=\s*(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * 從 console log 解析 same= 值
 */
function parseNavSame(logText) {
  const m = logText.match(/same=\s*(true|false)/);
  return m ? m[1] === 'true' : null;
}

/**
 * 將測試結果寫入報告檔案
 */
function writeReport(lines, reportPath) {
  const dir = path.dirname(reportPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(reportPath, lines.join('\n') + '\n', 'utf-8');
  console.log(`\n報告已儲存：${reportPath}`);
}

async function main() {
  const reportLines = [];
  const log = (msg) => {
    console.log(msg);
    reportLines.push(msg);
  };

  log('='.repeat(60));
  log('QA 測試報告：下一句 (>) 按鈕 ── 真實字幕場景');
  log(`執行時間：${new Date().toISOString()}`);
  log(`目標 URL：${TARGET_URL}`);
  log(`擴充功能：${EXT_PATH}`);
  log('規則：禁止假字幕 / 禁止 mock，必須等真實字幕載入');
  log('='.repeat(60));

  // 收集所有 [YT-SUB][NAV] console log 及其解析結果
  const navLogs = [];

  // 啟動帶有擴充功能的 Chrome（headed 模式，避免 YouTube bot 偵測）
  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--autoplay-policy=no-user-gesture-required',
      '--window-size=1600,900',
    ],
    viewport: { width: 1600, height: 900 },
  });

  const page = await context.newPage();

  // 注入 localStorage 設定（onboarding 完成、overlay 啟用），不注入字幕
  await page.addInitScript(buildInitScript());

  // 監聽 console 訊息，收集 [YT-SUB][NAV] log
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[YT-SUB][NAV]')) {
      const entry = `[CONSOLE] ${text}`;
      navLogs.push({ raw: entry, text });
      console.log(entry);
    } else if (text.includes('[YT-SUB]')) {
      console.log(`[CONSOLE] ${text}`);
    }
  });

  // --- 步驟 1：導航到 YouTube 影片 ---
  log('\n--- 步驟 1：導航到 YouTube 影片 ---');
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  log('頁面 domcontentloaded 完成');

  // --- 步驟 2：等待 video element 可播放 ---
  log('\n--- 步驟 2：等待 video element (YouTube player 初始化) ---');
  try {
    await page.waitForSelector('video', { timeout: 15000 });
    log('video element 已找到');
    // 等待 readyState >= 3 (HAVE_FUTURE_DATA)
    await page.waitForFunction(
      () => {
        const v = document.querySelector('video');
        return v && v.readyState >= 3;
      },
      { timeout: 15000 }
    ).catch(() => log('WARNING: video readyState < 3（可能仍在緩衝）'));
    const readyState = await page.evaluate(() => document.querySelector('video')?.readyState ?? -1);
    log(`video.readyState = ${readyState}`);
  } catch (e) {
    log(`ERROR: 無法找到 video element：${e.message}`);
    await context.close();
    writeReport(reportLines, REPORT_PATH);
    process.exit(1);
  }

  // --- 步驟 3：等待擴充功能 sidebar 出現 ---
  log('\n--- 步驟 3：等待擴充功能 sidebar (#yt-sub-demo-sidebar) ---');
  try {
    await page.waitForSelector('#yt-sub-demo-sidebar', { timeout: 20000 });
    log('Sidebar #yt-sub-demo-sidebar 已出現');
  } catch (e) {
    log(`ERROR: 找不到 #yt-sub-demo-sidebar，擴充功能可能未載入：${e.message}`);
    await context.close();
    writeReport(reportLines, REPORT_PATH);
    process.exit(1);
  }

  // --- 步驟 4：等待真實字幕載入（最多 30 秒）---
  log(`\n--- 步驟 4：等待真實字幕載入（最多 ${SUBTITLE_TIMEOUT_MS / 1000} 秒）---`);
  log('注意：禁止注入假字幕，必須等擴充功能從 YouTube 拉取真實字幕');
  const subtitleCount = await waitForRealSubtitles(page, SUBTITLE_TIMEOUT_MS);

  if (subtitleCount === 0) {
    // 字幕載入失敗，記錄實際錯誤狀態，不改用假資料
    const domDiag = await page.evaluate(() => ({
      hasSidebar: !!document.getElementById('yt-sub-demo-sidebar'),
      hasSubList: !!document.getElementById('yt-sub-list'),
      subItemCount: document.querySelectorAll('#yt-sub-list .yt-sub-item').length,
      statusText: document.getElementById('yt-sub-status')?.textContent || '',
      statusClass: document.getElementById('yt-sub-status')?.className || '',
      hasOverlay: !!document.getElementById('yt-sub-overlay'),
    }));
    log(`ERROR: 字幕在 ${SUBTITLE_TIMEOUT_MS / 1000} 秒內未載入`);
    log(`DOM 診斷：${JSON.stringify(domDiag, null, 2)}`);
    log('測試終止：依規定不改用假字幕');
    log('\n整體結果：FAIL ✗ (字幕載入失敗)');
    await context.close();
    writeReport(reportLines, REPORT_PATH);
    process.exit(1);
  }

  log(`真實字幕已載入：共 ${subtitleCount} 個 .yt-sub-item`);

  // 記錄字幕狀態文字
  const statusText = await page.$eval('#yt-sub-status', el => el.textContent || '').catch(() => '');
  log(`字幕狀態列文字：「${statusText}」`);

  // --- 步驟 5：確認 overlay 存在 ---
  log('\n--- 步驟 5：確認 #yt-sub-overlay 存在 ---');
  const overlayExists = await page.$('#yt-sub-overlay') !== null;
  if (!overlayExists) {
    // overlay 可能需要等待
    await page.waitForSelector('#yt-sub-overlay', { timeout: 10000 }).catch(() => {});
  }
  const overlayExistsFinal = await page.$('#yt-sub-overlay') !== null;
  log(`#yt-sub-overlay 狀態：${overlayExistsFinal ? '存在 ✓' : '不存在 ✗'}`);

  if (!overlayExistsFinal) {
    log('ERROR: overlay 不存在，無法進行 > 按鈕測試');
    await context.close();
    writeReport(reportLines, REPORT_PATH);
    process.exit(1);
  }

  // --- 步驟 6：讓影片播放幾秒，等待 #yt-sub-ov-next 出現 ---
  log('\n--- 步驟 6：讓影片播放，等待 #yt-sub-ov-next 按鈕出現 ---');

  // 確保影片從 t=22s 開始播放
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v) {
      v.currentTime = 22;
      v.play().catch(() => {});
    }
  });
  log('影片設定為 t=22s 並播放');

  try {
    await page.waitForSelector('#yt-sub-ov-next', { timeout: 15000 });
    log('#yt-sub-ov-next 按鈕已出現 ✓');
  } catch (e) {
    log(`ERROR: 找不到 #yt-sub-ov-next 按鈕：${e.message}`);
    const domDiag2 = await page.evaluate(() => ({
      hasSidebar: !!document.getElementById('yt-sub-demo-sidebar'),
      hasOverlay: !!document.getElementById('yt-sub-overlay'),
      hasNext: !!document.getElementById('yt-sub-ov-next'),
      statusText: document.getElementById('yt-sub-status')?.textContent || '',
      overlayToggleChecked: document.getElementById('yt-sub-overlay-toggle')?.checked,
      subItemCount: document.querySelectorAll('#yt-sub-list .yt-sub-item').length,
    }));
    log(`DOM 診斷：${JSON.stringify(domDiag2, null, 2)}`);
    await context.close();
    writeReport(reportLines, REPORT_PATH);
    process.exit(1);
  }

  // 讓字幕同步到當前時間再開始點擊
  await sleep(1500);

  // --- 步驟 7：連續點擊 > 按鈕 5 次 ---
  log(`\n--- 步驟 7：連續點擊 > 按鈕 ${CLICK_COUNT} 次 ---`);
  const timeRecords = [];
  const clickNavLogs = []; // 每次點擊後收到的 NAV log

  const timeInit = await page.evaluate(() => {
    const v = document.querySelector('video');
    return v ? v.currentTime : -1;
  });
  log(`初始影片時間：${timeInit.toFixed(3)}s`);
  timeRecords.push({ click: 0, time: timeInit });

  for (let i = 1; i <= CLICK_COUNT; i++) {
    log(`\n  [點擊 ${i}/${CLICK_COUNT}]`);

    // 記錄點擊前的 navLogs 數量（用來取出此次點擊新增的 log）
    const navLogsBefore = navLogs.length;

    const timePre = await page.evaluate(() => {
      const v = document.querySelector('video');
      return v ? v.currentTime : -1;
    });
    log(`  點擊前影片時間：${timePre.toFixed(3)}s`);

    // 點擊 > 按鈕
    await page.click('#yt-sub-ov-next');

    // 等待 seek 完成及 console log 抵達
    await sleep(1500);

    const timePost = await page.evaluate(() => {
      const v = document.querySelector('video');
      return {
        time: v ? v.currentTime : -1,
        overlayText: document.querySelector('#yt-sub-ov-primary')?.textContent?.trim() || '',
      };
    });

    const diff = timePost.time - timePre;
    const advanced = diff > 0.1;
    log(`  點擊後影片時間：${timePost.time.toFixed(3)}s  (diff: ${diff.toFixed(3)}s)  前進: ${advanced ? 'YES ✓' : 'NO ✗'}`);
    log(`  overlay 字幕：「${timePost.overlayText}」`);

    // 取出此次點擊新增的 NAV log
    const newNavLogs = navLogs.slice(navLogsBefore);
    if (newNavLogs.length > 0) {
      newNavLogs.forEach(nl => {
        const nextIdx = parseNavIdx(nl.text);
        const same = parseNavSame(nl.text);
        log(`  NAV log: ${nl.raw}  → nextIdx=${nextIdx}, same=${same}`);
        clickNavLogs.push({ click: i, nextIdx, same, raw: nl.raw });
      });
    } else {
      log(`  NAV log: （此次點擊未收到 NAV log）`);
      clickNavLogs.push({ click: i, nextIdx: null, same: null, raw: null });
    }

    timeRecords.push({
      click: i,
      timePre,
      timePost: timePost.time,
      diff,
      advanced,
      text: timePost.overlayText,
    });

    await sleep(300);
  }

  // --- 步驟 8：分析結果 ---
  log('\n--- 步驟 8：分析結果 ---');

  const clickResults = timeRecords.filter(r => r.click > 0);

  // 判定 1：每次點擊後時間前進
  const allAdvanced = clickResults.every(r => r.advanced);

  // 判定 2：nextIdx 遞增（無循環）
  let idxIncreasing = true;
  let idxSameFail = false;
  const idxValues = clickNavLogs.map(r => r.nextIdx).filter(v => v !== null);
  for (let i = 1; i < idxValues.length; i++) {
    if (idxValues[i] <= idxValues[i - 1]) {
      idxIncreasing = false;
      log(`  WARNING: nextIdx 非遞增：${idxValues[i - 1]} → ${idxValues[i]}`);
    }
  }
  const anySame = clickNavLogs.some(r => r.same === true);
  if (anySame) {
    idxSameFail = true;
    clickNavLogs.filter(r => r.same === true).forEach(r => {
      log(`  WARNING: 點擊 ${r.click} same=true（停在同一句）`);
    });
  }

  log('\n時間記錄彙整：');
  timeRecords.forEach(r => {
    if (r.click === 0) {
      log(`  初始: ${r.time.toFixed(3)}s`);
    } else {
      log(`  點擊 ${r.click}: ${r.timePre.toFixed(3)}s → ${r.timePost.toFixed(3)}s  diff=${r.diff.toFixed(3)}s  [${r.advanced ? '前進 ✓' : '未前進 ✗'}]  text=「${r.text}」`);
    }
  });

  log('\nnextIdx 遞增記錄：');
  if (idxValues.length === 0) {
    log('  （未收到任何 NAV log，無法驗證 nextIdx）');
  } else {
    log(`  nextIdx 序列：${idxValues.join(' → ')}`);
    log(`  遞增：${idxIncreasing ? 'YES ✓' : 'NO ✗'}`);
    log(`  存在 same=true：${anySame ? 'YES ✗' : 'NO ✓'}`);
  }

  log('\n--- [YT-SUB][NAV] Console Logs（完整記錄）---');
  if (navLogs.length === 0) {
    log('（未收到任何 [YT-SUB][NAV] log）');
  } else {
    navLogs.forEach(l => log(l.raw));
  }

  // 最終判定
  const noNavLogs = idxValues.length === 0;
  const overallPass = allAdvanced && idxIncreasing && !idxSameFail && !noNavLogs;

  log('\n判定：');
  log(`  ① 5 次點擊，每次時間有前進：${allAdvanced ? 'PASS ✓' : 'FAIL ✗'}`);
  log(`  ② nextIdx 遞增（無循環）：${idxIncreasing ? 'PASS ✓' : 'FAIL ✗'}`);
  log(`  ③ 無 same=true（未停在同一句）：${!idxSameFail ? 'PASS ✓' : 'FAIL ✗'}`);
  log(`  ④ 收到 NAV console log：${!noNavLogs ? `PASS ✓ (${idxValues.length} 筆)` : 'FAIL ✗ (0 筆)'}`);

  log('\n' + '='.repeat(60));
  log(`整體結果：${overallPass ? 'PASS ✓' : 'FAIL ✗'}`);
  log('='.repeat(60));

  await context.close();
  writeReport(reportLines, REPORT_PATH);
}

main().catch(err => {
  console.error('測試執行錯誤：', err);
  process.exit(1);
});
