/**
 * qa_overlay_fix.mjs
 * QA 靜態代碼驗證：overlay fix 相關修改
 *
 * 驗證項目：
 * 1. picker prepend：panel.prepend(picker) 存在，且 panel.appendChild(picker) 不再用於 community picker
 * 2. showCommunitySubtitlePicker click handler 中 applyOverlay() 在 startSync() 之前
 * 3. _restoreSavedSubtitle 自定義字幕路徑中 applyOverlay() 在 startSync() 之前
 * 4. _restoreSavedSubtitle 社群字幕路徑中 applyOverlay() 在 startSync() 之前
 */

import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONTENT_JS = path.resolve(__dirname, '..', 'content.js');

/** 印出 pass/fail 結果，回傳 boolean */
function report(label, passed, detail) {
  const icon = passed ? '✅' : '❌';
  console.log(icon + ' ' + label + (detail ? ' — ' + detail : ''));
  return passed;
}

// ===== 讀取 content.js =====
const src = readFileSync(CONTENT_JS, 'utf-8');
const lines = src.split('\n');

/**
 * 在 lines[] 中，從 startLine 開始（含），向後找到第一個包含 needle 的行號（0-based）
 * 找不到回傳 -1
 */
function findLineFrom(needle, startLine, endLine) {
  const end = endLine !== undefined ? endLine : lines.length - 1;
  for (let i = startLine; i <= end; i++) {
    if (lines[i].includes(needle)) return i;
  }
  return -1;
}

/**
 * 找到函式起始行（包含 funcMarker 的那一行），回傳行號
 */
function findFuncStart(funcMarker) {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(funcMarker)) return i;
  }
  return -1;
}

const results = [];

// ===== 驗證 1：picker prepend =====
// 期望：panel.prepend(picker) 出現，且 panel.appendChild(picker) 不出現（在 showCommunitySubtitlePicker 內）
{
  const prependIdx = findLineFrom('panel.prepend(picker)', 0);
  const appendIdx = findLineFrom('panel.appendChild(picker)', 0);

  const hasPrepend = prependIdx !== -1;
  const hasAppend = appendIdx !== -1;

  results.push(report(
    'picker prepend：panel.prepend(picker) 存在',
    hasPrepend,
    hasPrepend ? `第 ${prependIdx + 1} 行` : '未找到'
  ));

  results.push(report(
    'picker append：panel.appendChild(picker) 已移除（不存在）',
    !hasAppend,
    hasAppend ? `仍在第 ${appendIdx + 1} 行：${lines[appendIdx].trim()}` : '確認不存在'
  ));
}

// ===== 驗證 2：showCommunitySubtitlePicker click handler 中 applyOverlay 在 startSync 之前 =====
{
  const funcStart = findFuncStart('function showCommunitySubtitlePicker');
  if (funcStart === -1) {
    results.push(report('showCommunitySubtitlePicker：函式存在', false, '找不到函式定義'));
  } else {
    // 找函式結束（下一個 function 定義前，最多掃 200 行）
    const funcEnd = funcStart + 200;

    // 在函式範圍內找 click handler（包含 fetch 與 primarySubtitles 賦值後的區域）
    // applyOverlay() 應出現在 startSync() 之前
    const applyIdx = findLineFrom('applyOverlay()', funcStart, funcEnd);
    const syncIdx = findLineFrom('startSync()', funcStart, funcEnd);

    const bothExist = applyIdx !== -1 && syncIdx !== -1;
    const correctOrder = bothExist && applyIdx < syncIdx;

    results.push(report(
      'showCommunitySubtitlePicker：applyOverlay() 在 startSync() 之前',
      correctOrder,
      bothExist
        ? `applyOverlay 第 ${applyIdx + 1} 行，startSync 第 ${syncIdx + 1} 行`
        : `applyOverlay=${applyIdx + 1}, startSync=${syncIdx + 1}`
    ));
  }
}

