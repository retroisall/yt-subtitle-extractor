// editor.js — 自定義字幕編輯器邏輯（ES Module）

// ===== 狀態變數 =====
const params = new URLSearchParams(location.search);
const ytTabId = parseInt(params.get('tabId'));

/** 目前載入的字幕資料（從 background 取得）*/
let currentData = null;

/** 合併後的字幕陣列（primarySubtitles 為主）*/
let subtitles = [];

/** 目前 focus 的列 index（-1 表示無）*/
let focusRowIdx = -1;

/** 同步播放模式：focus 到列時自動跳轉到對應時間點 */
let syncMode = false;

/** 循環模式：focus 到列時持續重播該句 */
let loopMode = false;

/** YouTube 分頁是否仍存活 */
let ytAlive = false;

/** 目前搜尋關鍵字 */
let searchKeyword = '';

// ===== 初始化入口 =====

/**
 * 頁面載入後初始化：
 * 1. 讀取持久化設定
 * 2. 從 background 取得字幕資料
 * 3. 綁定 UI 事件
 * 4. 開始偵測 YT 分頁狀態
 */
function main() {
  // 讀取持久化的 toggle 設定
  chrome.storage.local.get(['editorSyncMode', 'editorLoopMode'], (r) => {
    syncMode = r.editorSyncMode || false;
    loopMode = r.editorLoopMode || false;
    renderToggleState();
  });

  // 從 background 取得字幕資料
  if (!isNaN(ytTabId)) {
    chrome.runtime.sendMessage({ type: 'editor_getSubtitles', ytTabId }, (resp) => {
      if (resp?.data) {
        renderEditor(resp.data);
        // 載入後檢查是否有本地儲存，若有則提示還原
        checkLocalSave(resp.data.videoId);
      } else {
        showNoDataState();
      }
    });
  } else {
    showNoDataState();
  }

  // 綁定 toolbar 事件
  bindToolbarEvents();

  // 綁定 footer 事件
  bindFooterEvents();

  // 開始偵測 YT 分頁存活狀態（每 3 秒一次）
  checkYtTab();
  setInterval(checkYtTab, 3000);
}

// ===== YT 分頁存活偵測 =====

/**
 * 檢查 YouTube 分頁是否仍開著，並更新連線狀態指示燈
 */
function checkYtTab() {
  if (isNaN(ytTabId)) {
    ytAlive = false;
    updateYtStatus();
    return;
  }
  chrome.tabs.get(ytTabId, (tab) => {
    ytAlive = !chrome.runtime.lastError && !!tab;
    updateYtStatus();
  });
}

/**
 * 更新 topbar 的 YT 連線狀態燈和文字
 */
function updateYtStatus() {
  const dot = document.getElementById('ed-yt-dot');
  const label = document.getElementById('ed-yt-label');
  if (!dot || !label) return;
  if (ytAlive) {
    dot.className = 'ed-yt-dot alive';
    label.textContent = '已連線';
  } else {
    dot.className = 'ed-yt-dot';
    label.textContent = '未連線';
  }
}

// ===== 渲染編輯器 =====

/**
 * 取得字幕資料後渲染整個編輯器介面
 * @param {Object} data - 從 background 取得的字幕資料
 */
function renderEditor(data) {
  currentData = data;

  // 合併 primarySubtitles（副字幕用同 index 對齊）
  subtitles = data.primarySubtitles || [];

  // 更新影片標題
  const titleEl = document.getElementById('ed-video-title');
  if (titleEl) {
    titleEl.textContent = data.videoTitle || '（未知影片）';
    titleEl.title = data.videoTitle || '';
  }

  // 預設字幕名稱
  const subnameEl = document.getElementById('ed-subname');
  if (subnameEl && !subnameEl.value) {
    subnameEl.value = data.videoTitle || '';
  }

  // 更新行數 badge
  updateLineCount();

  // 渲染表格
  renderTable();

  // 顯示表格，隱藏無資料狀態
  document.getElementById('ed-table-wrap').style.display = '';
  document.getElementById('ed-no-data').style.display = 'none';
}

