# editor（編輯器子系統）

## 基本資訊

| 檔案 | 行數 | 說明 |
|------|------|------|
| `editor.html` | 86 行 | 編輯器 UI 架構 |
| `editor.js` | 937 行 | 編輯器邏輯 |
| `editor.css` | 713 行 | 編輯器視覺樣式 |

## 功能說明

獨立開啟的字幕編輯器頁面，提供字幕逐句編輯、同步播放、單句循環、本地儲存與社群分享功能。由 [[background]] 負責開啟此頁面，並提供字幕資料來源。

---

## 依賴關係

### 上游（editor.js 依賴）

- [[background]] — `chrome.runtime.sendMessage` 取得字幕資料
  - `editor_getSubtitles` — 取得目前 YouTube 分頁的字幕
  - `fb_saveCommunitySubtitle` — 上傳到社群分享

- `chrome.storage.local` — 讀取/寫入已編輯字幕
- `chrome.tabs.query` — 偵測 YouTube 分頁活性

### 下游（依賴 editor 的模組）

- [[background]] — 接收 `open_editor` 訊息後開啟此頁面
- [[content]] — 可透過 `open_editor` 訊息觸發開啟

---

## editor.html 結構

```html
<div class="editor-container">
  <div class="video-section">
    <!-- YouTube iframe 嵌入或連結 -->
  </div>
  <div class="editor-panel glass-panel">
    <div class="search-bar">...</div>
    <div class="sentence-list">
      <!-- 動態生成的字幕句子卡片 -->
    </div>
    <div class="toolbar">
      <!-- 同步、循環、儲存、匯出、分享按鈕 -->
    </div>
  </div>
</div>
```

---

## editor.js 核心功能

### 1. 字幕資料載入

```javascript
// 從 background.js 的 subtitleStore 取得
async function loadSubtitles() {
  const response = await chrome.runtime.sendMessage({
    action: 'editor_getSubtitles'
  });
  renderSentenceList(response.data);
}
```

### 2. 句子卡片渲染

```javascript
function renderSentenceCard(sentence) {
  return `
    <div class="sentence-card" data-start="${sentence.start}">
      <div class="time-badge">${formatTime(sentence.start)}</div>
      <textarea class="sentence-text">${sentence.text}</textarea>
      <textarea class="sentence-translation">${sentence.translation}</textarea>
      <div class="card-actions">
        <button class="btn-loop">⟳ 單句循環</button>
        <button class="btn-delete">✕</button>
      </div>
    </div>
  `;
}
```

### 3. YT 分頁活性檢測

```javascript
// 偵測 YouTube 分頁是否還開著
async function checkYouTubeTab() {
  const tabs = await chrome.tabs.query({ url: '*://www.youtube.com/*' });
  return tabs.length > 0;
}
```

### 4. 本地儲存格式

```javascript
// chrome.storage.local
`editedSubtitles_${videoId}`: {
  primarySubtitles: [
    { start: 0.0, end: 2.5, text: "Hello World" },
    ...
  ],
  secondarySubtitles: [
    { start: 0.0, end: 2.5, text: "你好世界" },
    ...
  ],
  editedAt: Date.now()
}
```

### 5. 匯出 SRT

```javascript
function exportSRT(subtitles) {
  return subtitles.map((sub, i) => 
    `${i + 1}\n${toSRTTime(sub.start)} --> ${toSRTTime(sub.end)}\n${sub.text}\n`
  ).join('\n');
}
```

---

## editor.css 視覺特色

- **玻璃態效果**（Glassmorphism）：`backdrop-filter: blur(20px)`
- **句子卡片動畫**：hover 時微浮起、active 時高亮邊框
- **Dark / Light 主題**：CSS 變數切換
- **響應式布局**：側邊欄可調整寬度

---

## 踩坑記錄

- **YouTube 分頁關閉後 getSubtitles 失敗**：需先確認 tab 存在，否則 subtitleStore 無資料
- **字幕格式不一致**：舊版存 array，新版存 `{primary, secondary}` 物件，需版本相容處理
- **社群分享後需刷新 editor**：上傳成功後要更新 UI 狀態（分享按鈕 → 已分享）

---

## 反向依賴

- [[manifest]] — 宣告為 `web_accessible_resources`
- [[background]] — 負責開啟此頁面（`open_editor` 訊息）
- [[content]] — 可觸發開啟編輯器

---

## 相關

- [[background]]
- [[content]]
- [[styles]]
- [[firebase]]
- [[專案索引]]
