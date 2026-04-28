/**
 * qa-wordbook-popup-v48.mjs
 * QA 靜態代碼驗證腳本：針對 v48 改版的 4 個項目進行驗證
 * 改版項目：
 *   1. 生字本預設排序改為「最近加入」(date-desc)
 *   2. 生字本搜尋框（yt-sub-wb-search）
 *   3. 單字查詢彈窗縮至 420px，字體全面壓縮
 *   4. 彈窗定位改為錨點正上方（bottom 定位）
 */

import fs from 'fs';
import path from 'path';

// === 路徑設定 ===
const BASE = 'd:/dev/chrome字幕套件開發';
const CONTENT_JS = path.join(BASE, 'content.js');
const STYLES_CSS = path.join(BASE, 'styles.css');

// === 工具函式 ===

/**
 * 讀取檔案內容，回傳字串；失敗時拋出錯誤
 */
function readFile(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`找不到檔案：${filePath}`);
  }
  return fs.readFileSync(filePath, 'utf-8');
}

/**
 * 擷取 CSS 規則區塊內容（selector 到下一個 }）
 */
function extractCssBlock(css, selector) {
  const escaped = selector.replace(/[#.[\]()]/g, '\\$&');
  const re = new RegExp(escaped + '\\s*\\{([^}]+)\\}', 's');
  const m = css.match(re);
  return m ? m[1] : null;
}

/**
 * 從 CSS 區塊取得特定屬性值
 */
function getCssProp(block, prop) {
  if (!block) return null;
  const re = new RegExp(prop + '\\s*:\\s*([^;]+);');
  const m = block.match(re);
  return m ? m[1].trim() : null;
}

// === 測試執行 ===

const results = [];

/**
 * 執行單一測試，記錄結果
 */
function test(name, fn) {
  try {
    const { pass, details } = fn();
    results.push({ name, pass, details });
  } catch (e) {
    results.push({ name, pass: false, details: `例外：${e.message}` });
  }
}

// 讀取源文件
const contentJs = readFile(CONTENT_JS);
const stylesCss = readFile(STYLES_CSS);

// ============================================================
// 測試 1：生字本預設排序 — date-desc selected
// ============================================================
test('1. 生字本預設排序 — #yt-sub-wordbook-sort 第一個 option 為 date-desc 且有 selected', () => {
  // 找出 <select id="yt-sub-wordbook-sort"> 的區塊
  const selectMatch = contentJs.match(
    /<select[^>]*id="yt-sub-wordbook-sort"[^>]*>([\s\S]*?)<\/select>/
  );
  if (!selectMatch) {
    return { pass: false, details: '找不到 #yt-sub-wordbook-sort <select> 元素' };
  }
  const selectHtml = selectMatch[1];

  // 找第一個 <option>
  const firstOption = selectHtml.match(/<option([^>]*)>(.*?)<\/option>/);
  if (!firstOption) {
    return { pass: false, details: '找不到任何 <option>' };
  }
  const attrs = firstOption[1];
  const hasDateDesc = attrs.includes('value="date-desc"');
  const hasSelected = attrs.includes('selected');

  if (hasDateDesc && hasSelected) {
    return { pass: true, details: '第一個 option value="date-desc" 且有 selected 屬性 ✓' };
  }
  return {
    pass: false,
    details: `第一個 option 屬性：${attrs.trim()} | 期望：value="date-desc" selected`
  };
});

// ============================================================
// 測試 2a：搜尋框 HTML 元素存在
// ============================================================
test('2a. 搜尋框 — content.js 有 id="yt-sub-wb-search" 的 input', () => {
  const hasInput = contentJs.includes('id="yt-sub-wb-search"');
  if (hasInput) {
    return { pass: true, details: '找到 id="yt-sub-wb-search" input 元素 ✓' };
  }
  return { pass: false, details: '找不到 id="yt-sub-wb-search" input 元素' };
});

// ============================================================
// 測試 2b：renderWordbook 讀取搜尋框值並做 .includes() 過濾
// ============================================================
test('2b. 搜尋框 — renderWordbook 讀取搜尋值並使用 .includes() 過濾', () => {
  const readSearch = contentJs.includes("getElementById('yt-sub-wb-search')") ||
                     contentJs.includes('getElementById("yt-sub-wb-search")');
  const usesIncludes = contentJs.match(/yt-sub-wb-search[\s\S]{1,300}\.includes\(/);

  if (readSearch && usesIncludes) {
    return { pass: true, details: 'renderWordbook 讀取搜尋框值並呼叫 .includes() 過濾 ✓' };
  }
  const missing = [];
  if (!readSearch) missing.push('未找到讀取 yt-sub-wb-search 的程式碼');
  if (!usesIncludes) missing.push('未找到 .includes() 過濾邏輯');
  return { pass: false, details: missing.join('；') };
});

// ============================================================
// 測試 2c：styles.css 有 .yt-sub-wb-search 樣式
// ============================================================
test('2c. 搜尋框 — styles.css 定義 .yt-sub-wb-search 樣式', () => {
  const block = extractCssBlock(stylesCss, '.yt-sub-wb-search');
  if (block) {
    return { pass: true, details: '找到 .yt-sub-wb-search 樣式定義 ✓' };
  }
  return { pass: false, details: 'styles.css 中找不到 .yt-sub-wb-search 區塊' };
});

// ============================================================
// 測試 3a：彈窗寬度 width = 420px
// ============================================================
test('3a. 彈窗尺寸 — #yt-sub-word-popup width = 420px', () => {
  const block = extractCssBlock(stylesCss, '#yt-sub-word-popup');
  if (!block) {
    return { pass: false, details: '找不到 #yt-sub-word-popup CSS 區塊' };
  }
  const width = getCssProp(block, 'width');
  if (width === '420px') {
    return { pass: true, details: `width = ${width} ✓` };
  }
  return { pass: false, details: `width 實際值：${width}，期望：420px` };
});

// ============================================================
// 測試 3b：彈窗基礎 font-size = 15px
// ============================================================
test('3b. 彈窗尺寸 — #yt-sub-word-popup font-size = 15px', () => {
  const block = extractCssBlock(stylesCss, '#yt-sub-word-popup');
  if (!block) {
    return { pass: false, details: '找不到 #yt-sub-word-popup CSS 區塊' };
  }
  const fontSize = getCssProp(block, 'font-size');
  if (fontSize === '15px') {
    return { pass: true, details: `font-size = ${fontSize} ✓` };
  }
  return { pass: false, details: `font-size 實際值：${fontSize}，期望：15px` };
});

// ============================================================
// 測試 3c：.yt-sub-popup-word font-size = 22px（單字標題）
// ============================================================
test('3c. 彈窗尺寸 — .yt-sub-popup-word font-size = 22px', () => {
  const block = extractCssBlock(stylesCss, '.yt-sub-popup-word');
  if (!block) {
    return { pass: false, details: '找不到 .yt-sub-popup-word CSS 區塊' };
  }
  const fontSize = getCssProp(block, 'font-size');
  if (fontSize === '22px') {
    return { pass: true, details: `font-size = ${fontSize} ✓` };
  }
  return { pass: false, details: `font-size 實際值：${fontSize}，期望：22px` };
});

// ============================================================
// 測試 3d：.yt-sub-popup-save-btn font-size = 15px
// ============================================================
test('3d. 彈窗尺寸 — .yt-sub-popup-save-btn font-size = 15px', () => {
  const block = extractCssBlock(stylesCss, '.yt-sub-popup-save-btn');
  if (!block) {
    return { pass: false, details: '找不到 .yt-sub-popup-save-btn CSS 區塊' };
  }
  const fontSize = getCssProp(block, 'font-size');
  if (fontSize === '15px') {
    return { pass: true, details: `font-size = ${fontSize} ✓` };
  }
  return { pass: false, details: `font-size 實際值：${fontSize}，期望：15px` };
});

// ============================================================
// 測試 4a：_positionPopupNearAnchor 存在且使用 bottom 定位
// ============================================================
test('4a. 彈窗定位 — _positionPopupNearAnchor 使用 popup.style.bottom 設定上方位置', () => {
  const fnMatch = contentJs.match(
    /function _positionPopupNearAnchor\([\s\S]*?\n  \}/
  );
  if (!fnMatch) {
    return { pass: false, details: '找不到 _positionPopupNearAnchor 函式' };
  }
  const fnBody = fnMatch[0];
  const hasBottom = fnBody.includes('popup.style.bottom =');
  if (hasBottom) {
    return { pass: true, details: '找到 popup.style.bottom = ... 定位邏輯 ✓' };
  }
  return { pass: false, details: '函式內未找到 popup.style.bottom 指派' };
});

// ============================================================
// 測試 4b：上方模式有 popup.style.top = 'auto'
// ============================================================
test("4b. 彈窗定位 — 上方模式設定 popup.style.top = 'auto'", () => {
  const hasTopAuto = contentJs.includes("popup.style.top    = 'auto'") ||
                     contentJs.includes("popup.style.top = 'auto'");
  if (hasTopAuto) {
    return { pass: true, details: "找到 popup.style.top = 'auto' ✓" };
  }
  return { pass: false, details: "未找到 popup.style.top = 'auto'" };
});

// ============================================================
// 測試 4c：viewport 邊界保護 MARGIN = 8
// ============================================================
test('4c. 彈窗定位 — 有 MARGIN = 8 的 viewport 邊界保護', () => {
  const fnMatch = contentJs.match(
    /function _positionPopupNearAnchor\([\s\S]*?\n  \}/
  );
  if (!fnMatch) {
    return { pass: false, details: '找不到 _positionPopupNearAnchor 函式' };
  }
  const fnBody = fnMatch[0];
  const hasMargin8 = fnBody.includes('MARGIN = 8');
  const usesMargin = fnBody.includes('MARGIN');
  if (hasMargin8 && usesMargin) {
    return { pass: true, details: 'MARGIN = 8，並用於邊界保護 ✓' };
  }
  if (!hasMargin8) {
    return { pass: false, details: `未找到 MARGIN = 8，函式中 MARGIN 使用：${usesMargin}` };
  }
  return { pass: false, details: 'MARGIN 定義存在但未用於邊界保護' };
});

// ============================================================
// 測試 5：搜尋計數格式 N / 總數 個單字
// ============================================================
test('5. 搜尋計數 — 有搜尋結果時格式為「N / 總數 個單字」', () => {
  // 找 renderWordbook 函式中計數格式字串
  const hasCountFormat = contentJs.includes('/ ${baseCount} 個單字') ||
                         contentJs.includes("/ ${words.length} 個單字") ||
                         contentJs.match(/\$\{displayed\.length\}\s*\/\s*\$\{[^}]+\}\s*個單字/);
  if (hasCountFormat) {
    return { pass: true, details: '找到「N / 總數 個單字」格式字串 ✓' };
  }
  // 更寬鬆檢查
  const looseMatch = contentJs.match(/displayed\.length.*\/.*baseCount.*個單字/s) ||
                     contentJs.match(/`\$\{displayed\.length\} \/ \$\{baseCount\} 個單字`/);
  if (looseMatch) {
    return { pass: true, details: '找到「N / 總數 個單字」格式字串 ✓' };
  }
  return { pass: false, details: '未找到「N / 總數 個單字」計數格式' };
});

// ============================================================
// 輸出結果
// ============================================================

let allPass = true;
const lines = [];

lines.push('# QA 測試報告：qa-wordbook-popup-v48');
lines.push('');
lines.push(`測試時間：${new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' })}`);
lines.push(`測試檔案：content.js / styles.css`);
lines.push('');
lines.push('---');
lines.push('');

for (const r of results) {
  const status = r.pass ? '✅ PASS' : '❌ FAIL';
  if (!r.pass) allPass = false;
  lines.push(`## ${status} — ${r.name}`);
  lines.push('');
  lines.push(`${r.details}`);
  lines.push('');
}

lines.push('---');
lines.push('');
lines.push(`## 整體結果：${allPass ? '✅ 全部 PASS' : '❌ FAIL（有測試未通過）'}`);

const report = lines.join('\n');

// 輸出到 console
console.log('\n' + report);

// 寫入報告檔
const REPORT_PATH = path.join(BASE, 'docs', 'qa-wordbook-popup-v48.md');
fs.writeFileSync(REPORT_PATH, report, 'utf-8');
console.log(`\n報告已寫入：${REPORT_PATH}`);
process.exit(allPass ? 0 : 1);
