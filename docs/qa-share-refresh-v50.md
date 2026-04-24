# QA 報告 v5.0 — 社群字幕分享修正 + UI 設計一致性

**日期**：2026-04-24  
**版本**：v5.0  
**測試類型**：靜態代碼檢查 + 功能驗證  

---

## Part 1：靜態代碼檢查

### T1 — background.js：5 個 handler 補上 `_sessionReady`

```bash
grep -c "_sessionReady.then" d:/dev/chrome字幕套件開發/background.js
```

**預期**：≥ 9（原有 4 個 fb_saveWord/getWords/syncLocal/deleteWord/biSync + 新增 5 個）  

驗證標的：
- `fb_shareSubtitle` ✅ 含 `_sessionReady.then`
- `fb_registerEditorPermission` ✅ 含 `_sessionReady.then`
- `fb_checkEditorPermission` ✅ 含 `_sessionReady.then`
- `fb_getEditorPermissions` ✅ 含 `_sessionReady.then`
- `fb_setEditorPermission` ✅ 含 `_sessionReady.then`

**結果**：PASS

---

### T2 — content.js：分享成功後呼叫 `fetchCommunitySubtitles()`

```bash
grep -A2 "分享成功" d:/dev/chrome字幕套件開發/content.js | grep fetchCommunitySubtitles
```

**預期**：找到 `fetchCommunitySubtitles()` 呼叫  
**結果**：PASS

---

### T3 — content.js：存在 `REFRESH_COMMUNITY` 訊息處理器

```bash
grep "REFRESH_COMMUNITY" d:/dev/chrome字幕套件開發/content.js
```

**預期**：至少 2 行（handler 定義 + fetchCommunitySubtitles 呼叫）  
**結果**：PASS

---

### T4 — editor.js：分享成功後發送 `editor_relay` + `REFRESH_COMMUNITY`

```bash
grep -A5 "分享成功" d:/dev/chrome字幕套件開發/editor.js | grep REFRESH_COMMUNITY
```

**預期**：找到 `REFRESH_COMMUNITY`  
**結果**：PASS

---

### T5 — styles.css：popup 字體縮減確認

```bash
grep -A2 "#yt-sub-word-popup {" d:/dev/chrome字幕套件開發/styles.css | grep "width\|font-size\|padding"
```

**預期**：`width: 360px`、`font-size: 12px`、`padding: 12px 16px`  
**結果**：PASS

---

### T6 — styles.css：expanded card 字體還原確認

```bash
grep -A2 ".yt-sub-wb-word {" d:/dev/chrome字幕套件開發/styles.css | grep font-size
grep -A2 ".yt-sub-wb-zh {" d:/dev/chrome字幕套件開發/styles.css | grep font-size
```

**預期**：`font-size: 14px`（word）、`font-size: 11px`（zh）  
**結果**：PASS

---

### T7 — styles.css：按鈕圓角統一為 8px

```bash
grep -A8 ".yt-sub-wb-row-play {" d:/dev/chrome字幕套件開發/styles.css | grep border-radius
grep -A8 ".yt-sub-wb-del {" d:/dev/chrome字幕套件開發/styles.css | grep border-radius
grep -A8 ".yt-sub-wb-learned-btn {" d:/dev/chrome字幕套件開發/styles.css | grep border-radius
```

**預期**：三個 `border-radius: 8px`  
**結果**：PASS

---

### T8 — 語法檢查

```bash
node --check d:/dev/chrome字幕套件開發/content.js
node --check d:/dev/chrome字幕套件開發/background.js
node --check d:/dev/chrome字幕套件開發/editor.js
```

**結果**：PASS（無語法錯誤）

---

## 結論

| # | 項目 | 結果 |
|---|------|------|
| T1 | 5 個 handler 補 `_sessionReady` | ✅ PASS |
| T2 | 分享成功後刷新計數 (content.js) | ✅ PASS |
| T3 | `REFRESH_COMMUNITY` handler 存在 | ✅ PASS |
| T4 | editor.js relay `REFRESH_COMMUNITY` | ✅ PASS |
| T5 | popup 縮 20%（360px / 12px） | ✅ PASS |
| T6 | expanded card 還原原始字體 | ✅ PASS |
| T7 | 按鈕圓角統一 8px | ✅ PASS |
| T8 | 三個檔案語法正確 | ✅ PASS |

**所有測試通過。功能驗證（Part 2）需在真實 YouTube 頁面手動確認社群字幕分享 + 計數刷新行為。**

---

## 手動驗證清單（Part 2）

| # | 操作 | 預期 |
|---|------|------|
| M1 | 以 editor 帳號登入後，分享字幕（content.js 內嵌編輯器）| 分享成功 alert 後，字幕來源選單的「👥 社群字幕 (N)」數字立即 +1 |
| M2 | 以 editor 帳號登入後，從獨立 editor.html 分享字幕 | 分享成功 alert 後，YT 分頁的社群字幕計數自動刷新（若 YT 分頁仍開著）|
| M3 | 點擊「👥 社群字幕」開啟 Picker | Picker 列表包含剛分享的字幕 |
| M4 | SW 重啟後（關閉所有分頁 5 分鐘再重開）分享字幕 | 不再出現「分享失敗：Missing or insufficient permissions」 |
| M5 | 查看 popup 字典 popup 外觀 | 縮小後仍清晰可讀，不壓縮到難以辨識 |
| M6 | 展開生字本卡片 | 字體大小回到原始尺寸（單字 14px），按鈕圓角與 popup 一致 |
