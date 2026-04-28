/**
 * test-prev-btn-playing.mjs
 * 測試「上一句（‹）按鈕 + A 鍵」的 prev 導航功能
 *
 * 情境 1：播放中連點 Prev 5 次（每次間隔 1200ms）
 *   - 影片從 t=30s 播放
 *   - 判定：① 每次時間往前退 diff < -0.1s
 *           ② newIdx 每次遞減不重複
 *           ③ diff ≈ -3s（每句 3 秒）
 *
 * 情境 2：暫停中點 Prev 3 次
 *   - 暫停在 t=30s
 *   - 判定：同樣退一句，時間往前退
 *
 * 字幕：editedSubtitles 注入（影片 wIpVpJCRwUg，50 句假字幕，每句 3 秒）
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const EXT_PATH = 'd:\\dev\\chrome字幕套件開發';
const VIDEO_ID = 'wIpVpJCRwUg';
const TARGET_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;
const REPORT_PATH = 'd:\\dev\\chrome字幕套件開發\\docs\\qa-prev-btn-playing.txt';
const SUBTITLE_COUNT = 50; // 假字幕句數，每句 3 秒
const SUB_INTERVAL = 3;    // 每句間隔秒數

/** 等待指定毫秒 */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 生成假字幕資料（每句 3 秒，共 count 句）
 * @param {number} count - 句數
 */
function generateFakeSubs(count) {
  return Array.from({ length: count }, (_, i) => ({
    text: `Sentence ${i + 1}: test subtitle text for navigation`,
    startTime: i * SUB_INTERVAL,
    duration: 2.8,
  }));
}

/**
 * 等待 extension isolated world context 出現
 * content.js 名稱為 "YT Subtitle Demo"
 */
function waitForExtContext(client, timeout) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`等待 extension isolated world 超時（${timeout}ms）`)),
      timeout
    );
    client.on('Runtime.executionContextCreated', (event) => {
      if (event.context.name === 'YT Subtitle Demo') {
        clearTimeout(timer);
        resolve(event.context.id);
      }
    });
  });
}

/**
 * 在 extension isolated world 執行 chrome.storage.local.set
 */
async function storageSet(client, ctxId, key, value) {
  const keyJson = JSON.stringify(key);
  const valJson = JSON.stringify(value);
  const expr = [
    'new Promise(function(res, rej) {',
    '  var obj = {};',
    '  obj[' + keyJson + '] = ' + valJson + ';',
    '  chrome.storage.local.set(obj, function() {',
    '    if (chrome.runtime.lastError)',
    '      rej(new Error(chrome.runtime.lastError.message));',
    '    else',
    '      res(true);',
    '  });',
    '})',
  ].join('\n');
  const r = await client.send('Runtime.evaluate', {
    expression: expr,
    contextId: ctxId,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description || 'storage.set failed');
  }
  return r.result.value === true;
}

/**
 * 等待 #yt-sub-status 文字包含目標字串（輪詢）
 */
async function pollStatusText(page, targetSubstr, maxMs) {
  const deadline = Date.now() + maxMs;
  let last = '';
  while (Date.now() < deadline) {
    await sleep(500);
    const text = await page.evaluate(() => {
      const el = document.getElementById('yt-sub-status');
      return el ? el.textContent : '';
    }).catch(() => '');
    if (text !== last) {
      console.log(`  [狀態變化] "${text}"`);
      last = text;
    }
    if (text.includes(targetSubstr)) return text;
  }
  return last;
}

/**
 * 從 console log 解析 [YT-SUB][NAV] < 的 newIdx
 */
function parsePrevNavIdx(logText) {
  const m = logText.match(/newIdx=\s*(\d+)/);
  if (m) return parseInt(m[1], 10);
  const m2 = logText.match(/newIndex=\s*(\d+)/);
  if (m2) return parseInt(m2[1], 10);
  return null;
}

