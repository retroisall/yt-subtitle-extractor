# firestore.rules

## 基本資訊

| 項目 | 值 |
|------|-----|
| 檔案 | `firestore.rules` |
| 行數 | 55 行 |
| 用途 | Firebase Firestore 安全規則，控制讀寫權限 |
| 部署 | Firebase Console 或 `firebase deploy --only firestore:rules` |

## 功能說明

定義所有 Firestore Collection 的讀寫存取規則。區分「自己的資料」、「公開資料」、「管理員才能操作」三種層級。

---

## Collection 規則對照

### 1. 使用者單字庫 `/users/{uid}/**`

```
allow read, write: if request.auth != null && request.auth.uid == uid;
```
- 只有本人可讀寫自己的單字資料
- 用於 [[firebase]] 的 `setDoc/getDoc` 操作

---

### 2. 社群字幕頂層 `/customSubtitles/{videoId}`

```
allow read: if true;           // 公開讀取
allow write: if request.auth != null;  // 登入可建立
```
- [[community-subtitles-page]] 無需登入即可讀取

---

### 3. 社群字幕 entries `/customSubtitles/{videoId}/entries/{entryId}`

```
allow read: if true;
allow create: if request.auth != null
              && request.resource.data.uploaderUid == request.auth.uid;
allow delete: if request.auth != null
              && (resource.data.uploaderUid == request.auth.uid
                  || request.auth.token.email == 'kuoway79@gmail.com');
```
- 上傳者只能建立自己的字幕（`uploaderUid` 必須等於 `request.auth.uid`）
- 可刪除自己的，或管理員刪除任何人的
- 無 `update`：已上傳的字幕不能修改（只能刪除後重傳）

---

### 4. Collection Group 查詢支援 `/{path=**}/entries/{entryId}`

```
allow read: if true;
```
- 支援跨文件的 `collectionGroup('entries')` 查詢
- 若缺少此規則，群組查詢回傳 403

---

### 5. 編輯器權限 `/editor_permissions/{uid}`

```
allow read: if request.auth != null && request.auth.uid == uid;
allow create: if request.auth != null && request.auth.uid == uid
              && request.resource.data.enabled == false;  // 預設 disabled
allow update: if request.auth.token.email == 'kuoway79@gmail.com';  // 管理員核准
```
- 使用者可以「申請」成為社群字幕編輯者（create，`enabled: false`）
- 只有管理員能核准（update `enabled` 為 true）

---

### 6. 關鍵字 / 記憶 `/keywords/{docId}`, `/memories/{docId}`

```
allow read, write: if request.auth != null;
```
- 登入用戶可讀寫（供 Google Apps Script 同步使用）

---

## 安全設計重點

| 原則 | 實作方式 |
|------|---------|
| 資料所有權 | `request.auth.uid == uid` 確保只能操作自己的資料 |
| 上傳者驗證 | `request.resource.data.uploaderUid == request.auth.uid` 防止偽冒 |
| 管理員辨識 | `request.auth.token.email == 'kuoway79@gmail.com'`（Email 硬編碼） |
| 防止未授權修改 | entries 無 `update` 規則 |

---

## 反向依賴

- [[firebase]] — 所有 REST API 呼叫受此規則約束
- [[background]] — 透過 firebase.js 存取
- [[vocab-dashboard]] — 直接呼叫 Firestore REST
- [[community-subtitles-page]] — 公開讀取 entries

---

## 相關

- [[firebase]]
- [[background]]
- [[vocab-dashboard]]
- [[community-subtitles-page]]
- [[專案索引]]