/**
 * 顯示無資料狀態（字幕尚未載入或資料不存在）
 */
function showNoDataState() {
  document.getElementById('ed-table-wrap').style.display = 'none';
  document.getElementById('ed-no-data').style.display = 'flex';
  updateLineCount();
}

/**
 * 更新「X 句」行數 badge 及工具列行數計數
 */
function updateLineCount() {
  const count = subtitles.length;
  const lineEl = document.getElementById('ed-line-count');
  const rowCountEl = document.getElementById('ed-row-count');
  if (lineEl) lineEl.textContent = `${count} 句`;
  if (rowCountEl) rowCountEl.textContent = count > 0 ? `共 ${count} 句` : '';
}

// ===== 表格渲染 =====

/**
 * 將字幕陣列渲染為表格列
 */
function renderTable() {
  const tbody = document.getElementById('ed-tbody');
  if (!tbody) return;

  tbody.innerHTML = '';
  const secondary = currentData?.secondarySubtitles || [];

  subtitles.forEach((sub, idx) => {
    const secSub = secondary[idx] || null;
    const tr = createRow(sub, secSub, idx);
    tbody.appendChild(tr);
  });

  // 套用搜尋過濾
  applySearch();
}

/**
 * 建立單一字幕列的 DOM 元素
 * @param {Object} sub - 主字幕資料 { startTime, duration, text }
 * @param {Object|null} secSub - 副字幕資料（可能為 null）
 * @param {number} idx - 列 index
 * @returns {HTMLTableRowElement}
 */
function createRow(sub, secSub, idx) {
  const tr = document.createElement('tr');
  tr.dataset.idx = idx;

  // 點擊列時設定 focus（但非 textarea，讓 textarea 自行處理）
  tr.addEventListener('mousedown', (e) => {
    if (e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'BUTTON') {
      setFocusRow(idx);
    }
  });

  // # 序號
  const numTd = document.createElement('td');
  numTd.className = 'ed-cell-num';
  numTd.textContent = idx + 1;
  tr.appendChild(numTd);

  // 時間碼（唯讀）
  const timeTd = document.createElement('td');
  const startStr = toSrtTime(sub.startTime);
  const endStr = toSrtTime(sub.startTime + (sub.duration || 0));
  timeTd.innerHTML = `<span class="ed-timecode" title="${startStr} → ${endStr}">${startStr}<br><span style="color:#52525b">→${endStr}</span></span>`;
  timeTd.style.cursor = 'pointer';
  timeTd.title = '點擊跳轉到此時間點';
  timeTd.addEventListener('click', () => {
    setFocusRow(idx);
    relayToYt({ type: 'SEEK_TO', time: sub.startTime });
  });
  tr.appendChild(timeTd);

  // 主字幕 textarea
  const mainTd = document.createElement('td');
  const mainTA = createSubtitleTextarea(sub.text || '', idx, 'main');
  mainTd.appendChild(mainTA);
  tr.appendChild(mainTd);

  // 副字幕 textarea
  const secTd = document.createElement('td');
  const secTA = createSubtitleTextarea(secSub?.text || '', idx, 'sec');
  secTd.appendChild(secTA);
  tr.appendChild(secTd);

  // 清空按鈕
  const actTd = document.createElement('td');
  const clearBtn = document.createElement('button');
  clearBtn.className = 'ed-clear-btn';
  clearBtn.textContent = '×';
  clearBtn.title = '清空此列字幕';
  clearBtn.addEventListener('click', () => {
    clearRow(idx);
  });
  actTd.appendChild(clearBtn);
  tr.appendChild(actTd);

  return tr;
}

/**
 * 建立字幕 textarea 元素並綁定事件
 * @param {string} text - 初始文字
 * @param {number} idx - 列 index
 * @param {'main'|'sec'} kind - 主或副字幕
 * @returns {HTMLTextAreaElement}
 */
