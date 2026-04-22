# QA 靜態審查報告：字幕模式五項修復
**版本**：v48  
**日期**：2026-04-22  
**審查方式**：靜態代碼審查（依 QA_READ.md 規範，YouTube pot token 限制故無法實機自動化）  
**審查檔案**：`content.js`、`styles.css`

---

## A. z-index 修復

**1. ✅ PASS** — `styles.css` 第 1342 行：`#yt-sub-word-popup { z-index: 200001; }`，值正確。

**2. ✅ PASS** — `styles.css` 第 2059 行：`#yt-sub-subtitle-mode { z-index: 100000; }`，未被異動。

**3. ✅ PASS** — 200001 > 100000，popup 層級高於字幕模式覆蓋層，遮擋問題已修復。

---

## B. 播放控制修復

**4. ✅ PASS** — `content.js` 第 3442 行：
```js
const _ysmGetVid = () => document.querySelector('.ysm-real-video') || video;
```
定義在 `enterSubtitleMode()` 內，優先取 `.ysm-real-video`，fallback 到原始 `video` 引用。

**5. ✅ PASS** — 第 3454–3458 行，play button listener 使用 `_ysmGetVid()`：
```js
playBtn.addEventListener('click', () => {
  const v = _ysmGetVid();
  if (!v) return;
  v.paused ? v.play().catch(() => {}) : v.pause();
});
```

**6. ✅ PASS** — 第 3459–3462 行，scrubber input listener 使用 `_ysmGetVid()`：
```js
scrubber.addEventListener('input', () => {
  const v = _ysmGetVid();
  if (v) v.currentTime = Number(scrubber.value);
});
```

**7. ✅ PASS** — 第 3463–3464 行，timeupdate 綁在 `_ysmGetVid()` 的當下結果（`_vidRef`）上：
```js
const _vidRef = _ysmGetVid();
if (_vidRef) _vidRef.addEventListener('timeupdate', _ysmSyncControls);
```
⚠️ 觀察：`_vidRef` 在 `enterSubtitleMode` 呼叫當下快照，若後續 DOM 中 `.ysm-real-video` 因重渲染而替換元素，timeupdate 仍綁在舊節點。但現有流程中 video 元素於整個字幕模式期間不替換，屬於可接受設計。

---

## C. Loop 按鈕修復

**8. ✅ PASS** — `content.js` 第 3556 行，`_renderSubtitleModeList` 內：
```js
const _getV = () => document.querySelector('.ysm-real-video') || document.querySelector('video');
```
優先取 `.ysm-real-video`，fallback 為任何 `video`。

**9. ✅ PASS** — 第 3561–3567 行，loop button click 使用 `_getV()` 做 seek + play：
```js
const v = _getV();
if (loopingIdx === i) {
  loopingIdx = -1;
} else {
  loopingIdx = i;
  if (v) { v.currentTime = sub.startTime; v.play().catch(() => {}); }
}
```

**10. ✅ PASS** — toggle 邏輯正確：`loopingIdx === i` 時設為 -1（取消），否則設為 i（啟動）。

---

## D. 跳轉修復

**11. ✅ PASS** — 第 3572–3576 行，timestamp click 使用 `_getV()`：
```js
tsEl.addEventListener('click', e => {
  e.stopPropagation();
  const v = _getV();
  if (v) v.currentTime = sub.startTime;
});
```

**12. ✅ PASS** — 第 3579–3583 行，row 背景 click 使用 `_getV()`：
```js
row.addEventListener('click', e => {
  if (e.target.closest('.ysm-loop-btn, .yt-sub-word, .ysm-ts')) return;
  const v = _getV();
  if (v) v.currentTime = sub.startTime;
});
```

**13. ✅ PASS** — 排除選擇器為 `'.ysm-loop-btn, .yt-sub-word, .ysm-ts'`，三者均已排除，不干擾各自功能。

---

## E. 自動滾動修復

**14. ✅ PASS** — 第 3468 行，`_ysmSyncInterval` closure 內宣告：
```js
let _ysmLastActiveIdx = -1;
```
宣告位置正確，在 setInterval 外、enterSubtitleMode 內。

**15. ✅ PASS** — 第 3486 行：
```js
if (activeRow && activeIdx !== _ysmLastActiveIdx) {
```
僅在句子索引變化時觸發 scrollIntoView，避免鎖住用戶。

**16. ✅ PASS** — 第 3488 行：
```js
activeRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
```
使用 `block: 'nearest'`，不強制置中。

**17. ✅ PASS** — 第 3487 行，scroll 前先更新：
```js
_ysmLastActiveIdx = activeIdx;
```
每次 scroll 後（實際為 scroll 觸發時同步更新）確保下次比對正確。

---

## F. 生字卡功能

**18. ✅ PASS** — `_renderSubtitleModeList` 第 3536 行：
```js
buildTokenizedText(primEl, filterSubText(sub.text), sub.startTime);
```
使用 `buildTokenizedText` 而非 `textContent`，生字卡點擊功能已正確啟用。

**19. ✅ PASS** — 第 3580 行 row click handler 排除 `.yt-sub-word`，點字時不觸發跳轉，與審查項目 13 同一行確認。

---

## G. 搜尋功能

**20. ✅ PASS** — 第 3501–3505 行：
```js
function _ysmWordPrefixMatch(text, query) {
  if (!query) return true;
  const q = query.toLowerCase();
  return text.toLowerCase().split(/\s+/).some(w => w.startsWith(q));
}
```
字頭前綴比對邏輯正確。

**21. ✅ PASS** — 第 3509 行讀取 `#ysm-search` 的值，第 3514 行以 `_ysmWordPrefixMatch` 過濾，邏輯完整。

**22. ⚠️ 觀察（格式差異，非 FAIL）** — 第 3518 行搜尋計數顯示：
```js
countEl.textContent = searchQ ? `${filtered.length} / ${primarySubtitles.length} 句` : '';
```
實際輸出為 `N / 總數 句`（斜線前後有空格），審查規格描述為 `N / 總數 句`，**功能完全符合，僅格式描述略有差異**。PASS。

---

## 彙整

| 項目 | 結果 |
|------|------|
| A1–A3 z-index 修復 | ✅ ✅ ✅ |
| B4–B7 播放控制修復 | ✅ ✅ ✅ ✅（B7 附觀察） |
| C8–C10 Loop 按鈕修復 | ✅ ✅ ✅ |
| D11–D13 跳轉修復 | ✅ ✅ ✅ |
| E14–E17 自動滾動修復 | ✅ ✅ ✅ ✅ |
| F18–F19 生字卡功能 | ✅ ✅ |
| G20–G22 搜尋功能 | ✅ ✅ ✅（G22 附觀察） |

**共 22 項，全部 PASS，0 項 FAIL，2 項附觀察（不影響判定）。**

---

## 整體結論：**PASS**

所有五項修復邏輯（播放/暫停、Loop 按鈕、生字卡 z-index、點句跳轉、自動滾動）均已正確實作，代碼審查通過。
