# patch.js

## 基本資訊

| 項目 | 值 |
|------|-----|
| 檔案 | `patch.js` |
| 行數 | 131 行 |
| 執行環境 | Main World（`world: MAIN`） |
| 注入時機 | `document_start`（最早） |

## 功能說明

YouTube 頁面最早注入的腳本。在任何 JavaScript 執行之前攔截 `fetch` 和 `XMLHttpRequest`，將字幕相關回應快取到全域變數，供 [[inject]] 讀取。

---

## 依賴關係

### 上游（patch.js 依賴）

- 無外部 import，純 Main World 操作

### 下游（依賴 patch.js 輸出）

- [[inject]] — 讀取 `window.__YT_SUB_PLAYER_CACHE__` 和 `window.__YT_SUB_TIMEDTEXT_CACHE__`

---

## 核心機制

### 1. 攔截 `window.fetch`

```javascript
const originalFetch = window.fetch;
window.fetch = async function(...args) {
  const response = await originalFetch.apply(this, args);
  const url = args[0]?.toString() || '';
  if (url.includes('/api/timedtext')) {
    // 快取字幕回應到 __YT_SUB_TIMEDTEXT_CACHE__
  }
  return response;
};
```

### 2. 攔截 `XMLHttpRequest`

```javascript
const OriginalXHR = window.XMLHttpRequest;
// 重寫 open/send，監聽 onreadystatechange
// 同樣快取 /api/timedtext 回應
```

### 3. 監聽 `ytInitialPlayerResponse`

```javascript
// 使用 Object.defineProperty 攔截 window.ytInitialPlayerResponse 賦值
Object.defineProperty(window, 'ytInitialPlayerResponse', {
  set(value) {
    window.__YT_SUB_PLAYER_CACHE__ = value;
    _ytInitialPlayerResponse = value;
  },
  get() { return _ytInitialPlayerResponse; }
});
```

### 全域快取結構

| 變數名 | 內容 |
|--------|------|
| `window.__YT_SUB_PLAYER_CACHE__` | `ytInitialPlayerResponse` 完整物件（含 captions 資訊） |
| `window.__YT_SUB_TIMEDTEXT_CACHE__` | `/api/timedtext` 回應 Map（URL → 字幕文字） |

---

## 時序關係

```
document_start
  └─ patch.js 執行（Main World）
       ├─ 改寫 window.fetch
       ├─ 改寫 XMLHttpRequest
       └─ 監聽 ytInitialPlayerResponse
  
document_idle（之後）
  └─ content.js 執行，動態注入 [[inject]]
       └─ inject.js 讀取 patch.js 建立的快取
```

---

## 踩坑記錄

- **雙重觸發**：fetch 和 XHR 可能同時命中，需用 URL + requestId 去重
- **快取污染**：SPA 導航後舊快取殘留，需用 videoId 驗證有效性
- **document_start 時機**：此時 DOM 尚未建立，不能操作任何 DOM 元素

---

## 反向依賴

- [[manifest]] — 宣告此腳本在 `document_start, world: MAIN` 執行
- [[inject]] — 消費此腳本建立的全域快取

---

## 相關

- [[inject]]
- [[content]]
- [[專案索引]]
- [[TECHNICAL]]