function createSubtitleTextarea(text, idx, kind) {
  const ta = document.createElement('textarea');
  ta.className = 'ed-sub-textarea';
  ta.value = text;
  ta.rows = 2;
  ta.dataset.kind = kind;
  ta.dataset.idx = idx;
  ta.spellcheck = false;

  // focus 時設定 focus row
  ta.addEventListener('focus', () => {
    setFocusRow(idx);
  });

  // 自動調整高度
  ta.addEventListener('input', () => {
    autoResizeTextarea(ta);
  });

  // Tab 鍵導航：從最後一個 textarea 跳到下一列第一個
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Tab' && !e.shiftKey) {
      if (kind === 'sec') {
        // 目前在副字幕，Tab 跳到下一列主字幕
        e.preventDefault();
        focusNextRow(idx);
      }
      // 在主字幕，讓 Tab 自然跳到副字幕（瀏覽器預設）
    }
    if (e.key === 'Tab' && e.shiftKey) {
      if (kind === 'main' && idx > 0) {
        // 在主字幕按 Shift+Tab，跳到上一列副字幕
        e.preventDefault();
        focusPrevRow(idx);
      }
    }
  });

  // 初始調整高度
  requestAnimationFrame(() => autoResizeTextarea(ta));

  return ta;
}

/**
 * 自動調整 textarea 高度以適應內容
 * @param {HTMLTextAreaElement} ta
 */
function autoResizeTextarea(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 'px';
}

/**
 * 清空指定列的主副字幕文字（不移除列）
 * @param {number} idx - 列 index
 */
function clearRow(idx) {
  const tbody = document.getElementById('ed-tbody');
  const tr = tbody?.querySelector(`tr[data-idx="${idx}"]`);
  if (!tr) return;
  tr.querySelectorAll('.ed-sub-textarea').forEach(ta => {
    ta.value = '';
    autoResizeTextarea(ta);
  });
}

// ===== Focus 邏輯 =====

/**
 * 設定目前 focus 的列 index，並觸發相應動作
 * @param {number} idx - 列 index（-1 表示取消 focus）
 */
function setFocusRow(idx) {
  if (idx === focusRowIdx) return;
  focusRowIdx = idx;
  updateFocusHighlight();
  updateFocusIndicator();
  onFocusChanged(idx);
}

/**
 * 更新表格列的 focus 高亮樣式
 */
function updateFocusHighlight() {
  const tbody = document.getElementById('ed-tbody');
  if (!tbody) return;

  tbody.querySelectorAll('tr.ed-row-focused').forEach(tr => {
    tr.classList.remove('ed-row-focused', 'ed-loop-active');
  });

  if (focusRowIdx < 0) return;

  const tr = tbody.querySelector(`tr[data-idx="${focusRowIdx}"]`);
  if (!tr) return;
  tr.classList.add('ed-row-focused');
  if (loopMode) tr.classList.add('ed-loop-active');
}

/**
 * 更新 toolbar 的 focus 指示器文字
 */
function updateFocusIndicator() {
  const el = document.getElementById('ed-focus-indicator');
  if (!el) return;
  if (focusRowIdx < 0) {
    el.textContent = '未選取';
    return;
  }
  const sub = subtitles[focusRowIdx];
  if (!sub) return;
  el.textContent = `第 ${focusRowIdx + 1} 句 / ${toSrtTime(sub.startTime)}`;
}

/**
 * 當 focus 列變更時，根據 syncMode / loopMode 觸發播放控制
 * @param {number} idx - 新的 focus index
 */
function onFocusChanged(idx) {
  // 更新 footer 循環狀態 bar
  updateLoopStatusBar();

  if (idx < 0) {
    // 失去 focus → 停止循環
    if (loopMode) relayToYt({ type: 'LOOP_STOP' });
    return;
  }

  const sub = subtitles[idx];
  if (!sub) return;

  if (syncMode && !loopMode) {
    // 同步播放模式：跳轉到對應時間點播一次後暫停
    relayToYt({ type: 'SEEK_TO', time: sub.startTime, endTime: sub.startTime + (sub.duration || 0) });
  }

  if (loopMode) {
    // 循環模式：持續重播該句
    relayToYt({
      type: 'LOOP_LINE',
      startTime: sub.startTime,
      endTime: sub.startTime + (sub.duration || 0),
    });
  }
}

