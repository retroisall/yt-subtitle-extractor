/**
 * qa_wordbook_highlight.mjs
 * QA Playwright 功能測試：生字本單字高亮功能驗證
 *
 * 測試流程：
 * 1. 啟動 Playwright + Chrome 擴充套件（headless: false）
 * 2. 導航到 YouTube 影片（Gangnam Style，有英文字幕）
 * 3. 等待 extension isolated world context（名稱 "YouTube Learning Bar (DEV)"）
 * 4. 等待側邊欄載入（#yt-sub-demo-sidebar 出現）
 * 5. 用 CDP chrome.storage.local.set 預先寫入已知單字 "style" 到生字本
 * 6. 重新整理頁面，等待 extension context 重建
 * 7. 等待字幕列表渲染（#yt-sub-list 有子元素）
 * 8. 驗證 1：#yt-sub-list 中有 .yt-sub-word--saved span，且 dataset.token 為 "style"（大小寫不拘）
 * 9. 清理 storage（移除 yt_sub_saved_words）
 * 10. 重新整理頁面，等待字幕重新渲染
 * 11. 驗證 2：清理後無 .yt-sub-word--saved
 */

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..');
const PROFILE_PATH = path.resolve(__dirname, '..', '.playwright-profile');

const VIDEO_ID = '9bZkp7q19f0';
const SAVED_WORDS_KEY = 'yt_sub_saved_words';
// Gangnam Style 的 primary 字幕是韓文，但有英文 token "Ah"
// patchSavedWordHighlights 比對 _savedWordSet.has(token.toLowerCase())
// 所以生字本必須用小寫 "ah" 作為 word，才能匹配
const TARGET_WORD = 'Ah';        // 字幕 span 中的 dataset.token（原始大小寫）
const TARGET_WORD_LC = 'ah';     // 存入生字本的 word key（小寫，供高亮比對）

/** 生字本測試資料：寫入 "ah" 這個單字（小寫，匹配高亮比對邏輯） */
const TEST_SAVED_WORDS = {
  ah: {
    word: TARGET_WORD_LC,
    addedAt: Date.now(),
    count: 1,
    tier: null,
    tierFetched: false,
    noDefinition: false,
    wordZh: '',
    definitionZh: '',
    context: '',
    contextZh: '',
    videoId: VIDEO_ID,
    startTime: 0,
  },
};

// 儲存單字時 saveWord() 會將 token lemmatize/lowercase 後存入
// 例如 token "Ah" → word "ah"，高亮比對時用 token.toLowerCase() = "ah"

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
 * @param {object} client - CDP session
 * @param {number} timeout - 最長等待毫秒數
 * @returns {Promise<number|null>} contextId 或 null
 */
function waitForExtContext(client, timeout) {
  return new Promise(function (resolve) {
    const timer = setTimeout(function () {
      resolve(null);
    }, timeout);
    client.on('Runtime.executionContextCreated', function (event) {
      if (event.context.name === 'YouTube Learning Bar (DEV)') {
        clearTimeout(timer);
        resolve(event.context.id);
      }
    });
  });
}

/**
 * 在 extension isolated world 執行 chrome.storage.local.set
 * @param {object} client - CDP session
 * @param {number} ctxId - extension context ID
 * @param {string} key - storage key
 * @param {any} value - 要寫入的值
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
    throw new Error(
      r.exceptionDetails.exception.description || 'storage.set failed'
    );
  }
  return r.result.value === true;
}

/**
 * 在 extension isolated world 執行 chrome.storage.local.remove（清理用）
 * @param {object} client - CDP session
 * @param {number} ctxId - extension context ID
 * @param {string} key - 要移除的 storage key
 */
async function storageRemove(client, ctxId, key) {
  const keyJson = JSON.stringify(key);
  const expr =
    'new Promise(function(res) { chrome.storage.local.remove(' +
    keyJson +
    ', res); })';
  await client.send('Runtime.evaluate', {
    expression: expr,
    contextId: ctxId,
    awaitPromise: true,
  });
}

/**
 * 輪詢等待指定選擇器對應元素的子元素數量 > 0
 * @param {object} page - Playwright Page
 * @param {string} selector - CSS 選擇器
 * @param {number} maxMs - 最長等待毫秒數
 * @param {number} interval - 輪詢間隔毫秒數
 * @returns {Promise<boolean>} 是否在時限內出現
 */
async function pollForChildren(page, selector, maxMs, interval) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise(function (r) {
      setTimeout(r, interval || 500);
    });
    const count = await page
      .evaluate(function (sel) {
        const el = document.querySelector(sel);
        return el ? el.children.length : 0;
      }, selector)
      .catch(function () {
        return 0;
      });
    if (count > 0) {
      log(selector + ' 已有 ' + count + ' 個子元素');
      return true;
    }
  }
  return false;
}

/**
 * 輪詢等待側邊欄出現（#yt-sub-demo-sidebar）
 * @param {object} page - Playwright Page
 * @param {number} maxMs - 最長等待毫秒數
 */
