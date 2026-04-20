/**
 * test-storage-persist-v2.mjs
 * QA 測試：SRT 字幕匯入後 chrome.storage.local 持久化驗證
 *
 * 使用 CDP Runtime.evaluate + extension isolated world contextId
 * 繞過 Playwright page.evaluate 無法存取 chrome.storage 的限制。
 *
 * 測試流程：
 * 1. 導航到 YouTube 影片頁
 * 2. 取得 extension isolated world（name="YT Subtitle Demo"）context ID
 * 3. 寫入 editedSubtitles_<videoId> 到 chrome.storage.local
 * 4. 立即讀回驗證
 * 5. 重新整理頁面
 * 6. 確認 storage 資料仍在（持久化）
 * 7. 輪詢等待 _restoreSavedSubtitle 完成 → 確認 Sidebar 顯示「已還原」
 */

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..');

const VIDEO_ID = 'dQw4w9WgXcQ';
const STORAGE_KEY = 'editedSubtitles_' + VIDEO_ID;
const TEST_SUBTITLES = [
  { text: 'Hello QA test', startTime: 0, endTime: 2 },
  { text: 'Persistence check', startTime: 2, endTime: 4 },
  { text: '字幕還原測試', startTime: 4, endTime: 6 },
];

/** 印出帶時間戳的日誌 */
function log(msg) {
  console.log('[' + new Date().toLocaleTimeString() + '] ' + msg);
}

/** 印出 pass/fail 結果 */
function report(label, passed, detail) {
  var icon = passed ? '✅' : '❌';
  console.log(icon + ' ' + label + (detail ? ' — ' + detail : ''));
  return passed;
}

/**
 * 等待 extension isolated world context 出現（content.js 名稱為 "YT Subtitle Demo"）
 */