// ===== 驗證 3：_restoreSavedSubtitle 自定義字幕路徑 applyOverlay 在 startSync 之前 =====
{
  const funcStart = findFuncStart('function _restoreSavedSubtitle');
  if (funcStart === -1) {
    results.push(report('_restoreSavedSubtitle：函式存在', false, '找不到函式定義'));
  } else {
    // 自定義字幕路徑：editedSubtitles_ 的 get callback 內
    // 找 editedSubtitles_ 的 get 呼叫
    const editGetIdx = findLineFrom('editedSubtitles_${videoId}', funcStart, funcStart + 100);
    if (editGetIdx === -1) {
      results.push(report('_restoreSavedSubtitle 自定義路徑：找到 editedSubtitles_ get', false, '未找到'));
    } else {
      // 在 editGet 之後找 lastCommunitySubtitle（社群路徑開始）
      const commGetIdx = findLineFrom('lastCommunitySubtitle_${videoId}', editGetIdx, editGetIdx + 80);
      const customEnd = commGetIdx !== -1 ? commGetIdx : editGetIdx + 40;

      const applyIdx = findLineFrom('applyOverlay()', editGetIdx, customEnd);
      const syncIdx = findLineFrom('startSync()', editGetIdx, customEnd);

      const bothExist = applyIdx !== -1 && syncIdx !== -1;
      const correctOrder = bothExist && applyIdx < syncIdx;

      results.push(report(
        '_restoreSavedSubtitle 自定義路徑：applyOverlay() 在 startSync() 之前',
        correctOrder,
        bothExist
          ? `applyOverlay 第 ${applyIdx + 1} 行，startSync 第 ${syncIdx + 1} 行`
          : `applyOverlay=${applyIdx !== -1 ? applyIdx + 1 : '未找到'}, startSync=${syncIdx !== -1 ? syncIdx + 1 : '未找到'}`
      ));
    }
  }
}

// ===== 驗證 4：_restoreSavedSubtitle 社群字幕路徑 applyOverlay 在 startSync 之前 =====
{
  const funcStart = findFuncStart('function _restoreSavedSubtitle');
  if (funcStart === -1) {
    results.push(report('_restoreSavedSubtitle 社群路徑：函式存在', false, '找不到函式定義'));
  } else {
    // 社群路徑：lastCommunitySubtitle_ 的 get callback 內
    const commGetIdx = findLineFrom('lastCommunitySubtitle_${videoId}', funcStart, funcStart + 100);
    if (commGetIdx === -1) {
      results.push(report('_restoreSavedSubtitle 社群路徑：找到 lastCommunitySubtitle_ get', false, '未找到'));
    } else {
      // 在 commGet 之後找 applyOverlay / startSync（最多掃 30 行）
      const applyIdx = findLineFrom('applyOverlay()', commGetIdx, commGetIdx + 30);
      const syncIdx = findLineFrom('startSync()', commGetIdx, commGetIdx + 30);

      const bothExist = applyIdx !== -1 && syncIdx !== -1;
      const correctOrder = bothExist && applyIdx < syncIdx;

      results.push(report(
        '_restoreSavedSubtitle 社群路徑：applyOverlay() 在 startSync() 之前',
        correctOrder,
        bothExist
          ? `applyOverlay 第 ${applyIdx + 1} 行，startSync 第 ${syncIdx + 1} 行`
          : `applyOverlay=${applyIdx !== -1 ? applyIdx + 1 : '未找到'}, startSync=${syncIdx !== -1 ? syncIdx + 1 : '未找到'}`
      ));
    }
  }
}

// ===== 總結 =====
console.log('\n========== 靜態代碼驗證總結 ==========');
const passed = results.filter(Boolean).length;
const total = results.length;
console.log(`通過 ${passed} / ${total} 項驗證`);
if (passed === total) {
  console.log('✅ 全部通過');
  process.exit(0);
} else {
  console.log(`❌ ${total - passed} 項失敗`);
  process.exit(1);
}
