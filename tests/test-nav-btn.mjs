/**
 * test-nav-btn.mjs
 * 測試「下一句」(>) 按鈕功能
 * - 連續點擊 #yt-sub-ov-next 至少 5 次
 * - 確認每次點擊後影片時間點有前進
 * - 確認不會同一句循環
 * - 記錄所有 [YT-SUB][NAV] console log
 *
 * 策略：若字幕載入失敗（overlay 無法顯示），改用 window.postMessage
 * 注入假字幕資料（YT_SUBTITLE_DEMO_SUBTITLE_DATA），繞過網路問題直接測試按鈕邏輯。
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

// 擴充功能路徑（絕對路徑）
const EXT_PATH = 'd:\\dev\\chrome字幕套件開發';
const TARGET_URL = 'https://www.youtube.com/watch?v=3Io-WIiMKpA&t=22s';
const REPORT_PATH = 'd:\\dev\\chrome字幕套件開發\\docs\\qa-nav-btn.txt';
const CLICK_COUNT = 5;

// 等待指定毫秒
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 預設 localStorage 設定，確保 overlay 啟用、onboarding 完成
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
 * 產生假字幕資料（每句 3 秒，從 t=20s 開始共 20 句）
 * 格式：{ s: startTime, d: duration, t: text }
 */
function buildFakeSubtitles() {
  const subs = [];
  const texts = [
    'Hello and welcome to this video',
    'Today we will learn about testing',
    'The next button should advance forward',
    'Each click moves to the next sentence',
    'This is sentence number five',
    'Six keeps going further ahead',
    'Seven is the lucky number here',
    'Eight should still be advancing',
    'Nine is almost at the end',
    'Ten sentences have been tested now',
    'Eleven is the continuation',
    'Twelve brings us further along',
    'Thirteen is past halfway done',
    'Fourteen almost at the finish line',
    'Fifteen and we keep on going',
    'Sixteen moving forward steadily',
    'Seventeen just a few more left',
    'Eighteen getting close to the end',
    'Nineteen one more after this',
    'Twenty final sentence in our test',
  ];
  for (let i = 0; i < texts.length; i++) {
    subs.push({ s: 20 + i * 3, d: 2.8, t: texts[i] });
  }
  return subs;
}

/**
 * 等待字幕狀態列文字穩定（停止變化），連續 2 次相同才回傳
 */
async function waitStatusStable(page, timeout = 30000) {
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
    await page.waitForTimeout(600);
  }
  return prev;
}

