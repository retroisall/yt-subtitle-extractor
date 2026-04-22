# QA 靜態代碼審查報告：「已學會」功能 (v48)

**審查對象**：`d:\dev\chrome字幕套件開發\content.js` + `styles.css`
**審查日期**：2026-04-22
**審查方法**：靜態分析（Grep + Read，無執行）

---

## A. _learnedWordSet 建立與維護

**1. `let _learnedWordSet = new Set()` 宣告存在**
✅ PASS — 第 2117 行：`let _learnedWordSet = new Set();`，緊跟在 `_savedWordSet` 宣告後。

**2. `refreshSavedWordSet` 中 `_learnedWordSet` 只包含 `!deletedAt && status === 'learned'` 的字**
✅ PASS — 第 2123–2125 行：
```js
const active = Object.values(saved).filter(w => !w.deletedAt);
_savedWordSet  = new Set(active.map(w => w.word));
_learnedWordSet = new Set(active.filter(w => w.status === 'learned').map(w => w.word));
```
先過濾 `!deletedAt`（active），再篩 `status === 'learned'`，邏輯正確。

**3. `toggleLearnedStatus` 成功寫入 storage 後有 `_learnedWordSet.add` / `.delete`**
✅ PASS — 第 2446–2447 行，在 `chrome.storage.local.set` callback 內正確更新。

**4. `_popupLearnBtnHandler` 成功寫入 storage 後有 `_learnedWordSet.add` / `.delete`**
✅ PASS — 第 1975–1976 行，在 `chrome.storage.local.set` callback 內正確更新。

---

## B. renderPopupContent 按鈕渲染

**5. `alreadySaved` 用 `_savedWordSet.has(wordKey)`，`wordKey = result.word.toLowerCase()`**
✅ PASS — 第 1915–1916 行：
```js
const wordKey = result.word.toLowerCase();
const alreadySaved = _savedWordSet.has(wordKey);
```

**6. `alreadyLearned` 用 `_learnedWordSet.has(wordKey)`**
✅ PASS — 第 1917 行：`const alreadyLearned = _learnedWordSet.has(wordKey);`

**7. 已存入時渲染 `.yt-sub-popup-action-row`，內含 `.yt-sub-popup-save-btn` 與 `.yt-sub-popup-learn-btn`**
✅ PASS — 第 1929–1936 行：`.yt-sub-popup-action-row` 永遠渲染；`.yt-sub-popup-learn-btn` 在 `alreadySaved` 為 true 時以模板字串插入。

**8. 未存入時只渲染 `.yt-sub-popup-save-btn`（無 `.yt-sub-popup-learn-btn`）**
✅ PASS — 第 1933 行：`${alreadySaved ? \`<button class="yt-sub-popup-learn-btn...\` : ''}` ，未存入時為空字串。

**9. `.yt-sub-popup-learn-btn` 的 `data-word` 是小寫（`wordKey`，非 `result.word`）**
✅ PASS — 第 1933 行：`data-word="${escapeHtml(wordKey)}"` ，`wordKey` 已經 `.toLowerCase()`。

**10. `.yt-sub-popup-learn-btn` 初始時若 `alreadyLearned` 則有 `active` class**
✅ PASS — 第 1933 行：`class="yt-sub-popup-learn-btn${alreadyLearned ? ' active' : ''}"` 。

---

## C. 存入後動態插入已學會按鈕

**11. 加入生字本按鈕的 click handler 中，存入後若 `.yt-sub-popup-learn-btn` 不存在，動態建立並 append**
✅ PASS — 第 1948–1954 行：
```js
if (!popup.querySelector('.yt-sub-popup-learn-btn')) {
  const lb = document.createElement('button');
  lb.className = 'yt-sub-popup-learn-btn';
  lb.dataset.word = w.toLowerCase();
  lb.textContent = '已學會';
  lb.addEventListener('click', _popupLearnBtnHandler);
  e.currentTarget.parentElement.appendChild(lb);
}
```
確認存在、建立、append 到 `.yt-sub-popup-action-row`（`parentElement`）。

**12. 動態建立的按鈕有綁定 `_popupLearnBtnHandler`**
✅ PASS — 第 1953 行：`lb.addEventListener('click', _popupLearnBtnHandler);`

---

## D. _popupLearnBtnHandler 邏輯

**13. 從 storage 讀到 `saved[w]` 不存在時 early return，不做任何操作**
✅ PASS — 第 1970 行：`if (!saved[w]) return;`

⚠️ 觀察（D-13）：early return 只檢查 `!saved[w]`，未檢查 `saved[w].deletedAt`。若使用者在 popup 開啟期間從生字本刪除該單字（軟刪除），`saved[w]` 仍存在但有 `deletedAt`，handler 會繼續執行並更新 status，實質上會「復活」一筆已軟刪除字目的學習狀態。在常見使用情境下發生機率低，但屬邊緣情況設計缺陷。

**14. `nowLearned = saved[w].status !== 'learned'`，切換邏輯正確**
✅ PASS — 第 1971 行：`const nowLearned = saved[w].status !== 'learned';`

