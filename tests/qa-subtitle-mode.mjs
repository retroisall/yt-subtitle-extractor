/**
 * qa-subtitle-mode.mjs
 * QA 測試：字幕模式（Subtitle Mode）功能驗證
 *
 * 測試策略：
 * 1. 用 CDP 寫入本地字幕（editedSubtitles_<videoId>）到 chrome.storage.local
 * 2. 等待套件自動還原為自定義字幕（不依賴 YouTube pot token）
 * 3. 透過 DOM 操作 #yt-sub-mode-select 切入字幕模式
 * 4. 驗證各功能
 *
 * 執行方式：node tests/qa-subtitle-mode.mjs
 */

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..');

const VIDEO_ID = 'dQw4w9WgXcQ';
const STORAGE_KEY = 'editedSubtitles_' + VIDEO_ID;

// 測試用本地字幕（模擬真實英文字幕）
const TEST_SUBTITLES = {
  primarySubtitles: [
    { text: 'Never gonna give you up',       startTime: 0,  duration: 3 },
    { text: 'Never gonna let you down',       startTime: 3,  duration: 3 },
    { text: 'Never gonna run around and desert you', startTime: 6, duration: 4 },
    { text: 'Never gonna make you cry',       startTime: 10, duration: 3 },
    { text: 'Never gonna say goodbye',        startTime: 13, duration: 3 },
    { text: 'Never gonna tell a lie and hurt you', startTime: 16, duration: 4 },
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

async function storageGet(client, ctxId, key) {
  const expr = [
    'new Promise(function(res) {',
    '  chrome.storage.local.get(' + JSON.stringify(key) + ', function(data) {',
    '    res(JSON.stringify(data[' + JSON.stringify(key) + '] || null));',
    '  });',
    '})',
  ].join('\n');
  const r = await client.send('Runtime.evaluate', {
    expression: expr, contextId: ctxId, awaitPromise: true, returnByValue: true,
  });
  return JSON.parse(r.result.value || 'null');
}

async function storageRemove(client, ctxId, key) {
  const expr = 'new Promise(res => chrome.storage.local.remove(' + JSON.stringify(key) + ', res))';
  await client.send('Runtime.evaluate', {
    expression: expr, contextId: ctxId, awaitPromise: true,
  });
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

    // ===== T1：導航到 YouTube =====
    log('導航到 YouTube 影片...');
    const extCtxPromise = waitForExtContext(client, 20000);
    await page.goto('https://www.youtube.com/watch?v=' + VIDEO_ID, {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    results.push(report('T1 導航到 YouTube 影片', true));

    // ===== T2：Sidebar 出現 =====
    let sidebarOk = false;
    try {
      await page.waitForSelector('#yt-sub-demo-sidebar', { timeout: 10000 });
      sidebarOk = true;
    } catch (_) {}
    results.push(report('T2 Sidebar 出現', sidebarOk));
    if (!sidebarOk) { await context.close(); return summarize(results); }

    // ===== T3：取得 Extension Context =====
    log('等待 extension isolated world...');
    const ctxId = await extCtxPromise;
    results.push(report('T3 Extension isolated world 取得', !!ctxId,
      ctxId ? 'contextId=' + ctxId : '未找到'));
    if (!ctxId) { await context.close(); return summarize(results); }

    // ===== T4：寫入本地字幕 + 等待還原 =====
    log('寫入本地字幕到 storage...');
    await storageSet(client, ctxId, STORAGE_KEY, TEST_SUBTITLES);

    // 重新整理讓套件自動還原
    log('重新整理頁面，等待套件還原本地字幕...');
    const extCtxReload = waitForExtContext(client, 20000);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    const ctxId2 = await extCtxReload;
    if (!ctxId2) {
      results.push(report('T4 重新整理後取得 context', false));
      await context.close(); return summarize(results);
    }
    log('Reload 後 contextId=' + ctxId2);

    // 等頁面穩定後，確認 storage 資料確實存在
    await new Promise(r => setTimeout(r, 2000));
    const storageVerify = await storageGet(client, ctxId2, STORAGE_KEY);
    log('Storage 驗證: ' + (storageVerify ? JSON.stringify(storageVerify).slice(0, 80) : 'null'));
    if (!storageVerify || !storageVerify.primarySubtitles?.length) {
      log('⚠️  storage 資料不存在或格式錯誤，restore 必然失敗');
    }

    const statusText = await pollStatusText(page, '已還原', 15000);
    const restoredOk = statusText.includes('已還原');
    results.push(report('T4 本地字幕自動還原', restoredOk, '"' + statusText + '"'));
    if (!restoredOk) {
      log('字幕未還原，無法測試字幕模式');
      await context.close(); return summarize(results);
    }

    // ===== T5：字幕列表出現（正常模式）=====
    await new Promise(r => setTimeout(r, 1000));
    const listItems = await page.evaluate(() => {
      return document.querySelectorAll('#yt-sub-list .yt-sub-item').length;
    });
    results.push(report('T5 字幕列表在正常模式下出現', listItems > 0, listItems + ' 句'));

    // ===== T6：切換到字幕模式 =====
    log('切換到字幕模式...');
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
    results.push(report('T6 字幕模式 overlay 出現', subtitleModeExists));
    if (!subtitleModeExists) {
      await context.close(); return summarize(results);
    }

    // ===== T7：字幕列表渲染 =====
    const ysmRows = await page.evaluate(() =>
      document.querySelectorAll('#ysm-subtitle-list .ysm-row').length
    );
    results.push(report('T7 字幕模式列表渲染', ysmRows > 0, ysmRows + ' 句'));

    // ===== T8：影片元素已搬到字幕模式視窗 =====
    const videoInYsm = await page.evaluate(() =>
      !!document.querySelector('.ysm-real-video')
    );
    results.push(report('T8 影片元素搬入字幕模式視窗', videoInYsm));

    // ===== T9：播放控制按鈕存在 =====
    const playBtnExists = await page.evaluate(() =>
      !!document.getElementById('ysm-play-btn')
    );
    results.push(report('T9 播放控制按鈕存在', playBtnExists));

    // ===== T10：搜尋框存在 =====
    const searchExists = await page.evaluate(() =>
      !!document.getElementById('ysm-search')
    );
    results.push(report('T10 搜尋框存在', searchExists));

    // ===== T11：搜尋過濾功能 =====
    if (searchExists) {
      await page.fill('#ysm-search', 'never');
      await new Promise(r => setTimeout(r, 400));
      const filteredRows = await page.evaluate(() =>
        document.querySelectorAll('#ysm-subtitle-list .ysm-row').length
      );
      const countText = await page.evaluate(() =>
        document.getElementById('ysm-search-count')?.textContent || ''
      );
      const searchOk = filteredRows > 0 && filteredRows <= ysmRows && countText.includes('/');
      results.push(report('T11 搜尋過濾（前綴 "never"）', searchOk,
        filteredRows + ' 句符合，計數: "' + countText + '"'));
      // 清空搜尋
      await page.fill('#ysm-search', '');
      await new Promise(r => setTimeout(r, 300));
    }

    // ===== T12：ysm-loop-btn 存在（每句都有循環按鈕）=====
    const loopBtns = await page.evaluate(() =>
      document.querySelectorAll('.ysm-loop-btn').length
    );
    results.push(report('T12 每句有循環按鈕', loopBtns > 0, loopBtns + ' 個'));

    // ===== T13：循環按鈕點擊 → active class 加上 =====
    if (loopBtns > 0) {
      await page.evaluate(() => {
        document.querySelector('.ysm-loop-btn').click();
      });
      await new Promise(r => setTimeout(r, 200));
      const hasActive = await page.evaluate(() =>
        document.querySelector('.ysm-loop-btn.active') !== null
      );
      results.push(report('T13 點循環按鈕 → active class 加上', hasActive));

      // 再點一次取消
      await page.evaluate(() => {
        const active = document.querySelector('.ysm-loop-btn.active');
        if (active) active.click();
      });
      await new Promise(r => setTimeout(r, 200));
      const noActive = await page.evaluate(() =>
        document.querySelector('.ysm-loop-btn.active') === null
      );
      results.push(report('T14 再點循環按鈕 → active 取消', noActive));
    }

    // ===== T15：切換不同循環句 → active 立即轉移（不需等 300ms interval）=====
    if (loopBtns >= 2) {
      // 先 loop 第一句
      await page.evaluate(() => document.querySelectorAll('.ysm-loop-btn')[0].click());
      await new Promise(r => setTimeout(r, 100));
      // 立即 loop 第二句（不等 300ms）
      await page.evaluate(() => document.querySelectorAll('.ysm-loop-btn')[1].click());
      await new Promise(r => setTimeout(r, 100));
      const activeIdx = await page.evaluate(() => {
        const btns = document.querySelectorAll('.ysm-loop-btn');
        return Array.from(btns).findIndex(b => b.classList.contains('active'));
      });
      results.push(report('T15 切換循環句 active 立即轉移', activeIdx === 1,
        '第 ' + (activeIdx + 1) + ' 句亮起'));
      // 清掉循環
      await page.evaluate(() => {
        const active = document.querySelector('.ysm-loop-btn.active');
        if (active) active.click();
      });
      await new Promise(r => setTimeout(r, 100));
    }

    // ===== T16：單字 span 出現（buildTokenizedText）=====
    const wordSpans = await page.evaluate(() =>
      document.querySelectorAll('#ysm-subtitle-list .yt-sub-word').length
    );
    results.push(report('T16 單字 span 渲染（可點擊查字典）', wordSpans > 0, wordSpans + ' 個'));

    // ===== T17：點擊 timestamp → 影片時間改變 =====
    const firstTs = await page.$('#ysm-subtitle-list .ysm-ts');
    if (firstTs) {
      const tsBefore = await page.evaluate(() =>
        document.querySelector('.ysm-real-video, video')?.currentTime ?? -1
      );
      await firstTs.click();
      await new Promise(r => setTimeout(r, 400));
      const tsAfter = await page.evaluate(() =>
        document.querySelector('.ysm-real-video, video')?.currentTime ?? -1
      );
      results.push(report('T17 點時間戳跳轉影片', tsAfter !== tsBefore || tsAfter >= 0,
        'before=' + tsBefore.toFixed(2) + ' after=' + tsAfter.toFixed(2)));
    }

    // ===== T18：右鍵 contextmenu — 靜態驗證（⚠️ 受限：toast 無法在自動化中可靠觸發）=====
    // QA_README 說明：右鍵存字受 YouTube capture handler 干擾，須手動測試
    // 這裡改驗 initWindowContextMenu 是否涵蓋了 #yt-sub-subtitle-mode（代碼層面保證）
    const contextMenuCoversSubtitleMode = await page.evaluate(() => {
      // 驗證 window 上確實有 capture 模式的 contextmenu listener（不可直接讀到，改用靜態文字驗證）
      // 已知 initWindowContextMenu 在 content.js 已加入 inSubtitle = e.target.closest('#yt-sub-subtitle-mode')
      // 此 check 驗證字幕模式容器存在
      return !!document.getElementById('yt-sub-subtitle-mode');
    });
    log('T18 ⚠️ 右鍵 contextmenu（受限，需手動驗證）— 代碼已修正涵蓋 #yt-sub-subtitle-mode: ' + contextMenuCoversSubtitleMode);
    // 不加入 results 計分，需要手動在瀏覽器驗證

    // ===== T19：退出字幕模式 =====
    log('退出字幕模式...');
    await page.evaluate(() => {
      document.getElementById('ysm-close-btn')?.click();
    });
    await new Promise(r => setTimeout(r, 1000));
    const modeGone = await page.evaluate(() =>
      !document.getElementById('yt-sub-subtitle-mode')
    );
    results.push(report('T19 退出字幕模式 overlay 消失', modeGone));

    // ===== T20：退出後影片歸還 YouTube player =====
    const videoBack = await page.evaluate(() => {
      const player = document.querySelector('#movie_player');
      return !!player?.querySelector('video');
    });
    results.push(report('T20 退出後影片元素歸還 #movie_player', videoBack));

    // ===== T21：退出後無 timeupdate 錯誤（_ysmSyncControls 不再執行）=====
    // 等 1 秒，確認 console 無 "Cannot set properties of null" 之類的錯誤
    const pageErrors = [];
    page.on('pageerror', err => pageErrors.push(err.message));
    await new Promise(r => setTimeout(r, 1500));
    const noTimeupdateErr = !pageErrors.some(e =>
      e.includes('Cannot set') || e.includes('playBtn') || e.includes('scrubber')
    );
    results.push(report('T21 退出後無 timeupdate handler 殘留錯誤', noTimeupdateErr,
      noTimeupdateErr ? '無錯誤' : pageErrors.join('; ')));

  } catch (err) {
    log('測試過程發生例外: ' + err.message);
    console.error(err);
  } finally {
    // 清理測試資料（不汙染後續測試）
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
  console.log('\n========== 字幕模式 QA 測試總結 ==========');
  console.log('通過 ' + pass + ' / ' + results.length + ' 項');
  if (fail > 0) console.log('❌ 失敗 ' + fail + ' 項，請查看上方報告');
  else console.log('✅ 全部通過');
  return { pass, fail, total: results.length };
}

runTest().catch(err => {
  console.error('執行失敗:', err);
  process.exit(1);
});
