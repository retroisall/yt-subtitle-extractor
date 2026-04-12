// content.js — Content Script（隔離世界）

(function () {
  'use strict';

  // ===== 狀態 =====
  let trackList = [];
  let primarySubtitles = [];
  let _rawPrimarySubtitles = []; // 未延長的原始字幕（供設定切換時重算用）
  let secondarySubtitles = [];
  let syncInterval = null;
  let injected = false;
  let pendingTranslation = null;
  let translationJob = null;
  let loopingIdx = -1;
  const translationCache = {};  // videoId:lang → subtitles array (max 10 entries)
  const TRANSLATION_CACHE_MAX = 10;

  // ===== 常數 =====
  const SETTINGS_KEY = 'yt-sub-settings';

  const SECONDARY_LANG_OPTIONS = [
    { languageCode: 'zh-TW',   name: '繁體中文' },
    { languageCode: 'zh-Hans', name: '簡體中文' },
    { languageCode: 'en',      name: '英文' },
    { languageCode: 'ja',      name: '日文' },
    { languageCode: 'ko',      name: '韓文' },
    { languageCode: 'es',      name: '西班牙文' },
    { languageCode: 'fr',      name: '法文' },
    { languageCode: 'de',      name: '德文' },
    { languageCode: 'id',      name: '印尼文' },
    { languageCode: 'th',      name: '泰文' },
    { languageCode: 'vi',      name: '越南文' },
    { languageCode: 'pt',      name: '葡萄牙文' },
    { languageCode: 'ar',      name: '阿拉伯文' },
    { languageCode: 'ru',      name: '俄文' },
  ];

  const FONT_SIZES = {
    primary:   { sm: '11px', md: '13px', lg: '16px' },
    secondary: { sm: '10px', md: '12px', lg: '14px' },
  };

  const SECONDARY_COLORS = {
    purple: '#a855f7',
    cyan:   '#22d3ee',
    yellow: '#fbbf24',
    white:  '#e0e0e0',
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
    } catch (e) {}
    return defaultSettings();
  }

  function defaultSettings() {
    return {
      primaryLang:    'en',
      primaryVssId:   null,
      secondaryLangs: ['zh-TW', '__none__', '__none__'],  // 優先權 1→2→3
      dualEnabled:    true,
      asrLang:        'en',
      primarySize:    'md',
      secondarySize:  'sm',
      secondaryColor: 'purple',
      clickToSeek:    true,
      autoScroll:     true,
      overlayEnabled: true,
      loopSentence:   true,   // 單句循環
      translationProvider: 'ytlang',  // ytlang | google
      wordHover:      true,   // 單字 hover 高亮
      wordSpeak:      true,   // 點擊單字朗讀
      extensionEnabled:  true, // 套件整體開關
      extendSubtitles:   true, // 延長字幕顯示（填滿字幕間的空白間隔）
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
        <span class="yt-sub-title">字幕提取器</span>
        <div class="yt-sub-header-btns">
          <button class="yt-sub-icon-btn" id="yt-sub-refresh-btn" title="重新載入字幕">↻</button>
          <button class="yt-sub-icon-btn" id="yt-sub-wordbook-btn" title="生字本">★</button>
          <button class="yt-sub-icon-btn" id="yt-sub-settings-btn" title="設定">⚙</button>
          <button class="yt-sub-icon-btn" id="yt-sub-power-btn" title="關閉翻譯">⏻</button>
          <button class="yt-sub-icon-btn" id="yt-sub-toggle-btn">▲</button>
        </div>
      </div>

      <div class="yt-sub-body" id="yt-sub-body">

        <!-- 設定面板 -->
        <div class="yt-sub-settings" id="yt-sub-settings" style="display:none">

          <div class="yt-sub-settings-section">
            <div class="yt-sub-settings-section-title">語言</div>
            <div class="yt-sub-settings-row">
              <span class="yt-sub-settings-label">雙語模式</span>
              <label class="yt-sub-switch">
                <input type="checkbox" id="yt-sub-dual-toggle">
                <span class="yt-sub-switch-slider"></span>
              </label>
            </div>
            <div class="yt-sub-settings-row">
              <span class="yt-sub-settings-label">主字幕</span>
              <select id="yt-sub-primary-select" class="yt-sub-select"></select>
            </div>
            <div class="yt-sub-settings-row" id="yt-sub-secondary-row">
              <span class="yt-sub-settings-label">副字幕 1</span>
              <select id="yt-sub-secondary-select-0" class="yt-sub-select"></select>
            </div>
            <div class="yt-sub-settings-row" id="yt-sub-secondary-row-1">
              <span class="yt-sub-settings-label">副字幕 2</span>
              <select id="yt-sub-secondary-select-1" class="yt-sub-select"></select>
            </div>
            <div class="yt-sub-settings-row" id="yt-sub-secondary-row-2">
              <span class="yt-sub-settings-label">副字幕 3</span>
              <select id="yt-sub-secondary-select-2" class="yt-sub-select"></select>
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
          </div>

        </div>

        <!-- 生字本面板 -->
        <div class="yt-sub-wordbook" id="yt-sub-wordbook" style="display:none">
          <div class="yt-sub-wordbook-toolbar">
            <span class="yt-sub-wordbook-count" id="yt-sub-wordbook-count">0 個單字</span>
            <select class="yt-sub-select yt-sub-wordbook-sort" id="yt-sub-wordbook-sort">
              <option value="current-video">當前影片</option>
              <option value="date-desc">最近加入</option>
              <option value="count-desc">查詢最多</option>
              <option value="alpha">字母順序</option>
            </select>
          </div>
          <div class="yt-sub-wordbook-list" id="yt-sub-wordbook-list"></div>
        </div>

        <div class="yt-sub-status" id="yt-sub-status">載入中...</div>
        <div class="yt-sub-langs" id="yt-sub-langs"></div>
        <div class="yt-sub-current" id="yt-sub-current">
          <div class="yt-sub-current-primary" id="yt-sub-cur-primary"></div>
          <div class="yt-sub-current-secondary" id="yt-sub-cur-secondary"></div>
        </div>
        <div class="yt-sub-list" id="yt-sub-list"></div>

      </div>
    `;
    document.body.appendChild(sidebar);

    // 若套件為停用狀態，隱藏 body（header 仍可見供重新開啟）
    if (!settings.extensionEnabled) {
      document.getElementById('yt-sub-body').style.display = 'none';
    }

    // 收合 / 展開
    document.getElementById('yt-sub-toggle-btn').addEventListener('click', function () {
      sidebar.classList.toggle('collapsed');
      this.textContent = sidebar.classList.contains('collapsed') ? '▼' : '▲';
      updateOverlayRight();
    });

    updateOverlayRight();

    // 重新載入字幕
    document.getElementById('yt-sub-refresh-btn').addEventListener('click', () => {
      if (translationJob) { translationJob.cancelled = true; translationJob = null; }
      if (_nextBatchTimer) { clearTimeout(_nextBatchTimer); _nextBatchTimer = null; }
      primarySubtitles     = [];
      _rawPrimarySubtitles = [];
      secondarySubtitles = [];
      trackList = [];
      applyOverlay(); // 無字幕，撤掉 overlay 並恢復原生字幕
      if (syncInterval) clearInterval(syncInterval);
      const statusEl = document.getElementById('yt-sub-status');
      if (statusEl) { statusEl.textContent = '重新載入中...'; statusEl.className = 'yt-sub-status'; }
      const listEl = document.getElementById('yt-sub-list');
      if (listEl) listEl.innerHTML = '';
      const langsEl = document.getElementById('yt-sub-langs');
      if (langsEl) langsEl.innerHTML = '';
      const curPrim = document.getElementById('yt-sub-cur-primary');
      const curSec  = document.getElementById('yt-sub-cur-secondary');
      if (curPrim) curPrim.textContent = '';
      if (curSec)  curSec.textContent  = '';
      window.postMessage({ type: 'YT_SUBTITLE_DEMO_REQUEST' }, '*');
    });

    // 套件開關
    const powerBtn = document.getElementById('yt-sub-power-btn');
    powerBtn.classList.toggle('power-off', !settings.extensionEnabled);
    powerBtn.addEventListener('click', toggleExtension);

    // 設定面板開關
    document.getElementById('yt-sub-settings-btn').addEventListener('click', () => {
      const settingsPanel = document.getElementById('yt-sub-settings');
      const wbPanel = document.getElementById('yt-sub-wordbook');
      const opening = settingsPanel.style.display === 'none';
      settingsPanel.style.display = opening ? 'flex' : 'none';
      if (opening) wbPanel.style.display = 'none'; // 互斥
    });

    // 生字本面板開關
    document.getElementById('yt-sub-wordbook-btn').addEventListener('click', () => {
      const wbPanel = document.getElementById('yt-sub-wordbook');
      const settingsPanel = document.getElementById('yt-sub-settings');
      const opening = wbPanel.style.display === 'none';
      wbPanel.style.display = opening ? 'block' : 'none';
      if (opening) {
        settingsPanel.style.display = 'none'; // 互斥
        renderWordbook();
      }
    });

    // 生字本排序變更時重新渲染
    document.getElementById('yt-sub-wordbook-sort').addEventListener('change', () => renderWordbook());

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

    document.getElementById('yt-sub-primary-select').addEventListener('change', function () {
      const vssId = this.value;
      const track = trackList.find(t => (t.vssId || t.languageCode) === vssId);
      settings.primaryVssId = vssId;
      settings.primaryLang  = track?.languageCode || vssId;
      saveSettings();
      primarySubtitles = []; _rawPrimarySubtitles = [];
      if (track) loadSubtitle(track, 'primary');
      highlightActiveLangs();
    });

    [0, 1, 2].forEach(i => {
      document.getElementById(`yt-sub-secondary-select-${i}`).addEventListener('change', function () {
        settings.secondaryLangs[i] = this.value;
        saveSettings();
        refreshSecondarySelects();
        secondarySubtitles = [];
        autoLoadSubtitles(trackList);
      });
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
    const clickSeekEl   = document.getElementById('yt-sub-click-seek');
    const autoScrollEl  = document.getElementById('yt-sub-auto-scroll');
    clickSeekEl.checked  = settings.clickToSeek;
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

    // 套用初始顯示設定
    applyDisplaySettings();
    updateSizeGroupUI();
    updateSwatchGroupUI();
  }

  function updateTransProviderUI() {
    // 目前兩個 provider 都不需要額外輸入欄
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
    ['yt-sub-secondary-row', 'yt-sub-secondary-row-1', 'yt-sub-secondary-row-2'].forEach(id => {
      const row = document.getElementById(id);
      if (row) row.style.opacity = settings.dualEnabled ? '1' : '0.4';
    });
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
    sidebar.style.setProperty('--primary-fs',      FONT_SIZES.primary[settings.primarySize]   || '13px');
    sidebar.style.setProperty('--secondary-fs',    FONT_SIZES.secondary[settings.secondarySize] || '12px');
    sidebar.style.setProperty('--secondary-color', SECONDARY_COLORS[settings.secondaryColor]   || '#a855f7');
    // overlay 副字幕顏色同步
    const overlay = document.getElementById('yt-sub-overlay');
    if (overlay) overlay.style.setProperty('--ov-secondary-color', SECONDARY_COLORS[settings.secondaryColor] || '#a855f7');
  }

  // ===== 語言清單 =====
  function renderLanguages(tracks) {
    trackList = tracks || [];
    const container = document.getElementById('yt-sub-langs');
    const status    = document.getElementById('yt-sub-status');

    if (!trackList.length) {
      status.textContent = '此影片沒有可用字幕';
      status.className = 'yt-sub-status error';
      container.innerHTML = '';
      return;
    }

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
      settings.primaryLang  = track.languageCode;
      settings.primaryVssId = track.vssId || null;
      saveSettings();
      primarySubtitles = []; _rawPrimarySubtitles = [];
      const settingsSel = document.getElementById('yt-sub-primary-select');
      if (settingsSel) settingsSel.value = vssId;
      loadSubtitle(track, 'primary');
    });
    // 若設定語言在此影片中找不到，選中第一個 option 並臨時更新 runtime 設定
    // （不呼叫 saveSettings，保留使用者原始偏好語言給下一部影片使用）
    const anyMatched = displayTracks.some(t =>
      settings.primaryVssId
        ? (t.vssId || t.languageCode) === settings.primaryVssId
        : t.languageCode === settings.primaryLang
    );
    if (!anyMatched && displayTracks.length > 0) {
      const first = displayTracks[0];
      langDropdown.options[0].selected = true;
      // 臨時更新，使 autoLoadSubtitles 的 findPrimaryTrack 能找到正確 track
      settings.primaryLang  = first.languageCode;
      settings.primaryVssId = first.vssId || null;
    }

    container.appendChild(langDropdown);

    fillLangSelect('yt-sub-primary-select', displayTracks, settings.primaryVssId || settings.primaryLang, false);
    refreshSecondarySelects();
    highlightActiveLangs();
    autoLoadSubtitles(trackList);
  }

  function fillAsrSelect(asrTracks) {
    const row = document.getElementById('yt-sub-asr-row');
    const sel  = document.getElementById('yt-sub-asr-select');
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
    [0, 1, 2].forEach(i => {
      const sel = document.getElementById(`yt-sub-secondary-select-${i}`);
      if (!sel) return;
      const taken = settings.secondaryLangs.filter((l, idx) => idx !== i && l && l !== '__none__');
      const current = settings.secondaryLangs[i] ?? '__none__';
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
        if (taken.includes(t.languageCode)) return; // 只排除完全相同的 value
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
        if (taken.includes(val)) return; // 只排除完全相同的 value
        const opt = document.createElement('option');
        opt.value = val;
        opt.textContent = t.name + '（翻譯）';
        if (val === current) opt.selected = true;
        grp2.appendChild(opt);
      });
      sel.appendChild(grp2);
    });
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
    'zh-TW':   ['zh-TW', 'zh-Hant', 'zh'],
    'zh-Hans': ['zh-Hans', 'zh-CN', 'zh-SG'],
    'pt':      ['pt', 'pt-BR', 'pt-PT'],
    'es':      ['es', 'es-419', 'es-US', 'es-MX'],
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
  function autoLoadSubtitles(tracks) {
    if (!tracks.length) return;
    // 找偏好語言的 track；若仍找不到（非從 renderLanguages 呼叫的路徑），fallback 到第一條
    const primary = findPrimaryTrack(tracks) || tracks.find(t => !(t.vssId||'').startsWith('a.')) || tracks[0] || null;
    if (primary) loadSubtitle(primary, 'primary');

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
    if (tag === 'primary') {
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
        duration:  (e.dDurationMs || 2000) / 1000,
        text: e.segs.map(s => s.utf8 || '').join('').trim(),
      }))
      .filter(s => s.text.length > 0);
  }

  // ===== 渲染字幕清單 =====
  function renderSubtitleList() {
    const listEl = document.getElementById('yt-sub-list');
    if (!listEl) return;
    listEl.innerHTML = '';

    primarySubtitles.forEach((sub, index) => {
      const item = document.createElement('div');
      item.className = 'yt-sub-item';
      item.dataset.index = index;

      const midTime = sub.startTime + sub.duration / 2;
      const secSub  = findSubAtTime(secondarySubtitles, midTime);

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

  // ===== 單字查詢浮窗 =====
  const dictCache = {};  // word → result (max 200 entries)
  const DICT_CACHE_MAX = 200;

  function showWordPopup(word, anchor) {
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
    if (top + 280 > window.innerHeight - margin) top = rect.top - 286;
    top = Math.max(margin, top);
    popup.style.left = left + 'px';
    popup.style.top  = top + 'px';
    popup.style.display = 'block';
    popup.innerHTML = `<div class="yt-sub-popup-loading">查詢「${word}」中...</div>`;

    // 點其他地方關閉
    const close = e => { if (!popup.contains(e.target) && e.target !== anchor) { popup.style.display = 'none'; window.removeEventListener('click', close, true); } };
    setTimeout(() => window.addEventListener('click', close, true), 50);

    popup.dataset.word = word;
    lookupWord(word).then(result => {
      if (popup.style.display === 'none' || popup.dataset.word !== word) return;
      if (!result) {
        popup.innerHTML = `<div class="yt-sub-popup-error">找不到「${word}」的定義</div>`;
        return;
      }
      renderPopupContent(popup, result);
    });
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
      // 字典與詞頻並行請求，互不阻塞
      const [resp, tier] = await Promise.all([
        fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`),
        fetchWordTier(word),
      ]);
      if (!resp.ok) { dictCacheSet(word, null); return null; }
      const data = await resp.json();
      const entry = data[0];
      const firstMeaning = entry.meanings[0];
      const firstDef     = firstMeaning?.definitions[0];
      const synonyms     = (firstMeaning?.synonyms || []).slice(0, 4);

      const result = {
        word: entry.word,
        phonetic: entry.phonetic || entry.phonetics?.find(p => p.text)?.text || '',
        partOfSpeech: firstMeaning?.partOfSpeech || '',
        definition: firstDef?.definition || '',
        wordZh:       '',   // 單字本身的通用中文翻譯（miracle → 奇蹟）
        definitionZh: '',   // 定義的中文翻譯
        example: firstDef?.example || '',
        synonyms: synonyms.map(s => ({ en: s, zh: '' })),
        translating: true,  // 翻譯進行中
        tier,               // 詞頻分級
      };
      dictCacheSet(word, result);

      // 非同步翻譯：索引固定為 0=單字, 1=定義, 2+=近似詞
      // 不使用 filter(Boolean)，保留空字串佔位，確保索引不偏移
      const toTranslate = [word, firstDef?.definition || '', ...synonyms];
      if (word || firstDef?.definition || synonyms.length) {
        Promise.all(toTranslate.map(t => t ? translateGoogle(t, 'zh-TW').catch(() => '') : Promise.resolve(''))).then(translations => {
          result.wordZh       = translations[0] || '';
          result.definitionZh = translations[1] || '';
          result.synonyms = synonyms.map((s, i) => ({ en: s, zh: translations[i + 2] || '' }));
          result.translating = false;
          // 若 popup 仍顯示此單字，更新 DOM
          const popup = document.getElementById('yt-sub-word-popup');
          if (popup?.style.display !== 'none' && popup?.dataset.word === word) {
            renderPopupContent(popup, result);
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
    const hasCachedLookup  = dictCache[word] !== undefined;
    const cached           = hasCachedLookup ? dictCache[word] : null;
    const cachedNotFound   = hasCachedLookup && cached === null; // 查過但字典無此字
    const cachedTier       = cached?.tier ?? null;
    const cachedWordZh     = cached?.wordZh || '';
    const cachedZh         = cached?.definitionZh || '';
    const videoId    = new URLSearchParams(location.search).get('v') || '';

    chrome.storage.local.get(SAVED_WORDS_KEY, data => {
      const saved = data[SAVED_WORDS_KEY] || {};
      const alreadySaved = !!saved[word];
      if (!alreadySaved) {
        saved[word] = {
          word,
          addedAt:      Date.now(),
          count:        1,
          tier:         cachedTier,
          tierFetched:  hasCachedLookup,
          noDefinition: cachedNotFound,   // true = 字典查無此字，不顯示查詢按鈕
          wordZh:       cachedWordZh,     // 單字通用中文（危險、奇蹟...）
          definitionZh: cachedZh,
          context:      sentenceContext || '',
          contextZh:    '',        // 非同步翻譯後填入
          videoId,
          startTime:    startTime ?? 0,
        };
      } else {
        saved[word].count = (saved[word].count || 1) + 1;
        if (!saved[word].tier && cachedTier) { saved[word].tier = cachedTier; saved[word].tierFetched = true; }
        if (!saved[word].wordZh && cachedWordZh) saved[word].wordZh = cachedWordZh;
        if (!saved[word].definitionZh && cachedZh) saved[word].definitionZh = cachedZh;
        if (sentenceContext) {
          // 只有例句真的變了才重置 contextZh，避免連續右鍵重複打翻譯 API
          if (saved[word].context !== sentenceContext) saved[word].contextZh = '';
          saved[word].context   = sentenceContext;
          saved[word].videoId   = videoId;
          saved[word].startTime = startTime ?? 0;
        }
      }
      chrome.storage.local.set({ [SAVED_WORDS_KEY]: saved }, () => {
        if (chrome.runtime.lastError) {
          console.error('[YT-SUB] storage.set 失敗:', chrome.runtime.lastError.message);
          return;
        }
        if (anchor) anchor.classList.add('word-saved');
        showSaveToast(word, alreadySaved);
        // 面板開著時立即更新列表
        if (document.getElementById('yt-sub-wordbook')?.style.display !== 'none') {
          renderWordbook();
        }
        // 非同步翻譯例句，完成後寫回 storage 並重新渲染
        if (sentenceContext && !saved[word].contextZh) {
          translateGoogle(sentenceContext, 'zh-TW').then(zh => {
            if (!zh) return;
            chrome.storage.local.get(SAVED_WORDS_KEY, d2 => {
              if (chrome.runtime.lastError) return;
              const s2 = d2[SAVED_WORDS_KEY] || {};
              if (s2[word]) {
                s2[word].contextZh = zh;
                chrome.storage.local.set({ [SAVED_WORDS_KEY]: s2 }, () => {
                  if (document.getElementById('yt-sub-wordbook')?.style.display !== 'none') {
                    renderWordbook();
                  }
                });
              }
            });
          }).catch(() => {});
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
                  s2[word].tierFetched  = true;
                  chrome.storage.local.set({ [SAVED_WORDS_KEY]: s2 }, () => {
                    if (document.getElementById('yt-sub-wordbook')?.style.display !== 'none') {
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
                s2[word].tier         = result.tier || null;
                s2[word].tierFetched  = true;
                if (!s2[word].wordZh)       s2[word].wordZh       = result.wordZh       || '';
                if (!s2[word].definitionZh) s2[word].definitionZh = result.definitionZh || '';
                chrome.storage.local.set({ [SAVED_WORDS_KEY]: s2 }, () => {
                  if (document.getElementById('yt-sub-wordbook')?.style.display !== 'none') {
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
  function renderWordbook() {
    chrome.storage.local.get(SAVED_WORDS_KEY, data => {
      const saved = data[SAVED_WORDS_KEY] || {};
      const words = Object.values(saved);
      const countEl = document.getElementById('yt-sub-wordbook-count');
      const listEl  = document.getElementById('yt-sub-wordbook-list');
      const sortEl  = document.getElementById('yt-sub-wordbook-sort');
      if (!listEl || !countEl) return;

      // 過濾 + 排序
      const sortKey = sortEl?.value || 'current-video';
      const currentVideoId = new URLSearchParams(location.search).get('v') || '';

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
        const ctxHtml = item.context
          ? `<button class="yt-sub-wb-ctx" title="查看原句">≡</button>`
          : '';
        row.innerHTML = `
          <span class="yt-sub-wb-word${item.noDefinition ? ' no-def' : ''}">${escapeHtml(item.word)}</span>
          ${item.wordZh ? `<span class="yt-sub-wb-zh">${escapeHtml(item.wordZh)}</span>` : ''}
          ${tierHtml}
          ${item.count > 1 ? `<span class="yt-sub-wb-meta">×${item.count}</span>` : ''}
          ${ctxHtml}
          <button class="yt-sub-wb-del" data-word="${escapeHtml(item.word)}" title="刪除">×</button>
        `;

        // 點擊單字查字典（字典查無此字時不掛 listener）
        if (!item.noDefinition) {
          row.querySelector('.yt-sub-wb-word').addEventListener('click', e => {
            showWordPopup(item.word, e.target);
          });
        }

        // 點擊原句按鈕
        if (item.context) {
          row.querySelector('.yt-sub-wb-ctx').addEventListener('click', e => {
            e.stopPropagation();
            showSentencePopup(item, e.target);
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
      delete saved[word];
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
    const sbRect  = sidebar?.getBoundingClientRect();
    const popupW  = 280;
    const left       = sbRect ? sbRect.left + (sbRect.width - popupW) / 2 : window.innerWidth - popupW - 16;
    const anchorRect = anchor.getBoundingClientRect();
    const topBelow   = anchorRect.bottom + 6;
    const popupH     = 120; // 預估高度，避免超出視窗底部
    const top        = topBelow + popupH > window.innerHeight ? anchorRect.top - popupH - 6 : topBelow;
    popup.style.left = Math.max(8, Math.min(left, window.innerWidth - popupW - 8)) + 'px';
    popup.style.top  = Math.max(8, top) + 'px';

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
    const BATCH = 8;
    let done = 0;

    for (let b = 0; b < indices.length; b += BATCH) {
      if (job.cancelled) return;
      const batch = indices.slice(b, b + BATCH);
      for (const i of batch) {
        if (job.cancelled) return;
        try {
          const result = await translateOne(subs[i].text, targetLang);
          // 直接更新對應的 secondary 句，不重建整個陣列
          const existing = secondarySubtitles.findIndex(s => s.startTime === subs[i].startTime);
          const entry = { ...subs[i], text: result };
          if (existing >= 0) secondarySubtitles[existing] = entry;
          else secondarySubtitles.push(entry);
          // 只更新這一條 DOM，不重建整個列表
          patchSubtitleItem(i, result);
        } catch (e) {
          if (job.cancelled) return;
          if (statusEl) { statusEl.textContent = `翻譯失敗：${e.message}`; statusEl.className = 'yt-sub-status error'; }
          return;
        }
        done++;
      }
      if (!syncInterval) startSync();
      if (statusEl) {
        statusEl.textContent = `主：${primaryName}（${subs.length} 句）｜翻譯中 ${done}/${indices.length}`;
        statusEl.className = 'yt-sub-status success';
      }
      if (b + BATCH < indices.length) await new Promise(r => setTimeout(r, 400));
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
      // 已經到邊界，立刻翻
      translateAndSetSecondary(subs, targetLang, lastTranslated.startTime + lastTranslated.duration);
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
          showWordPopup(clean, span);
        });
        // 右鍵儲存單字到生字本（capture phase 搶先 YouTube handler，stopImmediatePropagation 防止後續 handler 干擾）
        span.addEventListener('contextmenu', e => {
          e.preventDefault();
          e.stopImmediatePropagation();
          const clean = lemmatize(token.toLowerCase().replace(/'s$/i, '').replace(/['-]$/, ''));
          saveWord(clean, span, text, startTime); // text 為整句字幕，startTime 為句子時間軸
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
      const midTime = sub.startTime + sub.duration / 2;
      const secSub = findSubAtTime(secondarySubtitles, midTime);
      patchSubtitleItem(i, secSub?.text || null);
    });
  }

  async function translateOne(text, targetLang) {
    switch (settings.translationProvider) {
      case 'google': return translateGoogle(text, targetLang);
      default:       return text;
    }
  }

  async function translateGoogle(text, targetLang) {
    const lang = ({ 'zh-Hans': 'zh-CN' })[targetLang] || targetLang;
    const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t'
      + '&tl=' + encodeURIComponent(lang) + '&q=' + encodeURIComponent(text);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('Google 翻譯回傳 ' + resp.status);
    const data = await resp.json();
    return data[0].map(s => s[0]).join('').trim();
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
  }

  function updateOverlayRight() {
    const overlay = document.getElementById('yt-sub-overlay');
    if (!overlay) return;
    const collapsed = document.getElementById('yt-sub-demo-sidebar')?.classList.contains('collapsed');
    overlay.style.right = collapsed ? '2%' : 'calc(360px + 2%)';
  }

  function removeOverlay() {
    document.getElementById('yt-sub-overlay')?.remove();
  }

  function updateOverlay(primText, secText, primIdx = -1) {
    const ovPrim = document.getElementById('yt-sub-ov-primary');
    const ovSec  = document.getElementById('yt-sub-ov-secondary');
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

    // 偵測跳轉：若外部翻譯進行中，跳到未翻譯區域時重新翻譯
    const video = document.querySelector('video');
    if (video && _seekHandler) video.removeEventListener('seeked', _seekHandler);
    if (video) {
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
      const primIdx  = findActiveIndex(primarySubtitles, t);
      const primSub  = primIdx >= 0 ? primarySubtitles[primIdx] : null;
      const secSub   = primSub
        ? findSubAtTime(secondarySubtitles, primSub.startTime + primSub.duration / 2)
        : null;

      const curPrimEl = document.getElementById('yt-sub-cur-primary');
      const curSecEl  = document.getElementById('yt-sub-cur-secondary');
      const curWrap   = document.getElementById('yt-sub-current');

      if (curPrimEl) {
        const newText = primSub ? primSub.text : '';
        if (curPrimEl.dataset.text !== newText) {
          curPrimEl.dataset.text = newText;
          curPrimEl.innerHTML = '';
          if (newText) buildTokenizedText(curPrimEl, newText, primSub?.startTime ?? 0);
        }
      }
      if (curSecEl)  curSecEl.textContent  = secSub && settings.dualEnabled ? secSub.text : '';
      if (curWrap)   curWrap.classList.toggle('active', primSub !== null || (secSub !== null && settings.dualEnabled));
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

      const items = document.getElementById('yt-sub-list')?.children;
      if (items) {
        for (let i = 0; i < items.length; i++) {
          const active = i === primIdx;
          items[i].classList.toggle('active', active);
          if (active && settings.autoScroll) items[i].scrollIntoView({ behavior: 'smooth', block: 'nearest' });
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

  function isVowel(c)     { return 'aeiou'.includes(c); }
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
  window.addEventListener('message', function (event) {
    if (event.data?.type === 'YT_SUBTITLE_DEMO_CAPTIONS') {
      clearTimeout(captionsDebounce);
      captionsDebounce = setTimeout(() => renderLanguages(event.data.data), 100);
    }

    if (event.data?.type === 'YT_SUBTITLE_DEMO_SUBTITLE_DATA') {
      const tag = event.data.tag || 'primary';
      const statusEl = document.getElementById('yt-sub-status');

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
        if (statusEl) {
          const name = trackList.find(t => t.languageCode === settings.primaryLang)?.name || settings.primaryLang;
          statusEl.textContent = `主：${name}（${parsed.length} 句）`;
          statusEl.className = 'yt-sub-status success';
        }
        if (pendingTranslation) {
          const { targetLang } = pendingTranslation;
          pendingTranslation = null;
          translateAndSetSecondary(parsed, targetLang);
        }
      } else {
        secondarySubtitles = parsed;
      }

      renderSubtitleList();
      startSync();
    }
  });

  // ===== SPA 導航 + sidebar 重建：單一 Observer =====
  let lastUrl = location.href;
  new MutationObserver(() => {
    // SPA 換頁
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      if (translationJob) { translationJob.cancelled = true; translationJob = null; }
      if (_nextBatchTimer) { clearTimeout(_nextBatchTimer); _nextBatchTimer = null; }
      primarySubtitles     = [];
      _rawPrimarySubtitles = [];
      secondarySubtitles = [];
      trackList = [];
      applyOverlay(); // 換頁時撤掉 overlay
      if (syncInterval) clearInterval(syncInterval);
      const statusEl = document.getElementById('yt-sub-status');
      if (statusEl) statusEl.textContent = '切換影片，重新載入...';
      const list = document.getElementById('yt-sub-list');
      const primCur = document.getElementById('yt-sub-cur-primary');
      const secCur  = document.getElementById('yt-sub-cur-secondary');
      if (list)    list.innerHTML    = '';
      if (primCur) primCur.textContent = '';
      if (secCur)  secCur.textContent  = '';
      updateOverlay('', '');
      // 生字本面板開著時，重新渲染以更新「當前影片」篩選
      if (document.getElementById('yt-sub-wordbook')?.style.display !== 'none') {
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

    const btn  = document.getElementById('yt-sub-power-btn');
    const body = document.getElementById('yt-sub-body');

    if (settings.extensionEnabled) {
      // 開啟：恢復 body，重新觸發字幕載入
      if (body) body.style.display = '';
      if (btn)  { btn.classList.remove('power-off'); btn.title = '關閉翻譯'; }
      window.postMessage({ type: 'YT_SUBTITLE_DEMO_REQUEST' }, '*');
    } else {
      // 關閉：停止背景任務，隱藏 body（header 保留供重新開啟）
      if (syncInterval) { clearInterval(syncInterval); syncInterval = null; }
      const video = document.querySelector('video');
      if (video && _seekHandler) { video.removeEventListener('seeked', _seekHandler); _seekHandler = null; }
      if (translationJob) { translationJob.cancelled = true; translationJob = null; }
      if (body) body.style.display = 'none';
      if (btn)  { btn.classList.add('power-off'); btn.title = '開啟翻譯'; }
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
})();