**15. 寫入 storage 成功後更新 `btn.textContent` 與 `btn.classList`**
✅ PASS — 第 1977–1978 行：
```js
btn.textContent = nowLearned ? '✓ 已學會' : '已學會';
btn.classList.toggle('active', nowLearned);
```

**16. 寫入 storage 成功後嘗試同步 wordbook 列表中對應的 row（查找 `.yt-sub-wb-del[data-word]`）**
✅ PASS — 第 1980–1998 行：查找 `#yt-sub-wordbook-list`，使用 `.yt-sub-wb-del[data-word="${CSS.escape(w)}"]` 定位 row，並更新 `.yt-sub-wb-learned-btn`、row class、badge 等，邏輯完整。

---

## E. toggleLearnedStatus 同步 popup

**17. `toggleLearnedStatus` 成功後嘗試查找 `#yt-sub-word-popup`**
✅ PASS — 第 2449 行：`const openPopup = document.getElementById('yt-sub-word-popup');`

**18. 只有在 popup 顯示中（`display !== 'none'`）且 `popup.dataset.word === word` 時才更新**
✅ PASS — 第 2450 行：
```js
if (openPopup?.style.display !== 'none' && openPopup?.dataset.word === word)
```

**19. 更新 popup 內 `.yt-sub-popup-learn-btn` 的 `textContent` 與 `classList`**
✅ PASS — 第 2453–2454 行：
```js
popupLearnBtn.textContent = nowLearned ? '✓ 已學會' : '已學會';
popupLearnBtn.classList.toggle('active', nowLearned);
```

---

## F. CSS 完整性

**20. `.yt-sub-popup-action-row` 為 `display: flex` 橫排**
✅ PASS — styles.css 第 1417–1421 行：`display: flex; gap: 8px; margin-top: 12px;`

**21. `.yt-sub-popup-save-btn` 有 `flex: 1`（與已學會按鈕平分寬度）**
✅ PASS — styles.css 第 1425 行：`flex: 1;`

**22. `.yt-sub-popup-learn-btn` 有 `flex: 1`**
✅ PASS — styles.css 第 1449 行：`flex: 1;`

**23. `.yt-sub-popup-learn-btn.active` 有綠色樣式**
✅ PASS — styles.css 第 1466–1470 行：`border-color: #16a34a; color: #16a34a; background: rgba(22, 163, 74, 0.12);`

**24. `.yt-sub-popup-learn-btn.active:hover` 有紅色反向提示**
✅ PASS — styles.css 第 1471–1475 行：`background: rgba(239, 68, 68, 0.08); color: #ef4444; border-color: rgba(239, 68, 68, 0.4);`

---

## G. 潛在 bug 檢查

**25. `_popupLearnBtnHandler` 使用 `CSS.escape(w)` 防止 word 含特殊字元時 querySelector 崩潰**
✅ PASS — 第 1982 行：
```js
const row = listEl.querySelector(`.yt-sub-wb-del[data-word="${CSS.escape(w)}"]`)?.closest('.yt-sub-wb-row');
```
有正確使用 `CSS.escape(w)`。

**26. `data-word` 在 popup learn btn 與 del btn 的 attribute 名稱是否一致（都用 `data-word`）**
✅ PASS — popup learn btn（第 1933 行）用 `data-word`；wordbook del btn（第 2371 行）用 `data-word="${escapeHtml(item.word)}"`，attribute 名稱一致。

**27. wordbook row 的 `.yt-sub-wb-del` 的 `data-word` 值是否與 saveWord 存入的 key（小寫）相同**
✅ PASS — `saveWord` 第 2142 行：`word = word.toLowerCase();`，storage key 為小寫；`renderWordbook` 使用 `Object.values(saved)` 取得的 `item.word` 即為 storage 內的小寫 key，del btn 的 `data-word` 因此也是小寫，與 popup learn btn 的 `w`（小寫 wordKey）一致。

---

## 附加觀察

⚠️ 觀察（save-btn data-word 大小寫）：`.yt-sub-popup-save-btn` 的 `data-word` 使用 `result.word`（第 1930 行，非小寫），而非 `wordKey`。Handler 在第 1942 行讀取後傳入 `saveWord(w, ...)`，`saveWord` 內部再 toLowerCase，所以功能無誤。但動態插入 learn-btn 時（第 1951 行）明確 `lb.dataset.word = w.toLowerCase()`，說明開發者也注意到此問題。save-btn 的 data-word 保留大小寫混用，若日後有其他地方直接使用該屬性值做字典 key 查詢，需特別注意。

---

## 整體結論

**整體 PASS**

27 項審查項目全數通過。發現 2 項 ⚠️ 觀察（非 FAIL）：
1. `_popupLearnBtnHandler` 未檢查 `deletedAt`（D-13），屬邊緣情境設計缺陷，建議後續版本補上 `if (saved[w]?.deletedAt) return;`。
2. `.yt-sub-popup-save-btn` 的 `data-word` 保留原始大小寫，與 learn-btn 的 `data-word`（強制小寫）不一致，目前不影響功能，但建議統一為小寫以降低未來維護風險。
