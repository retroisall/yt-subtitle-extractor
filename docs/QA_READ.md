# Chrome 字幕套件 QA 完整測試清單

每次功能異動後，QA 必須：
1. 先跑 **Part 1（靜態代碼檢查）**
2. 再跑 **Part 2（使用者情境測試）**中受影響的模組
3. 全部通過才可回報開發者

**測試原則：所有測試必須在真實 YouTube 影片上進行，禁止注入假字幕。**

---

## Part 1：靜態代碼檢查（每次必做）

### A. Manifest 層
- [ ] 新用到的 `chrome.*` API 有在 `permissions` 宣告？
- [ ] 外部 API domain 有在 `host_permissions` 宣告？
- [ ] 需要 `chrome.*` 的腳本確認不在 `"world": "MAIN"`？
- [ ] 動態注入的腳本有在 `web_accessible_resources` 宣告？

### B. Chrome API
- [ ] 所有 `chrome.storage` callback 有檢查 `chrome.runtime.lastError`？
- [ ] `chrome.runtime.sendMessage` callback 有檢查 `chrome.runtime.lastError`？
- [ ] storage key 的 `get` 和 `set` 名稱一致？

### C. DOM 事件
- [ ] 新增的 click/contextmenu listener，是否可能被 YouTube capture handler 搶先？
- [ ] 有沒有用 `pointer-events: none` 的元素誤擋了事件？

### D. 語法與靜態
- [ ] `node --check content.js` → 無語法錯誤
- [ ] `grep 'undefined'` 搜尋 innerHTML 中有無 `class="undefined"` 等錯誤插值
- [ ] 新增函式在使用前已定義或 hoisting 可用？

---

## Part 2：使用者情境測試

### 測試環境
- 使用 headed Chrome（非 headless）
- 必須等待擴充功能真正從 YouTube 載入字幕後才開始互動
- 每個測試項目記錄：情境、操作步驟、預期結果、實際結果

---

### 模組 1：初次啟用 / Onboarding

| # | 情境 | 操作 | 預期結果 |
|---|------|------|---------|
| 1-1 | 第一次安裝 | 打開 YouTube /watch 頁面 | Onboarding 對話框出現，顯示「Step 1：選擇學習語言」 |
| 1-2 | Step 1 選語言 | 點選「英文」→ 點「下一步」 | 進入 Step 2，進度條更新為 2/2 |
| 1-3 | Step 2 選母語 | 點選「繁體中文」→ 點「完成設定」 | 對話框關閉，字幕開始自動載入 |
| 1-4 | 重新設定 | 設定面板→「重新設定」 | Onboarding 重新出現，允許修改語言 |
| 1-5 | Step 2 返回 | 在 Step 2 點「上一步」 | 回到 Step 1，之前選的學習語言仍被選中 |

---

### 模組 2：字幕載入與語言選擇

測試影片需求：
- **有多語字幕的影片**（如英文影片附有英/日/中手動字幕）
- **只有 ASR 的影片**（自動產生字幕）
- **無字幕影片**

| # | 情境 | 操作 | 預期結果 |
|---|------|------|---------|
| 2-1 | 自動載入主字幕 | 開啟有英文字幕的影片 | 字幕列表自動填入，語言下拉顯示「英文」 |
| 2-2 | 語言偏好不支援時 | 設定主語言為「日文」，開啟無日文但有英文字幕的影片 | 不強制翻譯，狀態列顯示「此影片無日文字幕」 |
| 2-3 | 語言偏好不支援，但有相同語系 ASR | 設定主語言為「日文」，開啟有日文 ASR 的影片 | 自動以日文 ASR 字幕作為主字幕 |
| 2-4 | 切換字幕語言 | 在語言下拉選擇另一個語言 | 字幕列表重新載入為新語言，舊字幕清除 |
| 2-5 | 無字幕影片 | 開啟一部無任何字幕的影片 | 狀態列顯示「此影片沒有可用字幕」，LED 顯示紅叉 |
| 2-6 | 重新載入字幕 | 點 Header 的 ↺ 重新載入按鈕 | 字幕清空，重新從 YouTube 取得，狀態顯示「重新載入中...」→「找到 N 個字幕語言」 |

---

### 模組 3：副字幕 / 雙語模式

