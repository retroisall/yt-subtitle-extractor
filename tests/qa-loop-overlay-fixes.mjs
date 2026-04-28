/**
 * qa-loop-overlay-fixes.mjs
 * QA 測試：2026-04-24 修復功能驗證
 *
 * T1: Loop debounce — 點擊設定 loop 後 300ms 內不允許被取消（防雙重觸發）
 * T2: Overlay 不被 CC button 自動切換隱藏（只響應用戶點擊）
 * T3: YouTube popup 開啟時 wrapper z-index 降低（避免遮擋通知）
 * T4: 字幕模式 loop row 有紫色背景（.ysm-row.looping）
 *
 * 執行方式：node tests/qa-loop-overlay-fixes.mjs
 */

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..');

const VIDEO_ID = 'dQw4w9WgXcQ';
const STORAGE_KEY = 'editedSubtitles_' + VIDEO_ID;
const SETTINGS_KEY = 'yt-sub-settings';

const TEST_SUBTITLES = {
  primarySubtitles: [
    { text: 'Never gonna give you up',   startTime: 0,  duration: 3 },
    { text: 'Never gonna let you down',  startTime: 3,  duration: 3 },
    { text: 'Never gonna run around',    startTime: 6,  duration: 4 },
    { text: 'Never gonna make you cry',  startTime: 10, duration: 3 },
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

async function storageRemove(client, ctxId, key) {
  const expr = 'new Promise(res => chrome.storage.local.remove(' + JSON.stringify(key) + ', res))';
  await client.send('Runtime.evaluate', { expression: expr, contextId: ctxId, awaitPromise: true });
}

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

async function runTest() {
  log('啟動 Chrome + 擴充套件...');
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

    log('導航到 YouTube 影片...');
    const ctxProm = waitForExtContext(client, 20000);
    await page.goto('https://www.youtube.com/watch?v=' + VIDEO_ID, {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });

    try { await page.waitForSelector('#yt-sub-demo-sidebar', { timeout: 10000 }); }
    catch (_) { log('⚠️ Sidebar 未出現'); }

    const ctxId = await ctxProm;
    if (!ctxId) {
      results.push(report('前置 Extension context 取得', false));
      return summarize(results);
    }
    results.push(report('前置 Extension context 取得', true, 'contextId=' + ctxId));

    // 寫入測試字幕 + reload
    await storageSet(client, ctxId, STORAGE_KEY, TEST_SUBTITLES);
    log('重新整理...');
    const ctxProm2 = waitForExtContext(client, 20000);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    const ctxId2 = await ctxProm2;
    if (!ctxId2) {
      results.push(report('Reload 後 context 取得', false));
      return summarize(results);
    }

    await new Promise(r => setTimeout(r, 1500));
    const statusText = await pollStatusText(page, '已還原', 12000);
    if (!statusText.includes('已還原')) {
      results.push(report('字幕還原', false, '"' + statusText + '"'));
      return summarize(results);
    }
    results.push(report('字幕還原', true));
    await new Promise(r => setTimeout(r, 800));

    // ===== T1: Loop Debounce =====
    log('T1 測試 Loop Debounce...');

    // 確保 overlay 開啟
    await page.evaluate(() => {
      const el = document.getElementById('yt-sub-overlay-toggle');
      if (el && !el.checked) el.click();
    });
    await new Promise(r => setTimeout(r, 300));

    // 先讓影片到第一句字幕位置
    await page.evaluate(() => {
      const v = document.querySelector('video');
      if (v) v.currentTime = 1;
    });
    await new Promise(r => setTimeout(r, 400));

    // 取得目前 loopingIdx 初始狀態
    const loopBefore = await page.evaluate(() => {
      // 直接點擊 #yt-sub-current 兩次，用 timing 測試 debounce
      const el = document.getElementById('yt-sub-current');
      if (!el) return { error: 'no yt-sub-current' };

      let clickCount = 0;
      const origHandler = null;
      // 紀錄 loopingIdx 的變化
      const clicks = [];

      // 第一次點擊：應設定 loop
      el.click();
      // 立即第二次點擊（模擬雙重觸發）：應被 debounce 攔截
      el.click();

      // 等一個 microtask tick 再讀狀態
      return {
        hasLooping: el.classList.contains('looping'),
      };
    });

    log('T1 debounce 後 looping class: ' + JSON.stringify(loopBefore));
    // 如果 debounce 正常：looping = true（第一次設定，第二次被攔截）
    // 如果 debounce 失效：looping = false（第一次設定後立刻被第二次取消）
    const debounceOk = loopBefore.hasLooping === true;
    results.push(report('T1 Loop debounce — 連點兩次仍維持 looping 狀態', debounceOk,
      'looping=' + loopBefore.hasLooping));

    // 取消 loop
    await new Promise(r => setTimeout(r, 500));
    await page.evaluate(() => {
      document.getElementById('yt-sub-current')?.click();
    });
    await new Promise(r => setTimeout(r, 200));

    // ===== T2: CC Button 不自動隱藏 Overlay =====
    log('T2 測試 CC button 不自動隱藏 overlay...');

    // 先確認 overlay 存在且可見
    const overlayVisibleBefore = await page.evaluate(() => {
      const ov = document.getElementById('yt-sub-overlay');
      if (!ov) return false;
      return ov.style.display !== 'none';
    });
    results.push(report('T2a Overlay 初始可見', overlayVisibleBefore));

    if (overlayVisibleBefore) {
      // 模擬 YouTube 自動切換 CC button（非用戶點擊）
      const afterAutoToggle = await page.evaluate(() => {
        const btn = document.querySelector('.ytp-subtitles-button');
        if (!btn) return { noBtn: true };

        // 直接改變 aria-pressed 屬性（模擬 YouTube 程式性切換，非用戶點擊）
        const oldVal = btn.getAttribute('aria-pressed');
        btn.setAttribute('aria-pressed', 'false');

        // 等 MutationObserver 觸發
        return new Promise(resolve => {
          setTimeout(() => {
            const ov = document.getElementById('yt-sub-overlay');
            const visible = ov ? ov.style.display !== 'none' : false;
            // 還原
            if (oldVal !== null) btn.setAttribute('aria-pressed', oldVal);
            resolve({ visible, oldVal });
          }, 100);
        });
      });

      log('T2 CC button 自動切換後 overlay: ' + JSON.stringify(afterAutoToggle));
      if (afterAutoToggle.noBtn) {
        results.push(report('T2b CC button 存在', false, '找不到 .ytp-subtitles-button'));
      } else {
        // Overlay 應該仍然可見（debounce 阻止了自動切換）
        results.push(report('T2b 非用戶點擊不隱藏 overlay', afterAutoToggle.visible === true,
          'overlay visible=' + afterAutoToggle.visible));
      }
    }

    // ===== T3: YouTube Popup 開啟時降低 sidebar z-index =====
    log('T3 測試 YouTube popup 開啟時 z-index 降低...');

    // 直接修改頁面上已存在的 tp-yt-iron-dropdown 的 aria-hidden 屬性
    // （Polymer 的 connectedCallback 會把新建元素立刻設回 aria-hidden="true"，
    //   所以不能 createElement；改用修改現有元素屬性，這才是 YouTube 實際打開 popup 的方式）
    const zIndexResult = await page.evaluate(() => {
      const wrapper = document.getElementById('yt-sub-wrapper');
      if (!wrapper) return { error: 'no wrapper' };

      const zBefore = wrapper.style.zIndex || getComputedStyle(wrapper).zIndex;

      // 找頁面上已有的 tp-yt-iron-dropdown（YouTube 頁面上至少有一個，預設 aria-hidden="true"）
      const existingDropdown = document.querySelector('tp-yt-iron-dropdown, iron-dropdown');
      if (!existingDropdown) return { error: 'no existing dropdown', zBefore };

      const origAriaHidden = existingDropdown.getAttribute('aria-hidden');
      existingDropdown.setAttribute('aria-hidden', 'false'); // 模擬 popup 開啟

      return new Promise(resolve => {
        // 等 400ms（> 輪詢間隔 150ms * 2）讓 content script setInterval 偵測到
        setTimeout(() => {
          const zAfter = wrapper.style.zIndex;
          existingDropdown.setAttribute('aria-hidden', origAriaHidden || 'true'); // 還原（模擬 popup 關閉）

          setTimeout(() => {
            const zRestored = wrapper.style.zIndex;
            resolve({ zBefore, zAfter, zRestored });
          }, 400);
        }, 400);
      });
    });

    log('T3 z-index 變化: ' + JSON.stringify(zIndexResult));
    if (zIndexResult.error) {
      results.push(report('T3 wrapper 存在', false, zIndexResult.error));
    } else {
      results.push(report('T3a popup 開啟時 z-index 降到 1000',
        zIndexResult.zAfter === '1000',
        'zAfter=' + zIndexResult.zAfter));
      results.push(report('T3b popup 關閉後 z-index 還原',
        !zIndexResult.zRestored || zIndexResult.zRestored === '',
        'zRestored="' + zIndexResult.zRestored + '"'));
    }

    // ===== T4: 字幕模式 Loop Row 紫色背景 =====
    log('T4 測試字幕模式 loop row 樣式...');

    // 切換到字幕模式
    const enteredSubMode = await page.evaluate(() => {
      const sel = document.getElementById('yt-sub-mode-select');
      if (!sel) return false;
      sel.value = 'subtitle';
      sel.dispatchEvent(new Event('change'));
      return true;
    });

    if (!enteredSubMode) {
      results.push(report('T4a 切換到字幕模式', false, '找不到 #yt-sub-mode-select'));
    } else {
      await new Promise(r => setTimeout(r, 1000));

      const ysmExists = await page.evaluate(() =>
        !!document.getElementById('yt-sub-subtitle-mode'));
      results.push(report('T4a 字幕模式介面出現', ysmExists));

      if (ysmExists) {
        // 新行為：loop 由點擊卡片背景觸發，獨立按鈕已移除
        const noBtnInDom = await page.evaluate(() =>
          document.querySelector('.ysm-loop-btn') === null);
        results.push(report('T4b 獨立 loop 按鈕已移除', noBtnInDom));

        // 點擊第一個 row 的 texts 區（非 ts）觸發 loop
        await page.evaluate(() => {
          const row = document.querySelector('.ysm-row');
          if (row) row.querySelector('.ysm-texts')?.click();
        });
        await new Promise(r => setTimeout(r, 300));

          const loopRowStyle = await page.evaluate(() => {
            const row = document.querySelector('.ysm-row');
            if (!row) return { noRow: true };
            const hasLoopingClass = row.classList.contains('looping');
            const bg = getComputedStyle(row).backgroundColor;
            return { hasLoopingClass, bg };
          });

          log('T4 loop row 樣式: ' + JSON.stringify(loopRowStyle));

          if (loopRowStyle.noRow) {
            results.push(report('T4c loop row 取得', false, '找不到 .ysm-row'));
          } else {
            results.push(report('T4c .ysm-row 有 looping class', loopRowStyle.hasLoopingClass,
              'hasLoopingClass=' + loopRowStyle.hasLoopingClass));
            // 深紫背景 = rgb(30, 27, 75) = #1e1b4b
            const isPurple = loopRowStyle.bg && loopRowStyle.bg !== 'rgba(0, 0, 0, 0)' &&
              !loopRowStyle.bg.startsWith('rgba(0, 0, 0,');
            results.push(report('T4d row 背景有顏色（非透明）', isPurple,
              'background=' + loopRowStyle.bg));
          }
      }

      // 離開字幕模式
      await page.evaluate(() => {
        document.getElementById('ysm-close-btn')?.click();
      });
      await new Promise(r => setTimeout(r, 500));
    }

  } catch (err) {
    log('測試過程發生例外: ' + err.message);
    console.error(err);
  } finally {
    try {
      const cleanPage = await context.newPage();
      const cleanClient = await context.newCDPSession(cleanPage);
      await cleanClient.send('Runtime.enable');
      const cleanCtxProm = waitForExtContext(cleanClient, 10000);
      await cleanPage.goto('https://www.youtube.com/watch?v=' + VIDEO_ID, {
        waitUntil: 'domcontentloaded', timeout: 20000,
      });
      const cId = await cleanCtxProm;
      if (cId) await storageRemove(cleanClient, cId, STORAGE_KEY);
      log('測試資料已清除');
    } catch (_) {}
    await context.close();
  }

  return summarize(results);
}

function summarize(results) {
  const pass = results.filter(Boolean).length;
  const fail = results.length - pass;
  console.log('\n========== Loop/Overlay 修復 QA 測試總結 ==========');
  console.log('通過 ' + pass + ' / ' + results.length + ' 項');
  if (fail > 0) console.log('❌ 失敗 ' + fail + ' 項，請查看上方報告');
  else console.log('✅ 全部通過');
  return { pass, fail, total: results.length };
}

runTest().catch(err => {
  console.error('執行失敗:', err);
  process.exit(1);
});
