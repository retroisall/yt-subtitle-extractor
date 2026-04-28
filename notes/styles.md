# styles.css

## 基本資訊

| 項目 | 值 |
|------|-----|
| 檔案 | `styles.css` |
| 行數 | 2,833 行 |
| 執行環境 | Content Script CSS（注入到 YouTube 頁面） |

## 功能說明

整個擴充套件注入到 YouTube 頁面的主要樣式表，涵蓋側邊欄、Overlay 字幕、生字本彈窗、LED 點陣動畫、全螢幕模式、設定面板等所有 [[content]] 建立的 UI 元件。

---

## 依賴關係

### 上游（styles.css 依賴）

- 無外部 CSS 依賴（純 CSS，無 `@import`）
- 由 [[manifest]] 宣告為 content script css

### 下游（依賴 styles.css 的模組）

- [[content]] — 所有 UI 元件的視覺呈現
- [[manifest]] — 宣告此 CSS 隨 content.js 注入

---

## 主要樣式區塊

### 1. 側邊欄（Sidebar）

```css
#yt-subtitle-sidebar {
  position: fixed;
  right: 0;
  top: 0;
  width: 380px;
  height: 100vh;
  background: rgba(15, 15, 20, 0.95);
  backdrop-filter: blur(20px);
  z-index: 9999;
  overflow-y: auto;
  /* 滑入動畫 */
  transform: translateX(100%);
  transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
}

#yt-subtitle-sidebar.active {
  transform: translateX(0);
}
```

### 2. Overlay 字幕

```css
#yt-subtitle-overlay {
  position: absolute;          /* 疊加在 YouTube 播放器上 */
  bottom: 80px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1000;
  pointer-events: none;        /* 不阻擋播放器控制 */
}

.overlay-primary { font-size: 1.4em; color: #fff; }
.overlay-secondary { font-size: 1.1em; color: #ffd700; }
```

### 3. 生字本彈窗（Wordbook Popup）

```css
.yt-wordbook-popup {
  position: fixed;
  background: rgba(20, 20, 30, 0.98);
  border: 1px solid rgba(100, 100, 255, 0.3);
  border-radius: 12px;
  padding: 16px;
  z-index: 99999;              /* 最高層級 */
  min-width: 280px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.6);
}
```

### 4. LED 點陣動畫

```css
.led-matrix {
  display: grid;
  grid-template-columns: repeat(8, 6px);
  gap: 2px;
}

.led-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.1);
  transition: background 0.1s, box-shadow 0.1s;
}

.led-dot.active {
  background: #00ff88;
  box-shadow: 0 0 6px #00ff88;
}
```

### 5. 全螢幕模式

```css
/* YouTube 全螢幕時的特殊處理 */
:fullscreen #yt-subtitle-overlay,
:-webkit-full-screen #yt-subtitle-overlay {
  position: fixed;
  bottom: 100px;
  z-index: 2147483647;         /* 最大 z-index */
}

:fullscreen #yt-subtitle-sidebar {
  z-index: 2147483646;
}
```

### 6. 句子列表

```css
.subtitle-sentence {
  padding: 10px 14px;
  margin: 4px 0;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.15s;
  border-left: 3px solid transparent;
}

.subtitle-sentence.active {
  background: rgba(100, 100, 255, 0.2);
  border-left-color: #6464ff;
}

.subtitle-sentence:hover {
  background: rgba(255, 255, 255, 0.05);
}
```

---

## 設計語言

| 特性 | 說明 |
|------|------|
| **主色調** | 深色背景 `rgba(15,15,20)` + 藍紫色強調 `#6464ff` |
| **玻璃態** | `backdrop-filter: blur(20px)` 毛玻璃效果 |
| **動畫** | `cubic-bezier(0.4, 0, 0.2, 1)` Material Design 緩動 |
| **字體** | 系統字體堆疊，繁體中文優先 |
| **z-index 管理** | sidebar 9999, popup 99999, fullscreen 2147483647 |

---

## 踩坑記錄

- **z-index 遮擋**：YouTube 自身元件（廣告遮罩、popup）的 z-index 會衝突，需動態調整
- **全螢幕定位**：`:fullscreen` pseudo-class 在不同瀏覽器行為不一致，需 `-webkit-` 前綴
- **pointer-events**：Overlay 必須設 `pointer-events: none`，否則遮擋播放器點擊

---

## 反向依賴

- [[manifest]] — 宣告隨 content.js 注入
- [[content]] — 所有 DOM 元件依賴此樣式

---

## 相關

- [[content]]
- [[editor]]（editor.css 為獨立檔案）
- [[vocab-dashboard]]（vocab-dashboard.css 為獨立檔案）
- [[專案索引]]
