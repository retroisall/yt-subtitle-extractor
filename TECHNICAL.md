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
| **副字幕載入成功但 NOW PLAYING 和 Overlay 不同步** | sync loop 用 `primSub.startTime + primSub.duration / 2`（midpoint）查 `secondarySubtitles`；`extendSubtitles` 功能會把 primary 的 `duration` 拉長（填補句與句之間的空白），midpoint 因此跑到 secondary subtitle 的原始時間範圍之外，`findSubAtTime` 找不到 → 回傳 null；列表顯示正常是因為 `patchSubtitleItem` 直接改 DOM，不走 `findSubAtTime` | 所有 `findSubAtTime` 的 midpoint 查詢改為 `startTime + 0.1`（句子開始後 0.1 秒），確保無論 primary duration 被延伸多少，查詢點仍落在 secondary subtitle 的原始時間窗口內 |
| **生字本「當前影片」換頁不更新** | SPA 導航時 MutationObserver 重置字幕資料但沒呼叫 `renderWordbook()`，面板繼續顯示上一部影片的單字 | URL 變化分支補一行：若生字本面板開著則呼叫 `renderWordbook()`（`renderWordbook` 只讀 `location.search` 和 `chrome.storage`，不依賴被清空的字幕變數，安全） |
| **`&tlang=` 翻譯被 Google 限流（HTTP 429）** | 每部影片用 `&tlang=` 翻譯主字幕會對 YouTube timedtext API 發 4–6 次請求（warmup + native path + fallback），Google 快速封鎖 IP/session，連一般原生字幕也受影響 | 主字幕翻譯改走 Google Translate API（`translatePrimarySubtitles`，同副字幕的翻譯路徑）；只在影片有目標語言原生字幕時才直接載，否則先載原語言再 Google 翻譯；`&tlang=` 保留作 `translationProvider=ytlang` 的 fallback |
| **allTracks race condition（`lang=wd` 之類的廢 track）** | inject.js `allTracks` 是 module-level 共享變數；多個 patch.js 事件快速觸發時，後一部影片的 tracks 覆蓋前一部，fetchSubtitle 的 warmup 就拿到錯誤影片的 languageCode | 已記錄，待修：fetchSubtitle 應在進入時快照 videoId，發現 allTracks 不屬於當前影片時重新等待 |
| **Onboarding `body.innerHTML` 覆蓋導致 initSidebar crash** | `showOnboarding()` 原本用 `body.innerHTML = '<div class="yt-sub-onboarding">...</div>'` 替換整個 body；initSidebar 後續的 `getElementById` 全部回傳 null，觸發 TypeError | 改用 overlay `div`（`position: absolute; inset: 0; z-index: 10`）疊在 sidebar 上，panel HTML 始終留在 DOM；完成時只 `.remove()` overlay，不動 body 內容 |
| **`power-btn` 移除後 initSidebar crash** | v4.1 從 HTML template 移除 `⏻` 按鈕，但 initSidebar 仍有 `getElementById('yt-sub-power-btn').classList.toggle(...)` → null crash，整個 initSidebar 失敗，字幕永遠不載 | 刪除三行舊引用；同步清除 `toggleExtension` 內的 dead code |
| **sidebar 高度超出影片底部（push 順序錯誤）** | `applyLayoutMode('push')` 先呼叫 `syncWrapperToPlayer` 再設 `margin-right`，wrapper 記錄的是 push 前的影片高度；push 後影片縮小，wrapper 仍保留較大的高度，sidebar 下緣超出影片底部壓到標題 | 改為先設 `margin-right`，再呼叫 `syncWrapperToPlayer`；此時讀到的是 push 後影片的實際高度，wrapper bottom = player bottom |
| **1280/1440px `#secondary` 被 sidebar 部分遮蓋** | YouTube secondary 欄最小寬度約 348px，primary + secondary 合計 988–1201px，超過 `viewport - 360px`；`margin-right` 和 `padding-right` 都無法讓 secondary 縮到 sidebar 左邊 | sidebar 展開時直接 `#secondary { display: none !important }`，收合時 `removeProperty('display')`；1920px 以上影片內容不被遮，不需要隱藏 |
| **`>/<` 按鈕連按卡在同一句** | `_currentPrimIdx` 由 sync loop 每 100ms 用 `findActiveIndex`（duration-based）更新；seek 後若 duration 重疊或字幕極短，`findActiveIndex` 始終回傳舊 index，蓋掉剛設定的 nextIdx，下次點擊 base 永遠不動 | 拆分兩個函數：`findActiveIndex`（顯示用，需 duration，gap 回傳 -1）與 `findLastStartedIndex`（導航用，只比 startTime，永遠有值）；`>/<` 按鈕改為在點擊當下直接讀 `video.currentTime` 即時算 `findLastStartedIndex`，完全不依賴 sync loop 快取的 `_currentPrimIdx` |
| **合輯模式生字本「當前影片」為空** | `saveWord` 的 `videoId` 同步取自 `location.search`，但 `chrome.storage.local.get` callback 是 async；SPA 自動播放下一部時 URL 已切換，callback 執行時 `renderWordbook()` 用新 URL 過濾，找不到剛存的字 | `saveWord` 把已確認的 `videoId` 傳給 `renderWordbook(forceVideoId)`，強制使用存字當下的 videoId 過濾 |
| **OAuth nonce 參數不相容** | `launchWebAuthFlow` 使用 `response_type=token`（implicit flow），不支援 nonce 參數（nonce 只用於 id_token flow）；加了 nonce 後 Google 回傳「Parameter not allowed for this message type: nonce」 | 移除 OAuth URL 中的 nonce 參數 |
| **Chrome App OAuth vs Web Application** | 建立 OAuth client 時若選「Chrome App」類型，Google 要求上架 Chrome Web Store 才允許使用；開發中套件無法登入 | 改用「Web Application」類型，將 `https://<extensionId>.chromiumapp.org/` 加入授權重新導向 URI |
| **Service worker 重啟導致登入狀態消失** | MV3 service worker 閒置後會被 Chrome 終止，記憶體中的 `_idToken`、`_userInfo` 全部清空；下次啟動時 content.js 的 `fb_getUser` 在 `restoreSession` 完成前就發出，拿到 null 誤判未登入 | content.js 初始化時若第一次 `fb_getUser` 回傳 null，延遲 1.5 秒後重試；同時在 click handler 中也補呼叫 `updateAccountUI` 確保 UI 同步 |
| **SW 重啟後 share/權限 handler 403** | `fb_shareSubtitle`、`fb_registerEditorPermission` 等 5 個 handler 直接呼叫同步 `getCurrentUser()`，未等待 `_sessionReady`；SW 重啟後 `_userInfo` 為 null，即使 `_getIdToken()` 能從 storage 自動恢復 token，`getCurrentUser()` 仍回傳 null 導致提前返回「未登入」，或在 token 已存在但 `_userInfo` 尚未設定時，Firestore `uploaderUid` 欄位來源有誤造成 rule 403 | 所有需要登入的 handler 改以 `_sessionReady.then()` 包裝，確保 `restoreSession()` 完成後才進行 user check；受影響 handler：`fb_shareSubtitle`、`fb_registerEditorPermission`、`fb_checkEditorPermission`、`fb_getEditorPermissions`、`fb_setEditorPermission` |
| **Firestore PATCH 覆寫欄位** | 未設 `updateMask` 的 PATCH 請求會清除目標文件的所有欄位後再寫入，若資料有 race condition 可能導致欄位遺失 | 已知問題，目前資料模型以 word 為單位整筆覆寫，可接受；未來若有 partial update 需求再補 updateMask |
| **LED 初始狀態錯誤** | `expandSidebar()` 不呼叫 `updateBallDot`，LED 停在 idle；`startSync()` 啟動有延遲，中間狀態空白或殘留舊值 | 找到字幕時先 `setLedState('loading')` 再 `expandSidebar()`，`startSync()` 啟動時再切換成 `has-sub` 或 `paused` |

