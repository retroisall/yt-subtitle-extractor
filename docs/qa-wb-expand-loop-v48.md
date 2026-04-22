# QA 靜態審查報告：生字本展開朗讀 + 重複句功能

- **審查日期**：2026-04-22
- **審查員**：QA（靜態代碼審查）
- **審查範圍**：`d:\dev\chrome字幕套件開發\content.js`
- **功能版本**：v48（wbExpandLoop 功能）

---

## A. defaultSettings 與設定綁定

**1. `defaultSettings()` 中有 `wbExpandLoop: false`**
- 位置：line 139
- `wbExpandLoop: false,   // 生字本展開時持續重複句子（間隔 3 秒）`
- ✅ PASS

**2. HTML 中有 `id="yt-sub-wb-expand-loop"` 的 checkbox**
- 位置：line 408
- `<input type="checkbox" id="yt-sub-wb-expand-loop">`
- ✅ PASS

**3. 設定綁定程式碼有讀取 `wbExpandLoopEl.checked` 並賦值給 `settings.wbExpandLoop`**
- 位置：lines 754-757
- `wbExpandLoopEl.checked = settings.wbExpandLoop;` 及 `settings.wbExpandLoop = wbExpandLoopEl.checked;`
- ✅ PASS

**4. 設定 toggle 關閉時有呼叫 `_stopWbExpandLoop()`**
- 位置：line 759
- `if (!settings.wbExpandLoop) _stopWbExpandLoop();`
- ✅ PASS

---

## B. 狀態變數宣告

**5. `let _wbExpandLoopTimer = null` 存在**
- 位置：line 59
- `let _wbExpandLoopTimer = null;`
- ✅ PASS

**6. `let _wbExpandLoopMode = null` 存在**
- 位置：line 60
- `let _wbExpandLoopMode  = null;`
- ✅ PASS

---

## C. _stopWbExpandLoop

**7. 有 `clearInterval(_wbExpandLoopTimer)`**
- 位置：line 2023
- ✅ PASS

**8. 有 `clearTimeout(_wbExpandLoopTimer)`（避免 TTS setTimeout 洩漏）**
- 位置：line 2024
- ✅ PASS

**9. 有 `_wbExpandLoopTimer = null` 與 `_wbExpandLoopMode = null` 重置**
- 位置：lines 2025-2026
- ✅ PASS

**10. 有 `window.speechSynthesis?.cancel()`**
- 位置：line 2027
- `window.speechSynthesis?.cancel();`（使用 optional chaining，安全無誤）
- ✅ PASS

---

## D. _startWbExpandLoop — video 模式

**11. 先呼叫 `_stopWbExpandLoop()` 清除舊 loop**
- 位置：line 2034
- ✅ PASS

**12. `isSameVideo` 判斷包含：`item.videoId === currentVideoId` 且 `item.startTime != null`**
- 位置：line 2036
- `const isSameVideo = !!(item.videoId && item.videoId === currentVideoId && item.startTime != null);`
- 條件完整，且使用 `!!` 強制布林化
- ✅ PASS

**13. video 模式設定 `_wbExpandLoopMode = 'video'`**
- 位置：line 2037
- `_wbExpandLoopMode = isSameVideo ? 'video' : 'tts';`（在 if/else 分支前統一賦值）
- ✅ PASS

**14. 用 `primarySubtitles.find(...)` 查句子 duration，fallback 為 4 秒**
- 位置：line 2040-2041
- `const sub = primarySubtitles.find(s => Math.abs(s.startTime - item.startTime) < 0.1);`
- `const cycleDuration = ((sub?.duration || 4) + 3) * 1000;`
- fallback 為 4 秒，符合規格
- ✅ PASS

**15. `cycleDuration = (duration + 3) * 1000`**
- 位置：line 2041
- `((sub?.duration || 4) + 3) * 1000`，計算正確
- ✅ PASS

**16. 立即 `seekTo(item.startTime)`，影片暫停時有 `video.play()`**
- 位置：lines 2042-2044
- `seekTo(item.startTime);`（立即執行）
- `if (video?.paused) video.play().catch(() => {});`（暫停時播放，catch 避免 Promise reject）
- ✅ PASS

**17. `setInterval(() => seekTo(item.startTime), cycleDuration)` 並賦值給 `_wbExpandLoopTimer`**
- 位置：line 2045
- `_wbExpandLoopTimer = setInterval(() => seekTo(item.startTime), cycleDuration);`
- ✅ PASS

---

## E. _startWbExpandLoop — tts 模式

**18. tts 模式設定 `_wbExpandLoopMode = 'tts'`**
- 位置：line 2037
- 與項目 13 同行，三元運算子賦值
- ✅ PASS

**19. 有 `video.pause()` 暫停影片**
- 位置：line 2049
- `if (video && !video.paused) video.pause();`（有防呆：不重複 pause）
- ✅ PASS

**20. `SpeechSynthesisUtterance` 設定 `lang = 'en-US'`、`rate = 0.85`**
- 位置：lines 2053-2054
- `utter.lang = 'en-US'; utter.rate = 0.85;`
- ✅ PASS

**21. 使用 `item.context || item.word` 作為朗讀文字**
- 位置：line 2052
- `new SpeechSynthesisUtterance(item.context || item.word)`
- ✅ PASS

**22. `utter.onend` 中檢查 `_wbExpandLoopMode !== 'tts'` 後 early return**
- 位置：line 2056
- `if (_wbExpandLoopMode !== 'tts') return;`（正確防止 loop 停止後繼續排程）
- ✅ PASS

