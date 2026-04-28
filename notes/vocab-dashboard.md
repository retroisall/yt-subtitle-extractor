# vocab-dashboard（詞彙儀表板子系統）

## 基本資訊

| 檔案 | 行數 | 說明 |
|------|------|------|
| `vocab-dashboard.html` | 409 行 | 儀表板 UI（9 個 Tab） |
| `vocab-dashboard.js` | 924 行 | 儀表板邏輯 |
| `vocab-dashboard.css` | 234 行 | 儀表板樣式 |

## 功能說明

後台管理頁面，提供完整的詞彙學習管理功能，包含單字庫查詢、LINE Bot 紀錄、關鍵字提取、排程提醒、記憶遊戲化、使用者權限管理。直接呼叫 Firestore REST API，認證流程委由 [[background]] 處理。

---

## 依賴關係

### 上游（vocab-dashboard.js 依賴）

- [[background]] — `chrome.runtime.sendMessage` 取得認證 token
  - `fb_getUser` — 取得目前用戶
  - `fb_signIn` — 觸發登入
- Firestore REST API（直接呼叫，不經 background）：
  - `https://firestore.googleapis.com/v1/projects/.../databases/(default)/documents/...`
- `chrome.storage.local` — 讀取設定與快取

### 下游

- [[background]] — 接收 `open_dashboard` 訊息後開啟此頁面

---

## 9 個 Tab 功能

| Tab | 功能 |
|-----|------|
| **概覽** | 學習統計圖表（總單字數、本週新增、複習率） |
| **LINE 紀錄** | LINE Bot 傳入的單字查詢紀錄、使用者列表 |
| **單字庫** | Firestore 單字列表（排序、搜尋、匯出 CSV） |
| **關鍵字** | 高頻字提取、詞頻統計 |
| **排程** | 設定每日推播時間（LINE Notify / Chrome 通知） |
| **記憶** | 間隔記憶排程（SM-2 演算法概念） |
| **遊戲** | 填空題、選擇題遊戲化複習 |
| **設定** | API 金鑰、語言偏好、同步設定 |
| **權限** | 授予其他用戶編輯器存取權 |

---

## vocab-dashboard.js 核心功能

### 1. Firestore 直接查詢

```javascript
// 不透過 background.js，直接呼叫 REST
async function queryWords(uid) {
  const token = await getAuthToken();  // 從 chrome.storage 取 idToken
  const response = await fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/users/${uid}/words`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return parseFirestoreResponse(await response.json());
}
```

### 2. 統計圖表

```javascript
// 使用原生 Canvas API 繪製折線圖/長條圖
function renderChart(ctx, data) {
  // 自行實作，無外部圖表庫依賴
}
```

### 3. 資料匯出

```javascript
function exportCSV(words) {
  const csv = ['word,translation,addedAt,reviewCount']
    .concat(words.map(w => `${w.word},${w.translation},${w.addedAt},${w.reviewCount}`))
    .join('\n');
  downloadFile('vocab-export.csv', csv);
}
```

### 4. 權限管理

```javascript
// 授予其他用戶編輯器存取
async function grantEditorPermission(targetUid) {
  await chrome.runtime.sendMessage({
    action: 'fb_registerEditorPermission',
    targetUid
  });
}
```

---

## vocab-dashboard.html 結構

```html
<div class="dashboard-container">
  <nav class="tab-nav">
    <button class="tab-btn active" data-tab="overview">概覽</button>
    <button class="tab-btn" data-tab="line">LINE 紀錄</button>
    <!-- ... 共 9 個 tab 按鈕 -->
  </nav>
  <main class="tab-content">
    <section id="overview" class="tab-panel active">...</section>
    <section id="words" class="tab-panel">...</section>
    <!-- ... -->
  </main>
</div>
```

---

## vocab-dashboard.css 視覺

- **Grid 佈局**：左側 Tab 導覽 + 右側內容區
- **資料表格**：stripe 斑馬紋、hover 高亮
- **圖表容器**：Canvas 自動填滿容器寬度
- **深色主題**：與 [[editor]] 保持一致

---

## 踩坑記錄

- **Token 過期**：直接呼叫 Firestore 時需自行處理 token 刷新（因為不經 background 的 refreshTokenIfNeeded）
- **大量資料渲染**：單字本超過 500 筆時需虛擬滾動或分頁

---

## 反向依賴

- [[manifest]] — 宣告為 `web_accessible_resources`
- [[background]] — 負責開啟此頁面（`open_dashboard` 訊息）
- [[content]] — 可觸發開啟儀表板

---

## 相關

- [[background]]
- [[firebase]]
- [[content]]
- [[專案索引]]
