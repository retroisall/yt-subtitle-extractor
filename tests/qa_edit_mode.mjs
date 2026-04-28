/**
 * qa_edit_mode.mjs
 * QA Playwright 測試：YouTube Edit Mode (YEM) 完整功能驗證
 *
 * 策略：
 *  - 先導航到影片頁，取得 extension context
 *  - 透過 CDP 寫入假字幕到 chrome.storage.local（editedSubtitles_9bZkp7q19f0）
 *  - 重新整理頁面，extension 會還原假字幕（status: "自定義字幕（已還原）"）
 *  - 之後所有 YEM 測試都有字幕可用
 *
 * 測試清單（共 11 項）：
 *  1. 進入/退出編輯模式
 *  2. 字幕列表渲染
 *  3. 新增字幕句
 *  4. 刪除字幕句
 *  5. 合併字幕句
 *  6. 副字幕不錯位（插入後）
 *  7. 副字幕不錯位（刪除後）
 *  8. 時間平移
 *  9. 未儲存標記
 * 10. 儲存本地
 * 11. 匯出 SRT
 */

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH  = path.resolve(__dirname, '..');
const PROFILE   = path.resolve(__dirname, '..', '.playwright-profile');
const VIDEO_URL = 'https://www.youtube.com/watch?v=9bZkp7q19f0';
const VIDEO_ID  = '9bZkp7q19f0';
const STORAGE_KEY = `editedSubtitles_${VIDEO_ID}`;

// ─── 假字幕資料（10 句，含副字幕，供 YEM 測試使用） ─────────────────────────
const FAKE_SUBTITLES = {
  primarySubtitles: [
    { text: 'Oppan Gangnam Style',   startTime:  2,  endTime:  4 },
    { text: 'Gangnam Style',         startTime:  4,  endTime:  6 },
    { text: 'Oppan Gangnam Style',   startTime:  6,  endTime:  8 },
    { text: 'Gangnam Style',         startTime:  8,  endTime: 10 },
    { text: 'Eh, sexy lady',         startTime: 10,  endTime: 12 },
    { text: 'Op, op, op, op',        startTime: 12,  endTime: 14 },
    { text: 'Oppan Gangnam Style',   startTime: 14,  endTime: 16 },
    { text: 'Eh, sexy lady',         startTime: 16,  endTime: 18 },
    { text: 'Op, op, op, op',        startTime: 18,  endTime: 20 },
    { text: 'Oppan Gangnam Style',   startTime: 20,  endTime: 22 },
  ],
  secondarySubtitles: [
    { text: '江南大叔風格',   startTime:  2,  duration: 2 },
    { text: '江南風格',       startTime:  4,  duration: 2 },
    { text: '江南大叔風格',   startTime:  6,  duration: 2 },
    { text: '江南風格',       startTime:  8,  duration: 2 },
    { text: '嘿，性感女郎',   startTime: 10,  duration: 2 },
    { text: '嗯嗯嗯嗯',       startTime: 12,  duration: 2 },
    { text: '江南大叔風格',   startTime: 14,  duration: 2 },
    { text: '嘿，性感女郎',   startTime: 16,  duration: 2 },
    { text: '嗯嗯嗯嗯',       startTime: 18,  duration: 2 },
    { text: '江南大叔風格',   startTime: 20,  duration: 2 },
  ],
};

// ─── 工具函式 ───────────────────────────────────────────────────────────────

/** 帶時間戳的日誌 */
function log(msg) {
  console.log('[' + new Date().toLocaleTimeString() + '] ' + msg);
}

/** 印出 pass/fail/skip，回傳 result 物件 */
function report(label, passed, detail) {
  const icon = passed === null ? '⏭ ' : passed ? '✅' : '❌';
  console.log(icon + ' ' + label + (detail ? ' — ' + detail : ''));
  return { label, passed, detail };
}

/** 等待 extension isolated world context（監聽 CDP 事件） */
function waitForExtContext(client, timeout) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), timeout);
    client.on('Runtime.executionContextCreated', event => {
      if (event.context.name === 'YT Subtitle Demo') {
        clearTimeout(timer);
        resolve(event.context.id);
      }
    });
  });
}

