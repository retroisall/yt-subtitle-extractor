/**
 * qa-subtitle-mode-loop-click.mjs
 * QA 測試：字幕模式新功能驗證
 *
 * T1: 點擊卡片背景 → 進入 loop（looping class + loopingIdx 不為 -1）
 * T2: 同一卡片再次點擊 → 取消 loop（looping class 消失 + loopingIdx === -1）
 * T3: 獨立 loop 按鈕（.ysm-loop-btn）不再顯示於 DOM
 * T4: 換影片後退出字幕模式（history.pushState 模擬 SPA 換頁）
 *
 * 執行方式：node tests/qa-subtitle-mode-loop-click.mjs
 */

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..');

const VIDEO_ID = 'dQw4w9WgXcQ';
const STORAGE_KEY = 'editedSubtitles_' + VIDEO_ID;

// 測試用本地字幕
const TEST_SUBTITLES = {
  primarySubtitles: [
    { text: 'Never gonna give you up',       startTime: 0,  duration: 3 },
    { text: 'Never gonna let you down',       startTime: 3,  duration: 3 },
    { text: 'Never gonna run around and desert you', startTime: 6, duration: 4 },
    { text: 'Never gonna make you cry',       startTime: 10, duration: 3 },
    { text: 'Never gonna say goodbye',        startTime: 13, duration: 3 },
  ],
  secondarySubtitles: [],
};

function log(msg) {
  console.log('[' + new Date().toLocaleTimeString() + '] ' + msg);
}

function report(label, passed, detail) {
  const icon = passed ? '✅' : '❌';
  console.log(icon + ' ' + label + (detail ? ' — ' + detail : ''));
  return passed;
}

/** 等待 extension isolated world context（依名稱過濾） */
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

/** 將資料寫入 chrome.storage.local */
async function storageSet(client, ctxId, key, value) {
  const expr = [
    'new Promise(function(res, rej) {',
    '  var obj = {}; obj[' + JSON.stringify(key) + '] = ' + JSON.stringify(value) + ';',
    '  chrome.storage.local.set(obj, function() {',
    '    if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));',
    '    else res(true);',
    '  });',
    '})',
  ].join('\n');
  const r = await client.send('Runtime.evaluate', {
    expression: expr, contextId: ctxId, awaitPromise: true, returnByValue: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception.description);
  return r.result.value === true;
}

/** 從 chrome.storage.local 移除資料 */
async function storageRemove(client, ctxId, key) {
  const expr = 'new Promise(res => chrome.storage.local.remove(' + JSON.stringify(key) + ', res))';
  await client.send('Runtime.evaluate', {
    expression: expr, contextId: ctxId, awaitPromise: true,
  });
}

/**
 * 透過 DOM 讀取目前 looping 中的 row index。
 * loopingIdx 變數在 IIFE 內，CDP 無法直接讀取；
 * 改以 .ysm-row.looping 的 data-idx 屬性作為替代指標。
 * 無 looping row 時回傳 -1。
 */
async function getLoopingIdxFromDom(page) {
  return await page.evaluate(() => {
    const loopingRow = document.querySelector('#ysm-subtitle-list .ysm-row.looping');
    return loopingRow ? Number(loopingRow.dataset.idx) : -1;
  });
}

/** 等待狀態列出現指定字串 */
async function pollStatusText(page, targetSubstr, maxMs) {
  const deadline = Date.now() + maxMs;
  let last = '';
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 500));
    const text = await page.evaluate(() => {
      const el = document.getElementById('yt-sub-status');
      return el ? el.textContent : '';
    }).catch(() => '');
    if (text !== last) { log('狀態: "' + text + '"'); last = text; }
    if (text.includes(targetSubstr)) return text;
  }
  return last;
}

