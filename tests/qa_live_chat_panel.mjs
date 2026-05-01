/**
 * qa_live_chat_panel.mjs
 * Playwright 測試：直播聊天室 panel 隱藏與還原
 *
 * 驗證項目：
 *   1. sidebar 展開 → chat panel display=none
 *   2. sidebar 展開 → ytd-watch-flexy 無 chat_ 屬性（影片欄正確填滿）
 *   3. sidebar 展開 → #primary 寬度接近全寬（扣側邊欄 360px）
 *   4. sidebar 收合 → chat panel display 還原
 *   5. sidebar 收合 → ytd-watch-flexy chat_ 屬性還原
 *   6. 連續展開→收合冪等不崩潰
 *   7. 換頁後 _chatPanelHidden 旗標重置
 *
 * 執行方式：node tests/qa_live_chat_panel.mjs
 */

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH     = path.resolve(__dirname, '..');
const PROFILE_PATH = path.resolve(__dirname, '..', '.playwright-profile');

const VIDEO_URL = 'https://www.youtube.com/watch?v=Pi7Pq-EcK5w';

const CHAT_PANEL_SEL = [
  '#chat-container',
  'ytd-live-chat-frame',
  'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-live-chat-replay"]',
  'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-chat-replay"]',
].join(', ');

function log(msg) {
  console.log('[' + new Date().toLocaleTimeString() + '] ' + msg);
}

function report(results, label, passed, detail) {
  const icon = passed ? '✅' : '❌';
  console.log(icon + ' ' + label + (detail ? ' — ' + detail : ''));
  results.push(passed);
  return passed;
}

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

async function getSidebarState(page) {
  return page.evaluate(function() {
    const s = document.getElementById('yt-sub-demo-sidebar');
    if (!s) return 'missing';
    return s.classList.contains('sidebar-collapsed') ? 'collapsed' : 'expanded';
  }).catch(function() { return 'missing'; });
}

async function getChatPanelDisplay(page, sel) {
  return page.evaluate(function(s) {
    const el = document.querySelector(s);
    if (!el) return null;
    return el.style.display || '';
  }, sel).catch(function() { return null; });
}

async function listEngagementPanels(page) {
  return page.evaluate(function() {
    return Array.from(document.querySelectorAll('ytd-engagement-panel-section-list-renderer'))
      .map(function(el) { return el.getAttribute('target-id') || '(no id)'; });
  }).catch(function() { return []; });
}

async function waitForSidebarState(page, target, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (await getSidebarState(page) === target) return true;
    await new Promise(function(r) { setTimeout(r, 400); });
  }
  return false;
}

async function ensureSidebarState(page, target) {
  const current = await getSidebarState(page);
  log('  sidebar: ' + current + ' → ' + target);
  if (current === target) return true;
  await page.evaluate(function() {
    const ball = document.getElementById('yt-sub-ball');
    if (ball) ball.click();
  });
  return waitForSidebarState(page, target, 6000);
}

/** 讀取 ytd-watch-flexy 的 chat_ 屬性狀態 */
async function getChatAttr(page) {
  return page.evaluate(function() {
    const flexy = document.querySelector('ytd-watch-flexy');
    if (!flexy) return null;
    return flexy.hasAttribute('chat_');
  }).catch(function() { return null; });
}

/** 讀取 #primary 的像素寬度 */
async function getPrimaryWidth(page) {
  return page.evaluate(function() {
    const el = document.querySelector('#primary');
    if (!el) return null;
    return Math.round(el.getBoundingClientRect().width);
  }).catch(function() { return null; });
}

/** 讀取 #columns 的像素寬度（flex container，#primary 填滿它即正確） */
async function getColumnsWidth(page) {
  return page.evaluate(function() {
    const el = document.querySelector('#columns');
    if (!el) return null;
    return Math.round(el.getBoundingClientRect().width);
  }).catch(function() { return null; });
}