---

## Firebase 雲端同步架構

### 認證流程（launchWebAuthFlow）

```
用戶點擊帳號按鈕
  └→ content.js 發 fb_signIn 訊息給 background.js
      └→ chrome.identity.launchWebAuthFlow({ url: OAuth URL, interactive: true })
          └→ Google OAuth 彈窗 → 用戶同意
              └→ redirect 到 https://<extensionId>.chromiumapp.org/#access_token=...
                  └→ 從 hash 取 access_token
                      └→ POST /accounts:signInWithIdp?key=APIKEY
                          └→ 取得 idToken + refreshToken
                              └→ 存入 chrome.storage.local
```

**為什麼用 `launchWebAuthFlow` 而非 `getAuthToken`：**
- `getAuthToken` 需要套件上架 Chrome Web Store
- `launchWebAuthFlow` + Web Application OAuth client 在開發中套件即可使用
- redirect URI 格式：`https://<extensionId>.chromiumapp.org/`（Chrome 擴充套件專用 scheme）

### Token 自動更新

- `idToken` 有效期 1 小時（減 60 秒安全邊界）
- 每次 Firestore API 呼叫前先呼叫 `_getIdToken()`
- 若 token 已過期，自動用 `refreshToken` 向 `securetoken.googleapis.com/v1/token` 換新
- 新 refreshToken 存回 `chrome.storage.local`（sliding expiry）