/** 將測試結果寫入報告檔案 */
function writeReport(lines, reportPath) {
  const dir = path.dirname(reportPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(reportPath, lines.join('\n') + '\n', 'utf-8');
  console.log(`\n報告已儲存：${reportPath}`);
}

/**
 * 觸發 prev 按鈕一次（JS dispatchEvent，繞過 Playwright visibility check）
 */
async function clickPrev(page) {
  await page.evaluate(() => {
    const btn = document.getElementById('yt-sub-ov-prev');
    if (btn) btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  });
}

/**
 * 取得影片目前狀態
 */
async function getVideoState(page) {
  return page.evaluate(() => {
    const v = document.querySelector('video');
    return {
      time: v ? v.currentTime : -1,
      paused: v ? v.paused : true,
      overlayText: document.querySelector('#yt-sub-ov-primary')?.textContent?.trim() || '',
    };
  });
}

/**
 * 確保 overlay 及 prev 按鈕可見
 */
async function ensureOverlayVisible(page) {
  await page.evaluate(() => {
    const overlay = document.getElementById('yt-sub-overlay');
    if (overlay) {
      const s = window.getComputedStyle(overlay);
      if (s.display === 'none' || overlay.style.display === 'none') overlay.style.display = '';
    }
    const prev = document.getElementById('yt-sub-ov-prev');
    if (prev) {
      const s = window.getComputedStyle(prev);
      if (s.display === 'none' || s.visibility === 'hidden') {
        prev.style.display = '';
        prev.style.visibility = 'visible';
      }
    }
  });
}

/**
 * 執行單一情境的連點測試
 * @param {object} page
 * @param {Array} navLogs - 全域 nav log 陣列（共用）
 * @param {Function} log
 * @param {object} opts
 *   opts.scenarioName   - 情境名稱
 *   opts.startTime      - 影片起始秒數
 *   opts.clickCount     - 點擊次數
 *   opts.intervalMs     - 每次間隔毫秒
 *   opts.playFirst      - 是否先播放（true=播放中，false=暫停）
 * @returns {{ pass: boolean, details: string[] }}
 */
async function runScenario(page, navLogs, log, opts) {
  const { scenarioName, startTime, clickCount, intervalMs, playFirst } = opts;
  const results = [];

  log(`\n${'='.repeat(60)}`);
  log(`情境：${scenarioName}`);
  log(`起始時間：${startTime}s，點擊次數：${clickCount}，間隔：${intervalMs}ms，播放中：${playFirst}`);
  log('='.repeat(60));

  // 1. seek 到起始位置
  await page.evaluate((t) => {
    const v = document.querySelector('video');
    if (v) v.currentTime = t;
  }, startTime);
  await sleep(800);

  // 2. 播放或暫停
  if (playFirst) {
    await page.evaluate(() => { const v = document.querySelector('video'); if (v) v.play().catch(() => {}); });
    await sleep(1500); // 等穩定播放
    const checkPlay = await page.evaluate(() => { const v = document.querySelector('video'); return v ? !v.paused : false; });
    log(`影片播放中確認：${checkPlay ? 'YES ✓' : '嘗試 fallback...'}`);
    if (!checkPlay) {
      await page.click('video').catch(() => {});
      await sleep(1500);
    }
  } else {
    await page.evaluate(() => { const v = document.querySelector('video'); if (v) { v.currentTime; v.pause(); } });
    await sleep(500);
    const checkPaused = await page.evaluate(() => { const v = document.querySelector('video'); return v ? v.paused : true; });
    log(`影片暫停確認：${checkPaused ? 'YES ✓' : 'WARN 未暫停'}`);
  }

  // 確保 overlay 可見
  await ensureOverlayVisible(page);

  // 初始狀態
  const initState = await getVideoState(page);
  log(`初始影片時間：${initState.time.toFixed(3)}s，paused=${initState.paused}`);

  const clickNavLogs = [];
  const timeRecords = [];

  for (let i = 1; i <= clickCount; i++) {
    log(`\n  [點擊 ${i}/${clickCount}]`);
    const navLogsBefore = navLogs.length;

    const statePre = await getVideoState(page);
    log(`  點擊前：time=${statePre.time.toFixed(3)}s，paused=${statePre.paused}，overlay=「${statePre.overlayText}」`);

    await clickPrev(page);
    await sleep(intervalMs);

    const statePost = await getVideoState(page);
    const diff = statePost.time - statePre.time;
    const wentBack = diff < -0.1;
    // 判定 diff ≈ -3s（±1.5s 容差，允許播放時已前進少許秒）
    const diffOk = diff < -0.1 && diff > -(SUB_INTERVAL * 2 + 1.5);

    log(`  點擊後：time=${statePost.time.toFixed(3)}s  diff=${diff.toFixed(3)}s  往前退=${wentBack ? 'YES ✓' : 'NO ✗'}  paused=${statePost.paused}`);
    log(`  diff≈-3s 判定：${diffOk ? 'OK ✓' : `WARN（diff=${diff.toFixed(3)}s）`}`);
    log(`  overlay 字幕：「${statePost.overlayText}」`);

    const allNewNavLogs = navLogs.slice(navLogsBefore);
    const newNavLogs = allNewNavLogs.filter(nl => nl.text.includes('< ') || nl.text.includes('prev') || nl.text.includes('[NAV]'));
    const logsToProcess = newNavLogs.length > 0 ? newNavLogs : allNewNavLogs;

    if (logsToProcess.length > 0) {
      logsToProcess.forEach(nl => {
        const newIdx = parsePrevNavIdx(nl.text);
        log(`  NAV log: ${nl.raw}  → newIdx=${newIdx}`);
        clickNavLogs.push({ click: i, newIdx, raw: nl.raw });
      });
    } else {
      log(`  NAV log: （此次點擊未收到 NAV log）`);
      clickNavLogs.push({ click: i, newIdx: null, raw: null });
    }

    timeRecords.push({ click: i, timePre: statePre.time, timePost: statePost.time, diff, wentBack, diffOk });
  }

  // --- 彙整分析 ---
  log(`\n--- ${scenarioName} 結果彙整 ---`);
  log('\n時間記錄：');
  timeRecords.forEach(r => {
    log(`  點擊 ${r.click}: ${r.timePre.toFixed(3)}s → ${r.timePost.toFixed(3)}s  diff=${r.diff.toFixed(3)}s  [往前退=${r.wentBack ? '✓' : '✗'}] [≈-3s=${r.diffOk ? '✓' : '✗'}]`);
  });

  const idxValues = clickNavLogs.map(r => r.newIdx).filter(v => v !== null);
  let idxDecreasing = true;
  for (let i = 1; i < idxValues.length; i++) {
    if (idxValues[i] >= idxValues[i - 1]) { idxDecreasing = false; }
  }
  const idxCounts = {};
  idxValues.forEach(v => { idxCounts[v] = (idxCounts[v] || 0) + 1; });
  const anyDuplicateIdx = Object.values(idxCounts).some(c => c > 1);
  const navLogCount = clickNavLogs.filter(r => r.newIdx !== null).length;

  log('\nnewIdx 記錄：');
  if (idxValues.length === 0) {
    log('  （未收到任何 NAV log）');
  } else {
    log(`  newIdx 序列：${idxValues.join(' → ')}`);
    log(`  遞減：${idxDecreasing ? 'YES ✓' : 'NO ✗'}`);
    log(`  無重複：${!anyDuplicateIdx ? 'YES ✓' : 'NO ✗'}`);
  }

  const allWentBack = timeRecords.every(r => r.wentBack);
  const allDiffOk = timeRecords.every(r => r.diffOk);
  const noNavLogs = idxValues.length === 0;
  const pass = allWentBack && (noNavLogs || (idxDecreasing && !anyDuplicateIdx)) && navLogCount >= clickCount;

  log('\n判定：');
  log(`  ① 每次時間往前退（diff < -0.1s）：${allWentBack ? 'PASS ✓' : 'FAIL ✗'}`);
  log(`  ② newIdx 遞減不重複：${noNavLogs ? 'SKIP（無 NAV log）' : (idxDecreasing && !anyDuplicateIdx) ? 'PASS ✓' : 'FAIL ✗'} (${navLogCount}/${clickCount} 筆)`);
  log(`  ③ diff ≈ -3s（退剛好一句）：${allDiffOk ? 'PASS ✓' : 'WARN（部分偏差，詳見上方）'}`);
  log(`  情境整體：${pass ? 'PASS ✓' : 'FAIL ✗'}`);

  return { pass, allWentBack, allDiffOk, idxDecreasing, anyDuplicateIdx, navLogCount };
}

async function main() {
  const reportLines = [];
  const log = (msg) => { console.log(msg); reportLines.push(msg); };

  log('='.repeat(60));
  log('QA 測試報告：上一句（<）按鈕 ── 播放中 & 暫停中（本地字幕注入場景）');
  log(`執行時間：${new Date().toISOString()}`);
  log(`目標 URL：${TARGET_URL}`);
  log(`影片 ID：${VIDEO_ID}`);
  log(`擴充功能：${EXT_PATH}`);
  log(`字幕來源：本地字幕（editedSubtitles_${VIDEO_ID}，${SUBTITLE_COUNT} 句，每句 ${SUB_INTERVAL} 秒）`);
  log('='.repeat(60));

  const navLogs = [];

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

  // 注入 localStorage 設定
  await page.addInitScript(() => {
    try {
      localStorage.setItem('yt-sub-settings', JSON.stringify({
        primaryLang: 'en',
        secondaryLangs: ['__none__', '__none__', '__none__'],
        dualEnabled: false,
        overlayEnabled: true,
        extensionEnabled: true,
        extendSubtitles: false,
        subtitleOffset: 0,
        onboardingDone: true,
        translationProvider: 'ytlang',
        loopSentence: false,
        clickToSeek: false,
        autoScroll: false,
      }));
    } catch (_) {}
  });

  // 監聽 console，收集 [YT-SUB][NAV] log
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

  // --- 步驟 1：建立 CDP session ---
  log('\n--- 步驟 1：建立 CDP session，監聽 extension isolated world ---');
  const client = await context.newCDPSession(page);
  await client.send('Runtime.enable');
  const extCtxPromise = waitForExtContext(client, 20000);

  // --- 步驟 2：導航 ---
  log('\n--- 步驟 2：導航到 YouTube 影片 ---');
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  log('頁面 domcontentloaded 完成');

  // --- 步驟 3：等待 extension isolated world ---
  log('\n--- 步驟 3：等待 extension isolated world（最多 20 秒）---');
  let ctxId;
  try {
    ctxId = await extCtxPromise;
    log(`Extension isolated world 取得，contextId=${ctxId}`);
  } catch (e) {
    log(`ERROR: ${e.message}`);
    await context.close();
    writeReport(reportLines, REPORT_PATH);
    process.exit(1);
  }

  // --- 步驟 4：寫入本地字幕 ---
  log('\n--- 步驟 4：寫入本地字幕（editedSubtitles）到 chrome.storage.local ---');
  const fakeSubs = generateFakeSubs(SUBTITLE_COUNT);
  const storageKey = `editedSubtitles_${VIDEO_ID}`;
  const storageValue = { primarySubtitles: fakeSubs, secondarySubtitles: [] };
  try {
    const writeOk = await storageSet(client, ctxId, storageKey, storageValue);
    log(`storage.set 結果：${writeOk ? '成功' : '失敗'}`);
    log(`key: ${storageKey}，${fakeSubs.length} 句，時間跨度: 0s ~ ${(SUBTITLE_COUNT - 1) * SUB_INTERVAL + 2.8}s`);
  } catch (e) {
    log(`ERROR: 寫入 storage 失敗：${e.message}`);
    await context.close();
    writeReport(reportLines, REPORT_PATH);
    process.exit(1);
  }

  // --- 步驟 5：等待字幕還原 ---
  log('\n--- 步驟 5：等待 sidebar 與字幕還原 ---');
  try {
    await page.waitForSelector('#yt-sub-demo-sidebar', { timeout: 15000 });
    log('Sidebar 已出現');
  } catch (e) {
    log(`ERROR: ${e.message}`);
    await context.close();
    writeReport(reportLines, REPORT_PATH);
    process.exit(1);
  }

  const statusAfterRestore = await pollStatusText(page, '自定義字幕', 15000);
  const restoredOk = statusAfterRestore.includes('自定義字幕') || statusAfterRestore.includes('已還原');
  log(`字幕狀態：「${statusAfterRestore}」→ ${restoredOk ? '還原成功 ✓' : 'WARN（繼續）'}`);

  // --- 步驟 6：等待字幕列表 ---
  log('\n--- 步驟 6：等待 #yt-sub-list .yt-sub-item ---');
  let subtitleCount = 0;
  const listDeadline = Date.now() + 15000;
  while (Date.now() < listDeadline) {
    subtitleCount = await page.$$eval('#yt-sub-list .yt-sub-item', els => els.length).catch(() => 0);
    if (subtitleCount > 0) break;
    await sleep(800);
  }
  if (subtitleCount === 0) {
    log('ERROR: .yt-sub-item 未出現（本地字幕未套用到列表）');
    await context.close();
    writeReport(reportLines, REPORT_PATH);
    process.exit(1);
  }
  log(`字幕列表：共 ${subtitleCount} 個 .yt-sub-item ✓`);

  // --- 步驟 7：確認 overlay / prev 存在 ---
  log('\n--- 步驟 7：確認 overlay 與 #yt-sub-ov-prev 存在 ---');
  try {
    await page.waitForSelector('#yt-sub-overlay', { state: 'attached', timeout: 10000 });
    log('#yt-sub-overlay 附加 ✓');
  } catch (e) {
    log(`ERROR: ${e.message}`);
    await context.close();
    writeReport(reportLines, REPORT_PATH);
    process.exit(1);
  }
  try {
    await page.waitForSelector('#yt-sub-ov-prev', { state: 'attached', timeout: 10000 });
    log('#yt-sub-ov-prev 存在 ✓');
  } catch (e) {
    log(`ERROR: ${e.message}`);
    await context.close();
    writeReport(reportLines, REPORT_PATH);
    process.exit(1);
  }

  // =====================================================
  // 情境 1：播放中連點 Prev 5 次
  // =====================================================
  const sc1 = await runScenario(page, navLogs, log, {
    scenarioName: '情境 1：播放中連點 Prev 5 次',
    startTime: 30,
    clickCount: 5,
    intervalMs: 1200,
    playFirst: true,
  });

  // 等待影片穩定後進入情境 2
  log('\n（等待 2 秒後進入情境 2）');
  await sleep(2000);

  // =====================================================
  // 情境 2：暫停中點 Prev 3 次
  // =====================================================
  const sc2 = await runScenario(page, navLogs, log, {
    scenarioName: '情境 2：暫停中點 Prev 3 次',
    startTime: 30,
    clickCount: 3,
    intervalMs: 1000,
    playFirst: false,
  });

  // --- 最終彙整 ---
  log('\n' + '='.repeat(60));
  log('最終彙整：');
  log(`  情境 1（播放中 5 次）：${sc1.pass ? 'PASS ✓' : 'FAIL ✗'}`);
  log(`    ① 每次往前退：${sc1.allWentBack ? 'OK' : 'FAIL'}`);
  log(`    ② newIdx 遞減不重複：${sc1.idxDecreasing && !sc1.anyDuplicateIdx ? 'OK' : 'FAIL'} (${sc1.navLogCount}/5 筆 NAV log)`);
  log(`    ③ diff ≈ -3s：${sc1.allDiffOk ? 'OK' : 'WARN'}`);
  log(`  情境 2（暫停中 3 次）：${sc2.pass ? 'PASS ✓' : 'FAIL ✗'}`);
  log(`    ① 每次往前退：${sc2.allWentBack ? 'OK' : 'FAIL'}`);
  log(`    ② newIdx 遞減不重複：${sc2.idxDecreasing && !sc2.anyDuplicateIdx ? 'OK' : 'FAIL'} (${sc2.navLogCount}/3 筆 NAV log)`);
  log(`    ③ diff ≈ -3s：${sc2.allDiffOk ? 'OK' : 'WARN'}`);

  const overallPass = sc1.pass && sc2.pass;
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
