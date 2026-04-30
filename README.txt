YouTube Learning Bar - YouTube 沉浸式語言學習工具
==================================================

Chrome Store 上架進度（2026-04-30 更新）
------------------------------------------

已完成：
  [x] manifest.json 更新（名稱 / 版本 5.3 / 描述 / icons / homepage_url）
  [x] icons/ 目錄建立（16px / 48px / 128px）
  [x] 打包腳本 package.sh（輸出 yt-subtitle-store.zip，148KB）
  [x] Admin email 移出公開包（改從 Firestore app_config/admin_config 讀取）
  [x] Store 截圖 5 張 1280x800（store-screenshots\ 目錄）
  [x] 隱私政策頁面上線
      URL：https://retroisall.github.io/youtube-learning-bar-privacy/
  [x] 隱私政策草稿：notes/privacy-policy-draft.md

已完成（2026-04-29 補齊）：
  [x] Firebase Console 建立文件：app_config/admin_config
      欄位：admin_emails: ["kuoway79@gmail.com"]
  [x] 部署 Firestore 規則：firebase deploy --only firestore:rules
  [x] 打包腳本改為自動帶版本號（yt-subtitle-store-v5.3.zip）
  [x] OAuth PKCE token exchange 補 client_secret（修正「client_secret is missing」）
  [x] 切換翻譯服務時字幕閃爍修正（skipPrimary flag）
  [x] 懸浮球初次載入位置錯誤修正（無字幕影片 syncWrapperToPlayer 重試）
  [x] vocab-dashboard QA 自動化（tests/qa_vocab_dashboard.mjs，T1-T10 全過）

已完成（2026-04-30 補齊）：
  [x] CLIENT_SECRET 移至 secret.config.js（gitignore，不進 git 歷史）
  [x] 舊 secret 從 git 歷史完整清除（git filter-repo）
  [x] 生字本「已學習」單字不再高亮顯示（buildTokenizedText + patchSavedWordHighlights）
  [x] 標記已學習後字幕高亮即時消失（toggleLearnedStatus 補呼叫 patchSavedWordHighlights）
  [x] QA 回歸測試：tests/qa_wordbook_learned_nohighlight.mjs（11/11 通過）

待辦：
  [ ] 上傳 yt-subtitle-store-v5.3.zip 到 Chrome Web Store
  [ ] Store 填寫：簡短說明 / 詳細說明 / 截圖 / 隱私政策 URL
  [ ] 等待 Google 審查（首次約 1-7 天）
  [ ] 圖示請美術重新設計（目前為暫時佔位符 LB 圖示）

上架用檔案位置：
  ZIP 包：yt-subtitle-store-v5.3.zip（156KB，可直接上傳）
  截圖：store-screenshots\（5 張 1280x800 PNG）
  隱私政策：https://retroisall.github.io/youtube-learning-bar-privacy/



安裝說明
--------
1. 開啟 Chrome 瀏覽器
2. 網址列輸入：chrome://extensions/
3. 右上角開啟「開發人員模式」
4. 點擊「載入未封裝項目」
5. 選擇這個資料夾
6. 開啟任意 YouTube 影片頁面
7. 右側會出現「字幕提取器」側邊欄

注意事項
--------
- 僅在 youtube.com/watch 頁面生效
- 需要影片本身有字幕（手動或自動生成皆可）
- 切換影片時會自動重新載入字幕清單


v5.0 更新紀錄（2026-04-24）
============================

【修正】

■ 社群字幕分享後 UI 計數未刷新
  - 分享成功後選單仍顯示舊數量（例如 0），需手動切頁才能更新
  - content.js 分享成功後呼叫 fetchCommunitySubtitles() 即時刷新計數
  - editor.js（獨立分頁）分享成功後透過 editor_relay 傳送 REFRESH_COMMUNITY
  - content.js 新增 REFRESH_COMMUNITY 訊息處理器，收到後刷新計數

■ Firebase Service Worker 重啟後分享/權限 handler 遺失 session
  - fb_shareSubtitle、fb_registerEditorPermission、fb_checkEditorPermission、
    fb_getEditorPermissions、fb_setEditorPermission 均使用同步 getCurrentUser()
  - MV3 SW 被瀏覽器終止重啟後，in-memory _userInfo 遺失 → 回傳「未登入」或
    Firestore 403（取決於 SW 重啟時序）
  - 全部補上 _sessionReady.then() 包裝，確保 session 恢復後才執行

【設計調整】

■ 生字本彈出視窗（Popup）縮小 20%
  - 容器寬度 420px → 360px，padding 16/20px → 12/16px
  - 英文單字 22px → 18px、中文譯 18px → 14px、音標 14px → 11px
  - 定義/例句 15px → 12px、按鈕 15px → 12px、例句跳轉 16px → 13px
  - Simplified 模式等比例縮減

■ 生字本展開卡片（Expanded Card）還原原始尺寸
  - 上個版本誤縮此視窗，現全數還原：單字 14px、中文 11px、時間 10px、例句 12px
  - 刪除按鈕 32px（較原始 44px 緊湊）、播放按鈕 28px