### 雙向同步邏輯（fb_biSync）

```
本地 words (Map)  ×  雲端 words (Firestore)
        ↓
  對所有 key 取聯集
        ↓
  ┌ 雙方都有 → 比較時間戳（deletedAt 優先於 addedAt），取較新者
  ├ 只有本地 → 上傳到 Firestore
  └ 只有雲端 → 拉回本地
        ↓
  toUpload → batch PATCH 到 Firestore
        ↓
  merged map → 寫回 chrome.storage.local
```

**衝突解決原則**：
- 以 `deletedAt || addedAt` 的 Unix timestamp（ms）較大者為勝
- 軟刪除記錄（有 deletedAt）也會上傳，讓其他裝置知道要刪除
- 同步完後 `renderWordbook` 自動過濾 `deletedAt` 不顯示

### Firestore 安全規則

```js
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/words/{wordId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

---

## LED 點陣狀態指示器

### Canvas 架構

- 尺寸：5 列 × 3 行，dot size 4px，gap 2px → CSS 30×18px
- DPR 縮放：`canvas.width = 30 * devicePixelRatio`，`ctx.scale(dpr, dpr)`，確保 Retina 清晰
- 更新方式：`setLedState(state)` 驅動，依 anim 類型啟動 setInterval

### 狀態對照表

| 狀態 | 圖案 | 顏色 | 動畫 | 觸發時機 |
|------|------|------|------|---------|
| `idle` | 3 橫點 | 灰 #52525b | 靜止 | 無影片 / 非 watch 頁 |
| `loading` | 流水燈（5點依序） | 紫 #a78bfa | loop 160ms | 字幕清單取得中 |
| `has-sub` | 播放三角 ▶ | 綠 #4ade80 | 呼吸 50ms | 字幕播放中 |
| `no-sub` | 叉形 ✕ | 紅 #ef4444 | 閃爍×3次 | 影片無字幕 |
| `paused` | 雙豎線 ❚❚ | 黃 #fbbf24 | 呼吸 50ms | 影片暫停 |
| `syncing` | 旋轉圓弧 | 紫 #a78bfa | loop 160ms | 雲端同步進行中 |
| `signing-in` | G 字母 | 深紫 #7c3aed | 呼吸 50ms | Google 登入中 |

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

---

## 字幕功能反覆踩坑根因分析（2026-04-20）

### 為什麼字幕功能需要來回修多次？

#### 1. 全域 flag 競爭（`customSubtitleActive`）

`customSubtitleActive` 是單一布林值，控制「是否有自定義字幕啟用中」。
問題在於：
- `_restoreSavedSubtitle` 非同步，在 callback 裡設定 flag
- `fetchCommunitySubtitles`、`renderLanguages` 同步讀取 flag
- 結果：callback 尚未執行，flag 仍是 false，後續邏輯被跳過

**根因**：非同步 storage 讀取與同步 UI 流程的執行順序沒有明確協調機制。

#### 2. `timeupdate` 事件監聽器洩漏

`enterEditMode` 每次呼叫都 `addEventListener`，但 `exitEditMode` 沒有對應的 `removeEventListener`。
因為 listener 是匿名 function，無法正確移除，造成：
- 多個 listener 同時存在
- `_loopActive = true` 的舊 listener 持續呼叫 `vid.pause()`
- 外觀正常但播放被鎖死

**根因**：listener 用匿名函式，無法被 remove。修法：存成 module-level 具名變數。

#### 3. 儲存格式不一致

- 本地存：只存 `primarySubtitles`（陣列）
- 社群存：存 `{ primarySubtitles, secondarySubtitles }` 物件
- 社群上傳：`secondarySubtitles` hardcode 為 `[]`

造成副字幕完全無法在任何跨 session 情境下保留。
**根因**：儲存和上傳邏輯分屬不同 PR/修改時期，沒有統一規格。

#### 4. `_restoreSavedSubtitle` 呼叫點不完整

原本只在 `YT_SUBTITLE_DEMO_SUBTITLE_DATA` message handler 中呼叫（YouTube 字幕資料回傳後）。
若影片完全沒有 YouTube 字幕，該 message 永遠不會觸發，還原邏輯就完全不執行。

**根因**：設計時假設「所有影片都有 YT 字幕」，沒有考慮無字幕影片路徑。

---

### 防範措施

| 問題類型 | 防範方式 |
|---------|---------|
| 非同步競爭 | 在 callback 入口再次 guard check flag，不依賴外層時序 |
| listener 洩漏 | 所有 addEventListener 的 handler 必須存為具名變數，exitMode 時明確 remove |
| 儲存格式 | 統一以物件 `{ primarySubtitles, secondarySubtitles }` 存取，讀取兼容舊格式 |
| 呼叫路徑缺口 | 功能函式呼叫點要覆蓋所有可能的 entry（有字幕/無字幕/reload 等路徑） |

---

## 2026-04-21 技術日報

### 語言自動切換 bug 根因與修正

**問題**：主字幕語言在使用者未操作的情況下自動切換為土耳其文等非英語語系。

**根因分析**：
- `renderLanguages` 在 `anyMatched=false`（影片無偏好語言）時，下拉選單 UI 自動選中第一個可用 track（例如土耳其文）
- 使用者切換任何設定（字型大小、ASR 語言等）觸發 `saveSettings()`
- `saveSettings()` 將整個 `settings` 物件序列化，包含被 change event 改掉的 `settings.primaryLang='tr'`
- 下次載入時 'tr' 成為全域偏好語言

**修正方式**：
- 在 `langDropdown.change` handler 中加 `anyMatched` guard
- `anyMatched=true`（影片有偏好語言）：使用者切換視為全域偏好更新，更新 settings 並立即 `saveSettings()`
- `anyMatched=false`：切換僅為臨時 in-video 覆蓋，不觸碰 `settings.primaryLang`
- 「套用」按鈕屬明確操作，不論 anyMatched 為何都更新並持久化

**關鍵程式碼位置**：`content.js renderLanguages()` → `langDropdown.addEventListener('change', ...)`

---

### sync loop DOM 抖動修正

**問題**：字幕同步每 100ms 執行一次，DOM 持續抖動。

**根因**：
1. `ovSec.textContent = secText` 每 100ms 無條件寫入，即使文字未變
2. `curSecEl.textContent = ...` 同上
3. `scrollIntoView({ behavior: 'smooth' })` 對同一列表項每 100ms 重複驅動，smooth scroll 不斷競爭
4. `items[i].classList.toggle('active', ...)` 對所有列表項每 100ms 全跑一遍

**修正方式**：
- 所有 textContent 寫入改為 `dataset.text` 防護：只有內容改變才寫
- `curWrap.classList.toggle` 加 `dataset.active` 防護
- 新增模組層級 `_lastSyncPrimIdx` 追蹤上一次的 primIdx
- 只有 primIdx 改變時才重跑整個列表 classList 更新
- `scrollIntoView` 移至 primIdx 改變判斷內，確保每次 index 切換只呼叫一次
- 移除 loop debug 用的 `console.log`（對效能有明顯影響）

---

### 字幕查詢 popup 視覺改版

- 寬度 320→640px，padding 12→24px，max-height 420→80vh
- 所有字體 ×1.5（主詞 28px、中文翻譯 24px、定義/例句 18px）
- 定位從 anchor 旁邊改為 `left:50% top:50% transform:translate(-50%,-50%)` 畫面正中
- 新增 `.yt-sub-popup-save-btn`：`_savedWordSet` 即時判斷是否已存，已存顯示灰色 disabled 狀態
- 按鈕點擊呼叫 `saveWord()`，同步更新按鈕文字與 classList，無需重開 popup

---

### 下拉選單箭頭統一

- 所有 `.yt-sub-lang-select`、`.yt-sub-select` 加上 `appearance: none`
- 以 `background-image` 注入 SVG chevron（URL-encoded），`background-position: right 8px center`
- `padding-right: 28px` 確保文字不被箭頭遮蓋
- 視覺效果：箭頭間距一致，顏色 `#a1a1aa`，各瀏覽器行為統一

