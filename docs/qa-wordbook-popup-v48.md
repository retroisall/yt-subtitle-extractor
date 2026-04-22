# QA 測試報告：qa-wordbook-popup-v48

測試時間：2026/4/22 下午12:07:40
測試檔案：content.js / styles.css

---

## ✅ PASS — 1. 生字本預設排序 — #yt-sub-wordbook-sort 第一個 option 為 date-desc 且有 selected

第一個 option value="date-desc" 且有 selected 屬性 ✓

## ✅ PASS — 2a. 搜尋框 — content.js 有 id="yt-sub-wb-search" 的 input

找到 id="yt-sub-wb-search" input 元素 ✓

## ✅ PASS — 2b. 搜尋框 — renderWordbook 讀取搜尋值並使用 .includes() 過濾

renderWordbook 讀取搜尋框值並呼叫 .includes() 過濾 ✓

## ✅ PASS — 2c. 搜尋框 — styles.css 定義 .yt-sub-wb-search 樣式

找到 .yt-sub-wb-search 樣式定義 ✓

## ✅ PASS — 3a. 彈窗尺寸 — #yt-sub-word-popup width = 420px

width = 420px ✓

## ✅ PASS — 3b. 彈窗尺寸 — #yt-sub-word-popup font-size = 15px

font-size = 15px ✓

## ✅ PASS — 3c. 彈窗尺寸 — .yt-sub-popup-word font-size = 22px

font-size = 22px ✓

## ✅ PASS — 3d. 彈窗尺寸 — .yt-sub-popup-save-btn font-size = 15px

font-size = 15px ✓

## ✅ PASS — 4a. 彈窗定位 — _positionPopupNearAnchor 使用 popup.style.bottom 設定上方位置

找到 popup.style.bottom = ... 定位邏輯 ✓

## ✅ PASS — 4b. 彈窗定位 — 上方模式設定 popup.style.top = 'auto'

找到 popup.style.top = 'auto' ✓

## ✅ PASS — 4c. 彈窗定位 — 有 MARGIN = 8 的 viewport 邊界保護

MARGIN = 8，並用於邊界保護 ✓

## ✅ PASS — 5. 搜尋計數 — 有搜尋結果時格式為「N / 總數 個單字」

找到「N / 總數 個單字」格式字串 ✓

---

## 整體結果：✅ 全部 PASS