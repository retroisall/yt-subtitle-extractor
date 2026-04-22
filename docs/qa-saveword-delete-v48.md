# QA 靜態代碼審查報告：生字本新增／刪除邏輯
**日期**：2026-04-22
**對象**：`d:\dev\chrome字幕套件開發\content.js`
**版本**：v48（修正「刪除後無法重新加入相同單字」bug 後）

---

## 檢查 1：`alreadySaved` 判斷是否正確排除軟刪除

**位置**：`content.js` 第 2090 行

```js
const alreadySaved = !!saved[word] && !saved[word].deletedAt;
```

**結論**：✅ PASS

判斷式同時確認 key 存在且 `deletedAt` 為 falsy，軟刪除的字會被正確視為「未存在」。

---

## 檢查 2：軟刪除後重新加入流程

**位置**：`content.js` 第 2091–2105 行

```js
if (!alreadySaved) {
  if (saved[word]) {
    // 曾被軟刪除：清除刪除標記，重設時間與計數
    delete saved[word].deletedAt;   // ✓ 清除 deletedAt
    saved[word].addedAt = Date.now(); // ✓ 重設 addedAt
    saved[word].count = 1;            // ✓ 重設 count = 1
    ...
  }
}
```

**結論**：✅ PASS

三個必要動作（`delete deletedAt`、`addedAt = Date.now()`、`count = 1`）均已實作，條件分支為 `!alreadySaved && saved[word]`，符合預期。

---

## 檢查 3：`deleteWord` 軟刪除流程

**位置**：`content.js` 第 2331–2342 行

```js
function deleteWord(word, rowEl) {
  chrome.storage.local.get(SAVED_WORDS_KEY, data => {
    const saved = data[SAVED_WORDS_KEY] || {};
    if (saved[word]) saved[word].deletedAt = Date.now(); // ✓ 設定 deletedAt
    chrome.storage.local.set({ [SAVED_WORDS_KEY]: saved }, () => {
      _savedWordSet.delete(word); // ✓ 立即從 Set 移除
      ...
    });
  });
}
```

**結論**：✅ PASS

`deletedAt = Date.now()` 在 `storage.set` 之前設定，`_savedWordSet.delete(word)` 在 storage 寫入成功的 callback 中立即執行，順序正確。

---

## 檢查 4：`refreshSavedWordSet` 過濾軟刪除

**位置**：`content.js` 第 2057–2065 行

```js
function refreshSavedWordSet() {
  chrome.storage.local.get(SAVED_WORDS_KEY, data => {
    const saved = data[SAVED_WORDS_KEY] || {};
    _savedWordSet = new Set(
      Object.values(saved).filter(w => !w.deletedAt).map(w => w.word) // ✓ 過濾軟刪除
    );
    patchSavedWordHighlights();
  });
}
```

**結論**：✅ PASS

建立 Set 時已用 `.filter(w => !w.deletedAt)` 排除軟刪除項目。

---

## 檢查 5：`renderWordbook` 過濾軟刪除

**位置**：`content.js` 第 2233 行

```js
const words = Object.values(saved).filter(w => !w.deletedAt); // 排除軟刪除
```

**結論**：✅ PASS

在進入排序與渲染邏輯之前，已先過濾 `deletedAt` 非空的項目，軟刪除的字不會出現在生字本列表中。

---

## 檢查 6：`showWordPopup` 內「加入生字本」按鈕的 `alreadySaved` 狀態

**位置**：`content.js` 第 1914 行（`renderPopupContent` 函式內）

```js
const alreadySaved = _savedWordSet.has(result.word.toLowerCase());
```

**結論**：✅ PASS

使用 `_savedWordSet.has()` 而非直接讀 storage。
因 `deleteWord` 在成功後立即執行 `_savedWordSet.delete(word)`，Set 狀態與 storage 同步，判斷準確。
注意：popup 使用 `result.word.toLowerCase()`，而 Set 內儲存的是 `word`（由 `saveWord` 傳入，通常為小寫）。若大小寫一致則無問題；若有混用大小寫的場景，需確認 `saveWord` 傳入的 key 一律小寫（此問題超出本次審查範圍，暫列觀察）。

---

## 檢查 7：重新加入後 `_savedWordSet` 同步

**位置**：`content.js` 第 2141 行

```js
_savedWordSet.add(word); // 即時更新 Set，不等 storage 重讀
```

**結論**：✅ PASS

`_savedWordSet.add(word)` 在 `chrome.storage.local.set` 的成功 callback 中執行，確保 storage 寫入成功後才更新 Set，高亮狀態即時反映。

---

## 整體結論

**整體：PASS**

全部 7 項檢查均通過。修正後的邏輯正確解決「軟刪除後無法重新加入相同單字」的根因：
- `alreadySaved` 已考量 `deletedAt`
- 重新加入時正確清除 `deletedAt` 並重設時間與計數
- `deleteWord`、`refreshSavedWordSet`、`renderWordbook` 三處均一致過濾軟刪除
- popup 使用 Set 判斷（即時準確）
- storage 成功後 Set 立即同步

**附加觀察（非阻斷性）**：`showWordPopup` 使用 `result.word.toLowerCase()` 查 Set，`saveWord` 中 `_savedWordSet.add(word)` 的 `word` 若含大寫字母，可能導致 popup 顯示「加入生字本」而非「已在生字本」。建議統一在 `saveWord` 入口處將 `word` 轉為小寫，確保 Set key 一致。
