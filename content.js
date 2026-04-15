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
  let _playerRO = null; // ResizeObserver：監聽 player 大小變化以同步 wrapper 高度
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
      primarySize: 'md',
      secondarySize: 'sm',
      secondaryColor: 'purple',
      clickToSeek: true,
      autoScroll: true,
      overlayEnabled: true,
      loopSentence: true,   // 單句循環
      translationProvider: 'ytlang',  // ytlang | google
      googleBatchMode: 'sentence8', // sentence8 | words100
      wordHover: true,   // 單字 hover 高亮
      wordSpeak: true,   // 點擊單字朗讀
      extensionEnabled: true, // 套件整體開關
      extendSubtitles: true, // 延長字幕顯示（填滿字幕間的空白間隔）
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
            <button id="yt-sub-custom-btn" class="yt-sub-action-btn">✏ 自定義字幕</button>
            <button id="yt-sub-community-btn" class="yt-sub-action-btn yt-sub-community-btn" disabled>👥 社群字幕 <span id="yt-sub-community-count" class="yt-sub-community-badge">0</span></button>
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
                <option value="current-video">從此影片生成的生字</option>
                <option value="date-desc">最近加入</option>
                <option value="count-desc">查詢最多</option>
                <option value="alpha">字母順序</option>
              </select>
              <button class="yt-sub-wb-loop-btn" id="yt-sub-wb-loop-btn" title="循環當前句">⇄</button>
              <span class="yt-sub-wordbook-count" id="yt-sub-wordbook-count"></span>
            </div>
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
              <div class="yt-sub-settings-row">
                <span class="yt-sub-settings-label">主字幕大小</span>
                <div class="yt-sub-size-group" id="yt-sub-primary-size-group">
                  <button data-val="sm">小</button>
                  <button data-val="md">中</button>
                  <button data-val="lg">大</button>
                </div>
              </div>
              <div class="yt-sub-settings-row">
                <span class="yt-sub-settings-label">副字幕大小</span>
                <div class="yt-sub-size-group" id="yt-sub-secondary-size-group">
                  <button data-val="sm">小</button>
                  <button data-val="md">中</button>
                  <button data-val="lg">大</button>
                </div>
              </div>
              <div class="yt-sub-settings-row">
                <span class="yt-sub-settings-label">副字幕顏色</span>
                <div class="yt-sub-swatch-group" id="yt-sub-color-group">
                  <button class="yt-sub-swatch" data-val="purple" style="background:#a855f7" title="紫"></button>
                  <button class="yt-sub-swatch" data-val="cyan"   style="background:#22d3ee" title="青"></button>
                  <button class="yt-sub-swatch" data-val="yellow" style="background:#fbbf24" title="黃"></button>
                  <button class="yt-sub-swatch" data-val="white"  style="background:#e0e0e0" title="白"></button>
                </div>
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
              <div class="yt-sub-settings-row yt-sub-offset-row">
                <span class="yt-sub-settings-label">字幕時間偏移</span>
                <div class="yt-sub-offset-control">
                  <input type="range" id="yt-sub-offset-slider" min="-30" max="30" step="0.5" value="0" class="yt-sub-offset-slider">
                  <span id="yt-sub-offset-display" class="yt-sub-offset-display">0.0s</span>
                </div>
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

    // ===== 自定義字幕按鈕：傳送字幕資料至 background 並開啟編輯器分頁 =====
    document.getElementById('yt-sub-custom-btn')?.addEventListener('click', () => {
      // 先將當前字幕資料暫存至 background
      chrome.runtime.sendMessage({
        type: 'editor_setSubtitles',
        videoId: new URLSearchParams(location.search).get('v'),
        videoTitle: document.title.replace(' - YouTube', ''),
        primarySubtitles,
        secondarySubtitles,
      }, () => {
        // 資料存好後開啟編輯器分頁
        chrome.runtime.sendMessage({ type: 'editor_open' });
      });
    });

    // ===== 社群字幕按鈕：查詢並顯示清單 =====
    document.getElementById('yt-sub-community-btn')?.addEventListener('click', () => {
      showCommunitySubtitlePicker();
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
        // 生字本只在第一次或資料可能更新時重新渲染
        if (target === 'wordbook' && !_wordbookLoaded) {
          _wordbookLoaded = true;
          renderWordbook();
        }
      });
    });

    // 儲存或刪除單字後標記需要重新渲染
    const _markWordbookDirty = () => { _wordbookLoaded = false; };

    // 生字本排序變更時重新渲染
    document.getElementById('yt-sub-wordbook-sort').addEventListener('change', () => renderWordbook());

    // 生字本循環當前句按鈕
    document.getElementById('yt-sub-wb-loop-btn').addEventListener('click', () => {
      const video = document.querySelector('video');
      if (!video || !primarySubtitles.length) return;
      if (loopingIdx >= 0) {
        loopingIdx = -1;
      } else {
        const idx = findActiveIndex(primarySubtitles, video.currentTime + (settings.subtitleOffset || 0));
        if (idx >= 0) loopingIdx = idx;
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
    setupSizeGroup('yt-sub-primary-size-group', 'primarySize');
    setupSizeGroup('yt-sub-secondary-size-group', 'secondarySize');
    setupSwatchGroup('yt-sub-color-group', 'secondaryColor');

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
        loopingIdx = -1; // 任何 loop 中都直接取消
      } else {
        const video = document.querySelector('video');
        const primIdx = findActiveIndex(primarySubtitles, video?.currentTime || 0);
        if (primIdx >= 0) loopingIdx = primIdx;
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

    // 套用初始顯示設定
    applyDisplaySettings();
    updateSizeGroupUI();
    updateSwatchGroupUI();

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
      } else {
        // 第一次沒拿到，等 restoreSession 完成後重試
        setTimeout(() => {
          chrome.runtime.sendMessage({ type: 'fb_getUser' }, res2 => {
            updateAccountUI(res2?.user || null);
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
            if (r?.ok) updateAccountUI(r.user);
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
    [['yt-sub-primary-size-group', 'primarySize'], ['yt-sub-secondary-size-group', 'secondarySize']]
      .forEach(([groupId, key]) => {
        document.getElementById(groupId)?.querySelectorAll('button').forEach(btn => {
          btn.classList.toggle('active', btn.dataset.val === settings[key]);
        });
      });
  }

  function updateSwatchGroupUI() {
    document.getElementById('yt-sub-color-group')?.querySelectorAll('button').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.val === settings.secondaryColor);
    });
  }

  function applyDisplaySettings() {
    const sidebar = document.getElementById('yt-sub-demo-sidebar');
    if (!sidebar) return;
    sidebar.style.setProperty('--primary-fs', FONT_SIZES.primary[settings.primarySize] || '13px');
    sidebar.style.setProperty('--secondary-fs', FONT_SIZES.secondary[settings.secondarySize] || '12px');
    sidebar.style.setProperty('--secondary-color', SECONDARY_COLORS[settings.secondaryColor] || '#a855f7');
    // overlay 副字幕顏色同步
    const overlay = document.getElementById('yt-sub-overlay');
    if (overlay) overlay.style.setProperty('--ov-secondary-color', SECONDARY_COLORS[settings.secondaryColor] || '#a855f7');
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
      status.textContent = '此影片沒有可用字幕';
      status.className = 'yt-sub-status error';
      container.innerHTML = '';
      collapseSidebar('no-sub'); // 無字幕：自動收合，亮紅點
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
    // 過濾後顯示：手動 tracks 全部保留，ASR 只保留一條
    const displayTracks = trackList.filter(t =>
      !(t.vssId || '').startsWith('a.') || t === preferredAsr
    );

    fillAsrSelect(asrTracks);

    status.textContent = `找到 ${trackList.length} 個字幕語言`;
    status.className = 'yt-sub-status success';

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
    langDropdown.addEventListener('change', function () {
      const vssId = this.value;
      const track = displayTracks.find(t => (t.vssId || t.languageCode) === vssId);
      if (!track) return;
      settings.primaryLang = track.languageCode;
      settings.primaryVssId = track.vssId || null;
      // 不呼叫 saveSettings()：只影響當前影片，不覆蓋全域偏好
      primarySubtitles = []; _rawPrimarySubtitles = [];
      loadSubtitle(track, 'primary');
    });
    // 若設定語言在此影片中找不到，選中第一個 option 並用 override 傳給 autoLoadSubtitles
    // 不修改 settings，保留使用者原始偏好給下一部影片
    const anyMatched = displayTracks.some(t =>
      settings.primaryVssId
        ? (t.vssId || t.languageCode) === settings.primaryVssId
        : t.languageCode === settings.primaryLang
    );
    let primaryOverride = null;
    if (!anyMatched && displayTracks.length > 0) {
      primaryOverride = displayTracks[0];
      langDropdown.options[0].selected = true;
    }

    container.appendChild(langDropdown);

    refreshSecondarySelects();
    highlightActiveLangs();
    autoLoadSubtitles(trackList, primaryOverride);
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
  // primaryOverride：強制使用指定 track（fallback 情境），不修改 settings
  function autoLoadSubtitles(tracks, primaryOverride = null) {
    if (!tracks.length) return;
    const primary = primaryOverride
      || findPrimaryTrack(tracks)
      || tracks.find(t => !(t.vssId || '').startsWith('a.'))
      || tracks[0]
      || null;
    if (primary) {
      if (primaryOverride && settings.translationProvider === 'google') {
        // 偏好語言在此影片無原生字幕，且翻譯服務為 Google：
        // 先載原生語言，收到後再用 Google Translate 翻成偏好語言
        // （與副字幕中文的做法相同，避免走 &tlang= 被限流）
        pendingPrimaryTranslation = { targetLang: settings.primaryLang };
        loadSubtitle(primary, 'primary'); // 不帶 tlang，直接載原語言
      } else {
        // primaryOverride 且 ytlang：走 &tlang= 路徑（舊有）
        // 無 override：直接載偏好語言原生字幕
        const tlang = primaryOverride ? settings.primaryLang : null;
        loadSubtitle(primary, 'primary', tlang);
      }
    }

    pendingTranslation = null;
    if (settings.dualEnabled) {
      const priorities = (settings.secondaryLangs || []).filter(l => l && l !== '__none__');
      const base = tracks.find(t => (t.vssId || '').startsWith('a.')) || tracks[0];
      let loaded = false;

      for (const entry of priorities) {
        const isForcedTranslation = entry.startsWith('tlang:');
        const lang = isForcedTranslation ? entry.slice(6) : entry;

        // 原生 track 不需要翻譯，無論哪種 provider 都直接載
        if (!isForcedTranslation) {
          const native = findTrackByLang(tracks, lang);
          if (native) { loadSubtitle(native, 'secondary'); loaded = true; break; }
        }

        // 需要翻譯：依 provider 決定走 ytlang 或外部
        if (settings.translationProvider === 'ytlang') {
          if (base) { loadSubtitle(base, 'secondary', lang); loaded = true; break; }
        } else {
          // 外部翻譯：等 primary 載完後才翻
          pendingTranslation = { targetLang: lang };
          loaded = true;
          if (primarySubtitles.length) {
            translateAndSetSecondary(primarySubtitles, lang);
            pendingTranslation = null;
          }
          break;
        }
      }

      if (!loaded && priorities.length > 0) {
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
    listEl.innerHTML = '';

    // hover 時凍結高亮捲動，讓使用者有時間右鍵 / 點擊單字
    listEl.onmouseenter = () => { _listHovering = true; };
    listEl.onmouseleave = () => { _listHovering = false; };

    primarySubtitles.forEach((sub, index) => {
      const item = document.createElement('div');
      item.className = 'yt-sub-item';
      item.dataset.index = index;

      const midTime = sub.startTime + 0.1;
      const secSub = findSubAtTime(secondarySubtitles, midTime);

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
      buildTokenizedText(primEl, sub.text, sub.startTime);
      texts.appendChild(primEl);

      if (settings.dualEnabled && secSub) {
        const secEl = document.createElement('div');
        secEl.className = 'yt-sub-text-secondary';
        secEl.textContent = secSub.text;
        texts.appendChild(secEl);
      }

      // 點擊字幕文字區 → 跳轉 + 切換循環；點單字不觸發（stopPropagation 在 buildTokenizedText 裡）
      texts.addEventListener('click', e => {
        if (e.target.closest('.yt-sub-word')) return;
        if (loopingIdx >= 0) {
          loopingIdx = -1; // loop 中點任何句都取消
        } else {
          seekTo(sub.startTime);
          loopingIdx = index;
        }
        updateCurrentLoopStyle();
      });

      item.appendChild(timeSpan);
      item.appendChild(texts);
      listEl.appendChild(item);
    });
  }

  function findSubAtTime(subs, time) {
    return subs.find(s => time >= s.startTime && time < s.startTime + s.duration) || null;
  }

  // ytlang 翻譯檔會跳過重複歌詞/台詞，補上缺少翻譯的 primary subtitle
  // 做法：建立「原文 → 第一個翻譯」映射，再填補沒有時間對應的 primary
  function fillMissingSecondary() {
    if (!primarySubtitles.length || !secondarySubtitles.length) return;

    // 第一步：收集所有已有的 primaryText → secondaryText 對應
    const textMap = new Map();
    primarySubtitles.forEach(prim => {
      const midTime = prim.startTime + 0.1;
      const sec = findSubAtTime(secondarySubtitles, midTime);
      if (sec) {
        const key = prim.text.trim().toLowerCase();
        if (!textMap.has(key)) textMap.set(key, sec.text);
      }
    });

    // 第二步：對沒有對應翻譯的 primary，用同文字的譯文補上
    const toAdd = [];
    primarySubtitles.forEach(prim => {
      const midTime = prim.startTime + 0.1;
      if (!findSubAtTime(secondarySubtitles, midTime)) {
        const translated = textMap.get(prim.text.trim().toLowerCase());
        if (translated) {
          toAdd.push({ startTime: prim.startTime, duration: prim.duration, text: translated });
        }
      }
    });
    if (toAdd.length) secondarySubtitles.push(...toAdd);
  }

  // ===== 單字查詢浮窗 =====
  const dictCache = {};  // word → result (max 200 entries)
  const DICT_CACHE_MAX = 200;

  function showWordPopup(word, anchor, sentenceData = null) {
    let popup = document.getElementById('yt-sub-word-popup');
    if (!popup) {
      popup = document.createElement('div');
      popup.id = 'yt-sub-word-popup';
      document.body.appendChild(popup);
    }

    // 定位：置中對齊 anchor，四邊保留 16px，右側避開 sidebar
    const rect = anchor.getBoundingClientRect();
    const popupWidth = 320;
    const margin = 16;
    const sidebarWidth = document.getElementById('yt-sub-demo-sidebar')?.offsetWidth || 0;
    const rightBound = window.innerWidth - sidebarWidth - margin;
    let left = rect.left + rect.width / 2 - popupWidth / 2;
    left = Math.max(margin, Math.min(left, rightBound - popupWidth));
    let top = rect.bottom + 6;
    if (top + 420 > window.innerHeight - margin) top = rect.top - 426;
    top = Math.max(margin, top);
    popup.style.left = left + 'px';
    popup.style.top = top + 'px';
    popup.style.display = 'block';
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
    `;
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

  // 儲存單字到本地生字本；sentenceContext 為完整字幕句，startTime 為句子時間軸（秒）
  function saveWord(word, anchor, sentenceContext, startTime) {
    const hasCachedLookup = dictCache[word] !== undefined;
    const cached = hasCachedLookup ? dictCache[word] : null;
    const cachedNotFound = hasCachedLookup && cached === null; // 查過但字典無此字
    const cachedTier = cached?.tier ?? null;
    const cachedWordZh = cached?.wordZh || '';
    const cachedZh = cached?.definitionZh || '';
    const videoId = new URLSearchParams(location.search).get('v') || '';

    chrome.storage.local.get(SAVED_WORDS_KEY, data => {
      const saved = data[SAVED_WORDS_KEY] || {};
      const alreadySaved = !!saved[word];
      if (!alreadySaved) {
        saved[word] = {
          word,
          addedAt: Date.now(),
          count: 1,
          tier: cachedTier,
          tierFetched: hasCachedLookup,
          noDefinition: cachedNotFound,   // true = 字典查無此字，不顯示查詢按鈕
          wordZh: cachedWordZh,     // 單字通用中文（危險、奇蹟...）
          definitionZh: cachedZh,
          context: sentenceContext || '',
          contextZh: '',        // 非同步翻譯後填入
          videoId,
          startTime: startTime ?? 0,
        };
      } else {
        saved[word].count = (saved[word].count || 1) + 1;
        if (!saved[word].tier && cachedTier) { saved[word].tier = cachedTier; saved[word].tierFetched = true; }
        if (!saved[word].wordZh && cachedWordZh) saved[word].wordZh = cachedWordZh;
        if (!saved[word].definitionZh && cachedZh) saved[word].definitionZh = cachedZh;
        if (sentenceContext) {
          // 只有例句真的變了才重置 contextZh，避免連續右鍵重複打翻譯 API
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
        if (anchor) anchor.classList.add('word-saved');
        showSaveToast(word, alreadySaved);
        // 面板開著時立即更新列表
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
      }

      const totalLabel = sortKey === 'current-video'
        ? (displayed.length ? `當前影片 ${displayed.length} 個單字` : '此影片尚未儲存任何單字')
        : (words.length ? `共 ${words.length} 個單字` : '尚未儲存任何單字');
      countEl.textContent = totalLabel;
      listEl.innerHTML = '';

      if (!displayed.length) return;

      displayed.forEach(item => {
        const row = document.createElement('div');
        row.className = 'yt-sub-wb-row';

        const tierHtml = item.tier && TIER_CLASS[item.tier]
          ? `<span class="yt-sub-tier-badge ${TIER_CLASS[item.tier]}">${TIER_LABEL[item.tier]}</span>`
          : '';
        const isSameVideo = item.videoId && item.videoId === currentVideoId;
        const rowBtnsHtml = isSameVideo && item.startTime != null
          ? `<button class="yt-sub-wb-row-play" data-start="${item.startTime}" title="播放此句">▶</button>`
          : '';
        row.innerHTML = `
          <span class="yt-sub-wb-word${item.noDefinition ? ' no-def' : ''}">${escapeHtml(item.word)}</span>
          ${item.wordZh ? `<span class="yt-sub-wb-zh">${escapeHtml(item.wordZh)}</span>` : ''}
          ${rowBtnsHtml}
          ${tierHtml}
          ${item.count > 1 ? `<span class="yt-sub-wb-meta">×${item.count}</span>` : ''}
          <button class="yt-sub-wb-del" data-word="${escapeHtml(item.word)}" title="刪除">×</button>
        `;

        // 點擊單字：查字典，並在底部附加例句（若有）
        if (!item.noDefinition) {
          row.querySelector('.yt-sub-wb-word').addEventListener('click', e => {
            showWordPopup(item.word, e.target, item);
          });
        }

        // 播放此句按鈕（跳轉到該句）
        const playBtn = row.querySelector('.yt-sub-wb-row-play');
        if (playBtn) {
          playBtn.addEventListener('click', e => {
            e.stopPropagation();
            const startTime = parseFloat(playBtn.dataset.start);
            seekTo(startTime);
            // 循環開著：跟著轉移到新的句子；循環關著：不動
            if (loopingIdx >= 0) {
              const idx = primarySubtitles.findIndex(s => s.startTime === startTime);
              loopingIdx = idx >= 0 ? idx : -1;
              updateCurrentLoopStyle();
            }
          });
        }

        // 刪除單字
        row.querySelector('.yt-sub-wb-del').addEventListener('click', e => {
          e.stopPropagation();
          deleteWord(item.word, row);
        });

        listEl.appendChild(row);
      });
    });
  }

  // 從生字本刪除單字
  function deleteWord(word, rowEl) {
    chrome.storage.local.get(SAVED_WORDS_KEY, data => {
      const saved = data[SAVED_WORDS_KEY] || {};
      if (saved[word]) saved[word].deletedAt = Date.now(); // 軟刪除，保留供同步
      chrome.storage.local.set({ [SAVED_WORDS_KEY]: saved }, () => {
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

    if (!job.cancelled && statusEl) {
      const langName = ONBOARDING_LEARN_LANGS.find(l => l.code === targetLang)?.label || targetLang;
      statusEl.textContent = `主：${langName}（${total} 句，Google 翻譯）`;
      statusEl.className = 'yt-sub-status success';
    }
  }

  async function translateAndSetSecondary(subs, targetLang, fromTime = null) {
    const videoId = new URLSearchParams(location.search).get('v') || '';
    const cacheKey = videoId + ':' + targetLang;

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
      if (statusEl) {
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
      if (statusEl) {
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
    if (secText && settings.dualEnabled) {
      if (!secEl) {
        secEl = document.createElement('div');
        secEl.className = 'yt-sub-text-secondary';
        item.querySelector('.yt-sub-texts')?.appendChild(secEl);
      }
      secEl.textContent = secText;
    } else if (secEl) {
      secEl.remove();
    }
  }

  // ===== 單字 Tokenize =====
  function buildTokenizedText(container, text, startTime) {
    const tokens = text.split(/(\b[a-zA-Z'-]+\b)/);
    tokens.forEach(token => {
      if (/^[a-zA-Z'-]+$/.test(token) && token.length > 1) {
        const span = document.createElement('span');
        span.className = 'yt-sub-word';
        span.textContent = token;
        span.addEventListener('click', e => {
          e.stopPropagation();
          // 查字典時還原為原型（shining → shine），讓字典結果與生字本一致
          const clean = lemmatize(token.toLowerCase().replace(/'s$/i, '').replace(/['-]$/, ''));
          if (settings.wordSpeak) speakWord(token);
          showWordPopup(clean, span, { _originalToken: token.toLowerCase() });
        });
        // 右鍵儲存單字到生字本（capture phase 搶先 YouTube handler，stopImmediatePropagation 防止後續 handler 干擾）
        span.addEventListener('contextmenu', e => {
          e.preventDefault();
          e.stopImmediatePropagation();
          const clean = lemmatize(token.toLowerCase().replace(/'s$/i, '').replace(/['-]$/, ''));
          const original = token.toLowerCase();
          // dictCache[clean] === null 表示字典明確查無此詞（還原錯誤）→ 改存原始詞
          const wordToSave = (clean !== original && dictCache[clean] === null) ? original : clean;
          saveWord(wordToSave, span, text, startTime); // text 為整句字幕，startTime 為句子時間軸
        }, true);
        container.appendChild(span);
      } else {
        container.appendChild(document.createTextNode(token));
      }
    });
  }

  // 快取命中時批次更新所有現有 DOM 的副字幕欄位
  function patchSubtitleListSecondary() {
    primarySubtitles.forEach((sub, i) => {
      const midTime = sub.startTime + 0.1;
      const secSub = findSubAtTime(secondarySubtitles, midTime);
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

  function createOverlay() {
    if (document.getElementById('yt-sub-overlay')) return;
    const overlay = document.createElement('div');
    overlay.id = 'yt-sub-overlay';
    overlay.innerHTML = `
      <button id="yt-sub-ov-prev" class="yt-sub-ov-nav">&#8249;</button>
      <div id="yt-sub-ov-body">
        <div id="yt-sub-ov-primary"></div>
        <div id="yt-sub-ov-secondary"></div>
      </div>
      <button id="yt-sub-ov-next" class="yt-sub-ov-nav">&#8250;</button>
    `;
    const player = document.querySelector('#movie_player');
    if (player) player.appendChild(overlay);
    updateOverlayRight();

    // 點擊背版（body 區域）→ 啟動/取消單句循環
    document.getElementById('yt-sub-ov-body').addEventListener('click', e => {
      if (e.target.closest('.yt-sub-word')) return;
      if (loopingIdx >= 0) {
        loopingIdx = -1;
      } else {
        const primIdx = findActiveIndex(primarySubtitles, document.querySelector('video')?.currentTime || 0);
        if (primIdx >= 0) loopingIdx = primIdx;
      }
      updateCurrentLoopStyle();
    });

    // 上一句
    document.getElementById('yt-sub-ov-prev').addEventListener('click', e => {
      e.stopPropagation();
      loopingIdx = -1;
      const t = document.querySelector('video')?.currentTime || 0;
      const idx = findActiveIndex(primarySubtitles, t);
      const target = primarySubtitles[Math.max(0, idx - 1)];
      if (target) seekTo(target.startTime);
    });

    // 下一句
    document.getElementById('yt-sub-ov-next').addEventListener('click', e => {
      e.stopPropagation();
      loopingIdx = -1;
      const t = document.querySelector('video')?.currentTime || 0;
      const idx = findActiveIndex(primarySubtitles, t);
      const target = primarySubtitles[Math.min(primarySubtitles.length - 1, idx + 1)];
      if (target) seekTo(target.startTime);
    });
  }

  function updateOverlayLoopStyle() {
    updateCurrentLoopStyle();
  }

  let _lastLoopingState = false;
  function updateCurrentLoopStyle() {
    const looping = loopingIdx >= 0;
    if (looping === _lastLoopingState) return;
    _lastLoopingState = looping;
    document.getElementById('yt-sub-current')?.classList.toggle('looping', looping);
    document.getElementById('yt-sub-ov-body')?.classList.toggle('looping', looping);
    updateWbLoopBtn();
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

  function expandSidebar() {
    const sidebar = document.getElementById('yt-sub-demo-sidebar');
    const ball = document.getElementById('yt-sub-ball');
    if (!sidebar || !ball) return;
    _ballAnimating = true;
    sidebar.classList.remove('sidebar-collapsed');
    ball.classList.add('expanded');
    // 展開時隱藏 ball dot（狀態已由 header LED 點陣呈現，不需重複顯示）
    const dot = document.getElementById('yt-sub-ball-dot');
    if (dot) { dot.classList.remove('no-sub', 'has-sub', 'idle'); dot.classList.add('hidden'); }
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
    } else if (reason === 'idle') {
      dot.classList.add('idle');
      setLedState('idle');
    } else {
      dot.classList.add('has-sub');
      setLedState('has-sub');
    }
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
    if (ovSec) ovSec.textContent = secText || '';
    updateOverlayLoopStyle();
  }

  // ===== 同步高亮 =====
  let _seekHandler = null;
  function startSync() {
    if (syncInterval) clearInterval(syncInterval);

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

      if (curPrimEl) {
        const newText = primSub ? primSub.text : '';
        if (curPrimEl.dataset.text !== newText) {
          curPrimEl.dataset.text = newText;
          curPrimEl.innerHTML = '';
          if (newText) buildTokenizedText(curPrimEl, newText, primSub?.startTime ?? 0);
        }
      }
      if (curSecEl) curSecEl.textContent = secSub && settings.dualEnabled ? secSub.text : '';
      if (curWrap) curWrap.classList.toggle('active', primSub !== null || (secSub !== null && settings.dualEnabled));
      updateCurrentLoopStyle();

      // 單句循環：不依賴 primSub，句子間空隙也能正確 loop 回去
      if (settings.loopSentence && loopingIdx >= 0) {
        const loopSub = primarySubtitles[loopingIdx];
        if (loopSub && t >= loopSub.startTime + loopSub.duration) {
          video.currentTime = loopSub.startTime;
        }
      }

      if (settings.overlayEnabled) {
        if (!document.getElementById('yt-sub-overlay')) createOverlay();
        updateOverlay(
          primSub ? primSub.text : '',
          secSub && settings.dualEnabled ? secSub.text : '',
          primIdx
        );
      }

      // hover 時凍結高亮與捲動，讓使用者有時間右鍵 / 點擊單字
      if (!_listHovering) {
        const items = document.getElementById('yt-sub-list')?.children;
        if (items) {
          for (let i = 0; i < items.length; i++) {
            const active = i === primIdx;
            items[i].classList.toggle('active', active);
            if (active && settings.autoScroll) items[i].scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }
      }
    }, 100);
  }

  function findActiveIndex(subs, time) {
    return subs.findIndex(s => time >= s.startTime && time < s.startTime + s.duration);
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
        }
        return;
      }

      // inject.js 已預先解析成精簡格式 { s, d, t }，直接轉換
      const parsed = event.data.parsed
        ? event.data.parsed.map(e => ({ startTime: e.s, duration: e.d, text: e.t }))
        : parseJson3(event.data.data);

      if (tag === 'primary') {
        _rawPrimarySubtitles = parsed;
        primarySubtitles = settings.extendSubtitles ? extendSubtitleDurations(parsed) : parsed;
        applyOverlay(); // 有字幕了，啟用 overlay 並隱藏原生字幕
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
          pendingTranslation = null;
          translateAndSetSecondary(parsed, targetLang);
        }
      } else {
        secondarySubtitles = parsed;
        fillMissingSecondary(); // 補上 ytlang 跳過的重複句翻譯
      }

      renderSubtitleList();
      startSync();
      // 主字幕載入完成後，查詢社群字幕數量並更新按鈕狀態
      if (tag === 'primary') fetchCommunitySubtitles();
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
      // SPA 換頁時重置 ResizeObserver，下一頁的 player 元素是新的
      if (_playerRO) { _playerRO.disconnect(); _playerRO = null; }
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
   * 查詢當前影片的社群字幕數量，有資料時解鎖社群字幕按鈕
   */
  function fetchCommunitySubtitles() {
    const videoId = new URLSearchParams(location.search).get('v') || '';
    if (!videoId) return;
    const btn = document.getElementById('yt-sub-community-btn');
    const badge = document.getElementById('yt-sub-community-count');
    if (!btn || !badge) return;

    chrome.runtime.sendMessage({ type: 'fb_getCommunitySubtitles', videoId }, (res) => {
      if (!res?.ok || !res.entries?.length) return;
      badge.textContent = res.entries.length;
      btn.disabled = false;

      // 若本地記錄了上次選擇的社群字幕，自動套用
      chrome.storage.local.get(`lastCommunitySubtitle_${videoId}`, (stored) => {
        const saved = stored[`lastCommunitySubtitle_${videoId}`];
        if (!saved) return;

        // 提前設定 flag，避免後續 YT 字幕資料或 loadSubtitle 覆蓋狀態
        customSubtitleActive = true;

        if (saved.primarySubtitles?.length)   primarySubtitles   = saved.primarySubtitles;
        if (saved.secondarySubtitles?.length) secondarySubtitles = saved.secondarySubtitles;
        renderSubtitleList();
        startSync();
        setActiveSourceBtn('community');

        const statusEl = document.getElementById('yt-sub-status');
        if (statusEl) {
          statusEl.textContent = `社群字幕：${saved.subtitleName || '未命名'}（by ${saved.authorName || '匿名'}）`;
          statusEl.className = 'yt-sub-status success';
        }
      });
    });
  }

  /**
   * 彈出社群字幕選擇面板，讓使用者選擇要載入的字幕版本
   */
  function showCommunitySubtitlePicker() {
    const videoId = new URLSearchParams(location.search).get('v') || '';
    if (!videoId) return;

    // 移除舊的 picker（避免重複）
    document.getElementById('yt-sub-community-picker')?.remove();

    chrome.runtime.sendMessage({ type: 'fb_getCommunitySubtitles', videoId }, (res) => {
      if (!res?.ok || !res.entries?.length) {
        alert('目前沒有社群字幕可用。');
        return;
      }

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
      picker.querySelector('.yt-sub-community-picker-close').addEventListener('click', () => picker.remove());

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
          }

          renderSubtitleList();
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

      // 附加到面板上
      const panel = document.getElementById('yt-sub-panel-subtitle');
      if (panel) panel.appendChild(picker);
      else document.body.appendChild(picker);
    });
  }

  /**
  /**
   * 標示目前使用中的字幕來源按鈕（紫色底色），另一個恢復預設
   * @param {'custom'|'community'|null} source
   */
  function setActiveSourceBtn(source) {
    const customBtn    = document.getElementById('yt-sub-custom-btn');
    const communityBtn = document.getElementById('yt-sub-community-btn');
    customBtn?.classList.toggle('active-source',    source === 'custom');
    communityBtn?.classList.toggle('active-source', source === 'community');
    // 有自定義/社群字幕來源時，封鎖 YT 字幕覆蓋
    customSubtitleActive = source !== null;
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