---

### Overlay 導覽按鈕改善

- HTML entities `&#8249;`/`&#8250;`（‹ ›）字形在字型中不對稱，水平置中偏差
- 改為內嵌 SVG `<polyline>`，`viewBox="0 0 24 24"` 路徑精確對稱
- `align-items` 從 `flex-end` 改為 `center`，`align-self: center` 補強
- 導覽按鈕現在永遠垂直置中於字幕 body

---

## 2026-04-22 技術日報

### 字幕模式（Subtitle Mode）功能實作

**架構**：
- 進入時把 `#movie_player video` 搬到 `.ysm-video-box`，加上 class `.ysm-real-video`
- 離開時歸還給 `#movie_player`，恢復 visibility
- 所有字幕模式內部的 video selector 一律使用 `.ysm-real-video || video`，不依賴原位置

**關鍵實作**：
- `buildTokenizedText(container, text, startTime)` 共用：字幕列表、Overlay、字幕模式三處使用同一函式，單字 span 含 startTime / videoId / sentenceText
- 循環按鈕 click handler 直接呼叫 `updateCurrentLoopStyle()`，裡面再呼叫 `updateWbLoopBtn()`，後者統一更新所有 `.ysm-loop-btn`、`.yt-sub-wb-row-loop`
- `_ysmSyncInterval`（300ms）只在 `activeIdx !== _ysmLastActiveIdx` 時才 scrollIntoView，避免鎖定手動捲動