■ 按鈕圓角統一
  - card 內各按鈕（播放、刪除、已學會、備註輸入框）border-radius 6px → 8px
  - 與 popup 按鈕 8px 保持一致

---

v4.9 更新紀錄（2026-04-22）
============================

【新功能】

■ 字幕模式（Subtitle Mode）完整功能
  - 搜尋框：字頭前綴過濾，即時顯示命中句數
  - 單字點擊：整合 buildTokenizedText，可直接從字幕模式開啟字典 Popup
  - 循環按鈕（⇄）：點擊啟動該句循環，再點取消；切換句時 active 立即轉移（不等 300ms）
  - 時間戳點擊 / 句子背景點擊：跳轉影片到對應時間
  - 手動捲動不被 300ms interval 鎖定（只有句子切換時才自動捲動）

【修正】

■ 字幕模式右鍵存字失效
  - initWindowContextMenu 未涵蓋 #yt-sub-subtitle-mode
  - 補上 inSubtitle = e.target.closest('#yt-sub-subtitle-mode') 判斷

■ 退出字幕模式 timeupdate listener 未移除
  - enterSubtitleMode 加 timeupdate 到 video 後未在 exitSubtitleMode 清除
  - 新增 _ysmTimeUpdateHandler 模組層級變數，退出時正確 removeEventListener

■ 字幕模式切換循環句 active 不即時更新
  - updateCurrentLoopStyle 的 _lastLoopingState 短路導致 updateWbLoopBtn 不執行
  - 改為先呼叫 updateWbLoopBtn，再做短路；updateWbLoopBtn 補上 .ysm-loop-btn 更新邏輯

■ 本地字幕被 YouTube 字幕覆蓋（production bug）
  - YouTube 字幕 message handler 無 customSubtitleActive 保護，直接覆蓋 primarySubtitles
  - _restoreSavedSubtitle 還原後未設 customSubtitleActive = true，YouTube 字幕後至仍能蓋掉
  - 翻譯函數（translateAndSetSecondary / translatePrimarySubtitles）完成時無條件更新 status
  - _showTranslationGate（未登入提示）無條件覆蓋 status
  - renderLanguages「找到 N 個字幕語言」無條件覆蓋 status
  - 全部補上 !customSubtitleActive 保護，確保本地/社群字幕啟用時狀態不被蓋掉

■ 循環播放 duration 為 0 時立即觸發
  - 補上 Math.max(loopSub.duration || 0, 1) 保護，最少 1 秒才允許 loop 回頭

---

v4.8 更新紀錄（2026-04-22）
============================

【新功能】

■ 過濾狀聲詞
  - 設定中新增「過濾狀聲詞 [Music] 等方括號標示」開關（預設關閉）
  - 開啟後自動移除字幕中所有 [xxx] 格式的標記（例如 [Music]、[Applause]）
  - 同時套用於主字幕列表、Overlay 顯示與翻譯字幕

■ A / D 鍵盤快捷鍵導覽
  - A 鍵：跳到上一句（等同點擊 ‹ 按鈕）
  - D 鍵：跳到下一句（等同點擊 › 按鈕）
  - 設定中新增「A/D 快捷鍵控制上一句/下一句」開關（預設開啟）
  - 游標在輸入框時自動停用，不影響正常打字

【修正】

■ 播放中點擊「上一句」無法正確回退
  - 修正播放狀態下 video.currentTime 持續往前移動導致計算基準偏移的問題
  - 改為：點擊時先暫停 → 以當下時間計算目標句 → seek → 恢復播放
  - 快速連點時以第一次點擊後的 index 為基準，800ms 鎖定期內不受播放時間干擾

■ 本地 / 社群字幕時語言下拉選單為空
  - 使用本地字幕或社群字幕時，語言下拉改為顯示「✏ 本地字幕」或「👥 社群字幕」
  - 不再顯示空白選單

■ XSS 安全性修正
  - `_renderSubtitleModeList` 改用 DOM API 建構節點，移除 innerHTML 拼接避免注入風險

---

v4.7 更新紀錄（2026-04-21）
============================

【新功能】

■ 生字本單字高亮（字幕中）
  - 已存入生字本的單字，在字幕列表與 Overlay 中自動以系統設定顏色標記
  - 使用 CSS 變數 --secondary-color / --ov-secondary-color，與使用者顏色主題一致
  - 新增/刪除單字時即時更新所有現存 DOM span，無需等待下一句刷新

■ 三層權限系統
  - guest（未登入）：僅可使用雙語原生字幕
  - user（已登入 Google）：追加單字幕 + Google 翻譯功能
  - editor（管理員授予）：開放全功能，包含社群字幕上傳 / 載入
  - 未達權限時顯示升級提示，引導登入或聯繫管理員

■ 後台權限管理分頁
  - vocab-dashboard 新增「權限管理」分頁
  - 三層等級說明（guest / user / editor）
  - 統計列：總人數、user 數、editor 數
  - 支援篩選、「授予 Editor」/ 「撤銷 Editor」快速操作（附確認彈窗）

