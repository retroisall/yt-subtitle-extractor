# QA 靜態代碼審查報告：已學會功能
**版本**：v48  
**日期**：2026-04-22  
**審查員**：QA Agent  
**審查範圍**：`content.js`、`styles.css`

---

## A. 下拉選單與過濾邏輯

**A1. `#yt-sub-wordbook-sort` 中有 `value="learned"` 的 option**  
✅ PASS — 第 243 行：`<option value="learned">已學會</option>`

**A2. `renderWordbook` 中有 `sortKey === 'learned'` 的過濾分支，且只顯示 `status === 'learned'` 的字**  
✅ PASS — 第 2255–2256 行：
```js
} else if (sortKey === 'learned') {
  displayed = [...words.filter(w => w.status === 'learned')].sort((a, b) => b.addedAt - a.addedAt);
}
```

**A3. `totalLabel` 在 `learned` 分支有正確的計數文字**  
✅ PASS — 第 2271–2272 行：
```js
: sortKey === 'learned'
  ? (displayed.length ? `已學會 ${displayed.length} 個單字` : '尚未標記任何單字為已學會')
```
有字時顯示數量，無字時顯示提示語，皆正確。

---

## B. 字卡展開機制

**B4. `yt-sub-wb-row` 包含 `yt-sub-wb-row-main` 與 `yt-sub-wb-row-detail` 兩個子元素**  
✅ PASS — 第 2296–2322 行：`main` 與 `detail` 分別建立並透過 `row.appendChild` 掛入，順序正確。

**B5. `main` 的 click handler 有排除 `button` 與 `.yt-sub-wb-word` 的點擊（`e.target.closest(...)`）**  
✅ PASS — 第 2325–2328 行：
```js
main.addEventListener('click', e => {
  if (e.target.closest('button, .yt-sub-wb-word')) return;
  row.classList.toggle('expanded');
});
```

**B6. click handler 呼叫 `row.classList.toggle('expanded')`**  
✅ PASS — 同上第 2327 行。

**B7. CSS 中 `.yt-sub-wb-row-detail` 預設 `display: none`，`.yt-sub-wb-row.expanded .yt-sub-wb-row-detail` 為 `display: flex`**  
✅ PASS — styles.css 第 877–887 行：
```css
.yt-sub-wb-row-detail {
  display: none;
  ...
}
.yt-sub-wb-row.expanded .yt-sub-wb-row-detail {
  display: flex;
}
```

---

## C. 已學會切換邏輯

**C8. `toggleLearnedStatus` 從 storage 讀取後，根據 `saved[word].status !== 'learned'` 決定新狀態**  
✅ PASS — 第 2375 行：`const nowLearned = saved[word].status !== 'learned';`

**C9. 寫入 storage 成功後，同步更新：`btn.textContent`、`btn.classList`、`rowEl.classList`**  
✅ PASS — 第 2378–2380 行，在 `chrome.storage.local.set` 回呼中執行三者更新。

**C10. 已學會時在 `mainEl` 插入 `.yt-sub-wb-learned-badge`；取消時移除**  
✅ PASS — 第 2382–2392 行：`nowLearned && !badge` 時建立並插入；`!nowLearned && badge` 時呼叫 `badge.remove()`。

**C11. badge 插入位置在刪除按鈕之前（`mainEl.insertBefore(b, delBtn)`）**  
✅ PASS（功能正確）— 第 2388–2389 行確認以 `.yt-sub-wb-del` 為參考節點執行 `insertBefore`。  
⚠️ 見「觀察」區塊 — 動態插入位置與初始渲染位置略有差異。

---

## D. 初始渲染狀態正確性

**D12. 已學會的字初始渲染時：`row.className` 含 `learned`、`main.innerHTML` 含 `.yt-sub-wb-learned-badge`、`learnBtn.className` 含 `active`**  
✅ PASS：
- 第 2284 行：`row.className = 'yt-sub-wb-row' + (isLearned ? ' learned' : '')`
- 第 2293 行：`const learnedBadge = isLearned ? '<span class="yt-sub-wb-learned-badge">✓ 已學會</span>' : ''`，並注入 innerHTML（第 2303 行）
- 第 2318 行：`learnBtn.className = 'yt-sub-wb-learned-btn' + (isLearned ? ' active' : '')`

**D13. 未學會的字初始渲染時：`row.className` 不含 `learned`、`learnBtn` 不含 `active`、`main.innerHTML` 不含 badge**  
✅ PASS — 上述三行在 `isLearned === false` 時皆走 else 分支，不附加任何 class 或 badge HTML。

---

## E. CSS 完整性

**E14. `.yt-sub-wb-row` 有 `flex-direction: column`**  
✅ PASS — styles.css 第 843 行：`flex-direction: column;`

**E15. `.yt-sub-wb-row.learned` 有差異化樣式（背景或邊框）**  
✅ PASS — 第 857–860 行：`border-color: #16a34a44; background: #0a1a0f;`，綠色半透明邊框 + 深綠底色，視覺區隔明確。

