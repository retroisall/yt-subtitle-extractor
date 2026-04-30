/**
 * qa_wordbook_learned_nohighlight.mjs
 * Regression: 已學習單字在字幕中不應高亮
 *
 * Regression: ISSUE-001 — 已學習的生字本單字仍被 yt-sub-word--saved 高亮
 * Found by /qa on 2026-04-30
 * Report: .gstack/qa-reports/qa-report-chrome字幕套件-2026-04-30.md
 *
 * 策略：用 editedSubtitles 寫入本地字幕，繞過 YouTube pot token 限制
 *
 * 測試流程：
 * 1. 寫入本地測試字幕（含已知單字 "give"）+ 無 status 的生字本
 *    → 驗證字幕有高亮
 * 2. 更新生字本單字 status='learned'
 *    → 驗證高亮消失
 * 3. 移除 status（還原為普通生字）
 *    → 驗證高亮恢復
 */

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..');
const PROFILE_PATH = path.resolve(__dirname, '..', '.playwright-profile');

const VIDEO_ID = 'dQw4w9WgXcQ';        // Rickroll：使用本地字幕，不需 pot token
const SAVED_WORDS_KEY = 'yt_sub_saved_words';
const EDITED_KEY = 'editedSubtitles_' + VIDEO_ID;

// 測試用本地字幕（句子含目標單字 "give"）
const TEST_SUBTITLES = {
  primarySubtitles: [
    { text: 'Never gonna give you up',             startTime: 0,  duration: 3 },
    { text: 'Never gonna let you down',             startTime: 3,  duration: 3 },
    { text: 'Never gonna run around and desert you', startTime: 6, duration: 4 },
  ],
  secondarySubtitles: [],
};

const TARGET_WORD    = 'give';   // 字幕中出現的英文單字（小寫，直接匹配）
const TARGET_WORD_LC = 'give';

function log(msg) {
  console.log('[' + new Date().toLocaleTimeString() + '] ' + msg);
}

function report(label, passed, detail) {
  const icon = passed ? '✅' : '❌';
  console.log(icon + ' ' + label + (detail ? ' — ' + detail : ''));
  return passed;
}

function waitForExtContext(client, timeout) {
  return new Promise(function (resolve) {
    const timer = setTimeout(function () { resolve(null); }, timeout);
    client.on('Runtime.executionContextCreated', function (event) {
      if (event.context.name === 'YouTube Learning Bar (DEV)') {
        clearTimeout(timer);
        resolve(event.context.id);
      }
    });
  });
}

async function storageSet(client, ctxId, key, value) {
  const expr = [
    'new Promise(function(res, rej) {',
    '  var obj = {};',
    '  obj[' + JSON.stringify(key) + '] = ' + JSON.stringify(value) + ';',
    '  chrome.storage.local.set(obj, function() {',
    '    if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));',
    '    else res(true);',
    '  });',
    '})',
  ].join('\n');
  const r = await client.send('Runtime.evaluate', {
    expression: expr, contextId: ctxId, awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception.description || 'storage.set failed');
  return r.result.value === true;
}

async function storageRemove(client, ctxId, keys) {
  const keysJson = JSON.stringify(Array.isArray(keys) ? keys : [keys]);
  const expr = 'new Promise(function(res) { chrome.storage.local.remove(' + keysJson + ', res); })';
  await client.send('Runtime.evaluate', { expression: expr, contextId: ctxId, awaitPromise: true });
}

async function pollForSidebar(page, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise(function (r) { setTimeout(r, 500); });
    const found = await page.evaluate(function () {
      return !!document.getElementById('yt-sub-demo-sidebar');
    }).catch(function () { return false; });
    if (found) return true;
  }
  return false;
}

/** 輪詢等待 .yt-sub-word span 出現 */
async function pollForWordSpans(page, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise(function (r) { setTimeout(r, 500); });
    const count = await page.evaluate(function () {
      return document.querySelectorAll('#yt-sub-list .yt-sub-word').length;
    }).catch(function () { return 0; });
    if (count > 0) {
      log('#yt-sub-list .yt-sub-word 已出現 ' + count + ' 個 span');
      return count;
    }
  }
  return 0;
}