■ 字幕編輯器（YEM）副字幕同步修正
  - 新增字幕列時副字幕正確插入空行，不再錯位帶入下一句內容
  - 刪除字幕列時同步刪除對應副字幕
  - 合併字幕列時同步合併副字幕文字

【修正】

■ 語言自動切換 bug 修正
  - 影片無偏好語言（anyMatched=false）時，下拉選單切換不再污染全域 settings.primaryLang
  - 臨時切換只影響當前影片，不被後續 saveSettings() 持久化
  - 明確使用者操作（套用按鈕）才更新並立即持久化設定

■ 原生字幕被 customSubtitleActive 封鎖
  - 主動切換語言下拉 / 點套用按鈕時自動清除 customSubtitleActive flag
  - 確保原生字幕正常載入

■ 音樂 MV 副字幕偶發缺失
  - 新增 findSecondaryForPrimary：startTime+0.1 查找失敗時，改用 2 秒容差最近句 fallback
  - fillMissingSecondary 新增條目 duration 最低 1 秒，避免後續 midpoint 查找失效

【UI 調整】

- 字幕查詢 popup 放大至 2 倍（640px）、字型放大 1.5 倍、畫面置中
- popup 底部加入「＋ 加入生字本」大型按鈕，已存入自動顯示「✓ 已在生字本」
- 下拉選單箭頭改為自訂 SVG，間距統一（移除瀏覽器預設 appearance）
- Overlay ‹ › 導覽按鈕改為 SVG chevron，水平完全置中
- Overlay 導覽按鈕垂直置中對齊字幕 body（align-self: center）
- 同步 loop DOM 寫入加防護：只有內容真正改變才觸發，scrollIntoView 僅在 index 切換時呼叫一次

---

v4.6 更新紀錄（2026-04-19）
============================

【新功能】

■ 後台管理儀表板（vocab-dashboard.html）
  - 新分頁開啟完整後台，含 8 個分頁：概覽、LINE 紀錄、單字庫、關鍵字、排程、記憶、遊戲、設定
  - 概覽：統計卡片（總單字數、關鍵字數、記憶條數、遊戲場次）、最近單字與 LINE 訊息速覽
  - LINE 紀錄：顯示所有群組訊息紀錄（透過 Firebase Firestore 即時讀取）
  - 單字庫：列出雲端單字，支援 CEFR 等級標示、排序、搜尋、刪除、推播至 LINE
  - 關鍵字：新增 / 刪除關鍵字，雙寫至 Firebase 與 Google Sheets（via GAS API）
  - 記憶：新增 / 刪除觸發詞-回覆組合，雙寫至 Firebase 與 Google Sheets
  - 遊戲：分數排行榜與題庫管理（子頁籤）
  - 設定：GAS Webhook URL、LINE User ID、Firebase Security Rules 快速複製

■ Firebase 整合
  - 後台直接透過 Firestore REST API 讀取 Firebase 資料（不需 SDK）
  - 認證流程：background.js 管理 ID Token，儀表板透過 `fb_getIdToken` 訊息取得 token
  - 支援 LINE Flex Message 推播：從單字庫選字後一鍵推送至 LINE

■ 雙寫同步架構
  - 儀表板的關鍵字、記憶 CRUD 操作同時寫入 Firebase 與 Google Sheets
  - GAS API（`add_keyword`、`add_memory`、`delete_by_key`）負責 Sheets 端同步
  - LINE bot 仍讀取 Google Sheets，確保功能不中斷

【修正】

- firebase.js 補出 `getIdToken()` export，供 background.js 轉發給儀表板
- background.js 新增 `fb_getIdToken` 與 `dashboard_open` 訊息處理
- manifest.json 補加 `vocab-dashboard.html/js/css` 至 `web_accessible_resources`

---

v4.5 更新紀錄（2026-04-15）
============================

【修正】

- 主字幕語言偏好在影片無對應字幕時，不再強制走 tlang 翻譯或 Google Translate
- 改為：若該影片有同語系 ASR（自動產生）字幕，以 ASR 作為主字幕直接載入
- 若無同語系字幕（連 ASR 也沒有），顯示「此影片無 [lang] 字幕」並停止，不翻譯

---

v4.4 更新紀錄（2026-04-15）
============================

【新功能】

■ 自定義字幕編輯器（editor.html）
  - 側邊欄新增「✏ 自定義字幕」按鈕，點擊後在新分頁開啟字幕編輯器
  - 自動帶入當前影片的主字幕與副字幕（含時間軸）
  - 支援逐句編輯主字幕與副字幕文字，× 按鈕可清空內容
  - Tab 鍵在副字幕輸入後跳至下一行主字幕；Shift+Tab 反向跳上一行副字幕
  - 匯出 .srt 格式，包含 [CUSTOM_SUBTITLE] metadata block，雙字幕以 | 分隔