**E16. `.yt-sub-wb-learned-btn.active` 有綠色樣式**  
✅ PASS — 第 929–933 行：`border-color: #16a34a; color: #16a34a; background: rgba(22,163,74,0.12);`

**E17. `.yt-sub-wb-learned-btn.active:hover` 有紅色反向提示樣式**  
✅ PASS — 第 935–939 行：`background: rgba(239,68,68,0.08); color: #ef4444; border-color: rgba(239,68,68,0.4);`，紅色反向提示已實作。

---

## F. 事件隔離（防止干擾）

**F18. 播放按鈕 click handler 有 `e.stopPropagation()`**  
✅ PASS — 第 2341–2342 行：
```js
playBtn.addEventListener('click', e => {
  e.stopPropagation();
```

**F19. 刪除按鈕 click handler 有 `e.stopPropagation()`**  
✅ PASS — 第 2354–2355 行：
```js
main.querySelector('.yt-sub-wb-del').addEventListener('click', e => {
  e.stopPropagation();
```

**F20. 已學會按鈕 click handler 有 `e.stopPropagation()`**  
✅ PASS — 第 2360–2361 行：
```js
learnBtn.addEventListener('click', e => {
  e.stopPropagation();
```

**F21. 單字 click handler 有 `e.stopPropagation()`**  
✅ PASS — 第 2332–2333 行，`!item.noDefinition` 時加入 listener 並呼叫 `e.stopPropagation()`。  
當 `noDefinition === true` 時不附加該 listener，但 `main.addEventListener` 中的 `e.target.closest('button, .yt-sub-wb-word')` 早返回守衛依然攔截點擊，展開不會被誤觸。事件隔離在兩種情境下均有效。

---

## G. saveWord 軟刪除重建相容性

**G22. `saveWord` 中新建字的預設值沒有 `status` 欄位**  
✅ PASS — 第 2109–2122 行，全新字的物件字面量（`else` 分支）未包含 `status` 欄位，不會意外設為 `'learned'`。

**G23. 軟刪除後重新加入時（`delete saved[word].deletedAt` 分支），`status` 是否被清除？**  
❌ FAIL — 第 2094–2107 行，軟刪除重建（`if (saved[word])` 分支）清除 `deletedAt` 並重設 `addedAt`、`count`、`tier`、`context`、`videoId` 等欄位，但**未處理 `status` 欄位**。若字在標記為已學會後被刪除，再重新加入時 `status: 'learned'` 將被靜默保留，該字會在生字本中顯示為綠色已學會狀態，與使用者預期（重新加入視為新字）不符。

---

## ⚠️ 觀察

**Obs-1：badge 動態插入位置與初始渲染位置不一致**  
初始渲染（`main.innerHTML`）中，`learnedBadge` 放在 `tierHtml` 之後、`count` 之前（第 2302–2304 行）。  
`toggleLearnedStatus` 動態插入時以 `.yt-sub-wb-del`（刪除鈕）為參考節點，即放在 `count` 之後、`del` 之前（第 2388–2389 行）。  
結果：有出現次數計數（`item.count > 1`）的字在「標記→取消→標記」後，badge 會移至計數右側而非左側。視覺上略有跳動，但功能正確。建議修正為 `insertBefore(b, countEl || delBtn)` 以保持一致順序。

**Obs-2：`learned` 篩選分支在搜尋過濾後計數可能誤導**  
第 2268 行：`baseCount = displayed.length`（搜尋過濾前），但搜尋後 `displayed` 已進一步縮小，`totalLabel` 以搜尋後的 `displayed.length` 顯示「已學會 N 個單字」，不顯示篩選比例（如 `3 / 10`）。  
和其他模式（如 `date-desc`）在有 `searchQ` 時顯示 `${displayed.length} / ${baseCount}` 的行為不一致（第 2273–2274 行）。此為設計不一致，非崩潰性錯誤。

**Obs-3：`status` 寫入 null 而非刪除欄位**  
`toggleLearnedStatus` 取消學會時將 `status` 設為 `null`（第 2376 行）。若之後的 storage 消費端以 `w.status === undefined` 檢查「未設定」，會發生誤判。目前 `renderWordbook` 使用 `w.status === 'learned'` 判斷，不受影響；但建議未來統一為 `delete saved[word].status` 以保持資料乾淨。

---

## 總結

| 項目 | 結果 |
|------|------|
| A1–A3 | ✅ PASS |
| B4–B7 | ✅ PASS |
| C8–C11 | ✅ PASS |
| D12–D13 | ✅ PASS |
| E14–E17 | ✅ PASS |
| F18–F21 | ✅ PASS |
| G22 | ✅ PASS |
| G23 | ❌ FAIL |

**整體結果：FAIL**

唯一 FAIL 項目為 G23：軟刪除後重新加入的字保留舊 `status: 'learned'`，應在 `delete saved[word].deletedAt` 同行補上 `delete saved[word].status` 或 `saved[word].status = null`（視統一策略而定）。