/**
 * 更新 footer 循環狀態 bar 的顯示
 */
function updateLoopStatusBar() {
  const statusEl = document.getElementById('ed-loop-status');
  const textEl = document.getElementById('ed-loop-text');
  if (!statusEl) return;

  if (loopMode && focusRowIdx >= 0) {
    const sub = subtitles[focusRowIdx];
    statusEl.classList.add('visible');
    if (textEl && sub) {
      textEl.textContent = `循環中：第 ${focusRowIdx + 1} 句（${toSrtTime(sub.startTime)}）`;
    }
  } else {
    statusEl.classList.remove('visible');
  }
}

// ===== Tab 鍵導航 =====

/**
 * 將 focus 移到下一列的主字幕 textarea
 * @param {number} currentIdx - 目前列 index
 */
function focusNextRow(currentIdx) {
  const nextIdx = currentIdx + 1;
  if (nextIdx >= subtitles.length) return;
  const tbody = document.getElementById('ed-tbody');
  const nextRow = tbody?.querySelector(`tr[data-idx="${nextIdx}"]`);
  if (!nextRow) return;
  const mainTA = nextRow.querySelector('.ed-sub-textarea[data-kind="main"]');
  if (mainTA) {
    mainTA.focus();
    // focus 事件會觸發 setFocusRow(nextIdx)
  }
}

/**
 * 將 focus 移到上一列的副字幕 textarea
 * @param {number} currentIdx - 目前列 index
 */
function focusPrevRow(currentIdx) {
  const prevIdx = currentIdx - 1;
  if (prevIdx < 0) return;
  const tbody = document.getElementById('ed-tbody');
  const prevRow = tbody?.querySelector(`tr[data-idx="${prevIdx}"]`);
  if (!prevRow) return;
  const secTA = prevRow.querySelector('.ed-sub-textarea[data-kind="sec"]');
  if (secTA) secTA.focus();
}

// ===== Toggle 按鈕 =====

/**
 * 切換同步播放模式並持久化設定
 */
function toggleSync() {
  syncMode = !syncMode;
  chrome.storage.local.set({ editorSyncMode: syncMode });
  renderToggleState();
  // 若已有 focus 且開啟同步，立即跳轉
  if (syncMode && !loopMode && focusRowIdx >= 0) {
    onFocusChanged(focusRowIdx);
  }
}

/**
 * 切換循環模式並持久化設定
 */
function toggleLoop() {
  loopMode = !loopMode;
  chrome.storage.local.set({ editorLoopMode: loopMode });
  renderToggleState();
  updateFocusHighlight();
  updateLoopStatusBar();

  if (!loopMode) {
    // 關閉循環：發送停止指令
    relayToYt({ type: 'LOOP_STOP' });
  } else if (focusRowIdx >= 0) {
    // 開啟循環：立即開始循環當前句
    onFocusChanged(focusRowIdx);
  }
}

/**
 * 根據目前 syncMode / loopMode 更新按鈕外觀
 */
function renderToggleState() {
  const syncBtn = document.getElementById('ed-sync-btn');
  const loopBtn = document.getElementById('ed-loop-btn');
  if (!syncBtn || !loopBtn) return;

  syncBtn.classList.toggle('sync-on', syncMode);
  loopBtn.classList.toggle('loop-on', loopMode);
}

// ===== 搜尋過濾 =====

/**
 * 根據 searchKeyword 顯示/隱藏字幕列
 */