■ 編輯器同步播放與循環此句
  - Toolbar 提供兩個全域 toggle：▶ 同步播放、⇄ 循環此句
  - Focus 某一行 → 同步播放模式：跳到該句時間點播放一次後自動暫停
  - Focus 某一行 → 循環模式：持續重播該句，失去 focus 自動停止
  - YT 分頁存活狀態即時偵測（綠點 / 灰點）

■ 字幕本地儲存與還原
  - 編輯器「💾 儲存本地」按鈕：儲存所有編輯內容到 chrome.storage.local
  - 儲存時同步將編輯後字幕套用至 YT 分頁（即時生效）
  - 下次開啟同一影片的編輯器，偵測到本地存檔時顯示還原橫幅提示

■ 社群字幕分享與載入
  - 編輯器「分享至社群」：將字幕上傳至 Firebase Firestore（需登入）
  - 側邊欄「👥 社群字幕」按鈕：顯示社群貢獻筆數，點擊可選擇套用
  - 未登入使用者也能瀏覽與套用社群字幕（公開讀取）
  - 選擇社群字幕後，下次開啟同影片自動套用（記錄於本地）

■ 自定義/社群字幕來源標示
  - 使用中的字幕來源按鈕顯示紫色底色
  - 使用自定義或社群字幕時，不再從 YT 重新取得字幕（避免覆蓋）
  - 換影片或手動重新載入時自動解除封鎖

【修正】

- manifest.json 補加 tabs permission（chrome.tabs.get / chrome.tabs.create 需要）
- editor.js focusPrevRow CSS selector 末尾多餘反引號導致 Shift+Tab 失效
- 社群字幕狀態文字在切回 YT 字幕時未正確更新
- loadSubtitle 在自定義字幕生效後仍覆蓋狀態文字

---

v4.3 更新紀錄（2026-04-15）
============================

【新功能】

■ Google 帳號登入 + Firebase 雲端同步
  - 點擊 header 右側帳號按鈕觸發 Google OAuth（launchWebAuthFlow）
  - 登入後帳號按鈕變紫色 G，顯示雲端同步按鈕（⟳）
  - 點 ⟳ 執行雙向同步：以 addedAt/deletedAt 時間戳決定勝出方
  - 刪除單字改為軟刪除（加 deletedAt 欄位），雲端同步後對方裝置也會刪除
  - 登入狀態跨頁保留（restoreSession 從 chrome.storage.local 恢復 refresh token）

■ Header UI 全面重設計
  - 標題改為「學習Bar」膠囊 Tag 風格（Style B：紫底白字 + 灰底深字）
  - 移除舊左側圖示，改為 CSS 文字 LOGO
  - 右側按鈕間距拉開，區域往左調整避開懸浮球

■ 5×3 點陣 LED 狀態指示器
  - Header 右側新增 Canvas 點陣動畫，對應各播放狀態：
    idle（靜止灰點）、loading（流水燈紫色）、has-sub（播放三角綠色呼吸）
    no-sub（叉形紅色閃爍）、paused（雙豎線黃色呼吸）、syncing（旋轉紫色）、signing-in（G 字淡入淡出）
  - 展開 sidebar 時自動隱藏 ball dot（避免重複呈現）

■ 彈窗載入速度優化
  - 字典查詢不再等 Datamuse 詞頻 API，立即顯示定義
  - 詞頻等級異步補填，不阻擋 popup 顯示

【修正】

- 帳號 dropdown 與右側懸浮球重疊（right 從 10px 改為 52px）
- 首次載入 LED 狀態錯誤（expandSidebar 未設 LED 狀態，現在先 loading 再 has-sub）
- 初始化時 service worker 尚未恢復 session 導致帳號按鈕顯示為未登入（加 1.5s 延遲重試）
- 帳號按鈕點擊時 email 欄空白（click handler 補呼叫 updateAccountUI）
- 翻譯/詞頻更新後句子區塊消失（改用 popup._sentenceData 重新 append）
- 同步完成後 LED 未恢復字幕狀態（現在 syncing 結束後回到 has-sub/idle）

---

v4.2 更新紀錄（2026-04-14）
============================

【新功能】

■ 主字幕 Google 翻譯路徑
  - 影片無偏好語言原生字幕時，改用 Google Translate 翻譯（不再依賴 &tlang=）
  - 避免 YouTube timedtext API 限流（HTTP 429）
  - 翻譯服務設為「Google」時自動啟用，逐批翻譯並即時更新字幕列表

■ Sidebar 高度動態對齊影片
  - Sidebar 高度自動等於影片播放器高度，不再全頁覆蓋
  - 影片下方的標題、說明、留言不再被 sidebar 遮住
  - 劇院模式自動調整高度

■ 語言設定精簡
  - 語言偏好選項精簡為 5 種：英文、日文、韓文、簡體中文、繁體中文
  - 副字幕從 1/2/3 優先序簡化為單一選單
  - 副字幕切換只影響當前影片，不覆蓋全域偏好
  - 設定頁「語言偏好」顯示目前偏好語言（唯讀）