---

### 字幕模式 timeupdate listener 洩漏

| 項目 | 說明 |
|------|------|
| 問題 | `enterSubtitleMode` 內定義的 `_ysmSyncControls` 函式綁到 video 的 timeupdate，退出後仍持續觸發 |
| 根因 | 函式定義在 closure 內，exitSubtitleMode 無法取到參考 |
| 修正 | 新增模組層級 `let _ysmTimeUpdateHandler = null`，進入時存 ref，退出時 removeEventListener |
| 位置 | `enterSubtitleMode()` L3474、`exitSubtitleMode()` L3610 |

---

### 本地字幕被 YouTube 字幕覆蓋（多層競爭）

這是今日最複雜的 bug，涉及多個非同步競爭點。

**問題現象**：使用者有本地字幕（editedSubtitles_xxx），頁面重新整理後有時顯示本地字幕，有時被 YouTube 字幕蓋掉。

**根因 1：message handler 無 customSubtitleActive 保護**
```javascript
// 修正前（inject.js 字幕資料回來後直接覆蓋）
if (tag === 'primary') {
  primarySubtitles = parsed;   // ← 不管 customSubtitleActive
}
// 修正後
if (tag === 'primary') {
  if (!customSubtitleActive) {
    primarySubtitles = parsed;
  }
  if (customSubtitleActive) { renderSubtitleList(); startSync(); return; }
}
```

**根因 2：_restoreSavedSubtitle 未設 customSubtitleActive = true**
```javascript
// 修正前：本地字幕還原後 customSubtitleActive 仍為 false
if (savedPrimary?.length) {
  primarySubtitles = savedPrimary;
  // ...
}
// 修正後
if (savedPrimary?.length) {
  customSubtitleActive = true;  // ← 必須最先設，防止後續事件覆蓋
  primarySubtitles = savedPrimary;
  // ...
}
```

**根因 3：翻譯函數 / 狀態函數蓋掉 status**

下列函式在 `customSubtitleActive = true` 時仍無條件更新 `yt-sub-status`：
- `translateAndSetSecondary` 翻譯完成（"主：英文（6 句）"）
- `translatePrimarySubtitles` 翻譯進度
- `_showTranslationGate`（未登入提示）
- `renderLanguages` 的「找到 N 個字幕語言」

**全部補上 `!customSubtitleActive` 保護**。

**除錯流程**：用 Playwright CDP `Runtime.consoleAPICalled` 捕獲 extension isolated world console，在 `_restoreSavedSubtitle` 加 log，確認 restore 確實執行且 hasData=true，才發現是翻譯函數 2 秒後覆蓋 status。

---

### QA 自動化：本地字幕策略

**問題**：YouTube pot token 在 headless 模式下可能失敗，字幕不可靠。

**解法**：用 CDP 寫入 `editedSubtitles_<videoId>` 到 `chrome.storage.local`（extension isolated world），利用套件的本地字幕還原機制，完全繞過 YouTube 字幕 HTTP 請求。

**關鍵程式碼**（`tests/qa-subtitle-mode.mjs`）：
```javascript
// 1. 寫入本地字幕
await storageSet(client, ctxId, `editedSubtitles_${VIDEO_ID}`, {
  primarySubtitles: [...],
  secondarySubtitles: [],
});
// 2. 頁面重新整理，套件自動還原
await page.reload({ waitUntil: 'domcontentloaded' });
// 3. 等待狀態文字確認
await pollStatusText(page, '已還原', 15000);
```