function applySearch() {
  const keyword = searchKeyword.toLowerCase().trim();
  const tbody = document.getElementById('ed-tbody');
  if (!tbody) return;

  let visibleCount = 0;
  tbody.querySelectorAll('tr[data-idx]').forEach(tr => {
    const idx = parseInt(tr.dataset.idx);
    const sub = subtitles[idx];
    const secSub = currentData?.secondarySubtitles?.[idx];

    if (!keyword) {
      tr.classList.remove('ed-row-hidden');
      visibleCount++;
      return;
    }

    const mainText = (getMainText(idx) || sub?.text || '').toLowerCase();
    const secText = (getSecText(idx) || secSub?.text || '').toLowerCase();

    const matches = mainText.includes(keyword) || secText.includes(keyword);
    tr.classList.toggle('ed-row-hidden', !matches);
    if (matches) visibleCount++;
  });

  // 更新可見數量
  const rowCountEl = document.getElementById('ed-row-count');
  if (rowCountEl) {
    if (keyword) {
      rowCountEl.textContent = `${visibleCount} / ${subtitles.length} 句`;
    } else {
      rowCountEl.textContent = `共 ${subtitles.length} 句`;
    }
  }
}

// ===== 讀取 textarea 目前值 =====

/**
 * 取得指定列主字幕目前的文字（從 DOM textarea）
 * @param {number} idx - 列 index
 * @returns {string}
 */
function getMainText(idx) {
  const tr = document.querySelector(`#ed-tbody tr[data-idx="${idx}"]`);
  if (!tr) return subtitles[idx]?.text || '';
  return tr.querySelector('.ed-sub-textarea[data-kind="main"]')?.value || '';
}

/**
 * 取得指定列副字幕目前的文字（從 DOM textarea）
 * @param {number} idx - 列 index
 * @returns {string}
 */
function getSecText(idx) {
  const tr = document.querySelector(`#ed-tbody tr[data-idx="${idx}"]`);
  if (!tr) return currentData?.secondarySubtitles?.[idx]?.text || '';
  return tr.querySelector('.ed-sub-textarea[data-kind="sec"]')?.value || '';
}

// ===== 通訊到 YT 分頁 =====

/**
 * 透過 background relay 將播放控制指令傳送到 YouTube 分頁
 * @param {Object} payload - 指令物件 { type, ... }
 */
function relayToYt(payload) {
  if (!ytAlive) return;
  chrome.runtime.sendMessage({ type: 'editor_relay', ytTabId, payload });
}

// ===== 匯出 .srt =====

/**
 * 將目前字幕匯出為 .srt 格式檔案並下載
 */