// ===== 主流程 =====
async function runTest() {
  log('啟動 Chrome + 擴充套件...');
  log('擴充套件路徑: ' + EXT_PATH);

  const context = await chromium.launchPersistentContext('', {
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

    // ===== 前置：導航、寫入字幕、重新整理、確認還原 =====
    log('導航到 YouTube 影片...');
    const extCtxPromise = waitForExtContext(client, 20000);
    await page.goto('https://www.youtube.com/watch?v=' + VIDEO_ID, {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });

    // 等 sidebar 出現
    await page.waitForSelector('#yt-sub-demo-sidebar', { timeout: 10000 });

    // 取得 extension context
    const ctxId = await extCtxPromise;
    if (!ctxId) {
      log('❌ 無法取得 extension isolated world，放棄測試');
      await context.close(); return summarize(results);
    }
    log('Extension context 取得: contextId=' + ctxId);

    // 寫入本地字幕
    log('寫入本地字幕到 storage...');
    await storageSet(client, ctxId, STORAGE_KEY, TEST_SUBTITLES);

    // 重新整理讓套件自動還原
    log('重新整理頁面...');
    const extCtxReload = waitForExtContext(client, 20000);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    const ctxId2 = await extCtxReload;
    if (!ctxId2) {
      log('❌ reload 後無法取得 extension context，放棄測試');
      await context.close(); return summarize(results);
    }
    log('Reload 後 contextId=' + ctxId2);

    // 等字幕還原
    await new Promise(r => setTimeout(r, 2000));
    const statusText = await pollStatusText(page, '已還原', 15000);
    const restoredOk = statusText.includes('已還原');
    if (!restoredOk) {
      log('❌ 字幕未還原，無法測試字幕模式: "' + statusText + '"');
      await context.close(); return summarize(results);
    }
    log('字幕已還原，切換到字幕模式...');

    // 切換到字幕模式
    await page.evaluate(() => {
      const sel = document.getElementById('yt-sub-mode-select');
      if (!sel) throw new Error('找不到 #yt-sub-mode-select');
      sel.value = 'subtitle';
      sel.dispatchEvent(new Event('change'));
    });
    await new Promise(r => setTimeout(r, 1500));

    const subtitleModeExists = await page.evaluate(() =>
      !!document.getElementById('yt-sub-subtitle-mode')
    );
    if (!subtitleModeExists) {
      log('❌ 字幕模式 overlay 未出現，放棄測試');
      await context.close(); return summarize(results);
    }
    log('字幕模式已進入，開始 T1~T4...');

    // ===== T1：點擊卡片背景 → 進入 loop =====
    log('T1：點擊第一個 .ysm-row 的 texts 區域...');

    // 等待列表渲染
    await page.waitForSelector('#ysm-subtitle-list .ysm-row', { timeout: 5000 });

    // 點擊第一個 row 的 .ysm-texts 區域（非 .ysm-ts）
    await page.evaluate(() => {
      const row = document.querySelector('#ysm-subtitle-list .ysm-row');
      if (!row) throw new Error('找不到 .ysm-row');
      const texts = row.querySelector('.ysm-texts');
      if (texts) {
        texts.click();
      } else {
        // fallback：直接點 row（避開 ts）
        row.click();
      }
    });
    await new Promise(r => setTimeout(r, 300));

    // 驗證 looping class
    const t1HasLoopingClass = await page.evaluate(() => {
      const row = document.querySelector('#ysm-subtitle-list .ysm-row');
      return row ? row.classList.contains('looping') : false;
    });

    // 透過 DOM data-idx 讀取 loopingIdx（IIFE 內變數無法用 CDP 直接讀）
    const t1LoopingIdx = await getLoopingIdxFromDom(page);
    const t1Pass = t1HasLoopingClass && t1LoopingIdx !== -1;
    results.push(report('T1 點擊卡片背景 → 進入 loop',
      t1Pass,
      'looping class=' + t1HasLoopingClass + ', loopingIdx(DOM)=' + t1LoopingIdx));

    // ===== T2：同一卡片再次點擊 → 取消 loop =====
    log('T2：等 300ms debounce 後再次點擊同一張卡片...');
    await new Promise(r => setTimeout(r, 350)); // 等 debounce 過

    await page.evaluate(() => {
      const row = document.querySelector('#ysm-subtitle-list .ysm-row');
      if (!row) throw new Error('找不到 .ysm-row');
      const texts = row.querySelector('.ysm-texts');
      if (texts) {
        texts.click();
      } else {
        row.click();
      }
    });
    await new Promise(r => setTimeout(r, 300));

    // 驗證 looping class 消失
    const t2HasLoopingClass = await page.evaluate(() => {
      const row = document.querySelector('#ysm-subtitle-list .ysm-row');
      return row ? row.classList.contains('looping') : true; // 預期 false
    });

    // 透過 DOM 讀取 loopingIdx（無 looping row → -1）
    const t2LoopingIdx = await getLoopingIdxFromDom(page);
    const t2Pass = !t2HasLoopingClass && t2LoopingIdx === -1;
    results.push(report('T2 再次點擊同一卡片 → 取消 loop',
      t2Pass,
      'looping class=' + t2HasLoopingClass + ', loopingIdx(DOM)=' + t2LoopingIdx));

    // ===== T3：獨立 loop 按鈕不再顯示 =====
    log('T3：確認 .ysm-loop-btn 不在 DOM 中...');
    const t3LoopBtnCount = await page.evaluate(() => {
      const btns = document.querySelectorAll('.ysm-loop-btn');
      // 統計實際存在且可見的按鈕
      let visibleCount = 0;
      btns.forEach(btn => {
        const style = window.getComputedStyle(btn);
        if (style.display !== 'none' && style.visibility !== 'hidden') visibleCount++;
      });
      return { total: btns.length, visible: visibleCount };
    });
    const t3Pass = t3LoopBtnCount.total === 0 || t3LoopBtnCount.visible === 0;
    results.push(report('T3 .ysm-loop-btn 不在 DOM 或已隱藏',
      t3Pass,
      'total=' + t3LoopBtnCount.total + ', visible=' + t3LoopBtnCount.visible));

    // ===== T4：換影片後退出字幕模式 =====
    log('T4：確認目前在字幕模式...');

    // 先確保回到字幕模式（T2 後 loop 取消但仍在字幕模式介面）
    const t4SubtitleModeExistsBefore = await page.evaluate(() =>
      !!document.getElementById('yt-sub-subtitle-mode')
    );
    log('T4 字幕模式存在: ' + t4SubtitleModeExistsBefore);

    if (!t4SubtitleModeExistsBefore) {
      // 重新進入字幕模式
      await page.evaluate(() => {
        const sel = document.getElementById('yt-sub-mode-select');
        if (sel) { sel.value = 'subtitle'; sel.dispatchEvent(new Event('change')); }
      });
      await new Promise(r => setTimeout(r, 1000));
    }

    // 確認目前進入字幕模式（以 DOM 判斷，IIFE 內部變數無法用 CDP 讀取）
    const subtitleOverlayBefore = await page.evaluate(() =>
      !!document.getElementById('yt-sub-subtitle-mode')
    );
    log('T4 #yt-sub-subtitle-mode 存在: ' + subtitleOverlayBefore);

    // 模擬 SPA 換頁：pushState 觸發 MutationObserver
    log('T4：執行 history.pushState 模擬 SPA 換頁...');
    await page.evaluate(() => {
      history.pushState({}, '', '/watch?v=FAKE123');
      // 同時觸發 DOM 變動讓 MutationObserver 能偵測到（模擬 YouTube 的行為）
      document.title = document.title + ' ';
    });

    // 等待 800ms 讓 MutationObserver 執行並完成 exitSubtitleMode
    await new Promise(r => setTimeout(r, 800));

    // 確認 #yt-sub-subtitle-mode 已從 DOM 移除（exitSubtitleMode 的 .remove() 效果）
    const t4SubtitleModeGone = await page.evaluate(() =>
      !document.getElementById('yt-sub-subtitle-mode')
    );
    log('T4 pushState 後 #yt-sub-subtitle-mode 消失: ' + t4SubtitleModeGone);

    const t4Pass = subtitleOverlayBefore && t4SubtitleModeGone;
    results.push(report('T4 換影片後退出字幕模式（#yt-sub-subtitle-mode 消失）',
      t4Pass,
      'before=' + subtitleOverlayBefore + ', after gone=' + t4SubtitleModeGone));

  } catch (err) {
    log('測試過程發生例外: ' + err.message);
    console.error(err);
  } finally {
    // 清理測試資料
    try {
      const cleanPage = await context.newPage();
      const cleanClient = await context.newCDPSession(cleanPage);
      await cleanClient.send('Runtime.enable');
      const cleanCtx = waitForExtContext(cleanClient, 10000);
      await cleanPage.goto('https://www.youtube.com/watch?v=' + VIDEO_ID, {
        waitUntil: 'domcontentloaded', timeout: 20000,
      });
      const cId = await cleanCtx;
      if (cId) await storageRemove(cleanClient, cId, STORAGE_KEY);
      log('測試用本地字幕資料已清除');
    } catch (_) {}

    await context.close();
  }

  return summarize(results);
}

function summarize(results) {
  const pass = results.filter(Boolean).length;
  const fail = results.length - pass;
  console.log('\n========== 字幕模式 Loop 點擊 QA 測試總結 ==========');
  console.log('通過 ' + pass + ' / ' + results.length + ' 項');
  if (fail > 0) console.log('❌ 失敗 ' + fail + ' 項，請查看上方報告');
  else console.log('✅ 全部通過');
  return { pass, fail, total: results.length };
}

runTest().catch(err => {
  console.error('執行失敗:', err);
  process.exit(1);
});