■ Debug Relay 工具（開發用）
  - relay-server.js：WebSocket server，可即時接收套件 console log
  - 預設關閉，需要時取消 content.js / inject.js 內的註解並執行 node relay-server.js

■ 字幕列表互動優化
  - Hover 字幕列表時凍結高亮捲動，方便右鍵儲存單字或點擊查字典
  - Active 字幕固定在列表中央（可看到上下文）

【修正】

- 展開 sidebar 時隱藏右側推薦欄，避免在 1280/1440px 下被部分遮蓋
- Onboarding 改為 overlay 疊加，不再清空 body DOM（修正 initSidebar crash）
- 移除已廢除的 ⏻ 按鈕殘留引用（修正載入後字幕完全不顯示）
- 翻譯批次遞迴爆 call stack（scheduleNextTranslationBatch 改用 setTimeout(0)）
- 合輯播放模式下「當前影片生字」為空（saveWord 傳遞正確 videoId）
- lemmatize 還原錯誤時查字典 / 儲存單字改用原始詞 fallback
- stale allTracks 造成 404（Innertube UNPLAYABLE 後清空舊 tracks）
- 主副字幕 Google 翻譯 job 競爭（primaryTranslationJob 獨立化）

---

v4.1 更新紀錄（2026-04-13）
============================

【新功能】

■ 初次設定引導（Onboarding）
  - 第一次開啟套件時，sidebar 內顯示兩步驟語言選擇
  - Step 1：選擇你在學的語言（主字幕）
  - Step 2：選擇你的母語（副字幕參考翻譯）
  - 設定完成後自動套用，設定頁可隨時「重新設定」

■ 主字幕語言偏好（全域固定）
  - 主字幕語言改為全域偏好，不隨影片切換而改變
  - 影片沒有偏好語言的原生字幕時，自動用 &tlang= 翻譯成偏好語言

■ YouTube 版面縮排模式
  - 字幕載入時自動對 #columns 加 padding-left，讓標題與內容不被 sidebar 遮住
  - 離開影片頁時自動還原版面

■ 簡繁轉換
  - 副字幕選繁體中文時，若收到簡體字幕自動轉換為繁體
  - 使用 Google Translate sl=zh-CN tl=zh-TW 進行轉換

【修正】

- 副字幕載入成功但 NOW PLAYING 和 Overlay 不同步
  （extendSubtitles 拉長 duration 導致 midpoint 超出範圍，改用 startTime+0.1 查找）
- 切換回 YouTube 首頁時側邊欄自動收合，亮灰燈（不需字幕）
- 重整按鈕（↺）與循環按鈕（⇄）改用不同字元，視覺更易區分
- 移除 ⏻ 關閉按鈕（與懸浮球收合功能重疊）

---

v4.0 更新紀錄（2026-04-13）
============================

【新功能】

■ 懸浮球收合介面
  - 無字幕影片自動收合為右側半球，有字幕自動展開
  - 狀態燈：綠點（有字幕收合）/ 紅點（無字幕），3 秒脈衝後轉靜態光暈
  - 點擊球體 → sidebar 從右側橫向展開；再點 → 收合

■ UI 全面重構（Obsidian Card 風格）
  - 三頁籤架構：字幕 / 生字本 / 設定，頁籤切換淡入淡出
  - 深色卡片風格（#09090b 底、#7c3aed 紫色 accent）
  - 狀態列移至字幕頁底部，低調細線風格

■ 字幕時間偏移
  - 設定 > 行為 新增滑桿，範圍 ±30 秒，步進 0.5 秒
  - 正數延後字幕、負數提前字幕，解決字幕與影片不同步問題

■ Google 翻譯批次模式
  - 設定 > 翻譯服務 可切換「固定 8 句」或「約 100 字」分組
  - 多句合併為一次 HTTP 請求，大幅減少 API 呼叫次數

■ 生字本 ▶ 播放按鈕
  - 當前影片生字每筆顯示 ▶ 按鈕，點擊直接跳轉至例句時間點
  - 循環開啟時 ▶ 自動將循環轉移至該句

【修正】

- 主字幕設定跨影片污染（換影片後偏好語言被覆寫）
- 重複歌詞 / 台詞第二次出現沒有翻譯（ytlang 跳過重複行）
- 生字本點擊字典與例句整合為同一 popup（移除獨立 ≡ 按鈕）
- 頁籤切換改為 opacity 動畫，解決 display 切換閃爍問題

---

v3.0 更新紀錄（2026-04-12）
============================

【新功能】

■ 個人生字本
  - 右鍵字幕單字即可儲存到本地生字本（chrome.storage.local）
  - 儲存時自動記錄：通用中文翻譯、例句（含中文翻譯）、影片 ID、時間軸、查詢次數
  - 單字自動還原原型（Lemmatization）：shining → shine、running → run、walked → walk
  - 字典查無的單字（如 burnin）不顯示查詢按鈕，其他功能保留

