# landing.html

## 基本資訊

| 項目 | 值 |
|------|-----|
| 檔案 | `landing.html` |
| 行數 | 1,679 行 |
| 類型 | 純前端行銷頁（無後端，靜態 HTML） |
| 用途 | 產品官方網頁，介紹「學習Bar」Chrome 擴充套件 |

## 功能說明

產品對外展示頁，完全自包含（CSS、JS 內嵌），呈現功能特色、操作流程示範、CTA（安裝按鈕）。不與擴充套件本體互動，是獨立的行銷網頁。

---

## 設計語言

```css
:root {
  --bg:        #09090b;       /* 極深黑底 */
  --accent:    #7c3aed;       /* 紫色主色調 */
  --accent-hi: #9d5eff;       /* 紫色高亮 */
  --text:      #f4f4f5;
  --muted:     #a1a1aa;
  --green:     #22c55e;       /* 成功/功能說明 */
  --yellow:    #eab308;       /* 警示 */
}
```

- 字體：DM Sans（正文）、DM Mono（程式碼）
- 毛玻璃導覽列（`backdrop-filter: blur(16px)`）
- Noise texture 覆蓋層（SVG data URL）

---

## 頁面區塊

| 區塊 | 說明 |
|------|------|
| **Nav** | 固定導覽列（Logo + nav links + CTA 按鈕） |
| **Hero** | 主標題、副標、安裝按鈕、功能示意截圖 |
| **功能介紹** | 逐項列出核心功能（字幕載入、翻譯、生字本、社群字幕等） |
| **Journey 學習流程** | 動態示意的學習步驟流程 |
| **社群字幕** | 說明社群字幕資源庫功能 |
| **Contribute** | 呼籲使用者上傳字幕或加入社群 |
| **Footer** | 聯絡資訊、連結 |

---

## 技術特點

- **無外部 JS 框架**：全部原生 JavaScript
- **無後端依賴**：直接開啟 HTML 即可使用
- **自包含**：Google Fonts CDN 外無任何外部依賴
- **SEO 友善**：lang="zh-TW"、meta viewport

---

## QA 測試

```bash
# 版面 QA 自動化腳本
node qa-landing-layout.mjs
```

詳見 [[qa-landing-layout]]

---

## 反向依賴

- 不被 [[manifest]] 宣告（非套件本體）
- [[qa-landing-layout]] — 針對此頁的版面 QA 腳本

---

## 相關

- [[community-subtitles-page]]
- [[editor-preview]]
- [[qa-landing-layout]]
- [[專案索引]]
