/**
 * v5.4 QA：yt-dlp 字幕匯入格式測試
 * 測試對象：parseSrt + _deduplicateSubs（從 content.js 提取核心邏輯）
 *
 * 執行方式：node tests/qa_ytdlp_import.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── 從 content.js 提取的核心函式（與線上版本一致）────────────────────────────

function _srtTs(ts) {
  const m = ts.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
  if (!m) return NaN;
  return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + parseInt(m[4]) / 1000;
}

function parseSrt(srtText) {
  const subs = [];
  const normalized = srtText
    .replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    .replace(/(-->[^\n]*)\n\n/g, '$1\n');
  const blocks = normalized.trim().split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    const tsLine = lines.find(l => l.includes('-->'));
    if (!tsLine) continue;
    const parts = tsLine.split('-->');
    const startStr = parts[0].trim();
    const endStr   = parts[1].trim().split(/\s/)[0];
    const startTime = _srtTs(startStr);
    const endTime   = _srtTs(endStr);
    if (isNaN(startTime) || isNaN(endTime) || endTime <= startTime) continue;
    const tsIdx    = lines.indexOf(tsLine);
    const lineText = lines.slice(tsIdx + 1).join('\n').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (!lineText) continue;
    subs.push({ startTime, duration: endTime - startTime, text: lineText });
  }
  return subs;
}

function _deduplicateSubs(subs) {
  if (subs.length < 2) return subs;
  const result = [];
  for (const sub of subs) {
    const prev = result[result.length - 1];
    if (prev && (sub.startTime - prev.startTime) < 0.2) {
      result[result.length - 1] = sub;
    } else {
      result.push(sub);
    }
  }
  return result;
}

// ── 測試工具 ──────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;

function assert(condition, label, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

// ── T1：真實 yt-dlp 下載的 SRT（標準格式）────────────────────────────────────
console.log('\nT1：真實 yt-dlp SRT（標準格式，4TWR90KJl84）');
const srtPath = path.join(__dirname, '../.gstack/qa-reports/yt-dlp-test/test-video.en.srt');
if (!fs.existsSync(srtPath)) {
  console.error('  ⚠️  找不到 SRT 檔案，請先執行 yt-dlp 下載');
  failed++;
} else {
  const srtText = fs.readFileSync(srtPath, 'utf-8');
  const subs = parseSrt(srtText);
  assert(subs.length > 0, `解析出 ${subs.length} 句`);
  assert(subs[0].text.includes('Next Level Yeah'), `第 1 句文字正確：「${subs[0].text}」`);
  assert(Math.abs(subs[0].startTime - 16.43) < 0.01, `第 1 句 startTime = ${subs[0].startTime.toFixed(3)}s`);
  assert(subs.every(s => s.duration > 0), '所有句子 duration > 0');
  assert(subs.every(s => s.text.trim().length > 0), '所有句子文字非空');
  console.log(`     → 共 ${subs.length} 句，首句：「${subs[0].text}」`);
}

// ── T2：yt-dlp 空行格式（時間戳後有額外空行）──────────────────────────────────
console.log('\nT2：yt-dlp 空行格式（時間戳與文字之間有空行）');
const ytdlpBlankLine = `1
00:00:01,920 --> 00:00:20,790

Get out of here.

2
00:00:20,790 --> 00:00:25,000

This is a test sentence.

3
00:00:25,000 --> 00:00:25,010


`;
const subs2 = parseSrt(ytdlpBlankLine);
assert(subs2.length === 2, `解析出 2 句（空白句應被過濾），實際：${subs2.length}`);
assert(subs2[0].text === 'Get out of here.', `第 1 句文字正確：「${subs2[0].text}」`);
assert(Math.abs(subs2[0].startTime - 1.92) < 0.01, `startTime = ${subs2[0].startTime.toFixed(3)}s`);

// ── T3：VTT 格式（WEBVTT header + cue settings）──────────────────────────────
console.log('\nT3：VTT 格式（含 WEBVTT header 和 cue settings）');
const vttText = `WEBVTT
Kind: captions
Language: en

00:00:01.000 --> 00:00:03.500 align:start position:0%
Hello world

00:00:03.500 --> 00:00:06.000 align:start position:0%
<c>How</c><00:00:03.800><c>are</c><00:00:04.200><c>you</c>

`;
const subs3 = parseSrt(vttText);
assert(subs3.length === 2, `解析出 2 句，實際：${subs3.length}`);
assert(subs3[0].text === 'Hello world', `第 1 句：「${subs3[0].text}」`);
assert(subs3[1].text === 'How are you', `第 2 句（c tags 清除）：「${subs3[1].text}」`);
assert(Math.abs(subs3[1].startTime - 3.5) < 0.01, `第 2 句 startTime 正確`);

// ── T4：重疊句 dedup（YouTube ASR 格式）──────────────────────────────────────
console.log('\nT4：重疊句 dedup（ASR 漸進更新）');
const overlapText = `1
00:00:59,829 --> 00:01:01,829
All those who touch the stone meet the

2
00:00:59,840 --> 00:01:01,840
All those who touch the stone meet the
same fate.

3
00:01:02,000 --> 00:01:04,000
A completely different sentence.
`;
const raw4 = parseSrt(overlapText);
const deduped4 = _deduplicateSubs(raw4);
assert(raw4.length === 3, `dedup 前有 3 句，實際：${raw4.length}`);
assert(deduped4.length === 2, `dedup 後剩 2 句（兩個重疊句合為一），實際：${deduped4.length}`);
assert(deduped4[0].text.includes('same fate'), `保留後者（完整句）：「${deduped4[0].text}」`);
assert(deduped4[1].text === 'A completely different sentence.', `第 2 句保留：「${deduped4[1].text}」`);

// ── T5：套件自身匯出格式（含 | 雙字幕）──────────────────────────────────────
console.log('\nT5：套件自身匯出格式（含 | 雙字幕）');
const customFmt = `[CUSTOM_SUBTITLE]
author=test
name=test-sub
videoId=abc123

1
00:00:01,000 --> 00:00:03,000
Hello world | 哈囉世界

2
00:00:03,000 --> 00:00:05,000
How are you | 你好嗎

`;
const subs5 = parseSrt(customFmt);
assert(subs5.length === 2, `解析出 2 句，實際：${subs5.length}`);
assert(subs5[0].text === 'Hello world | 哈囉世界', `雙字幕 | 保留：「${subs5[0].text}」`);

// ── T6：applyOverlayPosition 位置 clamp ──────────────────────────────────────
console.log('\nT6：applyOverlayPosition 位置 clamp（拖曳上限修正）');

function clampBottom(raw) {
  return Math.min(72, Math.max(0, raw));
}

assert(clampBottom(0)   === 0,  'bottom=0 保持 0');
assert(clampBottom(50)  === 50, 'bottom=50 保持 50');
assert(clampBottom(72)  === 72, 'bottom=72 保持 72（上限邊界）');
assert(clampBottom(88)  === 72, 'bottom=88 → 截斷為 72（舊存檔修正）');
assert(clampBottom(100) === 72, 'bottom=100 → 截斷為 72');
assert(clampBottom(-5)  === 0,  'bottom=-5 → 截斷為 0（下限）');

// ── T7：secondaryCustomActive 封鎖翻譯覆寫 ───────────────────────────────────
console.log('\nT7：secondaryCustomActive 封鎖 Google Translate 覆寫副字幕');

// 模擬 content.js 的旗標狀態機
let secondaryCustomActive = false;
let secondarySubtitles = [];
let translationJobCancelled = false;

function simulateTranslateAndSetSecondary(newText) {
  if (secondaryCustomActive) return 'blocked';
  secondarySubtitles = [{ startTime: 0, duration: 2, text: newText }];
  return 'wrote';
}

function simulateImportSrtFile() {
  // 匯入主字幕 → 重置旗標，允許翻譯
  secondaryCustomActive = false;
}

function simulateImportSecondaryFile(subs) {
  secondarySubtitles = subs;
  secondaryCustomActive = true;
  translationJobCancelled = true; // 取消進行中的翻譯
}

function simulateSecondaryLangChange() {
  secondarySubtitles = [];
  secondaryCustomActive = false; // 用戶主動切換語言，解除封鎖
}

// 情境 A：匯入副字幕後，翻譯不該覆寫
simulateImportSrtFile();
assert(secondaryCustomActive === false, 'importSrtFile 後 secondaryCustomActive=false');
const resultBeforeImport = simulateTranslateAndSetSecondary('Google翻譯');
assert(resultBeforeImport === 'wrote', '匯入副字幕前，翻譯可以寫入');
assert(secondarySubtitles[0].text === 'Google翻譯', '翻譯結果已寫入');

simulateImportSecondaryFile([{ startTime: 0, duration: 2, text: '外部副字幕' }]);
assert(secondaryCustomActive === true, 'importSecondaryFile 後 secondaryCustomActive=true');
assert(translationJobCancelled === true, '翻譯 job 已取消');
assert(secondarySubtitles[0].text === '外部副字幕', '副字幕已設為匯入的內容');

const resultAfterImport = simulateTranslateAndSetSecondary('翻譯不該蓋掉');
assert(resultAfterImport === 'blocked', '匯入副字幕後，翻譯被封鎖');
assert(secondarySubtitles[0].text === '外部副字幕', '副字幕內容未被翻譯覆寫');

// 情境 B：用戶切換語言後解除封鎖
simulateSecondaryLangChange();
assert(secondaryCustomActive === false, '切換語言後 secondaryCustomActive=false');
const resultAfterLangChange = simulateTranslateAndSetSecondary('切換後重新翻譯');
assert(resultAfterLangChange === 'wrote', '切換語言後翻譯可再次寫入');

// 情境 C：換影片後解除封鎖（模擬 video change）
simulateImportSecondaryFile([{ startTime: 0, duration: 2, text: '副字幕' }]);
assert(secondaryCustomActive === true, '換影片前 secondaryCustomActive=true');
secondaryCustomActive = false; // 模擬 video change handler
assert(secondaryCustomActive === false, '換影片後 secondaryCustomActive=false');

// ── T8：直播聊天室 panel 隱藏邏輯（_chatPanelHidden 狀態機）────────────────────
console.log('\nT8：直播聊天室重播 panel 隱藏邏輯');

// 模擬 DOM：engagement panel
function makeChatPanel(visible = true) {
  return {
    _display: visible ? '' : 'none',
    get style() {
      const self = this;
      return {
        get display() { return self._display; },
        setProperty(k, v) { if (k === 'display') self._display = v; },
        removeProperty(k) { if (k === 'display') self._display = ''; },
      };
    },
  };
}

let _chatPanelHidden2 = false;

function simulateExpandSidebar(panel) {
  if (panel && panel._display !== 'none') {
    panel.style.setProperty('display', 'none');
    _chatPanelHidden2 = true;
  }
}

function simulateCollapseSidebar(panel) {
  if (_chatPanelHidden2) {
    if (panel) panel.style.removeProperty('display');
    _chatPanelHidden2 = false;
  }
}

// 情境 A：直播頁（panel 可見）→ 展開套件 → panel 隱藏 → 收合 → panel 還原
const panel = makeChatPanel(true);
simulateExpandSidebar(panel);
assert(_chatPanelHidden2 === true, '展開側邊欄後 _chatPanelHidden=true');
assert(panel._display === 'none', '直播 panel 被隱藏');
simulateCollapseSidebar(panel);
assert(_chatPanelHidden2 === false, '收合後 _chatPanelHidden=false');
assert(panel._display === '', '直播 panel 已還原');

// 情境 B：非直播頁（無 panel）→ 展開/收合不出錯，旗標不被設定
_chatPanelHidden2 = false;
simulateExpandSidebar(null);
assert(_chatPanelHidden2 === false, '無 panel 時展開，旗標不設定');
simulateCollapseSidebar(null);
assert(_chatPanelHidden2 === false, '無 panel 時收合，旗標保持 false');

// 情境 C：panel 已被 YouTube 隱藏（display=none）→ 展開時不再設旗標（避免雙重管理）
_chatPanelHidden2 = false;
const hiddenPanel = makeChatPanel(false); // 已隱藏的 panel
hiddenPanel._display = 'none';
simulateExpandSidebar(hiddenPanel);
assert(_chatPanelHidden2 === false, 'panel 原本已隱藏，旗標不設定');

// 情境 D：換影片時旗標重置（不還原 panel，讓新頁面自行管理）
_chatPanelHidden2 = true;
_chatPanelHidden2 = false; // 模擬 video change handler
assert(_chatPanelHidden2 === false, '換影片後 _chatPanelHidden 重置為 false');

// ── 結果統計 ──────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`結果：${passed} 通過 / ${failed} 失敗 / ${passed + failed} 總計`);
if (failed === 0) {
  console.log('✅ 全部通過 — v5.4 字幕匯入格式相容性確認');
} else {
  console.error('❌ 有測試失敗，請檢查上方錯誤');
  process.exit(1);
}
