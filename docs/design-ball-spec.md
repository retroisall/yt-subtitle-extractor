# 懸浮球元件 — 設計規格討論記錄

## 最終規格（已確認）

### 球體
- 尺寸：36 × 36 px
- 形狀：圓形（border-radius: 50%）
- 背景：#18181b
- 邊框：1.5px solid #7c3aed
- 光暈 idle：rgba(124,58,237,.25) blur 12px
- 光暈 hover：rgba(124,58,237,.55) blur 22px

### 位置
- 容器：`#yt-sub-wrapper`（position: fixed, right: 0, top: 60px, width: 360px）
- 收合態：right: -18px, top: 8px（半隱於 wrapper 右側邊緣，對齊 header 垂直置中）
- 展開態：right: 14px, top: 8px（移入 sidebar header 右側）
- Hover 展開：right: 0

### 動畫
- 球移動：right transition, 0.38s cubic-bezier(0.4, 0, 0.2, 1)
- Sidebar 展開：clip-path inset(0 0 0 100%) → inset(0 0 0 0%)，相同 0.38s easing
- 展開方向：從右往左橫向生長
- Hover 期間動畫鎖定：mouseenter 以 JS flag 控制，不用 pointer-events（避免擋住 click）

### 狀態燈（左上角）
- 有字幕收合：#4ade80 綠點
- 無字幕：#ef4444 紅點
- 展開中：隱藏
- 動畫：pulse 1s ease-out × 3 次，結束後靜態光暈

---

## 來回討論過程

（每個節點格式：**問題/提案** → **決策**）

1. **初始需求：無字幕時介面收起，變成球狀取代 ▼ 三角形**
   → 確認以懸浮球替代原有收合按鈕，無字幕時自動切換為球態。

2. **第一版設計：完整球體，hover 放大，點擊展開側邊欄**
   → 接受作為基礎方向，但 hover 放大效果視覺干擾大，進入下一輪修改。

3. **修改：收起時只顯示半球，hover 才整顆球出來**
   → 採用半隱設計，球體以 right: -18px 半露於 wrapper 右側邊緣，hover 時滑入完整球體（right: 0）。

4. **修改：展開動畫改為「球體位置橫向展開介面」，不動球體樣式**
   → 球體本身不縮放，改以 clip-path 對 sidebar 做橫向生長動畫；球與 sidebar 分離為 sibling，各自獨立運動。

5. **問題：球的運動速度和介面滑動速度不一致**
   → 統一 transition duration 為 0.38s，easing 統一使用 cubic-bezier(0.4, 0, 0.2, 1)。

6. **問題：動畫期間 hover 會干擾球的路徑**
   → 捨棄 pointer-events 方案（同時擋住 click 事件）；改用 JS mouseenter flag 鎖定動畫期間忽略 hover 觸發，動畫結束後解鎖。

7. **狀態燈位置：從右上角改到左上角**
   → 收合態下右上角被 wrapper 邊緣遮蔽，左上角在半球狀態時仍可見，確認移至左上角。

8. **新增綠點：有字幕收合時亮綠點**
   → 原規格只有紅點（無字幕）；新增有字幕且收合狀態顯示 #4ade80 綠點，與紅點形成直覺對比。

9. **動畫時間：脈衝動畫只跑 3 次，後續靜態光暈**
   → 無限 pulse 過於吵鬧；改為 pulse 1s ease-out 跑 3 次後停止，殘留靜態 box-shadow 光暈。

10. **PM 審查發現：靜態展示狀態二紅點缺 class、狀態三應顯示綠點、規格卡數值過期**
    → 美術全部修正：補上缺失 class、修正狀態三顯示邏輯、更新規格卡數值至最終確認版。

11. **RD 實作問題：球獨立丟到 document.body，與設計圖不符**
    → 原實作把球附加到 body，導致定位基準錯誤；改用 `#yt-sub-wrapper` 同時包住 sidebar 與 ball，clip-path 僅裁切 sidebar，ball 作為 sibling 不受 clip-path 影響。

---

## 架構說明

```
#yt-sub-wrapper（position: fixed, 360px）
├── #yt-sub-demo-sidebar（position: absolute, clip-path 動畫）
└── #yt-sub-ball（position: absolute, 伸出 wrapper 右側 18px）
```

sidebar 的 clip-path 不影響 ball（sibling 元素互不裁切）。wrapper pointer-events: none，sidebar/ball 各自設 auto，收合時 sidebar pointer-events: none 避免擋住視窗事件。