async function pollForSidebar(page, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise(function (r) {
      setTimeout(r, 500);
    });
    const found = await page
      .evaluate(function () {
        return !!document.getElementById('yt-sub-demo-sidebar');
      })
      .catch(function () {
        return false;
      });
    if (found) return true;
  }
  return false;
}

/**
 * 輪詢等待 .yt-sub-word span 出現在 #yt-sub-list 中
 * @param {object} page - Playwright Page
 * @param {number} maxMs - 最長等待毫秒數
 */
async function pollForWordSpans(page, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await new Promise(function (r) {
      setTimeout(r, 500);
    });
    const count = await page
      .evaluate(function () {
        return document.querySelectorAll('#yt-sub-list .yt-sub-word').length;
      })
      .catch(function () {
        return 0;
      });
    if (count > 0) {
      log('#yt-sub-list .yt-sub-word 已出現 ' + count + ' 個 span');
      return count;
    }
  }
  return 0;
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

    // ===== 1. 導航到 YouTube 影片 =====
    log('導航到 https://www.youtube.com/watch?v=' + VIDEO_ID);
    const extCtxOnLoad = waitForExtContext(client, 20000);
    try {
      await page.goto('https://www.youtube.com/watch?v=' + VIDEO_ID, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      results.push(report('導航到 YouTube Gangnam Style 頁', true));
    } catch (err) {
      results.push(report('導航到 YouTube Gangnam Style 頁', false, err.message));
      printSummary(results);
      await context.close();
      return;
    }

    // ===== 2. 等待 extension isolated world =====
    log('等待 extension isolated world（最多 20 秒）...');
    let ctxId = await extCtxOnLoad;
    log('Extension context ID: ' + ctxId);
    results.push(
      report(
        'Extension isolated world 取得',
        !!ctxId,
        ctxId ? 'contextId=' + ctxId : '未找到 — 擴充套件可能未正確載入'
      )
    );

    if (!ctxId) {
      log('無法取得 extension context，中止測試');
      printSummary(results);
      await context.close();
      return;
    }

    // ===== 3. 等待側邊欄載入 =====
    log('等待 #yt-sub-demo-sidebar 出現（最多 15 秒）...');
    const sidebarFound = await pollForSidebar(page, 15000);
    results.push(
      report(
        '#yt-sub-demo-sidebar 載入',
        sidebarFound,
        sidebarFound ? 'sidebar 已出現' : '15 秒內未出現 sidebar'
      )
    );

    if (!sidebarFound) {
      log('Sidebar 未出現，中止測試');
      printSummary(results);
      await context.close();
      return;
    }

    // ===== 4. 寫入 "style" 到生字本 storage =====
    log('寫入單字 "' + TARGET_WORD + '" 到 chrome.storage.local...');
    let writeOk = false;
    try {
      writeOk = await storageSet(
        client,
        ctxId,
        SAVED_WORDS_KEY,
        TEST_SAVED_WORDS
      );
      results.push(
        report(
          'chrome.storage.local.set 生字本寫入',
          writeOk,
          writeOk ? '單字 "' + TARGET_WORD + '" 已寫入' : '回傳 false'
        )
      );
    } catch (err) {
      results.push(
        report('chrome.storage.local.set 生字本寫入', false, err.message)
      );
    }

    if (!writeOk) {
      log('Storage 寫入失敗，中止測試');
      printSummary(results);
      await context.close();
      return;
    }

    // ===== 5. 重新整理頁面，等待 extension context 重建 =====
    log('重新整理頁面...');
    const extCtxReload = waitForExtContext(client, 20000);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    log('等待 extension context 重建（最多 20 秒）...');
    ctxId = await extCtxReload;
    log('Reload 後 extension context ID: ' + ctxId);
    results.push(
      report(
        'Reload 後 extension isolated world 重建',
        !!ctxId,
        ctxId ? 'contextId=' + ctxId : '未找到'
      )
    );

    if (!ctxId) {
      log('Reload 後 context 未恢復，中止測試');
      printSummary(results);
      await context.close();
      return;
    }

    // ===== 6. 等待字幕列表渲染（最多 20 秒，輪詢 500ms） =====
    log('等待 #yt-sub-list .yt-sub-word 出現（最多 20 秒）...');
    const wordSpanCount = await pollForWordSpans(page, 20000);
    results.push(
      report(
        '#yt-sub-list .yt-sub-word span 渲染',
        wordSpanCount > 0,
        wordSpanCount > 0
          ? wordSpanCount + ' 個 word span 已出現'
          : '20 秒內未找到任何 .yt-sub-word span'
      )
    );

    if (wordSpanCount === 0) {
      log('字幕 span 未出現，中止後續驗證（但繼續清理）');
      // 嘗試清理 storage
      try {
        await storageRemove(client, ctxId, SAVED_WORDS_KEY);
        log('Storage 已清理');
      } catch (e) {
        log('清理失敗（非致命）: ' + e.message);
      }
      printSummary(results);
      await context.close();
      return;
    }

    // ===== 7. 驗證 1：有 .yt-sub-word--saved span，且 dataset.token 為 "style" =====
    // 注意：refreshSavedWordSet() 是非同步的，span 建立後 patchSavedWordHighlights()
    // 才會補打 class，需要多等一點時間讓 storage callback 完成
    log('等待 .yt-sub-word--saved 高亮 class 被套用（最多 5 秒，輪詢 300ms）...');
    {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        await new Promise(function (r) { setTimeout(r, 300); });
        const hasSaved = await page.evaluate(function () {
          return document.querySelectorAll('#yt-sub-list .yt-sub-word--saved').length > 0;
        }).catch(function () { return false; });
        if (hasSaved) {
          log('.yt-sub-word--saved 已出現');
          break;
        }
      }
    }

    log('驗證 1：檢查 .yt-sub-word--saved 存在，且 dataset.token 包含 "style"...');
    const savedCheck = await page
      .evaluate(function (targetWord) {
        const savedSpans = document.querySelectorAll(
          '#yt-sub-list .yt-sub-word--saved'
        );
        if (savedSpans.length === 0) {
          return {
            found: false,
            count: 0,
            reason: '#yt-sub-list 中找不到任何 .yt-sub-word--saved span',
          };
        }
        // 找 dataset.token 為目標單字的 span（大小寫不拘）
        let matchedToken = null;
        for (let i = 0; i < savedSpans.length; i++) {
          const token = (savedSpans[i].dataset.token || '').toLowerCase();
          if (token === targetWord.toLowerCase()) {
            matchedToken = savedSpans[i].dataset.token;
            break;
          }
        }
        return {
          found: matchedToken !== null,
          count: savedSpans.length,
          token: matchedToken,
          reason:
            matchedToken !== null
              ? savedSpans.length +
                ' 個高亮 span，token="' +
                matchedToken +
                '" 符合目標'
              : savedSpans.length +
                ' 個高亮 span，但無 token 為 "' +
                targetWord +
                '" 的 span（tokens: ' +
                Array.from(savedSpans)
                  .map(function (s) {
                    return s.dataset.token;
                  })
                  .join(', ') +
                '）',
        };
      }, TARGET_WORD)
      .catch(function (err) {
        return { found: false, count: 0, reason: err.message };
      });

    results.push(
      report(
        '驗證 1：.yt-sub-word--saved 存在且 token="' + TARGET_WORD + '"',
        savedCheck.found,
        savedCheck.reason
      )
    );

    // ===== 8. 清理 storage（移除生字本資料） =====
    log('清理 storage：移除 "' + SAVED_WORDS_KEY + '"...');
    try {
      await storageRemove(client, ctxId, SAVED_WORDS_KEY);
      log('Storage 清理完成');
    } catch (err) {
      log('清理失敗（非致命）: ' + err.message);
    }

    // ===== 9. 重新整理頁面，等待字幕重新渲染 =====
    log('重新整理頁面（驗證清理後高亮消失）...');
    const extCtxReload2 = waitForExtContext(client, 20000);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    log('等待 extension context 重建（最多 20 秒）...');
    const ctxId3 = await extCtxReload2;
    log('第二次 Reload 後 extension context ID: ' + ctxId3);

    // 等待字幕重新渲染（最多 20 秒）
    log('等待字幕重新渲染（最多 20 秒）...');
    const wordSpanCount2 = await pollForWordSpans(page, 20000);
    log('重渲染後 word span 數量: ' + wordSpanCount2);

    // ===== 10. 驗證 2：清理後無 .yt-sub-word--saved =====
    log('驗證 2：確認清理後無 .yt-sub-word--saved...');
    const noSavedCheck = await page
      .evaluate(function () {
        const savedSpans = document.querySelectorAll(
          '#yt-sub-list .yt-sub-word--saved'
        );
        return {
          count: savedSpans.length,
          tokens: Array.from(savedSpans).map(function (s) {
            return s.dataset.token;
          }),
        };
      })
      .catch(function (err) {
        return { count: -1, tokens: [], error: err.message };
      });

    const noHighlightOk = noSavedCheck.count === 0;
    results.push(
      report(
        '驗證 2：清理後無 .yt-sub-word--saved',
        noHighlightOk,
        noHighlightOk
          ? '確認無高亮 span（字幕渲染 ' + wordSpanCount2 + ' 個 span）'
          : '仍有 ' +
            noSavedCheck.count +
            ' 個高亮 span（tokens: ' +
            noSavedCheck.tokens.join(', ') +
            '）'
      )
    );
  } finally {
    await context.close();
  }

  printSummary(results);
}

/** 印出總結並設定 exit code */
function printSummary(results) {
  console.log('\n========== QA 生字本高亮功能測試總結 ==========');
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