function exportSrt() {
  const author = document.getElementById('ed-author')?.value.trim() || '';
  const name = document.getElementById('ed-subname')?.value.trim() || 'subtitle';
  const videoId = currentData?.videoId || '';

  // 自定義 header
  let out = `[CUSTOM_SUBTITLE]\nauthor=${author}\nname=${name}\nvideoId=${videoId}\n\n`;

  subtitles.forEach((sub, i) => {
    const mainText = getMainText(i).trim();
    const secText = getSecText(i).trim();
    if (!mainText && !secText) return;

    out += `${i + 1}\n`;
    out += `${toSrtTime(sub.startTime)} --> ${toSrtTime(sub.startTime + (sub.duration || 0))}\n`;
    // 雙字幕用 | 分隔
    if (secText) {
      out += `${mainText} | ${secText}\n`;
    } else {
      out += `${mainText}\n`;
    }
    out += '\n';
  });

  const blob = new Blob([out], { type: 'text/plain; charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${name}.srt`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ===== 分享至社群 =====

/**
 * 點擊分享按鈕：檢查登入狀態後顯示確認 dialog
 */
function handleShare() {
  if (!currentData) {
    alert('沒有字幕資料可分享。');
    return;
  }

  // 先確認目前登入狀態
  chrome.runtime.sendMessage({ type: 'fb_getUser' }, (resp) => {
    if (!resp?.user) {
      // 未登入：提示
      showShareDialog(null);
    } else {
      showShareDialog(resp.user);
    }
  });
}

/**
 * 顯示分享確認 dialog
 * @param {Object|null} user - 目前登入的使用者（null 表示未登入）
 */
function showShareDialog(user) {
  // 移除已有的 dialog
  document.querySelector('.ed-dialog-backdrop')?.remove();

  const backdrop = document.createElement('div');
  backdrop.className = 'ed-dialog-backdrop';

  const author = document.getElementById('ed-author')?.value.trim() || '';
  const name = document.getElementById('ed-subname')?.value.trim() || '';

  if (!user) {
    // 未登入情況
    backdrop.innerHTML = `
      <div class="ed-dialog">
        <h3>請先登入 Google 帳號</h3>
        <p>分享字幕至社群需要登入。<br>請回到 YouTube 頁面，點擊側邊欄右上角的帳號圖示進行登入。</p>
        <div class="ed-dialog-btns">
          <button id="ed-dialog-cancel">關閉</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);
    document.getElementById('ed-dialog-cancel')?.addEventListener('click', () => backdrop.remove());
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });
    return;
  }

  // 已登入：確認分享
  backdrop.innerHTML = `
    <div class="ed-dialog">
      <h3>分享至社群</h3>
      <p>
        確認要以「<strong>${escapeHtml(author || user.email || '匿名')}</strong>」的名義，
        將字幕「<strong>${escapeHtml(name || '未命名')}</strong>」
        （共 ${subtitles.length} 句）分享至社群嗎？<br><br>
        分享後其他用戶可在該影片的「👥 社群字幕」功能中看到。
      </p>
      <div class="ed-dialog-btns">
        <button id="ed-dialog-cancel">取消</button>
        <button id="ed-dialog-confirm" class="confirm">確認分享</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  document.getElementById('ed-dialog-cancel')?.addEventListener('click', () => backdrop.remove());
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) backdrop.remove(); });

  document.getElementById('ed-dialog-confirm')?.addEventListener('click', () => {
    // 收集目前 textarea 的最新字幕內容
    const editedPrimary = subtitles.map((sub, i) => ({
      ...sub,
      text: getMainText(i),
    }));
    const editedSecondary = (currentData?.secondarySubtitles || []).map((sub, i) => ({
      ...sub,
      text: getSecText(i),
    }));

    chrome.runtime.sendMessage({
      type: 'fb_shareSubtitle',
      videoId: currentData.videoId,
      authorName: author || user.email,
      subtitleName: name || '未命名',
      primarySubtitles: editedPrimary,
      secondarySubtitles: editedSecondary,
    }, (resp) => {
      backdrop.remove();
      if (resp?.ok) {
        alert('分享成功！感謝您的貢獻。');
      } else {
        alert(`分享失敗：${resp?.error || '未知錯誤'}`);
      }
    });
  });
}

// ===== 輔助函式 =====

/**
 * 將秒數轉換為 SRT 時間碼格式（HH:MM:SS,mmm）
 * @param {number} sec - 秒數（可含小數）
 * @returns {string}
 */
function toSrtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 1000);
  return [
    String(h).padStart(2, '0'),
    String(m).padStart(2, '0'),
    String(s).padStart(2, '0'),
  ].join(':') + ',' + String(ms).padStart(3, '0');
}

/**
 * 跳脫 HTML 特殊字元，防止 XSS
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ===== 事件綁定 =====

/**
 * 綁定 toolbar 區域的所有事件（搜尋、toggle 按鈕）
 */
function bindToolbarEvents() {
  // 搜尋框：即時過濾
  document.getElementById('ed-search')?.addEventListener('input', (e) => {
    searchKeyword = e.target.value;
    applySearch();
  });

  // 同步播放 toggle
  document.getElementById('ed-sync-btn')?.addEventListener('click', toggleSync);

  // 循環此句 toggle
  document.getElementById('ed-loop-btn')?.addEventListener('click', toggleLoop);
}

/**
 * 綁定 footer 區域的所有事件（匯出、分享）
 */
function bindFooterEvents() {
  // 匯出 .srt
  document.getElementById('ed-export-btn')?.addEventListener('click', () => {
    if (!currentData) {
      alert('沒有字幕資料可匯出。');
      return;
    }
    exportSrt();
  });

  // 儲存到本地
  document.getElementById('ed-save-local-btn')?.addEventListener('click', handleSaveLocal);

  // 分享至社群
  document.getElementById('ed-share-btn')?.addEventListener('click', handleShare);
}

// ===== 本地儲存 =====

