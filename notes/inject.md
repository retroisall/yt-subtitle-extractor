# inject.js

## 基本資訊

| 項目 | 值 |
|------|-----|
| 檔案 | `inject.js` |
| 行數 | 740 行 |
| 執行環境 | Main World（由 content.js 動態注入） |
| 注入方式 | `chrome.runtime.getURL('inject.js')` → `<script src>` |

## 功能說明

由 [[content]] 動態建立 `<script>` 標籤注入到 Main World。負責從 YouTube 全域變數提取 captionTracks 資訊，生成 SAPISIDHASH 認證 header，實際 fetch 字幕 XML/JSON，最後透過 `postMessage` 傳回給 [[content]]。

---

## 依賴關係

### 上游（inject.js 依賴）

- [[patch]] — 讀取 `window.__YT_SUB_PLAYER_CACHE__` 和 `window.__YT_SUB_TIMEDTEXT_CACHE__`
- YouTube 全域變數：
  - `window.ytInitialPlayerResponse`
  - `window.ytplayer?.config?.args?.raw_player_response`
  - `window.yt?.config_?.SAPISID`（用於生成 SAPISIDHASH）

### 下游（依賴 inject.js 輸出）

- [[content]] — 透過 `window.addEventListener('message')` 接收 `YT_SUBTITLE_DEMO_SUBTITLE_DATA`

---

## 核心機制

### 1. 四層字幕來源提取（可靠性順序）

```javascript
// Path 1: ytInitialPlayerResponse（首次載入）
window.__YT_SUB_PLAYER_CACHE__?.captions
  ?.playerCaptionsTracklistRenderer?.captionTracks

// Path 2: ytplayer.config（SPA 導航後）
window.ytplayer?.config?.args?.raw_player_response?.captions?...

// Path 3: HTML 括號計數法解析 JSON（備用）
// 比 regex 更可靠，處理巢狀結構

// Path 4: Innertube API（最後備用，需 POT token）
POST /youtubei/v1/player
```

### 2. SAPISIDHASH 生成

```javascript
async function generateSAPIHash(sapisid, origin) {
  const ts = Math.floor(Date.now() / 1000);
  const message = `${ts} ${sapisid} ${origin}`;
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(message));
  return `SAPISIDHASH ${ts}_${hashHex}`;
}
```

**用途**：讓字幕 fetch 請求的 Authorization header 看起來像 YouTube 前端發出，避免被拒絕。

### 3. postMessage 通訊

```javascript
// inject.js → content.js
window.postMessage({
  type: 'YT_SUBTITLE_DEMO_SUBTITLE_DATA',
  tracks: captionTracks,    // 字幕軌道列表
  subtitleData: xmlData,    // 實際字幕內容
  videoId: currentVideoId
}, '*');
```

---

## 資料結構

### captionTrack 物件

```javascript
{
  baseUrl: "https://www.youtube.com/api/timedtext?...",
  name: { simpleText: "Chinese (Traditional)" },
  vssId: ".zh-TW",
  languageCode: "zh-TW",
  kind: "asr"  // 自動生成字幕
}
```

### 字幕快取機制

- 使用 `Map<videoId, subtitleData>` 避免重複 fetch
- 快取有效性驗證：檢查 `baseUrl` 中的 `expire` 參數

---

## 踩坑記錄

- **SPA 導航延遲**：換影片時 `ytInitialPlayerResponse` 可能仍為舊影片資料，需輪詢驗證 videoId
- **SAPISID 未載入**：某些情況下 `window.yt?.config_?.SAPISID` 為 undefined，需等待 YT SDK 初始化
- **fetch 被攔截**：inject.js 本身的 fetch 會被 [[patch]] 攔截，需防止遞迴

---

## 反向依賴

- [[content]] — 動態注入此腳本，並監聽其 postMessage 回傳
- [[manifest]] — 宣告為 `web_accessible_resources`

---

## 相關

- [[patch]]
- [[content]]
- [[TECHNICAL]]
- [[專案索引]]