**注意**：`waitForExtContext` 必須在 `page.reload()` 之前就開始監聽，否則 extension context 建立事件會漏掉。

---

### updateCurrentLoopStyle 短路問題

**問題**：字幕模式切換循環句（從句 A 到句 B，都是 looping=true），`updateCurrentLoopStyle` 的 `_lastLoopingState` 防抖直接 return，`updateWbLoopBtn` 不執行，`.ysm-loop-btn` 的 active 不更新。

**修正**：
```javascript
function updateCurrentLoopStyle() {
  // 先更新 row 按鈕（不受短路影響）
  updateWbLoopBtn();
  const looping = loopingIdx >= 0;
  if (looping === _lastLoopingState) return;
  _lastLoopingState = looping;
  // 只有 on/off 狀態改變才更新全域樣式
  document.getElementById('yt-sub-current')?.classList.toggle('looping', looping);
  document.getElementById('yt-sub-ov-body')?.classList.toggle('looping', looping);
}
```

`updateWbLoopBtn` 同時更新 `.yt-sub-wb-row-loop`（生字本列）和 `.ysm-loop-btn`（字幕模式列）。

---

### YouTube Popup 遮擋：跨 Isolated World 的坑

**問題**：側邊欄 `z-index: 9999` 蓋住 YouTube 通知/帳號等 popup。

**第一次嘗試（失敗）**：在 `content.js`（isolated world）用 `MutationObserver` 監聽 `ytd-popup-container`，偵測到子元素出現時把 `#yt-sub-wrapper` 的 `z-index` 降到 `1000`。

**QA 驗證方式（失敗）**：在測試中 `document.createElement('tp-yt-iron-dropdown')` 加入 `ytd-popup-container`，等 MutationObserver 觸發。測試通過，但實際截圖仍然遮擋。

---

**踩坑 1：Polymer 自定義元素 connectedCallback 會立刻覆寫屬性**

用 `document.createElement('tp-yt-iron-dropdown')` 建立元素後，Polymer 的 `connectedCallback` 會在 append 到 DOM 時**自動把 `aria-hidden` 設回 `"true"`**。  
所以 `popup.querySelector('tp-yt-iron-dropdown:not([aria-hidden="true"])')` 永遠找不到。

**驗證方式**：
```javascript
const d = document.createElement('tp-yt-iron-dropdown');
d.setAttribute('aria-hidden', 'false');
popup.appendChild(d);
// 立刻查詢 → null，因為 connectedCallback 已把屬性改掉
const found = popup.querySelector('tp-yt-iron-dropdown:not([aria-hidden="true"])'); // null
```

**正確測試方式**：找頁面上**已存在**的 dropdown，直接改其 `aria-hidden` 屬性：
```javascript
const existing = document.querySelector('tp-yt-iron-dropdown'); // 已有，aria-hidden="true"
existing.setAttribute('aria-hidden', 'false'); // 模擬 popup 開啟
```

---

**踩坑 2：MutationObserver 在 isolated world 無法可靠偵測 page context 的 DOM 變動**

即使 MutationObserver 在 content script（isolated world）監聽 `document.body`，當 **page context** 修改 DOM 時，observer 不一定會即時觸發（V8 跨 context 的 microtask 調度問題）。

**解法**：改用 `setInterval` 輪詢，每 150ms 執行一次 `_ytPopupIsOpen()`。輪詢在 isolated world 裡是穩定的，不依賴跨 world 的 MutationObserver 觸發。

```javascript
let _lastPopupOpen = false;
setInterval(() => {
  const isOpen = _ytPopupIsOpen();
  if (isOpen === _lastPopupOpen) return;
  _lastPopupOpen = isOpen;
  const wrapper = document.getElementById('yt-sub-wrapper');
  if (wrapper) wrapper.style.zIndex = isOpen ? '1000' : '';
}, 150);
```

---

**踩坑 3：`ytd-popup-container.querySelector()` 找不到其子元素**

在 page context 對 `ytd-popup-container`（Polymer 自定義元素）使用 `.appendChild()` 加入子元素後，`popup.querySelector()` 依然回傳 null，`popup.children.length` 也不增加。  
推測原因：Polymer 元素的 `connectedCallback` 攔截了 light DOM 的插入，把子元素搬到 Shadow Root 或丟棄。