| # | 情境 | 操作 | 預期結果 |
|---|------|------|---------|
| 3-1 | 啟用副字幕 | 勾選「顯示對照副字幕」 | 副字幕語言選單出現，字幕列表每句下方顯示副字幕 |
| 3-2 | 切換副字幕語言 | 在副字幕選單選擇「繁體中文」 | 副字幕更新為繁中翻譯 |
| 3-3 | 關閉副字幕 | 取消勾選「顯示對照副字幕」 | 副字幕消失，字幕列表只顯示主字幕 |
| 3-4 | 設定面板副字幕選單有內容 | 開啟設定面板 | 副字幕語言選單有選項（非空白） |

---

### 模組 4：字幕列表互動

測試需要：已載入英文字幕的影片

| # | 情境 | 操作 | 預期結果 |
|---|------|------|---------|
| 4-1 | Active 字幕高亮 | 播放影片 | 當前播放句子在列表中高亮，並自動捲動到中央 |
| 4-2 | Hover 凍結捲動 | 鼠標停在字幕列表上 | 列表停止自動捲動，方便互動 |
| 4-3 | 點擊單字查字典 | 點擊英文字幕中的一個單字 | 字典 Popup 出現，顯示 IPA、定義、中文翻譯 |
| 4-4 | 右鍵單字加入生字本 | 右鍵點擊英文單字 | Toast 出現「[word]已加入生字本」，再切換到生字本面板確認有該單字 |
| 4-5 | 右鍵相同單字再次儲存 | 對同一個單字再次右鍵 | Toast 顯示「[word]已在生字本」，count 遞增 |
| 4-6 | 點擊句子文字區啟動循環 | 點擊字幕句子的非單字區域 | 該句開始循環，區塊顯示 looping 樣式 |
| 4-7 | 再次點擊停止循環 | 在循環中點擊同一句文字區 | 循環停止，looping 樣式消失 |

---

### 模組 5：Overlay 浮動字幕

測試需要：Overlay 已啟用 + 影片有字幕

| # | 情境 | 操作 | 預期結果 |
|---|------|------|---------|
| 5-1 | Overlay 出現 | 啟用 Overlay 開關，播放有字幕的影片 | 字幕浮現在影片上方，YouTube 原生字幕消失 |
| 5-2 | > 按鈕跳下一句 | 連續點擊 > 五次 | 每次跳到不同的下一句，不循環同一句（Console 確認 base 遞增）|
| 5-3 | < 按鈕跳上一句 | 連續點擊 < 三次 | 每次跳到不同的上一句，base 遞減 |
| 5-4 | > 到最後一句 | 跳到字幕最後一句後繼續按 > | 停在最後一句，不越界 |
| 5-5 | < 在第一句按 | 跳到第一句後繼續按 < | 停在第一句，不越界 |
| 5-6 | 點擊 Overlay 背版啟動循環 | 點擊非單字區域 | 當前句子開始循環，背版顯示 looping 樣式 |
| 5-7 | 再次點擊停止循環 | 在循環中點擊背版 | 循環停止 |
| 5-8 | 點 > 取消循環 | 循環中點 > | 循環停止，跳到下一句 |
| 5-9 | CC 按鈕控制 Overlay | 點 YouTube 播放器的 CC 字幕按鈕 | Overlay 字幕隨之開關（而非原生字幕） |
| 5-10 | 展開 Sidebar 強制劇院模式 | 影片非劇院模式下展開 Sidebar | 自動切到劇院模式，影片與 Sidebar 不重疊 |
| 5-11 | 收合 Sidebar 還原劇院模式 | 收合 Sidebar | 劇院模式還原為一般模式 |

---

### 模組 6：生字本

| # | 情境 | 操作 | 預期結果 |
|---|------|------|---------|
| 6-1 | 切換到生字本面板 | 點「生字本」頁籤 | 顯示當前影片已儲存的單字列表 |
| 6-2 | 篩選排序 | 切換排序為「最近加入」 | 列表重新排列 |
| 6-3 | 點擊單字查字典 | 點生字本中的單字名稱 | 字典 Popup 出現 |
| 6-4 | 播放該句按鈕 | 點 ▶ 按鈕（同影片） | 影片跳到該句並播放 |
| 6-5 | 刪除單字 | 點 × 刪除按鈕 | 單字從列表消失（平滑動畫），重新渲染後不再出現 |
| 6-6 | 循環按鈕 | 點 ⇄ 循環按鈕 | 當前句子開始循環，按鈕變 active；再次點擊停止 |

