# TECHNICAL.md

## 基本資訊

| 項目 | 值 |
|------|-----|
| 檔案 | `TECHNICAL.md` |
| 行數 | 879 行 |
| 用途 | 技術實作核心文件，記錄六大關鍵技術與陷阱 |

## 功能說明

開發者手冊，記錄整個擴充套件最複雜的技術決策與實作細節，是理解 [[inject]]、[[patch]]、[[content]] 之間協作的最佳入口文件。

---

## 六大關鍵技術

### 1. 為何需要 inject.js（主世界注入）

Content Script 跑在「隔離世界」，無法存取 `window.ytInitialPlayerResponse`。解法：透過動態插入 `<script>` 標籤讓程式碼跑在頁面主世界。

```js
// content.js
function injectScript() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject.js');
  (document.head || document.documentElement).appendChild(script);
}
```

需在 [[manifest]] 的 `web_accessible_resources` 宣告 `inject.js`。

---

### 2. 四層字幕來源提取

| 優先順序 | 來源 | 說明 |
|----------|------|------|
| 1 | `window.ytInitialPlayerResponse` | 最快，首次載入有效 |
| 2 | `window.ytplayer.config` | SPA 導航後最可靠 |
| 3 | HTML 解析 | 括號計數法（比 regex 可靠） |
| 4 | Innertube API POST | 最後備用，POST `/youtubei/v1/player` |

---

### 3. SPA 導航處理

YouTube 換影片不重新載入頁面，`ytInitialPlayerResponse` 可能仍是舊資料。

```js
// 解法一：監聽 YouTube 自訂事件
document.addEventListener('yt-navigate-finish', pollAndExtract);

// 解法二：輪詢 + Video ID 驗證
function isForCurrentVideo(renderer) {
  const videoId = new URLSearchParams(location.search).get('v');
  return renderer.captionTracks[0].baseUrl?.includes('v=' + videoId);
}
```

---

### 4. SAPISIDHASH — 突破 timedtext API 限制

部分影片直接 fetch 字幕 URL 回傳 HTTP 200 但 body 為空，需帶 Authorization header：

```
Authorization: SAPISIDHASH {timestamp}_{SHA256(timestamp + " " + SAPISID + " " + origin)}
```

```js
async function buildSapiAuthHeader() {
  const sapisid = document.cookie.split('; ')
    .find(c => c.startsWith('__Secure-3PAPISID=') || c.startsWith('SAPISID='))
    ?.split('=')[1];
  const ts = Math.floor(Date.now() / 1000);
  const msg = ts + ' ' + sapisid + ' https://www.youtube.com';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg));
  const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  return { 'Authorization': 'SAPISIDHASH ' + ts + '_' + hex };
}
```

---

### 5. vssId 邏輯 — 選對字幕 URL

| vssId 前綴 | 類型 | 策略 |
|-----------|------|------|
| `.en` | 手動上傳 | 直接用 baseUrl |
| `a.zh` | ASR 自動生成 | 直接用 baseUrl |
| 無目標語言 | 需翻譯 | 用 `&tlang=目標語言` |

`&tlang=` 讓 YouTube 伺服器即時翻譯，不依賴速率受限的翻譯 track URL。

---

### 6. fetch + XHR 雙重攔截

在 [[patch]] 最前段（document_start）攔截，捕捉 YouTube 播放器發出的字幕 fetch：

```js
const originalFetch = window.fetch;
window.fetch = async function(url, options) {
  if (url?.includes?.('timedtext')) {
    // 快取回應供 inject.js 使用
    window.__YT_SUB_TIMEDTEXT_CACHE__[url] = response.clone();
  }
  return originalFetch.apply(this, arguments);
};
```

---

## 反向依賴

此文件是所有複雜模組的知識來源：
- [[inject]] — 實作 SAPISIDHASH、四層提取
- [[patch]] — 實作 fetch/XHR 攔截
- [[content]] — 實作 SPA 導航偵測
- [[background]] — Service Worker 架構

---

## 相關

- [[inject]]
- [[patch]]
- [[content]]
- [[background]]
- [[firebase]]
- [[專案索引]]

---

## 安全性檢查紀錄

### 2026-04-28 — Git 敏感資訊掃描

| 檔案 | 問題 | 狀態 |
|------|------|------|
| `background.js` | admin email 已移入 Firestore `app_config/admin_config` | ✅ 已修 |
| `vocab-dashboard.js` 第 271 行 | `ADMIN_EMAIL = 'kuoway79@gmail.com'` hardcode 尚未移除 | ⚠️ 待修 |
| `notes/firestore-rules.md` | admin email 出現 3 處（文件說明用） | ⚠️ 低風險，可遮蔽 |
| `firebase.js` — `apiKey` / `CLIENT_ID` | Firebase Web API Key 與 OAuth Client ID | ✅ 正常（前端公開設計，安全性靠 Firestore Rules） |

**結論：** `vocab-dashboard.js` 的 `ADMIN_EMAIL` 需比照 `background.js` 改成從 Firestore 讀取。