**解法**：`_ytPopupIsOpen()` 改從 `document`（非 `popup`）全域搜尋，確保能找到 Shadow DOM 外的 dropdown：
```javascript
function _ytPopupIsOpen() {
  if (document.querySelector(
    'tp-yt-iron-dropdown:not([aria-hidden="true"]), iron-dropdown:not([aria-hidden="true"])'
  )) return true;
  const popup = document.querySelector('ytd-popup-container');
  return popup ? Array.from(popup.children).some(el => el.getBoundingClientRect().height > 0) : false;
}
```


---

## 關鍵技術 N：Hover-Pause 與 Overlay DOM 控制

### 背景

YEM hover-pause 功能：滑鼠移入字幕 overlay 時，若字幕切換，影片自動暫停並凍結顯示原句；移出後恢復播放。

---

**踩坑 1：`pointer-events: none` 導致 mouseenter 永遠不觸發**

`#yt-sub-overlay`（最外層容器）設了 `pointer-events: none`（讓點擊穿透到 YouTube 播放器）。若把 `mouseenter` / `mouseleave` 綁在此元素上，事件永遠不會觸發，但 CSS `:hover` 仍有效（CSS hover 不受 pointer-events 限制）。

現象：透明度/背景色因 CSS `:hover` 正常變化，但 JS 監聽毫無反應。

**解法**：事件綁在子元素 `#yt-sub-ov-body`（`pointer-events: all`），而非 overlay 本體：

```javascript
// 錯誤：overlay 本體有 pointer-events:none，mouseenter 不觸發
overlay.addEventListener('mouseenter', ...);

// 正確：綁在有 pointer-events:all 的子元素
const ovBody = overlay.querySelector('#yt-sub-ov-body');
ovBody.addEventListener('mouseenter', () => { _ovHovering = true; });
ovBody.addEventListener('mouseleave', () => { ... });
```

---

**踩坑 2：YouTube 字幕通常無間隙，`primIdx === -1` 判斷永遠不成立**

字幕切換判斷用 `primIdx === -1`（字幕結束後有空白間隙才觸發）。但大多數 YouTube 字幕 A 結束的瞬間 B 立刻開始，`primIdx` 從 A 的 index 直接跳到 B，永遠不經過 `-1`。

**解法**：改判斷「字幕切換到不同句子」（含有間隙與無間隙兩種情況）：

```javascript
// 錯誤：只捕捉有空隙的情況
&& _currentPrimIdx >= 0 && primIdx === -1

// 正確：有間隙（→-1）或直接切換（→下一句）都觸發
&& _currentPrimIdx >= 0 && primIdx !== _currentPrimIdx
```

---

**踩坑 3：rewind + pause 連用導致字幕閃爍**

為了在暫停後仍顯示原句，嘗試 `video.currentTime = sub.endTime - 0.05` + `video.pause()`。seek 觸發瀏覽器非同步 repaint，會有一幀空白字幕閃爍。

**解法**：完全不動 `video.currentTime`，改用狀態變數凍結顯示層：

```javascript
// 暫停時儲存要凍結的字幕物件
_ovFrozenSub = primarySubtitles[_currentPrimIdx];
video.pause();
_ovPausedForHover = true;

// 渲染時，凍結期間強制用 _ovFrozenSub 取代 primSub
const displaySub = (_ovPausedForHover && _ovFrozenSub) ? _ovFrozenSub : primSub;
```

---

**踩坑 4：狀態更新必須在依賴它的計算之前**

`secSub`（副字幕）依賴 `_ovPausedForHover` 和 `_ovFrozenSub` 來決定查找時間點。若 hover-pause trigger 寫在 `secSub` 計算之後，trigger 發動的那一幀 `_ovPausedForHover` 還是 `false`，導致副字幕凍結失敗（主字幕正確，副字幕跑到下一句）。

**正確順序**：

```javascript
// 1. 先算 primSub（不依賴凍結狀態）
const primSub = primIdx >= 0 ? primarySubtitles[primIdx] : null;

// 2. 執行 hover-pause trigger，更新 _ovFrozenSub 和 _ovPausedForHover
if (_ovHovering && !_ovPausedForHover && ...) {
  _ovFrozenSub = primarySubtitles[_currentPrimIdx];
  video.pause();
  _ovPausedForHover = true;
}

// 3. 才計算 secSub（此時 _ovPausedForHover 已是最新值）
const secLookupSub = (_ovPausedForHover && _ovFrozenSub) ? _ovFrozenSub : primSub;
const secSub = secLookupSub ? findSubAtTime(secondarySubtitles, secLookupSub.startTime + 0.1) : null;

// 4. 最後渲染，主副都用凍結狀態決定
const displaySub = (_ovPausedForHover && _ovFrozenSub) ? _ovFrozenSub : primSub;
```