// ===== 主流程 =====
async function runTest() {
  log('啟動 Playwright + Chrome 擴充套件...');

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

    // ── 1. 導航 ──────────────────────────────────────────────
    log('導航到 ' + VIDEO_URL);
    const extCtxPromise = waitForExtContext(client, 25000);
    try {
      await page.goto(VIDEO_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
      report(results, '導航到直播紀錄影片', true);
    } catch (err) {
      report(results, '導航到直播紀錄影片', false, err.message);
      await context.close(); process.exit(1);
    }

    // ── 2. Extension context ──────────────────────────────────
    const ctxId = await extCtxPromise;
    report(results, 'Extension isolated world 取得', !!ctxId,
      ctxId ? 'contextId=' + ctxId : '未找到');
    if (!ctxId) { printSummary(results); await context.close(); return; }

    // ── 3. 在 extension 自動展開之前，先抓 YouTube 原始的 chat_ 狀態 ──────
    // 等 ytd-watch-flexy 出現（YouTube 本體初始化），但不等 extension 展開 sidebar
    log('等待 ytd-watch-flexy 出現（最多 10 秒）...');
    let chatAttrBaseline = null;
    try {
      await page.waitForSelector('ytd-watch-flexy', { timeout: 10000 });
      chatAttrBaseline = await getChatAttr(page);
      log('YouTube 原始 chat_ 屬性: ' + chatAttrBaseline);
    } catch (_) {
      log('ytd-watch-flexy 未出現，繼續...');
    }

    // ── 4. Ball 出現（extension 已初始化） ─────────────────────
    let ballFound = false;
    try { await page.waitForSelector('#yt-sub-ball', { timeout: 15000 }); ballFound = true; }
    catch (_) {}
    report(results, '#yt-sub-ball 出現', ballFound, ballFound ? 'OK' : '15 秒未出現');
    if (!ballFound) { printSummary(results); await context.close(); return; }

    // 確保 sidebar 收合，等頁面穩定
    log('確保 sidebar 收合...');
    await ensureSidebarState(page, 'collapsed');
    await new Promise(function(r) { setTimeout(r, 1500); });

    const panels = await listEngagementPanels(page);
    log('engagement panels: ' + (panels.length ? panels.join(', ') : '（無）'));

    const hasChatPanel = await getChatPanelDisplay(page, CHAT_PANEL_SEL) !== null;
    log('Chat panel: ' + (hasChatPanel ? '找到' : '未找到（無聊天室重播）'));

    // 若 baseline 未取得（timing 問題），用收合後的狀態補
    if (chatAttrBaseline === null) {
      chatAttrBaseline = await getChatAttr(page);
      log('補抓 chat_ baseline（收合後）: ' + chatAttrBaseline);
    }

    const primaryWidthBaseline = await getPrimaryWidth(page);
    log('收合時 #primary 寬度: ' + primaryWidthBaseline + 'px');

    // ── 6. 展開 sidebar ───────────────────────────────────────
    log('展開 sidebar...');
    const expandOk = await ensureSidebarState(page, 'expanded');
    await new Promise(function(r) { setTimeout(r, 800); });
    report(results, 'Sidebar 展開成功', expandOk,
      expandOk ? 'state=expanded' : '逾時');

    if (hasChatPanel) {
      // 6a. chat panel 被隱藏
      const dispExpand = await getChatPanelDisplay(page, CHAT_PANEL_SEL);
      report(results, '展開後 chat panel display=none', dispExpand === 'none',
        'display="' + dispExpand + '"');

      // 6b. chat_ 屬性被移除（影片欄位填滿的關鍵）
      const chatAttrExpand = await getChatAttr(page);
      report(results, '展開後 ytd-watch-flexy 無 chat_ 屬性（影片欄填滿）',
        chatAttrExpand === false,
        'chat_=' + chatAttrExpand);

      // 6c. #primary 填滿 #columns（chat 隱藏後整個 flex container 應給 primary 用）
      // 展開後 sidebar 佔 360px，columns 變窄，所以不能拿 collapsed baseline 比
      // 正確標準：primary 應接近 columns 寬度（兩者差距不超過 50px margin/padding）
      const primaryWidthExpand = await getPrimaryWidth(page);
      const colsWidthExpand = await getColumnsWidth(page);
      const gapToColumns = (primaryWidthExpand && colsWidthExpand)
        ? colsWidthExpand - primaryWidthExpand : null;
      // primary 應填滿 columns（允許 50px margin/padding 差距）
      const widthOk = gapToColumns !== null && gapToColumns <= 50;
      report(results, '展開後 #primary 填滿 #columns（聊天室空間已釋放）',
        widthOk,
        '#columns=' + colsWidthExpand + 'px, #primary=' + primaryWidthExpand + 'px (gap=' + gapToColumns + 'px)');

      // 6d. #panels-full-bleed-container 不可視覺遮蓋 #primary
      // 若 display 不是 none，它的黑色區塊會疊在影片右側（寬度驗證無法偵測此問題）
      const panelsFullDisplay = await page.evaluate(function() {
        const el = document.querySelector('#panels-full-bleed-container');
        if (!el) return 'not-found';
        return el.style.display || window.getComputedStyle(el).display || '';
      }).catch(function() { return 'error'; });
      report(results, '展開後 #panels-full-bleed-container 已隱藏（無黑色遮罩）',
        panelsFullDisplay === 'none' || panelsFullDisplay === 'not-found',
        'display="' + panelsFullDisplay + '"');
    } else {
      log('  （無 chat panel，跳過隱藏/寬度驗證）');
    }

    // ── 7. 收合 sidebar ───────────────────────────────────────
    log('收合 sidebar...');
    const collapseOk = await ensureSidebarState(page, 'collapsed');
    await new Promise(function(r) { setTimeout(r, 800); });
    report(results, 'Sidebar 收合成功', collapseOk,
      collapseOk ? 'state=collapsed' : '逾時');

    if (hasChatPanel) {
      // 7a. chat panel 還原
      const dispCollapse = await getChatPanelDisplay(page, CHAT_PANEL_SEL);
      report(results, '收合後 chat panel 顯示還原（非 none）',
        dispCollapse !== null && dispCollapse !== 'none',
        'display="' + dispCollapse + '"');

      // 7b. chat_ 屬性：只有原本有 chat_ 的頁面才應被還原（與 baseline 一致）
      const chatAttrCollapse = await getChatAttr(page);
      report(results, '收合後 ytd-watch-flexy chat_ 與 baseline 一致（正確還原）',
        chatAttrCollapse === chatAttrBaseline,
        'baseline=' + chatAttrBaseline + ' → collapse=' + chatAttrCollapse);
    } else {
      log('  （無 chat panel，跳過還原驗證）');
    }

    // ── 8. 冪等性 ─────────────────────────────────────────────
    log('冪等性驗證（再次展開→收合）...');
    const exp2 = await ensureSidebarState(page, 'expanded');
    await new Promise(function(r) { setTimeout(r, 400); });
    const col2 = await ensureSidebarState(page, 'collapsed');
    await new Promise(function(r) { setTimeout(r, 400); });
    report(results, '連續展開→收合不崩潰（冪等）', exp2 && col2,
      exp2 && col2 ? '成功' : '失敗');

    // ── 9. 換頁旗標重置 ───────────────────────────────────────
    log('換頁驗證 _chatPanelHidden 重置...');
    const extCtx2 = waitForExtContext(client, 15000);
    await page.goto('https://www.youtube.com/watch?v=dQw4w9WgXcQ',
      { waitUntil: 'domcontentloaded', timeout: 30000 });
    const ctxId2 = await extCtx2;
    await new Promise(function(r) { setTimeout(r, 1500); });
    if (ctxId2) {
      const flagRes = await client.send('Runtime.evaluate', {
        expression: '(typeof _chatPanelHidden !== "undefined") ? String(_chatPanelHidden) : "undefined"',
        contextId: ctxId2, returnByValue: true,
      }).catch(function() { return { result: { value: 'error' } }; });
      const flag = flagRes.result && flagRes.result.value;
      report(results, '換頁後 _chatPanelHidden 重置', flag === 'false' || flag === 'undefined',
        '_chatPanelHidden=' + flag);
    }

  } finally {
    await context.close();
  }

  printSummary(results);
}

function printSummary(results) {
  console.log('\n' + '='.repeat(52));
  const passed = results.filter(Boolean).length;
  const failed = results.length - passed;
  console.log('結果：' + passed + ' 通過 / ' + failed + ' 失敗 / ' + results.length + ' 總計');
  if (failed === 0) {
    console.log('✅ 全部通過 — 直播聊天室 panel 隱藏/還原邏輯確認');
    process.exitCode = 0;
  } else {
    console.log('❌ 有測試失敗，請檢查上方錯誤');
    process.exitCode = 1;
  }
}

runTest().catch(function(err) {
  console.error('未預期錯誤:', err);
  process.exit(1);
});
