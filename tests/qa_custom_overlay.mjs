/**
 * qa_custom_overlay.mjs
 * QA Playwright 功能測試：自定義字幕還原後 applyOverlay 驗證
 *
 * 測試流程：
 * 1. 導航到 YouTube 影片頁 (dQw4w9WgXcQ)
 * 2. 等待 extension isolated world context（名稱 "YouTube Learning Bar (DEV)"）
 * 3. 用 CDP 寫入假自定義字幕到 editedSubtitles_dQw4w9WgXcQ
 * 4. 重新整理，等待字幕還原（最多 10 秒，輪詢確認 sidebar 顯示「已還原」）
 * 5. 驗證 #yt-sub-overlay 存在於 DOM
 * 6. 驗證 #yt-sub-panel-subtitle 第一個子元素不是 .yt-sub-community-picker
 */

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..');
const PROFILE_PATH = path.resolve(__dirname, '..', '.playwright-profile');

const VIDEO_ID = 'dQw4w9WgXcQ';
const STORAGE_KEY = 'editedSubtitles_' + VIDEO_ID;

/** 假自定義字幕資料（新格式：含 primarySubtitles / secondarySubtitles） */
const TEST_SUBTITLES = {
  primarySubtitles: [
    { text: 'QA overlay test line 1', startTime: 0, duration: 2000 },
    { text: 'QA overlay test line 2', startTime: 2, duration: 2000 },
    { text: '字幕 applyOverlay 驗證',  startTime: 4, duration: 2000 },
  ],
  secondarySubtitles: [],
};

/** 帶時間戳的日誌 */
function log(msg) {
  console.log('[' + new Date().toLocaleTimeString() + '] ' + msg);
}

/** 印出 pass/fail 結果，回傳 boolean */
function report(label, passed, detail) {
  const icon = passed ? '✅' : '❌';
  console.log(icon + ' ' + label + (detail ? ' — ' + detail : ''));
  return passed;
}

/**
 * 等待 extension isolated world context 出現（監聽 Runtime.executionContextCreated）
 */
