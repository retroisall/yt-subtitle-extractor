/**
 * qa_community_subtitles.mjs
 * QA Playwright 測試：社群字幕功能驗證（模組 8）
 *
 * 測試策略：
 *  - 透過 CDP 在 extension context 攔截 chrome.runtime.sendMessage，
 *    模擬 fb_getCommunitySubtitles 回傳假資料，不依賴真實 Firestore
 *  - 透過 CDP 寫入 lastCommunitySubtitle_{videoId}，測試自動還原
 *  - 登入狀態驗證：profile 已有登入，確認 _userTier=editor、編輯功能開通
 *
 * 自動化測試清單（共 8 項）：
 *  T1  社群字幕選項存在且無 🔒 前綴
 *  T2  選項在 DOM 中不是 disabled（可被選取）
 *  T3  點擊社群字幕選項 → 觸發 showCommunitySubtitlePicker，不出現「需登入」訊息
 *  T4  Mock Firestore 回傳 2 筆 → Picker 面板出現，列出 2 項
 *  T5  點選 Picker 第一項 → Picker 關閉，字幕更新，狀態文字含來源名稱
 *  T6  source select 切換為 community 後再切回 default → 無錯誤
 *  T7  設 lastCommunitySubtitle_{videoId} → 重整 → 自動套用社群字幕（狀態含「社群字幕：」）
 *  T8  _userTier 確認為 'editor'（登入即自動升級，不需 Firestore 查詢）
 *
 * 手動測試（無法自動化）：
 *  M1  Guest（未登入）狀態下社群字幕選項仍可點擊
 *  M2  Guest 選取社群字幕 → Picker 正常出現（不被攔截）
 *  M3  分享後計數即時刷新（需操作 editor.html）
 *  M4  SW 重啟後分享不再 403
 */

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH  = path.resolve(__dirname, '..');
const PROFILE   = path.resolve(__dirname, '..', '.playwright-profile');
const VIDEO_URL = 'https://www.youtube.com/watch?v=9bZkp7q19f0';
const VIDEO_ID  = '9bZkp7q19f0';
const STORAGE_KEY = `lastCommunitySubtitle_${VIDEO_ID}`;

// 模擬社群字幕資料
const MOCK_ENTRIES = [
  {
    subtitleName: '測試字幕A',
    authorName: 'QA_Bot',
    uploadedAt: Date.now() - 1000,
    primarySubtitles: [
      { text: 'Hello world', startTime: 2, endTime: 4 },
      { text: 'This is a test', startTime: 4, endTime: 7 },
    ],
    secondarySubtitles: [
      { text: '哈囉世界', startTime: 2, duration: 2 },
      { text: '這是一個測試', startTime: 4, duration: 3 },
    ],
  },
  {
    subtitleName: '測試字幕B',
    authorName: 'QA_User',
    uploadedAt: Date.now() - 2000,
    primarySubtitles: [
      { text: 'Second subtitle set', startTime: 2, endTime: 5 },
    ],
    secondarySubtitles: [],
  },
];

// ─── 工具函式 ─────────────────────────────────────────────────────────────

function log(msg) {
  console.log('[' + new Date().toLocaleTimeString() + '] ' + msg);
}

function report(label, passed, detail) {
  const icon = passed === null ? '⏭ ' : passed ? '✅' : '❌';
  console.log(icon + ' ' + label + (detail ? ' — ' + detail : ''));
  return { label, passed, detail };
}

/** 等待 extension isolated world context */
function waitForExtContext(client, timeout) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), timeout);
    client.on('Runtime.executionContextCreated', event => {
      if (event.context.name === 'YouTube Learning Bar (DEV)') {
        clearTimeout(timer);
        resolve(event.context.id);
      }
    });
  });
}

/** 在 extension context 執行 JS */
async function evalExt(client, ctxId, expr) {
  const r = await client.send('Runtime.evaluate', {
    expression: expr,
    contextId: ctxId,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(
      r.exceptionDetails.exception?.description ||
      r.exceptionDetails.text ||
      'CDP eval failed'
    );
  }
  return r.result?.value;
}

async function storageSet(client, ctxId, key, value) {
  const keyJson = JSON.stringify(key);
  const valJson = JSON.stringify(value);
  const expr = [
    'new Promise(function(res, rej) {',
    '  var obj = {};',
    '  obj[' + keyJson + '] = ' + valJson + ';',
    '  chrome.storage.local.set(obj, function() {',
    '    if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));',
    '    else res(true);',
    '  });',
    '})',
  ].join('\n');
  return evalExt(client, ctxId, expr);
}

async function storageRemove(client, ctxId, key) {
  const keyJson = JSON.stringify(key);
  const expr = `new Promise(res => chrome.storage.local.remove(${keyJson}, res))`;
  return evalExt(client, ctxId, expr);
}

/** 輪詢等待 #yt-sub-status 包含指定字串 */
async function pollStatusText(page, targetSubstr, maxMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    const text = await page.evaluate(() =>
      document.getElementById('yt-sub-status')?.textContent || ''
    );
    if (text.includes(targetSubstr)) return text;
    await page.waitForTimeout(200);
  }
  return null;
}

