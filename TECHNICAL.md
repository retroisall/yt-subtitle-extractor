# YouTube 字幕提取套件 — 技術文件

## 架構概覽

```
YouTube 頁面
├── content.js        （隔離世界，Isolated World）
│   ├── 建立側邊欄 UI
│   ├── 注入 inject.js
│   └── 接收資料 → 渲染字幕
│
└── inject.js         （主世界，Main World）
    ├── 攔截 window.fetch / XMLHttpRequest
    ├── 提取 captionTracks
    ├── 生成 SAPISIDHASH
    └── fetch 字幕內容 → postMessage 回 content.js
```

兩個世界透過 `window.postMessage` 溝通。

---

## 關鍵技術一：為什麼需要 inject.js（主世界）

Content Script 跑在「隔離世界」，**無法存取** `window.ytInitialPlayerResponse` 等 YouTube 全域變數。

解法：透過動態插入 `<script>` 標籤，讓程式碼跑在頁面的主世界：

```js
// content.js
function injectScript() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('inject.js');
  (document.head || document.documentElement).appendChild(script);
}
```

需要在 `manifest.json` 宣告：
```json
"web_accessible_resources": [{ "resources": ["inject.js"], "matches": ["*://www.youtube.com/*"] }]
```

---

## 關鍵技術二：四層字幕來源提取

YouTube 資料可從四個地方取得，依可靠性排序：

```js
// 1. 全域變數（最快，首次載入有效）
window.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer

// 2. 播放器設定（SPA 導航後最可靠）
window.ytplayer?.config?.args?.raw_player_response?.captions?....

// 3. HTML 解析（備用）
// 用括號計數法（比 regex 可靠），支援 var/let/const/window. 等宣告
const match = text.match(/ytInitialPlayerResponse\s*=\s*\{/);
// 找到 { 後用計數器找對應的 }，避免 regex 被 }; 截斷

// 4. Innertube API（最後備用）
POST https://www.youtube.com/youtubei/v1/player
Body: { videoId, context: { client: { clientName: 'WEB', ... } } }
```

---

## 關鍵技術三：SPA 導航處理

YouTube 是 SPA（Single Page Application），換影片不會重新載入頁面。

**陷阱**：`ytInitialPlayerResponse` 在 SPA 導航後可能仍是舊影片資料。

**解法一**：監聽 YouTube 自訂事件：
```js
document.addEventListener('yt-navigate-finish', pollAndExtract);
```

**解法二**：輪詢 + Video ID 驗證，避免接受舊資料：
```js
function isForCurrentVideo(renderer) {
  const videoId = new URLSearchParams(location.search).get('v');
  return renderer.captionTracks[0].baseUrl?.includes('v=' + videoId);
}
```

每 500ms 確認一次資料是否屬於當前影片，最多等 5 秒。

---

## 關鍵技術四：SAPISIDHASH — 突破字幕 API 限制

**問題**：直接 fetch `baseUrl + '&fmt=json3'` 對 ASR（自動生成）和翻譯字幕回傳 HTTP 200 但空 body。

**原因**：YouTube 的 timedtext API 在某些影片需要 `Authorization` header，格式為 `SAPISIDHASH`，由 `SAPISID` cookie 生成：

```
Authorization: SAPISIDHASH {timestamp}_{SHA256(timestamp + " " + SAPISID + " " + origin)}
```

**實作**：
```js
async function buildSapiAuthHeader() {
  const sapisid = document.cookie.split('; ')
    .find(c => c.startsWith('__Secure-3PAPISID=') || c.startsWith('SAPISID='))
    ?.split('=')[1];

  const ts = Math.floor(Date.now() / 1000);
  const msg = ts + ' ' + sapisid + ' ' + 'https://www.youtube.com';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg));
  const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');

  return { 'Authorization': 'SAPISIDHASH ' + ts + '_' + hex };
}
```

這個 header 讓請求看起來像 YouTube 自己的前端發出的，成功突破限制。

---

