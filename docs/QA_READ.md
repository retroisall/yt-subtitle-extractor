# Chrome 套件 QA 審查清單

每次功能完成後，QA agent 必須逐項核對此清單，全部通過才可回報開發者。

---

## A. Manifest 層（每次有新 API 或 storage 操作時必查）

- [ ] **permissions** — 有用到 `chrome.storage` 嗎？有宣告 `"storage"` 嗎？
- [ ] **host_permissions** — 所有外部 API（字典、翻譯、詞頻…）都在清單中嗎？
- [ ] **content_scripts.world** — 需要 `chrome.*` API 的腳本，是否確認沒有 `"world": "MAIN"`？
- [ ] **web_accessible_resources** — 動態注入的腳本是否已宣告？

---

## B. Chrome API 使用

- [ ] **chrome.storage callback 有無檢查 `chrome.runtime.lastError`？**
- [ ] **storage key 一致** — `get` 和 `set` 使用的 key 名稱相同？
- [ ] **storage 資料結構** — 寫入和讀取的欄位名稱一致（不會因 typo 靜默讀到 undefined）？

---

## C. DOM 事件

- [ ] **contextmenu / click 是否可能被父層或 YouTube 自身的 capture handler 攔截？**
  - 若有 `stopPropagation`，確認是否需要改為 `stopImmediatePropagation`
  - 若頁面可能有 capture phase handler，listener 是否用 `capture: true` 優先搶佔？
- [ ] **pointer-events** — 目標 span 是否被 CSS 或父層設為 `pointer-events: none`？
- [ ] **z-index 覆蓋** — 是否有透明 overlay 蓋在目標元素上，導致事件打不到？

---

## D. 非同步邏輯

- [ ] **重複 API 呼叫防護** — 快取 / flag 是否正確避免重複打 API？
- [ ] **Promise.all 並行呼叫** — 各請求失敗時不影響彼此的結果？
- [ ] **null / undefined 區分** — 「尚未查詢」和「查詢後無結果」是否用不同值表示，不會觸發無限重試？

---

## E. CSS 佈局

- [ ] **flex 子元素** — `flex: 1` 的元素有設 `min-width: 0`，防止長內容溢出？
- [ ] **不縮小元素** — badge、按鈕等小元素有設 `flex-shrink: 0`？
- [ ] **class 命名** — JS 中插入的 className 和 CSS 選擇器拼字一致？

---

## F. 靜態驗證（每次必做）

- [ ] `node --check content.js` → 語法無誤
- [ ] 搜尋 `undefined` 字串是否出現在 innerHTML（class="undefined" 等）
- [ ] 所有新增函式是否在使用前已定義（或有 hoisting）？

---

## G. 功能邏輯（依本次改動決定）

- [ ] 新功能的正常流程（happy path）邏輯正確？
- [ ] Edge case：空資料、cache miss、API 失敗，有無 fallback 或 guard？
- [ ] 互斥 UI（如設定面板 vs 生字本面板）開關邏輯正確，不會同時顯示？

---

## 第一次 QA 漏掉 manifest 的事後說明

**Root cause：** 第一次審查聚焦在 JavaScript 邏輯層，沒有主動去讀 `manifest.json`。  
`chrome.storage` 的呼叫語法本身正確，所以 JS 層看不出問題；錯誤發生在更外層的 manifest 權限宣告，屬於「跨檔案的依賴關係」，純看 content.js 無法察覺。

**改進：** 本清單第 A 節「Manifest 層」已列為必查項目，且明確標注「每次有新 API 或 storage 操作時必查」，之後不會再漏。