/** 在 extension context 執行 JS，回傳 result.value（awaitPromise） */
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

/** chrome.storage.local.set（在 extension context 執行） */
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
  return evalExt(client, ctxId, expr);
}

/** chrome.storage.local.get（在 extension context 執行） */
async function storageGet(client, ctxId, key) {
  const keyJson = JSON.stringify(key);
  const expr = `new Promise(res => chrome.storage.local.get(${keyJson}, res))`;
  return evalExt(client, ctxId, expr);
}

/** chrome.storage.local.remove（清理用） */
async function storageRemove(client, ctxId, key) {
  const keyJson = JSON.stringify(key);
  const expr = `new Promise(res => chrome.storage.local.remove(${keyJson}, res))`;
  await evalExt(client, ctxId, expr);
}

/** 輪詢直到條件成立或超時 */
async function poll(fn, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

/** 進入 edit 模式（透過 #yt-sub-mode-select） */
async function enterEditMode(page) {
  await page.evaluate(() => {
    const sel = document.getElementById('yt-sub-mode-select');
    if (!sel) throw new Error('#yt-sub-mode-select 不存在');
    sel.value = 'edit';
    sel.dispatchEvent(new Event('change'));
  });
}

/** 等待 #yem-rows .yem-row 出現，最多 10 秒 */
async function waitForRows(page) {
  return poll(
    () => page.evaluate(() => {
      const rows = document.querySelectorAll('#yem-rows .yem-row');
      return rows.length > 0 ? rows.length : null;
    }),
    10000
  );
}

/** 退出 edit 模式（點 #yem-back-btn） */
async function exitEditMode(page) {
  await page.evaluate(() => {
    document.getElementById('yem-back-btn')?.click();
  });
  await page.waitForTimeout(800);
}

/** 重新整理頁面並等待 extension context 重新出現 */
async function reloadAndWaitExt(page, client, timeout = 20000) {
  const ctxPromise = waitForExtContext(client, timeout);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  return ctxPromise;
}

// ─── 主測試流程 ──────────────────────────────────────────────────────────────

async function runTests() {
  log('啟動 Playwright + Chrome 擴充套件...');
  log('擴充套件路徑: ' + EXT_PATH);
  log('Profile 路徑: ' + PROFILE);

  const context = await chromium.launchPersistentContext(PROFILE, {
    headless: false,
    args: [
      '--disable-extensions-except=' + EXT_PATH,
      '--load-extension=' + EXT_PATH,
      '--no-sandbox',
    ],
  });

  const results = [];

  try {
    const page   = await context.newPage();
    const client = await context.newCDPSession(page);
    await client.send('Runtime.enable');

    // ── 1st 導航：取得 extension context，寫入假字幕 ─────────────────────
    log('首次導航到 ' + VIDEO_URL);
    const extCtxPromise1 = waitForExtContext(client, 20000);
    await page.goto(VIDEO_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    log('等待 extension context...');
    const ctxId1 = await extCtxPromise1;
    results.push(report(
      '前置：Extension isolated world 取得',
      !!ctxId1,
      ctxId1 ? 'contextId=' + ctxId1 : '未找到'
    ));
    if (!ctxId1) {
      printSummary(results);
      await context.close();
      return;
    }

    // ── 清除舊 key，寫入假字幕 ───────────────────────────────────────────
    log('清除舊假字幕 key...');
    await storageRemove(client, ctxId1, STORAGE_KEY);
    log('寫入假字幕到 ' + STORAGE_KEY);
    await storageSet(client, ctxId1, STORAGE_KEY, FAKE_SUBTITLES);
    log('假字幕寫入完成');

    // ── Reload：extension 還原假字幕 ─────────────────────────────────────
    log('重新整理頁面，等待 extension 還原字幕...');
    // 使用可變狀態追蹤最新 ctxId（跨多次 reload）
    const state = { ctxId: ctxId1 };
    client.on('Runtime.executionContextCreated', event => {
      if (event.context.name === 'YT Subtitle Demo') {
        state.ctxId = event.context.id;
        log('Extension context 更新: ' + state.ctxId);
      }
    });
    const extCtxPromise2 = waitForExtContext(client, 20000);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await extCtxPromise2;
    log('Extension context ID（reload 後）: ' + state.ctxId);

    // ── 等待側邊欄 & 字幕還原 success ────────────────────────────────────
    await page.waitForSelector('#yt-sub-mode-select', { timeout: 15000 });
    log('等待字幕還原（#yt-sub-status.success，最多 15 秒）...');
    const statusText = await poll(
      () => page.evaluate(() => {
        const el = document.getElementById('yt-sub-status');
        if (!el) return null;
        return el.classList.contains('success') ? el.textContent : null;
      }),
      15000, 600
    );
    log('字幕狀態: ' + (statusText || '（未達 success）'));
    if (!statusText) {
      // 如果沒達到 success，多給 2 秒
      await page.waitForTimeout(2000);
    }

    // ────────────────────────────────────────────────────────────────────────
    // 測試 1：進入 / 退出 編輯模式
    // ────────────────────────────────────────────────────────────────────────
    log('\n=== 測試 1：進入/退出編輯模式 ===');
    await enterEditMode(page);
    await page.waitForTimeout(1000);

    const overlayVisible = await page.evaluate(() => {
      const el = document.getElementById('yt-sub-edit-mode');
      return !!el;
    });
    results.push(report('T1a 進入 edit mode → overlay 出現', overlayVisible));

    await exitEditMode(page);
    const overlayGone = await page.evaluate(() => !document.getElementById('yt-sub-edit-mode'));
    results.push(report('T1b 點 ← 返回 → overlay 消失', overlayGone));

    // ────────────────────────────────────────────────────────────────────────
    // 測試 2：字幕列表渲染
    // ────────────────────────────────────────────────────────────────────────
    log('\n=== 測試 2：字幕列表渲染 ===');
    await enterEditMode(page);
    const rowCount = await waitForRows(page);
    results.push(report(
      'T2 #yem-rows 有 .yem-row',
      !!rowCount && rowCount > 0,
      rowCount ? rowCount + ' 列' : '0 列（超時）'
    ));

    if (!rowCount) {
      results.push(report('T3-T11', false, '字幕列表為空，後續測試中止'));
      printSummary(results);
      await context.close();
      return;
    }

    // ────────────────────────────────────────────────────────────────────────
    // 測試 3：新增字幕句
    // ────────────────────────────────────────────────────────────────────────
    log('\n=== 測試 3：新增字幕句 ===');
    const rowsBefore3 = await page.evaluate(() =>
      document.querySelectorAll('#yem-rows .yem-row').length
    );
    await page.evaluate(() => document.getElementById('yem-add-btn')?.click());
    await page.waitForTimeout(400);

    const rowsAfter3 = await page.evaluate(() =>
      document.querySelectorAll('#yem-rows .yem-row').length
    );
    results.push(report('T3a 點 #yem-add-btn → 新增一列', rowsAfter3 === rowsBefore3 + 1,
      `before=${rowsBefore3} after=${rowsAfter3}`
    ));

    // 新增列（主副字幕均空）的副字幕欄位應為空
    const newRowSecEmpty = await page.evaluate(() => {
      const rows = document.querySelectorAll('#yem-rows .yem-row');
      for (const row of rows) {
        const pri = row.querySelector('.yem-primary-input')?.value || '';
        const sec = row.querySelector('.yem-secondary-input')?.value || '';
        if (pri === '' && sec === '') return true;
      }
      return false;
    });
    results.push(report('T3b 新增列副字幕欄位為空', newRowSecEmpty));

    // ────────────────────────────────────────────────────────────────────────
    // 測試 4：刪除字幕句
    // ────────────────────────────────────────────────────────────────────────
    log('\n=== 測試 4：刪除字幕句 ===');
    await exitEditMode(page);
    await enterEditMode(page);
    await waitForRows(page);

    const rowsBefore4 = await page.evaluate(() =>
      document.querySelectorAll('#yem-rows .yem-row').length
    );
    await page.evaluate(() => {
      document.querySelector('#yem-rows .yem-row .yem-del-btn')?.click();
    });
    await page.waitForTimeout(400);

    const rowsAfter4 = await page.evaluate(() =>
      document.querySelectorAll('#yem-rows .yem-row').length
    );
    results.push(report('T4a 點 .yem-del-btn → 該列消失', rowsAfter4 === rowsBefore4 - 1,
      `before=${rowsBefore4} after=${rowsAfter4}`
    ));

    // 確認 data-idx 重排：第 0 列的 data-idx 應為 "0"
    const newFirstIdx = await page.evaluate(() =>
      document.querySelector('#yem-rows .yem-row')?.dataset.idx
    );
    results.push(report('T4b 刪除後 data-idx 重排', newFirstIdx === '0',
      `新第1列 data-idx="${newFirstIdx}"`
    ));

    // ────────────────────────────────────────────────────────────────────────
    // 測試 5：合併字幕句
    // ────────────────────────────────────────────────────────────────────────
    log('\n=== 測試 5：合併字幕句 ===');
    await exitEditMode(page);
    await enterEditMode(page);
    await waitForRows(page);

    const rowsBefore5 = await page.evaluate(() =>
      document.querySelectorAll('#yem-rows .yem-row').length
    );
    const texts5 = await page.evaluate(() => {
      const rows = document.querySelectorAll('#yem-rows .yem-row');
      return [
        rows[0]?.querySelector('.yem-primary-input')?.value || '',
        rows[1]?.querySelector('.yem-primary-input')?.value || '',
      ];
    });

    if (rowsBefore5 < 2) {
      results.push(report('T5 合併字幕句', false, '列數不足 2，無法測試'));
    } else {
      await page.evaluate(() => document.querySelector('.yem-merge-btn')?.click());
      await page.waitForTimeout(400);

      const rowsAfter5 = await page.evaluate(() =>
        document.querySelectorAll('#yem-rows .yem-row').length
      );
      results.push(report('T5a 點 .yem-merge-btn → 兩列合為一列', rowsAfter5 === rowsBefore5 - 1,
        `before=${rowsBefore5} after=${rowsAfter5}`
      ));

      // 合併後第一列文字應包含兩句的合集
      const mergedText5 = await page.evaluate(() =>
        document.querySelector('#yem-rows .yem-row .yem-primary-input')?.value || ''
      );
      const hasBoth = (
        (texts5[0] === '' || mergedText5.includes(texts5[0])) &&
        (texts5[1] === '' || mergedText5.includes(texts5[1]))
      );
      results.push(report('T5b 合併後文字合成', hasBoth,
        `"${mergedText5.substring(0, 60)}"`
      ));
    }

    // ────────────────────────────────────────────────────────────────────────
    // 測試 6：副字幕不錯位（插入新句後）
    // ────────────────────────────────────────────────────────────────────────
    log('\n=== 測試 6：副字幕不錯位（插入後）===');
    await exitEditMode(page);
    await enterEditMode(page);
    await waitForRows(page);

    // 讀取第 1 列（index=1）的副字幕
    const secN = await page.evaluate(() => {
      const rows = document.querySelectorAll('#yem-rows .yem-row');
      if (rows.length < 2) return null;
      return rows[1].querySelector('.yem-secondary-input')?.value ?? null;
    });

    if (secN === null || secN === '') {
      results.push(report('T6 副字幕不錯位（插入後）', null, 'SKIP — 副字幕欄位為空'));
      log('T6 SKIP');
    } else {
      // 聚焦第 0 列，新增在其後（新列成為第 1 列，原第 1 列推到第 2 列）
      await page.evaluate(() => {
        const rows = document.querySelectorAll('#yem-rows .yem-row');
        rows[0]?.querySelector('.yem-primary-input')?.focus();
      });
      await page.waitForTimeout(100);
      await page.evaluate(() => document.getElementById('yem-add-btn')?.click());
      await page.waitForTimeout(500);

      // 原第 1 列現在是第 2 列，副字幕應不變
      const secNPlus1 = await page.evaluate(() => {
        const rows = document.querySelectorAll('#yem-rows .yem-row');
        if (rows.length < 3) return null;
        return rows[2].querySelector('.yem-secondary-input')?.value ?? '';
      });
      results.push(report('T6 插入後原第N列副字幕不錯位', secNPlus1 === secN,
        `原副字幕="${secN}" 現第N+1列="${secNPlus1}"`
      ));
    }

    // ────────────────────────────────────────────────────────────────────────
    // 測試 7：副字幕不錯位（刪除後）
    // ────────────────────────────────────────────────────────────────────────
    log('\n=== 測試 7：副字幕不錯位（刪除後）===');
    // 重新整理頁面，確保 secondarySubtitles 狀態乾淨（不受 T6 插入影響）
    await exitEditMode(page);
    log('T7：重新整理頁面以清除 T6 殘留狀態...');
    {
      const ctxT7Promise = waitForExtContext(client, 15000);
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      await ctxT7Promise;
    }
    await page.waitForSelector('#yt-sub-mode-select', { timeout: 10000 });
    await poll(
      () => page.evaluate(() => {
        const el = document.getElementById('yt-sub-status');
        return el?.classList.contains('success') ? el.textContent : null;
      }),
      10000, 500
    );
    await enterEditMode(page);
    await waitForRows(page);

    const secRow1_7 = await page.evaluate(() => {
      const rows = document.querySelectorAll('#yem-rows .yem-row');
      if (rows.length < 2) return null;
      return rows[1].querySelector('.yem-secondary-input')?.value ?? null;
    });

    if (secRow1_7 === null || secRow1_7 === '') {
      results.push(report('T7 副字幕不錯位（刪除後）', null, 'SKIP — 副字幕為空'));
      log('T7 SKIP');
    } else {
      await page.evaluate(() => {
        document.querySelector('#yem-rows .yem-row .yem-del-btn')?.click();
      });
      await page.waitForTimeout(400);

      const secNewRow0 = await page.evaluate(() =>
        document.querySelector('#yem-rows .yem-row .yem-secondary-input')?.value ?? ''
      );
      results.push(report('T7 刪除後副字幕不錯位', secNewRow0 === secRow1_7,
        `原第2列="${secRow1_7}" 刪除後第1列="${secNewRow0}"`
      ));
    }

    // ────────────────────────────────────────────────────────────────────────
    // 測試 8：時間平移
    // ────────────────────────────────────────────────────────────────────────
    log('\n=== 測試 8：時間平移 ===');
    await exitEditMode(page);
    await enterEditMode(page);
    await waitForRows(page);

    // 記錄平移前所有 startTime input 值
    const tsBefore = await page.evaluate(() =>
      [...document.querySelectorAll('.yem-ts-input[data-field="startTime"]')].map(i => i.value)
    );

    // 設定 +1 秒並套用
    await page.evaluate(() => {
      const inp = document.getElementById('yem-shift-input');
      if (inp) { inp.value = '1'; inp.dispatchEvent(new Event('input')); }
      document.getElementById('yem-shift-btn')?.click();
    });
    await page.waitForTimeout(500);

    const tsAfter = await page.evaluate(() =>
      [...document.querySelectorAll('.yem-ts-input[data-field="startTime"]')].map(i => i.value)
    );

    // 解析 m:ss.mmm → 秒
    function parseTs(str) {
      if (!str) return NaN;
      const parts = str.split(':');
      if (parts.length === 2) return Number(parts[0]) * 60 + Number(parts[1]);
      return Number(str) || 0;
    }

    let shiftOk = tsBefore.length > 0 && tsAfter.length === tsBefore.length;
    let shiftDetail = '';
    if (shiftOk) {
      for (let i = 0; i < tsBefore.length; i++) {
        const diff = parseTs(tsAfter[i]) - parseTs(tsBefore[i]);
        if (Math.abs(diff - 1) >= 0.02) {
          shiftOk = false;
          shiftDetail = `列${i}: before="${tsBefore[i]}" after="${tsAfter[i]}" diff=${diff.toFixed(3)}`;
          break;
        }
      }
      if (shiftOk) shiftDetail = `${tsBefore.length} 列全部 startTime +1s 正確`;
    } else {
      shiftDetail = `before=${tsBefore.length} after=${tsAfter.length}`;
    }
    results.push(report('T8 時間平移 +1s 正確', shiftOk, shiftDetail));

    // ────────────────────────────────────────────────────────────────────────
    // 測試 9：未儲存標記
    // ────────────────────────────────────────────────────────────────────────
    log('\n=== 測試 9：未儲存標記 ===');
    // T8 已執行平移並呼叫 _markDirty → style.display = ''（空字串 = 顯示）
    // 注意：style.display === '' 表示 inline style 被清除，元素依 CSS 顯示（非 none）
    const dirtyVisible = await page.evaluate(() => {
      const badge = document.getElementById('yem-dirty-badge');
      if (!badge) return false;
      const d = badge.style.display;
      // '' = 顯示中（_markDirty 設 ''）；'none' = 隱藏
      return d !== 'none';
    });
    results.push(report('T9 修改後 #yem-dirty-badge 顯示', dirtyVisible,
      dirtyVisible ? 'display 非 none' : 'display=none（badge 隱藏）'
    ));

    // ────────────────────────────────────────────────────────────────────────
    // 測試 10：儲存本地
    // ────────────────────────────────────────────────────────────────────────
    log('\n=== 測試 10：儲存本地 ===');
    // 清除 key 後儲存
    await storageRemove(client, state.ctxId, STORAGE_KEY);
    await page.evaluate(() => document.getElementById('yem-save-btn')?.click());
    await page.waitForTimeout(800);

    let saveOk = false, saveDetail = '';
    try {
      const stored = await storageGet(client, state.ctxId, STORAGE_KEY);
      if (stored && typeof stored === 'object') {
        const val = stored[STORAGE_KEY];
        saveOk = !!(val?.primarySubtitles?.length > 0);
        saveDetail = saveOk
          ? `key "${STORAGE_KEY}" 存在，${val.primarySubtitles.length} 句`
          : `val=${JSON.stringify(val).substring(0, 80)}`;
      } else {
        saveDetail = 'storageGet 回傳非物件: ' + JSON.stringify(stored);
      }
    } catch (e) {
      saveDetail = 'CDP 查詢失敗: ' + e.message;
    }
    results.push(report('T10 儲存本地 → storage key 存在', saveOk, saveDetail));

    // ────────────────────────────────────────────────────────────────────────
    // 測試 11：匯出 SRT
    // ────────────────────────────────────────────────────────────────────────
    log('\n=== 測試 11：匯出 SRT ===');
    // 擴充套件在 isolated world 執行，需在 extension context 中 patch document.createElement
    // 才能攔截到 <a download>.click() 事件
    await client.send('Runtime.evaluate', {
      expression: `(function() {
        window.__qaExportClickedExt = false;
        const orig = document.createElement.bind(document);
        document.createElement = function(tag) {
          const el = orig(tag);
          if (tag.toLowerCase() === 'a') {
            const oc = el.click.bind(el);
            el.click = function() {
              if (this.hasAttribute('download')) window.__qaExportClickedExt = true;
              try { oc(); } catch(_) {}
            };
          }
          return el;
        };
        return 'patched';
      })()`,
      contextId: state.ctxId,
      awaitPromise: false,
      returnByValue: true,
    });

    await page.evaluate(() => document.getElementById('yem-export-btn')?.click());
    await page.waitForTimeout(600);

    const exportResult = await client.send('Runtime.evaluate', {
      expression: 'window.__qaExportClickedExt === true',
      contextId: state.ctxId,
      returnByValue: true,
    });
    const exportClicked = exportResult.result?.value === true;
    results.push(report('T11 匯出 SRT → <a download> 被觸發', exportClicked,
      exportClicked ? '已在 ext context 偵測到 <a download>.click()' : '未偵測到下載動作'
    ));

  } catch (err) {
    console.error('測試過程發生未預期錯誤:', err.message);
    results.push(report('未預期錯誤', false, err.message));
  } finally {
    await context.close().catch(() => {});
  }

  printSummary(results);
}

/** 印出最終摘要 */
function printSummary(results) {
  console.log('\n' + '═'.repeat(60));
  console.log('YEM 測試摘要');
  console.log('═'.repeat(60));
  let pass = 0, fail = 0, skip = 0;
  for (const r of results) {
    if (r.passed === null) skip++;
    else if (r.passed) pass++;
    else fail++;
  }
  console.log(`通過: ${pass}  失敗: ${fail}  跳過: ${skip}  共: ${results.length}`);
  console.log('═'.repeat(60));
  process.exit(fail > 0 ? 1 : 0);
}

runTests().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