**23. `onend` 中用 `setTimeout(scheduleTts, 3000)` 遞迴排程，並賦值給 `_wbExpandLoopTimer`**
- 位置：line 2057
- `_wbExpandLoopTimer = setTimeout(scheduleTts, 3000);`
- ✅ PASS

**24. 每次朗讀前有 `window.speechSynthesis.cancel()`**
- 位置：line 2059
- `window.speechSynthesis.cancel();`（在 `speak()` 前清除，避免 queue 堆積）
- ⚠️ 觀察：此處使用 `window.speechSynthesis.cancel()`（無 optional chaining），而 `_stopWbExpandLoop` 用 `window.speechSynthesis?.cancel()`。tts 分支在進入前已確認 `window.speechSynthesis` 存在（否則早於此呼叫的 `speak` 也會爆錯），故不構成 FAIL，但風格不一致。
- ✅ PASS

---

## F. 展開 toggle handler

**25. handler 先判斷 `isExpanding = !row.classList.contains('expanded')`**
- 位置：line 2456
- `const isExpanding = !row.classList.contains('expanded');`
- ✅ PASS

**26. 先 `listEl.querySelectorAll('.yt-sub-wb-row.expanded').forEach(r => r.classList.remove('expanded'))` 收合其他卡**
- 位置：line 2458
- `listEl.querySelectorAll('.yt-sub-wb-row.expanded').forEach(r => r.classList.remove('expanded'));`
- ⚠️ 觀察：此操作收合「所有」展開卡（包含當前 row），之後才在 `if (isExpanding)` 中重新 `add('expanded')`。邏輯正確但順序上 `isExpanding` 必須在 `classList.remove` 之前讀取（已在 line 2456 讀取），無 bug。
- ✅ PASS

**27. 先呼叫 `_stopWbExpandLoop()`**
- 位置：line 2459
- `_stopWbExpandLoop();`（在 classList 批次清除後、展開判斷前呼叫）
- ✅ PASS

**28. `isExpanding` 為 true 時呼叫 `speakWord(item.word)`**
- 位置：line 2462
- `speakWord(item.word);`（在 `if (isExpanding)` 分支內）
- ✅ PASS

**29. `isExpanding` 且 `settings.wbExpandLoop` 為 true 時才呼叫 `_startWbExpandLoop(item)`**
- 位置：line 2463
- `if (settings.wbExpandLoop) _startWbExpandLoop(item);`（已在 `if (isExpanding)` 內，雙重條件正確）
- ✅ PASS

**30. `isExpanding` 為 false（即收合）時不再重新展開，`_stopWbExpandLoop` 已被呼叫**
- 位置：lines 2459-2464（handler 整體結構）
- 收合路徑：`_stopWbExpandLoop()` 被呼叫，無 `row.classList.add('expanded')`，loop 確實停止
- ✅ PASS

---

## G. 邊界情況

**31. `_startWbExpandLoop` 開頭呼叫 `_stopWbExpandLoop()`，確保不會雙重啟動**
- 位置：line 2034
- ✅ PASS

**32. tts 模式：`scheduleTts` 是 closure 內部函式，不依賴外部 mutable 狀態（除了 `_wbExpandLoopMode`）**
- `scheduleTts` 定義於 line 2050，捕捉 `item`（傳入參數，不可變）與 `_wbExpandLoopMode`（module-level，有意依賴）
- closure 結構正確，無意外的外部 mutable 狀態依賴
- ✅ PASS

**33. video 模式：`seekTo` 在 interval callback 中呼叫，確認 `seekTo` 函式在此 scope 可用**
- `seekTo` 定義於 line 4185，與 `_startWbExpandLoop`（line 2033）同屬同一外層 closure（IIFE）
- JavaScript hoisting（function declaration）確保可用
- ✅ PASS

**34. `wbExpandLoopEl` 綁定的 `saveSettings()` 呼叫存在**
- 位置：line 758
- `saveSettings();`（在 change listener 內，`_stopWbExpandLoop` 之前呼叫）
- ✅ PASS

---

## 額外觀察（不計入 FAIL）

- ⚠️ **video 模式 `seekTo` 後立即 `play()`，但 setInterval 的週期 callback 僅呼叫 `seekTo` 而未再次 `play()`**：若使用者在 interval 期間手動暫停，後續 seek 不會自動恢復播放。此屬設計邊緣情況，不構成 FAIL 但可考慮改進。
- ⚠️ **`speechSynthesis.cancel()` 風格不一致**：`_stopWbExpandLoop` 用 `?.`，`scheduleTts` 內不用。建議統一使用 `window.speechSynthesis?.cancel()`。
- ⚠️ **tts 模式的 `_wbExpandLoopTimer` 第一次 `scheduleTts()` 呼叫（line 2062）為同步直接呼叫，`_wbExpandLoopTimer` 直到 `onend` 後才被賦值**：若在朗讀期間呼叫 `_stopWbExpandLoop()`，`clearTimeout(null)` 無害，timer 可透過 `_wbExpandLoopMode` 檢查正確中止，無洩漏風險。

---

## 審查結果統計

| 類別 | 通過 | 失敗 |
|------|------|------|
| A. defaultSettings 與設定綁定 | 4 | 0 |
| B. 狀態變數宣告 | 2 | 0 |
| C. _stopWbExpandLoop | 4 | 0 |
| D. _startWbExpandLoop video 模式 | 7 | 0 |
| E. _startWbExpandLoop tts 模式 | 7 | 0 |
| F. 展開 toggle handler | 6 | 0 |
| G. 邊界情況 | 4 | 0 |
| **合計** | **34** | **0** |

---

## 整體結論

**整體 PASS**

34 項審查全數通過，無 FAIL。3 項 ⚠️ 觀察屬潛在設計改善點，不影響功能正確性與穩定性。
