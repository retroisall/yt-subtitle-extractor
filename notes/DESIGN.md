# DESIGN/（設計稿原型目錄）

## 基本資訊

| 路徑 | `DESIGN/` |
|------|-----------|
| 檔案數 | 12 個（11 個 HTML 原型 + 1 個 `design_READ.md`） |
| 用途 | UI 設計探索與協作溝通，實作前的視覺確認工具 |

## 功能說明

純靜態 HTML 原型，用於在實作前確認視覺設計方向，以及設計與開發之間的溝通媒介。所有原型與 [[content]] 或 [[styles]] 無直接程式關係，不被 [[manifest]] 宣告。

---

## 原型清單

| 檔案 | 說明 |
|------|------|
| `design-A.html` | 方案 A：Midnight Glass 側邊欄（深色漸層背景 + 毛玻璃） |
| `design-B.html` | 方案 B：側邊欄替代設計 |
| `design-C.html` | 方案 C：側邊欄第三方案 |
| `design-ball.html` | **懸浮球元件**原型（橫向展開動畫） |
| `design-custom-subtitle.html` | 自定義字幕介面原型 |
| `design-dotmatrix.html` | LED 點陣動畫效果原型 |
| `design-dotmatrix - 複製.html` | LED 點陣動畫備份版本 |
| `design-edit-mode.html` | 字幕編輯模式 UI 原型 |
| `design-header-refresh.html` | Header 重新整理按鈕設計 |
| `design-onboarding.html` | 首次啟動 Onboarding 流程原型 |
| `design-preview.html` | 整體預覽畫面 |
| `design-subtitle-priority.html` | 字幕優先順序選擇 UI |

---

## design_READ.md — 設計與開發協作反思

記錄「懸浮球元件」開發過程中的設計決策教訓：

### 五個學到的教訓

1. **先說清楚「動的是誰」** — 設計稿要標注哪個元素做什麼動作、誰跟誰同步
2. **規格數值要跟實作同步** — 改了 code 的動畫參數就要更新文件
3. **技術限制要提前問** — `pointer-events: none` 同時擋 click，需在設計定案前確認
4. **結構意圖要在設計稿說明** — 「球和 sidebar 要在同一容器」這類 DOM 關係必須在稿上說明
5. **動態行為先在 prototype 確認** — Live Demo 確認後才進 RD 實作

---

## 設計語言（共通）

所有原型使用一致的深色設計系統，與 [[styles]] 保持一致：
- 背景：深黑 `#0f0c29 → #302b63`（漸層）或 `rgba(10,10,20,0.85)`（毛玻璃）
- 強調色：藍紫色系
- 字體：Inter / system-ui

---

## 使用方式

```bash
# 直接雙擊 HTML 在瀏覽器開啟
# 或 VS Code Live Server 即時預覽
open DESIGN/design-ball.html
```

---

## 反向依賴

- 無（純視覺工具）
- [[editor-preview]] — 類似概念的編輯器靜態預覽

---

## 相關

- [[styles]]
- [[content]]
- [[editor-preview]]
- [[editor]]
- [[專案索引]]