■ 生字本面板（Header ★ 按鈕）
  - 篩選模式：當前影片（預設）、最近加入、查詢最多、字母順序
  - 每筆單字顯示：通用中文、詞頻等級（基礎 / 常用 / 進階）、查詢次數
  - 點擊單字名稱可彈出字典 popup
  - ≡ 按鈕顯示例句浮窗（英文原句 + 中文翻譯）
  - 例句浮窗右下角有時間軸跳轉按鈕：同影片直接 seek，不同影片開新分頁
  - SPA 換頁後「當前影片」篩選自動更新

■ 詞頻等級（Datamuse API）
  - 查字典同時呼叫 Datamuse API 取得詞頻
  - 基礎（every million > 100）/ 常用（10-100）/ 進階（< 10）
  - 同時顯示在字典 popup 和生字本列表

■ 字典 popup 中文翻譯強化
  - 新增單字本身的通用中文（miracle → 奇蹟）顯示在最上方
  - 定義中文翻譯保留，顯示在英文定義下方

■ 延長字幕顯示
  - 設定面板可開關（預設開啟）
  - 字幕結束到下一句開始前的空白間隔，自動延伸前一句的顯示時間
  - 例：A 字幕 1-5s，B 字幕 10-15s → A 自動延伸到 9.95s
  - 不修改原始字幕資料，切換開關即時生效

■ 套件整體開關（Header ⏻ 按鈕）
  - 停用時隱藏字幕 body，保留 Header 供隨時重新開啟
  - 停用時自動停止 sync loop、取消翻譯任務、移除 Overlay
  - 設定存入 localStorage，重整頁面維持狀態

【修正】

- 選英文字幕但顯示中文（&tlang 翻譯靜默失敗，錯誤內容被快取為英文）
- 字幕找到但不載入（偏好語言在此影片中不存在，改為自動 fallback 第一條可用 track）
- 生字本「當前影片」換頁後不更新（SPA 換頁時補呼叫 renderWordbook）

【待研究 / 下一步】

  ○ 翻譯流程優化（路徑 B：外部 Google 翻譯）
    - 目前逐句串行呼叫 API，長片耗時 O(n)
    - 方向 1：多句合併成一個 API 請求（Google API 支援長 q= 參數）
    - 方向 2：翻譯結果持久化到 sessionStorage，重整頁面不重翻
    - 方向 3：批間改為動態等待，取消固定 400ms delay
    - 詳細流程已記錄在 TECHNICAL.md「字幕翻譯流程」章節

---

v2.0 更新紀錄（2026-04-10）
============================

【新功能】

■ 影片浮動字幕 Overlay
  - 字幕顯示在影片畫面上，不與側邊欄重疊
  - 包含主字幕（可點擊單字）與副字幕
  - 左右各有 < > 按鈕跳上一句 / 下一句
  - 點擊背版區域啟動單句循環，再點取消

■ 單句循環
  - 設定面板可開關（預設開啟）
  - 觸發方式：點擊 Overlay 背版 / 側邊欄當前字幕區 / 右側字幕列表的文字區
  - 取消方式：再次點擊同一區域 / 按鍵盤 → / 點擊 < >
  - 句子間空隙也能正確 loop 回去（修正多句同時循環的問題）

■ 單字查字典
  - 主字幕每個英文單字可點擊（包含 Overlay 和側邊欄）
  - 彈窗顯示：發音（IPA）、詞性、英文定義、中文翻譯、例句、近似詞（含中文）
  - 中文翻譯非同步載入，先顯示英文再填入
  - 點擊單字同時朗讀（可在設定關閉）
  - 單字 Hover 高亮（可在設定關閉）

■ 副字幕優先序
  - 支援 3 個副字幕優先序（副字幕 1/2/3）
  - 各優先序可選「原生優先」或「自動翻譯」（強制走 &tlang=）
  - 有原生 track 用原生，否則自動 fallback 翻譯

■ 外部翻譯（Google）
  - 設定可切換翻譯服務：YouTube 內建 / Google（免費）
  - 每次翻譯 30 分鐘內的字幕，快到邊界自動翻下一批
  - 翻譯逐批進行，狀態列顯示進度
  - 跳轉到未翻譯區域時自動重新觸發翻譯

■ 字幕快取
  - 字幕原文存入 sessionStorage（最多 20 條），重刷不重複請求 YouTube
  - 翻譯結果存入記憶體（最多 10 部影片）
  - 字典查詢結果快取（最多 200 筆）

■ 無字幕影片
  - 影片沒有字幕時不顯示 Overlay，不隱藏 YouTube 原生字幕

【修正】

- 語言切換後 YouTube 播放器字幕不跟著切換
- ASR（自動產生）字幕不出現在下拉選單
- 切換主字幕語言時副字幕消失
- 翻譯字幕 URL 帶重複 &fmt= 參數導致空回應（len=0）
- 翻譯目標語言等待播放器 4 秒 timeout 浪費時間
- baseUrl 過期（2020 年舊快取）導致 404
- Google 翻譯 URL 過長被截斷導致翻譯失敗
- 翻譯時字幕列表抖動（現改為逐條 patch DOM，不重建）
- 多句同時循環無法取消
- 單字彈窗位置超出 sidebar / 螢幕邊緣
- 兩個 MutationObserver 合併為一，減少 DOM 監聽開銷
- 100ms sync loop 中 querySelectorAll 改為 children 存取，減少開銷
- loop style 更新加 guard，避免每 tick 觸發無謂的 classList 操作


