# firebase.js

## 基本資訊

| 項目 | 值 |
|------|-----|
| 檔案 | `firebase.js` |
| 行數 | 341 行 |
| 執行環境 | ES Module（被 background.js import） |
| 類型 | Firebase REST API 封裝層 |

## 功能說明

封裝所有與 Firebase 服務的通訊，包含 Google OAuth 登入流程、idToken 管理、Firestore CRUD 操作。不直接使用 Firebase SDK，改用 REST API 呼叫，確保 MV3 Service Worker 相容性。

---

## 依賴關係

### 上游（firebase.js 依賴）

- `chrome.identity.launchWebAuthFlow` — Google OAuth 授權
- `chrome.storage.local` — 持久化 token（idToken、refreshToken、userId）
- Firebase REST 端點：
  - `https://identitytoolkit.googleapis.com` — 帳號驗證
  - `https://securetoken.googleapis.com` — Token 刷新
  - `https://firestore.googleapis.com` — 資料庫 CRUD

### 下游（依賴 firebase.js）

- [[background]] — `import` 並呼叫所有匯出函式

---

## 匯出函式清單

```javascript
export {
  signInWithGoogle,      // Google OAuth → Firebase idToken
  signOut,               // 清除 token，登出
  restoreSession,        // 從 chrome.storage 恢復 session
  refreshTokenIfNeeded,  // 檢查 token 是否過期，自動刷新
  setDoc,                // 建立/覆寫 Firestore 文件
  getDoc,                // 讀取單一 Firestore 文件
  updateDoc,             // 部分更新 Firestore 文件（PATCH）
  deleteDoc,             // 刪除 Firestore 文件
  getCollection,         // 查詢 Collection（需認證）
  getCollectionPublic    // 查詢公開 Collection（無需認證）
}
```

---

## 核心機制

### 1. Google OAuth 登入流程

```
launchWebAuthFlow
  → 彈出 Google 帳號選擇視窗
  → 取得 access_token（Google OAuth2）
  → 呼叫 identitytoolkit.googleapis.com/v1/accounts:signInWithIdp
  → 取得 Firebase idToken + refreshToken
  → 儲存到 chrome.storage.local
```

### 2. Token 自動刷新

```javascript
async function refreshTokenIfNeeded() {
  const { idToken, expiresAt } = await chrome.storage.local.get(['idToken', 'expiresAt']);
  if (Date.now() > expiresAt - 5 * 60 * 1000) {  // 提前 5 分鐘刷新
    const newToken = await refreshToken(refreshToken);
    await chrome.storage.local.set({ idToken: newToken, expiresAt: ... });
  }
}
```

### 3. Firestore REST 操作範例

```javascript
// setDoc
async function setDoc(path, data) {
  await refreshTokenIfNeeded();
  return fetch(
    `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${path}`,
    {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${idToken}` },
      body: JSON.stringify(toFirestoreFormat(data))
    }
  );
}
```

### 4. Firestore 資料格式轉換

Firestore REST API 使用特定格式，需手動轉換：

```javascript
// JS 物件 → Firestore 格式
{ word: "hello", count: 3 }
→ {
    fields: {
      word: { stringValue: "hello" },
      count: { integerValue: "3" }
    }
  }
```

---

## 儲存結構（Firestore）

```
/users/{uid}/
  words/{wordId}         # 單字本
  settings/{settingId}   # 使用者設定

/community/
  subtitles/{videoId}    # 社群分享字幕

/editors/{uid}           # 編輯器授權記錄
```

---

## Token 儲存（chrome.storage.local）

```javascript
{
  idToken: "eyJ...",
  refreshToken: "1//0g...",
  userId: "google-uid-xxx",
  expiresAt: 1735000000000,  // Unix timestamp ms
  userEmail: "user@gmail.com",
  displayName: "User Name"
}
```

---

## 踩坑記錄

- **MV3 不支援 Firebase SDK**：Firebase JS SDK 依賴 `window` 物件，Service Worker 無此環境，只能用 REST API
- **Token 在 SW 重啟後消失**：必須從 `chrome.storage.local` 恢復，不能只存記憶體
- **launchWebAuthFlow popup 被阻擋**：必須由 user gesture 觸發（content script sendMessage → background）

---

## 反向依賴

- [[background]] — 唯一的直接呼叫者

---

## 相關

- [[background]]
- [[TECHNICAL]]
- [[專案索引]]