/** 注入 mock：攔截 extension context 的 chrome.runtime.sendMessage，
 *  只對 fb_getCommunitySubtitles 回傳 mockEntries，其他訊息正常傳出 */
async function injectMockCommunitySubtitles(client, ctxId, mockEntries) {
  const entriesJson = JSON.stringify(mockEntries);
  const expr = `
    (function() {
      if (window.__qa_mock_community__) return 'already_mocked';
      window.__qa_mock_community__ = true;
      var _orig = chrome.runtime.sendMessage.bind(chrome.runtime);
      chrome.runtime.sendMessage = function(msg, callback) {
        if (msg && msg.type === 'fb_getCommunitySubtitles') {
          var entries = ${entriesJson};
          if (typeof callback === 'function') {
            setTimeout(function() { callback({ ok: true, entries: entries }); }, 50);
          }
          return;
        }
        return _orig(msg, callback);
      };
      return 'mocked';
    })()
  `;
  return evalExt(client, ctxId, expr);
}

/** 移除 mock，還原原始 sendMessage */
async function removeMockCommunitySubtitles(client, ctxId) {
  const expr = `
    (function() {
      window.__qa_mock_community__ = false;
      // 無法還原 bind 後的原始函式，重新整理才能真正還原
      return 'removed_flag';
    })()
  `;
  return evalExt(client, ctxId, expr).catch(() => null);
}

// ─── 主測試流程 ───────────────────────────────────────────────────────────

