// content.js — Content Script（隔離世界）

(function () {
  'use strict';

  /* ===== Debug Relay（ws://localhost:9527）=====
  啟用方式：取消此區塊的註解，並執行 node relay-server.js
  (function setupRelay() {
    let _ws = null;
    const _q = [];

    function _connect() {
      try {
        _ws = new WebSocket('ws://localhost:9527');
        _ws.onopen  = () => { _q.forEach(m => _ws.send(m)); _q.length = 0; };
        _ws.onclose = () => { _ws = null; };
        _ws.onerror = () => { _ws = null; };
      } catch(e) {}
    }

    window.__dbgSend = function(msg) {
      if (!_ws || _ws.readyState > 1) _connect();
      if (_ws && _ws.readyState === 1) _ws.send(msg);
      else if (_ws) _q.push(msg);
    };

    window.addEventListener('error', e =>
      window.__dbgSend(`[content:error] ${e.message}  @ ${e.filename?.split('/').pop()}:${e.lineno}:${e.colno}`));
    window.addEventListener('unhandledrejection', e =>
      window.__dbgSend(`[content:unhandled] ${e.reason?.stack || e.reason}`));

    const _err = console.error;
    console.error = (...a) => { _err(...a); window.__dbgSend('[content:error] ' + a.join(' ')); };

    _connect();
  })();
  ===== end Debug Relay ===== */

  // ===== 狀態 =====
  let trackList = [];
  let primarySubtitles = [];
  let _rawPrimarySubtitles = []; // 未延長的原始字幕（供設定切換時重算用）
  let secondarySubtitles = [];
  let syncInterval = null;
  let _listHovering = false; // 滑鼠 hover 在字幕列表上時凍結高亮捲動
  let injected = false;
  let pendingTranslation = null;
  let pendingPrimaryTranslation = null; // 主字幕 Google Translate 翻譯目標
  let primaryTranslationJob = null;     // 主字幕翻譯 job（獨立於副字幕的 translationJob）
  let translationJob = null;
  let loopingIdx = -1;
  let _playerRO = null;       // ResizeObserver：監聽 player 大小變化以同步 wrapper 高度
  let _forcedTheater = false; // 記錄展開時是否由套件主動切入劇院模式（收合時還原）
  let _ccBtnObserver = null;  // MutationObserver：監聽 CC 按鈕 aria-pressed，與 overlay 字幕綁定開關
  let _currentPrimIdx = -1;  // sync loop 目前顯示的主字幕 index（供 >/<  按鈕直接使用，避免 gap 時 findActiveIndex 回傳 -1）
  let _navedToIdx = -1;     // 手動跳句的目標 index；sync loop 必須等 video 真正抵達此 index 才可更新 _currentPrimIdx
  let _navLockedIdx = -1;   // 導航鎖定的目標 index，連點時以此為基準（避免 seek async 期間重算同一句）
  let _navLockUntil = 0;    // 導航鎖定到期時間戳；期間 sync loop 不更新 _currentPrimIdx
  let _wbExpandLoopTimer = null; // 生字本展開重複句 timer（setInterval ID 或 setTimeout ID）
  let _wbExpandLoopMode  = null; // 'video' | 'tts' | null
  let _lastSyncPrimIdx = -2; // 上一次 sync loop 的 primIdx，用來避免 index 未變時重跑 DOM list 更新
  let _windowContextMenuBound = false; // window capture 右鍵 delegation 是否已綁定（只綁一次）
  const translationCache = {};  // videoId:lang → subtitles array (max 10 entries)
  const TRANSLATION_CACHE_MAX = 10;

  // ===== 常數 =====
  const SETTINGS_KEY = 'yt-sub-settings';

  const SECONDARY_LANG_OPTIONS = [
    { languageCode: 'zh-TW', name: '繁體中文' },
    { languageCode: 'zh-Hans', name: '簡體中文' },
    { languageCode: 'en', name: '英文' },
    { languageCode: 'ja', name: '日文' },
    { languageCode: 'ko', name: '韓文' },
    { languageCode: 'es', name: '西班牙文' },
    { languageCode: 'fr', name: '法文' },
    { languageCode: 'de', name: '德文' },
    { languageCode: 'id', name: '印尼文' },
    { languageCode: 'th', name: '泰文' },
    { languageCode: 'vi', name: '越南文' },
    { languageCode: 'pt', name: '葡萄牙文' },
    { languageCode: 'ar', name: '阿拉伯文' },
    { languageCode: 'ru', name: '俄文' },
  ];

  const FONT_SIZES = {
    primary: { sm: '11px', md: '13px', lg: '16px' },
    secondary: { sm: '10px', md: '12px', lg: '14px' },
  };

  const SECONDARY_COLORS = {
    purple: '#a855f7',
    cyan: '#22d3ee',
    yellow: '#fbbf24',
    white: '#e0e0e0',
  };

  // ===== 設定 =====
  function loadSettings() {
    try {
      const saved = localStorage.getItem(SETTINGS_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        // 舊版 secondaryLang 遷移
        if (parsed.secondaryLang && !parsed.secondaryLangs) {
          parsed.secondaryLangs = [parsed.secondaryLang, '__none__', '__none__'];
          delete parsed.secondaryLang;
        }
        return { ...defaultSettings(), ...parsed };
      }
    } catch (e) { }
    return defaultSettings();
  }

  function defaultSettings() {
    return {
      primaryLang: 'en',
      primaryVssId: null,
      secondaryLangs: ['zh-TW', '__none__', '__none__'],  // 優先權 1→2→3
      dualEnabled: true,
      asrLang: 'en',
      primarySize: 100,
      secondarySize: 100,
      loopInterval: 0.5,
      secondaryColor: 'purple',
      clickToSeek: true,
      autoScroll: true,
      overlayEnabled: true,
      subtitleSwapped: false, // 上下顛倒：翻譯字幕在上、原生字幕在下
      loopSentence: true,   // 單句循環
      translationProvider: 'ytlang',  // ytlang | google
      googleBatchMode: 'sentence8', // sentence8 | words100
      wordHover: true,   // 單字 hover 高亮
      wordSpeak: true,   // 點擊單字朗讀
      extensionEnabled: true, // 套件整體開關
      extendSubtitles: true, // 延長字幕顯示（填滿字幕間的空白間隔）
      filterSoundDesc: false, // 過濾狀聲詞（移除 [Music] 等方括號標示）
      keyboardNav: true,     // A/D 快捷鍵控制上一句 / 下一句
      wbExpandLoop: false,   // 生字本展開時持續重複句子（間隔 3 秒）
      subtitleOffset: 0,    // 字幕時間偏移（秒），正數延後、負數提前，範圍 ±30
      onboardingDone: false, // 是否已完成語言初始設定
    };
  }

  function saveSettings() {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  let settings = loadSettings();

  // ===== 注入 inject.js =====
  function injectScript() {
    if (injected) { window.postMessage({ type: 'YT_SUBTITLE_DEMO_REQUEST' }, '*'); return; }
    injected = true;
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('inject.js');
    script.onload = function () { this.remove(); };
    (document.head || document.documentElement).appendChild(script);
  }

  // ===== 建立 UI =====
  function createSidebar() {
    if (document.getElementById('yt-sub-demo-sidebar')) return;

    const sidebar = document.createElement('div');
    sidebar.id = 'yt-sub-demo-sidebar';
    sidebar.innerHTML = `
      <div class="yt-sub-header">
        <div class="yt-sub-title-area">
          <!-- LOGO：膠囊 Tag 風格 -->
          <div class="yt-sub-logo yt-sub-logo--style-b">
            <span class="yt-sub-logo-zh">學習</span><span class="yt-sub-logo-bar">Bar</span>
          </div>
          <!-- 5×3 點陣狀態指示器 -->
          <canvas id="yt-sub-led" class="yt-sub-led" title="狀態指示"></canvas>
        </div>
        <div class="yt-sub-header-btns">
          <button class="yt-sub-icon-btn reload" id="yt-sub-refresh-btn" title="重新載入字幕">↺</button>
          <!-- 同步按鈕：cloud + arrows SVG -->
          <button class="yt-sub-icon-btn yt-sub-sync-icon-btn" id="yt-sub-cloud-sync-btn" title="雙向同步單字" style="display:none">
            <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14.5 9A4.5 4.5 0 0 0 6.2 7H5a3 3 0 0 0 0 6h1"/>
              <polyline points="10 13 12.5 10.5 10 8"/>
              <polyline points="12.5 10.5 7 10.5"/>
            </svg>
          </button>
          <!-- 帳號按鈕 -->
          <button class="yt-sub-account-btn" id="yt-sub-account-btn" title="帳號">
            <!-- 未登入：人像 -->
            <svg id="yt-sub-avatar-guest" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="10" cy="7" r="3"/>
              <path d="M3.5 17c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5"/>
            </svg>
            <!-- 已登入：G 字樣 -->
            <span id="yt-sub-avatar-loggedin" style="display:none;font-size:12px;font-weight:700;color:#fff;line-height:1">G</span>
          </button>
        </div>
      </div>
      <!-- 帳號 Dropdown -->
      <div id="yt-sub-account-dropdown" class="yt-sub-account-dropdown" style="display:none">
        <span id="yt-sub-account-email-disp" class="yt-sub-account-email"></span>
        <button id="yt-sub-signout-btn" class="yt-sub-signout-btn">登出</button>
      </div>

      <div class="yt-sub-tab-bar" id="yt-sub-tab-bar">
        <button class="yt-sub-tab active" data-tab="subtitle">字幕</button>
        <button class="yt-sub-tab" data-tab="wordbook">生字本</button>
        <button class="yt-sub-tab" data-tab="settings">設定</button>
      </div>

      <div class="yt-sub-body" id="yt-sub-body">

        <!-- TAB 1：字幕 -->
        <div class="yt-sub-panel active" id="yt-sub-panel-subtitle">
          <div class="yt-sub-langs" id="yt-sub-langs"></div>
          <div class="yt-sub-panel-actions">
            <select id="yt-sub-source-select" class="yt-sub-select yt-sub-source-select" title="字幕來源">
              <option value="default">📄 預設字幕</option>
              <option value="custom" disabled>✏ 自定義字幕</option>
              <option value="community" disabled>👥 社群字幕</option>
              <option value="import-srt">📥 匯入 SRT</option>
            </select>
            <select id="yt-sub-mode-select" class="yt-sub-select yt-sub-mode-select" title="播放模式">
              <option value="default">預設模式</option>
              <option value="subtitle">字幕模式</option>
              <option value="edit">編輯字幕模式</option>
            </select>
          </div>
          <div class="yt-sub-current" id="yt-sub-current">
            <div class="yt-sub-current-primary" id="yt-sub-cur-primary"></div>
            <div class="yt-sub-current-secondary" id="yt-sub-cur-secondary"></div>
          </div>
          <div class="yt-sub-list" id="yt-sub-list"></div>
          <div class="yt-sub-status" id="yt-sub-status">載入中...</div>
        </div>

        <!-- TAB 2：生字本 -->
        <div class="yt-sub-panel" id="yt-sub-panel-wordbook">
          <div class="yt-sub-wordbook" id="yt-sub-wordbook">
            <div class="yt-sub-wordbook-toolbar">
              <select class="yt-sub-select yt-sub-wordbook-sort" id="yt-sub-wordbook-sort">
                <option value="date-desc" selected>最近加入</option>
                <option value="current-video">從此影片生成的生字</option>
                <option value="count-desc">查詢最多</option>
                <option value="alpha">字母順序</option>
                <option value="learned">已學會</option>
              </select>
              <button class="yt-sub-wb-loop-btn" id="yt-sub-wb-loop-btn" title="循環當前句">⇄</button>
              <span class="yt-sub-wordbook-count" id="yt-sub-wordbook-count"></span>
            </div>
            <input class="yt-sub-wb-search" id="yt-sub-wb-search" type="text" placeholder="搜尋單字…" autocomplete="off" spellcheck="false">
            <div class="yt-sub-wordbook-list" id="yt-sub-wordbook-list"></div>
          </div>
        </div>

        <!-- TAB 3：設定 -->
        <div class="yt-sub-panel" id="yt-sub-panel-settings">
          <div class="yt-sub-settings" id="yt-sub-settings">

            <div class="yt-sub-settings-section">
              <div class="yt-sub-settings-section-title">語言</div>
              <div class="yt-sub-settings-row">
                <span class="yt-sub-settings-label">語言偏好</span>
                <span class="yt-sub-primary-lang-display" id="yt-sub-primary-lang-display"></span>
                <button class="yt-sub-ob-reset-btn" id="yt-sub-ob-reset">重新設定</button>
              </div>
              <div class="yt-sub-settings-row">
                <span class="yt-sub-settings-label">雙語模式</span>
                <label class="yt-sub-switch">
                  <input type="checkbox" id="yt-sub-dual-toggle">
                  <span class="yt-sub-switch-slider"></span>
                </label>
              </div>
              <div class="yt-sub-settings-row" id="yt-sub-secondary-row">
                <span class="yt-sub-settings-label">副字幕</span>
                <select id="yt-sub-secondary-select-0" class="yt-sub-select"></select>
              </div>
              <div class="yt-sub-settings-row" id="yt-sub-asr-row" style="display:none">
                <span class="yt-sub-settings-label">自動產生語言</span>
                <select id="yt-sub-asr-select" class="yt-sub-select"></select>
              </div>
            </div>

            <div class="yt-sub-settings-section">
              <div class="yt-sub-settings-section-title">翻譯服務</div>
              <div class="yt-sub-settings-row">
                <span class="yt-sub-settings-label">服務</span>
                <select id="yt-sub-trans-provider" class="yt-sub-select">
                  <option value="ytlang">YouTube 內建</option>
                  <option value="google">Google（免費）</option>
                </select>
              </div>
              <div class="yt-sub-settings-row" id="yt-sub-batch-mode-row" style="display:none">
                <span class="yt-sub-settings-label">批次模式</span>
                <select id="yt-sub-batch-mode" class="yt-sub-select">
                  <option value="sentence8">固定 8 句</option>
                  <option value="words100">約 100 字</option>
                </select>
              </div>
            </div>

            <div class="yt-sub-settings-section">
              <div class="yt-sub-settings-section-title">顯示</div>

              <div class="yt-sub-settings-sub-title">影片下方的字幕</div>
              <div class="yt-sub-settings-row">
                <span class="yt-sub-settings-label">翻譯字幕顏色</span>
                <div class="yt-sub-swatch-group" id="yt-sub-color-group">
                  <button class="yt-sub-swatch" data-val="purple" style="background:#a855f7" title="紫"></button>
                  <button class="yt-sub-swatch" data-val="cyan"   style="background:#22d3ee" title="青"></button>
                  <button class="yt-sub-swatch" data-val="yellow" style="background:#fbbf24" title="黃"></button>
                  <button class="yt-sub-swatch" data-val="white"  style="background:#e0e0e0" title="白"></button>
                </div>
              </div>

              <div class="yt-sub-settings-sub-title">側邊欄的字幕</div>
              <div class="yt-sub-settings-row">
                <span class="yt-sub-settings-label">原生字幕大小</span>
                <div class="yt-sub-scale-group">
                  <input type="range" id="yt-sub-primary-scale" min="100" max="500" step="10">
                  <span id="yt-sub-primary-scale-val" class="yt-sub-scale-label"></span>
                </div>
              </div>
              <div class="yt-sub-settings-row">
                <span class="yt-sub-settings-label">翻譯字幕大小</span>
                <div class="yt-sub-scale-group">
                  <input type="range" id="yt-sub-secondary-scale" min="100" max="500" step="10">
                  <span id="yt-sub-secondary-scale-val" class="yt-sub-scale-label"></span>
                </div>
              </div>
              <div class="yt-sub-settings-row">
                <span class="yt-sub-settings-label">上下顛倒</span>
                <label class="yt-sub-switch">
                  <input type="checkbox" id="yt-sub-swap-toggle">
                  <span class="yt-sub-switch-slider"></span>
                </label>
              </div>
            </div>

            <div class="yt-sub-settings-section">
              <div class="yt-sub-settings-section-title">行為</div>
              <div class="yt-sub-settings-row">
                <span class="yt-sub-settings-label">單句循環</span>
                <label class="yt-sub-switch">
                  <input type="checkbox" id="yt-sub-loop-sentence">
                  <span class="yt-sub-switch-slider"></span>
                </label>
              </div>
              <div class="yt-sub-settings-row">
                <span class="yt-sub-settings-label">影片浮動字幕</span>
                <label class="yt-sub-switch">
                  <input type="checkbox" id="yt-sub-overlay-toggle">
                  <span class="yt-sub-switch-slider"></span>
                </label>
              </div>
              <div class="yt-sub-settings-row">
                <span class="yt-sub-settings-label">點擊字幕跳轉</span>
                <label class="yt-sub-switch">
                  <input type="checkbox" id="yt-sub-click-seek">
                  <span class="yt-sub-switch-slider"></span>
                </label>
              </div>
              <div class="yt-sub-settings-row">
                <span class="yt-sub-settings-label">自動捲動</span>
                <label class="yt-sub-switch">
                  <input type="checkbox" id="yt-sub-auto-scroll">
                  <span class="yt-sub-switch-slider"></span>
                </label>
              </div>
              <div class="yt-sub-settings-row">
                <span class="yt-sub-settings-label">單字 Hover 高亮</span>
                <label class="yt-sub-switch">
                  <input type="checkbox" id="yt-sub-word-hover">
                  <span class="yt-sub-switch-slider"></span>
                </label>
              </div>
              <div class="yt-sub-settings-row">
                <span class="yt-sub-settings-label">點擊單字朗讀</span>
                <label class="yt-sub-switch">
                  <input type="checkbox" id="yt-sub-word-speak">
                  <span class="yt-sub-switch-slider"></span>
                </label>
              </div>
              <div class="yt-sub-settings-row">
                <span class="yt-sub-settings-label">延長字幕顯示</span>
                <label class="yt-sub-switch">
                  <input type="checkbox" id="yt-sub-extend-subs">
                  <span class="yt-sub-switch-slider"></span>
                </label>
              </div>
              <div class="yt-sub-settings-row">
                <span class="yt-sub-settings-label">過濾狀聲詞 [Music]</span>
                <label class="yt-sub-switch">
                  <input type="checkbox" id="yt-sub-filter-sound-desc">
                  <span class="yt-sub-switch-slider"></span>
                </label>
              </div>
              <div class="yt-sub-settings-row">
                <span class="yt-sub-settings-label">A/D 鍵跳句</span>
                <label class="yt-sub-switch">
                  <input type="checkbox" id="yt-sub-keyboard-nav">
                  <span class="yt-sub-switch-slider"></span>
                </label>
              </div>
              <div class="yt-sub-settings-row">
                <span class="yt-sub-settings-label">生字本展開重複句</span>
                <label class="yt-sub-switch">
                  <input type="checkbox" id="yt-sub-wb-expand-loop">
                  <span class="yt-sub-switch-slider"></span>
                </label>
              </div>
              <div class="yt-sub-settings-row yt-sub-offset-row">
                <span class="yt-sub-settings-label">字幕時間偏移</span>
                <div class="yt-sub-offset-control">
                  <input type="range" id="yt-sub-offset-slider" min="-30" max="30" step="0.5" value="0" class="yt-sub-offset-slider">
                  <span id="yt-sub-offset-display" class="yt-sub-offset-display">0.0s</span>
                </div>
              </div>
              <div class="yt-sub-settings-row">
                <span class="yt-sub-settings-label">循環間隔（秒）</span>
                <input type="number" id="yt-sub-loop-interval" min="0" max="10" step="0.5" class="yt-sub-num-input">
              </div>
            </div>


            <!-- 版本號 -->
            <div style="text-align:right;padding:8px 4px 0;font-size:10px;color:#52525b;">
              v${chrome.runtime.getManifest().version}
            </div>

          </div>
        </div>

      </div>
    `;
    // 填入 banner 圖片的 extension URL（content script 無法直接用相對路徑）
    const bannerEl = sidebar.querySelector('#yt-sub-banner');
    if (bannerEl) bannerEl.src = chrome.runtime.getURL('banner.png');

    // wrapper：把 sidebar + ball 包在同一個容器，clip-path 只作用於 sidebar，不影響 ball
    const wrapper = document.createElement('div');
    wrapper.id = 'yt-sub-wrapper';
    wrapper.appendChild(sidebar);
    document.body.appendChild(wrapper);
    createBall(wrapper);

    // 對齊播放器高度（初始化 + 視窗縮放時更新）
    syncWrapperToPlayer();
    window.addEventListener('resize', syncWrapperToPlayer);

    // 若套件為停用狀態，直接收合
    if (!settings.extensionEnabled) {
      sidebar.classList.add('sidebar-collapsed');
      document.getElementById('yt-sub-body').style.display = 'none';
    }

    // 尚未完成語言初始設定 → 顯示 Onboarding
    if (!settings.onboardingDone) showOnboarding();

    updateOverlayRight();
    _updateEditModeOption(); // 初始狀態：未登入前先鎖定

    // ===== 字幕來源選單：切換預設 / 自定義 / 社群字幕 =====
    document.getElementById('yt-sub-source-select')?.addEventListener('change', (e) => {
      const val = e.target.value;
      if (val === 'default') {
        customSubtitleActive = false;
        setActiveSourceBtn(null);
        const statusEl = document.getElementById('yt-sub-status');
        if (statusEl) { statusEl.textContent = '已切換至預設字幕'; statusEl.className = 'yt-sub-status'; }
      } else if (val === 'community') {
        e.target.value = customSubtitleActive ? 'community' : 'default';
        showCommunitySubtitlePicker();
      } else if (val === 'import-srt') {
        // 記錄切換前的值，若取消則還原
        const prevVal = e.target.dataset.prevSource || 'default';
        e.target.value = prevVal;
        importSrtFile();
      }
      // custom 選項在自定義字幕已套用時才可選，目前以 setActiveSourceBtn('custom') 管理
      if (val !== 'import-srt') e.target.dataset.prevSource = val;
    });

    // ===== 播放模式選單：切換預設 / 字幕模式 / 編輯字幕模式 =====
    document.getElementById('yt-sub-mode-select')?.addEventListener('change', async (e) => {
      const val = e.target.value;
      if (val === _currentMode) return;
      // 非預設模式下切換：先退出當前模式再進入新模式
      if (_currentMode !== 'default') {
        const exited = await exitSpecialMode();
        if (!exited) { e.target.value = _currentMode; return; }
      }
      if (val === 'subtitle') {
        enterSubtitleMode();
      } else if (val === 'edit') {
        enterEditMode();
      }
      // val === 'default'：exitSpecialMode 已處理退出
    });

    // 重新載入字幕
    document.getElementById('yt-sub-refresh-btn').addEventListener('click', () => {
      if (translationJob) { translationJob.cancelled = true; translationJob = null; }
      if (primaryTranslationJob) { primaryTranslationJob.cancelled = true; primaryTranslationJob = null; }
      if (_nextBatchTimer) { clearTimeout(_nextBatchTimer); _nextBatchTimer = null; }
      primarySubtitles = [];
      _rawPrimarySubtitles = [];
      secondarySubtitles = [];
      trackList = [];
      // 手動重新載入時解除自定義/社群字幕封鎖，重新從 YT 取得
      customSubtitleActive = false;
      setActiveSourceBtn(null);
      applyOverlay(); // 無字幕，撤掉 overlay 並恢復原生字幕
      if (syncInterval) clearInterval(syncInterval);
      const statusEl = document.getElementById('yt-sub-status');
      if (statusEl) { statusEl.textContent = '重新載入中...'; statusEl.className = 'yt-sub-status'; }
      setLedState('loading');
      const listEl = document.getElementById('yt-sub-list');
      if (listEl) listEl.innerHTML = '';
      const langsEl = document.getElementById('yt-sub-langs');
      if (langsEl) langsEl.innerHTML = '';
      const curPrim = document.getElementById('yt-sub-cur-primary');
      const curSec = document.getElementById('yt-sub-cur-secondary');
      if (curPrim) curPrim.textContent = '';
      if (curSec) curSec.textContent = '';
      window.postMessage({ type: 'YT_SUBTITLE_DEMO_REQUEST' }, '*');
    });

    // 頁籤切換（opacity 淡入淡出，panel 全留在 DOM 避免重排）
    let _wordbookLoaded = false;
    document.querySelectorAll('.yt-sub-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.yt-sub-tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const target = tab.dataset.tab;
        document.querySelectorAll('.yt-sub-panel').forEach(p => p.classList.remove('active'));
        document.getElementById('yt-sub-panel-' + target)?.classList.add('active');
        // 切到生字本時永遠重新渲染（storage 讀取快，確保即時反映最新存字）
        if (target === 'wordbook') {
          renderWordbook();
        }
      });
    });

    // 生字本排序 / 搜尋變更時重新渲染
    document.getElementById('yt-sub-wordbook-sort').addEventListener('change', () => renderWordbook());
    document.getElementById('yt-sub-wb-search').addEventListener('input', () => renderWordbook());

    // 生字本循環當前句按鈕
    document.getElementById('yt-sub-wb-loop-btn').addEventListener('click', () => {
      const video = document.querySelector('video');
      if (!video || !primarySubtitles.length) return;
      if (loopingIdx >= 0) {
        console.log('[YT-SUB][LOOP] wb-loop-btn → cancel');
        loopingIdx = -1;
      } else {
        const idx = findActiveIndex(primarySubtitles, video.currentTime + (settings.subtitleOffset || 0));
        if (idx >= 0) { console.log('[YT-SUB][LOOP] wb-loop-btn → set idx=', idx); loopingIdx = idx; }
      }
      updateCurrentLoopStyle();
      updateWbLoopBtn();
    });

    // ── 語言設定（即時生效）────────────────────────────────────
    const dualToggle = document.getElementById('yt-sub-dual-toggle');
    dualToggle.checked = settings.dualEnabled;
    updateSecondaryRowOpacity();

    dualToggle.addEventListener('change', () => {
      settings.dualEnabled = dualToggle.checked;
      saveSettings();
      updateSecondaryRowOpacity();
      primarySubtitles = []; _rawPrimarySubtitles = [];
      secondarySubtitles = [];
      autoLoadSubtitles(trackList);
    });

    document.getElementById('yt-sub-secondary-select-0').addEventListener('change', function () {
      settings.secondaryLangs[0] = this.value;
      // 不呼叫 saveSettings()：只影響當前影片，不覆蓋全域偏好
      secondarySubtitles = [];
      autoLoadSubtitles(trackList);
    });

    document.getElementById('yt-sub-asr-select').addEventListener('change', function () {
      settings.asrLang = this.value;
      // 若目前主字幕是舊的 ASR track，清掉讓它重選
      const currentTrack = trackList.find(t => t.vssId === settings.primaryVssId);
      if (currentTrack && (currentTrack.vssId || '').startsWith('a.')) {
        settings.primaryVssId = null;
      }
      saveSettings();
      primarySubtitles = []; _rawPrimarySubtitles = [];
      secondarySubtitles = [];
      renderLanguages(trackList); // 重新渲染（過濾後只顯示選定的 ASR）
    });

    // ── 顯示設定（即時套用）────────────────────────────────────
    function _bindScaleSlider(sliderId, valId, settingKey) {
      const slider = document.getElementById(sliderId);
      const valEl  = document.getElementById(valId);
      if (!slider || !valEl) return;
      slider.value = settings[settingKey] || 100;
      valEl.textContent = slider.value + '%';
      slider.addEventListener('input', () => {
        settings[settingKey] = Number(slider.value);
        valEl.textContent = slider.value + '%';
        saveSettings();
        applyDisplaySettings();
        renderSubtitleList();
      });
    }
    _bindScaleSlider('yt-sub-primary-scale',   'yt-sub-primary-scale-val',   'primarySize');
    _bindScaleSlider('yt-sub-secondary-scale', 'yt-sub-secondary-scale-val', 'secondarySize');
    setupSwatchGroup('yt-sub-color-group', 'secondaryColor');

    // ── 循環間隔 ──────────────────────────────────────────────
    const loopIntervalEl = document.getElementById('yt-sub-loop-interval');
    if (loopIntervalEl) {
      loopIntervalEl.value = settings.loopInterval ?? 0.5;
      loopIntervalEl.addEventListener('change', () => {
        settings.loopInterval = Math.max(0, Math.min(10, Number(loopIntervalEl.value)));
        loopIntervalEl.value = settings.loopInterval;
        saveSettings();
      });
    }

    // ── 翻譯服務設定 ──────────────────────────────────────────
    const providerSel = document.getElementById('yt-sub-trans-provider');
    providerSel.value = settings.translationProvider;
    updateTransProviderUI();

    providerSel.addEventListener('change', () => {
      settings.translationProvider = providerSel.value;
      saveSettings();
      updateTransProviderUI();
      secondarySubtitles = [];
      autoLoadSubtitles(trackList);
    });

    const batchModeSel = document.getElementById('yt-sub-batch-mode');
    batchModeSel.value = settings.googleBatchMode;
    batchModeSel.addEventListener('change', () => {
      settings.googleBatchMode = batchModeSel.value;
      saveSettings();
    });

    // ── 單句循環 ──────────────────────────────────────────────
    const loopToggle = document.getElementById('yt-sub-loop-sentence');
    loopToggle.checked = settings.loopSentence;
    loopToggle.addEventListener('change', () => {
      settings.loopSentence = loopToggle.checked;
      saveSettings();
      if (!settings.loopSentence) loopingIdx = -1;
    });

    // ── 上下顛倒 ──────────────────────────────────────────────
    const swapToggle = document.getElementById('yt-sub-swap-toggle');
    if (swapToggle) {
      swapToggle.checked = !!settings.subtitleSwapped;
      swapToggle.addEventListener('change', () => {
        settings.subtitleSwapped = swapToggle.checked;
        saveSettings();
        applySubtitleSwap();
        renderSubtitleList(); // 側邊欄列表重新渲染以套用順序
      });
    }

    // ── overlay 開關 ──────────────────────────────────────────
    const overlayToggle = document.getElementById('yt-sub-overlay-toggle');
    overlayToggle.checked = settings.overlayEnabled;
    applyOverlay();

    overlayToggle.addEventListener('change', () => {
      settings.overlayEnabled = overlayToggle.checked;
      saveSettings();
      applyOverlay();
    });

    // ── 行為設定 ───────────────────────────────────────────────
    const clickSeekEl = document.getElementById('yt-sub-click-seek');
    const autoScrollEl = document.getElementById('yt-sub-auto-scroll');
    clickSeekEl.checked = settings.clickToSeek;
    autoScrollEl.checked = settings.autoScroll;

    clickSeekEl.addEventListener('change', () => {
      settings.clickToSeek = clickSeekEl.checked;
      saveSettings();
    });
    autoScrollEl.addEventListener('change', () => {
      settings.autoScroll = autoScrollEl.checked;
      saveSettings();
    });

    // ── 側邊欄當前字幕區：點擊切換單句循環 ──────────────────────
    document.getElementById('yt-sub-current').addEventListener('click', e => {
      if (e.target.closest('.yt-sub-word')) return;
      if (loopingIdx >= 0) {
        console.log('[YT-SUB][LOOP] yt-sub-current click → cancel');
        loopingIdx = -1;
      } else {
        const video = document.querySelector('video');
        const primIdx = findActiveIndex(primarySubtitles, video?.currentTime || 0);
        if (primIdx >= 0) { console.log('[YT-SUB][LOOP] yt-sub-current click → set idx=', primIdx); loopingIdx = primIdx; }
      }
      updateCurrentLoopStyle();
    });

    const wordHoverEl = document.getElementById('yt-sub-word-hover');
    const wordSpeakEl = document.getElementById('yt-sub-word-speak');
    wordHoverEl.checked = settings.wordHover;
    wordSpeakEl.checked = settings.wordSpeak;
    applyWordHoverStyle();

    wordHoverEl.addEventListener('change', () => {
      settings.wordHover = wordHoverEl.checked;
      saveSettings();
      applyWordHoverStyle();
    });
    wordSpeakEl.addEventListener('change', () => {
      settings.wordSpeak = wordSpeakEl.checked;
      saveSettings();
    });

    const extendSubsEl = document.getElementById('yt-sub-extend-subs');
    extendSubsEl.checked = settings.extendSubtitles;
    extendSubsEl.addEventListener('change', () => {
      settings.extendSubtitles = extendSubsEl.checked;
      saveSettings();
      // 已有字幕時立即重新套用（不重新 fetch，直接從原始資料重算）
      if (_rawPrimarySubtitles.length) {
        primarySubtitles = settings.extendSubtitles
          ? extendSubtitleDurations(_rawPrimarySubtitles)
          : [..._rawPrimarySubtitles];
        renderSubtitleList();
      }
    });

    const filterSoundEl = document.getElementById('yt-sub-filter-sound-desc');
    filterSoundEl.checked = settings.filterSoundDesc;
    filterSoundEl.addEventListener('change', () => {
      settings.filterSoundDesc = filterSoundEl.checked;
      saveSettings();
      if (primarySubtitles.length) renderSubtitleList();
    });

    const keyboardNavEl = document.getElementById('yt-sub-keyboard-nav');
    keyboardNavEl.checked = settings.keyboardNav;
    keyboardNavEl.addEventListener('change', () => {
      settings.keyboardNav = keyboardNavEl.checked;
      saveSettings();
    });

    const wbExpandLoopEl = document.getElementById('yt-sub-wb-expand-loop');
    wbExpandLoopEl.checked = settings.wbExpandLoop;
    wbExpandLoopEl.addEventListener('change', () => {
      settings.wbExpandLoop = wbExpandLoopEl.checked;
      saveSettings();
      if (!settings.wbExpandLoop) _stopWbExpandLoop();
    });

    // 字幕時間偏移滑桿
    const offsetSlider = document.getElementById('yt-sub-offset-slider');
    const offsetDisplay = document.getElementById('yt-sub-offset-display');
    const formatOffset = v => (v >= 0 ? '+' : '') + parseFloat(v).toFixed(1) + 's';
    offsetSlider.value = settings.subtitleOffset;
    offsetDisplay.textContent = formatOffset(settings.subtitleOffset);
    offsetSlider.addEventListener('input', () => {
      settings.subtitleOffset = parseFloat(offsetSlider.value);
      offsetDisplay.textContent = formatOffset(settings.subtitleOffset);
      saveSettings();
    });

    // 語言偏好顯示名稱（唯讀）
    function updatePrimaryLangDisplay() {
      const el = document.getElementById('yt-sub-primary-lang-display');
      if (!el) return;
      const match = ONBOARDING_LEARN_LANGS.find(l => l.code === settings.primaryLang);
      el.textContent = match ? match.label : settings.primaryLang;
    }
    updatePrimaryLangDisplay();

    // 重新設定語言偏好
    document.getElementById('yt-sub-ob-reset')?.addEventListener('click', () => {
      settings.onboardingDone = false;
      saveSettings();
      showOnboarding();
    });

    // 套用初始顯示設定，同時填充副字幕選單（不依賴 trackList 是否已載入）
    applyDisplaySettings();
    updateSizeGroupUI();
    updateSwatchGroupUI();
    refreshSecondarySelects();
    initWindowContextMenu(); // 在 window 最頂層綁右鍵 delegation，只執行一次

    // ===== Google 帳號區塊 =====
    // ===== Header 帳號 & 同步 =====
    function updateAccountUI(user) {
      const guestSvg = document.getElementById('yt-sub-avatar-guest');
      const loggedInG = document.getElementById('yt-sub-avatar-loggedin');
      const accountBtn = document.getElementById('yt-sub-account-btn');
      const syncBtn = document.getElementById('yt-sub-cloud-sync-btn');
      const emailDisp = document.getElementById('yt-sub-account-email-disp');
      if (user) {
        if (guestSvg) guestSvg.style.display = 'none';
        if (loggedInG) loggedInG.style.display = '';
        if (accountBtn) accountBtn.classList.add('yt-sub-account-btn--active');
        if (syncBtn) syncBtn.style.display = '';
        if (emailDisp) emailDisp.textContent = user.email || user.displayName || '已登入';
      } else {
        if (guestSvg) guestSvg.style.display = '';
        if (loggedInG) loggedInG.style.display = 'none';
        if (accountBtn) accountBtn.classList.remove('yt-sub-account-btn--active');
        if (syncBtn) syncBtn.style.display = 'none';
        const dd = document.getElementById('yt-sub-account-dropdown');
        if (dd) dd.style.display = 'none';
      }
    }

    // 初始化時查詢登入狀態（service worker 可能還在 restoreSession，延遲 1.5s 再試一次）
    chrome.runtime.sendMessage({ type: 'fb_getUser' }, res => {
      if (res?.user) {
        updateAccountUI(res.user);
        _registerAndCheckEditorPermission();
        _refreshUserTier();
      } else {
        _applyTierGates(); // guest 狀態下立即鎖定社群字幕 UI
        setTimeout(() => {
          chrome.runtime.sendMessage({ type: 'fb_getUser' }, res2 => {
            updateAccountUI(res2?.user || null);
            if (res2?.user) { _registerAndCheckEditorPermission(); _refreshUserTier(); }
            else _applyTierGates();
          });
        }, 1500);
      }
    });

    // 帳號按鈕：登入 or 展開 dropdown
    document.getElementById('yt-sub-account-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      chrome.runtime.sendMessage({ type: 'fb_getUser' }, res => {
        const user = res?.user;
        if (!user) {
          // 未登入 → 觸發登入
          const btn = document.getElementById('yt-sub-account-btn');
          btn.disabled = true;
          chrome.runtime.sendMessage({ type: 'fb_signIn' }, r => {
            btn.disabled = false;
            if (r?.ok) {
            updateAccountUI(r.user);
            _registerAndCheckEditorPermission();
            _refreshUserTier(() => {
              // 登入後補跑翻譯（若 primary 已載入但翻譯被 guest 擋住）
              if (_userTier !== 'guest' && primarySubtitles.length && !secondarySubtitles.length && settings.dualEnabled) {
                autoLoadSubtitles(trackList);
              }
            });
          }
            else alert('登入失敗：' + (r?.error || '未知'));
          });
        } else {
          // 已登入 → 確保 UI 同步（session 恢復比初始化慢時補救）
          updateAccountUI(user);
          // 開 / 關 dropdown
          const dd = document.getElementById('yt-sub-account-dropdown');
          if (dd) dd.style.display = dd.style.display === 'none' ? 'flex' : 'none';
        }
      });
    });

    // 登出
    document.getElementById('yt-sub-signout-btn')?.addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'fb_signOut' }, () => {
        updateAccountUI(null);
        _userTier = 'guest';
        _editorEnabled = false;
        _applyTierGates();
      });
    });

    // ⟳ 雙向同步
    document.getElementById('yt-sub-cloud-sync-btn')?.addEventListener('click', () => {
      const btn = document.getElementById('yt-sub-cloud-sync-btn');
      btn.classList.add('yt-sub-syncing');
      btn.disabled = true;
      setLedState('syncing');
      chrome.storage.local.get(SAVED_WORDS_KEY, data => {
        const localWords = data[SAVED_WORDS_KEY] || {};
        chrome.runtime.sendMessage({ type: 'fb_biSync', localWords }, res => {
          btn.classList.remove('yt-sub-syncing');
          btn.disabled = false;
          // 同步完後恢復字幕狀態
          setLedState(primarySubtitles.length ? 'has-sub' : 'idle');
          if (res?.ok) {
            // 寫回合併後的本地
            chrome.storage.local.set({ [SAVED_WORDS_KEY]: res.merged }, () => {
              if (document.getElementById('yt-sub-panel-wordbook')?.classList.contains('active')) {
                renderWordbook();
              }
            });
          } else {
            alert('同步失敗：' + (res?.error || '未知'));
          }
        });
      });
    });

    // 點其他地方關閉 dropdown
    document.addEventListener('click', () => {
      const dd = document.getElementById('yt-sub-account-dropdown');
      if (dd) dd.style.display = 'none';
    });

    // 初始化點陣 LED
    initLed();
  }

  // ===== 5×3 點陣 LED 狀態指示器 =====
  // 每個狀態對應一組 5 列 × 3 行的 bit 圖，以及顏色與動畫類型
  const LED_COLS = 5;
  const LED_ROWS = 3;
  const LED_DOT = 4;   // 每個點的像素大小
  const LED_GAP = 2;   // 點之間的間距
  let _ledState = 'idle';
  let _ledFrame = 0;
  let _ledAlpha = 1;
  let _ledDir = 1;  // 呼吸方向
  let _ledTimer = null;

  // 點陣圖定義（5列×3行，bit=1 代表亮）
  const LED_PATTERNS = {
    idle: {
      // 三個橫排點 • • •（中間一行）
      frames: [[
        [0, 0, 0, 0, 0],
        [1, 0, 1, 0, 1],
        [0, 0, 0, 0, 0],
      ]],
      color: '#52525b', anim: 'static',
    },
    loading: {
      // 流水燈：每 frame 依序點亮一個點
      frames: Array.from({ length: 5 }, (_, i) => [
        [0, 0, 0, 0, 0],
        Array.from({ length: 5 }, (__, j) => j === i ? 1 : 0),
        [0, 0, 0, 0, 0],
      ]),
      color: '#a78bfa', anim: 'loop',
    },
    'has-sub': {
      // 播放三角點陣 ▶
      frames: [[
        [1, 0, 0, 0, 0],
        [1, 1, 1, 0, 0],
        [1, 0, 0, 0, 0],
      ]],
      color: '#4ade80', anim: 'breathe',
    },
    'no-sub': {
      // 叉形 ✕
      frames: [[
        [1, 0, 0, 0, 1],
        [0, 1, 0, 1, 0],
        [1, 0, 0, 0, 1],
      ]],
      color: '#ef4444', anim: 'blink',
    },
    paused: {
      // 雙豎線 ❚❚
      frames: [[
        [1, 0, 1, 0, 0],
        [1, 0, 1, 0, 0],
        [1, 0, 1, 0, 0],
      ]],
      color: '#fbbf24', anim: 'breathe',
    },
    syncing: {
      // 順時針旋轉圓弧：4 個 frame 輪替 4 個角
      frames: [
        [[1, 1, 1, 1, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]],
        [[0, 0, 0, 1, 1], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]],
        [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 1, 1, 1, 1]],
        [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [1, 1, 0, 0, 0]],
      ],
      color: '#a78bfa', anim: 'loop',
    },
    'signing-in': {
      // G 字樣點陣
      frames: [[
        [0, 1, 1, 1, 0],
        [0, 1, 0, 1, 1],
        [0, 1, 1, 1, 0],
      ]],
      color: '#7c3aed', anim: 'breathe',
    },
  };

  // 物理像素寬高（CSS px × DPR）
  const LED_CSS_W = LED_COLS * (LED_DOT + LED_GAP); // = 30px
  const LED_CSS_H = LED_ROWS * (LED_DOT + LED_GAP); // = 18px

  function initLed() {
    const canvas = document.getElementById('yt-sub-led');
    if (!canvas) return;
    // DPR 縮放：讓 Retina 螢幕也清晰
    const dpr = window.devicePixelRatio || 1;
    canvas.width  = LED_CSS_W * dpr;
    canvas.height = LED_CSS_H * dpr;
    canvas.style.width  = LED_CSS_W + 'px';
    canvas.style.height = LED_CSS_H + 'px';
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    setLedState('idle');
  }

  /* 設定 LED 狀態（外部呼叫） */
  function setLedState(state) {
    if (!LED_PATTERNS[state]) return;
    _ledState = state;
    _ledFrame = 0;
    _ledAlpha = 1;
    _ledDir = 1;
    if (_ledTimer) { clearInterval(_ledTimer); _ledTimer = null; }
    _drawLed();

    const { anim } = LED_PATTERNS[state];
    if (anim === 'loop') {
      _ledTimer = setInterval(() => {
        _ledFrame = (_ledFrame + 1) % LED_PATTERNS[_ledState].frames.length;
        _drawLed();
      }, 160);
    } else if (anim === 'breathe') {
      _ledTimer = setInterval(() => {
        _ledAlpha += _ledDir * 0.06;
        if (_ledAlpha >= 1) { _ledAlpha = 1; _ledDir = -1; }
        if (_ledAlpha <= 0.2) { _ledAlpha = 0.2; _ledDir = 1; }
        _drawLed();
      }, 50);
    } else if (anim === 'blink') {
      let count = 0;
      _ledTimer = setInterval(() => {
        _ledAlpha = _ledAlpha > 0.5 ? 0 : 1;
        count++;
        _drawLed();
        if (count >= 6) { clearInterval(_ledTimer); _ledTimer = null; _ledAlpha = 1; _drawLed(); }
      }, 200);
    }
  }

  function _drawLed() {
    const canvas = document.getElementById('yt-sub-led');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const { frames, color } = LED_PATTERNS[_ledState];
    const frame = frames[_ledFrame % frames.length];

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (let col = 0; col < LED_COLS; col++) {
      for (let row = 0; row < LED_ROWS; row++) {
        const on = frame[row][col];
        const x = col * (LED_DOT + LED_GAP);
        const y = row * (LED_DOT + LED_GAP);
        ctx.beginPath();
        ctx.arc(x + LED_DOT / 2, y + LED_DOT / 2, LED_DOT / 2, 0, Math.PI * 2);
        ctx.fillStyle = on
          ? hexToRgba(color, _ledAlpha)
          : 'rgba(39,39,42,0.6)';  // 暗點（底色）
        ctx.fill();
      }
    }
  }

  function hexToRgba(hex, alpha) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }

  function updateTransProviderUI() {
    const batchRow = document.getElementById('yt-sub-batch-mode-row');
    if (batchRow) batchRow.style.display = settings.translationProvider === 'google' ? '' : 'none';
  }

  // sidebar wrapper 高度對齊影片播放器
  // 讓 sidebar 只覆蓋影片區域，標題和資訊欄在影片下方不受遮擋
  function syncWrapperToPlayer() {
    const wrapper = document.getElementById('yt-sub-wrapper');
    if (!wrapper) return;
    const player = document.querySelector('#movie_player') || document.querySelector('ytd-player');
    if (!player) return;

    // 第一次找到 player 時掛上 ResizeObserver
    // window resize 只在視窗縮放時觸發，無法捕捉 player 非同步渲染完成
    // 或劇院模式切換時的高度變化，因此需要直接觀察 player 元素本身
    if (!_playerRO) {
      _playerRO = new ResizeObserver(() => {
        const w = document.getElementById('yt-sub-wrapper');
        const p = document.querySelector('#movie_player') || document.querySelector('ytd-player');
        if (!w || !p) return;
        const r = p.getBoundingClientRect();
        if (r.height < 100) return;
        w.style.top = r.top + 'px';
        w.style.height = r.height + 'px';
      });
      _playerRO.observe(player);
    }

    const rect = player.getBoundingClientRect();
    if (rect.height < 100) return; // 播放器還沒渲染完，略過
    wrapper.style.top = rect.top + 'px';
    wrapper.style.height = rect.height + 'px';
  }

  // push 模式：sidebar 展開時縮排 YouTube 版面，讓影片與側邊欄並排不重疊
  // sidebar 現在只有影片高度，下方的標題 / 說明 / 留言不會被遮住，不需要 padding-left 補救
  function applyLayoutMode(mode) {
    const app = document.querySelector('ytd-app') || document.body;

    if (mode === 'push') {
      app.style.setProperty('margin-right', '360px', 'important');
    } else {
      app.style.removeProperty('margin-right');
    }
    syncWrapperToPlayer();
    window.dispatchEvent(new Event('resize'));
    updateOverlayRight();
  }

  function applyWordHoverStyle() {
    // sidebar 可能在 createSidebar 完成前就被呼叫，用 requestAnimationFrame 確保 DOM 已掛上
    requestAnimationFrame(() => {
      const sidebar = document.getElementById('yt-sub-demo-sidebar');
      if (!sidebar) return;
      sidebar.classList.toggle('word-hover-off', !settings.wordHover);
    });
  }

  function updateSecondaryRowOpacity() {
    const secRow = document.getElementById('yt-sub-secondary-row');
    if (secRow) secRow.style.opacity = settings.dualEnabled ? '1' : '0.4';
  }

  function setupSizeGroup(groupId, settingKey) {
    document.getElementById(groupId)?.addEventListener('click', e => {
      const btn = e.target.closest('button[data-val]');
      if (!btn) return;
      settings[settingKey] = btn.dataset.val;
      saveSettings();
      applyDisplaySettings();
      updateSizeGroupUI();
      renderSubtitleList(); // 重新渲染讓大小立即反映
    });
  }

  function setupSwatchGroup(groupId, settingKey) {
    document.getElementById(groupId)?.addEventListener('click', e => {
      const btn = e.target.closest('button[data-val]');
      if (!btn) return;
      settings[settingKey] = btn.dataset.val;
      saveSettings();
      applyDisplaySettings();
      updateSwatchGroupUI();
    });
  }

  function updateSizeGroupUI() {
    const ps = document.getElementById('yt-sub-primary-scale');
    const ss = document.getElementById('yt-sub-secondary-scale');
    if (ps) { ps.value = settings.primarySize || 100; document.getElementById('yt-sub-primary-scale-val').textContent = ps.value + '%'; }
    if (ss) { ss.value = settings.secondarySize || 100; document.getElementById('yt-sub-secondary-scale-val').textContent = ss.value + '%'; }
  }

  function updateSwatchGroupUI() {
    document.getElementById('yt-sub-color-group')?.querySelectorAll('button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.val === settings.secondaryColor);
    });
  }

  function applyDisplaySettings() {
    const sidebar = document.getElementById('yt-sub-demo-sidebar');
    if (!sidebar) return;
    const pScale = Number(settings.primarySize)   || 100;
    const sScale = Number(settings.secondarySize) || 100;
    sidebar.style.setProperty('--primary-fs',   `${Math.round(13 * pScale / 100)}px`);
    sidebar.style.setProperty('--secondary-fs', `${Math.round(12 * sScale / 100)}px`);
    sidebar.style.setProperty('--secondary-color', SECONDARY_COLORS[settings.secondaryColor] || '#a855f7');
    const overlay = document.getElementById('yt-sub-overlay');
    if (overlay) overlay.style.setProperty('--ov-secondary-color', SECONDARY_COLORS[settings.secondaryColor] || '#a855f7');
    applySubtitleSwap();
  }

  function applySubtitleSwap() {
    const swapped = !!settings.subtitleSwapped;
    document.getElementById('yt-sub-ov-body')?.classList.toggle('sub-swapped', swapped);
    document.getElementById('yt-sub-list')?.classList.toggle('sub-swapped', swapped);
  }

  // ===== 語言清單 =====
  // ===== Onboarding：語言初始設定 =====
  const ONBOARDING_LEARN_LANGS = [
    { code: 'en', label: '英文', native: 'English' },
    { code: 'ja', label: '日文', native: '日本語' },
    { code: 'ko', label: '韓文', native: '한국어' },
    { code: 'zh-Hans', label: '簡體中文', native: '简体' },
    { code: 'zh-TW', label: '繁體中文', native: '繁體' },
  ];

  // 母語選項與學習語言共用同一清單，顯示時自動排除已選的學習語言
  const ONBOARDING_NATIVE_LANGS = [
    { code: 'zh-TW', label: '繁體中文', native: '繁體' },
    { code: 'zh-Hans', label: '簡體中文', native: '简体' },
    { code: 'en', label: '英文', native: 'English' },
    { code: 'ja', label: '日文', native: '日本語' },
    { code: 'ko', label: '韓文', native: '한국어' },
  ];

  function showOnboarding() {
    const sidebar = document.getElementById('yt-sub-demo-sidebar');
    if (!sidebar) return;

    // 移除舊的（重新設定時可能已存在）
    document.getElementById('yt-sub-ob-overlay')?.remove();

    // 以 overlay 疊在 sidebar 上，不動 body/panel 的 DOM
    // 這樣 panel 元素始終存在，event listener 不受影響
    const overlay = document.createElement('div');
    overlay.id = 'yt-sub-ob-overlay';

    let step = 1;
    let learnLang = settings.primaryLang || 'en';
    let nativeLang = settings.secondaryLangs?.[0] || 'zh-TW';

    const CHECK_SVG = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none">
      <path d="M2 5l2.5 2.5L8 3" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;

    function langBtn(l, selectedCode) {
      const sel = l.code === selectedCode;
      return `<button class="yt-sub-ob-item${sel ? ' selected' : ''}" data-code="${l.code}">
        <span class="yt-sub-ob-check">${sel ? CHECK_SVG : ''}</span>
        <span class="yt-sub-ob-lang-label">${l.label}</span>
        <span class="yt-sub-ob-lang-native">${l.native}</span>
      </button>`;
    }

    function render() {
      overlay.innerHTML = `
        <div class="yt-sub-onboarding">
          <div class="yt-sub-ob-topbar">
            <div class="yt-sub-ob-step-meta">
              <span class="yt-sub-ob-step-label">STEP ${step} / 2</span>
              <div class="yt-sub-ob-dots">
                <span class="yt-sub-ob-dot ${step >= 1 ? 'active' : ''}"></span>
                <span class="yt-sub-ob-dot ${step >= 2 ? 'active' : ''}"></span>
              </div>
            </div>
            <div class="yt-sub-ob-progress-track">
              <div class="yt-sub-ob-progress-fill" style="width:${step * 50}%"></div>
            </div>
          </div>
          <div class="yt-sub-ob-content">
            <div class="yt-sub-ob-title">${step === 1 ? '你在學哪個語言？' : '你的母語是？'}</div>
            <div class="yt-sub-ob-subtitle">${step === 1 ? '字幕會優先顯示這個語言，找不到時自動翻譯' : '用來顯示對照翻譯的副字幕'}</div>
            <div class="yt-sub-ob-list">
              ${step === 1
          ? ONBOARDING_LEARN_LANGS.map(l => langBtn(l, learnLang)).join('')
          : ONBOARDING_NATIVE_LANGS.filter(l => l.code !== learnLang).map(l => langBtn(l, nativeLang)).join('')
        }
            </div>
          </div>
          <div class="yt-sub-ob-footer">
            ${step === 1
          ? `<button class="yt-sub-ob-btn-primary" id="yt-sub-ob-next">下一步</button>`
          : `<button class="yt-sub-ob-btn-secondary" id="yt-sub-ob-back">上一步</button>
                 <button class="yt-sub-ob-btn-primary" id="yt-sub-ob-done">完成設定</button>`
        }
          </div>
        </div>
      `;

      // 語言選項點擊
      overlay.querySelectorAll('.yt-sub-ob-item').forEach(btn => {
        btn.addEventListener('click', () => {
          overlay.querySelectorAll('.yt-sub-ob-item').forEach(b => {
            b.classList.remove('selected');
            b.querySelector('.yt-sub-ob-check').innerHTML = '';
          });
          btn.classList.add('selected');
          btn.querySelector('.yt-sub-ob-check').innerHTML = CHECK_SVG;
          if (step === 1) learnLang = btn.dataset.code;
          else nativeLang = btn.dataset.code;
        });
      });

      if (step === 1) {
        overlay.querySelector('#yt-sub-ob-next')?.addEventListener('click', () => {
          if (nativeLang === learnLang) {
            nativeLang = ONBOARDING_NATIVE_LANGS.find(l => l.code !== learnLang)?.code || 'zh-TW';
          }
          step = 2; render();
        });
      } else {
        overlay.querySelector('#yt-sub-ob-back')?.addEventListener('click', () => { step = 1; render(); });
        overlay.querySelector('#yt-sub-ob-done')?.addEventListener('click', () => {
          settings.primaryLang = learnLang;
          settings.primaryVssId = null;
          settings.secondaryLangs = [nativeLang, '__none__', '__none__'];
          settings.dualEnabled = true;
          settings.onboardingDone = true;
          saveSettings();
          // 移除 overlay，panel 仍完整存在
          overlay.remove();
          // 更新設定頁語言偏好顯示
          const _dispEl = document.getElementById('yt-sub-primary-lang-display');
          if (_dispEl) {
            const _m = ONBOARDING_LEARN_LANGS.find(l => l.code === learnLang);
            _dispEl.textContent = _m ? _m.label : learnLang;
          }
          // 重新觸發字幕載入
          window.postMessage({ type: 'YT_SUBTITLE_DEMO_REQUEST' }, '*');
        });
      }
    }

    render();
    sidebar.appendChild(overlay);
  }

  function renderLanguages(tracks) {
    trackList = tracks || [];
    const container = document.getElementById('yt-sub-langs');
    const status = document.getElementById('yt-sub-status');

    // Onboarding 正在顯示時 DOM 結構不存在，略過渲染（onboarding 完成後會重新 REQUEST）
    if (!container || !status) return;

    // 新影片時，從已儲存設定還原語言偏好（per-video 切換不會污染全域 settings）
    const _saved = loadSettings();
    settings.primaryLang = _saved.primaryLang;
    settings.primaryVssId = _saved.primaryVssId;
    settings.secondaryLangs = [..._saved.secondaryLangs];

    if (!trackList.length) {
      fetchCommunitySubtitles();
      if (!customSubtitleActive) {
        _restoreSavedSubtitle(() => {
          status.textContent = '此影片沒有可用字幕';
          status.className = 'yt-sub-status error';
          container.innerHTML = '';
          collapseSidebar('no-sub');
        });
      }
      return;
    }

    // 有字幕：確保 sidebar 展開，更新 LED 為 loading（字幕選擇/翻譯尚未完成）
    setLedState('loading');
    expandSidebar();

    // ASR tracks 處理：只顯示使用者選定語言的那一條
    const asrTracks = trackList.filter(t => (t.vssId || '').startsWith('a.'));
    const preferredAsr = asrTracks.find(t => t.languageCode === settings.asrLang) || asrTracks[0] || null;
    // 若只找到 ASR tracks（沒有匹配），更新 asrLang 為實際選到的
    if (preferredAsr && preferredAsr.languageCode !== settings.asrLang && !asrTracks.find(t => t.languageCode === settings.asrLang)) {
      settings.asrLang = preferredAsr.languageCode;
    }
    // primaryVssId 若在此影片找不到對應 track（換影片後 stale），清掉讓 primaryLang fallback 接手
    if (settings.primaryVssId && !trackList.find(t => t.vssId === settings.primaryVssId)) {
      settings.primaryVssId = null;
    }

    // 過濾後顯示：手動 tracks 全部保留，ASR 只保留一條
    const displayTracks = trackList.filter(t =>
      !(t.vssId || '').startsWith('a.') || t === preferredAsr
    );

    fillAsrSelect(asrTracks);

    if (!customSubtitleActive) {
      status.textContent = `找到 ${trackList.length} 個字幕語言`;
      status.className = 'yt-sub-status success';
    }

    container.innerHTML = '<span class="yt-sub-section-title">字幕語言：</span>';
    const langDropdown = document.createElement('select');
    langDropdown.id = 'yt-sub-lang-dropdown';
    langDropdown.className = 'yt-sub-lang-select';
    displayTracks.forEach(track => {
      const opt = document.createElement('option');
      opt.value = track.vssId || track.languageCode;
      opt.textContent = track.name + (track.kind === 'asr' ? ' (自動)' : '');
      const matched = settings.primaryVssId
        ? opt.value === settings.primaryVssId
        : track.languageCode === settings.primaryLang;
      if (matched) opt.selected = true;
      langDropdown.appendChild(opt);
    });
    // 若設定語言在此影片中找不到，只在 ASR 語系相同時才用 ASR 作主字幕
    // 語系不符則 primaryOverride 維持 null，不強制翻譯
    const anyMatched = displayTracks.some(t =>
      settings.primaryVssId
        ? (t.vssId || t.languageCode) === settings.primaryVssId
        : t.languageCode === settings.primaryLang
    );
    langDropdown.addEventListener('change', function () {
      const vssId = this.value;
      const track = displayTracks.find(t => (t.vssId || t.languageCode) === vssId);
      if (!track) return;
      // 此影片有偏好語言時，使用者切換才視為全域偏好更新並立即持久化
      // anyMatched=false 表示此影片根本沒有偏好語言，切換只是臨時覆蓋，不污染全域設定
      if (anyMatched) {
        settings.primaryLang = track.languageCode;
        settings.primaryVssId = track.vssId || null;
        saveSettings();
      }
      customSubtitleActive = false;
      primarySubtitles = []; _rawPrimarySubtitles = [];
      secondarySubtitles = [];
      autoLoadSubtitles(trackList);
    });
    let primaryOverride = null;
    if (!anyMatched) {
      // 檢查目前選中的 ASR track 語系是否與偏好相同（含 fuzzy match）
      const asrSameLang = preferredAsr && findTrackByLang([preferredAsr], settings.primaryLang)
        ? preferredAsr : null;
      if (asrSameLang) {
        primaryOverride = asrSameLang;
        // 選中下拉選單中對應的 option
        const asrOpt = Array.from(langDropdown.options)
          .find(o => o.value === (asrSameLang.vssId || asrSameLang.languageCode));
        if (asrOpt) asrOpt.selected = true;
      }
      // 若無同語系 ASR，primaryOverride 維持 null → 不載入主字幕
    }

    container.appendChild(langDropdown);

    // 套用按鈕：強制重新載入當前選取的主字幕（含副字幕）
    const applyLangBtn = document.createElement('button');
    applyLangBtn.className = 'yt-sub-lang-apply-btn';
    applyLangBtn.textContent = '套用';
    applyLangBtn.addEventListener('click', () => {
      const vssId = langDropdown.value;
      const track = displayTracks.find(t => (t.vssId || t.languageCode) === vssId);
      if (!track) return;
      // 按鈕點擊是明確的使用者意圖，無論影片是否有偏好語言都更新全域設定
      settings.primaryLang = track.languageCode;
      settings.primaryVssId = track.vssId || null;
      saveSettings();
      customSubtitleActive = false;
      primarySubtitles = []; _rawPrimarySubtitles = [];
      loadSubtitle(track, 'primary');
    });
    container.appendChild(applyLangBtn);

    refreshSecondarySelects();
    highlightActiveLangs();
    autoLoadSubtitles(trackList, primaryOverride);
    // 查詢社群字幕數量（獨立於 YT 字幕資料，不受 customSubtitleActive 影響）
    fetchCommunitySubtitles();
    // 嘗試還原上次使用的自定義/社群字幕（不依賴 YT 字幕資料回傳）
    if (!customSubtitleActive) _restoreSavedSubtitle();
  }

  function fillAsrSelect(asrTracks) {
    const row = document.getElementById('yt-sub-asr-row');
    const sel = document.getElementById('yt-sub-asr-select');
    if (!row || !sel) return;
    // 只有多條 ASR 才顯示選項（只有一條不需要選）
    if (asrTracks.length < 2) { row.style.display = 'none'; return; }
    row.style.display = 'flex';
    sel.innerHTML = '';
    asrTracks.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.languageCode;
      opt.textContent = t.name;
      if (t.languageCode === settings.asrLang) opt.selected = true;
      sel.appendChild(opt);
    });
  }

  function fillLangSelect(selectId, tracks, selected, allowNone) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    sel.innerHTML = '';

    if (!allowNone) {
      // 主字幕選單：用 vssId 作為 value，才能區分手動/ASR 同語言的 track
      const grp = document.createElement('optgroup');
      grp.label = '字幕語言';
      tracks.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.vssId || t.languageCode;   // 用 vssId 作 key
        opt.textContent = t.name + (t.kind === 'asr' ? ' (自動)' : '');
        if ((t.vssId || t.languageCode) === selected) opt.selected = true;
        grp.appendChild(opt);
      });
      sel.appendChild(grp);
    } else {
      // 副字幕選單：固定語系清單，不依影片而變
      const noneOpt = document.createElement('option');
      noneOpt.value = '__none__';
      noneOpt.textContent = '（不顯示副字幕）';
      if (selected === '__none__') noneOpt.selected = true;
      sel.appendChild(noneOpt);

      SECONDARY_LANG_OPTIONS.forEach(t => {
        const opt = document.createElement('option');
        opt.value = t.languageCode;
        opt.textContent = t.name;
        if (t.languageCode === selected) opt.selected = true;
        sel.appendChild(opt);
      });
    }
  }

  function refreshSecondarySelects() {
    const sel = document.getElementById('yt-sub-secondary-select-0');
    if (!sel) return;
    const current = settings.secondaryLangs[0] ?? '__none__';
    sel.innerHTML = '';

    const noneOpt = document.createElement('option');
    noneOpt.value = '__none__';
    noneOpt.textContent = '（不顯示副字幕）';
    if (current === '__none__') noneOpt.selected = true;
    sel.appendChild(noneOpt);

    // 一般語系（有原生用原生，沒有才翻譯）
    const grp1 = document.createElement('optgroup');
    grp1.label = '原生優先';
    SECONDARY_LANG_OPTIONS.forEach(t => {
      const opt = document.createElement('option');
      opt.value = t.languageCode;
      opt.textContent = t.name;
      if (t.languageCode === current) opt.selected = true;
      grp1.appendChild(opt);
    });
    sel.appendChild(grp1);

    // 強制自動翻譯
    const grp2 = document.createElement('optgroup');
    grp2.label = '自動翻譯';
    SECONDARY_LANG_OPTIONS.forEach(t => {
      const val = 'tlang:' + t.languageCode;
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = t.name + '（翻譯）';
      if (val === current) opt.selected = true;
      grp2.appendChild(opt);
    });
    sel.appendChild(grp2);
  }

  function highlightActiveLangs() {
    const dropdown = document.getElementById('yt-sub-lang-dropdown');
    if (!dropdown) return;
    const found = settings.primaryVssId
      ? Array.from(dropdown.options).find(o => o.value === settings.primaryVssId)
      : Array.from(dropdown.options).find(o => {
        const t = trackList.find(tk => (tk.vssId || tk.languageCode) === o.value);
        return t?.languageCode === settings.primaryLang;
      });
    if (found) dropdown.value = found.value;
  }

  // 語言代碼 fuzzy match：zh-TW 能匹配 zh-Hant、zh；ja 能匹配 ja-JP 等
  const LANG_ALIASES = {
    'zh-TW': ['zh-TW', 'zh-Hant', 'zh'],
    'zh-Hans': ['zh-Hans', 'zh-CN', 'zh-SG'],
    'pt': ['pt', 'pt-BR', 'pt-PT'],
    'es': ['es', 'es-419', 'es-US', 'es-MX'],
  };

  function findTrackByLang(tracks, lang) {
    const aliases = LANG_ALIASES[lang] || [lang];
    for (const code of aliases) {
      const t = tracks.find(tr => tr.languageCode === code);
      if (t) return t;
    }
    // prefix match：zh-TW 也能匹配 zh-whatever
    const base = lang.split('-')[0];
    return tracks.find(tr => tr.languageCode === base || tr.languageCode.startsWith(base + '-')) || null;
  }

  // ===== 自動載入主、副字幕 =====
  // primaryOverride：ASR 同語系 fallback（不翻譯），不修改 settings
  function autoLoadSubtitles(tracks, primaryOverride = null) {
    if (!tracks.length) return;
    // 只接受偏好語言的原生 track 或同語系 ASR，不走翻譯/tlang
    const primary = primaryOverride || findPrimaryTrack(tracks);
    if (primary) {
      loadSubtitle(primary, 'primary');
    } else {
      // 此影片無偏好語言字幕，停止，不強制翻譯
      const statusEl = document.getElementById('yt-sub-status');
      if (statusEl) {
        statusEl.textContent = `此影片無 ${settings.primaryLang} 字幕`;
        statusEl.className = 'yt-sub-status';
      }
    }

    pendingTranslation = null;
    if (settings.dualEnabled) {
      const priorities = (settings.secondaryLangs || []).filter(l => l && l !== '__none__');
      const base = tracks.find(t => (t.vssId || '').startsWith('a.')) || tracks[0];
      let loaded = false;
      console.log('[YT-SUB][DUAL] dualEnabled, priorities=', priorities, 'provider=', settings.translationProvider);

      for (const entry of priorities) {
        const isForcedTranslation = entry.startsWith('tlang:');
        const lang = isForcedTranslation ? entry.slice(6) : entry;

        // 原生 track 不需要翻譯，無論哪種 provider 都直接載
        if (!isForcedTranslation) {
          const native = findTrackByLang(tracks, lang);
          console.log('[YT-SUB][DUAL] lang=', lang, 'native=', native?.languageCode || null);
          if (native) { loadSubtitle(native, 'secondary'); loaded = true; break; }
        }

        // 需要翻譯：未登入 guest 不允許
        if (_userTier === 'guest') {
          _showTranslationGate();
          loaded = true;
          break;
        }

        // 需要翻譯：依 provider 決定走 ytlang 或外部
        if (settings.translationProvider === 'ytlang') {
          console.log('[YT-SUB][DUAL] ytlang path, base=', base?.languageCode || null);
          if (base) { loadSubtitle(base, 'secondary', lang); loaded = true; break; }
        } else {
          // 外部翻譯：等 primary 載完後才翻
          console.log('[YT-SUB][DUAL] google path, primaryLen=', primarySubtitles.length, '→ pendingTranslation=', lang);
          pendingTranslation = { targetLang: lang };
          loaded = true;
          if (primarySubtitles.length) {
            console.log('[YT-SUB][DUAL] primary already loaded, translateAndSetSecondary immediately');
            translateAndSetSecondary(primarySubtitles, lang);
            pendingTranslation = null;
          }
          break;
        }
      }

      if (!loaded && priorities.length > 0) {
        if (_userTier === 'guest') { _showTranslationGate(); }
        else {
          const lang = priorities[0].startsWith('tlang:') ? priorities[0].slice(6) : priorities[0];
          if (settings.translationProvider === 'ytlang') {
            if (base) loadSubtitle(base, 'secondary', lang);
          } else {
            pendingTranslation = { targetLang: lang };
            if (primarySubtitles.length) {
              translateAndSetSecondary(primarySubtitles, lang);
              pendingTranslation = null;
            }
          }
        }
      }
    }
  }

  // 找主字幕 track：優先用 vssId 精確比對；其次偏好手動 track（non-ASR）
  function findPrimaryTrack(tracks) {
    if (settings.primaryVssId) {
      const byVssId = tracks.find(t => t.vssId === settings.primaryVssId);
      if (byVssId) return byVssId;
    }
    // 同語言中優先手動，次選 ASR（支援 fuzzy match）
    const byLang = findTrackByLang(tracks, settings.primaryLang);
    if (byLang && (byLang.vssId || '').startsWith('a.')) {
      // 有 ASR，看看有沒有同語系的手動
      const manualAlias = (LANG_ALIASES[settings.primaryLang] || [settings.primaryLang]);
      const manual = tracks.find(t => manualAlias.includes(t.languageCode) && !(t.vssId || '').startsWith('a.'));
      return manual || byLang;
    }
    return byLang || null;
  }

  function loadSubtitle(track, tag = 'primary', langOverride = null) {
    const langCode = langOverride || track.languageCode;
    if (tag === 'primary' && !customSubtitleActive) {
      const statusEl = document.getElementById('yt-sub-status');
      if (statusEl) { statusEl.textContent = `載入主字幕（${track.name}）...`; statusEl.className = 'yt-sub-status'; }
    }
    window.postMessage({ type: 'YT_SUBTITLE_DEMO_FETCH', baseUrl: track.baseUrl, languageCode: langCode, tag }, '*');
  }

  // ===== 解析 JSON3 =====
  function parseJson3(json) {
    if (!json?.events) return [];
    return json.events
      .filter(e => e.segs?.length > 0)
      .map(e => ({
        startTime: (e.tStartMs || 0) / 1000,
        duration: (e.dDurationMs || 2000) / 1000,
        text: e.segs.map(s => s.utf8 || '').join('').trim(),
      }))
      .filter(s => s.text.length > 0);
  }

  // ===== 渲染字幕清單 =====
  function renderSubtitleList() {
    const listEl = document.getElementById('yt-sub-list');
    if (!listEl) return;
    refreshSavedWordSet(); // 確保生字本 Set 是最新狀態
    listEl.innerHTML = '';

    // hover 時凍結高亮捲動，讓使用者有時間右鍵 / 點擊單字
    listEl.onmouseenter = () => { _listHovering = true; };
    listEl.onmouseleave = () => { _listHovering = false; };
    // 右鍵 delegation 由 initWindowContextMenu() 在 window 層統一處理，此處不再重複綁定

    primarySubtitles.forEach((sub, index) => {
      const item = document.createElement('div');
      item.className = 'yt-sub-item';
      item.dataset.index = index;

      const secSub = findSecondaryForPrimary(secondarySubtitles, sub);

      const timeSpan = document.createElement('span');
      timeSpan.className = 'yt-sub-time';
      timeSpan.textContent = formatTime(sub.startTime);
      if (settings.clickToSeek) {
        timeSpan.style.cursor = 'pointer';
        timeSpan.addEventListener('click', e => { e.stopPropagation(); seekTo(sub.startTime); });
      }

      const texts = document.createElement('div');
      texts.className = 'yt-sub-texts';

      const primEl = document.createElement('div');
      primEl.className = 'yt-sub-text-primary';
      buildTokenizedText(primEl, filterSubText(sub.text), sub.startTime);
      texts.appendChild(primEl);

      if (settings.dualEnabled && secSub) {
        const secEl = document.createElement('div');
        secEl.className = 'yt-sub-text-secondary';
        secEl.textContent = filterSubText(secSub.text);
        texts.appendChild(secEl);
      }

      // 點擊字幕文字區 → 跳轉 + 切換循環；點單字不觸發（stopPropagation 在 buildTokenizedText 裡）
      texts.addEventListener('click', e => {
        if (e.target.closest('.yt-sub-word')) return;
        if (loopingIdx >= 0) {
          console.log('[YT-SUB][LOOP] subtitle-list item click → cancel');
          loopingIdx = -1;
        } else {
          console.log('[YT-SUB][LOOP] subtitle-list item click → set idx=', index, sub.text);
          seekTo(sub.startTime);
          loopingIdx = index;
        }
        updateCurrentLoopStyle();
      });

      item.appendChild(timeSpan);
      item.appendChild(texts);
      listEl.appendChild(item);
    });
    // 渲染後套用上下顛倒狀態
    listEl.classList.toggle('sub-swapped', !!settings.subtitleSwapped);
  }

  function findSubAtTime(subs, time) {
    return subs.find(s => time >= s.startTime && time < s.startTime + s.duration) || null;
  }

  // 為 primary 字幕找對應的 secondary：先用時間重疊比對，fallback 用最近 startTime（容差 2 秒）
  function findSecondaryForPrimary(secondarySubs, primarySub) {
    const midTime = primarySub.startTime + 0.1;
    const byTime = findSubAtTime(secondarySubs, midTime);
    if (byTime) return byTime;
    // 時間比對失敗（duration 極短或 timing 偏移）→ 找 startTime 最接近的 secondary
    let best = null;
    let bestDist = 2; // 容差 2 秒
    for (const s of secondarySubs) {
      const dist = Math.abs(s.startTime - primarySub.startTime);
      if (dist < bestDist) { bestDist = dist; best = s; }
    }
    return best;
  }

  // ytlang 翻譯檔會跳過重複歌詞/台詞，補上缺少翻譯的 primary subtitle
  // 做法：建立「原文 → 第一個翻譯」映射，再填補沒有時間對應的 primary
  function fillMissingSecondary() {
    if (!primarySubtitles.length || !secondarySubtitles.length) return;

    // 第一步：收集所有已有的 primaryText → secondaryText 對應
    const textMap = new Map();
    primarySubtitles.forEach(prim => {
      const sec = findSecondaryForPrimary(secondarySubtitles, prim);
      if (sec) {
        const key = prim.text.trim().toLowerCase();
        if (!textMap.has(key)) textMap.set(key, sec.text);
      }
    });

    // 第二步：對沒有對應翻譯的 primary，用同文字的譯文補上
    const toAdd = [];
    primarySubtitles.forEach(prim => {
      if (!findSecondaryForPrimary(secondarySubtitles, prim)) {
        const translated = textMap.get(prim.text.trim().toLowerCase());
        if (translated) {
          // duration 至少 1 秒，確保 findSubAtTime 能以 midTime = startTime + 0.1 命中
          toAdd.push({ startTime: prim.startTime, duration: Math.max(prim.duration, 1), text: translated });
        }
      }
    });
    if (toAdd.length) secondarySubtitles.push(...toAdd);
  }

  // ===== 單字查詢浮窗 =====
  const dictCache = {};  // word → result (max 200 entries)
  const DICT_CACHE_MAX = 200;

  // 將彈窗定位在錨點正上方，以 bottom 貼齊錨點上緣往上撐開，確保不遮句子與單字
  // 上方空間不足（< 280px）時改為正下方，以 top 貼齊錨點下緣往下撐開
  function _positionPopupNearAnchor(popup, anchor) {
    const MARGIN = 8;
    const GAP = 6;
    const POPUP_W = 420;
    const ASSUMED_H = 280; // 用於判斷上方是否有足夠空間，不影響實際高度
    const rect = anchor.getBoundingClientRect();
    // 水平：置中對齊錨點，做邊界保護
    let left = rect.left + rect.width / 2 - POPUP_W / 2;
    left = Math.max(MARGIN, Math.min(left, window.innerWidth - POPUP_W - MARGIN));
    popup.style.left  = left + 'px';
    popup.style.right = 'auto';
    if (rect.top - GAP - ASSUMED_H >= MARGIN) {
      // 上方空間足夠：bottom 貼在錨點上緣，彈窗往上撐，永遠不蓋住單字與句子
      popup.style.top    = 'auto';
      popup.style.bottom = (window.innerHeight - rect.top + GAP) + 'px';
    } else {
      // 上方空間不足：top 貼在錨點下緣，彈窗往下撐
      popup.style.top    = (rect.bottom + GAP) + 'px';
      popup.style.bottom = 'auto';
    }
  }

  function showWordPopup(word, anchor, sentenceData = null) {
    let popup = document.getElementById('yt-sub-word-popup');
    if (!popup) {
      popup = document.createElement('div');
      popup.id = 'yt-sub-word-popup';
      document.body.appendChild(popup);
    }

    popup.style.display = 'block';
    // 定位：錨點正上方，空間不足則改正下方，水平置中後做邊界保護
    _positionPopupNearAnchor(popup, anchor);
    popup.innerHTML = `<div class="yt-sub-popup-loading">查詢「${word}」中...</div>`;

    // 點其他地方關閉
    const close = e => { if (!popup.contains(e.target) && e.target !== anchor) { popup.style.display = 'none'; window.removeEventListener('click', close, true); } };
    setTimeout(() => window.addEventListener('click', close, true), 50);

    popup.dataset.word = word;
    popup._sentenceData = (sentenceData?.context) ? sentenceData : null;
    const originalToken = sentenceData?._originalToken || word;
    lookupWord(word).then(async result => {
      if (popup.style.display === 'none' || popup.dataset.word !== word) return;

      // 還原詞查不到時，用點擊的原始詞再查一次
      if (!result && originalToken !== word) {
        popup.innerHTML = `<div class="yt-sub-popup-loading">查詢「${originalToken}」中...</div>`;
        result = await lookupWord(originalToken);
        if (popup.style.display === 'none' || popup.dataset.word !== word) return;
      }

      if (!result) {
        popup.innerHTML = `<div class="yt-sub-popup-error">找不到「${word}」的定義</div>`;
      } else {
        renderPopupContent(popup, result);
      }
      if (sentenceData?.context) appendSentenceSection(popup, word, sentenceData);
    });
  }

  // 在 popup 底部附加例句區塊
  function appendSentenceSection(popup, word, item) {
    const currentVideoId = new URLSearchParams(location.search).get('v') || '';
    const isSameVideo = item.videoId && item.videoId === currentVideoId;
    const timeLabel = formatTime(item.startTime || 0);

    const safeWord = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const highlighted = escapeHtml(item.context).replace(
      new RegExp(`(${safeWord})`, 'gi'),
      '<mark class="yt-sub-sent-mark">$1</mark>'
    );

    const section = document.createElement('div');
    section.className = 'yt-sub-popup-sentence';
    section.innerHTML = `
      <div class="yt-sub-popup-sent-en">${highlighted}</div>
      ${item.contextZh ? `<div class="yt-sub-popup-sent-zh">${escapeHtml(item.contextZh)}</div>` : ''}
      <button class="yt-sub-popup-sent-seek" title="${isSameVideo ? '跳轉到此句' : '在 YouTube 開啟'}">
        ${isSameVideo ? '▶' : '↗'} ${timeLabel}
      </button>
    `;
    section.querySelector('.yt-sub-popup-sent-seek').addEventListener('click', e => {
      e.stopPropagation();
      if (isSameVideo) {
        seekTo(item.startTime || 0);
      } else {
        window.open(`https://www.youtube.com/watch?v=${item.videoId}&t=${Math.floor(item.startTime || 0)}s`, '_blank');
      }
      popup.style.display = 'none';
    });
    popup.appendChild(section);
  }

  // 詞頻分級對應顯示文字
  const TIER_LABEL = { basic: '基礎', common: '常用', advanced: '進階' };
  const TIER_CLASS = { basic: 'tier-basic', common: 'tier-common', advanced: 'tier-advanced' };

  function renderPopupContent(popup, result) {
    const zhLoading = result.translating ? `<span class="yt-sub-popup-translating">翻譯中...</span>` : '';
    const tierHtml = result.tier && TIER_CLASS[result.tier]
      ? `<span class="yt-sub-tier-badge ${TIER_CLASS[result.tier]}">${TIER_LABEL[result.tier]}</span>`
      : '';
    const synHtml = result.synonyms.length
      ? `<div class="yt-sub-popup-section-title">近似詞</div>
         <div class="yt-sub-popup-synonyms">${result.synonyms.map(s =>
        `<span class="yt-sub-popup-syn"><span class="yt-sub-popup-syn-en">${escapeHtml(s.en)}</span>${s.zh ? `<span class="yt-sub-popup-syn-zh">${escapeHtml(s.zh)}</span>` : (result.translating ? '<span class="yt-sub-popup-syn-zh">...</span>' : '')}</span>`
      ).join('')}</div>`
      : '';
    const wordZhHtml = result.wordZh
      ? `<div class="yt-sub-popup-word-zh">${escapeHtml(result.wordZh)}</div>`
      : (result.translating ? `<div class="yt-sub-popup-word-zh yt-sub-popup-translating">...</div>` : '');
    const wordKey = result.word.toLowerCase();
    const alreadySaved = _savedWordSet.has(wordKey);
    const alreadyLearned = _learnedWordSet.has(wordKey);
    popup.innerHTML = `
      <div class="yt-sub-popup-word">${escapeHtml(result.word)}
        ${result.phonetic ? `<span class="yt-sub-popup-phonetic">${escapeHtml(result.phonetic)}</span>` : ''}
        ${tierHtml}
      </div>
      ${wordZhHtml}
      ${result.partOfSpeech ? `<div class="yt-sub-popup-pos">${result.partOfSpeech}</div>` : ''}
      <div class="yt-sub-popup-def">• ${escapeHtml(result.definition)}</div>
      ${result.definitionZh ? `<div class="yt-sub-popup-def-zh">${escapeHtml(result.definitionZh)}</div>` : zhLoading}
      ${result.example ? `<div class="yt-sub-popup-example">${escapeHtml(result.example)}</div>` : ''}
      ${synHtml}
      <div class="yt-sub-popup-action-row">
        <button class="yt-sub-popup-save-btn${alreadySaved ? ' saved' : ''}" data-word="${escapeHtml(wordKey)}">
          ${alreadySaved ? '✓ 已在生字本' : '＋ 加入生字本'}
        </button>
        ${alreadySaved ? `<button class="yt-sub-popup-learn-btn${alreadyLearned ? ' active' : ''}" data-word="${escapeHtml(wordKey)}">
          ${alreadyLearned ? '✓ 已學會' : '已學會'}
        </button>` : ''}
      </div>
    `;
    // 綁定加入生字本按鈕
    popup.querySelector('.yt-sub-popup-save-btn').addEventListener('click', e => {
      e.stopPropagation();
      if (e.currentTarget.classList.contains('saved')) return;
      const w = e.currentTarget.dataset.word;
      const sentenceData = popup._sentenceData;
      saveWord(w, null, sentenceData?.context || '', sentenceData?.startTime || 0);
      e.currentTarget.textContent = '✓ 已在生字本';
      e.currentTarget.classList.add('saved');
      // 存入後動態插入已學會按鈕
      if (!popup.querySelector('.yt-sub-popup-learn-btn')) {
        const lb = document.createElement('button');
        lb.className = 'yt-sub-popup-learn-btn';
        lb.dataset.word = w.toLowerCase();
        lb.textContent = '已學會';
        lb.addEventListener('click', _popupLearnBtnHandler);
        e.currentTarget.parentElement.appendChild(lb);
      }
    });
    // 綁定已學會按鈕（若存在）
    const learnBtn = popup.querySelector('.yt-sub-popup-learn-btn');
    if (learnBtn) learnBtn.addEventListener('click', _popupLearnBtnHandler);
  }

  // popup 已學會按鈕的 handler（獨立函式供動態插入時重用）
  function _popupLearnBtnHandler(e) {
    e.stopPropagation();
    const btn = e.currentTarget;
    const w = btn.dataset.word;
    // 借用 toggleLearnedStatus，傳入 null 的 rowEl/mainEl（不影響 wordbook 列表）
    chrome.storage.local.get(SAVED_WORDS_KEY, data => {
      const saved = data[SAVED_WORDS_KEY] || {};
      if (!saved[w] || saved[w].deletedAt) return;
      const nowLearned = saved[w].status !== 'learned';
      if (nowLearned) saved[w].status = 'learned';
      else delete saved[w].status;
      chrome.storage.local.set({ [SAVED_WORDS_KEY]: saved }, () => {
        if (nowLearned) _learnedWordSet.add(w);
        else _learnedWordSet.delete(w);
        btn.textContent = nowLearned ? '✓ 已學會' : '已學會';
        btn.classList.toggle('active', nowLearned);
        // 若生字本面板開著，同步重繪對應的 row
        const listEl = document.getElementById('yt-sub-wordbook-list');
        if (listEl) {
          const row = listEl.querySelector(`.yt-sub-wb-del[data-word="${CSS.escape(w)}"]`)?.closest('.yt-sub-wb-row');
          if (row) {
            row.classList.toggle('learned', nowLearned);
            const learnRowBtn = row.querySelector('.yt-sub-wb-learned-btn');
            if (learnRowBtn) { learnRowBtn.textContent = nowLearned ? '✓ 已學會' : '標記為已學會'; learnRowBtn.classList.toggle('active', nowLearned); }
            const badge = row.querySelector('.yt-sub-wb-learned-badge');
            if (nowLearned && !badge) {
              const b = document.createElement('span');
              b.className = 'yt-sub-wb-learned-badge';
              b.textContent = '✓ 已學會';
              const mainEl = row.querySelector('.yt-sub-wb-row-main');
              const countEl = mainEl?.querySelector('.yt-sub-wb-meta');
              const delBtn = mainEl?.querySelector('.yt-sub-wb-del');
              mainEl?.insertBefore(b, countEl || delBtn);
            } else if (!nowLearned && badge) { badge.remove(); }
          }
        }
      });
    });
  }

  // 停止生字本展開重複句 loop
  function _stopWbExpandLoop() {
    clearInterval(_wbExpandLoopTimer);
    clearTimeout(_wbExpandLoopTimer);
    _wbExpandLoopTimer = null;
    _wbExpandLoopMode  = null;
    window.speechSynthesis?.cancel();
  }

  // 啟動生字本展開重複句 loop
  // 當前影片：seek 到句子起點重播，間隔 = 句子長度 + 3 秒
  // 非當前影片：暫停影片，用 TTS 朗讀整句，間隔 3 秒後再朗讀
  function _startWbExpandLoop(item) {
    _stopWbExpandLoop();
    const currentVideoId = new URLSearchParams(location.search).get('v') || '';
    const isSameVideo = !!(item.videoId && item.videoId === currentVideoId && item.startTime != null);
    _wbExpandLoopMode = isSameVideo ? 'video' : 'tts';

    if (isSameVideo) {
      const sub = primarySubtitles.find(s => Math.abs(s.startTime - item.startTime) < 0.1);
      const cycleDuration = ((sub?.duration || 4) + 3) * 1000;
      seekTo(item.startTime);
      const video = document.querySelector('video');
      if (video?.paused) video.play().catch(() => {});
      _wbExpandLoopTimer = setInterval(() => {
        seekTo(item.startTime);
        const v = document.querySelector('video');
        if (v?.paused) v.play().catch(() => {});
      }, cycleDuration);
    } else {
      // 非當前影片：暫停後用 TTS 遞迴朗讀
      const video = document.querySelector('video');
      if (video && !video.paused) video.pause();
      const scheduleTts = () => {
        if (_wbExpandLoopMode !== 'tts') return;
        const utter = new SpeechSynthesisUtterance(item.context || item.word);
        utter.lang = 'en-US';
        utter.rate = 0.85;
        utter.onend = () => {
          if (_wbExpandLoopMode !== 'tts') return;
          _wbExpandLoopTimer = setTimeout(scheduleTts, 3000);
        };
        window.speechSynthesis?.cancel();
        window.speechSynthesis?.speak(utter);
      };
      scheduleTts();
    }
  }

  function speakWord(word) {
    if (!window.speechSynthesis) return;
    window.speechSynthesis.cancel();
    const utter = new SpeechSynthesisUtterance(word);
    utter.lang = 'en-US';
    utter.rate = 0.9;
    window.speechSynthesis.speak(utter);
  }

  function dictCacheSet(word, value) {
    const keys = Object.keys(dictCache);
    if (keys.length >= DICT_CACHE_MAX) delete dictCache[keys[0]];
    dictCache[word] = value;
  }

  // 透過 Datamuse API 取得單字詞頻分級
  // 回傳 'basic'（基礎）| 'common'（常用）| 'advanced'（進階）| null（無資料）
  async function fetchWordTier(word) {
    try {
      const resp = await fetch(`https://api.datamuse.com/words?sp=${encodeURIComponent(word)}&md=f&max=1`);
      if (!resp.ok) return null;
      const data = await resp.json();
      if (!data.length || data[0].word.toLowerCase() !== word.toLowerCase()) return null;
      const freqTag = data[0].tags?.find(t => t.startsWith('f:'));
      if (!freqTag) return null;
      const freq = parseFloat(freqTag.slice(2));
      if (freq > 100) return 'basic';
      if (freq >= 10) return 'common';
      return 'advanced';
    } catch {
      return null;
    }
  }

  async function lookupWord(word) {
    if (dictCache[word] !== undefined) return dictCache[word];
    try {
      // 字典 API 優先，tier 獨立非同步（不阻塞 popup 顯示）
      const resp = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`);
      if (!resp.ok) { dictCacheSet(word, null); return null; }
      const data = await resp.json();
      const entry = data[0];
      const firstMeaning = entry.meanings[0];
      const firstDef = firstMeaning?.definitions[0];
      const synonyms = (firstMeaning?.synonyms || []).slice(0, 4);

      const result = {
        word: entry.word,
        phonetic: entry.phonetic || entry.phonetics?.find(p => p.text)?.text || '',
        partOfSpeech: firstMeaning?.partOfSpeech || '',
        definition: firstDef?.definition || '',
        wordZh: '',
        definitionZh: '',
        example: firstDef?.example || '',
        synonyms: synonyms.map(s => ({ en: s, zh: '' })),
        translating: true,
        tier: null,  // 非同步填入
      };
      dictCacheSet(word, result);

      // tier 非同步，回來後更新 popup（若還開著）
      fetchWordTier(word).then(tier => {
        result.tier = tier;
        const popup = document.getElementById('yt-sub-word-popup');
        if (popup?.style.display !== 'none' && popup?.dataset.word === word) {
          renderPopupContent(popup, result);
          if (popup._sentenceData) appendSentenceSection(popup, word, popup._sentenceData);
        }
      });

      // 非同步翻譯：索引固定為 0=單字, 1=定義, 2+=近似詞
      // 不使用 filter(Boolean)，保留空字串佔位，確保索引不偏移
      const toTranslate = [word, firstDef?.definition || '', ...synonyms];
      if (word || firstDef?.definition || synonyms.length) {
        Promise.all(toTranslate.map(t => t ? translateGoogle(t, 'zh-TW').catch(() => '') : Promise.resolve(''))).then(translations => {
          result.wordZh = translations[0] || '';
          result.definitionZh = translations[1] || '';
          result.synonyms = synonyms.map((s, i) => ({ en: s, zh: translations[i + 2] || '' }));
          result.translating = false;
          // 若 popup 仍顯示此單字，更新 DOM
          const popup = document.getElementById('yt-sub-word-popup');
          if (popup?.style.display !== 'none' && popup?.dataset.word === word) {
            renderPopupContent(popup, result);
            if (popup._sentenceData) appendSentenceSection(popup, word, popup._sentenceData);
          }
          // 若此字已存入生字本，補寫 wordZh/definitionZh/tier 到本地（不打 Firestore）
          if (result.wordZh) {
            chrome.storage.local.get(SAVED_WORDS_KEY, d => {
              const saved = d[SAVED_WORDS_KEY] || {};
              if (!saved[word]) return;
              if (!saved[word].wordZh) saved[word].wordZh = result.wordZh;
              if (!saved[word].definitionZh) saved[word].definitionZh = result.definitionZh;
              if (!saved[word].tier) { saved[word].tier = result.tier; saved[word].tierFetched = true; }
              chrome.storage.local.set({ [SAVED_WORDS_KEY]: saved }, () => { });
            });
          }
        });
      } else {
        result.translating = false;
      }

      return result;
    } catch (e) {
      dictCacheSet(word, null);
      return null;
    }
  }

  // ===== 生字本 =====
  const SAVED_WORDS_KEY = 'yt_sub_saved_words';

  // 已儲存單字集合（lemma 小寫），供字幕高亮使用
  let _savedWordSet = new Set();
  // 已學會單字集合（lemma 小寫），供 popup 即時判斷狀態
  let _learnedWordSet = new Set();

  // 從 storage 重新載入生字本 Set，完成後 patch 所有現存字幕 span
  function refreshSavedWordSet() {
    chrome.storage.local.get(SAVED_WORDS_KEY, data => {
      const saved = data[SAVED_WORDS_KEY] || {};
      const active = Object.values(saved).filter(w => !w.deletedAt);
      _savedWordSet  = new Set(active.map(w => w.word));
      _learnedWordSet = new Set(active.filter(w => w.status === 'learned').map(w => w.word));
      patchSavedWordHighlights();
    });
  }

  // 批次更新 DOM 中所有 .yt-sub-word span 的生字本高亮 class
  function patchSavedWordHighlights() {
    document.querySelectorAll('.yt-sub-word').forEach(span => {
      const token = span.dataset.token || '';
      const lemma = lemmatize(token.toLowerCase().replace(/'s$/i, '').replace(/['-]$/, ''));
      const inBook = _savedWordSet.has(lemma) || _savedWordSet.has(token.toLowerCase());
      span.classList.toggle('yt-sub-word--saved', inBook);
    });
  }

  // 儲存單字到本地生字本；sentenceContext 為完整字幕句，startTime 為句子時間軸（秒）
  function saveWord(word, anchor, sentenceContext, startTime) {
    word = word.toLowerCase(); // 統一小寫，確保 Set / storage key 一致
    const hasCachedLookup = dictCache[word] !== undefined;
    const cached = hasCachedLookup ? dictCache[word] : null;
    const cachedNotFound = hasCachedLookup && cached === null; // 查過但字典無此字
    const cachedTier = cached?.tier ?? null;
    const cachedWordZh = cached?.wordZh || '';
    const cachedZh = cached?.definitionZh || '';
    const videoId = new URLSearchParams(location.search).get('v') || '';

    chrome.storage.local.get(SAVED_WORDS_KEY, data => {
      const saved = data[SAVED_WORDS_KEY] || {};
      // 軟刪除的字視為「未存在」，重新加入時需清除 deletedAt
      const alreadySaved = !!saved[word] && !saved[word].deletedAt;
      if (!alreadySaved) {
        if (saved[word]) {
          // 曾被軟刪除：清除刪除標記與已學會狀態，重設時間與計數（視為全新字）
          delete saved[word].deletedAt;
          delete saved[word].status;
          saved[word].addedAt = Date.now();
          saved[word].count = 1;
          if (cachedTier) { saved[word].tier = cachedTier; saved[word].tierFetched = true; }
          if (cachedWordZh) saved[word].wordZh = cachedWordZh;
          if (cachedZh) saved[word].definitionZh = cachedZh;
          if (sentenceContext) {
            if (saved[word].context !== sentenceContext) saved[word].contextZh = '';
            saved[word].context = sentenceContext;
          }
          saved[word].videoId = videoId;
          saved[word].startTime = startTime ?? 0;
        } else {
          saved[word] = {
            word,
            addedAt: Date.now(),
            count: 1,
            tier: cachedTier,
            tierFetched: hasCachedLookup,
            noDefinition: cachedNotFound,
            wordZh: cachedWordZh,
            definitionZh: cachedZh,
            context: sentenceContext || '',
            contextZh: '',
            videoId,
            startTime: startTime ?? 0,
          };
        }
      } else {
        saved[word].count = (saved[word].count || 1) + 1;
        if (!saved[word].tier && cachedTier) { saved[word].tier = cachedTier; saved[word].tierFetched = true; }
        if (!saved[word].wordZh && cachedWordZh) saved[word].wordZh = cachedWordZh;
        if (!saved[word].definitionZh && cachedZh) saved[word].definitionZh = cachedZh;
        if (sentenceContext) {
          if (saved[word].context !== sentenceContext) saved[word].contextZh = '';
          saved[word].context = sentenceContext;
          saved[word].videoId = videoId;
          saved[word].startTime = startTime ?? 0;
        }
      }
      chrome.storage.local.set({ [SAVED_WORDS_KEY]: saved }, () => {
        if (chrome.runtime.lastError) {
          console.error('[YT-SUB] storage.set 失敗:', chrome.runtime.lastError.message);
          return;
        }
        // 同步由使用者手動觸發（設定頁同步按鈕），存字時不打 Firestore
        try { if (anchor) anchor.classList.add('word-saved'); } catch (_) {}
        _savedWordSet.add(word); // 即時更新 Set，不等 storage 重讀
        patchSavedWordHighlights();
        showSaveToast(word, alreadySaved);
        // 面板開著時立即更新列表（無論是否 active 都標為 dirty，下次切換時也能重新渲染）
        if (document.getElementById('yt-sub-panel-wordbook')?.classList.contains('active')) {
          renderWordbook(videoId);
        }
        // 非同步翻譯例句 → 只寫回 local storage，不單獨打 Firestore
        if (sentenceContext && !saved[word].contextZh) {
          translateGoogle(sentenceContext, 'zh-TW').then(zh => {
            if (!zh) return;
            chrome.storage.local.get(SAVED_WORDS_KEY, d2 => {
              if (chrome.runtime.lastError) return;
              const s2 = d2[SAVED_WORDS_KEY] || {};
              if (s2[word]) {
                s2[word].contextZh = zh;
                chrome.storage.local.set({ [SAVED_WORDS_KEY]: s2 }, () => {
                  if (document.getElementById('yt-sub-panel-wordbook')?.classList.contains('active')) {
                    renderWordbook(videoId);
                  }
                });
              }
            });
          }).catch(() => { });
        }
        // 若無快取，背景呼叫 lookupWord 補齊 tier 與中文解釋
        if (!hasCachedLookup) {
          lookupWord(word).then(result => {
            if (!result) {
              // 字典查無此字：標記 noDefinition，避免生字本顯示查詢功能
              chrome.storage.local.get(SAVED_WORDS_KEY, d2 => {
                if (chrome.runtime.lastError) return;
                const s2 = d2[SAVED_WORDS_KEY] || {};
                if (s2[word] && !s2[word].noDefinition) {
                  s2[word].noDefinition = true;
                  s2[word].tierFetched = true;
                  chrome.storage.local.set({ [SAVED_WORDS_KEY]: s2 }, () => {
                    if (document.getElementById('yt-sub-panel-wordbook')?.classList.contains('active')) {
                      renderWordbook();
                    }
                  });
                }
              });
              return;
            }
            // 等待非同步翻譯完成後再寫入 storage（最多等 12 秒，防止翻譯 API 失敗時無限輪詢）
            let retries = 0;
            const tryUpdate = () => {
              if (result.translating && retries++ < 30) { setTimeout(tryUpdate, 400); return; }
              chrome.storage.local.get(SAVED_WORDS_KEY, d2 => {
                if (chrome.runtime.lastError) return;
                const s2 = d2[SAVED_WORDS_KEY] || {};
                if (!s2[word]) return;
                s2[word].tier = result.tier || null;
                s2[word].tierFetched = true;
                if (!s2[word].wordZh) s2[word].wordZh = result.wordZh || '';
                if (!s2[word].definitionZh) s2[word].definitionZh = result.definitionZh || '';
                chrome.storage.local.set({ [SAVED_WORDS_KEY]: s2 }, () => {
                  // Firestore 同步由 lookupWord 翻譯 callback 負責，這裡只更新本地
                  if (document.getElementById('yt-sub-panel-wordbook')?.classList.contains('active')) {
                    renderWordbook();
                  }
                });
              });
            };
            tryUpdate();
          });
        }
      });
    });
  }

  // 顯示儲存回饋 toast
  function showSaveToast(word, alreadySaved) {
    let toast = document.getElementById('yt-sub-save-toast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'yt-sub-save-toast';
      document.body.appendChild(toast);
    }
    toast.textContent = alreadySaved ? `「${word}」已在生字本` : `「${word}」已加入生字本`;
    toast.classList.add('show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('show'), 1800);
  }

  // ===== 生字本渲染 =====

  // 讀取生字本並渲染到面板
  function renderWordbook(forceVideoId) {
    chrome.storage.local.get(SAVED_WORDS_KEY, data => {
      const saved = data[SAVED_WORDS_KEY] || {};
      const words = Object.values(saved).filter(w => !w.deletedAt); // 排除軟刪除
      const countEl = document.getElementById('yt-sub-wordbook-count');
      const listEl = document.getElementById('yt-sub-wordbook-list');
      const sortEl = document.getElementById('yt-sub-wordbook-sort');
      if (!listEl || !countEl) return;

      // 過濾 + 排序
      const sortKey = sortEl?.value || 'current-video';
      // forceVideoId：saveWord 傳入已確認的 ID，避免合輯 SPA 切頁後讀到錯誤 URL
      const currentVideoId = forceVideoId || new URLSearchParams(location.search).get('v') || '';

      let displayed = words;
      if (sortKey === 'current-video') {
        displayed = words.filter(w => w.videoId && w.videoId === currentVideoId);
      } else if (sortKey === 'date-desc') {
        displayed = [...words].sort((a, b) => b.addedAt - a.addedAt);
      } else if (sortKey === 'count-desc') {
        displayed = [...words].sort((a, b) => b.count - a.count);
      } else if (sortKey === 'alpha') {
        displayed = [...words].sort((a, b) => a.word.localeCompare(b.word));
      } else if (sortKey === 'learned') {
        displayed = [...words.filter(w => w.status === 'learned')].sort((a, b) => b.addedAt - a.addedAt);
      }

      // 搜尋過濾：字頭前綴比對（輸入 "appl" 能找到 "apple"，輸入 "pple" 找不到）
      const searchQ = (document.getElementById('yt-sub-wb-search')?.value || '').trim().toLowerCase();
      if (searchQ) {
        displayed = displayed.filter(w =>
          w.word.toLowerCase().startsWith(searchQ) ||
          (w.wordZh && w.wordZh.toLowerCase().startsWith(searchQ))
        );
      }

      const learnedTotal = words.filter(w => w.status === 'learned').length;
      const baseCount = sortKey === 'current-video' ? displayed.length : words.length;
      const totalLabel = sortKey === 'current-video'
        ? (displayed.length ? `當前影片 ${displayed.length} 個單字` : '此影片尚未儲存任何單字')
        : sortKey === 'learned'
          ? (learnedTotal
              ? (searchQ ? `${displayed.length} / ${learnedTotal} 個單字` : `已學會 ${learnedTotal} 個單字`)
              : '尚未標記任何單字為已學會')
          : (searchQ
              ? `${displayed.length} / ${baseCount} 個單字`
              : (words.length ? `共 ${words.length} 個單字` : '尚未儲存任何單字'));
      countEl.textContent = totalLabel;
      listEl.innerHTML = '';

      if (!displayed.length) return;

      displayed.forEach(item => {
        const row = document.createElement('div');
        const isLearned = item.status === 'learned';
        row.className = 'yt-sub-wb-row' + (isLearned ? ' learned' : '');

        const tierHtml = item.tier && TIER_CLASS[item.tier]
          ? `<span class="yt-sub-tier-badge ${TIER_CLASS[item.tier]}">${TIER_LABEL[item.tier]}</span>`
          : '';
        const isSameVideo = item.videoId && item.videoId === currentVideoId;
        const rowBtnsHtml = isSameVideo && item.startTime != null
          ? `<button class="yt-sub-wb-row-play" data-start="${item.startTime}" title="播放此句">▶</button>`
          : '';
        const learnedBadge = isLearned ? `<span class="yt-sub-wb-learned-badge">✓ 已學會</span>` : '';

        // 主列
        const main = document.createElement('div');
        main.className = 'yt-sub-wb-row-main';
        main.innerHTML = `
          <span class="yt-sub-wb-word${item.noDefinition ? ' no-def' : ''}">${escapeHtml(item.word)}</span>
          ${item.wordZh ? `<span class="yt-sub-wb-zh">${escapeHtml(item.wordZh)}</span>` : ''}
          ${rowBtnsHtml}
          ${tierHtml}
          ${learnedBadge}
          ${item.count > 1 ? `<span class="yt-sub-wb-meta">×${item.count}</span>` : ''}
          <button class="yt-sub-wb-del" data-word="${escapeHtml(item.word)}" title="刪除">×</button>
        `;

        // 展開詳情區塊
        const detail = document.createElement('div');
        detail.className = 'yt-sub-wb-row-detail';
        if (item.context) {
          const ctxEl = document.createElement('div');
          ctxEl.className = 'yt-sub-wb-row-context';
          ctxEl.textContent = item.context;
          detail.appendChild(ctxEl);
        }
        const learnBtn = document.createElement('button');
        learnBtn.className = 'yt-sub-wb-learned-btn' + (isLearned ? ' active' : '');
        learnBtn.textContent = isLearned ? '✓ 已學會' : '標記為已學會';
        detail.appendChild(learnBtn);
        row.appendChild(main);
        row.appendChild(detail);

        // 點擊主列背景：展開 / 收合（排除按鈕與單字）
        main.addEventListener('click', e => {
          if (e.target.closest('button, .yt-sub-wb-word')) return;
          const isExpanding = !row.classList.contains('expanded');
          // 收合所有其他已展開的卡片並停止 loop
          listEl.querySelectorAll('.yt-sub-wb-row.expanded').forEach(r => r.classList.remove('expanded'));
          _stopWbExpandLoop();
          if (isExpanding) {
            row.classList.add('expanded');
            speakWord(item.word);
            if (settings.wbExpandLoop) _startWbExpandLoop(item);
          }
        });

        // 點擊單字：查字典
        if (!item.noDefinition) {
          main.querySelector('.yt-sub-wb-word').addEventListener('click', e => {
            e.stopPropagation();
            showWordPopup(item.word, e.target, item);
          });
        }

        // 播放此句按鈕
        const playBtn = main.querySelector('.yt-sub-wb-row-play');
        if (playBtn) {
          playBtn.addEventListener('click', e => {
            e.stopPropagation();
            const startTime = parseFloat(playBtn.dataset.start);
            seekTo(startTime);
            if (loopingIdx >= 0) {
              const idx = primarySubtitles.findIndex(s => s.startTime === startTime);
              loopingIdx = idx >= 0 ? idx : -1;
              updateCurrentLoopStyle();
            }
          });
        }

        // 刪除單字
        main.querySelector('.yt-sub-wb-del').addEventListener('click', e => {
          e.stopPropagation();
          deleteWord(item.word, row);
        });

        // 已學會按鈕
        learnBtn.addEventListener('click', e => {
          e.stopPropagation();
          toggleLearnedStatus(item.word, learnBtn, row, main);
        });

        listEl.appendChild(row);
      });
    });
  }

  // 切換已學會狀態
  function toggleLearnedStatus(word, btn, rowEl, mainEl) {
    chrome.storage.local.get(SAVED_WORDS_KEY, data => {
      const saved = data[SAVED_WORDS_KEY] || {};
      if (!saved[word]) return;
      const nowLearned = saved[word].status !== 'learned';
      if (nowLearned) saved[word].status = 'learned';
      else delete saved[word].status;
      chrome.storage.local.set({ [SAVED_WORDS_KEY]: saved }, () => {
        // 同步更新記憶體 Set
        if (nowLearned) _learnedWordSet.add(word);
        else _learnedWordSet.delete(word);
        // 同步更新 popup 內的已學會按鈕（若 popup 仍開著）
        const openPopup = document.getElementById('yt-sub-word-popup');
        if (openPopup?.style.display !== 'none' && openPopup?.dataset.word === word) {
          const popupLearnBtn = openPopup.querySelector('.yt-sub-popup-learn-btn');
          if (popupLearnBtn) {
            popupLearnBtn.textContent = nowLearned ? '✓ 已學會' : '已學會';
            popupLearnBtn.classList.toggle('active', nowLearned);
          }
        }
        btn.textContent = nowLearned ? '✓ 已學會' : '標記為已學會';
        btn.classList.toggle('active', nowLearned);
        rowEl.classList.toggle('learned', nowLearned);
        // 同步更新主列的已學會 badge
        const badge = mainEl.querySelector('.yt-sub-wb-learned-badge');
        if (nowLearned && !badge) {
          const b = document.createElement('span');
          b.className = 'yt-sub-wb-learned-badge';
          b.textContent = '✓ 已學會';
          // 插在 count（×N）之前；若無 count 則插在刪除按鈕之前
          const countEl = mainEl.querySelector('.yt-sub-wb-meta');
          const delBtn = mainEl.querySelector('.yt-sub-wb-del');
          mainEl.insertBefore(b, countEl || delBtn);
        } else if (!nowLearned && badge) {
          badge.remove();
        }
      });
    });
  }

  // 從生字本刪除單字
  function deleteWord(word, rowEl) {
    chrome.storage.local.get(SAVED_WORDS_KEY, data => {
      const saved = data[SAVED_WORDS_KEY] || {};
      if (saved[word]) saved[word].deletedAt = Date.now(); // 軟刪除，保留供同步
      chrome.storage.local.set({ [SAVED_WORDS_KEY]: saved }, () => {
        _savedWordSet.delete(word); // 即時更新 Set
        patchSavedWordHighlights();
        rowEl.classList.add('yt-sub-wb-row-removing');
        setTimeout(() => renderWordbook(), 250);
      });
    });
  }

  // 顯示存字時的完整例句（雙語）與跳轉按鈕
  function showSentencePopup(item, anchor) {
    let popup = document.getElementById('yt-sub-sentence-popup');
    if (!popup) {
      popup = document.createElement('div');
      popup.id = 'yt-sub-sentence-popup';
      document.body.appendChild(popup);
    }
    // 高亮句子中的目標單字（先跳脫 RegExp 特殊字元）
    const safeWord = escapeHtml(item.word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const highlighted = escapeHtml(item.context).replace(
      new RegExp(`(${safeWord})`, 'gi'),
      '<mark class="yt-sub-sent-mark">$1</mark>'
    );
    const timeLabel = formatTime(item.startTime || 0);
    const currentVideoId = new URLSearchParams(location.search).get('v') || '';
    const isSameVideo = item.videoId && item.videoId === currentVideoId;

    popup.innerHTML = `
      <div class="yt-sub-sent-en">${highlighted}</div>
      ${item.contextZh ? `<div class="yt-sub-sent-zh">${escapeHtml(item.contextZh)}</div>` : ''}
      <div class="yt-sub-sent-footer">
        <button class="yt-sub-sent-seek" title="${isSameVideo ? '跳轉到此句' : '在 YouTube 開啟'}">
          ${isSameVideo ? '▶' : '↗'} ${timeLabel}
        </button>
      </div>
    `;
    popup.style.display = 'block';

    // 定位：以 sidebar 為基準居中
    const sidebar = document.getElementById('yt-sub-demo-sidebar');
    const sbRect = sidebar?.getBoundingClientRect();
    const popupW = 280;
    const left = sbRect ? sbRect.left + (sbRect.width - popupW) / 2 : window.innerWidth - popupW - 16;
    const anchorRect = anchor.getBoundingClientRect();
    const topBelow = anchorRect.bottom + 6;
    const popupH = 120; // 預估高度，避免超出視窗底部
    const top = topBelow + popupH > window.innerHeight ? anchorRect.top - popupH - 6 : topBelow;
    popup.style.left = Math.max(8, Math.min(left, window.innerWidth - popupW - 8)) + 'px';
    popup.style.top = Math.max(8, top) + 'px';

    // 跳轉按鈕邏輯
    popup.querySelector('.yt-sub-sent-seek').addEventListener('click', e => {
      e.stopPropagation();
      if (isSameVideo) {
        seekTo(item.startTime || 0);
      } else {
        window.open(`https://www.youtube.com/watch?v=${item.videoId}&t=${Math.floor(item.startTime || 0)}s`, '_blank');
      }
      popup.style.display = 'none';
    });

    const close = e => {
      if (!popup.contains(e.target) && e.target !== anchor) {
        popup.style.display = 'none';
        window.removeEventListener('click', close, true);
      }
    };
    setTimeout(() => window.addEventListener('click', close, true), 50);
  }

  // ===== 外部翻譯 =====
  const TRANSLATE_WINDOW = 30 * 60; // 每次翻譯 30 分鐘的字幕
  const TRANSLATE_TRIGGER = 5 * 60; // 距離翻譯邊界 5 分鐘時觸發下一批

  // 主字幕 Google Translate 路徑：將原語言字幕全量翻譯後取代 primarySubtitles
  // 與副字幕翻譯相同原理，差別是結果存入 primary 而非 secondary
  async function translatePrimarySubtitles(subs, targetLang) {
    const videoId = new URLSearchParams(location.search).get('v') || '';
    const statusEl = document.getElementById('yt-sub-status');
    const total = subs.length;
    let done = 0;

    const job = { cancelled: false };
    primaryTranslationJob = job; // 獨立 job，不影響副字幕的 translationJob

    // 以 groupByWords 分組（約 100 字一批，減少 API 呼叫）
    const indices = subs.map((_, i) => i);
    const groups = groupByWords(indices, subs, 100);

    for (const group of groups) {
      if (job.cancelled) return;
      const texts = group.map(i => subs[i].text);
      const combined = texts.join('\n');
      try {
        const translated = await translateGoogle(combined, targetLang);
        const lines = translated.split('\n');
        group.forEach((si, li) => {
          const t = (lines[li] || '').trim() || subs[si].text;
          // 更新 primarySubtitles（in-place）
          if (primarySubtitles[si]) primarySubtitles[si] = { ...primarySubtitles[si], text: t };
        });
        done += group.length;
        if (statusEl) {
          statusEl.textContent = `翻譯主字幕 ${done}/${total}`;
          statusEl.className = 'yt-sub-status';
        }
        renderSubtitleList();
      } catch (e) {
        console.warn('[YT-SUB] translatePrimarySubtitles 批次失敗:', e.message);
      }
      if (done < total) await new Promise(r => setTimeout(r, 400));
    }

    if (!job.cancelled && statusEl && !customSubtitleActive) {
      const langName = ONBOARDING_LEARN_LANGS.find(l => l.code === targetLang)?.label || targetLang;
      statusEl.textContent = `主：${langName}（${total} 句，Google 翻譯）`;
      statusEl.className = 'yt-sub-status success';
    }
  }

  async function translateAndSetSecondary(subs, targetLang, fromTime = null) {
    const videoId = new URLSearchParams(location.search).get('v') || '';
    const cacheKey = videoId + ':' + targetLang;
    console.log('[YT-SUB][TRANS] translateAndSetSecondary called, subsLen=', subs.length, 'target=', targetLang, 'fromTime=', fromTime);

    // 快取命中：直接用，不重翻
    if (translationCache[cacheKey] && fromTime === null) {
      console.log('[YT-SUB] 翻譯快取命中 key=' + cacheKey);
      secondarySubtitles = translationCache[cacheKey];
      patchSubtitleListSecondary();
      if (!syncInterval) startSync();
      scheduleNextTranslationBatch(subs, targetLang);
      return;
    }

    // 取消上一個翻譯工作
    if (translationJob) translationJob.cancelled = true;
    const job = { cancelled: false };
    translationJob = job;

    const video = document.querySelector('video');
    const currentTime = fromTime ?? (video?.currentTime || 0);
    const windowEnd = currentTime + TRANSLATE_WINDOW;

    // 找出這個時間窗口內的字幕 index
    const indices = [];
    subs.forEach((s, i) => {
      if (s.startTime >= currentTime && s.startTime < windowEnd) indices.push(i);
    });

    const statusEl = document.getElementById('yt-sub-status');
    const primaryName = trackList.find(t => t.languageCode === settings.primaryLang)?.name || settings.primaryLang;
    let done = 0;

    // 依批次模式決定分組：sentence8 = 固定 8 句，words100 = 累積約 100 字
    const groups = settings.googleBatchMode === 'words100'
      ? groupByWords(indices, subs, 100)
      : (() => { const g = []; for (let b = 0; b < indices.length; b += 8) g.push(indices.slice(b, b + 8)); return g; })();

    for (const group of groups) {
      if (job.cancelled) return;
      try {
        const texts = group.map(i => subs[i].text);
        // 合併成一次 API 請求
        const results = await translateBatch(texts, targetLang);
        for (let k = 0; k < group.length; k++) {
          if (job.cancelled) return;
          const i = group[k];
          const existing = secondarySubtitles.findIndex(s => s.startTime === subs[i].startTime);
          const entry = { ...subs[i], text: results[k] };
          if (existing >= 0) secondarySubtitles[existing] = entry;
          else secondarySubtitles.push(entry);
          patchSubtitleItem(i, results[k]);
          done++;
        }
      } catch (e) {
        if (job.cancelled) return;
        if (statusEl) { statusEl.textContent = `翻譯失敗：${e.message}`; statusEl.className = 'yt-sub-status error'; }
        return;
      }
      if (!syncInterval) startSync();
      if (statusEl && !customSubtitleActive) {
        statusEl.textContent = `主：${primaryName}（${subs.length} 句）｜翻譯中 ${done}/${indices.length}`;
        statusEl.className = 'yt-sub-status success';
      }
      if (done < indices.length) await new Promise(r => setTimeout(r, 400));
    }

    if (!job.cancelled) {
      // 整批存快取（累積所有已翻區段）
      const keys = Object.keys(translationCache);
      if (keys.length >= TRANSLATION_CACHE_MAX) delete translationCache[keys[0]];
      translationCache[cacheKey] = [...secondarySubtitles];
      if (statusEl && !customSubtitleActive) {
        statusEl.textContent = `主：${primaryName}（${subs.length} 句）`;
        statusEl.className = 'yt-sub-status success';
      }
      // 安排下一批的觸發
      scheduleNextTranslationBatch(subs, targetLang);
    }
  }

  // 當播放位置接近已翻譯邊界時觸發下一批
  let _nextBatchTimer = null;
  function scheduleNextTranslationBatch(subs, targetLang) {
    if (_nextBatchTimer) clearTimeout(_nextBatchTimer);
    if (!secondarySubtitles.length) return;
    const lastTranslated = secondarySubtitles[secondarySubtitles.length - 1];
    const video = document.querySelector('video');
    if (!video) return;
    const remaining = lastTranslated.startTime - video.currentTime - TRANSLATE_TRIGGER;
    if (remaining <= 0) {
      // 已經到邊界，用 setTimeout(0) 讓 event loop 喘一口氣，避免同步遞迴爆 call stack
      _nextBatchTimer = setTimeout(() => {
        translateAndSetSecondary(subs, targetLang, lastTranslated.startTime + lastTranslated.duration);
      }, 0);
    } else {
      _nextBatchTimer = setTimeout(() => {
        translateAndSetSecondary(subs, targetLang, lastTranslated.startTime + lastTranslated.duration);
      }, remaining * 1000);
    }
  }

  // 只更新單條字幕 DOM 的副字幕文字，不重建整個列表
  function patchSubtitleItem(primaryIdx, secText) {
    const item = document.querySelector(`.yt-sub-item[data-index="${primaryIdx}"]`);
    if (!item) return;
    let secEl = item.querySelector('.yt-sub-text-secondary');
    const displaySecText = filterSubText(secText);
    if (displaySecText && settings.dualEnabled) {
      if (!secEl) {
        secEl = document.createElement('div');
        secEl.className = 'yt-sub-text-secondary';
        item.querySelector('.yt-sub-texts')?.appendChild(secEl);
      }
      secEl.textContent = displaySecText;
    } else if (secEl) {
      secEl.remove();
    }
  }

  // ===== 狀聲詞過濾 =====
  function filterSubText(text) {
    if (!settings.filterSoundDesc || !text) return text;
    return text.replace(/\[.*?\]/g, '').replace(/\s{2,}/g, ' ').trim();
  }

  // ===== 單字 Tokenize =====
  function buildTokenizedText(container, text, startTime) {
    const tokens = text.split(/(\b[a-zA-Z'-]+\b)/);
    tokens.forEach(token => {
      if (/^[a-zA-Z'-]+$/.test(token) && token.length > 1) {
        const span = document.createElement('span');
        span.className = 'yt-sub-word';
        span.textContent = token;
        const _lemma = lemmatize(token.toLowerCase().replace(/'s$/i, '').replace(/['-]$/, ''));
        if (_savedWordSet.has(_lemma) || _savedWordSet.has(token.toLowerCase())) {
          span.classList.add('yt-sub-word--saved');
        }
        // 儲存 token 於 dataset，讓 container 層的右鍵 delegation 取得
        span.dataset.token = token;
        span.dataset.startTime = startTime;
        span.dataset.sentenceText = text;
        span.addEventListener('click', e => {
          e.stopPropagation();
          // 查字典時還原為原型（shining → shine），讓字典結果與生字本一致
          const clean = lemmatize(token.toLowerCase().replace(/'s$/i, '').replace(/['-]$/, ''));
          if (settings.wordSpeak) speakWord(token);
          showWordPopup(clean, span, {
            _originalToken: token.toLowerCase(),
            context: text,
            startTime: startTime,
            videoId: new URLSearchParams(location.search).get('v') || '',
          });
        });
        container.appendChild(span);
      } else {
        container.appendChild(document.createTextNode(token));
      }
    });
  }

  // 在 window 最頂層綁 capture 右鍵，早於 YouTube document-level capture handler
  // 只需綁一次；SPA 換頁不需重設（listener 掛在 window 不會隨 DOM 消失）
  function initWindowContextMenu() {
    if (_windowContextMenuBound) return;
    _windowContextMenuBound = true;
    window.addEventListener('contextmenu', e => {
      const inOverlay  = e.target.closest('#yt-sub-overlay');
      const inList     = e.target.closest('#yt-sub-list');
      const inSubtitle = e.target.closest('#yt-sub-subtitle-mode');
      if (!inOverlay && !inList && !inSubtitle) return;
      handleWordContextMenu(e);
    }, true);
  }

  // 右鍵儲存單字的共用邏輯（供 window capture delegation 呼叫）
  function handleWordContextMenu(e) {
    const span = e.target.closest('.yt-sub-word');
    if (!span) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const token = span.dataset.token || span.textContent;
    const text = span.dataset.sentenceText || '';
    const startTime = parseFloat(span.dataset.startTime) || 0;
    const clean = lemmatize(token.toLowerCase().replace(/'s$/i, '').replace(/['-]$/, ''));
    const original = token.toLowerCase();
    const wordToSave = (clean !== original && dictCache[clean] === null) ? original : clean;
    saveWord(wordToSave, span, text, startTime);
  }

  // 快取命中時批次更新所有現有 DOM 的副字幕欄位
  function patchSubtitleListSecondary() {
    primarySubtitles.forEach((sub, i) => {
      const secSub = findSecondaryForPrimary(secondarySubtitles, sub);
      patchSubtitleItem(i, secSub?.text || null);
    });
  }

  async function translateOne(text, targetLang) {
    switch (settings.translationProvider) {
      case 'google': return translateGoogle(text, targetLang);
      default: return text;
    }
  }

  async function translateGoogle(text, targetLang) {
    const lang = ({ 'zh-Hans': 'zh-CN' })[targetLang] || targetLang;
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t'
      + '&tl=' + encodeURIComponent(lang) + '&q=' + encodeURIComponent(text);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('Google 翻譯回傳 ' + resp.status);
    const data = await resp.json();
    let result = data[0].map(s => s[0]).join('').trim();
    // 使用者選繁體中文但收到簡體時，補一道 zh-CN → zh-TW 轉換
    if (targetLang === 'zh-TW' && looksLikeSimplified(result)) {
      result = await s2t(result);
    }
    return result;
  }

  // 偵測文字是否包含常見簡體獨有字元
  function looksLikeSimplified(text) {
    // 高頻簡體字中有別於繁體的字元
    return /[这来时们说国为动爱学习语实现样会还员义务际联么问题带电话头别识设发现开处么进过对须则总达两场统该计长达确实际联样么间须则总达]/.test(text);
  }

  // 簡體 → 繁體（走 Google Translate sl=zh-CN tl=zh-TW）
  async function s2t(text) {
    try {
      const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=zh-CN&dt=t&tl=zh-TW&q='
        + encodeURIComponent(text);
      const resp = await fetch(url);
      if (!resp.ok) return text;
      const data = await resp.json();
      return data[0].map(s => s[0]).join('').trim();
    } catch { return text; }
  }

  // 將字幕 index 陣列按累積單字數分組（約 maxWords 字一組）
  function groupByWords(indices, subs, maxWords) {
    const groups = [];
    let cur = [], count = 0;
    for (const i of indices) {
      const w = subs[i].text.split(/\s+/).length;
      if (cur.length > 0 && count + w > maxWords) {
        groups.push(cur);
        cur = []; count = 0;
      }
      cur.push(i); count += w;
    }
    if (cur.length) groups.push(cur);
    return groups;
  }

  // 多句合併成一次 Google API 請求，用 ⚡ 做分隔符
  async function translateBatch(texts, targetLang) {
    const SEP = '\n⚡\n';
    const lang = ({ 'zh-Hans': 'zh-CN' })[targetLang] || targetLang;
    const combined = texts.join(SEP);
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t'
      + '&tl=' + encodeURIComponent(lang) + '&q=' + encodeURIComponent(combined);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('Google 翻譯回傳 ' + resp.status);
    const data = await resp.json();
    const raw = data[0].map(s => s[0]).join('').trim();
    const parts = raw.split(/\n?⚡\n?/).map(p => p.trim());
    // 切割數量不符時 fallback 逐句翻譯
    if (parts.length !== texts.length) {
      console.warn('[YT-SUB] translateBatch 切割數不符，fallback 逐句', parts.length, '!=', texts.length);
      return Promise.all(texts.map(t => translateGoogle(t, targetLang)));
    }
    return parts;
  }


  // ===== 影片 Overlay =====
  function applyOverlay() {
    const hasSubtitles = primarySubtitles.length > 0;
    watchCcButton(); // 確保 CC 按鈕監聽已掛上
    if (settings.overlayEnabled && hasSubtitles) {
      createOverlay();
      suppressNativeCaptions(true);
    } else {
      removeOverlay();
      suppressNativeCaptions(false);
    }
  }

  function suppressNativeCaptions(hide) {
    const id = 'yt-sub-caption-suppress';
    if (hide) {
      if (!document.getElementById(id)) {
        const style = document.createElement('style');
        style.id = id;
        // opacity:0 而非 display:none，確保 YouTube 內部 CC 系統仍正常運作（fetch 不中斷）
        style.textContent = '.ytp-caption-window-container { opacity: 0 !important; pointer-events: none !important; }';
        document.head.appendChild(style);
      }
    } else {
      document.getElementById(id)?.remove();
    }
  }

  // 監聽 CC 按鈕（.ytp-subtitles-button）aria-pressed 變化
  // CC 按鈕與我們的 overlay 字幕綁定：按下顯示、再按隱藏
  function watchCcButton() {
    if (_ccBtnObserver) return; // 已在監聽
    const btn = document.querySelector('.ytp-subtitles-button');
    if (!btn) return;
    _ccBtnObserver = new MutationObserver(() => {
      const pressed = btn.getAttribute('aria-pressed') === 'true';
      const overlay = document.getElementById('yt-sub-overlay');
      if (overlay) overlay.style.display = pressed ? '' : 'none';
    });
    _ccBtnObserver.observe(btn, { attributes: true, attributeFilter: ['aria-pressed'] });
  }

  function createOverlay() {
    if (document.getElementById('yt-sub-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'yt-sub-overlay';
    overlay.innerHTML = `
      <button id="yt-sub-ov-prev" class="yt-sub-ov-nav"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>
      <div id="yt-sub-ov-body">
        <div id="yt-sub-ov-primary"></div>
        <div id="yt-sub-ov-secondary"></div>
      </div>
      <button id="yt-sub-ov-next" class="yt-sub-ov-nav"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></button>
    `;
    const player = document.querySelector('#movie_player');
    if (player) player.appendChild(overlay);
    updateOverlayRight();

    // 右鍵 delegation 由 initWindowContextMenu() 在 window 層統一處理，此處不再重複綁定

    // 點擊背版（body 區域）→ 啟動/取消單句循環
    document.getElementById('yt-sub-ov-body').addEventListener('click', e => {
      if (e.target.closest('.yt-sub-word')) return;
      if (loopingIdx >= 0) {
        console.log('[YT-SUB][LOOP] ov-body click → cancel');
        loopingIdx = -1;
      } else {
        const primIdx = findActiveIndex(primarySubtitles, document.querySelector('video')?.currentTime || 0);
        if (primIdx >= 0) { console.log('[YT-SUB][LOOP] ov-body click → set idx=', primIdx); loopingIdx = primIdx; }
      }
      updateCurrentLoopStyle();
    });

    // 上一句
    document.getElementById('yt-sub-ov-prev').addEventListener('click', e => {
      e.stopPropagation();
      if (!primarySubtitles.length) return;
      loopingIdx = -1;
      updateCurrentLoopStyle();
      const video = document.querySelector('video');
      const wasPlaying = video && !video.paused;
      // 播放中先暫停，確保 currentTime 凍結後再計算當前句，避免 seek async 跑錯句
      if (wasPlaying) video.pause();
      const cur = _navLockedIdx >= 0 ? _navLockedIdx
        : findLastStartedIndex(primarySubtitles, (video?.currentTime || 0) + (settings.subtitleOffset || 0));
      const newIdx = Math.max(0, cur - 1);
      console.log('[YT-SUB][NAV] < clicked cur=', cur, '→ newIdx=', newIdx, 'target=', primarySubtitles[newIdx]?.text);
      _navLockedIdx = newIdx;
      _navLockUntil = Date.now() + 800;
      seekTo(primarySubtitles[newIdx].startTime);
      if (wasPlaying) video.play().catch(() => {});
    });

    // 下一句
    document.getElementById('yt-sub-ov-next').addEventListener('click', e => {
      e.stopPropagation();
      if (!primarySubtitles.length) return;
      loopingIdx = -1;
      updateCurrentLoopStyle();
      const video = document.querySelector('video');
      const cur = findLastStartedIndex(primarySubtitles, (video?.currentTime || 0) + (settings.subtitleOffset || 0));
      const nextIdx = Math.min(primarySubtitles.length - 1, cur + 1);
      console.log('[YT-SUB][NAV] > clicked cur=', cur, '→ nextIdx=', nextIdx, 'target=', primarySubtitles[nextIdx]?.text);
      if (nextIdx !== cur) {
        seekTo(primarySubtitles[nextIdx].startTime);
      }
    });
  }

  function updateOverlayLoopStyle() {
    updateCurrentLoopStyle();
  }

  let _lastLoopingState = false;
  function updateCurrentLoopStyle() {
    const looping = loopingIdx >= 0;
    // 不論狀態是否改變，都更新 row 層 loop 按鈕（因為可能切換了不同的循環句）
    updateWbLoopBtn();
    if (looping === _lastLoopingState) return;
    _lastLoopingState = looping;
    document.getElementById('yt-sub-current')?.classList.toggle('looping', looping);
    document.getElementById('yt-sub-ov-body')?.classList.toggle('looping', looping);
  }

  function updateWbLoopBtn() {
    // toolbar 全域按鈕
    const btn = document.getElementById('yt-sub-wb-loop-btn');
    if (btn) {
      const looping = loopingIdx >= 0;
      btn.classList.toggle('active', looping);
      btn.title = looping ? '停止循環' : '循環當前句';
    }
    // 每個 row 的循環按鈕：只亮正在循環的那一句
    const loopingStartTime = loopingIdx >= 0 ? primarySubtitles[loopingIdx]?.startTime : null;
    document.querySelectorAll('.yt-sub-wb-row-loop').forEach(b => {
      const isThis = loopingStartTime != null && parseFloat(b.dataset.start) === loopingStartTime;
      b.classList.toggle('active', isThis);
      b.title = isThis ? '停止循環' : '循環此句';
    });
    // 字幕模式 loop 按鈕（依 data-idx 對比 loopingIdx）
    document.querySelectorAll('.ysm-loop-btn').forEach(b => {
      const row = b.closest('.ysm-row');
      const isThis = row != null && Number(row.dataset.idx) === loopingIdx;
      b.classList.toggle('active', isThis);
      b.title = isThis ? '停止循環' : '循環此句';
    });
  }

  function updateOverlayRight() {
    const overlay = document.getElementById('yt-sub-overlay');
    if (!overlay) return;
    const collapsed = document.getElementById('yt-sub-demo-sidebar')?.classList.contains('sidebar-collapsed');
    const isPush = !!(document.querySelector('ytd-app')?.style.getPropertyValue('margin-right'));
    // push 模式：player 已縮排，overlay 只需留自身邊距
    // overlay 模式：sidebar 懸空，需額外避開 sidebar 寬度
    overlay.style.right = (collapsed || isPush) ? '2%' : 'calc(360px + 2%)';
  }

  // ===== 懸浮球 =====
  let _ballAnimating = false;

  function createBall(wrapper) {
    if (document.getElementById('yt-sub-ball')) return;
    const ball = document.createElement('div');
    ball.id = 'yt-sub-ball';
    ball.innerHTML = `
      <div class="yt-sub-ball-dot hidden" id="yt-sub-ball-dot"></div>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"
           stroke-linecap="round" stroke-linejoin="round" width="16" height="16">
        <path d="M4 6h16M4 12h10M4 18h7"/>
      </svg>
    `;
    // 球掛在 wrapper 裡（sidebar 的 sibling），clip-path 不會裁切它
    (wrapper || document.body).appendChild(ball);

    // hover：動畫中不觸發
    ball.addEventListener('mouseenter', () => {
      if (!_ballAnimating && !ball.classList.contains('expanded')) ball.classList.add('hovered');
    });
    ball.addEventListener('mouseleave', () => ball.classList.remove('hovered'));

    // 點擊：切換展開/收合
    ball.addEventListener('click', () => {
      ball.classList.remove('hovered');
      const sidebar = document.getElementById('yt-sub-demo-sidebar');
      if (sidebar.classList.contains('sidebar-collapsed')) {
        expandSidebar();
      } else {
        collapseSidebar('user');
      }
    });
  }

  // 偵測 YouTube 目前是否為劇院模式
  function isTheaterMode() {
    return document.querySelector('ytd-watch-flexy')?.hasAttribute('theater') ?? false;
  }

  // 等待 ytd-watch-flexy[theater] 屬性出現，最多 timeout ms
  // 劇院模式切換是非同步的（YouTube 內部 dispatch event 後才改 DOM），
  // 點完按鈕後需等 attribute 真的上去再對齊 player，否則用舊尺寸定位
  function waitForTheater(timeout = 800) {
    return new Promise(resolve => {
      if (isTheaterMode()) { resolve(); return; }
      const flexy = document.querySelector('ytd-watch-flexy');
      if (!flexy) { resolve(); return; }
      const mo = new MutationObserver(() => {
        if (flexy.hasAttribute('theater')) { mo.disconnect(); resolve(); }
      });
      mo.observe(flexy, { attributes: true, attributeFilter: ['theater'] });
      // 超時保護：無論如何都繼續，不卡住展開流程
      setTimeout(() => { mo.disconnect(); resolve(); }, timeout);
    });
  }

  // 強制切入劇院模式，回傳 Promise（等切換完成才 resolve）
  async function forceTheaterMode() {
    if (isTheaterMode()) return;
    const btn = document.querySelector('.ytp-size-button');
    if (!btn) return;
    btn.click();
    _forcedTheater = true;
    await waitForTheater();
  }

  // 還原劇院模式（若展開時是由套件強制切入的才還原）
  function restoreTheaterMode() {
    if (!_forcedTheater) return;
    _forcedTheater = false;
    if (isTheaterMode()) {
      const btn = document.querySelector('.ytp-size-button');
      if (btn) btn.click();
    }
  }

  async function expandSidebar() {
    const sidebar = document.getElementById('yt-sub-demo-sidebar');
    const ball = document.getElementById('yt-sub-ball');
    if (!sidebar || !ball) return;
    _ballAnimating = true;
    sidebar.classList.remove('sidebar-collapsed');
    ball.classList.add('expanded');
    // 展開時隱藏 ball dot（狀態已由 header LED 點陣呈現，不需重複顯示）
    const dot = document.getElementById('yt-sub-ball-dot');
    if (dot) { dot.classList.remove('no-sub', 'has-sub', 'idle'); dot.classList.add('hidden'); }
    // 等劇院模式切換完成再對齊 player，避免用舊尺寸定位
    await forceTheaterMode();
    syncWrapperToPlayer();
    applyLayoutMode('push');
    const sec = document.querySelector('#secondary');
    if (sec) sec.style.setProperty('display', 'none', 'important');
    const onEnd = () => { _ballAnimating = false; ball.removeEventListener('transitionend', onEnd); };
    ball.addEventListener('transitionend', onEnd);
  }

  function collapseSidebar(reason) {
    const sidebar = document.getElementById('yt-sub-demo-sidebar');
    const ball = document.getElementById('yt-sub-ball');
    if (!sidebar || !ball) return;
    _ballAnimating = true;
    sidebar.classList.add('sidebar-collapsed');
    ball.classList.remove('expanded', 'hovered');
    applyLayoutMode('overlay'); // 收合 → 還原 YouTube 版面
    // 還原 secondary
    const sec = document.querySelector('#secondary');
    if (sec) sec.style.removeProperty('display');
    // 若展開時由套件強制切入劇院模式，收合時還原
    restoreTheaterMode();
    const onEnd = () => { _ballAnimating = false; ball.removeEventListener('transitionend', onEnd); };
    ball.addEventListener('transitionend', onEnd);
    updateBallDot(reason);
  }

  // 更新狀態點（no-sub / has-sub / hidden）+ 同步 LED 點陣
  function updateBallDot(reason) {
    const dot = document.getElementById('yt-sub-ball-dot');
    if (!dot) return;
    dot.classList.remove('no-sub', 'has-sub', 'hidden');
    // 強制重播動畫
    dot.style.animation = 'none';
    dot.offsetHeight;
    dot.style.animation = '';
    if (reason === 'no-sub') {
      dot.classList.add('no-sub');
      setLedState('no-sub');
    } else if (reason === 'idle' || !primarySubtitles.length) {
      // 沒字幕時不論 reason 為何（包含 'user' 手動收合），都顯示 idle
      dot.classList.add('idle');
      setLedState('idle');
    } else {
      dot.classList.add('has-sub');
      setLedState('has-sub');
    }
  }

  // ===== 播放模式管理 =====

  let _currentMode    = 'default'; // 'default' | 'subtitle' | 'edit'
  let _editDirty      = false;     // 編輯字幕模式是否有未儲存變更
  let _focusedRow     = -1;        // 編輯模式中目前聚焦的列索引
  let _editorEnabled  = false;     // 目前使用者是否有編輯字幕模式權限
  let _userTier       = 'guest';   // 'guest' | 'user' | 'editor'  三層權限
  let _loopActive     = false;     // 循環播放是否啟用
  let _loopTimeoutId  = null;      // 循環播放定時器 ID
  let _ysmTimeUpdateHandler = null; // enterSubtitleMode 加的 timeupdate handler（退出時移除）
  let _yemSyncHandler      = null; // enterEditMode 加的 timeupdate handler（退出時移除）
  let _yemMainHandler      = null; // enterEditMode 加的 loop/autopause handler（退出時移除）

  function _registerAndCheckEditorPermission() {
    // 自動建立申請 doc（已存在則跳過）
    chrome.runtime.sendMessage({ type: 'fb_registerEditorPermission' }, () => {});
    // 查詢權限並更新模式選單
    chrome.runtime.sendMessage({ type: 'fb_checkEditorPermission' }, res => {
      _editorEnabled = res?.enabled === true;
      _updateEditModeOption();
    });
  }

  // ===== 三層權限管理 =====

  /**
   * 從 background.js 重新取得使用者權限等級並更新 _userTier：
   *   'guest'  — 未登入：只能使用雙語原生字幕
   *   'user'   — 已登入：可使用單字幕 + 翻譯
   *   'editor' — 已登入且獲授權：可使用全功能（含社群字幕）
   */
  function _refreshUserTier(onDone) {
    chrome.runtime.sendMessage({ type: 'fb_getUser' }, res => {
      if (!res?.user) {
        _userTier = 'guest';
        _applyTierGates();
        onDone?.();
        return;
      }
      chrome.runtime.sendMessage({ type: 'fb_checkEditorPermission' }, r => {
        _editorEnabled = r?.enabled === true;
        _userTier = _editorEnabled ? 'editor' : 'user';
        _applyTierGates();
        onDone?.();
      });
    });
  }

  /** 根據 _userTier 更新所有受限 UI */
  function _applyTierGates() {
    _updateEditModeOption();
    // 社群字幕 option：非 editor 顯示鎖頭，但仍可選（選後顯示提示）
    const communityOpt = document.querySelector('#yt-sub-source-select option[value="community"]');
    if (communityOpt) {
      if (_userTier === 'editor') {
        // 由 fetchCommunitySubtitles 決定文字與 disabled 狀態
      } else if (_userTier === 'user') {
        communityOpt.textContent = '🔒 社群字幕（需申請權限）';
        communityOpt.disabled = false;
      } else {
        communityOpt.textContent = '🔒 社群字幕（需登入）';
        communityOpt.disabled = false;
      }
    }
  }

  function _updateEditModeOption() {
    const sel = document.getElementById('yt-sub-mode-select');
    if (!sel) return;
    const editOpt = sel.querySelector('option[value="edit"]');
    if (!editOpt) return;
    if (_editorEnabled) {
      editOpt.textContent = '編輯字幕模式';
      editOpt.disabled = false;
    } else {
      editOpt.textContent = '🔒 編輯字幕模式';
      editOpt.disabled = true;
    }
  }

  /** 在 sidebar 狀態列顯示「需登入才能使用翻譯」提示 */
  function _showTranslationGate() {
    if (customSubtitleActive) return; // 本地/社群字幕使用中，不蓋掉已還原狀態
    const statusEl = document.getElementById('yt-sub-status');
    if (!statusEl) return;
    statusEl.className = 'yt-sub-status';
    statusEl.innerHTML = '翻譯需登入 Google 帳號 <button class="yt-sub-tier-gate-btn" id="yt-sub-tier-login-btn">登入</button>';
    document.getElementById('yt-sub-tier-login-btn')?.addEventListener('click', () => {
      const btn = document.getElementById('yt-sub-account-btn');
      if (btn) btn.click(); // 觸發帳號按鈕登入流程
    });
  }

  /** 退出任何特殊模式（含未儲存確認）。回傳 true 表示成功退出 */
  async function exitSpecialMode() {
    if (_currentMode === 'edit' && _editDirty) {
      const ok = window.confirm('字幕尚未儲存，確定要離開編輯模式？');
      if (!ok) return false;
    }
    if (_currentMode === 'subtitle') exitSubtitleMode();
    if (_currentMode === 'edit')     exitEditMode(true);
    return true;
  }

  // ─── 字幕模式 ───────────────────────────────────────────────

  function enterSubtitleMode() {
    if (_currentMode !== 'default') return;
    _currentMode = 'subtitle';

    const overlay = document.createElement('div');
    overlay.id = 'yt-sub-subtitle-mode';
    overlay.innerHTML = `
      <div class="ysm-left">
        <div class="ysm-video-box" id="ysm-video-box">
          <div class="ysm-video-placeholder" id="ysm-video-placeholder"></div>
          <div class="ysm-video-controls">
            <button class="ysm-ctrl-btn" id="ysm-play-btn">▶</button>
            <input  class="ysm-scrubber" id="ysm-scrubber" type="range" min="0" max="100" step="0.1" value="0">
            <span   class="ysm-time" id="ysm-time">0:00</span>
          </div>
        </div>
        <div class="ysm-video-info">
          <div class="ysm-title" id="ysm-title">${document.title.replace(' - YouTube','')}</div>
        </div>
        <div class="ysm-tools">
          <select class="yt-sub-select" id="ysm-lang-select"></select>
          <label class="ysm-dual-label">
            <input type="checkbox" id="ysm-dual-toggle"> 雙語
          </label>
          <div class="ysm-font-btns">
            <button class="ysm-font-btn" data-delta="-2">A-</button>
            <button class="ysm-font-btn" data-delta="2">A+</button>
          </div>
        </div>
      </div>
      <div class="ysm-main">
        <div class="ysm-search-bar">
          <input class="ysm-search" id="ysm-search" type="text" placeholder="搜尋句子字頭…" autocomplete="off" spellcheck="false">
          <span class="ysm-search-count" id="ysm-search-count"></span>
        </div>
        <div class="ysm-subtitle-list" id="ysm-subtitle-list"></div>
      </div>
      <button class="ysm-close-btn" id="ysm-close-btn" title="還原正常模式">✕</button>
    `;
    document.body.appendChild(overlay);

    // 把真實 video 搬進小窗
    const video = document.querySelector('#movie_player video');
    const placeholder = overlay.querySelector('#ysm-video-placeholder');
    if (video) {
      placeholder.replaceWith(video);
      video.classList.add('ysm-real-video');
    }
    // 隱藏 YouTube player 殼，避免殘留佔版面
    const ytPlayer = document.querySelector('#movie_player');
    if (ytPlayer) ytPlayer.style.setProperty('visibility', 'hidden', 'important');

    // 渲染字幕列表
    _renderSubtitleModeList(overlay.querySelector('#ysm-subtitle-list'));

    // 同步語言選單
    const langSel = overlay.querySelector('#ysm-lang-select');
    const ytLangSel = document.querySelector('#yt-sub-langs select');
    if (ytLangSel) {
      ytLangSel.querySelectorAll('option').forEach(o => langSel.appendChild(o.cloneNode(true)));
      langSel.value = ytLangSel.value || '';
    } else if (customSubtitleActive) {
      // 無 YT 字幕但自定義/社群字幕啟用中：顯示來源標籤
      const srcVal = document.getElementById('yt-sub-source-select')?.value || 'custom';
      _ysmSetCustomLabel(langSel, srcVal);
    }
    langSel.addEventListener('change', () => {
      const srcSel = document.querySelector('#yt-sub-langs select');
      if (srcSel) { srcSel.value = langSel.value; srcSel.dispatchEvent(new Event('change')); }
    });

    // 雙語 toggle
    const dualTog = overlay.querySelector('#ysm-dual-toggle');
    dualTog.checked = settings.dualEnabled;
    dualTog.addEventListener('change', () => {
      settings.dualEnabled = dualTog.checked;
      saveSettings();
      _renderSubtitleModeList(overlay.querySelector('#ysm-subtitle-list'));
    });

    // 字體大小按鈕
    let _ysmFontSize = 18;
    overlay.querySelectorAll('.ysm-font-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _ysmFontSize = Math.max(12, Math.min(36, _ysmFontSize + Number(btn.dataset.delta)));
        overlay.querySelector('#ysm-subtitle-list').style.fontSize = _ysmFontSize + 'px';
      });
    });

    // 搜尋框：字頭前綴過濾
    overlay.querySelector('#ysm-search').addEventListener('input', () => {
      _renderSubtitleModeList(overlay.querySelector('#ysm-subtitle-list'));
    });

    // 播放控制
    const playBtn  = overlay.querySelector('#ysm-play-btn');
    const scrubber = overlay.querySelector('#ysm-scrubber');
    const timeEl   = overlay.querySelector('#ysm-time');
    // 影片已被搬到 ysm-video-box，優先用 .ysm-real-video 抓，再 fallback 到原始 ref
    const _ysmGetVid = () => document.querySelector('.ysm-real-video') || video;

    function _ysmSyncControls() {
      const v = _ysmGetVid();
      if (!v) return;
      playBtn.textContent = v.paused ? '▶' : '⏸';
      scrubber.max = v.duration || 100;
      scrubber.value = v.currentTime;
      const m = Math.floor(v.currentTime / 60);
      const s = Math.floor(v.currentTime % 60).toString().padStart(2, '0');
      timeEl.textContent = `${m}:${s}`;
    }
    playBtn.addEventListener('click', () => {
      const v = _ysmGetVid();
      if (!v) return;
      v.paused ? v.play().catch(() => {}) : v.pause();
    });
    scrubber.addEventListener('input', () => {
      const v = _ysmGetVid();
      if (v) v.currentTime = Number(scrubber.value);
    });
    const _vidRef = _ysmGetVid();
    _ysmTimeUpdateHandler = _ysmSyncControls;
    if (_vidRef) _vidRef.addEventListener('timeupdate', _ysmSyncControls);
    _ysmSyncControls();

    // 高亮 + loop 按鈕視覺同步（只有 active index 變化時才 scroll）
    let _ysmLastActiveIdx = -1;
    _ysmSyncInterval = setInterval(() => {
      const v = _ysmGetVid();
      if (!primarySubtitles.length || !v) return;
      const t = v.currentTime;
      const rows = overlay.querySelectorAll('.ysm-row');
      let activeRow = null;
      let activeIdx = -1;
      rows.forEach(r => {
        const i = Number(r.dataset.idx);
        const sub = primarySubtitles[i];
        if (!sub) return;
        const isActive = t >= sub.startTime && t < sub.startTime + (sub.duration || 5);
        r.classList.toggle('ysm-active', isActive);
        if (isActive) { activeRow = r; activeIdx = i; }
        r.querySelector('.ysm-loop-btn')?.classList.toggle('active', i === loopingIdx);
      });
      // 只在句子切換時才自動捲動，避免鎖住用戶的手動滾動
      if (activeRow && activeIdx !== _ysmLastActiveIdx) {
        _ysmLastActiveIdx = activeIdx;
        activeRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }
    }, 300);

    overlay.querySelector('#ysm-close-btn').addEventListener('click', async () => {
      const exited = await exitSpecialMode();
      if (exited) document.getElementById('yt-sub-mode-select').value = 'default';
    });
  }

  let _ysmSyncInterval = null;

  // 字頭前綴比對：句子中任意一個詞以 query 開頭即視為命中
  function _ysmWordPrefixMatch(text, query) {
    if (!query) return true;
    const q = query.toLowerCase();
    return text.toLowerCase().split(/\s+/).some(w => w.startsWith(q));
  }

  function _renderSubtitleModeList(container) {
    container.innerHTML = '';
    const searchQ = (document.getElementById('ysm-search')?.value || '').trim();
    const countEl = document.getElementById('ysm-search-count');

    // 過濾：有搜尋詞時只顯示命中的句子
    const filtered = searchQ
      ? primarySubtitles.map((sub, i) => ({ sub, i })).filter(({ sub }) => _ysmWordPrefixMatch(filterSubText(sub.text), searchQ))
      : primarySubtitles.map((sub, i) => ({ sub, i }));

    if (countEl) {
      countEl.textContent = searchQ ? `${filtered.length} / ${primarySubtitles.length} 句` : '';
    }

    filtered.forEach(({ sub, i }) => {
      const row = document.createElement('div');
      row.className = 'ysm-row';
      row.dataset.idx = i;

      const tsEl = document.createElement('span');
      tsEl.className = 'ysm-ts';
      tsEl.textContent = _fmtTime(sub.startTime);

      const texts = document.createElement('div');
      texts.className = 'ysm-texts';

      const primEl = document.createElement('div');
      primEl.className = 'ysm-primary';
      // 使用 buildTokenizedText 開啟生字卡功能
      buildTokenizedText(primEl, filterSubText(sub.text), sub.startTime);
      texts.appendChild(primEl);

      if (settings.dualEnabled && secondarySubtitles[i]) {
        const secEl = document.createElement('div');
        secEl.className = 'ysm-secondary';
        secEl.textContent = filterSubText(secondarySubtitles[i].text) || '';
        texts.appendChild(secEl);
      }

      const loopBtn = document.createElement('button');
      loopBtn.className = 'ysm-loop-btn' + (i === loopingIdx ? ' active' : '');
      loopBtn.title = i === loopingIdx ? '停止循環' : '循環此句';
      loopBtn.textContent = '⇄';

      row.appendChild(tsEl);
      row.appendChild(texts);
      row.appendChild(loopBtn);

      // 取得字幕模式下的影片元素（已搬離 #movie_player）
      const _getV = () => document.querySelector('.ysm-real-video') || document.querySelector('video');

      // 點擊 loop 按鈕：切換循環（再次點擊取消）
      loopBtn.addEventListener('click', e => {
        e.stopPropagation();
        const v = _getV();
        if (loopingIdx === i) {
          loopingIdx = -1;
        } else {
          loopingIdx = i;
          if (v) { v.currentTime = sub.startTime; v.play().catch(() => {}); }
        }
        updateCurrentLoopStyle();
      });

      // 點擊 timestamp：跳轉到該句
      tsEl.addEventListener('click', e => {
        e.stopPropagation();
        const v = _getV();
        if (v) v.currentTime = sub.startTime;
      });

      // 點擊列背景（非按鈕、非單字、非 timestamp）：跳轉到該句
      row.addEventListener('click', e => {
        if (e.target.closest('.ysm-loop-btn, .yt-sub-word, .ysm-ts')) return;
        const v = _getV();
        if (v) v.currentTime = sub.startTime;
      });

      container.appendChild(row);
    });
  }

  function _fmtTime(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60).toString().padStart(2, '0');
    return `${m}:${s}`;
  }

  function exitSubtitleMode() {
    clearInterval(_ysmSyncInterval);
    _ysmSyncInterval = null;
    // 移除 timeupdate handler，避免退出後繼續執行
    if (_ysmTimeUpdateHandler) {
      const v = document.querySelector('.ysm-real-video') || document.querySelector('video');
      v?.removeEventListener('timeupdate', _ysmTimeUpdateHandler);
      _ysmTimeUpdateHandler = null;
    }
    // 把 video 歸還給 YouTube player，並恢復 player 可見度
    const video = document.querySelector('.ysm-real-video');
    const player = document.querySelector('#movie_player');
    if (video) {
      video.classList.remove('ysm-real-video');
      if (player) player.appendChild(video);
    }
    if (player) player.style.removeProperty('visibility');
    document.getElementById('yt-sub-subtitle-mode')?.remove();
    _currentMode = 'default';
  }

  // ─── 編輯字幕模式 ────────────────────────────────────────────

  let _editSubtitles = []; // 目前編輯中的字幕陣列（deep copy）

  function enterEditMode() {
    if (_currentMode !== 'default') return;
    _currentMode = 'edit';
    _editDirty   = false;
    _editSubtitles = primarySubtitles.map(s => ({ ...s }));

    const overlay = document.createElement('div');
    overlay.id = 'yt-sub-edit-mode';
    overlay.innerHTML = `
      <div class="yem-left">
        <div class="yem-video-wrap" id="yem-video-wrap">
          <div class="yem-video-placeholder" id="yem-video-placeholder"></div>
        </div>
        <div class="yem-controls">
          <button class="yem-ctrl-btn" id="yem-play-btn">▶</button>
          <input  class="yem-scrubber"  id="yem-scrubber" type="range" min="0" max="100" step="0.01" value="0">
          <span   class="yem-time"      id="yem-time">0:00.000</span>
        </div>
      </div>
      <div class="yem-right">
        <div class="yem-toolbar">
          <button class="yem-tool-btn" id="yem-save-btn">💾 儲存本地</button>
          <button class="yem-tool-btn" id="yem-share-btn">🌐 分享社群</button>
          <button class="yem-tool-btn" id="yem-export-btn">📤 匯出 SRT</button>
          <button class="yem-tool-btn" id="yem-loop-btn">⇄ 循環</button>
          <button class="yem-tool-btn yem-back-btn" id="yem-back-btn">← 返回</button>
          <span class="yem-dirty-badge" id="yem-dirty-badge" style="display:none">● 未儲存</span>
        </div>
        <div class="yem-options-bar">
          <label class="yem-toggle-label"><input type="checkbox" id="yem-auto-pause" checked> 自動暫停</label>
          <div class="yem-shift-group">
            <span class="yem-shift-label">時間平移</span>
            <input type="number" id="yem-shift-input" class="yt-sub-num-input" step="0.1" value="0" placeholder="s">
            <span class="yem-shift-unit">s</span>
            <button id="yem-shift-btn" class="yem-shift-apply-btn">套用</button>
          </div>
        </div>
        <div class="yem-rows" id="yem-rows"></div>
        <button class="yem-add-btn" id="yem-add-btn">＋ 新增字幕句</button>
      </div>
    `;
    document.body.appendChild(overlay);

    // 搬移 video，隱藏 player 殼
    const video = document.querySelector('#movie_player video');
    const placeholder = overlay.querySelector('#yem-video-placeholder');
    if (video) { placeholder.replaceWith(video); video.classList.add('yem-real-video'); }
    const ytPlayerEm = document.querySelector('#movie_player');
    if (ytPlayerEm) ytPlayerEm.style.setProperty('visibility', 'hidden', 'important');

    const vid = document.querySelector('.yem-real-video') || document.querySelector('#movie_player video');

    // 播放控制
    const playBtn  = overlay.querySelector('#yem-play-btn');
    const scrubber = overlay.querySelector('#yem-scrubber');
    const timeEl   = overlay.querySelector('#yem-time');
    function _yemFmtMs(sec) {
      const m = Math.floor(sec / 60);
      const s = Math.floor(sec % 60).toString().padStart(2, '0');
      const ms = Math.floor((sec % 1) * 1000).toString().padStart(3, '0');
      return `${m}:${s}.${ms}`;
    }
    function _yemSync() {
      if (!vid) return;
      playBtn.textContent = vid.paused ? '▶' : '⏸';
      scrubber.max = vid.duration || 100;
      scrubber.value = vid.currentTime;
      timeEl.textContent = _yemFmtMs(vid.currentTime);
    }
    playBtn.addEventListener('click', () => vid?.paused ? vid.play() : vid?.pause());
    scrubber.addEventListener('input', () => { if (vid) vid.currentTime = Number(scrubber.value); });
    // 1. 點擊影片區域暫停/播放
    overlay.querySelector('#yem-video-wrap').addEventListener('click', e => {
      if (e.target === scrubber || e.target === playBtn) return;
      vid?.paused ? vid.play() : vid?.pause();
    });
    _yemSyncHandler = _yemSync;
    if (vid) vid.addEventListener('timeupdate', _yemSyncHandler);
    _yemSync();

    // 3. 循環鈕狀態
    _focusedRow    = -1;
    _loopActive    = false;
    _loopTimeoutId = null;
    const loopBtn = overlay.querySelector('#yem-loop-btn');

    function _setLoopActive(active) {
      _loopActive = active;
      loopBtn.classList.toggle('yem-loop-active', active);
      loopBtn.textContent = active ? '⇄ 循環中' : '⇄ 循環';
      if (!active) { clearTimeout(_loopTimeoutId); _loopTimeoutId = null; }
    }

    loopBtn.addEventListener('click', () => _setLoopActive(!_loopActive));

    // 時間平移
    overlay.querySelector('#yem-shift-btn')?.addEventListener('click', () => {
      const delta = parseFloat(overlay.querySelector('#yem-shift-input')?.value || 0);
      if (!isFinite(delta) || delta === 0) return;
      _editSubtitles = _editSubtitles.map(s => ({
        ...s,
        startTime: Math.max(0, s.startTime + delta),
        endTime:   s.endTime != null ? Math.max(0, s.endTime + delta) : undefined,
      }));
      _markDirty(overlay);
      _renderEditRows(overlay, vid);
    });

    // timeupdate：循環 + 自動暫停 + focus 跟隨播放
    if (vid) {
      _yemMainHandler = () => {
        if (_currentMode !== 'edit') return; // 已離開編輯模式時自我保護
        const t = vid.currentTime;

        // --- focus 跟隨播放：找出目前播放中的字幕行並更新 focus ---
        const playingIdx = _editSubtitles.findIndex(s => {
          const end = s.endTime ?? s.startTime + 2;
          return t >= s.startTime && t < end;
        });
        if (playingIdx >= 0 && playingIdx !== _focusedRow) {
          _focusedRow = playingIdx;
          overlay.querySelectorAll('.yem-row').forEach((r, i) => r.classList.toggle('yem-focused', i === playingIdx));
          overlay.querySelector(`.yem-row[data-idx="${playingIdx}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }

        // --- 循環邏輯 ---
        if (_loopActive && _focusedRow >= 0) {
          const sub = _editSubtitles[_focusedRow];
          if (sub) {
            const endTime = sub.endTime ?? sub.startTime + 2;
            if (t >= endTime && !_loopTimeoutId) {
              vid.pause();
              const interval = settings.loopInterval ?? 0.5;
              _loopTimeoutId = setTimeout(() => {
                _loopTimeoutId = null;
                if (_loopActive) { vid.currentTime = sub.startTime; vid.play(); }
              }, interval * 1000);
            }
          }
          return;
        }

        // --- 自動暫停：播完聚焦句自動暫停 ---
        const autoPause = overlay.querySelector('#yem-auto-pause')?.checked;
        if (autoPause && _focusedRow >= 0 && !vid.paused) {
          const sub = _editSubtitles[_focusedRow];
          if (sub) {
            const endTime = sub.endTime ?? sub.startTime + 2;
            if (t >= endTime) vid.pause();
          }
        }
      };
      vid.addEventListener('timeupdate', _yemMainHandler);
    }

    _renderEditRows(overlay, vid);

    // 2. 聚焦 row → seek 到該句起始並播放
    overlay.querySelector('#yem-rows').addEventListener('focusin', e => {
      const row = e.target.closest('.yem-row');
      if (!row) return;
      _focusedRow = Number(row.dataset.idx);
      if (vid) {
        const sub = _editSubtitles[_focusedRow];
        if (sub) {
          vid.currentTime = sub.startTime;
          vid.play();
        }
      }
      clearTimeout(_loopTimeoutId); _loopTimeoutId = null;
      overlay.querySelectorAll('.yem-row').forEach(r => r.classList.toggle('yem-focused', r === row));
    });

    // 離開 row focus → 依 startTime 重新排序（只在 focus 真正離開 row 時觸發）
    overlay.querySelector('#yem-rows').addEventListener('focusout', e => {
      const row = e.target.closest('.yem-row');
      if (!row) return;
      if (row.contains(e.relatedTarget)) return; // focus 在同 row 內移動
      const focusedSub = _focusedRow >= 0 ? _editSubtitles[_focusedRow] : null;
      _editSubtitles.sort((a, b) => a.startTime - b.startTime);
      if (focusedSub) _focusedRow = _editSubtitles.indexOf(focusedSub);
      _renderEditRows(overlay, vid);
    });

    // 新增字幕句（插入聚焦列下方）
    overlay.querySelector('#yem-add-btn').addEventListener('click', () => {
      const insertAfter = _focusedRow >= 0 ? _focusedRow : _editSubtitles.length - 1;
      const prev = _editSubtitles[insertAfter];
      const next = _editSubtitles[insertAfter + 1];
      const startTime = prev ? (prev.endTime ?? prev.startTime + 2) : 0;
      const endTime   = next ? next.startTime : startTime + 2;
      _editSubtitles.splice(insertAfter + 1, 0, { text: '', startTime, endTime });
      secondarySubtitles.splice(insertAfter + 1, 0, { text: '', startTime, duration: endTime - startTime });
      _focusedRow = insertAfter + 1;
      _markDirty(overlay);
      _renderEditRows(overlay, vid);
      // 聚焦新 row 的主字幕輸入框
      setTimeout(() => {
        const rows = overlay.querySelectorAll('.yem-row');
        rows[_focusedRow]?.querySelector('.yem-primary-input')?.focus();
      }, 50);
    });

    // 儲存本地
    overlay.querySelector('#yem-save-btn').addEventListener('click', () => {
      primarySubtitles = _editSubtitles.map(s => ({ ...s }));
      chrome.storage.local.set({ [`editedSubtitles_${new URLSearchParams(location.search).get('v')}`]: { primarySubtitles: primarySubtitles, secondarySubtitles: secondarySubtitles.map(s => ({ ...s })) } });
      renderSubtitleList();
      startSync();
      setActiveSourceBtn('custom');
      _editDirty = false;
      overlay.querySelector('#yem-dirty-badge').style.display = 'none';
      const st = document.getElementById('yt-sub-status');
      if (st) { st.textContent = '自定義字幕（已儲存）'; st.className = 'yt-sub-status success'; }
    });

    // 分享到社群
    overlay.querySelector('#yem-share-btn').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'fb_getUser' }, res => {
        const user = res?.user;
        if (!user) { alert('請先登入 Google 帳號才能分享字幕。'); return; }

        const videoId = new URLSearchParams(location.search).get('v') || '';
        if (!videoId) { alert('無法取得影片 ID。'); return; }

        // 建立分享 dialog
        const backdrop = document.createElement('div');
        backdrop.className = 'yem-share-backdrop';
        backdrop.innerHTML = `
          <div class="yem-share-dialog">
            <div class="yem-share-title">🌐 分享字幕到社群</div>
            <div class="yem-share-row">
              <label class="yem-share-label">作者名稱</label>
              <input class="yem-share-input" id="yem-share-author" type="text" placeholder="${user.displayName || user.email}" value="${user.displayName || ''}">
            </div>
            <div class="yem-share-row">
              <label class="yem-share-label">字幕名稱</label>
              <input class="yem-share-input" id="yem-share-name" type="text" placeholder="（選填）">
            </div>
            <div class="yem-share-actions">
              <button class="yem-share-cancel">取消</button>
              <button class="yem-share-confirm">確認分享</button>
            </div>
          </div>
        `;
        overlay.appendChild(backdrop);

        backdrop.querySelector('.yem-share-cancel').addEventListener('click', () => backdrop.remove());
        backdrop.querySelector('.yem-share-confirm').addEventListener('click', () => {
          const author = backdrop.querySelector('#yem-share-author').value.trim() || user.displayName || user.email;
          const name   = backdrop.querySelector('#yem-share-name').value.trim() || '未命名';
          const ps = _editSubtitles.map(s => ({ ...s }));
          const ss = secondarySubtitles.map(s => ({ ...s }));
          chrome.runtime.sendMessage({
            type: 'fb_shareSubtitle',
            videoId,
            authorName: author,
            subtitleName: name,
            primarySubtitles: ps,
            secondarySubtitles: ss,
          }, resp => {
            backdrop.remove();
            if (resp?.ok) {
              alert('分享成功！感謝您的貢獻。');
            } else {
              alert(`分享失敗：${resp?.error || '未知錯誤'}`);
            }
          });
        });
      });
    });

    // 匯出 SRT
    overlay.querySelector('#yem-export-btn').addEventListener('click', () => {
      let srt = '';
      _editSubtitles.forEach((s, i) => {
        const fmt = t => {
          const h  = Math.floor(t / 3600).toString().padStart(2, '0');
          const m  = Math.floor((t % 3600) / 60).toString().padStart(2, '0');
          const sc = Math.floor(t % 60).toString().padStart(2, '0');
          const ms = Math.floor((t % 1) * 1000).toString().padStart(3, '0');
          return `${h}:${m}:${sc},${ms}`;
        };
        srt += `${i + 1}\n${fmt(s.startTime)} --> ${fmt(s.endTime ?? s.startTime + 2)}\n${s.text}\n\n`;
      });
      const blob = new Blob([srt], { type: 'text/plain' });
      const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: 'subtitles.srt' });
      a.click();
    });

    // 返回
    overlay.querySelector('#yem-back-btn').addEventListener('click', async () => {
      const exited = await exitSpecialMode();
      if (exited) document.getElementById('yt-sub-mode-select').value = 'default';
    });
  }

  function _markDirty(overlay) {
    _editDirty = true;
    overlay.querySelector('#yem-dirty-badge').style.display = '';
  }

  function _renderEditRows(overlay, vid) {
    const container = overlay.querySelector('#yem-rows');
    container.innerHTML = '';
    _editSubtitles.forEach((sub, i) => {
      const row = document.createElement('div');
      row.className = 'yem-row' + (i === _focusedRow ? ' yem-focused' : '');
      row.dataset.idx = i;
      row.innerHTML = `
        <div class="yem-ts-block">
          <div class="yem-ts-row">
            <input class="yem-ts-input" data-field="startTime" value="${_yemFmtTs(sub.startTime)}" placeholder="0:00.000">
            <button class="yem-grab-btn" data-field="startTime" title="對齊前一句結尾" ${i === 0 ? 'disabled' : ''}>⌚</button>
          </div>
          <div class="yem-ts-row">
            <input class="yem-ts-input" data-field="endTime" value="${_yemFmtTs(sub.endTime ?? sub.startTime + 2)}" placeholder="0:00.000">
            <button class="yem-grab-btn" data-field="endTime" title="對齊後一句結尾" ${i === _editSubtitles.length - 1 ? 'disabled' : ''}>⌚</button>
          </div>
        </div>
        <textarea class="yem-primary-input" placeholder="主字幕" rows="1">${sub.text || ''}</textarea>
        <textarea class="yem-secondary-input" placeholder="副字幕" rows="1">${secondarySubtitles[i]?.text || ''}</textarea>
        <button class="yem-del-btn" title="刪除此句">×</button>
      `;

      // 時間戳防呆：回傳 true 表示合法，false 表示超出相鄰字幕範圍
      function _tsValid(field, val) {
        if (!isFinite(val) || val < 0) return false;
        if (field === 'startTime') {
          const prevEnd = i > 0 ? (_editSubtitles[i - 1].endTime ?? _editSubtitles[i - 1].startTime + 2) : 0;
          if (val < prevEnd) return false;
          const curEnd = _editSubtitles[i].endTime;
          if (curEnd != null && val >= curEnd) return false;
        } else {
          const nextStart = i < _editSubtitles.length - 1 ? _editSubtitles[i + 1].startTime : Infinity;
          if (val >= nextStart) return false;
          if (val <= _editSubtitles[i].startTime) return false;
        }
        return true;
      }

      // 時間戳輸入
      row.querySelectorAll('.yem-ts-input').forEach(inp => {
        inp.addEventListener('change', () => {
          const field = inp.dataset.field;
          const parsed = _yemParseTs(inp.value);
          if (!_tsValid(field, parsed)) {
            inp.value = _yemFmtTs(_editSubtitles[i][field]);
            return;
          }
          _editSubtitles[i][field] = parsed;
          _markDirty(overlay);
        });
      });

      // ⌚ 按鈕：頭→對齊前句結尾，尾→對齊後句結尾
      row.querySelectorAll('.yem-grab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          const field = btn.dataset.field;
          const tsInp = btn.closest('.yem-ts-row').querySelector('.yem-ts-input');
          let t;
          if (field === 'startTime') {
            if (i === 0) return;
            const prev = _editSubtitles[i - 1];
            t = prev.endTime ?? prev.startTime + 2;
            if (t >= (_editSubtitles[i].endTime ?? Infinity)) return;
          } else {
            if (i >= _editSubtitles.length - 1) return;
            t = _editSubtitles[i + 1].startTime;
            if (t <= _editSubtitles[i].startTime) return;
          }
          _editSubtitles[i][field] = t;
          tsInp.value = _yemFmtTs(t);
          _markDirty(overlay);
        });
      });

      // 主字幕輸入
      const primaryTa = row.querySelector('.yem-primary-input');
      primaryTa.addEventListener('input', e => {
        _editSubtitles[i].text = e.target.value;
        _yemAutoResize(e.target);
        _markDirty(overlay);
      });

      // 副字幕輸入
      const secondaryTa = row.querySelector('.yem-secondary-input');
      secondaryTa.addEventListener('input', e => {
        if (!secondarySubtitles[i]) secondarySubtitles[i] = { text: '' };
        secondarySubtitles[i].text = e.target.value;
        _yemAutoResize(e.target);
        _markDirty(overlay);
      });

      // 刪除
      row.querySelector('.yem-del-btn').addEventListener('click', () => {
        _editSubtitles.splice(i, 1);
        secondarySubtitles.splice(i, 1);
        if (_focusedRow >= _editSubtitles.length) _focusedRow = _editSubtitles.length - 1;
        _markDirty(overlay);
        _renderEditRows(overlay, vid);
      });

      container.appendChild(row);

      // 兩句之間的合併按鈕
      if (i < _editSubtitles.length - 1) {
        const mergeBar = document.createElement('div');
        mergeBar.className = 'yem-merge-bar';
        mergeBar.innerHTML = `<button class="yem-merge-btn" title="合併上下兩句">＋</button>`;
        mergeBar.querySelector('.yem-merge-btn').addEventListener('click', () => {
          const sA = _editSubtitles[i];
          const sB = _editSubtitles[i + 1];
          sA.text    = [sA.text, sB.text].filter(Boolean).join('\n');
          sA.endTime = sB.endTime ?? sB.startTime + 2;
          _editSubtitles.splice(i + 1, 1);
          // 合併副字幕（保留上句，若上句為空則取下句）
          if (secondarySubtitles[i] && secondarySubtitles[i + 1]) {
            secondarySubtitles[i].text = secondarySubtitles[i].text || secondarySubtitles[i + 1].text;
          }
          secondarySubtitles.splice(i + 1, 1);
          if (_focusedRow > i) _focusedRow = Math.max(0, _focusedRow - 1);
          _markDirty(overlay);
          _renderEditRows(overlay, vid);
        });
        container.appendChild(mergeBar);
      }
    });
    // 所有 row 進 DOM 後，才能正確讀到 scrollHeight
    requestAnimationFrame(() => {
      container.querySelectorAll('.yem-primary-input, .yem-secondary-input').forEach(_yemAutoResize);
    });
  }

  function _yemAutoResize(ta) {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  function _yemFmtTs(sec) {
    if (sec == null || isNaN(sec)) return '0:00.000';
    const m  = Math.floor(sec / 60);
    const s  = Math.floor(sec % 60).toString().padStart(2, '0');
    const ms = Math.floor((sec % 1) * 1000).toString().padStart(3, '0');
    return `${m}:${s}.${ms}`;
  }

  function _yemParseTs(str) {
    const parts = str.split(':');
    if (parts.length === 2) {
      const [m, s] = parts;
      return Number(m) * 60 + Number(s);
    }
    return Number(str) || 0;
  }

  function exitEditMode(force = false) {
    // 移除編輯模式加的 timeupdate handler，防止退出後繼續暫停影片
    const vidEl = document.querySelector('.yem-real-video') || document.querySelector('#movie_player video');
    if (vidEl) {
      if (_yemSyncHandler)  { vidEl.removeEventListener('timeupdate', _yemSyncHandler);  _yemSyncHandler = null; }
      if (_yemMainHandler)  { vidEl.removeEventListener('timeupdate', _yemMainHandler);  _yemMainHandler = null; }
    }
    // 重置循環/自動暫停狀態，避免殘留
    _loopActive    = false;
    _focusedRow    = -1;
    if (_loopTimeoutId) { clearTimeout(_loopTimeoutId); _loopTimeoutId = null; }

    // 把 video 歸還給 YouTube
    const video = document.querySelector('.yem-real-video');
    if (video) {
      video.classList.remove('yem-real-video');
      const player = document.querySelector('#movie_player');
      if (player) { player.appendChild(video); player.style.removeProperty('visibility'); }
    }
    document.getElementById('yt-sub-edit-mode')?.remove();
    _editDirty   = false;
    _currentMode = 'default';
  }

  function removeOverlay() {
    document.getElementById('yt-sub-overlay')?.remove();
  }

  function updateOverlay(primText, secText, primIdx = -1) {
    const ovPrim = document.getElementById('yt-sub-ov-primary');
    const ovSec = document.getElementById('yt-sub-ov-secondary');
    if (ovPrim) {
      // 只有文字改變時才重建 tokenize，避免 hover 閃爍
      if (ovPrim.dataset.text !== primText) {
        ovPrim.dataset.text = primText;
        ovPrim.innerHTML = '';
        if (primText) buildTokenizedText(ovPrim, primText, primarySubtitles[primIdx]?.startTime ?? 0);
      }
    }
    if (ovSec && ovSec.dataset.text !== (secText || '')) {
      ovSec.dataset.text = secText || '';
      ovSec.textContent = secText || '';
    }
    updateOverlayLoopStyle();
  }

  // ===== 同步高亮 =====
  let _seekHandler = null;
  function startSync() {
    if (syncInterval) clearInterval(syncInterval);
    _lastSyncPrimIdx = -2; // 重置快取，確保新影片第一幀立即更新列表

    // 字幕同步啟動 → LED 確認進入 has-sub（video 可能已在播放中）
    const videoCheck = document.querySelector('video');
    if (videoCheck && videoCheck.paused) setLedState('paused');
    else setLedState('has-sub');

    // 偵測跳轉：若外部翻譯進行中，跳到未翻譯區域時重新翻譯
    const video = document.querySelector('video');
    if (video && _seekHandler) video.removeEventListener('seeked', _seekHandler);
    if (video) {
      // 暫停/播放 → 更新 LED 狀態
      video.addEventListener('pause', () => { if (primarySubtitles.length) setLedState('paused'); });
      video.addEventListener('playing', () => { if (primarySubtitles.length) setLedState('has-sub'); });

      _seekHandler = () => {
        if (settings.translationProvider === 'ytlang') return;
        const t = video.currentTime;
        // 目前時間點後 60 秒內沒有翻譯結果，才重新觸發
        const hasCoverage = secondarySubtitles.some(s => s.startTime >= t && s.startTime < t + 60);
        if (!hasCoverage && pendingTranslation === null) {
          const priorities = (settings.secondaryLangs || []).filter(l => l && l !== '__none__');
          if (priorities.length) {
            const lang = priorities[0].startsWith('tlang:') ? priorities[0].slice(6) : priorities[0];
            translateAndSetSecondary(primarySubtitles, lang, t);
          }
        }
      };
      video.addEventListener('seeked', _seekHandler);
    }

    syncInterval = setInterval(() => {
      const video = document.querySelector('video');
      if (!video || !primarySubtitles.length) return;

      const t = video.currentTime;
      const tSub = t + (settings.subtitleOffset || 0); // 套用使用者設定的時間偏移
      const primIdx = findActiveIndex(primarySubtitles, tSub);
      const primSub = primIdx >= 0 ? primarySubtitles[primIdx] : null;
      // 用 startTime + 0.1 而非 midpoint，避免 extendSubtitles 拉長 duration 後
      // midpoint 跑到 secondary subtitle 的時間範圍之外
      const secSub = primSub
        ? findSubAtTime(secondarySubtitles, primSub.startTime + 0.1)
        : null;

      const curPrimEl = document.getElementById('yt-sub-cur-primary');
      const curSecEl = document.getElementById('yt-sub-cur-secondary');
      const curWrap = document.getElementById('yt-sub-current');
      const secText = secSub && settings.dualEnabled ? filterSubText(secSub.text) : '';
      const wrapActive = primSub !== null || (secSub !== null && settings.dualEnabled);

      if (curPrimEl) {
        const newText = primSub ? filterSubText(primSub.text) : '';
        if (curPrimEl.dataset.text !== newText) {
          curPrimEl.dataset.text = newText;
          curPrimEl.innerHTML = '';
          if (newText) buildTokenizedText(curPrimEl, newText, primSub?.startTime ?? 0);
        }
      }
      // 只有文字改變時才寫入，避免每 100ms 觸發 layout
      if (curSecEl && curSecEl.dataset.text !== secText) {
        curSecEl.dataset.text = secText;
        curSecEl.textContent = secText;
      }
      if (curWrap && curWrap.dataset.active !== String(wrapActive)) {
        curWrap.dataset.active = String(wrapActive);
        curWrap.classList.toggle('active', wrapActive);
      }
      updateCurrentLoopStyle();

      // 單句循環：不依賴 primSub，句子間空隙也能正確 loop 回去
      if (settings.loopSentence && loopingIdx >= 0) {
        const loopSub = primarySubtitles[loopingIdx];
        if (loopSub && t >= loopSub.startTime + Math.max(loopSub.duration || 0, 1)) {
          video.currentTime = loopSub.startTime;
        }
      }

      // 更新目前顯示的 index
      if (Date.now() < _navLockUntil) {
        // 導航鎖定中（seek async 尚未完成）：顯示目標句，不讓 video.currentTime 蓋掉
        _currentPrimIdx = _navLockedIdx;
      } else {
        // 鎖定結束：解除並恢復正常追蹤
        if (_navLockedIdx >= 0) _navLockedIdx = -1;
        if (_navedToIdx >= 0) {
          // 舊的 forward-seek 鎖（其他地方設的 _navedToIdx）：等 video 抵達後解鎖
          const navTarget = primarySubtitles[_navedToIdx];
          if (navTarget && tSub >= navTarget.startTime) {
            _currentPrimIdx = Math.max(primIdx >= 0 ? primIdx : _navedToIdx, _navedToIdx);
            _navedToIdx = -1;
          }
        } else if (primIdx >= 0) {
          _currentPrimIdx = primIdx;
        }
      }

      if (settings.overlayEnabled) {
        if (!document.getElementById('yt-sub-overlay')) createOverlay();
        updateOverlay(
          primSub ? filterSubText(primSub.text) : '',
          secText,
          primIdx
        );
      }

      // hover 時凍結高亮與捲動；index 沒有改變時跳過整個列表更新
      if (!_listHovering && primIdx !== _lastSyncPrimIdx) {
        _lastSyncPrimIdx = primIdx;
        const items = document.getElementById('yt-sub-list')?.children;
        if (items) {
          for (let i = 0; i < items.length; i++) {
            const active = i === primIdx;
            items[i].classList.toggle('active', active);
          }
          // scrollIntoView 只在 index 變化時觸發一次，避免每 100ms 重複驅動 smooth scroll
          if (primIdx >= 0 && settings.autoScroll) {
            items[primIdx]?.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }
      }
    }, 100);
  }

  function findActiveIndex(subs, time) {
    // 從尾部往前找，回傳 startTime 最新且仍在有效範圍的 index
    // 當兩句字幕時間重疊（如 extendSubtitleDurations 造成），優先回傳較新的那句
    for (let i = subs.length - 1; i >= 0; i--) {
      if (time >= subs[i].startTime && time < subs[i].startTime + subs[i].duration) {
        return i;
      }
    }
    return -1;
  }

  // 導航用：找「已開始播放」的最後一句（startTime ≤ time），不管 duration
  // 用於 >/<  按鈕，直接從 video.currentTime 即時計算，不依賴 sync loop 快取
  function findLastStartedIndex(subs, time) {
    for (let i = subs.length - 1; i >= 0; i--) {
      if (subs[i].startTime <= time) return i;
    }
    return 0;
  }

  function seekTo(time) {
    const video = document.querySelector('video');
    if (video) video.currentTime = time;
  }

  // ===== 延長字幕顯示 =====
  // 將每句字幕的結束時間延伸到下一句開始前（填滿字幕間的空白間隔）
  // 不修改原陣列，回傳新陣列
  function extendSubtitleDurations(subs) {
    if (!subs.length) return subs;
    return subs.map((sub, i) => {
      const next = subs[i + 1];
      if (!next) return sub; // 最後一句不延伸
      const currentEnd = sub.startTime + sub.duration;
      const gap = next.startTime - currentEnd;
      if (gap <= 0) return sub; // 無間隔或已重疊，保留原始
      // 延伸到下一句開始前 50ms（緩衝避免閃爍），但不縮短原始 duration
      const extended = next.startTime - sub.startTime - 0.05;
      return { ...sub, duration: Math.max(sub.duration, extended) };
    });
  }

  // ===== 工具 =====

  function isVowel(c) { return 'aeiou'.includes(c); }
  function isConsonant(c) { return /^[a-z]$/.test(c) && !isVowel(c); }

  // 英文詞形還原：將屈折形（shining/walked/runs）還原為原型（shine/walk/run）
  function lemmatize(word) {
    if (word.length <= 3) return word;

    // -ied → -y（tried→try, carried→carry）
    if (word.endsWith('ied') && word.length > 4) return word.slice(0, -3) + 'y';

    // -ing（現在分詞/動名詞）
    if (word.endsWith('ing') && word.length >= 5) {
      const s = word.slice(0, -3);
      // 重複字尾輔音：running→run, sitting→sit
      if (s.length >= 2 && isConsonant(s.at(-1)) && s.at(-1) === s.at(-2))
        return s.slice(0, -1);
      // 字尾為「輔音-母音-輔音」模式，原形有被省略的 e：shining→shine, making→make
      if (s.length >= 3 && isConsonant(s.at(-1)) && isVowel(s.at(-2)) && isConsonant(s.at(-3)))
        return s + 'e';
      // 一般情況：walking→walk, talking→talk
      return s;
    }

    // -ed（過去式/過去分詞）
    if (word.endsWith('ed') && word.length > 4) {
      const s = word.slice(0, -2);
      // 重複字尾輔音：stopped→stop, planned→plan
      if (s.length >= 2 && isConsonant(s.at(-1)) && s.at(-1) === s.at(-2))
        return s.slice(0, -1);
      // 省略 e：loved→love, placed→place
      if (s.length >= 3 && isConsonant(s.at(-1)) && isVowel(s.at(-2)) && isConsonant(s.at(-3)))
        return s + 'e';
      // 一般情況：walked→walk, looked→look
      return s;
    }

    // -ies → -y（flies→fly, tries→try）
    if (word.endsWith('ies') && word.length > 4) return word.slice(0, -3) + 'y';

    // -s（複數/第三人稱，不處理 -es 避免 goes/does 等不規則形）
    if (word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('es') && word.length >= 4)
      return word.slice(0, -1); // runs→run, eats→eat, cats→cat

    return word;
  }

  function formatTime(s) {
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ===== 訊息監聽 =====
  let captionsDebounce = null;
  // 當使用自定義或社群字幕時，略過來自 YT 的字幕資料
  let customSubtitleActive = false;
  window.addEventListener('message', function (event) {
    if (event.data?.type === 'YT_SUBTITLE_DEMO_CAPTIONS') {
      clearTimeout(captionsDebounce);
      captionsDebounce = setTimeout(() => renderLanguages(event.data.data), 100);
    }

    if (event.data?.type === 'YT_SUBTITLE_DEMO_SUBTITLE_DATA') {
      // 使用自定義或社群字幕時，略過 YT 字幕資料，避免覆蓋
      if (customSubtitleActive) return;

      const tag = event.data.tag || 'primary';
      const statusEl = document.getElementById('yt-sub-status');

      // relay 確認收到
      // window.__dbgSend?.(`[content:recv] tag=${tag} error=${event.data.error || '—'} parsed=${event.data.parsed?.length ?? 'null'}`);

      if (event.data.error) {
        if (tag === 'primary' && statusEl) {
          statusEl.textContent = `載入失敗：${event.data.error}`;
          statusEl.className = 'yt-sub-status error';
        } else if (tag === 'secondary' && settings.translationProvider === 'ytlang') {
          // ytlang 次要字幕載入失敗，fallback 到 Google Translate
          const priorities = (settings.secondaryLangs || []).filter(l => l && l !== '__none__');
          if (priorities.length) {
            const lang = priorities[0].startsWith('tlang:') ? priorities[0].slice(6) : priorities[0];
            console.log('[YT-SUB][DUAL] ytlang error → fallback Google Translate, lang=', lang, 'primaryLen=', primarySubtitles.length);
            if (primarySubtitles.length) {
              translateAndSetSecondary(primarySubtitles, lang);
            } else {
              // primary 尚未載入，等 primary 載完後翻
              pendingTranslation = { targetLang: lang };
            }
          }
        }
        return;
      }

      // inject.js 已預先解析成精簡格式 { s, d, t }，直接轉換
      const parsed = event.data.parsed
        ? event.data.parsed.map(e => ({ startTime: e.s, duration: e.d, text: e.t }))
        : parseJson3(event.data.data);

      if (tag === 'primary') {
        if (!customSubtitleActive) {
          // 本地/社群字幕啟用中，不讓 YouTube 字幕覆蓋
          _rawPrimarySubtitles = parsed;
          primarySubtitles = settings.extendSubtitles ? extendSubtitleDurations(parsed) : parsed;
        }
        applyOverlay(); // 有字幕了，啟用 overlay 並隱藏原生字幕
        if (customSubtitleActive) {
          // 本地字幕已在位，不更新狀態文字和翻譯流程
          renderSubtitleList();
          startSync();
          return;
        }
        if (pendingPrimaryTranslation) {
          // 主字幕 Google Translate 路徑：原語言已載，開始翻譯成偏好語言
          const { targetLang } = pendingPrimaryTranslation;
          pendingPrimaryTranslation = null;
          if (statusEl) {
            statusEl.textContent = `翻譯主字幕中（→ ${targetLang}）...`;
            statusEl.className = 'yt-sub-status';
          }
          translatePrimarySubtitles(parsed, targetLang);
        } else {
          if (statusEl) {
            const name = trackList.find(t => t.languageCode === settings.primaryLang)?.name || settings.primaryLang;
            statusEl.textContent = `主：${name}（${parsed.length} 句）`;
            statusEl.className = 'yt-sub-status success';
          }
        }
        if (pendingTranslation) {
          const { targetLang } = pendingTranslation;
          console.log('[YT-SUB][TRANS] primary loaded → consuming pendingTranslation, targetLang=', targetLang, 'parsedLen=', parsed.length);
          pendingTranslation = null;
          translateAndSetSecondary(parsed, targetLang);
        }
      } else {
        secondarySubtitles = parsed;
        fillMissingSecondary(); // 補上 ytlang 跳過的重複句翻譯
        // ytlang 空結果（音樂影片或不支援 tlang 的影片）：fallback 到 Google Translate
        if (!secondarySubtitles.length && settings.translationProvider === 'ytlang' && primarySubtitles.length) {
          const priorities = (settings.secondaryLangs || []).filter(l => l && l !== '__none__');
          if (priorities.length) {
            const lang = priorities[0].startsWith('tlang:') ? priorities[0].slice(6) : priorities[0];
            console.log('[YT-SUB][DUAL] ytlang 空結果 → fallback Google Translate, lang=', lang);
            translateAndSetSecondary(primarySubtitles, lang);
          }
        }
      }

      renderSubtitleList();
      startSync();
      if (tag === 'primary' && !customSubtitleActive) _restoreSavedSubtitle();
    }
  });

  // ===== SPA 導航 + sidebar 重建：單一 Observer =====
  let lastUrl = location.href;
  new MutationObserver(() => {
    // SPA 換頁
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (translationJob) { translationJob.cancelled = true; translationJob = null; }
      if (primaryTranslationJob) { primaryTranslationJob.cancelled = true; primaryTranslationJob = null; }
      if (_nextBatchTimer) { clearTimeout(_nextBatchTimer); _nextBatchTimer = null; }
      // SPA 換頁時重置 ResizeObserver、劇院模式標記、CC 按鈕監聽
      if (_playerRO) { _playerRO.disconnect(); _playerRO = null; }
      if (_ccBtnObserver) { _ccBtnObserver.disconnect(); _ccBtnObserver = null; }
      _forcedTheater = false;
      _currentPrimIdx = -1;
      _navedToIdx = -1;
      _navLockedIdx = -1;
      _navLockUntil = 0;
      primarySubtitles = [];
      _rawPrimarySubtitles = [];
      secondarySubtitles = [];
      trackList = [];
      pendingPrimaryTranslation = null;
      // 換影片時重置自定義/社群字幕狀態，允許新影片重新從 YT 取得字幕
      customSubtitleActive = false;
      setActiveSourceBtn(null);
      applyOverlay(); // 換頁時撤掉 overlay
      applyLayoutMode('overlay'); // 換頁時先還原版面，等字幕載入後 expandSidebar 再推開
      // 離開影片頁（回首頁或其他非 watch 頁）→ 自動收合
      if (!location.pathname.startsWith('/watch')) collapseSidebar('idle');
      // 換到影片頁時主動 trigger inject.js 重新取得字幕（避免回到舊影片時 __yt_sub_player__ 事件缺漏）
      if (location.pathname.startsWith('/watch')) window.postMessage({ type: 'YT_SUBTITLE_DEMO_REQUEST' }, '*');
      if (syncInterval) clearInterval(syncInterval);
      const statusEl = document.getElementById('yt-sub-status');
      if (statusEl) statusEl.textContent = '切換影片，重新載入...';
      const list = document.getElementById('yt-sub-list');
      const primCur = document.getElementById('yt-sub-cur-primary');
      const secCur = document.getElementById('yt-sub-cur-secondary');
      if (list) list.innerHTML = '';
      if (primCur) primCur.textContent = '';
      if (secCur) secCur.textContent = '';
      updateOverlay('', '');
      // 生字本面板開著時，重新渲染以更新「當前影片」篩選
      if (document.getElementById('yt-sub-panel-wordbook')?.classList.contains('active')) {
        renderWordbook();
      }
    }
    // sidebar 消失時重建（YouTube SPA 有時會移除 DOM 元素）
    if (location.pathname.startsWith('/watch') && !document.getElementById('yt-sub-demo-sidebar')) init();
  }).observe(document.body, { childList: true, subtree: true });

  // ===== 鍵盤快捷鍵 =====
  document.addEventListener('keydown', e => {
    if (e.key === 'ArrowRight' && loopingIdx >= 0) {
      loopingIdx = -1;
      updateCurrentLoopStyle();
    }

    // A/D 快捷鍵：上一句 / 下一句（需開啟設定且焦點不在輸入框時才觸發）
    if (settings.keyboardNav && !primarySubtitles.length) return;
    if (settings.keyboardNav && (e.key === 'a' || e.key === 'A' || e.key === 'd' || e.key === 'D')) {
      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (document.activeElement?.isContentEditable) return;
      e.preventDefault();

      const video = document.querySelector('video');
      loopingIdx = -1;
      updateCurrentLoopStyle();

      if (e.key === 'a' || e.key === 'A') {
        // 上一句：先暫停確保 currentTime 凍結，再計算當前句，seek 後 resume
        const wasPlaying = video && !video.paused;
        if (wasPlaying) video.pause();
        const cur = _navLockedIdx >= 0 ? _navLockedIdx
          : findLastStartedIndex(primarySubtitles, (video?.currentTime || 0) + (settings.subtitleOffset || 0));
        const newIdx = Math.max(0, cur - 1);
        _navLockedIdx = newIdx;
        _navLockUntil = Date.now() + 800;
        seekTo(primarySubtitles[newIdx].startTime);
        if (wasPlaying) video.play().catch(() => {});
      } else {
        // 下一句：不使用鎖定機制，直接讀 video.currentTime（forward seek 不需補償 async 延遲）
        const cur = findLastStartedIndex(primarySubtitles, (video?.currentTime || 0) + (settings.subtitleOffset || 0));
        const nextIdx = Math.min(primarySubtitles.length - 1, cur + 1);
        if (nextIdx !== cur) seekTo(primarySubtitles[nextIdx].startTime);
      }
    }
  });

  // 切換整體啟用狀態（body 隱藏/顯示，header 常駐讓用戶可隨時重開）
  function toggleExtension() {
    settings.extensionEnabled = !settings.extensionEnabled;
    saveSettings();

    const body = document.getElementById('yt-sub-body');
    const tabBar = document.getElementById('yt-sub-tab-bar');

    if (settings.extensionEnabled) {
      // 開啟：展開 sidebar，恢復 body/tab-bar，重新觸發字幕載入
      expandSidebar();
      if (body) body.style.display = '';
      if (tabBar) tabBar.style.display = '';
      window.postMessage({ type: 'YT_SUBTITLE_DEMO_REQUEST' }, '*');
    } else {
      // 關閉：停止背景任務，收合 sidebar，隱藏 body/tab-bar
      if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
      const video = document.querySelector('video');
      if (video && _seekHandler) { video.removeEventListener('seeked', _seekHandler); _seekHandler = null; }
      if (translationJob) { translationJob.cancelled = true; translationJob = null; }
      if (primaryTranslationJob) { primaryTranslationJob.cancelled = true; primaryTranslationJob = null; }
      collapseSidebar('user');
      if (body) body.style.display = 'none';
      if (tabBar) tabBar.style.display = 'none';
      removeOverlay();
    }
  }

  // ===== 初始化 =====
  function init() {
    if (!location.pathname.startsWith('/watch')) return;
    createSidebar();
    injectScript();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // ===== 社群字幕：查詢與載入 =====

  /**
   * 影片載入後自動還原上次使用的字幕（自定義優先，其次社群）
   * 循序執行避免 race condition
   */
  function _restoreSavedSubtitle(onNotFound) {
    const videoId = new URLSearchParams(location.search).get('v') || '';
    if (!videoId || customSubtitleActive) { onNotFound?.(); return; }

    chrome.storage.local.get(`editedSubtitles_${videoId}`, data => {
      if (customSubtitleActive) return;
      const savedEdit = data[`editedSubtitles_${videoId}`];
      // 兼容舊格式（純陣列）與新格式（物件含 primarySubtitles/secondarySubtitles）
      const savedPrimary = Array.isArray(savedEdit) ? savedEdit : savedEdit?.primarySubtitles;
      const savedSecondary = Array.isArray(savedEdit) ? [] : (savedEdit?.secondarySubtitles || []);
      if (savedPrimary?.length) {
        customSubtitleActive = true;
        primarySubtitles = savedPrimary;
        _rawPrimarySubtitles = savedPrimary;
        if (savedSecondary.length) {
          secondarySubtitles = savedSecondary;
        } else {
          secondarySubtitles = [];
          if (settings.dualEnabled && primarySubtitles.length) {
            translateAndSetSecondary(primarySubtitles, settings.secondaryLang || 'zh-TW', 0);
          }
        }
        renderSubtitleList();
        applyOverlay();
        startSync();
        setActiveSourceBtn('custom');
        const s = document.getElementById('yt-sub-status');
        if (s) { s.textContent = `自定義字幕（已還原，${savedPrimary.length} 句）`; s.className = 'yt-sub-status success'; }
        return;
      }
      // 沒有自定義字幕 → 嘗試還原社群字幕（需 editor 權限）
      chrome.storage.local.get(`lastCommunitySubtitle_${videoId}`, stored => {
        if (customSubtitleActive) return;
        if (_userTier !== 'editor') { onNotFound?.(); return; } // 非授權帳號不還原社群字幕
        const savedComm = stored[`lastCommunitySubtitle_${videoId}`];
        if (!savedComm) { onNotFound?.(); return; }
        customSubtitleActive = true;
        if (savedComm.primarySubtitles?.length)  primarySubtitles   = savedComm.primarySubtitles;
        if (savedComm.secondarySubtitles?.length) {
          secondarySubtitles = savedComm.secondarySubtitles;
        } else {
          secondarySubtitles = [];
          if (settings.dualEnabled && primarySubtitles.length) {
            const lang = settings.secondaryLang || 'zh-TW';
            translateAndSetSecondary(primarySubtitles, lang, 0);
          }
        }
        renderSubtitleList();
        applyOverlay();
        startSync();
        setActiveSourceBtn('community');
        const s = document.getElementById('yt-sub-status');
        if (s) { s.textContent = `社群字幕：${savedComm.subtitleName || '未命名'}（by ${savedComm.authorName || '匿名'}）`; s.className = 'yt-sub-status success'; }
      });
    });
  }

  /**
   * 查詢當前影片的社群字幕數量，有資料時解鎖社群字幕按鈕（純 UI 更新）
   */
  function fetchCommunitySubtitles() {
    const videoId = new URLSearchParams(location.search).get('v') || '';
    if (!videoId) return;
    // 非 editor 不查詢 Firestore，節省請求；UI 已由 _applyTierGates 顯示鎖頭
    if (_userTier !== 'editor') return;

    chrome.runtime.sendMessage({ type: 'fb_getCommunitySubtitles', videoId }, (res) => {
      if (!res?.ok || !res.entries?.length) return;
      const communityOpt = document.querySelector('#yt-sub-source-select option[value="community"]');
      if (communityOpt) {
        communityOpt.textContent = `👥 社群字幕 (${res.entries.length})`;
        communityOpt.disabled = false;
      }
    });
  }

  /**
   * 彈出社群字幕選擇面板，讓使用者選擇要載入的字幕版本
   */
  function showCommunitySubtitlePicker() {
    const videoId = new URLSearchParams(location.search).get('v') || '';
    if (!videoId) return;

    // 權限檢查
    if (_userTier !== 'editor') {
      const statusEl = document.getElementById('yt-sub-status');
      // 還原 source select 到預設
      const srcSel = document.getElementById('yt-sub-source-select');
      if (srcSel) srcSel.value = customSubtitleActive ? (srcSel.dataset.prevSource || 'default') : 'default';
      if (_userTier === 'guest') {
        if (statusEl) {
          statusEl.className = 'yt-sub-status';
          statusEl.innerHTML = '社群字幕需登入 Google 帳號 <button class="yt-sub-tier-gate-btn" id="yt-sub-tier-comm-login">登入</button>';
          document.getElementById('yt-sub-tier-comm-login')?.addEventListener('click', () => {
            document.getElementById('yt-sub-account-btn')?.click();
          });
        }
      } else {
        // 'user' — 已登入但未獲授權
        if (statusEl) {
          statusEl.textContent = '社群字幕需要編輯器權限，請聯絡管理員申請';
          statusEl.className = 'yt-sub-status';
        }
      }
      return;
    }

    // 移除舊的 picker（避免重複）
    document.getElementById('yt-sub-community-picker')?.remove();

    chrome.runtime.sendMessage({ type: 'fb_getCommunitySubtitles', videoId }, (res) => {
      if (chrome.runtime.lastError) {
        const s = document.getElementById('yt-sub-status');
        if (s) { s.textContent = '社群字幕查詢失敗，請重試'; s.className = 'yt-sub-status error'; }
        return;
      }
      if (!res?.ok || !res.entries?.length) {
        const s = document.getElementById('yt-sub-status');
        if (s) { s.textContent = '目前沒有社群字幕可用'; s.className = 'yt-sub-status'; }
        return;
      }

      // 記錄開啟 picker 前的 source select 值，供取消時還原
      const srcSel = document.getElementById('yt-sub-source-select');
      if (srcSel) srcSel.dataset.prevSource = srcSel.value;

      // 建立 picker 面板
      const picker = document.createElement('div');
      picker.id = 'yt-sub-community-picker';
      picker.className = 'yt-sub-community-picker';
      picker.innerHTML = `
        <div class="yt-sub-community-picker-header">
          <span>👥 社群字幕（${res.entries.length} 筆）</span>
          <button class="yt-sub-community-picker-close">✕</button>
        </div>
        <ul class="yt-sub-community-picker-list">
          ${res.entries.map((e, i) => `
            <li class="yt-sub-community-picker-item" data-idx="${i}">
              <div class="yt-sub-community-item-name">${escapeHtml(e.subtitleName || '未命名')}</div>
              <div class="yt-sub-community-item-meta">by ${escapeHtml(e.authorName || '匿名')} · ${res.entries[i].primarySubtitles?.length || 0} 句</div>
            </li>
          `).join('')}
        </ul>
      `;

      // 關閉按鈕
      picker.querySelector('.yt-sub-community-picker-close').addEventListener('click', () => {
        picker.remove();
        // 取消 picker 時還原 source select 顯示值（不套用字幕）
        const sel = document.getElementById('yt-sub-source-select');
        if (sel) sel.value = customSubtitleActive ? (sel.dataset.prevSource || 'default') : 'default';
      });

      // 選擇項目 → 載入字幕
      picker.querySelectorAll('.yt-sub-community-picker-item').forEach(item => {
        item.addEventListener('click', () => {
          const idx = parseInt(item.dataset.idx);
          const entry = res.entries[idx];
          if (!entry) return;

          // 替換主/副字幕
          if (entry.primarySubtitles?.length) {
            primarySubtitles = entry.primarySubtitles;
            _rawPrimarySubtitles = entry.primarySubtitles;
          }
          if (entry.secondarySubtitles?.length) {
            secondarySubtitles = entry.secondarySubtitles;
          } else {
            // 舊資料沒有副字幕，若雙語模式開啟則自動翻譯
            secondarySubtitles = [];
            if (settings.dualEnabled && primarySubtitles.length) {
              const lang = settings.secondaryLang || 'zh-TW';
              translateAndSetSecondary(primarySubtitles, lang, 0);
            }
          }

          renderSubtitleList();
          applyOverlay();
          startSync();
          picker.remove();
          setActiveSourceBtn('community');

          // 記錄此次選擇，下次開啟同影片自動套用
          chrome.storage.local.set({ [`lastCommunitySubtitle_${videoId}`]: entry });

          // 更新狀態文字
          const statusEl = document.getElementById('yt-sub-status');
          if (statusEl) {
            statusEl.textContent = `社群字幕：${entry.subtitleName || '未命名'}（by ${entry.authorName || '匿名'}）`;
            statusEl.className = 'yt-sub-status success';
          }
        });
      });

      // 附加到面板最上方
      const panel = document.getElementById('yt-sub-panel-subtitle');
      if (panel) panel.prepend(picker);
      else document.body.appendChild(picker);
    });
  }

  /**
   * 將 ysm-lang-select 設為自定義/社群字幕標籤（無 YT tracks 時使用）
   */
  function _ysmSetCustomLabel(langSel, srcVal) {
    langSel.innerHTML = '';
    const opt = document.createElement('option');
    opt.value = srcVal;
    opt.textContent = srcVal === 'community' ? '👥 社群字幕' : '✏ 本地字幕';
    langSel.appendChild(opt);
    langSel.value = srcVal;
  }

  /**
   * 標示目前使用中的字幕來源按鈕（紫色底色），另一個恢復預設
   * @param {'custom'|'community'|null} source
   */
  function setActiveSourceBtn(source) {
    const sel = document.getElementById('yt-sub-source-select');
    if (sel) {
      if (source === 'custom')    sel.querySelector('option[value="custom"]').disabled    = false;
      if (source === 'community') sel.querySelector('option[value="community"]').disabled = false;
      sel.value = source ?? 'default';
      if (source) sel.dataset.prevSource = source;
    }
    // 有自定義/社群字幕來源時，封鎖 YT 字幕覆蓋
    customSubtitleActive = source !== null;
    // 若字幕模式 overlay 已開啟且無 YT tracks，同步更新 ysm-lang-select 顯示
    const ysmLangSel = document.querySelector('#ysm-lang-select');
    const ytLangSel  = document.querySelector('#yt-sub-langs select');
    if (ysmLangSel && !ytLangSel) {
      if (source) {
        _ysmSetCustomLabel(ysmLangSel, source);
      } else {
        // 切回預設時清空自訂標籤（無 YT tracks 時留空，避免殘留舊來源名稱）
        ysmLangSel.innerHTML = '';
      }
    }
  }

  // ===== SRT 匯入 =====
  function importSrtFile() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.srt';
    input.style.display = 'none';
    document.body.appendChild(input);

    input.addEventListener('change', async () => {
      const file = input.files[0];
      document.body.removeChild(input);
      if (!file) return;

      try {
        const text = await file.text();
        const parsed = parseSrt(text);
        if (!parsed.length) throw new Error('無法解析 SRT 內容，請確認格式正確');

        primarySubtitles = settings.extendSubtitles ? extendSubtitleDurations(parsed) : parsed;
        _rawPrimarySubtitles = parsed;
        secondarySubtitles = [];

        // 匯入後自動存入 localStorage（與「儲存本地」相同機制）
        const _srtVid = new URLSearchParams(location.search).get('v') || '';
        if (_srtVid) chrome.storage.local.set({ [`editedSubtitles_${_srtVid}`]: { primarySubtitles: primarySubtitles, secondarySubtitles: secondarySubtitles.map(s => ({ ...s })) } });

        applyOverlay();
        renderSubtitleList();
        startSync();
        setActiveSourceBtn('custom');
        const _vidNow = document.querySelector('video');
        if (_vidNow) _vidNow.dispatchEvent(new Event('timeupdate'));

        const statusEl = document.getElementById('yt-sub-status');
        if (statusEl) {
          statusEl.textContent = `SRT 已匯入：${file.name}（${parsed.length} 句）`;
          statusEl.className = 'yt-sub-status success';
        }
      } catch (err) {
        const statusEl = document.getElementById('yt-sub-status');
        if (statusEl) { statusEl.textContent = `SRT 匯入失敗：${err.message}`; statusEl.className = 'yt-sub-status error'; }
      }
    });

    // 若使用者沒選擇檔案（關閉 dialog），focus 觸發後 input 已被移除，無副作用
    input.click();
  }

  function parseSrt(srtText) {
    const subs = [];
    const blocks = srtText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim().split(/\n\s*\n/);
    for (const block of blocks) {
      const lines = block.trim().split('\n');
      const tsLine = lines.find(l => l.includes('-->'));
      if (!tsLine) continue;
      const [startStr, endStr] = tsLine.split('-->').map(s => s.trim());
      const startTime = _srtTs(startStr);
      const endTime   = _srtTs(endStr);
      if (isNaN(startTime) || isNaN(endTime) || endTime <= startTime) continue;
      const tsIdx    = lines.indexOf(tsLine);
      const lineText = lines.slice(tsIdx + 1).join('\n').replace(/<[^>]+>/g, '').trim();
      if (!lineText) continue;
      subs.push({ startTime, duration: endTime - startTime, text: lineText });
    }
    return subs;
  }

  function _srtTs(ts) {
    const m = ts.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    if (!m) return NaN;
    return parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseInt(m[3]) + parseInt(m[4]) / 1000;
  }

  // ===== 來自編輯器的訊息監聽 =====
  // 接收 editor.html 透過 background relay 傳來的播放控制指令
  chrome.runtime.onMessage.addListener((msg) => {
    // 跳轉到指定時間點並播放，若帶有 endTime 則播完後暫停
    if (msg.type === 'SEEK_TO') {
      const video = document.querySelector('video');
      if (!video) return;
      video.currentTime = msg.time;
      video.play();
      if (msg.endTime && msg.endTime > msg.time) {
        // 用 timeupdate 偵測到達結束時間後暫停（比 setTimeout 更準確）
        const onTimeUpdate = () => {
          if (video.currentTime >= msg.endTime) {
            video.pause();
            video.removeEventListener('timeupdate', onTimeUpdate);
          }
        };
        video.addEventListener('timeupdate', onTimeUpdate);
      }
    }

    // 設定循環播放特定字幕句
    if (msg.type === 'LOOP_LINE') {
      // 利用現有 loopingIdx 機制，找到對應的字幕 index
      const idx = primarySubtitles.findIndex(s => Math.abs(s.startTime - msg.startTime) < 0.1);
      if (idx >= 0) {
        loopingIdx = idx;
        const video = document.querySelector('video');
        if (video) { video.currentTime = msg.startTime; video.play(); }
        updateCurrentLoopStyle();
      }
    }

    // 停止循環播放
    if (msg.type === 'LOOP_STOP') {
      loopingIdx = -1;
      updateCurrentLoopStyle();
    }

    // 套用編輯器儲存的字幕到 YT 前端，並標示自定義字幕按鈕為使用中
    if (msg.type === 'APPLY_SUBTITLES') {
      if (msg.primarySubtitles?.length)   primarySubtitles   = msg.primarySubtitles;
      if (msg.secondarySubtitles?.length) secondarySubtitles = msg.secondarySubtitles;
      renderSubtitleList();
      startSync();
      setActiveSourceBtn('custom');
      const statusEl = document.getElementById('yt-sub-status');
      if (statusEl) {
        statusEl.textContent = '自定義字幕（本地）';
        statusEl.className = 'yt-sub-status success';
      }
    }
  });
})();
