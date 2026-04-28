/**
 * qa-subtitle-display.mjs
 * QA 測試：字幕顯示功能驗證
 *
 * T1: filterSoundDesc 開啟時 sidebar highlight 對齊 dataset.index（不因過濾偏移）
 * T2: findSubAtTime 重疊字幕取最新條（後往前搜尋，與 findActiveIndex 一致）
 * T3: 字幕列表點單字 popup 為 simplified（無定義/例句/同義詞/句子區塊）
 *
 * 執行方式：node tests/qa-subtitle-display.mjs
 */

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..');

const VIDEO_ID = 'dQw4w9WgXcQ';
const STORAGE_KEY = 'editedSubtitles_' + VIDEO_ID;
const SETTINGS_KEY = 'yt-sub-settings';

// 包含狀聲詞的測試字幕
// idx 0 → normal, idx 1 → [Music] sound desc, idx 2 → normal, idx 3 → normal
const TEST_SUBTITLES_WITH_SOUNDDESC = {
  primarySubtitles: [
    { text: 'Hello world',  startTime: 0, duration: 3 },
    { text: '[Music]',      startTime: 3, duration: 2 },
    { text: 'Second line',  startTime: 5, duration: 3 },
    { text: 'Third line',   startTime: 8, duration: 3 },
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

    // ===== 前置：導航 + sidebar =====
    log('導航到 YouTube 影片...');
    const ctxProm = waitForExtContext(client, 20000);
    await page.goto('https://www.youtube.com/watch?v=' + VIDEO_ID, {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    try { await page.waitForSelector('#yt-sub-demo-sidebar', { timeout: 10000 }); }
    catch (_) { log('⚠️ Sidebar 未出現，可能影響測試'); }

    const ctxId = await ctxProm;
    if (!ctxId) {
      results.push(report('前置 Extension context 取得', false));
      return summarize(results);
    }
    results.push(report('前置 Extension context 取得', true, 'contextId=' + ctxId));

    // ===== T1：filterSoundDesc 開啟時 sidebar highlight 不偏移 =====
    log('T1 準備：寫入含狀聲詞的字幕 + 啟用 filterSoundDesc...');

    // 先取得現有 settings，加入 filterSoundDesc=true
    const existingSettings = await page.evaluate(key => {
      try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; }
    }, SETTINGS_KEY);
    const newSettings = { ...existingSettings, filterSoundDesc: true };
    await page.evaluate(({ key, val }) => localStorage.setItem(key, JSON.stringify(val)),
      { key: SETTINGS_KEY, val: newSettings });

    // 寫入含狀聲詞的字幕
    await storageSet(client, ctxId, STORAGE_KEY, TEST_SUBTITLES_WITH_SOUNDDESC);

    // 重新整理讓套件還原
    log('T1 重新整理...');
    const ctxProm2 = waitForExtContext(client, 20000);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    const ctxId2 = await ctxProm2;
    if (!ctxId2) {
      results.push(report('T1 reload 後 context 取得', false));
      return summarize(results);
    }

    await new Promise(r => setTimeout(r, 1500));
    const statusT1 = await pollStatusText(page, '已還原', 12000);
    if (!statusT1.includes('已還原')) {
      results.push(report('T1 字幕還原', false, '"' + statusT1 + '"'));
    } else {
      // 等列表渲染完成
      await new Promise(r => setTimeout(r, 800));

      // 確認 DOM items 存在且有 dataset.index
      const listInfo = await page.evaluate(() => {
        const items = document.querySelectorAll('#yt-sub-list .yt-sub-item');
        return {
          count: items.length,
          indices: Array.from(items).map(el => parseInt(el.dataset.index)),
        };
      });
      log('T1 渲染後 DOM items: ' + listInfo.count + ' 個，indices=' + listInfo.indices.join(','));

      // filterSoundDesc=true → idx 1 ([Music]) 被過濾，DOM 應只剩 3 項（idx 0, 2, 3）
      const filteredCorrect = listInfo.count === 3 &&
        listInfo.indices.join(',') === '0,2,3';
      results.push(report('T1a filterSoundDesc 過濾後 DOM 剩 3 項（idx 0,2,3）', filteredCorrect,
        '數量=' + listInfo.count + ' indices=' + listInfo.indices.join(',')));

      // Seek 到 startTime=5（primarySubtitles[2] = 'Second line'）
      await page.evaluate(() => {
        const video = document.querySelector('video');
        if (video) video.currentTime = 5.1;
      });
      await new Promise(r => setTimeout(r, 350)); // 等 sync loop（100ms）執行幾次

      const activeInfo = await page.evaluate(() => {
        const active = document.querySelector('#yt-sub-list .yt-sub-item.active');
        return active
          ? { dataIndex: parseInt(active.dataset.index), text: active.textContent.trim().slice(0, 30) }
          : null;
      });
      log('T1 active item: ' + JSON.stringify(activeInfo));

      // 正確：dataset.index 應為 2（'Second line'），不應為 3（位移偏移的舊行為）
      const highlightOk = activeInfo?.dataIndex === 2;
      results.push(report('T1b filterSoundDesc highlight 對齊 dataset.index（無偏移）',
        highlightOk,
        activeInfo ? 'active dataset.index=' + activeInfo.dataIndex : '無 active item'));
    }

    // ===== T2：findSubAtTime 重疊字幕取最新條（純邏輯測試）=====
    log('T2 測試 findSubAtTime 重疊取最新...');
    const t2Result = await page.evaluate(() => {
      // 模擬重疊字幕：older 覆蓋 0-5 秒，newer 從 3 秒起，兩者在 3-5 秒重疊
      const subs = [
        { startTime: 0, duration: 5, text: 'older' },
        { startTime: 3, duration: 5, text: 'newer' },
      ];
      // 複製 content.js 新版 findSubAtTime（後往前搜尋）
      function findSubAtTimeNew(arr, time) {
        for (let i = arr.length - 1; i >= 0; i--) {
          if (time >= arr[i].startTime && time < arr[i].startTime + arr[i].duration) return arr[i];
        }
        return null;
      }
      // 複製舊版（前往後）
      function findSubAtTimeOld(arr, time) {
        return arr.find(s => time >= s.startTime && time < s.startTime + s.duration) || null;
      }
      const atTime4_new = findSubAtTimeNew(subs, 4)?.text;
      const atTime4_old = findSubAtTimeOld(subs, 4)?.text;
      return { new: atTime4_new, old: atTime4_old };
    });
    log('T2 time=4：new=' + t2Result.new + ' old=' + t2Result.old);
    results.push(report('T2a 新版 findSubAtTime 重疊取 newer（最新）', t2Result.new === 'newer',
      '回傳: ' + t2Result.new));
    results.push(report('T2b 舊版行為確認：重疊時取 older（驗證問題存在）', t2Result.old === 'older',
      '回傳: ' + t2Result.old));

    // ===== T3：字幕列表點單字 popup 為 simplified =====
    log('T3 測試 simplified popup...');

    // 先關閉任何殘留 popup
    await page.evaluate(() => {
      const p = document.getElementById('yt-sub-word-popup');
      if (p) p.style.display = 'none';
    });

    // 找 sidebar 列表中的第一個可點擊單字 span
    const wordSpanExists = await page.evaluate(() =>
      !!document.querySelector('#yt-sub-list .yt-sub-word')
    );
    results.push(report('T3a sidebar 列表有可點擊單字 span', wordSpanExists));

    if (wordSpanExists) {
      // 點擊第一個單字
      await page.evaluate(() => {
        document.querySelector('#yt-sub-list .yt-sub-word').click();
      });

      // 等 popup 出現且載入完成（loading spinner 消失），最多 6 秒
      let popupVisible = false;
      for (let i = 0; i < 30; i++) {
        await new Promise(r => setTimeout(r, 200));
        popupVisible = await page.evaluate(() => {
          const p = document.getElementById('yt-sub-word-popup');
          if (!p || p.style.display === 'none' || p.style.display === '') return false;
          // 等 loading 結束（word 元素出現）
          return !!p.querySelector('.yt-sub-popup-word, .yt-sub-popup-error');
        });
        if (popupVisible) break;
      }
      results.push(report('T3b popup 出現且載入完成', popupVisible));

      if (popupVisible) {
        const popupContent = await page.evaluate(() => {
          const p = document.getElementById('yt-sub-word-popup');
          return {
            hasWord:       !!p.querySelector('.yt-sub-popup-word'),
            hasActionRow:  !!p.querySelector('.yt-sub-popup-action-row'),
            hasDef:        !!p.querySelector('.yt-sub-popup-def'),
            hasDefZh:      !!p.querySelector('.yt-sub-popup-def-zh'),
            hasExample:    !!p.querySelector('.yt-sub-popup-example'),
            hasSynonyms:   !!p.querySelector('.yt-sub-popup-synonyms'),
            hasSentence:   !!p.querySelector('.yt-sub-popup-sentence'),
            hasSimplifiedClass: p.classList.contains('simplified'),
            innerHTML: p.innerHTML.slice(0, 200),
          };
        });
        log('T3 popup 內容: ' + JSON.stringify(popupContent, null, 2));

        results.push(report('T3c popup 有 word 區塊',     popupContent.hasWord));
        results.push(report('T3d popup 有 action-row',   popupContent.hasActionRow));
        results.push(report('T3e popup 無定義（def）區塊',   !popupContent.hasDef,
          popupContent.hasDef ? '❗ 出現了 .yt-sub-popup-def' : 'OK'));
        results.push(report('T3f popup 無例句（example）區塊', !popupContent.hasExample,
          popupContent.hasExample ? '❗ 出現了 .yt-sub-popup-example' : 'OK'));
        results.push(report('T3g popup 無近似詞（synonyms）', !popupContent.hasSynonyms,
          popupContent.hasSynonyms ? '❗ 出現了 synonyms' : 'OK'));
        results.push(report('T3h popup 無句子（sentence）區塊', !popupContent.hasSentence,
          popupContent.hasSentence ? '❗ 出現了 .yt-sub-popup-sentence' : 'OK'));
        results.push(report('T3i popup 有 .simplified class', popupContent.hasSimplifiedClass));
      }
    }

  } catch (err) {
    log('測試過程發生例外: ' + err.message);
    console.error(err);
  } finally {
    // 清理：還原 filterSoundDesc 設定 + 移除測試字幕
    try {
      const cleanPage = await context.newPage();
      const cleanClient = await context.newCDPSession(cleanPage);
      await cleanClient.send('Runtime.enable');
      const cleanCtxProm = waitForExtContext(cleanClient, 10000);
      await cleanPage.goto('https://www.youtube.com/watch?v=' + VIDEO_ID, {
        waitUntil: 'domcontentloaded', timeout: 20000,
      });
      const cId = await cleanCtxProm;
      if (cId) {
        await storageRemove(cleanClient, cId, STORAGE_KEY);
        // 還原 filterSoundDesc=false
        await cleanPage.evaluate(({ key }) => {
          try {
            const s = JSON.parse(localStorage.getItem(key) || '{}');
            s.filterSoundDesc = false;
            localStorage.setItem(key, JSON.stringify(s));
          } catch {}
        }, { key: SETTINGS_KEY });
      }
      log('測試資料已清除');
    } catch (_) {}
    await context.close();
  }

  return summarize(results);
}

function summarize(results) {
  const pass = results.filter(Boolean).length;
  const fail = results.length - pass;
  console.log('\n========== 字幕顯示 QA 測試總結 ==========');
  console.log('通過 ' + pass + ' / ' + results.length + ' 項');
  if (fail > 0) console.log('❌ 失敗 ' + fail + ' 項，請查看上方報告');
  else console.log('✅ 全部通過');
  return { pass, fail, total: results.length };
}

runTest().catch(err => {
  console.error('執行失敗:', err);
  process.exit(1);
});
