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

## 字幕翻譯流程

### 路徑 A — YouTube 內建翻譯（`translationProvider = 'ytlang'`）

**觸發條件**：副字幕語言在影片中沒有原生 track（或選擇強制翻譯 `tlang:lang`），且 provider 設定為 `ytlang`。

**流程**：
```
autoLoadSubtitles()
  └→ loadSubtitle(base track, 'secondary', targetLang)   // content.js ~847
      └→ postMessage YT_SUBTITLE_DEMO_FETCH
          └→ fetchSubtitle() [inject.js ~330]
              └→ buildUrl(baseUrl, tlang)                // 加 &fmt=json3&tlang=zh-TW
                  └→ fetch 一次，YouTube 伺服器端翻譯整份字幕
                      └→ dispatchSubtitle() → scSet() → sessionStorage 快取
```

**特性**：
- **一次 API 呼叫**取得全片翻譯字幕，速度快
- 快取 key：`yt-sub-sc:VIDEO_ID:targetLang`（sessionStorage，頁面會話有效）
- 已有 `looksLikeCJK()` 驗證：若 YouTube 翻譯失敗回傳原文，不快取、送錯誤訊息

---

### 路徑 B — 外部 Google 翻譯（`translationProvider = 'google'`）

**觸發條件**：provider 設定為 `google`，且副字幕無原生 track。

**流程**：
```
autoLoadSubtitles()
  └→ pendingTranslation = { targetLang }
      └→（等 primary 字幕載完）
          └→ translateAndSetSecondary(primarySubtitles, targetLang)  // content.js ~1376
              ├─ 時間視窗：只翻當前播放位置 + 30 分鐘內的字幕
              ├─ 批次大小：8 句一批，批間延遲 400ms
              ├─ 每句各自呼叫 Google Translate API（client=gtx，免費無驗證）
              │   URL: translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t&tl=lang&q=TEXT
              ├─ 每句翻完立即 patchSubtitleItem()（逐條更新 DOM，不重建整個列表）
              └─ 翻完後存入 translationCache（記憶體，上限 10 部影片）

scheduleNextTranslationBatch()
  └→ 監視播放位置，距已翻邊界 < 5 分鐘時觸發翻下一個 30 分鐘視窗
```

**特性**：
- **逐句順序呼叫 Google API**（無並行），N 句 ≈ N × (網路延遲 + 批間等待)
- 每批 8 句後等 400ms（防止被限流）
- 翻譯結果只存記憶體（`translationCache`），**頁面重整後需重翻**
- 狀態欄即時顯示進度（`翻譯中 5/20`）

---

### 快取對比

| 快取層 | 路徑 A | 路徑 B |
|--------|--------|--------|
| sessionStorage | ✅（跨刷新有效） | ❌ |
| 記憶體 | ✅（`subtitleCache`） | ✅（`translationCache`） |
| 快取 key | `videoId:lang` | `videoId:lang` |
| 快取上限 | 20 條影片 | 10 部影片 |

---

### 已知瓶頸 / 可優化空間

| 瓶頸 | 描述 | 可能方向 |
|------|------|---------|
| 路徑 B 逐句串行 | 每句各自等待 API 回應，長片耗時 O(n) | 改為批次多句合併請求（Google API 支援長 `q=` 參數，用分隔符拼接）|
| 路徑 B 不持久化 | 頁面重整後整片重翻 | 翻譯結果存 sessionStorage（注意 quota 限制）|
| 路徑 B 批間固定 400ms | 不論 API 快慢都等 | 改為動態等待（上一批完成後直接啟動下一批）|
| 路徑 A 翻譯驗證 | 只在 path 3 驗證，path 0/1 命中舊快取時已修正 | ✅ 已修正（2026-04-12）|

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
| **選英文但顯示中文** | `&tlang=en` 翻譯靜默失敗，YouTube 直接回傳原文 CJK，inject.js 未驗證就存入 sessionStorage 並標記為「英文」；下次 sessionStorage 命中時吐出中文內容卻掛英文標籤 | Path 3 fetch 後以 `looksLikeCJK()` 驗證語言，不符則送錯誤訊息且**不快取**；Path 0 sessionStorage 命中後也做語言驗證，發現舊壞快取則先清除再重新 fetch |
| **字幕找到但不載入（語言不存在）** | `autoLoadSubtitles` 用 `settings.primaryLang`（如 `'en'`）在影片 tracks 中找對應 track，找不到時 `findPrimaryTrack` 回傳 `null`，`loadSubtitle` 完全沒被呼叫，字幕靜默不載 | `renderLanguages` 偵測偏好語言不在此影片 tracks 中（`anyMatched=false`）時，設定 `primaryOverride = displayTracks[0]` 並傳給 `autoLoadSubtitles(tracks, primaryOverride)`；**不修改 settings**，保留使用者原始偏好給下一部影片 |
| **主字幕設定被跨影片污染（primaryLang 跑掉）** | 舊修法在 `anyMatched=false` 時直接對 `settings.primaryLang/primaryVssId` 賦值（未呼叫 `saveSettings`），但 runtime settings 物件已被 mutate；之後任何操作（切 toggle、改副字幕等）觸發 `saveSettings()` 都會把 fallback 語言永久寫入 localStorage，導致下次開啟偏好語言變成別的影片的語言 | 改用 `primaryOverride` 參數：fallback 時只傳一個臨時 track 給 `autoLoadSubtitles`，完全不碰 `settings` 物件；`autoLoadSubtitles` 簽名改為 `(tracks, primaryOverride = null)`，有 override 時優先用，否則走 `findPrimaryTrack` 正常邏輯 |
| **重複句子第二次出現沒有翻譯** | YouTube 的 `&tlang=` 翻譯檔會跳過重複歌詞／台詞，只翻第一次出現；`findSubAtTime` 純按時間查，第二次出現的時間點在 `secondarySubtitles` 裡無條目，查不到 | ytlang secondary 載完後呼叫 `fillMissingSecondary()`：建立「原文小寫 → 第一個譯文」映射，對沒有時間對應的 primary subtitle 補插相同時間長度的 secondary 條目 |
| **生字本「當前影片」換頁不更新** | SPA 導航時 MutationObserver 重置字幕資料但沒呼叫 `renderWordbook()`，面板繼續顯示上一部影片的單字 | URL 變化分支補一行：若生字本面板開著則呼叫 `renderWordbook()`（`renderWordbook` 只讀 `location.search` 和 `chrome.storage`，不依賴被清空的字幕變數，安全） |

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