/** 輪詢等待 .yt-sub-word--saved 出現或消失
 * @param {boolean} expectPresent - true: 等高亮出現; false: 等高亮消失
 */
async function pollForSavedClass(page, expectPresent, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise(function (r) { setTimeout(r, 300); });
    const count = await page.evaluate(function () {
      return document.querySelectorAll('#yt-sub-list .yt-sub-word--saved').length;
    }).catch(function () { return -1; });
    if (expectPresent && count > 0) return count;
    if (!expectPresent && count === 0) return 0;
  }
  return expectPresent ? 0 : -1;
}

// ===== 共用：導航 + 等待 extension context =====
async function navigateAndGetCtx(page, client, ctxId0) {
  log('導航到 https://www.youtube.com/watch?v=' + VIDEO_ID);
  const ctxPromise = waitForExtContext(client, 25000);
  await page.goto('https://www.youtube.com/watch?v=' + VIDEO_ID, {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  return await ctxPromise;
}

// ===== 主測試流程 =====
async function runTest() {
  log('啟動 Playwright + Chrome 擴充套件...');
  const context = await chromium.launchPersistentContext(PROFILE_PATH, {
    headless: false,
    args: [
      '--disable-extensions-except=' + EXT_PATH,
      '--load-extension=' + EXT_PATH,
      '--no-sandbox',
    ],
  });

  const results = [];

  try {
    const page = await context.newPage();
    const client = await context.newCDPSession(page);
    await client.send('Runtime.enable');

    // ===== 初次導航，取得 extension context =====
    let ctxId = await navigateAndGetCtx(page, client, null);
    results.push(report('Extension isolated world 取得', !!ctxId, ctxId ? 'contextId=' + ctxId : '未找到'));
    if (!ctxId) { printSummary(results); await context.close(); return; }

    const sidebarFound = await pollForSidebar(page, 15000);
    results.push(report('#yt-sub-demo-sidebar 載入', sidebarFound, sidebarFound ? 'sidebar 已出現' : '15 秒內未出現'));
    if (!sidebarFound) { printSummary(results); await context.close(); return; }

    // ===== 場景 A：單字無 status → 應高亮 =====
    log('--- 場景 A：寫入無 status 單字 + 本地字幕，驗證高亮出現 ---');

    const savedWordsNoStatus = {
      [TARGET_WORD_LC]: {
        word: TARGET_WORD_LC, addedAt: Date.now(), count: 1,
        tier: null, tierFetched: false, noDefinition: false,
        wordZh: '', definitionZh: '', context: '', contextZh: '',
        videoId: VIDEO_ID, startTime: 0,
        // status 未設定 → 不在 _learnedWordSet → 應高亮
      },
    };

    await storageSet(client, ctxId, EDITED_KEY, TEST_SUBTITLES);
    await storageSet(client, ctxId, SAVED_WORDS_KEY, savedWordsNoStatus);
    log('已寫入本地字幕 + 無 status 生字本（單字: "' + TARGET_WORD_LC + '"）');

    // Reload 讓 extension 從 storage 初始化
    const ctxPromiseA = waitForExtContext(client, 25000);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    ctxId = await ctxPromiseA;
    results.push(report('場景 A — Reload 後 extension context 重建', !!ctxId));
    if (!ctxId) { printSummary(results); await context.close(); return; }

    const spanCountA = await pollForWordSpans(page, 20000);
    results.push(report('場景 A — 本地字幕 word span 渲染', spanCountA > 0,
      spanCountA > 0 ? spanCountA + ' 個 span' : '20 秒內未找到 word span（本地字幕未套用）'));

    if (spanCountA > 0) {
      const highlightCountA = await pollForSavedClass(page, true, 5000);
      results.push(report('場景 A — 無 status 的單字應有高亮', highlightCountA > 0,
        highlightCountA > 0
          ? '"' + TARGET_WORD_LC + '" 正確顯示 .yt-sub-word--saved（' + highlightCountA + ' 個 span）'
          : '未找到 .yt-sub-word--saved（高亮功能異常）'));
    } else {
      results.push(report('場景 A — 無 status 的單字應有高亮', false, 'word span 未渲染，跳過'));
    }

    // ===== 場景 B：status='learned' → 不應高亮 =====
    log('--- 場景 B：更新 status="learned"，驗證高亮消失 ---');

    const savedWordsLearned = {
      [TARGET_WORD_LC]: {
        word: TARGET_WORD_LC, addedAt: Date.now(), count: 1,
        tier: null, tierFetched: false, noDefinition: false,
        wordZh: '', definitionZh: '', context: '', contextZh: '',
        videoId: VIDEO_ID, startTime: 0,
        status: 'learned',   // 已學習 → 進入 _learnedWordSet → 不應高亮
        learnedAt: Date.now(),
      },
    };

    await storageSet(client, ctxId, EDITED_KEY, TEST_SUBTITLES);
    await storageSet(client, ctxId, SAVED_WORDS_KEY, savedWordsLearned);
    log('已更新生字本 status="learned"');

    const ctxPromiseB = waitForExtContext(client, 25000);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    ctxId = await ctxPromiseB;
    results.push(report('場景 B — Reload 後 extension context 重建', !!ctxId));
    if (!ctxId) { printSummary(results); await context.close(); return; }

    const spanCountB = await pollForWordSpans(page, 20000);
    results.push(report('場景 B — 本地字幕 word span 渲染', spanCountB > 0,
      spanCountB > 0 ? spanCountB + ' 個 span' : '20 秒內未找到 word span'));

    if (spanCountB > 0) {
      const noHighlightB = await pollForSavedClass(page, false, 5000);
      results.push(report('場景 B — status="learned" 的單字不應高亮', noHighlightB === 0,
        noHighlightB === 0
          ? '確認無 .yt-sub-word--saved（已學習單字正確排除高亮）'
          : '仍有 .yt-sub-word--saved (' + (-noHighlightB) + ' 個)，高亮未正確排除'));
    } else {
      results.push(report('場景 B — status="learned" 的單字不應高亮', false, 'word span 未渲染，跳過'));
    }

    // ===== 場景 C：移除 status → 高亮應恢復 =====
    log('--- 場景 C：移除 status，驗證高亮恢復 ---');

    await storageSet(client, ctxId, EDITED_KEY, TEST_SUBTITLES);
    await storageSet(client, ctxId, SAVED_WORDS_KEY, savedWordsNoStatus);
    log('已還原生字本（移除 status）');

    const ctxPromiseC = waitForExtContext(client, 25000);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    ctxId = await ctxPromiseC;
    results.push(report('場景 C — Reload 後 extension context 重建', !!ctxId));
    if (!ctxId) { printSummary(results); await context.close(); return; }

    const spanCountC = await pollForWordSpans(page, 20000);
    results.push(report('場景 C — 本地字幕 word span 渲染', spanCountC > 0,
      spanCountC > 0 ? spanCountC + ' 個 span' : '20 秒內未找到 word span'));

    if (spanCountC > 0) {
      const restoredC = await pollForSavedClass(page, true, 5000);
      results.push(report('場景 C — 移除 status 後高亮應恢復', restoredC > 0,
        restoredC > 0 ? '"' + TARGET_WORD_LC + '" 高亮正確恢復' : '高亮未恢復（異常）'));
    } else {
      results.push(report('場景 C — 移除 status 後高亮應恢復', false, 'word span 未渲染，跳過'));
    }

    // ===== 清理 =====
    try {
      await storageRemove(client, ctxId, [SAVED_WORDS_KEY, EDITED_KEY]);
      log('Storage 已清理');
    } catch (e) {
      log('清理失敗（非致命）: ' + e.message);
    }

  } finally {
    await context.close();
  }

  printSummary(results);
}

function printSummary(results) {
  console.log('\n========== QA 已學習單字不高亮回歸測試總結 ==========');
  const passed = results.filter(Boolean).length;
  const total = results.length;
  console.log('通過 ' + passed + ' / ' + total + ' 項測試');
  if (passed === total) {
    console.log('✅ 全部通過');
    process.exitCode = 0;
  } else {
    console.log('❌ ' + (total - passed) + ' 項失敗，請見上方詳細輸出');
    process.exitCode = 1;
  }
}

runTest().catch(function (err) {
  console.error('測試執行期間發生未預期錯誤:', err);
  process.exit(1);
});
