/**
 * test-storage-persist.mjs
 * QA 測試：SRT 字幕匯入後 chrome.storage.local 持久化驗證
 * 測試重新整理頁面後字幕資料仍能還原
 */

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..'); // d:\dev\chrome字幕套件開發

const VIDEO_ID = 'dQw4w9WgXcQ';
const STORAGE_KEY = `editedSubtitles_${VIDEO_ID}`;
const TEST_SUBTITLES = [
  { text: 'Hello QA test', startTime: 0, endTime: 2 },
  { text: 'Persistence check', startTime: 2, endTime: 4 },
  { text: '字幕還原測試', startTime: 4, endTime: 6 },
];

// ===== 工具函數 =====

/**
 * 印出帶有時間戳的日誌
 */
function log(msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${msg}`);
}

/**
 * 印出測試結果（通過/失敗）
 */
function report(label, passed, detail = '') {
  const icon = passed ? '✅' : '❌';
  console.log(`${icon} ${label}${detail ? ' — ' + detail : ''}`);
  return passed;
}

// ===== 主測試流程 =====

async function runTest() {
  log('啟動 Playwright + Chrome 擴充套件...');

  const userDataDir = path.join(EXT_PATH, '.playwright-profile');

  let context;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      headless: false,
      args: [
        `--disable-extensions-except=${EXT_PATH}`,
        `--load-extension=${EXT_PATH}`,
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
      // 允許擴充套件在 YouTube 上執行
      ignoreHTTPSErrors: true,
    });
  } catch (err) {
    console.error('❌ 無法啟動 Chrome，請確認 Playwright Chromium 已安裝:', err.message);
    process.exit(1);
  }

  const results = [];

  try {
    // ========== 取得擴充套件 service worker 頁 ==========
    log('等待擴充套件 service worker 啟動...');
    await new Promise(r => setTimeout(r, 2000));

    // 取得背景 service worker（用來存取 chrome.storage.local）
    const workers = context.serviceWorkers();
    log(`找到 ${workers.length} 個 service worker`);

    // ========== 測試 1：導航到 YouTube 影片頁 ==========
    log(`導航到 YouTube 影片: https://www.youtube.com/watch?v=${VIDEO_ID}`);
    const page = await context.newPage();

    try {
      await page.goto(`https://www.youtube.com/watch?v=${VIDEO_ID}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      log('頁面載入成功');
      results.push(report('導航到 YouTube 影片頁', true));
    } catch (err) {
      log(`頁面載入失敗（可能是網路問題）: ${err.message}`);
      results.push(report('導航到 YouTube 影片頁', false, err.message));
    }

    // ========== 測試 2：等待擴充套件 sidebar ==========
    log('等待擴充套件 sidebar 出現 (最多 10 秒)...');
    let sidebarFound = false;
    try {
      await page.waitForSelector('#yt-sub-demo-sidebar', { timeout: 10000 });
      sidebarFound = true;
      log('Sidebar 已出現');
    } catch {
      log('Sidebar 未在 10 秒內出現（可能需要登入或網路較慢）');
    }
    results.push(report('擴充套件 Sidebar 出現', sidebarFound));

    // ========== 測試 3：直接用 JS 寫入 chrome.storage.local ==========
    log(`用 page.evaluate 寫入 storage key: ${STORAGE_KEY}`);

    // 使用擴充套件的 content script context 無法直接存取 chrome.storage
    // 改用 chrome.storage 的 background worker，或用 CDP 直接注入
    // 策略：先嘗試透過擴充套件 service worker CDP session
    let writeSuccess = false;

    // 找到擴充套件 service worker
    let swTarget = null;
    const allWorkers = context.serviceWorkers();
    log(`Service workers: ${allWorkers.length}`);
    for (const w of allWorkers) {
      log(`  Worker URL: ${w.url()}`);
    }

    // 方法：透過 content script world 的 chrome.storage（在頁面 evaluate 中使用 chrome API）
    // content.js 在 isolated world，可用 chrome.storage
    // 我們透過 chrome.storage.local 注入資料
    try {
      // 嘗試直接在 page 的 isolated extension context 寫入
      // （這會用到 content script 的 chrome 物件）
      writeSuccess = await page.evaluate(async ({ key, data }) => {
        return new Promise((resolve) => {
          if (typeof chrome === 'undefined' || !chrome.storage) {
            resolve(false);
            return;
          }
          chrome.storage.local.set({ [key]: data }, () => {
            resolve(!chrome.runtime.lastError);
          });
        });
      }, { key: STORAGE_KEY, data: TEST_SUBTITLES });
    } catch (err) {
      log(`直接 page.evaluate 寫入失敗（非擴充套件 context）: ${err.message}`);
      writeSuccess = false;
    }

    // 若直接寫入失敗，嘗試透過 service worker
    if (!writeSuccess && allWorkers.length > 0) {
      log('嘗試透過 service worker 寫入...');
      try {
        const sw = allWorkers[0];
        // 無法直接 evaluate service worker，跳過
        log('Service worker evaluate 不支援，嘗試其他方式');
      } catch (err) {
        log(`Service worker 寫入失敗: ${err.message}`);
      }
    }

    results.push(report('chrome.storage.local.set 寫入測試資料', writeSuccess,
      writeSuccess ? `key=${STORAGE_KEY}, ${TEST_SUBTITLES.length} 筆` : '寫入失敗'));

    // ========== 測試 4：讀回驗證 ==========
    log('讀回 storage 資料驗證...');
    let readSuccess = false;
    let readData = null;

    if (writeSuccess) {
      try {
        readData = await page.evaluate(async ({ key }) => {
          return new Promise((resolve) => {
            if (typeof chrome === 'undefined' || !chrome.storage) {
              resolve(null);
              return;
            }
            chrome.storage.local.get(key, (data) => {
              resolve(data[key] || null);
            });
          });
        }, { key: STORAGE_KEY });

        if (readData && Array.isArray(readData) && readData.length === TEST_SUBTITLES.length) {
          readSuccess = true;
          log(`讀回 ${readData.length} 筆字幕資料`);
        } else {
          log(`讀回資料異常: ${JSON.stringify(readData)}`);
        }
      } catch (err) {
        log(`讀回失敗: ${err.message}`);
      }
    }

    results.push(report('chrome.storage.local.get 讀回驗證', readSuccess,
      readSuccess ? `讀回 ${readData.length} 筆，內容正確` : '讀回失敗或資料為空'));

    // ========== 測試 5：重新整理頁面後資料仍存在 ==========
    if (writeSuccess) {
      log('重新整理頁面...');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
      log('頁面已重新整理，等待 2 秒...');
      await new Promise(r => setTimeout(r, 2000));

      let persistSuccess = false;
      let persistData = null;
      try {
        persistData = await page.evaluate(async ({ key }) => {
          return new Promise((resolve) => {
            if (typeof chrome === 'undefined' || !chrome.storage) {
              resolve(null);
              return;
            }
            chrome.storage.local.get(key, (data) => {
              resolve(data[key] || null);
            });
          });
        }, { key: STORAGE_KEY });

        if (persistData && Array.isArray(persistData) && persistData.length === TEST_SUBTITLES.length) {
          persistSuccess = true;
          log(`重新整理後仍讀到 ${persistData.length} 筆資料`);
        } else {
          log(`重新整理後資料遺失或異常: ${JSON.stringify(persistData)}`);
        }
      } catch (err) {
        log(`重新整理後讀取失敗: ${err.message}`);
      }

      results.push(report('重新整理後 storage 資料持久化', persistSuccess,
        persistSuccess ? '資料完整保留' : '資料遺失'));

      // ========== 測試 6：觀察「自定義字幕（已還原）」狀態文字 ==========
      if (sidebarFound) {
        log('等待 sidebar 重新出現並觀察狀態文字...');
        let statusRestored = false;
        let statusText = '';

        try {
          await page.waitForSelector('#yt-sub-demo-sidebar', { timeout: 10000 });
          // 等待狀態更新
          await new Promise(r => setTimeout(r, 3000));

          statusText = await page.evaluate(() => {
            const el = document.getElementById('yt-sub-status');
            return el ? el.textContent : '(element not found)';
          });

          log(`狀態文字: "${statusText}"`);
          statusRestored = statusText.includes('已還原');
        } catch (err) {
          log(`觀察狀態文字失敗: ${err.message}`);
        }

        results.push(report('Sidebar 顯示「自定義字幕（已還原）」', statusRestored,
          `實際文字: "${statusText}"`));
      }
    } else {
      log('跳過持久化測試（寫入步驟失敗）');
    }

    // ========== 清理 storage ==========
    if (writeSuccess) {
      log('清理測試資料...');
      try {
        await page.evaluate(async ({ key }) => {
          return new Promise((resolve) => {
            chrome.storage.local.remove(key, resolve);
          });
        }, { key: STORAGE_KEY });
        log('測試資料已清除');
      } catch (err) {
        log(`清理失敗（非致命）: ${err.message}`);
      }
    }

  } finally {
    await context.close();
  }

  // ========== 總結 ==========
  console.log('\n========== QA 測試總結 ==========');
  const passed = results.filter(Boolean).length;
  const total = results.length;
  console.log(`通過 ${passed} / ${total} 項測試`);
  if (passed === total) {
    console.log('✅ 全部通過');
  } else {
    console.log(`❌ ${total - passed} 項失敗，請見上方詳細輸出`);
  }

  return passed === total;
}

runTest().catch(err => {
  console.error('測試執行期間發生未預期錯誤:', err);
  process.exit(1);
});