---

### 模組 7：設定面板

| # | 情境 | 操作 | 預期結果 |
|---|------|------|---------|
| 7-1 | 字體大小切換 | 點「大」字體按鈕 | 字幕列表字體立即變大 |
| 7-2 | 副字幕顏色切換 | 點青色色塊 | 副字幕顏色立即變青色 |
| 7-3 | 啟用延長字幕顯示 | 勾選「延長字幕顯示時間」 | 字幕結束後下一句之前的空隙仍顯示前一句 |
| 7-4 | 時間偏移滑桿 | 拖動到 +2.0s | 字幕延後 2 秒顯示，顯示值更新 |
| 7-5 | 關閉 Overlay | 取消勾選「影片浮動字幕」 | Overlay 消失，YouTube 原生字幕恢復 |
| 7-6 | 關閉點擊跳轉 | 取消勾選「點擊字幕跳轉」 | 點擊時間戳不觸發跳轉 |

---

### 模組 8：社群字幕

| # | 情境 | 操作 | 預期結果 |
|---|------|------|---------|
| 8-1 | 有社群字幕時按鈕狀態 | 開啟有社群字幕的影片 | 社群字幕按鈕 badge 顯示數量，按鈕可點擊 |
| 8-2 | 點擊社群字幕按鈕（有資料） | 點「👥 社群字幕」 | 彈出 Picker 面板，列出所有版本（不出現 alert 或 dialog） |
| 8-3 | 選擇社群字幕 | 點 Picker 中某一項 | Picker 關閉，字幕列表更新，狀態列顯示來源名稱，按鈕轉紫色 |
| 8-4 | 無社群字幕時按鈕狀態 | 開啟無社群字幕的影片 | 按鈕 disabled（灰色），badge 顯示 0 |
| 8-5 | 無社群字幕時點擊（不應 disabled 失效） | 假設 badge>0 但 Firestore 回傳空 | 狀態列顯示錯誤訊息，**不出現原生 alert/dialog** |
| 8-6 | 重新開啟同影片自動套用 | 切換到其他影片再切回 | 上次選的社群字幕自動套用 |

---

### 模組 9：自定義字幕

| # | 情境 | 操作 | 預期結果 |
|---|------|------|---------|
| 9-1 | 開啟編輯器 | 點「✏ 自定義字幕」按鈕 | 新分頁開啟 editor.html，顯示當前字幕內容 |
| 9-2 | 儲存本地並套用 | 在編輯器修改一句→「儲存本地」 | YT 頁面字幕即時更新，狀態列顯示「自定義字幕（本地）」 |
| 9-3 | 自定義字幕期間 YT 字幕不覆蓋 | 使用自定義字幕時播放影片 | YT 原生字幕不會覆蓋自定義內容 |

---

### 模組 10：Google 帳號 & 雲端同步

| # | 情境 | 操作 | 預期結果 |
|---|------|------|---------|
| 10-1 | 未登入狀態 | 檢查 Header | 顯示灰色人頭圖示，無雲端同步按鈕 |
| 10-2 | 登入流程 | 點 G 按鈕 → 完成 OAuth | 按鈕轉紫色，雲端同步按鈕出現 |
| 10-3 | 雲端同步 | 先加幾個單字，點 ⟳ 同步按鈕 | LED 顯示 syncing，完成後恢復；Firestore 確認有資料 |
| 10-4 | 登出 | 點帳號按鈕 → 點「登出」 | 恢復灰色人頭，雲端按鈕消失 |

---

### 模組 11：SPA 頁面切換

| # | 情境 | 操作 | 預期結果 |
|---|------|------|---------|
| 11-1 | 切換到其他影片 | 點推薦影片切換 | 字幕清空，新影片字幕重新載入，狀態重置 |
| 11-2 | 從 /watch 切到首頁 | 點 YouTube Logo 返回首頁 | Sidebar 收合，LED 轉 idle |
| 11-3 | 循環狀態跨頁重置 | 循環中切換影片 | 新影片不繼承循環狀態 |
| 11-4 | 自定義字幕跨頁重置 | 使用自定義字幕時切換影片 | 新影片從 YT 取得字幕，不沿用舊的自定義字幕 |

