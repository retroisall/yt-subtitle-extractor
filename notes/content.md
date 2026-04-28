# content.js

## 基本資訊

| 項目 | 值 |
|------|-----|
| 檔案 | `content.js` |
| 行數 | 5,428 行 |
| 執行環境 | Isolated World（Content Script） |
| 注入時機 | `document_idle` |

## 功能說明

專案最核心的模組，負責整個擴充套件的主邏輯：建立側邊欄 UI、協調字幕提取流程、執行即時翻譯、管理單字本、渲染 Overlay 字幕、LED 狀態指示，以及與 [[background]] 通訊取得 Firebase 服務。

---

## 依賴關係

### 上游（content.js 依賴）

- [[inject]] — 動態注入並監聽 `postMessage`（字幕資料）
- [[patch]] — 間接依賴（透過 inject.js 消費其快取）
- [[background]] — `chrome.runtime.sendMessage` 取得 Firebase 認證、Firestore 資料、字幕管理
- [[styles]] — 注入的 CSS（由 manifest 宣告）

### 外部 API

- `https://translate.googleapis.com` — Google Translate（免費 client=gtx）
- `https://api.dictionaryapi.dev` — 英文字典定義
- `https://api.datamuse.com` — 英文詞彙層級（CEFR 估算）

### 下游（依賴 content.js）

- [[background]] — 被動接收訊息（content 發出 sendMessage）

---

## 主要功能模組（內部）

### A. 字幕提取與協調

```javascript
// 注入 inject.js
function injectScript() {
  const s = document.createElement('script');
  s.src = chrome.runtime.getURL('inject.js');
  document.documentElement.appendChild(s);
}

// 接收字幕資料
window.addEventListener('message', (event) => {
  if (event.data.type === 'YT_SUBTITLE_DEMO_SUBTITLE_DATA') {
    handleSubtitleData(event.data);
  }
});
```

### B. 側邊欄 UI

- 建立浮動側邊欄（句子列表、語言選擇、設定）
- 滾動同步（隨播放進度高亮當前句）
- 展開/收起句子詳情

### C. 翻譯系統

**雙路徑翻譯策略**：

| 路徑 | 方式 | 優點 | 缺點 |
|------|------|------|------|
| 路徑 A | YouTube `&tlang=` 參數 | 一次 API 呼叫、快速 | 速率限制、驗證複雜 |
| 路徑 B | Google Translate `client=gtx` | 逐句可控、易驗證 | O(n) 逐句呼叫 |

```javascript
// 批次翻譯（8 句一批，間隔 400ms）
async function translateBatch(sentences) { ... }

// 翻譯快取（最多快取 10 部影片）
const translationCache = new Map(); // videoId → Map<startTime, translation>
```

### D. Overlay 字幕

- 在 YouTube 播放器上方疊加字幕文字
- 全螢幕模式自動調整位置
- 支援主字幕 + 副字幕雙行顯示

### E. LED 狀態指示

- 點陣 LED 動畫顯示當前狀態（載入中、翻譯中、同步中）

### F. 單字本（Wordbook）

```javascript
// 儲存生字
chrome.runtime.sendMessage({ 
  action: 'fb_saveWord', 
  word: selectedWord,
  context: currentSentence 
});

// 雙向同步
chrome.runtime.sendMessage({ action: 'fb_biSync' });
```

### G. 設定管理

- `chrome.storage.local` 儲存使用者偏好
- 包含：翻譯語言、自動翻譯開關、字體大小、顯示模式

---

## 狀態管理

| 狀態變數 | 說明 |
|---------|------|
| `trackList` | 可用字幕軌道列表 |
| `primarySubtitles` | 主字幕陣列 |
| `secondarySubtitles` | 副字幕陣列（翻譯後） |
| `translationCache` | 翻譯快取 Map |
| `customSubtitleActive` | 全域字幕模式旗標（重要：競爭條件來源） |
| `pendingTranslation` | 待翻譯佇列 |
| `currentVideoId` | 當前影片 ID |

---

## 同步迴圈

```javascript
// 每 100ms 執行一次
setInterval(() => {
  const currentTime = video.currentTime;
  syncSubtitleHighlight(currentTime);
  updateOverlay(currentTime);
  updateLED(currentTime);
  checkAutoTranslate(currentTime);
}, 100);
```

---

## 訊息清單（sendMessage to background）

| action | 說明 |
|--------|------|
| `fb_getUser` | 取得已登入用戶資訊 |
| `fb_signIn` | 觸發 Google OAuth 登入 |
| `fb_saveWord` | 儲存生字到 Firestore |
| `fb_getWords` | 取得單字本 |
| `fb_biSync` | 雙向同步單字本 |
| `fb_checkEditorPermission` | 確認編輯器使用權限 |
| `fb_getCommunitySubtitles` | 取得社群上傳字幕 |

---

## 踩坑記錄

- **customSubtitleActive 競爭**：多處設定全域 flag 導致字幕模式切換不穩定
- **listener 洩漏**：`timeupdate`、`setTimeout` 切換影片後未清除
- **儲存格式不一致**：primarySubtitles 曾為 array，後改為 `{primary, secondary}` 物件
- **Hover-pause 閃爍**：改用 `display:none` 而非 seek+pause 解決
- **Overlay popup z-index**：需輪詢 YouTube popup 狀態動態調整

---

## 反向依賴

- [[manifest]] — 宣告為 content script
- [[inject]] — 由此模組動態注入

---

## 相關

- [[patch]]
- [[inject]]
- [[background]]
- [[styles]]
- [[firebase]]
- [[TECHNICAL]]
- [[專案索引]]