function waitForExtContext(client, timeout) {
  return new Promise(function(resolve) {
    const timer = setTimeout(function() { resolve(null); }, timeout);
    client.on('Runtime.executionContextCreated', function(event) {
      if (event.context.name === 'YouTube Learning Bar (DEV)') {
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
    throw new Error(r.exceptionDetails.exception.description || 'storage.set failed');
  }
  return r.result.value === true;
}

/**
 * 在 extension isolated world 執行 chrome.storage.local.remove（清理用）
 */
async function storageRemove(client, ctxId, key) {
  const keyJson = JSON.stringify(key);
  const expr = 'new Promise(function(res) { chrome.storage.local.remove(' + keyJson + ', res); })';
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
  const deadline = Date.now() + maxMs;
  let last = '';
  while (Date.now() < deadline) {
    await new Promise(function(r) { setTimeout(r, 500); });
    const text = await page.evaluate(function() {
      const el = document.getElementById('yt-sub-status');
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

// ===== 主測試流程 =====
async function runTest() {
  log('啟動 Playwright + Chrome 擴充套件...');
  log('擴充套件路徑: ' + EXT_PATH);
  log('Profile 路徑: ' + PROFILE_PATH);

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

    // ===== 1. 導航到 YouTube 影片頁 =====
    log('導航到 https://www.youtube.com/watch?v=' + VIDEO_ID);
    const extCtxOnLoad = waitForExtContext(client, 15000);
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

    // ===== 2. 等待 extension isolated world =====
    log('等待 extension isolated world（最多 15 秒）...');
    const ctxId = await extCtxOnLoad;
    log('Extension context ID: ' + ctxId);
    results.push(report(
      'Extension isolated world 取得',
      !!ctxId,
      ctxId ? 'contextId=' + ctxId : '未找到 — 擴充套件可能未正確載入'
    ));

    if (!ctxId) {
      log('無法取得 extension context，中止測試');
      printSummary(results);
      await context.close();
      return;
    }

    // ===== 3. 寫入假自定義字幕 =====
    log('寫入假自定義字幕到 storage key: ' + STORAGE_KEY);
    let writeOk = false;
    try {
      writeOk = await storageSet(client, ctxId, STORAGE_KEY, TEST_SUBTITLES);
      results.push(report(
        'chrome.storage.local.set 假字幕寫入',
        writeOk,
        writeOk
          ? TEST_SUBTITLES.primarySubtitles.length + ' 句主字幕'
          : '回傳 false'
      ));
    } catch (err) {
      results.push(report('chrome.storage.local.set 假字幕寫入', false, err.message));
    }

    if (!writeOk) {
      log('storage 寫入失敗，中止測試');
      printSummary(results);
      await context.close();
      return;
    }

    // ===== 4. 重新整理頁面，等待還原 =====
    log('重新整理頁面...');
    const extCtxReload = waitForExtContext(client, 15000);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    log('等待 extension context 重建（最多 15 秒）...');
    const ctxId2 = await extCtxReload;
    log('Reload 後 extension context ID: ' + ctxId2);
    results.push(report(
      'Reload 後 extension isolated world 重建',
      !!ctxId2,
      ctxId2 ? 'contextId=' + ctxId2 : '未找到'
    ));

    if (!ctxId2) {
      log('Reload 後 context 未恢復，中止測試');
      printSummary(results);
      await context.close();
      return;
    }

    // 輪詢等待 sidebar 顯示「已還原」（最多 10 秒）
    log('等待 _restoreSavedSubtitle 執行（輪詢最多 10 秒）...');
    const finalStatus = await pollStatusText(page, '已還原', 10000);
    const restoredOk = finalStatus.includes('已還原');
    results.push(report(
      'Sidebar 顯示「自定義字幕（已還原）」',
      restoredOk,
      '最終狀態: "' + finalStatus + '"'
    ));

    // ===== 5. 驗證 #yt-sub-overlay 存在 =====
    log('驗證 #yt-sub-overlay 元素存在於 DOM...');
    const overlayExists = await page.evaluate(function() {
      return !!document.getElementById('yt-sub-overlay');
    }).catch(function() { return false; });
    results.push(report(
      '#yt-sub-overlay 存在（applyOverlay 已被呼叫）',
      overlayExists,
      overlayExists ? 'DOM 確認存在' : 'DOM 中找不到 #yt-sub-overlay'
    ));

    // ===== 5b. 驗證 overlay right 與 sidebar 狀態一致（updateOverlayRight 生效）=====
    log('驗證 overlay right 屬性與 sidebar 狀態一致...');
    const overlayRightCheck = await page.evaluate(function() {
      const overlay = document.getElementById('yt-sub-overlay');
      if (!overlay) return { ok: false, reason: 'overlay 不存在' };

      const sidebar = document.getElementById('yt-sub-demo-sidebar');
      const collapsed = sidebar ? sidebar.classList.contains('sidebar-collapsed') : true;
      const ytdApp = document.querySelector('ytd-app');
      const isPush = !!(ytdApp && ytdApp.style.getPropertyValue('margin-right'));

      const rightStyle = overlay.style.right;
      const expectedRight = (collapsed || isPush) ? '2%' : 'calc(360px + 2%)';
      const ok = rightStyle === expectedRight;

      return {
        ok,
        reason: 'right=' + rightStyle + '，sidebar collapsed=' + collapsed + '，isPush=' + isPush + '，expected=' + expectedRight,
      };
    }).catch(function(err) { return { ok: false, reason: err.message }; });
    results.push(report(
      'overlay right 與 sidebar 狀態一致（updateOverlayRight 正確執行）',
      overlayRightCheck.ok,
      overlayRightCheck.reason
    ));

    // ===== 5c. 模擬 sidebar 收合，確認 right 切換為 2% =====
    if (overlayExists) {
      log('模擬 sidebar 收合，確認 overlay right 切換...');
      const collapseCheck = await page.evaluate(function() {
        const sidebar = document.getElementById('yt-sub-demo-sidebar');
        const overlay = document.getElementById('yt-sub-overlay');
        if (!sidebar || !overlay) return { ok: false, reason: 'sidebar 或 overlay 不存在' };

        // 強制加上 sidebar-collapsed class（模擬收合）
        sidebar.classList.add('sidebar-collapsed');

        // 觸發 updateOverlayRight（從 content.js 全域呼叫）
        if (typeof updateOverlayRight === 'function') updateOverlayRight();

        const rightAfter = overlay.style.right;
        // 清理：恢復原狀
        sidebar.classList.remove('sidebar-collapsed');

        return {
          ok: rightAfter === '2%',
          reason: 'sidebar-collapsed 加上後 right=' + rightAfter + '（預期 2%）',
        };
      }).catch(function(err) { return { ok: false, reason: err.message }; });
      results.push(report(
        'sidebar 收合後 overlay right 切換為 2%',
        collapseCheck.ok,
        collapseCheck.reason
      ));
    }

    // ===== 6. 驗證 #yt-sub-panel-subtitle 第一個子元素不是 .yt-sub-community-picker =====
    log('驗證 #yt-sub-panel-subtitle 第一個子元素不是 .yt-sub-community-picker...');
    const pickerNotFirst = await page.evaluate(function() {
      const panel = document.getElementById('yt-sub-panel-subtitle');
      if (!panel) return { ok: false, reason: 'panel 不存在' };
      const firstChild = panel.firstElementChild;
      if (!firstChild) return { ok: true, reason: 'panel 無子元素（非 community picker）' };
      const isCommunityPicker = firstChild.classList.contains('yt-sub-community-picker');
      return {
        ok: !isCommunityPicker,
        reason: isCommunityPicker
          ? 'picker 錯誤出現在第一個位置（class: ' + firstChild.className + '）'
          : '第一個子元素為 ' + (firstChild.id || firstChild.tagName) + '（非 community picker）',
      };
    }).catch(function(err) { return { ok: false, reason: err.message }; });
    results.push(report(
      '#yt-sub-panel-subtitle 第一子元素不是 .yt-sub-community-picker',
      pickerNotFirst.ok,
      pickerNotFirst.reason
    ));

    // ===== 清理 storage =====
    log('清理測試 storage 資料...');
    try {
      await storageRemove(client, ctxId2, STORAGE_KEY);
      log('測試資料已清除');
    } catch (err) {
      log('清理失敗（非致命）: ' + err.message);
    }

  } finally {
    await context.close();
  }

  printSummary(results);
}

/** 印出總結並設定 exit code */
function printSummary(results) {
  console.log('\n========== QA 功能測試總結 ==========');
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

runTest().catch(function(err) {
  console.error('測試執行期間發生未預期錯誤:', err);
  process.exit(1);
});