---

### 模組 12：邊界情境（Edge Cases）

| # | 情境 | 操作 | 預期結果 |
|---|------|------|---------|
| 12-1 | 右鍵在 Overlay 字幕 | 對 Overlay 中的單字右鍵 | 儲存成功，**不出現瀏覽器原生右鍵選單被 YouTube 攔截** |
| 12-2 | 右鍵在列表字幕 | 對列表中的單字右鍵 | 儲存成功 |
| 12-3 | > 按鈕連按 5 次 | 快速連點 > 五次 | 每次都跳到不同的下一句（base index 遞增） |
| 12-4 | 字典 Popup 超出螢幕 | 對靠近右邊界的單字點擊 | Popup 自動往左偏移，不超出螢幕 |
| 12-5 | 字幕時間偏移後的循環 | 設定偏移 +2s，啟動循環 | 循環仍在正確時間段重播 |
| 12-6 | 無網路時查字典 | 斷網後點擊單字 | 顯示錯誤或從 cache 取得結果，不 crash |

---

## Part 3：回歸確認（有改動時才做）

每次修改某模組，**必須同時確認相鄰功能沒有 regression**：

| 改動類型 | 必須重測的模組 |
|---------|-------------|
| 修改 sync loop | 模組 5（Overlay 互動）、模組 4（列表循環） |
| 修改事件監聽 | 模組 4-4（右鍵）、模組 5-9（CC 按鈕） |
| 修改 Firestore 查詢 | 模組 8（社群字幕）、模組 10（同步） |
| 修改 sidebar 展開/收合 | 模組 5-10、5-11（劇院模式） |
| 修改 SPA 換頁邏輯 | 模組 11 全部 |
| 修改字幕載入流程 | 模組 2、3、9 |

---

## Part 4：Playwright 自動化測試

### 環境需求

```bash
# 在套件目錄安裝 Playwright（若尚未安裝）
cd "d:\dev\chrome字幕套件開發"
npm install playwright
npx playwright install chromium
```

### 關鍵限制：必須用 headed + CDP 取得 extension isolated world

Chrome 擴充套件的 `content.js` 跑在 **isolated world**，`page.evaluate()` 跑在 main world，**無法存取 `chrome.storage`**。

必須透過 **CDP `Runtime.evaluate` + `contextId`** 繞過：

```js
// 1. 啟動 Chrome 並載入擴充套件（不能 headless）
const context = await chromium.launchPersistentContext('', {
  headless: false,
  args: [
    '--disable-extensions-except=' + EXT_PATH,
    '--load-extension=' + EXT_PATH,
    '--no-sandbox',
  ],
});

// 2. 建立 CDP session
const client = await context.newCDPSession(page);
await client.send('Runtime.enable');

// 3. 監聽 extension isolated world（name = 'YT Subtitle Demo'）
const ctxId = await new Promise(resolve => {
  client.on('Runtime.executionContextCreated', event => {
    if (event.context.name === 'YT Subtitle Demo')
      resolve(event.context.id);
  });
});

// 4. 用 contextId 執行 chrome.storage.local
await client.send('Runtime.evaluate', {
  expression: `new Promise(res => chrome.storage.local.set({key: 'val'}, res))`,
  contextId: ctxId,
  awaitPromise: true,
});
```

> **重要**：`waitForExtContext` 必須在 `page.goto()` **之前**就開始監聽，否則事件已觸發就會漏掉。詳見 `tests/test-storage-persist-v2.mjs`。

### 現有自動化測試腳本

| 腳本 | 說明 | 執行方式 |
|------|------|---------|
| `test-storage-persist-v2.mjs` | 驗證 `chrome.storage.local` 讀寫與刷新持久化，並確認 `_restoreSavedSubtitle` 顯示「已還原」 | `node tests/test-storage-persist-v2.mjs` |
| `test-lang-behavior.mjs` | 驗證字幕語言偏好選擇行為 | `node tests/test-lang-behavior.mjs` |
| `test-nav-btn-real.mjs` | 驗證 Overlay 上一句/下一句按鈕 | `node tests/test-nav-btn-real.mjs` |
| `test-secondary-translation.mjs` | 驗證副字幕翻譯載入 | `node tests/test-secondary-translation.mjs` |

