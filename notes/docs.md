# docs/（QA 文件目錄）

## 基本資訊

| 路徑 | `docs/` |
|------|---------|
| 用途 | QA 規範、測試報告、功能驗證記錄 |
| 主要讀者 | QA 工程師、開發者 |

---

## 檔案清單

### 核心規範

| 檔案 | 說明 |
|------|------|
| `QA_READ.md` | **QA 完整測試清單**（主文件）— 涵蓋 Part 1-5，12 個功能模組 |
| `QA_report_2026-04-20.md` | 2026-04-20 版本 QA 報告 |
| `qa-report-2026-04-21.md`（在 `tests/`）| 2026-04-21 Playwright 自動化報告 |

### 功能驗證記錄（`.md`）

| 檔案 | 驗證功能 |
|------|---------|
| `qa-learned-status-v48.md` | v48 生字本「已學習」狀態顯示 |
| `qa-popup-learned-v48.md` | v48 生字本 Popup 已學習標記 |
| `qa-saveword-delete-v48.md` | v48 存字／刪字功能 |
| `qa-subtitle-mode-fix-v48.md` | v48 字幕模式修復驗證 |
| `qa-wb-expand-loop-v48.md` | v48 生字本展開循環行為 |
| `qa-wordbook-popup-v48.md` | v48 生字本 Popup 完整驗證 |
| `qa-share-refresh-v50.md` | v50 社群字幕分享後計數刷新 |

### 行為觀察記錄（`.txt`）

| 檔案 | 說明 |
|------|------|
| `qa-lang-behavior.txt` | 字幕語言選取行為原始記錄 |
| `qa-nav-btn.txt` | 導覽按鈕行為原始記錄 |
| `qa-nav-btn-real.txt` | 真實影片下導覽按鈕行為 |
| `qa-prev-btn-playing.txt` | 播放中上一句按鈕行為記錄 |
| `qa-secondary-translation.txt` | 副字幕翻譯行為記錄 |

---

## QA_READ.md 結構摘要

### Part 1：靜態代碼檢查（每次必做）

- Manifest 層：permissions、host_permissions 宣告是否完整
- Chrome API：storage callback 有無 lastError 檢查
- DOM 事件：click/contextmenu 是否被 YouTube 搶先
- 語法：`node --check content.js`

### Part 2：使用者情境測試（12 個模組）

| 模組 | 功能 |
|------|------|
| 1 | 初次啟用 / Onboarding |
| 2 | 字幕載入與語言選擇 |
| 3 | 副字幕 / 雙語模式 |
| 4 | 字幕列表互動（點字、右鍵、循環） |
| 5 | Overlay 浮動字幕（12 個測試案例） |
| 6 | 生字本 |
| 7 | 設定面板 |
| 8 | 社群字幕（9 個案例，含 SW 重啟後不 403） |
| 9 | 字幕模式（T1-T21，20 項可自動化） |
| 10 | 自定義字幕 / Google 帳號同步 |
| 11 | SPA 頁面切換 |
| 12 | 邊界情境（Edge Cases） |

### Part 3：回歸確認

改動某模組時必須同時確認的相鄰功能（如改 sync loop 需重測 Overlay + 列表循環）。

### Part 4：Playwright 自動化測試

詳細記載 CDP + isolated world 技術、現有腳本清單、可自動化 vs 手動項目對照。

→ 實作細節見 [[tests]]

### Part 5：Chrome 擴充套件測試常見失誤

記錄三大錯誤做法（`page.evaluate` 存取 chrome.*、事件訂閱晚了、注入假字幕）及正確替代方案。

---

## 反向依賴

- [[tests]] — Playwright 腳本執行的測試結果寫回此目錄
- [[content]] — 所有 QA 測試的主要目標
- [[qa_batch_test]] — 單元測試的補充

---

## 相關

- [[tests]]
- [[test-tools]]
- [[qa_batch_test]]
- [[content]]
- [[專案索引]]