/**
 * 從表格收集目前所有編輯內容，合併回 currentData 並回傳快照
 */
function collectCurrentEdits() {
  if (!currentData) return null;
  const rows = document.querySelectorAll('#ed-tbody tr[data-idx]');
  const primary   = [...currentData.primarySubtitles];
  const secondary = [...(currentData.secondarySubtitles || [])];
  rows.forEach(tr => {
    const idx = parseInt(tr.dataset.idx);
    const priTA = tr.querySelector('.ed-sub-textarea[data-kind="pri"]');
    const secTA = tr.querySelector('.ed-sub-textarea[data-kind="sec"]');
    if (priTA && primary[idx])   primary[idx]   = { ...primary[idx],   text: priTA.value };
    if (secTA && secondary[idx]) secondary[idx] = { ...secondary[idx], text: secTA.value };
  });
  return {
    videoId:            currentData.videoId,
    videoTitle:         currentData.videoTitle,
    authorName:         document.getElementById('ed-author')?.value || '',
    subtitleName:       document.getElementById('ed-subtitle-name')?.value || '',
    primarySubtitles:   primary,
    secondarySubtitles: secondary,
    savedAt:            Date.now(),
  };
}

/**
 * 儲存目前編輯內容到 chrome.storage.local
 */
function handleSaveLocal() {
  if (!currentData?.videoId) {
    alert('沒有字幕資料可儲存。');
    return;
  }
  const snapshot = collectCurrentEdits();
  if (!snapshot) return;

  const key = `localSubtitle_${snapshot.videoId}`;
  chrome.storage.local.set({ [key]: snapshot }, () => {
    const btn = document.getElementById('ed-save-local-btn');
    const orig = btn.textContent;
    btn.textContent = '✅ 已儲存';
    btn.disabled = true;
    setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
  });

  // 儲存的同時，將編輯後的字幕套用到 YT 分頁
  relayToYt({
    type:               'APPLY_SUBTITLES',
    primarySubtitles:   snapshot.primarySubtitles,
    secondarySubtitles: snapshot.secondarySubtitles,
  });
}

/**
 * 開啟編輯器後，若偵測到此影片有本地儲存版本，提示使用者是否還原
 * @param {string} videoId
 */
function checkLocalSave(videoId) {
  if (!videoId) return;
  const key = `localSubtitle_${videoId}`;
  chrome.storage.local.get(key, (result) => {
    const saved = result[key];
    if (!saved) return;

    const d = new Date(saved.savedAt);
    const timeStr = `${d.getFullYear()}/${d.getMonth()+1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2,'0')}`;

    // 建立還原提示橫幅
    const banner = document.createElement('div');
    banner.id = 'ed-local-restore-banner';
    banner.className = 'ed-local-restore-banner';
    banner.innerHTML = `
      <span>💾 偵測到本地儲存（${timeStr}）${saved.subtitleName ? `「${saved.subtitleName}」` : ''}，要還原嗎？</span>
      <div class="ed-local-restore-actions">
        <button id="ed-restore-yes" class="ed-restore-btn yes">還原</button>
        <button id="ed-restore-no"  class="ed-restore-btn no">略過</button>
      </div>
    `;
    document.querySelector('.ed-meta-row')?.insertAdjacentElement('afterend', banner);

    document.getElementById('ed-restore-yes')?.addEventListener('click', () => {
      // 還原 author / name
      const authorEl = document.getElementById('ed-author');
      const nameEl   = document.getElementById('ed-subtitle-name');
      if (authorEl && saved.authorName)   authorEl.value = saved.authorName;
      if (nameEl   && saved.subtitleName) nameEl.value   = saved.subtitleName;

      // 還原字幕內容（同步全域 subtitles，renderTable 依賴此變數）
      currentData.primarySubtitles   = saved.primarySubtitles;
      currentData.secondarySubtitles = saved.secondarySubtitles;
      subtitles = saved.primarySubtitles;
      renderTable();
      banner.remove();
    });

    document.getElementById('ed-restore-no')?.addEventListener('click', () => banner.remove());
  });
}

// ===== 啟動 =====
main();