---

## 單句循環（loopSentence）踩坑

### 踩坑 1：rewind 觸發 sentenceChanged → auto-pause 誤觸發

**問題**：每次 loop rewind（`video.currentTime = loopSub.startTime`）發生在 tick T。在 tick T 的最後，`_currentPrimIdx` 被更新為下一句的 index（`primIdx` 此時是下一句）。tick T+1 時，video 已回到 looping 句，`primIdx = loopingIdx`，與 `_currentPrimIdx`（下一句）不同 → `sentenceChanged = true`，若 `autoPauseEvery` 開啟或使用者正在 hover，每次 loop 都會多暫停一次。

**修正**：加 `_loopJustRewound` 旗標。loop check 執行 rewind 時設為 `true`；下一 tick 開始時讀取後立刻清除；`sentenceChanged` 判斷加 `&& !wasLoopRewound`。

```javascript
// sync loop 開頭
const wasLoopRewound = _loopJustRewound;
_loopJustRewound = false;

// sentenceChanged 判斷
const sentenceChanged = _currentPrimIdx >= 0 && primIdx !== _currentPrimIdx && !wasLoopRewound;

// loop check 結尾
if (tSub >= loopSub.startTime + Math.max(rawDuration || 0, 1)) {
  video.currentTime = loopSub.startTime - (settings.subtitleOffset || 0);
  _loopJustRewound = true;
}
```

同樣地，設定 loop 時手動 seek（從字幕清單點擊）也會造成 `sentenceChanged` 誤觸，在設定 `loopingIdx` 時也一併設 `_loopJustRewound = true`。

### 踩坑 2：extendSubtitles 讓 loop 等太久

**問題**：`extendSubtitles` 功能把 `primarySubtitles[i].duration` 延伸到下一句開始前（填滿間隙），loop check 用 `loopSub.duration` 計算結束點，結果等到延伸後的時間才 rewind，明顯比自然說完的時間晚。

**修正**：loop check 改用 `_rawPrimarySubtitles[loopingIdx]?.duration`（未延長的原始值），fallback 到 `loopSub.duration`。

```javascript
const rawDuration = (_rawPrimarySubtitles[loopingIdx] ?? loopSub)?.duration;
if (loopSub && tSub >= loopSub.startTime + Math.max(rawDuration || 0, 1)) { ... }
```

### 踩坑 3：subtitleOffset 讓 loop seek 偏移

**問題**：字幕偏移（subtitleOffset）不存在 subtitle 物件內，而是在 sync loop 查詢時套用（`tSub = t + offset`）。loop check 若用 `t` 比對，offset 非零時 rewind 時機偏差；seek target 若用 `loopSub.startTime`，video 實際停在錯誤位置。

**修正**：loop check 改用 `tSub`，seek target 改為 `loopSub.startTime - offset`。

---

## Overlay 複製按鈕

### 設計要點

複製按鈕（`#yt-sub-ov-copy`）與自動暫停切換按鈕（`#yt-sub-ov-pause-toggle`）採相同的懶載策略：第一次 `mouseenter` 時才建立 DOM，之後靠 CSS 控制顯示／隱藏。

| 元素 | 位置 | 預設 opacity |
|---|---|---|
| `#yt-sub-ov-pause-toggle` | `bottom: 6px; right: 8px` | 0（hover 顯示） |
| `#yt-sub-ov-copy` | `top: 6px; right: 8px` | 0（hover 顯示） |

### 複製來源

直接讀取 `#yt-sub-ov-primary` 的 `dataset.text`，這是 sync loop 每次更新時寫入的值，hover-pause 凍結期間也保持凍結句的文字，不會誤複製到下一句。

```javascript
const text = document.getElementById('yt-sub-ov-primary')?.dataset.text || '';
navigator.clipboard.writeText(text).then(() => { /* 切換圖示 1.5s */ });
```

### 注意事項

- `e.stopPropagation()` 必須加，否則點擊複製會冒泡到 `#yt-sub-ov-body` 的 click handler，意外觸發單句循環的設定／取消。
- `navigator.clipboard.writeText` 需要頁面在 focus 狀態，YouTube 全螢幕播放時仍可使用（document 保有 focus）。

