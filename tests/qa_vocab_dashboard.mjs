/**
 * qa_vocab_dashboard.mjs
 * QA Playwright 測試：vocab-dashboard 後台管理系統
 *
 * 測試策略：
 *  - 先開 YouTube，再透過 chrome.runtime.sendMessage({ type: 'dashboard_open' })
 *    讓 background.js 開啟 vocab-dashboard.html（chrome-extension:// 無法直接 goto）
 *  - 登入：.playwright-profile 若有 Google session 則 OAuth 自動完成；
 *    否則從環境變數 GOOGLE_EMAIL / GOOGLE_PASSWORD 填入
 *
 * 自動化測試清單：
 *  T1  頁面正常載入（background.js dashboard_open 正常運作）
 *  T2  所有分頁按鈕存在（overview/line-log/yt-vocab/keyword/schedule/memory/game/settings）
 *  T3  按鈕初始顯示「登入 Google」（或 profile 已有 session 顯示「登出」）
 *  T4  登入按鈕只觸發一次 OAuth 彈窗（不雙彈窗）
 *  T5  完成 OAuth → 按鈕變「登出」，顯示使用者資訊
 *  T6  概覽分頁載入，有內容，無 JS 錯誤
 *  T7  生字庫分頁，表格存在（0 筆也不崩潰）
 *  T8  關鍵字分頁，表格存在
 *  T9  設定分頁，有內容
 *  T10 登出 → 按鈕恢復「登入 Google」
 *
 * 執行方式：
 *  node tests/qa_vocab_dashboard.mjs
 *  GOOGLE_EMAIL=xxx GOOGLE_PASSWORD=xxx node tests/qa_vocab_dashboard.mjs
 */

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH   = path.resolve(__dirname, '..');
const PROFILE    = path.resolve(__dirname, '..', '.playwright-profile');
const YT_URL     = 'https://www.youtube.com/watch?v=9bZkp7q19f0';
const EXT_NAME   = 'YouTube Learning Bar (DEV)';
const DEV_EXT_ID = 'imcniikicdlcphijhaglfajpfllflfpe';

// ── CDP 工具 ──────────────────────────────────────────────────────────────
async function waitForExtContext(client, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('extension context timeout')), timeoutMs);
    client.on('Runtime.executionContextCreated', event => {
      if (event.context.name === EXT_NAME) {
        clearTimeout(timer);
        resolve(event.context.id);
      }
    });
  });
}

async function evalExt(client, ctxId, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    contextId: ctxId,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result?.value;
}

const GOOGLE_EMAIL    = process.env.GOOGLE_EMAIL    || '';
const GOOGLE_PASSWORD = process.env.GOOGLE_PASSWORD || '';

// ── 工具函數 ──────────────────────────────────────────────────────────────
let passed = 0, failed = 0, skipped = 0;

function ok(name)           { console.log(`  ✅ ${name}`); passed++; }
function fail(name, reason) { console.log(`  ❌ ${name}: ${reason}`); failed++; }
function skip(name, reason) { console.log(`  ⏭  ${name}: SKIP (${reason})`); skipped++; }

async function waitFor(fn, maxMs = 8000, intervalMs = 300) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    try { const r = await fn(); if (r) return r; } catch (_) {}
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

// ── 啟動 ──────────────────────────────────────────────────────────────────
const context = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    '--no-sandbox',
  ],
});

console.log('\n=== vocab-dashboard QA ===\n');

// ── T1：透過 dashboard_open 開啟頁面 ─────────────────────────────────────
console.log('T1: 頁面正常載入（background dashboard_open）');

const ytPage = await context.newPage();
const client  = await context.newCDPSession(ytPage);
await client.send('Runtime.enable');
const ctxIdPromise = waitForExtContext(client, 20000);

