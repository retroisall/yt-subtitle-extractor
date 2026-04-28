# editor-preview.html

## 基本資訊

| 項目 | 值 |
|------|-----|
| 檔案 | `editor-preview.html` |
| 行數 | 153 行 |
| 類型 | 靜態 UI 原型（設計預覽用） |
| 用途 | 在沒有套件環境下，視覺確認 editor.css 樣式效果 |

## 功能說明

`editor.html` 的靜態展示版本。強制顯示 YouTube iframe（`#ed-yt-iframe`），隱藏 placeholder，預填假字幕卡片（Rick Astley 歌詞），方便在單純開啟 HTML 時直接看到編輯器完整樣式。

---

## 與 editor.html 的差異

| 項目 | editor-preview.html | editor.html |
|------|--------------------|-----------| 
| 用途 | 設計預覽（靜態） | 真實功能頁面 |
| 字幕來源 | 預填假資料 | `chrome.runtime.sendMessage` |
| YouTube iframe | 強制顯示（RickRoll） | 動態決定是否嵌入 |
| JS 邏輯 | 僅 textarea 自動高度 | 完整 editor.js |

---

## 硬編碼資料

```html
<!-- 預填 Rick Astley - Never Gonna Give You Up 歌詞作為示範 -->
<div class="ed-card">
  <div class="ed-card-preview main">We're no strangers to love</div>
  <div class="ed-card-preview sec">我們對愛情並不陌生</div>
</div>
<!-- 第 3 句模擬 FOCUS 狀態（展開 textarea） -->
<div class="ed-card ed-row-focused">...</div>
```

---

## 使用方式

```bash
# 直接在瀏覽器開啟
open editor-preview.html
# 或雙擊檔案，不需任何伺服器
```

---

## 反向依賴

- 不被 [[manifest]] 宣告（純設計工具）
- 依賴 [[editor]] 的 `editor.css` 作為樣式來源

---

## 相關

- [[editor]]
- [[DESIGN]]
- [[專案索引]]