---

v2.1 更新紀錄（2026-04-20）
============================

【新功能】

■ 字幕編輯器改版
  - 自動暫停 + 時間平移移至右側面板頂部（移除左下角循環播放 checkbox）
  - 離開某列後自動依 startTime 排序所有字幕
  - 秒數欄位驗證：startTime 不可超出前一句 endTime、endTime 不可超出後一句 startTime
  - ⌚ 抓取按鈕改為：startTime 抓前一句的 endTime，endTime 抓下一句的 startTime
  - 句子間新增 ＋ 合併按鈕：點擊後兩句合為一句（文字換行合併、時間區間取聯集）
  - textarea 高度依內容自動增高（不固定單行）

■ 自定義字幕持久化（本地 + 社群）
  - 儲存本地格式改為 `{ primarySubtitles, secondarySubtitles }`，與社群上傳格式一致
  - SRT 匯入後自動儲存至 chrome.storage.local（含副字幕）
  - 重整頁面後自動還原自定義字幕或社群字幕（修正過去需重新匯入的問題）
  - 讀取時兼容舊格式（純陣列）

■ 社群字幕功能修正
  - 社群字幕上傳現正確包含副字幕（過去 hardcode 空陣列）
  - 社群字幕選項不再恆為 disabled
  - 載入無副字幕的社群字幕時自動觸發翻譯（若雙語模式開啟）

【修正】

- 離開編輯模式後字幕 sync 停止（timeupdate 事件監聽器未清除）
- _loopActive 未重置導致播放器持續被暫停
- fetchCommunitySubtitles() 因 customSubtitleActive flag 而被略過
- _restoreSavedSubtitle 僅在有 YT 字幕時才呼叫（無字幕影片無法還原）

---

v5.1 更新紀錄（2026-04-25）
============================

【效能優化】

■ YEM 字幕編輯器虛擬捲動（Virtual Scroll）
  - 修正：7000+ 句字幕開啟編輯器直接崩潰
  - 超過 150 句時啟用虛擬捲動，只渲染可見範圍 ± 25 句緩衝
  - 上下各用 spacer div 撐開高度，維持正確捲軸比例
  - 播放自動跟隨改用 scrollTop 直接賦值（取代 scrollIntoView），避免 smooth scroll 期間連續觸發重建
  - 1000 句以內體感無差異；7000+ 句從崩潰變為流暢

【修正】

■ YEM 翻譯字幕在未導航前不載入
  - 新增 _translationWindowEnd 保護：翻譯 job 仍在跑且當前時間在其窗口內，seeked 事件不取消 job
  - 修正快速點擊導覽按鈕時 seeked 事件反覆取消進行中的翻譯

【新功能】

■ Overlay Hover-Pause（字幕暫停閱讀）
  - 滑鼠移入影片字幕 overlay（#yt-sub-ov-body）時進入 hover 狀態
  - 字幕切換瞬間自動暫停影片，讓使用者有時間點擊當前字幕內容
  - 暫停時主副字幕均凍結顯示原句（不跟隨影片位置更新），無閃爍
  - 移開滑鼠後自動繼續播放
  - 使用者手動按播放（Space / 點擊播放鍵）時，自動解除 hover-pause 鎖
  - 換影片時重置所有 hover-pause 狀態，避免殘留誤觸發

v5.2 更新紀錄（2026-04-25）
============================

【修正】

■ 單句循環（loopSentence）三項 Bug 修正

  1. rewind 誤觸 auto-pause / hover-pause
     - 症狀：循環播放時每次 rewind 後，若開啟「每句自動暫停」或滑鼠停留在 overlay，
       影片都會多暫停一次，導致循環無法流暢連續
     - 原因：rewind 發生後，下一 tick 的 sentenceChanged 誤判為「真的換句」並觸發暫停
     - 修正：加入 _loopJustRewound 旗標，rewind 執行後的下一 tick 跳過 sentenceChanged

  2. extendSubtitles 讓 loop 等太久才 rewind
     - 症狀：開啟「延伸字幕顯示」時，loop 要等到下一句開始才 rewind，
       而不是在當前句說完時立刻重播
     - 原因：loop 比對的是延伸後的 duration（含補白間隙），而非原始說話時間
     - 修正：改用 _rawPrimarySubtitles 的原始 duration 計算 rewind 時機

  3. subtitleOffset 導致 loop 時間點偏移
     - 症狀：設有字幕時間偏移時，loop 的 rewind 時機和 seek 目標都有偏差
     - 原因：loop check 用 raw video.currentTime，未套用 offset
     - 修正：loop check 改用 tSub（套用 offset 後），seek target 改為 startTime - offset

【新功能】