async function main() {
  const reportLines = [];
  const log = (msg) => {
    console.log(msg);
    reportLines.push(msg);
  };

  log('='.repeat(60));
  log('QA 測試報告：下一句 (>) 按鈕');
  log(`執行時間：${new Date().toISOString()}`);
  log(`目標 URL：${TARGET_URL}`);
  log(`擴充功能：${EXT_PATH}`);
  log('='.repeat(60));

  // 收集所有 [YT-SUB][NAV] console log
  const navLogs = [];

  // 啟動帶有擴充功能的 Chrome
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

  // 預設 localStorage（在頁面載入前注入）
  await page.addInitScript(buildInitScript());

  // 監聽 console 訊息，收集 [YT-SUB][NAV] log
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('[YT-SUB][NAV]')) {
      const entry = `[CONSOLE] ${text}`;
      navLogs.push(entry);
      console.log(entry);
    } else if (text.includes('[YT-SUB]')) {
      console.log(`[CONSOLE] ${text}`);
    }
  });

  log('\n--- 步驟 1：導航到 YouTube 影片 ---');
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  log('頁面載入完成');

  // 等待影片播放器
  log('\n--- 步驟 2：等待影片播放器 ---');
  try {
    await page.waitForSelector('video', { timeout: 15000 });
    log('影片元素已找到');
  } catch (e) {
    log('WARNING: 無法找到影片元素');
  }

  // 等待 sidebar
  log('\n--- 步驟 3：等待擴充功能 sidebar (#yt-sub-demo-sidebar) ---');
  try {
    await page.waitForSelector('#yt-sub-demo-sidebar', { timeout: 20000 });
    log('Sidebar 已出現');
  } catch (e) {
    log('ERROR: 找不到 #yt-sub-demo-sidebar，擴充功能可能未載入');
    await context.close();
    writeReport(reportLines, navLogs, REPORT_PATH);
    process.exit(1);
  }

  // 等待字幕狀態，最多 20 秒
  log('\n--- 步驟 4：等待字幕載入（最多 20 秒）---');
  const statusText = await waitStatusStable(page, 20000);
  log(`字幕狀態：${statusText || '（未取得）'}`);

  // 檢查 overlay 是否已出現
  let overlayFound = await page.$('#yt-sub-overlay') !== null;
  log(`\n--- 步驟 5：檢查 #yt-sub-overlay ---`);
  log(`Overlay 狀態：${overlayFound ? '已出現 ✓' : '未出現，改用注入假字幕'}`);

  if (!overlayFound) {
    // 字幕載入失敗（通常是 pot token 問題），注入假字幕繞過網路
    log('\n--- 步驟 5b：注入假字幕資料 (YT_SUBTITLE_DEMO_SUBTITLE_DATA) ---');
    const fakeSubs = buildFakeSubtitles();
    log(`注入 ${fakeSubs.length} 句假字幕（t=20s ~ t=${20 + fakeSubs.length * 3}s）`);

    await page.evaluate((subs) => {
      window.postMessage({
        type: 'YT_SUBTITLE_DEMO_SUBTITLE_DATA',
        tag: 'primary',
        parsed: subs,
        error: null,
      }, '*');
    }, fakeSubs);

    // 等待 overlay 出現
    await sleep(1500);
    overlayFound = await page.$('#yt-sub-overlay') !== null;
    log(`注入後 overlay 狀態：${overlayFound ? '已出現 ✓' : '仍未出現 ✗'}`);

    if (!overlayFound) {
      // 再等久一點
      await page.waitForSelector('#yt-sub-overlay', { timeout: 10000 }).catch(() => {});
      overlayFound = await page.$('#yt-sub-overlay') !== null;
      log(`再等待後 overlay 狀態：${overlayFound ? '已出現 ✓' : '仍未出現 ✗'}`);
    }
  }

  // 等待 > 按鈕
  log('\n--- 步驟 6：等待 #yt-sub-ov-next 按鈕 ---');
  try {
    await page.waitForSelector('#yt-sub-ov-next', { timeout: 15000 });
    log('#yt-sub-ov-next 按鈕已出現 ✓');
  } catch (e) {
    log('ERROR: 找不到 #yt-sub-ov-next 按鈕');
    const domInfo = await page.evaluate(() => ({
      hasSidebar: !!document.getElementById('yt-sub-demo-sidebar'),
      hasOverlay: !!document.getElementById('yt-sub-overlay'),
      hasNext: !!document.getElementById('yt-sub-ov-next'),
      statusText: document.getElementById('yt-sub-status')?.textContent || '',
      overlayToggle: document.getElementById('yt-sub-overlay-toggle')?.checked,
    }));
    log(`DOM 診斷：${JSON.stringify(domInfo)}`);
    log('測試終止');
    await context.close();
    writeReport(reportLines, navLogs, REPORT_PATH);
    process.exit(1);
  }

  // 若使用假字幕，先 seek 到 t=20s（第一句字幕起始時間）
  if (!overlayFound) {
    log('\n調整影片時間至 t=22s（假字幕覆蓋範圍）');
  }
  await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v) { v.currentTime = 22; }
  });
  await sleep(1000);

  // 連續點擊 5 次
  log(`\n--- 步驟 7：連續點擊 > 按鈕 ${CLICK_COUNT} 次 ---`);
  const timeRecords = [];

  const timeInit = await page.evaluate(() => {
    const v = document.querySelector('video');
    return v ? v.currentTime : -1;
  });
  log(`初始影片時間：${timeInit.toFixed(3)}s`);
  timeRecords.push({ click: 0, time: timeInit });

  for (let i = 1; i <= CLICK_COUNT; i++) {
    log(`\n  [點擊 ${i}/${CLICK_COUNT}]`);

    const statePre = await page.evaluate(() => {
      const v = document.querySelector('video');
      return { time: v ? v.currentTime : -1 };
    });
    log(`  點擊前影片時間：${statePre.time.toFixed(3)}s`);

    // 點擊 > 按鈕
    await page.click('#yt-sub-ov-next');

    // 等待 seek 完成
    await sleep(1500);

    const statePost = await page.evaluate(() => {
      const v = document.querySelector('video');
      return {
        time: v ? v.currentTime : -1,
        overlayText: document.querySelector('#yt-sub-ov-primary')?.textContent?.trim() || '',
      };
    });

    const diff = statePost.time - statePre.time;
    const advanced = diff > 0.1;
    log(`  點擊後影片時間：${statePost.time.toFixed(3)}s  (差距: ${diff.toFixed(3)}s)  前進: ${advanced ? 'YES ✓' : 'NO ✗'}`);
    log(`  overlay 字幕文字：「${statePost.overlayText}」`);
    timeRecords.push({
      click: i,
      timePre: statePre.time,
      timePost: statePost.time,
      diff,
      advanced,
      text: statePost.overlayText,
    });

    await sleep(300);
  }

  // 分析結果
  log('\n--- 步驟 8：分析結果 ---');
  const clickResults = timeRecords.filter(r => r.click > 0);
  const allAdvanced = clickResults.every(r => r.advanced);
  let anyLooped = false;
  for (let i = 1; i < clickResults.length; i++) {
    if (Math.abs(clickResults[i].timePost - clickResults[i - 1].timePost) < 0.1) {
      anyLooped = true;
      log(`  WARNING: 點擊 ${clickResults[i].click} 與 ${clickResults[i-1].click} 時間幾乎相同 → 可能循環`);
    }
  }

  log('\n時間記錄彙整：');
  timeRecords.forEach(r => {
    if (r.click === 0) {
      log(`  初始: ${r.time.toFixed(3)}s`);
    } else {
      log(`  點擊 ${r.click}: ${r.timePre.toFixed(3)}s → ${r.timePost.toFixed(3)}s  diff=${r.diff.toFixed(3)}s  [${r.advanced ? '前進 ✓' : '未前進 ✗'}]  text=「${r.text}」`);
    }
  });

  log('\n判定：');
  log(`  每次點擊後時間有前進：${allAdvanced ? 'PASS ✓' : 'FAIL ✗'}`);
  log(`  未發現同一句循環：${anyLooped ? 'FAIL ✗ (偵測到循環)' : 'PASS ✓'}`);

  log('\n--- [YT-SUB][NAV] Console Logs（完整記錄）---');
  if (navLogs.length === 0) {
    log('（未收到任何 [YT-SUB][NAV] log）');
  } else {
    navLogs.forEach(l => log(l));
  }

  const overallPass = allAdvanced && !anyLooped;
  log('\n' + '='.repeat(60));
  log(`整體結果：${overallPass ? 'PASS ✓' : 'FAIL ✗'}`);
  log('='.repeat(60));

  await context.close();
  writeReport(reportLines, navLogs, REPORT_PATH);
}

/**
 * 將測試結果寫入報告檔案
 */
function writeReport(lines, navLogs, reportPath) {
  const dir = path.dirname(reportPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(reportPath, lines.join('\n') + '\n', 'utf-8');
  console.log(`\n報告已儲存：${reportPath}`);
}

main().catch(err => {
  console.error('測試執行錯誤：', err);
  process.exit(1);
});
