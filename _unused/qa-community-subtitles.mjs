/**
 * QA 社群字幕功能實機測試腳本
 * 測試 TC-1 ~ TC-4 四個測試案例
 */

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ===== 設定 =====
const EXT_PATH = 'd:\\dev\\chrome字幕套件開發';
const PROFILE_PATH = path.join(EXT_PATH, '.playwright-profile');
const SCREENSHOT_DIR = path.join(EXT_PATH, 'qa-screenshots', 'community');

// 已確認有社群字幕的 videoId
const VIDEO_ID = '9bZkp7q19f0';
const VIDEO_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}`;

// ===== 測試結果追蹤 =====
const results = [];

/**
 * 記錄測試結果
 */
function log(tc, status, msg) {
  const entry = { tc, status, msg };
  results.push(entry);
  const mark = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : 'ℹ️';
  console.log(`[${mark} ${tc}] ${msg}`);
}

/**
 * 輪詢等待條件成立
 */
async function pollUntil(fn, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result !== null && result !== false && result !== undefined) return result;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

/**
 * 主測試流程
 */
async function runTests() {
  console.log('=== 社群字幕 QA 測試開始 ===');
  console.log(`videoId: ${VIDEO_ID}`);
  console.log(`擴充套件路徑: ${EXT_PATH}`);
  console.log(`截圖目錄: ${SCREENSHOT_DIR}`);
  console.log('');

  let context;
  let page;

  try {
    // 啟動 persistent context 並載入擴充套件
    context = await chromium.launchPersistentContext(PROFILE_PATH, {
      headless: false,
      args: [
        `--disable-extensions-except=${EXT_PATH}`,
        `--load-extension=${EXT_PATH}`,
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
      viewport: { width: 1280, height: 720 },
    });

    // 取得或建立分頁
    const pages = context.pages();
    page = pages.length > 0 ? pages[0] : await context.newPage();

    log('SETUP', 'INFO', `瀏覽器啟動成功，導航至 ${VIDEO_URL}`);

    // =========================================
    // TC-1：社群字幕按鈕解鎖
    // =========================================
    console.log('\n--- TC-1：社群字幕按鈕解鎖 ---');

    await page.goto(VIDEO_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    log('TC-1', 'INFO', '頁面導航完成');

    // 等待 sidebar 出現（最多 15 秒）
    const sidebar = await page.waitForSelector('#yt-sub-demo-sidebar', {
      timeout: 15000,
      state: 'attached',
    }).catch(() => null);

    if (!sidebar) {
      log('TC-1', 'FAIL', 'sidebar (#yt-sub-demo-sidebar) 未在 15 秒內出現');
      await page.screenshot({ path: `${SCREENSHOT_DIR}/tc1-sidebar-missing.png` });
      throw new Error('TC-1 失敗：sidebar 不存在');
    }
    log('TC-1', 'INFO', 'sidebar 已出現');

    // 等待 community option 文字包含數字（最多 8 秒輪詢）
    const communityOptionText = await pollUntil(async () => {
      const text = await page.evaluate(() => {
        const opt = document.querySelector('option[value="community"]');
        if (!opt) return null;
        // 檢查是否含有括號數字格式
        if (/\(\d+\)/.test(opt.textContent)) return opt.textContent;
        return null;
      });
      return text;
    }, 8000);

    if (!communityOptionText) {
      // 取得目前的 option 文字供除錯
      const currentText = await page.evaluate(() => {
        const opt = document.querySelector('option[value="community"]');
        return opt ? opt.textContent : '（找不到 option）';
      });
      log('TC-1', 'FAIL', `community option 未在 8 秒內顯示數量。目前文字：「${currentText}」`);
      await page.screenshot({ path: `${SCREENSHOT_DIR}/tc1-option-not-updated.png` });
    } else {
      // 驗證 disabled 屬性
      const isDisabled = await page.evaluate(() => {
        const opt = document.querySelector('option[value="community"]');
        return opt ? opt.disabled : true;
      });

      if (isDisabled) {
        log('TC-1', 'FAIL', `community option 有數字「${communityOptionText}」但 disabled 仍為 true`);
        await page.screenshot({ path: `${SCREENSHOT_DIR}/tc1-still-disabled.png` });
      } else {
        // 驗證數字 > 0
        const match = communityOptionText.match(/\((\d+)\)/);
        const count = match ? parseInt(match[1]) : 0;
        if (count > 0) {
          log('TC-1', 'PASS', `community option 已解鎖，顯示「${communityOptionText.trim()}」（N=${count}）`);
        } else {
          log('TC-1', 'FAIL', `community option 數量為 0，文字：「${communityOptionText}」`);
        }
      }
    }

    await page.screenshot({ path: `${SCREENSHOT_DIR}/tc1-result.png` });

    // =========================================
    // TC-2：Picker 顯示
    // =========================================
    console.log('\n--- TC-2：Picker 顯示 ---');

    // 確認 community option 未 disabled 才能繼續
    const canSelectCommunity = await page.evaluate(() => {
      const opt = document.querySelector('option[value="community"]');
      return opt && !opt.disabled;
    });

    if (!canSelectCommunity) {
      log('TC-2', 'FAIL', '無法選擇 community（option 仍 disabled），跳過');
    } else {
      // 選擇 community 選項
      await page.selectOption('#yt-sub-source-select', 'community').catch(async (e) => {
        // 若沒有 select#yt-sub-source-select，改用 evaluate
        await page.evaluate(() => {
          const sel = document.querySelector('#yt-sub-source-select') ||
                      document.querySelector('select');
          if (sel) {
            sel.value = 'community';
            sel.dispatchEvent(new Event('change', { bubbles: true }));
          }
        });
      });
      log('TC-2', 'INFO', '已選擇 community 選項');

      // 等待 picker 出現（最多 5 秒）
      const picker = await page.waitForSelector('#yt-sub-community-picker', {
        timeout: 5000,
        state: 'visible',
      }).catch(() => null);

      if (!picker) {
        log('TC-2', 'FAIL', 'picker (#yt-sub-community-picker) 未在 5 秒內出現');
        await page.screenshot({ path: `${SCREENSHOT_DIR}/tc2-picker-missing.png` });
      } else {
        log('TC-2', 'INFO', 'picker 已出現');

        // 驗證 picker 標題
        const headerText = await page.evaluate(() => {
          const header = document.querySelector('.yt-sub-community-picker-header');
          return header ? header.textContent.trim() : '';
        });
        if (headerText.includes('社群字幕')) {
          log('TC-2', 'PASS', `picker 標題正確：「${headerText}」`);
        } else {
          log('TC-2', 'FAIL', `picker 標題不含「社群字幕」，實際：「${headerText}」`);
        }

        // 驗證清單項目
        const itemCount = await page.evaluate(() => {
          return document.querySelectorAll('ul.yt-sub-community-picker-list li.yt-sub-community-picker-item').length;
        });
        if (itemCount >= 1) {
          log('TC-2', 'PASS', `picker 有 ${itemCount} 個字幕項目`);
        } else {
          log('TC-2', 'FAIL', `picker 清單項目數量為 ${itemCount}（期望 >= 1）`);
        }

        await page.screenshot({ path: `${SCREENSHOT_DIR}/tc2-picker-visible.png` });
      }
    }

    // =========================================
    // TC-3：選擇字幕並套用
    // =========================================
    console.log('\n--- TC-3：選擇字幕並套用 ---');

    const firstItem = await page.$('li.yt-sub-community-picker-item');
    if (!firstItem) {
      log('TC-3', 'FAIL', '找不到 picker item，無法點擊');
      await page.screenshot({ path: `${SCREENSHOT_DIR}/tc3-no-item.png` });
    } else {
      const itemName = await firstItem.evaluate(el => el.querySelector('.yt-sub-community-item-name')?.textContent?.trim() || '未知');
      log('TC-3', 'INFO', `點擊第一個字幕項目：「${itemName}」`);
      // 用 evaluate 直接在頁面 JS 中觸發 click event，繞過 overlay 遮擋問題
      await page.evaluate(() => {
        const item = document.querySelector('li.yt-sub-community-picker-item');
        if (item) item.click();
      });

      // 等待 picker 消失（最多 3 秒）
      const pickerGone = await page.waitForSelector('#yt-sub-community-picker', {
        timeout: 3000,
        state: 'detached',
      }).then(() => true).catch(() => false);

      if (!pickerGone) {
        log('TC-3', 'FAIL', 'picker 點擊後未在 3 秒內消失');
        await page.screenshot({ path: `${SCREENSHOT_DIR}/tc3-picker-not-gone.png` });
      } else {
        log('TC-3', 'INFO', 'picker 已消失');
      }

      // 驗證 overlay 存在
      const overlayExists = await page.evaluate(() => !!document.getElementById('yt-sub-overlay'));
      if (overlayExists) {
        log('TC-3', 'PASS', '#yt-sub-overlay 存在於 DOM');
      } else {
        log('TC-3', 'FAIL', '#yt-sub-overlay 不存在');
      }

      // 驗證 status 文字包含「社群字幕」
      const statusText = await page.evaluate(() => {
        const el = document.getElementById('yt-sub-status');
        return el ? el.textContent.trim() : '';
      });
      if (statusText.includes('社群字幕')) {
        log('TC-3', 'PASS', `#yt-sub-status 顯示：「${statusText}」`);
      } else {
        log('TC-3', 'FAIL', `#yt-sub-status 不含「社群字幕」，實際：「${statusText}」`);
      }

      await page.screenshot({ path: `${SCREENSHOT_DIR}/tc3-overlay-applied.png` });
    }

    // =========================================
    // TC-4：下次自動還原
    // =========================================
    console.log('\n--- TC-4：下次自動還原 ---');

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    log('TC-4', 'INFO', '頁面重新整理完成');

    // 等待 sidebar 出現（最多 15 秒）
    const sidebarAfterReload = await page.waitForSelector('#yt-sub-demo-sidebar', {
      timeout: 15000,
      state: 'attached',
    }).catch(() => null);

    if (!sidebarAfterReload) {
      log('TC-4', 'FAIL', '重整後 sidebar 未在 15 秒內出現');
      await page.screenshot({ path: `${SCREENSHOT_DIR}/tc4-no-sidebar.png` });
    } else {
      log('TC-4', 'INFO', '重整後 sidebar 已出現');

      // 輪詢 8 秒確認 status 包含「社群字幕」
      const autoRestoredStatus = await pollUntil(async () => {
        const text = await page.evaluate(() => {
          const el = document.getElementById('yt-sub-status');
          if (!el) return null;
          return el.textContent.includes('社群字幕') ? el.textContent.trim() : null;
        });
        return text;
      }, 8000);

      if (autoRestoredStatus) {
        log('TC-4', 'PASS', `自動還原成功，#yt-sub-status：「${autoRestoredStatus}」`);
      } else {
        const currentStatus = await page.evaluate(() => {
          const el = document.getElementById('yt-sub-status');
          return el ? el.textContent.trim() : '（找不到 #yt-sub-status）';
        });
        log('TC-4', 'FAIL', `8 秒內未自動還原社群字幕。目前 status：「${currentStatus}」`);
      }

      // 驗證 overlay 存在
      const overlayAfterReload = await page.evaluate(() => !!document.getElementById('yt-sub-overlay'));
      if (overlayAfterReload) {
        log('TC-4', 'PASS', '重整後 #yt-sub-overlay 自動套用');
      } else {
        log('TC-4', 'FAIL', '重整後 #yt-sub-overlay 不存在');
      }

      await page.screenshot({ path: `${SCREENSHOT_DIR}/tc4-auto-restored.png` });
    }

  } catch (err) {
    console.error('\n[FATAL] 測試中斷：', err.message);
    if (page) {
      await page.screenshot({ path: `${SCREENSHOT_DIR}/fatal-error.png` }).catch(() => {});
    }
  } finally {
    if (context) {
      await new Promise(r => setTimeout(r, 2000)); // 讓截圖存完
      await context.close();
    }
  }

  // ===== 測試摘要 =====
  console.log('\n========== 測試摘要 ==========');
  console.log(`Firestore 資料：videoId=${VIDEO_ID}，1 筆 entry（作者：井下花草，字幕名：繁中字幕）`);
  console.log('');
  for (const r of results) {
    const mark = r.status === 'PASS' ? '✅' : r.status === 'FAIL' ? '❌' : 'ℹ️';
    console.log(`${mark} [${r.tc}] ${r.msg}`);
  }

  const passes = results.filter(r => r.status === 'PASS').length;
  const fails  = results.filter(r => r.status === 'FAIL').length;
  console.log(`\n總計：${passes} PASS，${fails} FAIL`);
  console.log(`截圖路徑：${SCREENSHOT_DIR}\\`);
}

runTests().catch(err => {
  console.error('未預期錯誤：', err);
  process.exit(1);
});
