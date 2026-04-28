# 根目錄測試工具（Root-level Test Scripts）

## 基本資訊

| 檔案 | 行數 | 說明 |
|------|------|------|
| `test.mjs` | 95 | 基礎冒煙測試（Smoke Test） |
| `test-playlist.mjs` | 97 | 播放清單／合輯模式測試 |
| `test-ui-scenarios.mjs` | 674 | UI 交錯情境完整驗證 |
| `debug-interactive.mjs` | 171 | 互動式 DOM 快照工具 |
| `inspect-layout.mjs` | 100 | YouTube RWD 版面量測工具 |
| `qa-community-subtitles.mjs` | 343 | 社群字幕功能 QA（TC-1~TC-4） |
| `qa-landing-layout.mjs` | 152 | landing.html 版面 QA |

---

## 各腳本說明

### test.mjs — 基礎冒煙測試

最簡單的整合測試：驗證套件載入後側邊欄出現、語言按鈕顯示、點選後字幕載入。

```bash
node test.mjs
```

測試影片：`jNQXAC9IVRw`（"Me at the zoo"，有英文和德文字幕）

主要驗證點：
- 側邊欄 `#yt-sub-demo-sidebar` 出現（10 秒 timeout）
- `.yt-sub-demo-lang-btn` 按鈕出現
- 點選第一個語言後字幕內容載入

---

### test-playlist.mjs — 播放清單模式

驗證帶 `&list=` 參數的合輯 URL 下，套件是否正常運作，以及 SPA 導航到合輯第二部影片後字幕是否重新載入。

```bash
node test-playlist.mjs
```

---

### test-ui-scenarios.mjs — UI 交錯情境（674 行）

多情境整合測試，包含：
- 注入 `onboardingDone=true` 確保不顯示 Onboarding
- 驗證 sidebar wrapper 位置（`wrapperTop ≈ playerTop`）與高度（`wrapperH ≈ playerH`）
- 驗證 `#secondary` 隱藏/還原行為
- 合輯模式（`&list=` 參數）下的佈局
- 各截圖存於 `docs/qa-screenshots/{timestamp}/`

```bash
node test-ui-scenarios.mjs
```

---

### debug-interactive.mjs — 互動式 DOM 快照

開啟帶套件的 Chrome，每 2 秒自動偵測 sidebar 是否展開，一旦展開就自動抓取 DOM 快照（不需按 Enter）。

擷取內容：viewport 尺寸、`ytd-app` margin、`#primary`/`#secondary` 位置、是否為劇院模式等。

```bash
node debug-interactive.mjs
```

---

### inspect-layout.mjs — YouTube RWD 版面量測

研究工具：在 1280/1440/1600/1920px 四種視窗寬度下，量測 YouTube 播放器、primary、secondary 的實際 BoundingRect，找出 sidebar push 的正確計算方式。

```bash
node inspect-layout.mjs
```

---

### qa-community-subtitles.mjs — 社群字幕 QA

測試 TC-1～TC-4 四個社群字幕使用案例：

| TC | 說明 |
|----|------|
| TC-1 | 社群字幕按鈕解鎖（有資料時按鈕可點擊） |
| TC-2 | Picker 面板出現且列出版本 |
| TC-3 | 選取後字幕列表更新 |
| TC-4 | 無社群字幕時按鈕 disabled |

使用 persistent profile（`.playwright-profile`），截圖存於 `qa-screenshots/community/`。

```bash
node qa-community-subtitles.mjs
```

---

### qa-landing-layout.mjs — Landing 版面 QA

以 headless Chrome 開啟 `landing.html`，量測：
- `journey-section` 的 `padding-bottom` 是否為 140px
- `journey-section` 底部到 `#contribute` 頂部的像素距離
- 截圖全頁（Hero 到 #contribute）

```bash
node qa-landing-layout.mjs
```

---

## 反向依賴

- [[package]] — 依賴 playwright
- [[content]] — 主要測試目標
- [[landing]] — `qa-landing-layout.mjs` 的測試目標
- [[community-subtitles-page]] — `qa-community-subtitles.mjs` 的測試目標

---

## 相關

- [[tests]]
- [[qa_batch_test]]
- [[landing]]
- [[community-subtitles-page]]
- [[package]]
- [[專案索引]]