## 關鍵技術五：vssId 邏輯 — 選對字幕 URL

captionTrack 的 `vssId` 欄位揭示字幕類型：

| vssId 前綴 | 類型 | 策略 |
|-----------|------|------|
| `.en` | 手動上傳字幕 | 直接用 baseUrl |
| `a.zh` | ASR 自動生成 | 直接用 baseUrl |
| （無目標語言）| 需翻譯 | 找任意 track + `&tlang=目標語言` |

```js
const manualTarget = allTracks.find(t => t.vssId?.startsWith('.' + languageCode));
const asrTarget    = allTracks.find(t => t.vssId?.startsWith('a.' + languageCode));
const fallback     = allTracks.find(t => t.vssId?.startsWith('a.')) || allTracks[0];

let url;
if (manualTarget)   url = manualTarget.baseUrl + '&fmt=json3';
else if (asrTarget) url = asrTarget.baseUrl + '&fmt=json3';
else                url = fallback.baseUrl + '&fmt=json3&tlang=' + languageCode;
```

`&tlang=` 參數讓 YouTube 伺服器**即時翻譯**，不依賴預先生成的翻譯 track URL（後者受速率限制）。

---

## 關鍵技術六：fetch + XHR 雙重攔截

在 inject.js 最開頭（在 YouTube 自己的程式碼執行之前）攔截，捕捉 YouTube 播放器的字幕 fetch：

```js
// 攔截 fetch
const originalFetch = window.fetch;
window.fetch = async function(input, init) {
  const response = await originalFetch.call(this, input, init);
  if (url.includes('/api/timedtext')) {
    response.clone().text().then(text => cacheTimedtext(url, text));
  }
  return response;
};

// 攔截 XHR（YouTube 播放器可能使用）
const OriginalXHR = window.XMLHttpRequest;
function PatchedXHR() {
  const xhr = new OriginalXHR();
  xhr.addEventListener('load', () => {
    if (_url.includes('/api/timedtext')) cacheTimedtext(_url, xhr.responseText);
  });
  return xhr;
}
window.XMLHttpRequest = PatchedXHR;
```

---

## 關鍵技術七：多格式字幕解析

YouTube 字幕有多種格式，統一轉換為 json3 結構：

```js
function parseSubtitleText(text, fmt) {
  if (['json3','srv3','srv2','srv1'].includes(fmt)) {
    return JSON.parse(text); // 都是 JSON，結構相同
  }
  // XML / TTML 格式 → 用 DOMParser 解析
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  const nodes = doc.querySelectorAll('text,p');
  return { events: Array.from(nodes).map(n => ({
    tStartMs: parseFloat(n.getAttribute('start')) * 1000,
    dDurationMs: parseFloat(n.getAttribute('dur')) * 1000,
    segs: [{ utf8: n.textContent }]
  }))};
}
```

---

## 踩過的坑

| 坑 | 原因 | 解法 |
|----|------|------|
| inject.js 多次注入 | navObserver 反覆觸發 | `window.__YT_SUB_DEMO_INJECTED__` guard |
| SPA 後取到舊影片字幕 | `ytInitialPlayerResponse` 更新有延遲 | 輪詢 + video ID 驗證 |
| HTML 解析 regex 失效 | `};\` 提前截斷 JSON | 改用括號計數法 |
| 字幕 fetch 空回應 | 缺少 SAPISIDHASH header | 從 SAPISID cookie 生成 auth token |
| fetch 攔截沒捕到 | YouTube 播放器可能用 XHR | 同時攔截 fetch 和 XMLHttpRequest |
| 縮小後展開看不到字幕 | transform + flex 重算問題 | 改用 `display: none` 折疊 body |

---

## 測試工具

使用 Playwright 做自動化測試：

```bash
cd d:/dev/yt-sub-test
node test.mjs
```

- 測試 1：側邊欄出現
- 測試 2：字幕語言清單（mock timedtext 回應）
- 測試 3：字幕內容載入與渲染
- 測試 4：SPA 導航後字幕更新