■ Overlay 一鍵複製字幕
  - 字幕 overlay 右上角新增複製圖示按鈕
  - 滑鼠移入 overlay 時按鈕淡入；點擊後自動複製當前主字幕文字至剪貼簿
  - 複製成功後圖示短暫切換為勾選符號（1.5 秒後復原），提供明確回饋
  - hover-pause 凍結狀態下複製的是凍結句，而非下一句
  - 點擊不影響單句循環（已阻止事件冒泡）



---

v5.3 更新紀錄（2026-04-29）
============================

【修正】

■ 登入使用者無法使用社群字幕與編輯字幕（權限競態 Bug）
  - 症狀：已登入用戶進入頁面後，社群字幕選項仍顯示「🔒」或 disabled，
    編輯模式也無法進入
  - 根本原因：_registerAndCheckEditorPermission() 會非同步查詢 Firestore，
    若查無明確的 editor 記錄則回寫 _editorEnabled = false，
    覆蓋掉 _refreshUserTier() 剛設好的 _editorEnabled = true
  - 修正：移除所有 _registerAndCheckEditorPermission() 呼叫點（共 3 處），
    登入即自動取得 editor 權限，不再查詢 Firestore 審核記錄

■ 社群字幕對未登入用戶不開放（錯誤的權限門檻）
  - 症狀：未登入時社群字幕選項鎖定，點擊後顯示「需登入」或「需申請」提示
  - 修正：
    - fetchCommunitySubtitles() 移除 editor 層級檢查，所有用戶皆可讀取
    - showCommunitySubtitlePicker() 移除登入/申請攔截邏輯
    - 自動還原社群字幕（auto-restore）移除 editor 層級檢查
    - _applyTierGates() 移除社群字幕的 disabled 強制設定
  - 社群字幕讀取現對 guest、editor 皆開放；寫入（分享）仍需登入

■ OAuth PKCE 登入失敗（client_secret is missing）
  - Web application 類型 OAuth client 在 code exchange 時需傳 client_secret
  - firebase.js token exchange body 補上 CLIENT_SECRET 常數

■ 切換翻譯服務時字幕整體閃爍
  - 原因：切換 provider 時重新呼叫 autoLoadSubtitles，導致已載入的主字幕被清空重抓
  - 修正：新增 skipPrimary flag，provider 切換時只重載副字幕，主字幕不重複請求

■ 懸浮球初次載入位置錯誤（無字幕影片）
  - 原因：collapseSidebar('no-sub') 時 #movie_player 尚未渲染，syncWrapperToPlayer 失效
  - 修正：補加 300ms / 1000ms 兩次重試；syncWrapperToPlayer 偵測到 player 不存在時自動重試

【架構調整】

■ 三階層權限簡化為兩階層
  - 移除中間 'user' 層（需申請）
  - 現為：guest（未登入）/ editor（已登入，自動授予）
  - 舊的 user 層 UI 提示一併清除

【QA 自動化】

■ vocab-dashboard Playwright 自動化（T1-T10）
  - 新增 tests/qa_vocab_dashboard.mjs
  - T5 改用 window.__qaSetUser 直接注入 mock user，繞過 MV3 SW async 限制
  - 執行：node tests/qa_vocab_dashboard.mjs

---

v5.3.1 更新紀錄（2026-04-30）
==============================

【安全修正】

■ OAuth CLIENT_SECRET 移出 git 歷史
  - 問題：CLIENT_SECRET 明文寫在 firebase.js 並已 commit 進 git，public repo 可見
  - 舊 secret GOCSPX-OI2G... 已在 GCP 撤銷
  - 修正：新建 secret.config.js（已加入 .gitignore），firebase.js 改為 import
  - 使用 git filter-repo --replace-text 清除所有 37 個歷史 commit 中的舊 secret
  - force push 更新 remote，公開 repo 歷史已乾淨

【功能修正】

■ 已學習單字不再在字幕中高亮顯示
  - 需求：生字本中標記為「已學會」的單字，字幕不再套用紫色高亮
  - 修正：buildTokenizedText() 與 patchSavedWordHighlights() 加入 _learnedWordSet 排除條件
  - _learnedWordSet：從 storage 中 status === 'learned' 的單字建立的 Set

■ 標記已學習後字幕高亮未即時消失
  - 問題：在頁面上點擊「標記為已學會」後，字幕中的高亮不會立即消失（需 reload）
  - 根本原因：toggleLearnedStatus() 更新 _learnedWordSet 後未呼叫 patchSavedWordHighlights()
    （deleteWord() 有呼叫，但兩個 toggleLearnedStatus callback 都遺漏）
  - 修正：兩處 toggleLearnedStatus storage callback 皆補上 patchSavedWordHighlights()

【QA 自動化】

■ 已學習單字不高亮回歸測試
  - 新增 tests/qa_wordbook_learned_nohighlight.mjs
  - 三場景：無 status 應高亮 / status='learned' 不高亮 / 移除 status 後恢復
  - 使用 editedSubtitles 本地字幕策略，繞過 YouTube pot token 限制
  - 執行：node tests/qa_wordbook_learned_nohighlight.mjs（11/11 全過）