### 新測試的 helper 模板

```js
// storageSet(client, ctxId, key, value) → Boolean
// storageGet(client, ctxId, key) → value | null
// storageRemove(client, ctxId, key)
// 以上三個 helper 已在 test-storage-persist-v2.mjs 定義，可直接複製使用

// 輪詢等待 sidebar 狀態文字
async function pollStatusText(page, targetSubstr, maxMs) { ... }
// 用法：await pollStatusText(page, '已還原', 15000);
```

### 可自動化 vs 必須手動的項目

| 類型 | 自動化可行性 | 說明 |
|------|------------|------|
| `chrome.storage` 讀寫驗證 | ✅ 可自動化 | 用 CDP + isolated world |
| Sidebar DOM 狀態確認 | ✅ 可自動化 | `page.evaluate` 讀取 `#yt-sub-status` |
| 刷新後字幕還原 | ✅ 可自動化 | `page.reload()` + 輪詢狀態文字 |
| 字幕列表 active 高亮 | ✅ 可自動化 | 等 video play 後查 `.yt-sub-item.active` |
| Google OAuth 登入 | ❌ 手動 | 需互動式 browser |
| 右鍵選單儲存單字 | ⚠️ 受限 | YouTube 可能攔截 contextmenu |
| YouTube 字幕 HTTP 回傳 | ⚠️ 受限 | 需要 pot token，headless 下可能失敗 |

---

## 已知限制

- **YouTube pot token**：headless 模式下 YouTube 可能要求 pot token，導致字幕 HTTP 請求失敗。功能測試（Part 2）仍建議在真實瀏覽器手動執行。
- **OAuth 流程**：需要手動操作，無法自動化。

---

## Part 5：Chrome 擴充套件測試常見失誤與守則

### 為什麼套件測試特別容易失誤？

Chrome Extension 在 **isolated world** 中執行，與頁面的 JavaScript context 完全分離。
這造成以下限制，必須在測試設計時就考慮到，否則會測不到正確的東西。

---

### ❌ 錯誤做法（不可重蹈）

#### 1. 用 `page.evaluate` 存取 `chrome.storage`
```js
// 這會拋出 ReferenceError：chrome is not defined
await page.evaluate(() => chrome.storage.local.get('key', ...));
```
`page.evaluate` 跑在頁面 context，沒有 `chrome` API。

#### 2. 在 `page.goto` 之後才開始監聽 extension context
```js
await page.goto(url);
const ctxId = await waitForExtContext(client, 15000); // 永遠得到 null
```
Content script 在 `domcontentloaded` 時就建立 isolated world，必須**先訂閱事件再導航**。

#### 3. 用 `page.evaluate` inject 假字幕假設功能正確
注入假資料的測試只驗證了 DOM 渲染，不能驗證真實的資料流（storage 讀寫、message 傳遞、YouTube API 回應）。
功能測試必須用真實影片、真實字幕。

---

### ✅ 正確做法

| 場景 | 方法 |
|------|------|
| 存取 `chrome.storage` | CDP `Runtime.evaluate` + `contextId`（isolated world） |
| 監聽 extension context 建立 | `waitForExtContext` 必須在 `page.goto` **之前**啟動 |
| 驗證 UI 狀態 | `page.evaluate` 讀取 DOM（`#yt-sub-status` 等），這是合法的 |
| 驗證字幕還原 | `pollStatusText` 輪詢狀態文字，不用假資料注入 |
| 驗證 storage 持久化 | reload 後再 `storageGet`，用 CDP 讀取 |

---

### 套件測試快速檢查清單

開始寫新的 Playwright 套件測試前，確認以下事項：

- [ ] `client.send('Runtime.enable')` 在 `page.goto` 之前執行
- [ ] `waitForExtContext` promise 在 `page.goto` 之前建立
- [ ] 沒有用 `page.evaluate` 直接呼叫 `chrome.*` API
- [ ] 需要驗證 storage 的測試都使用 `storageSet/storageGet` helper（見 test-storage-persist-v2.mjs）
- [ ] 沒有 inject 假字幕資料來模擬「正常運作」
- [ ] YouTube 影片使用真實 VIDEO_ID，非私人影片
