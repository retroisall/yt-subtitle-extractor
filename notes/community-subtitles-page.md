# community-subtitles-page.html

## 基本資訊

| 項目 | 值 |
|------|-----|
| 檔案 | `community-subtitles-page.html` |
| 行數 | 1,027 行 |
| 類型 | 純前端頁面（直接呼叫 Firestore REST） |
| 用途 | 社群字幕公開資源庫瀏覽頁 |

## 功能說明

提供給所有人（不需登入）瀏覽社群上傳字幕的頁面。直接查詢 Firestore `customSubtitles` Collection，列出所有影片的社群字幕版本，支援搜尋與篩選。

---

## 依賴關係

### 上游

- Firestore REST API — `customSubtitles/{videoId}/entries` Collection（公開讀取）
- Google Fonts CDN

### 下游

- 不被 [[manifest]] 宣告（對外網頁，非套件本體）

---

## Firestore 查詢

```javascript
// 查詢所有社群字幕（公開，不需 token）
const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/customSubtitles`;
const res = await fetch(url);
const data = await res.json();
```

Firestore Rules 中 `customSubtitles/{videoId}` 允許 `read: if true`，此頁無需認證。

---

## UI 結構

| 元件 | 說明 |
|------|------|
| **Nav** | sticky 導覽列，顯示社群字幕總數 badge |
| **搜尋列** | 依影片 ID 或標題搜尋 |
| **字幕卡片列表** | 每張卡顯示影片縮圖、標題、上傳者、字幕語言 |
| **版本選擇** | 同一影片可能有多個社群字幕版本 |

---

## 設計語言

與 [[landing]] 共用同一套 CSS token：
```css
--accent: #7c3aed;
--bg:     #09090b;
```
字體：DM Sans + DM Mono

---

## 踩坑記錄

- **Firestore Collection Group 查詢**：跨文件 entries 查詢需在 Rules 中開啟 `/{path=**}/entries/{entryId}` 規則，否則 403
- **大量字幕時渲染效能**：超過百筆需分頁或虛擬滾動

---

## 反向依賴

- [[firestore-rules]] — 安全規則保障此頁只能讀，不能寫
- [[content]] — 擴充套件內也可觸發開啟此頁

---

## 相關

- [[landing]]
- [[firestore-rules]]
- [[firebase]]
- [[vocab-dashboard]]
- [[專案索引]]