function waitForExtContext(client, timeout) {
  return new Promise(function(resolve) {
    var timer = setTimeout(function() { resolve(null); }, timeout);
    client.on('Runtime.executionContextCreated', function(event) {
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
  var keyJson = JSON.stringify(key);
  var valJson = JSON.stringify(value);
  var expr = [
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
  var r = await client.send('Runtime.evaluate', {
    expression: expr,
    contextId: ctxId,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception.description || 'storage.set failed');
  }
  return r.result.value === true;
}

/**
 * 在 extension isolated world 執行 chrome.storage.local.get
 */
async function storageGet(client, ctxId, key) {
  var keyJson = JSON.stringify(key);
  var expr = [
    'new Promise(function(res) {',
    '  chrome.storage.local.get(' + keyJson + ', function(data) {',
    '    res(JSON.stringify(data[' + keyJson + '] || null));',
    '  });',
    '})',
  ].join('\n');
  var r = await client.send('Runtime.evaluate', {
    expression: expr,
    contextId: ctxId,
    awaitPromise: true,
    returnByValue: true,
  });
  return JSON.parse(r.result.value || 'null');
}

/**
 * 在 extension isolated world 執行 chrome.storage.local.remove
 */
async function storageRemove(client, ctxId, key) {
  var keyJson = JSON.stringify(key);
  var expr = 'new Promise(function(res) { chrome.storage.local.remove(' + keyJson + ', res); })';
  await client.send('Runtime.evaluate', {
    expression: expr,
    contextId: ctxId,
    awaitPromise: true,
  });
}

/**
 * 輪詢等待 sidebar 狀態文字包含目標字串（最多 maxMs 毫秒）
 */
async function pollStatusText(page, targetSubstr, maxMs) {
  var deadline = Date.now() + maxMs;
  var last = '';
  while (Date.now() < deadline) {
    await new Promise(function(r) { setTimeout(r, 500); });
    var text = await page.evaluate(function() {
      var el = document.getElementById('yt-sub-status');
      return el ? el.textContent : '';
    }).catch(function() { return ''; });
    if (text !== last) {
      log('狀態變化: "' + text + '"');
      last = text;
    }
    if (text.includes(targetSubstr)) return text;
  }
  return last;
}

// ===== 主流程 =====
async function runTest() {
  log('啟動 Playwright + Chrome 擴充套件...');
  log('擴充套件路徑: ' + EXT_PATH);

  var context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      '--disable-extensions-except=' + EXT_PATH,
      '--load-extension=' + EXT_PATH,
      '--no-sandbox',
    ],
  });

  var results = [];

  try {
    var page = await context.newPage();
    var client = await context.newCDPSession(page);
    await client.send('Runtime.enable');

    // ========== 測試 1：導航到 YouTube ==========
    log('導航到 https://www.youtube.com/watch?v=' + VIDEO_ID);
    var extCtxOnLoad = waitForExtContext(client, 15000);
    try {
      await page.goto('https://www.youtube.com/watch?v=' + VIDEO_ID, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      results.push(report('導航到 YouTube 影片頁', true));
    } catch (err) {
      results.push(report('導航到 YouTube 影片頁', false, err.message));
      await context.close();
      process.exit(1);
    }

    // ========== 測試 2：Sidebar 出現 ==========
    log('等待 Sidebar...');
    var sidebarFound = false;
    try {
      await page.waitForSelector('#yt-sub-demo-sidebar', { timeout: 10000 });
      sidebarFound = true;
    } catch (_) {
      log('Sidebar 未在 10 秒內出現');
    }
    results.push(report('擴充套件 Sidebar 出現', sidebarFound));

    // ========== 取得 extension context ==========
    log('等待 extension isolated world (最多 15 秒)...');
    var ctxId = await extCtxOnLoad;
    log('Extension context ID: ' + ctxId);
    results.push(report('Extension isolated world 取得', !!ctxId,
      ctxId ? 'contextId=' + ctxId : '未找到 — 擴充套件可能未正確載入'));

    if (!ctxId) {
      log('無法取得 extension context，跳過 storage 測試');
      console.log('\n========== QA 測試總結 ==========');
      var p = results.filter(Boolean).length;
      console.log('通過 ' + p + ' / ' + results.length + ' 項測試');
      await context.close();
      return;
    }

    // ========== 測試 3：chrome.storage.local.set ==========
    log('寫入 storage key: ' + STORAGE_KEY);
    var writeOk = false;
    try {
      writeOk = await storageSet(client, ctxId, STORAGE_KEY, TEST_SUBTITLES);
      results.push(report('chrome.storage.local.set 寫入', writeOk,
        writeOk ? TEST_SUBTITLES.length + ' 筆' : '回傳 false'));
    } catch (err) {
      results.push(report('chrome.storage.local.set 寫入', false, err.message));
    }

    // ========== 測試 4：立即讀回驗證 ==========
    log('讀回 storage 資料...');
    try {
      var readData = await storageGet(client, ctxId, STORAGE_KEY);
      var readOk = readData && Array.isArray(readData) && readData.length === TEST_SUBTITLES.length;
      results.push(report('chrome.storage.local.get 讀回', readOk,
        readOk ? readData.length + ' 筆正確' : '得到: ' + JSON.stringify(readData)));
    } catch (err) {
      results.push(report('chrome.storage.local.get 讀回', false, err.message));
    }

    // ========== 測試 5：重新整理後持久化 ==========
    log('重新整理頁面...');
    var extCtxReload = waitForExtContext(client, 15000);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    log('等待 extension context 重建...');
    var ctxId2 = await extCtxReload;
    log('Reload 後 extension context ID: ' + ctxId2);

    if (!ctxId2) {
      results.push(report('重新整理後 storage 資料持久化', false, 'context not found after reload'));
      results.push(report('Sidebar 顯示「自定義字幕（已還原）」', false, 'context not found after reload'));
    } else {
      // 立即讀取 storage（不依賴 content script 行為）
      try {
        var persistData = await storageGet(client, ctxId2, STORAGE_KEY);
        var persistOk = persistData && Array.isArray(persistData) && persistData.length === TEST_SUBTITLES.length;
        results.push(report('重新整理後 storage 資料持久化', persistOk,
          persistOk ? '資料完整保留 (' + persistData.length + ' 筆)' : '得到: ' + JSON.stringify(persistData)));
      } catch (err) {
        results.push(report('重新整理後 storage 資料持久化', false, err.message));
      }

      // ========== 測試 6：Sidebar 顯示「已還原」（輪詢最多 15 秒）==========
      // _restoreSavedSubtitle 在主字幕 HTTP 回傳後才呼叫，需等待
      log('等待 _restoreSavedSubtitle 執行（輪詢最多 15 秒）...');
      var finalStatus = await pollStatusText(page, '已還原', 15000);
      var restoredOk = finalStatus.includes('已還原');
      results.push(report('Sidebar 顯示「自定義字幕（已還原）」', restoredOk,
        '最終狀態: "' + finalStatus + '"'));

      // ========== 清理 ==========
      log('清理測試 storage 資料...');
      try {
        await storageRemove(client, ctxId2, STORAGE_KEY);
        log('測試資料已清除');
      } catch (err) {
        log('清理失敗（非致命）: ' + err.message);
      }
    }
  } finally {
    await context.close();
  }

  // ===== 總結 =====
  console.log('\n========== QA 測試總結 ==========');
  var passed = results.filter(Boolean).length;
  var total = results.length;
  console.log('通過 ' + passed + ' / ' + total + ' 項測試');
  if (passed === total) {
    console.log('✅ 全部通過');
  } else {
    console.log('❌ ' + (total - passed) + ' 項失敗，請見上方詳細輸出');
  }
}

runTest().catch(function(err) {
  console.error('測試執行期間發生未預期錯誤:', err);
  process.exit(1);
});