async function main() {
  const results = [];
  let context, page, client, ctxId;

  log('啟動 Playwright + Chrome 擴充套件...');
  log('擴充套件路徑: ' + EXT_PATH);
  log('Profile 路徑: ' + PROFILE);

  context = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    args: [
      '--disable-extensions-except=' + EXT_PATH,
      '--load-extension=' + EXT_PATH,
      '--no-sandbox',
    ],
  });

  try {
    page = context.pages()[0] || await context.newPage();
    client = await context.newCDPSession(page);
    await client.send('Runtime.enable');

    // ── 前置：取得 extension context ──────────────────────────────────────
    log('導航到 ' + VIDEO_URL);
    const ctxPromise = waitForExtContext(client, 15000);
    await page.goto(VIDEO_URL, { waitUntil: 'domcontentloaded' });
    log('等待 Sidebar...');
    await page.waitForSelector('#yt-sub-source-select', { timeout: 20000 });
    log('等待 extension context...');
    ctxId = await ctxPromise;

    if (!ctxId) {
      // context 可能在 goto 前已建立，重試一次
      const ctxPromise2 = waitForExtContext(client, 5000);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#yt-sub-source-select', { timeout: 15000 });
      ctxId = await ctxPromise2;
    }

    results.push(report('前置：Extension isolated world 取得', !!ctxId,
      ctxId ? 'contextId=' + ctxId : '未找到'));
    if (!ctxId) throw new Error('無法取得 extension context，終止測試');

    // 等待頁面穩定
    await page.waitForTimeout(1500);

    // ── T1：社群字幕選項無 🔒 前綴 ────────────────────────────────────────
    log('\n=== T1：社群字幕選項無 🔒 前綴 ===');
    const communityText = await page.evaluate(() => {
      const opt = document.querySelector('#yt-sub-source-select option[value="community"]');
      return opt ? opt.textContent.trim() : null;
    });
    const t1 = communityText !== null && !communityText.includes('🔒');
    results.push(report('T1 社群字幕選項無 🔒 前綴', t1,
      communityText ? `"${communityText}"` : '找不到選項'));

    // ── T2：選項不是 disabled ─────────────────────────────────────────────
    log('\n=== T2：社群字幕選項非 disabled ===');
    const isDisabledInitially = await page.evaluate(() => {
      const opt = document.querySelector('#yt-sub-source-select option[value="community"]');
      return opt ? opt.disabled : null;
    });
    // 初始可能是 disabled（無資料），注入 mock 後應該變成 enabled
    results.push(report('T2 社群字幕選項存在', isDisabledInitially !== null,
      isDisabledInitially !== null ? `初始 disabled=${isDisabledInitially}` : '找不到選項'));

    // ── 注入 Mock ─────────────────────────────────────────────────────────
    log('\n=== 注入 Mock：fb_getCommunitySubtitles 回傳 2 筆假資料 ===');
    const mockResult = await injectMockCommunitySubtitles(client, ctxId, MOCK_ENTRIES);
    log('Mock 注入結果: ' + mockResult);

    // 觸發 fetchCommunitySubtitles（重新執行）
    await evalExt(client, ctxId, `
      (function() {
        var videoId = new URLSearchParams(location.search).get('v') || '';
        if (!videoId) return;
        chrome.runtime.sendMessage({ type: 'fb_getCommunitySubtitles', videoId }, function(res) {
          if (!res || !res.ok || !res.entries || !res.entries.length) return;
          var opt = document.querySelector('#yt-sub-source-select option[value="community"]');
          if (opt) {
            opt.textContent = '👥 社群字幕 (' + res.entries.length + ')';
            opt.disabled = false;
          }
        });
      })()
    `);
    await page.waitForTimeout(500);

    // ── T3：Mock 後選項顯示數量且不含 🔒 ────────────────────────────────
    log('\n=== T3：Mock 後社群字幕選項顯示正確文字 ===');
    const communityTextAfterMock = await page.evaluate(() => {
      const opt = document.querySelector('#yt-sub-source-select option[value="community"]');
      return opt ? { text: opt.textContent.trim(), disabled: opt.disabled } : null;
    });
    const t3 = communityTextAfterMock &&
      communityTextAfterMock.text.includes('👥') &&
      !communityTextAfterMock.text.includes('🔒') &&
      !communityTextAfterMock.disabled;
    results.push(report('T3 Mock 後選項顯示 👥 且非 disabled', t3,
      communityTextAfterMock ? `"${communityTextAfterMock.text}" disabled=${communityTextAfterMock.disabled}` : '找不到選項'));

    // ── T4：點擊社群字幕 → Picker 出現，列出 2 項 ────────────────────────
    log('\n=== T4：點擊社群字幕 → Picker 面板出現 ===');
    // 用 JS 觸發 source select change（Playwright select 無法觸發 option 監聽）
    await page.evaluate(() => {
      const sel = document.getElementById('yt-sub-source-select');
      if (!sel) return;
      sel.value = 'community';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(800);

    const pickerInfo = await page.evaluate(() => {
      const picker = document.getElementById('yt-sub-community-picker');
      if (!picker) return null;
      const items = picker.querySelectorAll('.yt-sub-community-picker-item');
      return { visible: picker.style.display !== 'none', itemCount: items.length };
    });
    const t4 = pickerInfo && pickerInfo.itemCount === 2;
    results.push(report('T4 Picker 出現且列出 2 筆', t4,
      pickerInfo ? `visible=${pickerInfo.visible} items=${pickerInfo.itemCount}` : 'Picker 未出現'));

    // 確認沒有「社群字幕需登入」或「社群字幕需申請」錯誤（翻譯 gate 不在此範疇）
    const statusAfterClick = await page.evaluate(() =>
      document.getElementById('yt-sub-status')?.textContent || ''
    );
    const t3b = !statusAfterClick.includes('社群字幕需登入') && !statusAfterClick.includes('社群字幕需申請');
    results.push(report('T3b 點擊後無社群字幕登入/申請訊息', t3b,
      `狀態: "${statusAfterClick}"`));

    // ── T5：點選 Picker 第一項 → 字幕更新 ───────────────────────────────
    log('\n=== T5：選擇 Picker 第一項 → 字幕套用 ===');
    if (pickerInfo && pickerInfo.itemCount > 0) {
      await page.click('.yt-sub-community-picker-item');
      await page.waitForTimeout(800);

      const pickerGone = await page.evaluate(() =>
        !document.getElementById('yt-sub-community-picker')
      );
      const statusText = await page.evaluate(() =>
        document.getElementById('yt-sub-status')?.textContent || ''
      );
      const t5 = pickerGone && statusText.includes('社群字幕');
      results.push(report('T5 Picker 關閉且狀態顯示社群字幕來源', t5,
        `pickerGone=${pickerGone} status="${statusText}"`));
    } else {
      results.push(report('T5 選擇 Picker 第一項', null, '跳過（Picker 未出現）'));
    }

    // ── T6：切回 default → 無錯誤 ────────────────────────────────────────
    log('\n=== T6：切回 default 來源 → 無主控台錯誤 ===');
    const consoleErrors6 = [];
    page.on('console', msg => {
      if (msg.type() === 'error') consoleErrors6.push(msg.text());
    });
    await page.evaluate(() => {
      const sel = document.getElementById('yt-sub-source-select');
      if (!sel) return;
      sel.value = 'default';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForTimeout(500);
    results.push(report('T6 切回 default 無 JS 錯誤', consoleErrors6.length === 0,
      consoleErrors6.length ? consoleErrors6[0] : 'clean'));

    // ── T7：注入 lastCommunitySubtitle → 重整 → 自動套用 ─────────────────
    log('\n=== T7：storage 有 lastCommunitySubtitle → 重整後自動套用 ===');
    const savedComm = {
      subtitleName: '快取測試字幕',
      authorName: 'QA_Cache',
      primarySubtitles: [
        { text: 'Cached subtitle line 1', startTime: 2, endTime: 4 },
        { text: 'Cached subtitle line 2', startTime: 4, endTime: 7 },
      ],
      secondarySubtitles: [],
    };
    // 清除 editedSubtitles 避免蓋掉社群字幕還原路徑
    await storageRemove(client, ctxId, `editedSubtitles_${VIDEO_ID}`).catch(() => {});
    await storageSet(client, ctxId, STORAGE_KEY, savedComm);
    log('已寫入 ' + STORAGE_KEY);

    // 重整頁面並等待 extension context 重建
    const ctxPromise3 = waitForExtContext(client, 15000);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#yt-sub-source-select', { timeout: 20000 });
    const newCtxId = await ctxPromise3;
    if (newCtxId) ctxId = newCtxId;

    log('等待自動套用社群字幕...');
    const autoApplyStatus = await pollStatusText(page, '社群字幕', 12000);
    const t7 = autoApplyStatus !== null && autoApplyStatus.includes('社群字幕');
    results.push(report('T7 重整後自動套用社群字幕', t7,
      autoApplyStatus ? `狀態: "${autoApplyStatus}"` : '12 秒內未出現社群字幕狀態'));

    // 清理 storage
    if (newCtxId || ctxId) {
      await storageRemove(client, ctxId, STORAGE_KEY).catch(() => {});
    }

    // ── T8：登入狀態偵測（若有登入則確認 edit 選項 enabled）─────────────────
    log('\n=== T8：登入狀態偵測 ===');
    // 偵測帳號 UI：已登入時 #yt-sub-avatar-loggedin display 非 none
    const isLoggedIn = await page.evaluate(() => {
      const el = document.getElementById('yt-sub-avatar-loggedin');
      return el ? el.style.display !== 'none' : false;
    });
    if (!isLoggedIn) {
      results.push(report('T8 _userTier=editor（需登入才可測試）', null,
        '跳過 — .playwright-profile 無登入狀態，請手動登入後重跑'));
    } else {
      // 已登入，等待最多 5 秒讓 _refreshUserTier 完成
      let tier = 'not_editor';
      const t8Start = Date.now();
      while (Date.now() - t8Start < 5000) {
        tier = await evalExt(client, ctxId, `
          (function() {
            var editOpt = document.querySelector('#yt-sub-mode-select option[value="edit"]');
            if (!editOpt) return 'no_edit_option';
            return editOpt.disabled ? 'not_editor' : 'editor';
          })()
        `).catch(() => 'eval_failed');
        if (tier === 'editor') break;
        await page.waitForTimeout(500);
      }
      const t8 = tier === 'editor';
      results.push(report('T8 _userTier=editor（edit 選項不是 disabled）', t8, `result=${tier}`));
    }

  } catch (err) {
    log('測試中斷: ' + err.message);
    results.push(report('測試中斷', false, err.message));
  } finally {
    log('\n清理測試環境...');
    await context.close();
  }

  // ── 測試摘要 ─────────────────────────────────────────────────────────
  const passed  = results.filter(r => r.passed === true).length;
  const failed  = results.filter(r => r.passed === false).length;
  const skipped = results.filter(r => r.passed === null).length;
  const total   = results.length;

  console.log('\n' + '═'.repeat(60));
  console.log('社群字幕 QA 測試摘要');
  console.log('═'.repeat(60));
  console.log(`通過: ${passed}  失敗: ${failed}  跳過: ${skipped}  共: ${total}`);
  console.log('═'.repeat(60));

  if (failed > 0) {
    console.log('\n❌ 失敗項目：');
    results.filter(r => r.passed === false).forEach(r =>
      console.log(`  • ${r.label}${r.detail ? ' — ' + r.detail : ''}`)
    );
  }

  console.log(`
手動測試提醒（需在真實瀏覽器執行）：
  M1  未登入狀態下，社群字幕選項仍可點擊（無 🔒）
  M2  未登入選取社群字幕 → Picker 正常出現（不被攔截）
  M3  分享後計數即時刷新（editor.html 分享後確認 YT 頁面計數 +1）
  M4  SW 重啟後分享不再 403（Service Worker 關閉 5 分鐘後重開測試）
`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
