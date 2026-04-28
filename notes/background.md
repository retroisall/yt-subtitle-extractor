# background.js

## 基本資訊

| 項目 | 值 |
|------|-----|
| 檔案 | `background.js` |
| 行數 | 317 行 |
| 執行環境 | Service Worker（MV3） |
| 類型 | ES Module（`"type": "module"`） |

## 功能說明

擴充套件的後台 Service Worker，作為 [[content]]、[[editor]]、[[vocab-dashboard]] 的訊息中心。處理 Firebase 認證流程、Firestore 資料存取、字幕暫存管理，以及開啟編輯器/儀表板分頁。

---

## 依賴關係

### 上游（background.js 依賴）

- [[firebase]] — `import` 所有 Firebase 操作函式

```javascript
import {
  signInWithGoogle, signOut, restoreSession,
  setDoc, getDoc, updateDoc, deleteDoc,
  getCollection, getCollectionPublic
} from './firebase.js';
```

### 下游（向 background 發送訊息的模組）

- [[content]] — 認證、單字本、社群字幕
- [[editor]] — 取得字幕資料（`editor_getSubtitles`）
- [[vocab-dashboard]] — 認證流程

---

## 訊息處理清單

```javascript
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message.action) {
    case 'fb_getUser':              // 取得目前登入用戶
    case 'fb_signIn':               // 觸發 Google OAuth
    case 'fb_signOut':              // 登出
    case 'fb_saveWord':             // 儲存單字到 Firestore
    case 'fb_getWords':             // 取得單字本
    case 'fb_biSync':               // 雙向同步（本地 ∪ 雲端）
    case 'fb_deleteWord':           // 刪除單字
    case 'fb_checkEditorPermission':    // 確認編輯器授權
    case 'fb_registerEditorPermission': // 授予編輯器權限
    case 'fb_getCommunitySubtitles':    // 取得社群字幕
    case 'fb_saveCommunitySubtitle':    // 上傳字幕到社群
    case 'editor_getSubtitles':     // 提供字幕資料給 editor.js
    case 'open_editor':             // 開啟 editor.html 分頁
    case 'open_dashboard':          // 開啟 vocab-dashboard.html 分頁
  }
});
```

---

## 核心機制

### 1. Session 管理

```javascript
// Service Worker 會被 Chrome 終止後重啟
// 用 Promise 確保 session 在訊息到達前就緒
let _sessionReady = restoreSession().then(user => {
  currentUser = user;
});

// 每個訊息處理前都 await _sessionReady
await _sessionReady;
```

> ⚠️ 踩坑：Service Worker 重啟後 `currentUser` 為 null，需先 `restoreSession()` 再處理訊息。

### 2. 字幕暫存（subtitleStore）

```javascript
// 接收 content.js 的字幕資料後暫存
const subtitleStore = new Map(); // tabId → subtitleData

// editor.js 請求時從暫存取出
case 'editor_getSubtitles':
  sendResponse({ data: subtitleStore.get(sender.tab.id) });
```

### 3. 雙向同步邏輯

```javascript
// 本地 Map ∪ 雲端 Collection
// 比較 deletedAt / addedAt 時戳
// 衝突解決：取較新者
// PATCH 上傳差異 + 更新本地
async function biDirectionalSync(uid, localWords) { ... }
```

### 4. 分頁管理

```javascript
// 開啟編輯器（確保不重複開啟）
case 'open_editor':
  const existing = await chrome.tabs.query({ url: chrome.runtime.getURL('editor.html') });
  if (existing.length > 0) {
    chrome.tabs.update(existing[0].id, { active: true });
  } else {
    chrome.tabs.create({ url: chrome.runtime.getURL('editor.html') });
  }
```

---

## 錯誤處理

- Token 過期：每次 Firestore 操作前呼叫 `firebase.js` 的 `refreshTokenIfNeeded()`
- Service Worker 重啟：用 `_sessionReady` Promise 防止競爭
- 訊息異步回應：記得 `return true` 保持 sendResponse channel 開放

---

## 反向依賴

- [[manifest]] — 宣告為 `background.service_worker`
- [[content]] — 主要呼叫者
- [[editor]] — 取得字幕資料
- [[vocab-dashboard]] — 認證相關

---

## 相關

- [[firebase]]
- [[content]]
- [[editor]]
- [[vocab-dashboard]]
- [[TECHNICAL]]
- [[專案索引]]
