# tests/（Playwright E2E 測試目錄）

## 基本資訊

| 項目 | 值 |
|------|-----|
| 路徑 | `tests/` |
| 檔案數 | 20 個 `.mjs` 測試腳本 |
| 框架 | Playwright（headed Chrome + 真實套件載入） |
| 執行環境 | Node.js，依賴 [[package]] 中的 `playwright` 套件 |

## 功能說明

所有 E2E 自動化測試腳本。使用 Playwright 啟動帶套件的真實 Chrome，透過 CDP（Chrome DevTools Protocol）存取擴充套件的 isolated world，驗證字幕模式、Overlay、生字本、存儲持久化等功能。

---

## 關鍵技術：CDP 存取 Isolated World

```js
// Content Script 跑在 isolated world，page.evaluate() 無法存取 chrome.*
// 必須用 CDP Runtime.evaluate + contextId
const client = await context.newCDPSession(page);
await client.send('Runtime.enable');

// 必須在 page.goto() 之前訂閱，否則漏掉事件
const ctxId = await new Promise(resolve => {
  client.on('Runtime.executionContextCreated', event => {
    if (event.context.name === 'YT Subtitle Demo')
      resolve(event.context.id);
  });
});

// 再 goto
await page.goto(url);

// 用 contextId 操作 chrome.storage.local
await client.send('Runtime.evaluate', {
  expression: `new Promise(res => chrome.storage.local.set({key: 'val'}, res))`,
  contextId: ctxId,
  awaitPromise: true,
});
```

---

## 測試腳本清單

### 功能驗證類

| 腳本 | 行數 | 說明 |
|------|------|------|
| `qa-subtitle-mode.mjs` | 406 | 字幕模式完整測試（T1-T21，20 項自動化）：本地字幕還原、切換模式、搜尋、循環、時間跳轉、退出 |
| `qa-subtitle-mode-loop-click.mjs` | 357 | 字幕模式循環按鈕點擊專項測試 |
| `qa-subtitle-display.mjs` | 339 | 字幕顯示邏輯驗證 |
| `qa-loop-overlay-fixes.mjs` | 387 | Loop + Overlay 修復後的回歸測試 |
| `qa-wordbook-popup-v48.mjs` | 310 | 生字本 Popup（v48 版本）驗證 |
| `qa_custom_overlay.mjs` | 355 | 自定義 Overlay 字幕測試 |
| `qa_edit_mode.mjs` | 657 | 編輯模式完整測試 |
| `qa_overlay_fix.mjs` | 176 | Overlay 修復回歸測試 |
| `qa_wordbook_highlight.mjs` | 529 | 生字本高亮功能測試 |

### 功能行為驗證類

| 腳本 | 行數 | 說明 |
|------|------|------|
| `test-lang-behavior.mjs` | 380 | 字幕主語言選取邏輯驗證 |
| `test-nav-btn-real.mjs` | 420 | Overlay 上一句/下一句按鈕（真實影片） |
| `test-nav-btn.mjs` | 360 | Overlay 導覽按鈕基本測試 |
| `test-prev-btn-playing.mjs` | 519 | 播放中的上一句按鈕行為 |
| `test-secondary-translation.mjs` | 186 | 副字幕翻譯載入驗證 |
| `test-storage-persist-v2.mjs` | 288 | chrome.storage 讀寫與重新整理持久化（v2，使用改進的 helper） |
| `test-storage-persist.mjs` | 290 | chrome.storage 讀寫持久化（v1） |

### Debug 工具類

| 腳本 | 行數 | 說明 |
|------|------|------|
| `debug-t3.mjs` | 66 | 快速 debug T3（Popup 偵測） |
| `debug-t3-v2.mjs` | 52 | T3 debug 改版 |
| `inspect-yt-popup.mjs` | 47 | 檢測 YouTube popup 元件狀態 |
| `extract-yt-cookies.mjs` | 100 | 從本機 Chrome 擷取 YouTube cookies，輸出 Playwright 可用的 JSON 格式 |

---

## 執行方式

```bash
# 安裝依賴（首次）
cd "d:\dev\chrome字幕套件開發"
npm install
npx playwright install chromium

# 執行單一測試
node tests/qa-subtitle-mode.mjs
node tests/test-storage-persist-v2.mjs
node tests/test-lang-behavior.mjs
```

---

## 常見錯誤與守則

| 錯誤 | 原因 | 正確做法 |
|------|------|---------|
| `chrome is not defined` | 用 `page.evaluate` 呼叫 `chrome.*` | 改用 CDP + contextId |
| `waitForExtContext` 永遠 null | 在 `page.goto` 之後才訂閱事件 | 先訂閱事件，再 `page.goto` |
| 字幕請求失敗（pot token） | headless 模式缺少 pot token | 改用本地字幕 (`editedSubtitles_<videoId>`) 繞過 |

---

## 反向依賴

- [[package]] — 提供 Playwright 依賴
- [[content]] — 所有測試的目標模組
- [[docs]] — QA 報告記錄測試結果

---

## 相關

- [[test-tools]]
- [[qa_batch_test]]
- [[docs]]
- [[package]]
- [[content]]
- [[專案索引]]