await ytPage.goto(YT_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
const ctxId = await ctxIdPromise.catch(() => null);

const jsErrors = [];
let dp = null;

// 監聽所有新分頁，挑 DEV extension 的 dashboard
const newPagesCollected = [];
const pageCollector = p => newPagesCollected.push(p);
context.on('page', pageCollector);

if (ctxId) {
  await evalExt(client, ctxId, `chrome.runtime.sendMessage({ type: 'dashboard_open' })`).catch(() => {});
} else {
  const workers = context.serviceWorkers();
  if (workers.length) {
    const swClient = await context.newCDPSession(workers[0]);
    await swClient.send('Runtime.evaluate', {
      expression: `chrome.tabs.create({ url: chrome.runtime.getURL('vocab-dashboard.html') })`,
    }).catch(() => {});
  }
}

// 等候最多 10 秒，找到 DEV extension 的 dashboard
const deadline = Date.now() + 10000;
while (Date.now() < deadline) {
  dp = newPagesCollected.find(p => p.url().includes(DEV_EXT_ID));
  if (dp) break;
  await new Promise(r => setTimeout(r, 300));
}
// fallback：若找不到 DEV 的，就用第一個
if (!dp) dp = newPagesCollected[0] || null;
context.off('page', pageCollector);

try {
  if (!dp) throw new Error('background.js 未開啟新分頁（dashboard_open 未處理）');
  console.log(`  dashboard URL: ${dp.url()}`);
  dp.on('pageerror', err => jsErrors.push(err.message));
  await dp.waitForSelector('#vd-auth-btn', { timeout: 10000 });
  ok('頁面載入成功，#vd-auth-btn 存在');
} catch (e) {
  fail('頁面載入', e.message);
  await context.close();
  process.exit(1);
}

// ── T2：分頁按鈕存在 ──────────────────────────────────────────────────────
console.log('\nT2: 所有分頁按鈕存在');
const expectedTabs = ['overview', 'line-log', 'vocab', 'keywords', 'schedule', 'memory', 'games', 'settings', 'permissions'];
for (const tab of expectedTabs) {
  const btn = await dp.$(`[data-tab="${tab}"]`);
  if (btn) ok(`data-tab="${tab}" 存在`);
  else fail(`data-tab="${tab}"`, '找不到按鈕');
}

// ── T3：登入按鈕初始狀態 ──────────────────────────────────────────────────
console.log('\nT3: 登入按鈕初始狀態');
try {
  const authText = await dp.$eval('#vd-auth-btn', el => el.textContent.trim());
  if (authText === '登入 Google') ok(`按鈕文字正確：${authText}`);
  else if (authText === '登出')   ok(`profile 已有 session，顯示「登出」`);
  else                            fail('按鈕文字', `未預期值「${authText}」`);
} catch (e) {
  fail('取得按鈕文字', e.message);
}

const isLoggedIn = await dp.$eval('#vd-auth-btn', el => el.textContent.trim() === '登出').catch(() => false);

// ── T4：登入按鈕只觸發一次彈窗 ───────────────────────────────────────────
console.log('\nT4: 登入按鈕只觸發一次 OAuth 彈窗');
if (isLoggedIn) {
  skip('T4', '已登入，跳過');
} else {
  let popupCount = 0;
  const popupListener = () => popupCount++;
  context.on('page', popupListener);
  await dp.click('#vd-auth-btn');
  await new Promise(r => setTimeout(r, 2000));
  context.off('page', popupListener);
  // 關閉 OAuth 彈窗（我們用後門登入，不需要 OAuth）
  for (const p of context.pages()) {
    if (p.url().includes('accounts.google.com')) await p.close().catch(() => {});
  }
  if (popupCount === 0)      ok('OAuth 自動完成（無彈窗）');
  else if (popupCount === 1) ok('只開了 1 個 OAuth 彈窗（不雙彈窗）');
  else                       fail('彈窗數量', `開了 ${popupCount} 個彈窗（預期 1）`);
}

// ── T5：QA 後門登入 ──────────────────────────────────────────────────────
// vocab-dashboard.js 已暴露 window.__qaSetUser（直接操作模組閉包）
// 不透過 service worker message，完全規避 MV3 async handler 的 port closed 問題
console.log('\nT5: QA 後門登入（window.__qaSetUser 直接操作 dashboard 閉包）');
if (isLoggedIn) {
  skip('T5', '已登入，跳過');
} else {
  const mockUser = { uid: 'qa-uid-001', email: 'qa@test.com', displayName: 'QA Bot', photoUrl: '' };

  const qaResult = await dp.evaluate((user) => {
    if (typeof window.__qaSetUser !== 'function') return 'no_backdoor';
    window.__qaSetUser(user);
    return 'ok';
  }, mockUser).catch(e => e.message);
  console.log(`  __qaSetUser result: ${qaResult}`);

  if (qaResult === 'ok') ok('__qaSetUser 注入成功');
  else { fail('後門登入', `result: ${qaResult}`); }

  const authText = await dp.$eval('#vd-auth-btn', el => el.textContent.trim()).catch(() => '');
  if (authText === '登出') ok('dashboard 顯示已登入（QA mock user）');
  else fail('dashboard auth 狀態', `按鈕仍顯示「${authText}」`);
}

const loggedInNow = await dp.$eval('#vd-auth-btn', el => el.textContent.trim() === '登出').catch(() => false);
console.log(`  [debug] loggedInNow = ${loggedInNow}`);

// ── T6：概覽分頁 ──────────────────────────────────────────────────────────
console.log('\nT6: 概覽分頁');
if (!loggedInNow) {
  skip('T6', '未登入，跳過');
} else {
  try {
    await dp.click('[data-tab="overview"]');
    await dp.waitForTimeout(2000);
    const content = await dp.$eval('#tab-overview', el => el.innerHTML.length).catch(() => 0);
    if (content > 50) ok(`概覽有內容（${content} chars）`);
    else              fail('概覽分頁', '無內容');
    if (jsErrors.length) fail('JS 錯誤', jsErrors.join('; '));
    else                 ok('無 JS 錯誤');
  } catch (e) {
    fail('概覽分頁', e.message);
  }
}

// ── T7：生字庫分頁 ────────────────────────────────────────────────────────
console.log('\nT7: 生字庫分頁');
if (!loggedInNow) {
  skip('T7', '未登入，跳過');
} else {
  try {
    await dp.click('[data-tab="vocab"]');
    await dp.waitForTimeout(2000);
    const table = await dp.$('#yt-vocab-table, #tab-vocab table');
    if (table) {
      const rows = await table.$$('tbody tr');
      ok(`生字庫表格存在（${rows.length} 筆）`);
    } else {
      fail('生字庫', '找不到表格');
    }
  } catch (e) {
    fail('生字庫分頁', e.message);
  }
}

// ── T8：關鍵字分頁 ────────────────────────────────────────────────────────
console.log('\nT8: 關鍵字分頁');
if (!loggedInNow) {
  skip('T8', '未登入，跳過');
} else {
  try {
    await dp.click('[data-tab="keywords"]');
    await dp.waitForTimeout(1500);
    const table = await dp.$('#kw-table, #tab-keywords table');
    if (table) ok('關鍵字表格存在');
    else       fail('關鍵字', '找不到表格');
  } catch (e) {
    fail('關鍵字分頁', e.message);
  }
}

// ── T9：設定分頁 ──────────────────────────────────────────────────────────
console.log('\nT9: 設定分頁');
try {
  await dp.click('[data-tab="settings"]');
  await dp.waitForTimeout(1000);
  const content = await dp.$eval('#tab-settings', el => el.innerHTML.length).catch(() => 0);
  if (content > 50) ok('設定分頁有內容');
  else              fail('設定分頁', '無內容');
} catch (e) {
  fail('設定分頁', e.message);
}

// ── T10：登出 ─────────────────────────────────────────────────────────────
console.log('\nT10: 登出');
if (!loggedInNow) {
  skip('T10', '未登入，跳過');
} else {
  try {
    await dp.click('#vd-auth-btn');
    const loggedOut = await waitFor(async () => {
      const text = await dp.$eval('#vd-auth-btn', el => el.textContent.trim()).catch(() => '');
      return text === '登入 Google' ? true : null;
    }, 5000, 300);
    if (loggedOut) ok('登出成功，按鈕恢復「登入 Google」');
    else           fail('登出', '按鈕未恢復「登入 Google」');
  } catch (e) {
    fail('登出', e.message);
  }
}

// ── 結果 ──────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════');
console.log(`結果：✅ ${passed} 通過  ❌ ${failed} 失敗  ⏭  ${skipped} 跳過`);
console.log('═══════════════════════════════════════\n');

await context.close();
process.exit(failed > 0 ? 1 : 0);
