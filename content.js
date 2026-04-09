// content.js — Content Script（隔離世界）

(function () {
  'use strict';

  // ===== 狀態 =====
  let trackList = [];
  let primarySubtitles = [];
  let secondarySubtitles = [];
  let syncInterval = null;
  let injected = false;

  // ===== 常數 =====
  const SETTINGS_KEY = 'yt-sub-settings';

  const TRANSLATION_TARGETS = [
    { languageCode: 'zh-TW',   name: '繁體中文（翻譯）' },
    { languageCode: 'zh-Hans', name: '簡體中文（翻譯）' },
    { languageCode: 'ja',      name: '日文（翻譯）' },
    { languageCode: 'ko',      name: '韓文（翻譯）' },
    { languageCode: 'en',      name: '英文（翻譯）' },
    { languageCode: 'es',      name: '西班牙文（翻譯）' },
    { languageCode: 'fr',      name: '法文（翻譯）' },
    { languageCode: 'de',      name: '德文（翻譯）' },
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
      if (saved) return { ...defaultSettings(), ...JSON.parse(saved) };
    } catch (e) {}
    return defaultSettings();
  }

  function defaultSettings() {
    return {
      primaryLang:    'en',
      primaryVssId:   null,       // 識別特定 track（區分手動/ASR）
      secondaryLang:  'zh-TW',
      dualEnabled:    true,
      asrLang:        'en',       // 使用者偏好的自動產生字幕語言
      primarySize:    'md',
      secondarySize:  'sm',
      secondaryColor: 'purple',
      clickToSeek:    true,
      autoScroll:     true,
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
          <button class="yt-sub-icon-btn" id="yt-sub-settings-btn" title="設定">⚙</button>
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
              <span class="yt-sub-settings-label">副字幕</span>
              <select id="yt-sub-secondary-select" class="yt-sub-select"></select>
            </div>
            <div class="yt-sub-settings-row" id="yt-sub-asr-row" style="display:none">
              <span class="yt-sub-settings-label">自動產生語言</span>
              <select id="yt-sub-asr-select" class="yt-sub-select"></select>
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
          </div>

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

    // 收合 / 展開
    document.getElementById('yt-sub-toggle-btn').addEventListener('click', function () {
      sidebar.classList.toggle('collapsed');
      this.textContent = sidebar.classList.contains('collapsed') ? '▼' : '▲';
    });

    // 重新載入字幕
    document.getElementById('yt-sub-refresh-btn').addEventListener('click', () => {
      primarySubtitles  = [];
      secondarySubtitles = [];
      trackList = [];
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

    // 設定面板開關
    document.getElementById('yt-sub-settings-btn').addEventListener('click', () => {
      const panel = document.getElementById('yt-sub-settings');
      panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
    });

    // ── 語言設定（即時生效）────────────────────────────────────
    const dualToggle = document.getElementById('yt-sub-dual-toggle');
    dualToggle.checked = settings.dualEnabled;
    updateSecondaryRowOpacity();

    dualToggle.addEventListener('change', () => {
      settings.dualEnabled = dualToggle.checked;
      saveSettings();
      updateSecondaryRowOpacity();
      primarySubtitles = [];
      secondarySubtitles = [];
      autoLoadSubtitles(trackList);
    });

    document.getElementById('yt-sub-primary-select').addEventListener('change', function () {
      const vssId = this.value;
      const track = trackList.find(t => (t.vssId || t.languageCode) === vssId);
      settings.primaryVssId = vssId;
      settings.primaryLang  = track?.languageCode || vssId;
      saveSettings();
      primarySubtitles = [];
      if (track) loadSubtitle(track, 'primary');
      highlightActiveLangs();
    });

    document.getElementById('yt-sub-secondary-select').addEventListener('change', function () {
      settings.secondaryLang = this.value;
      saveSettings();
      secondarySubtitles = [];
      autoLoadSubtitles(trackList);
      highlightActiveLangs();
    });

    document.getElementById('yt-sub-asr-select').addEventListener('change', function () {
      settings.asrLang = this.value;
      // 若目前主字幕是舊的 ASR track，清掉讓它重選
      const currentTrack = trackList.find(t => t.vssId === settings.primaryVssId);
      if (currentTrack && (currentTrack.vssId || '').startsWith('a.')) {
        settings.primaryVssId = null;
      }
      saveSettings();
      primarySubtitles = [];
      secondarySubtitles = [];
      renderLanguages(trackList); // 重新渲染（過濾後只顯示選定的 ASR）
    });

    // ── 顯示設定（即時套用）────────────────────────────────────
    setupSizeGroup('yt-sub-primary-size-group', 'primarySize');
    setupSizeGroup('yt-sub-secondary-size-group', 'secondarySize');
    setupSwatchGroup('yt-sub-color-group', 'secondaryColor');

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

    // 套用初始顯示設定
    applyDisplaySettings();
    updateSizeGroupUI();
    updateSwatchGroupUI();
  }

  function updateSecondaryRowOpacity() {
    const row = document.getElementById('yt-sub-secondary-row');
    if (row) row.style.opacity = settings.dualEnabled ? '1' : '0.4';
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
      primarySubtitles = [];
      const settingsSel = document.getElementById('yt-sub-primary-select');
      if (settingsSel) settingsSel.value = vssId;
      loadSubtitle(track, 'primary');
    });
    container.appendChild(langDropdown);

    fillLangSelect('yt-sub-primary-select',   displayTracks, settings.primaryVssId || settings.primaryLang, false);
    fillLangSelect('yt-sub-secondary-select', trackList,     settings.secondaryLang, true);
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
      // 副字幕選單：用 languageCode 作為 value
      const noneOpt = document.createElement('option');
      noneOpt.value = '__none__';
      noneOpt.textContent = '（不顯示副字幕）';
      sel.appendChild(noneOpt);

      if (tracks.length) {
        const grp = document.createElement('optgroup');
        grp.label = '原生字幕';
        tracks.forEach(t => {
          const opt = document.createElement('option');
          opt.value = t.languageCode;
          opt.textContent = t.name + (t.kind === 'asr' ? ' (自動)' : '');
          if (t.languageCode === selected) opt.selected = true;
          grp.appendChild(opt);
        });
        sel.appendChild(grp);
      }

      const tlGrp = document.createElement('optgroup');
      tlGrp.label = 'YouTube 機器翻譯';
      TRANSLATION_TARGETS.forEach(t => {
        // 只有影片沒有完全相同 languageCode 才顯示（避免重複）
        if (tracks.find(tr => tr.languageCode === t.languageCode)) return;
        const opt = document.createElement('option');
        opt.value = t.languageCode;
        opt.textContent = t.name;
        if (t.languageCode === selected) opt.selected = true;
        tlGrp.appendChild(opt);
      });
      if (tlGrp.childElementCount > 0) sel.appendChild(tlGrp);

      if (sel.value !== selected) sel.value = selected;
    }
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

  // ===== 自動載入主、副字幕 =====
  function autoLoadSubtitles(tracks) {
    if (!tracks.length) return;
    const primary = findPrimaryTrack(tracks);
    if (primary) loadSubtitle(primary, 'primary');

    if (settings.dualEnabled && settings.secondaryLang !== '__none__') {
      // secondary：strict exact match only；沒有才走 &tlang= 翻譯
      const secondary = tracks.find(t => t.languageCode === settings.secondaryLang);
      if (secondary) {
        loadSubtitle(secondary, 'secondary');
      } else {
        // 優先用 ASR track 作為翻譯來源（品質較好）
        const base = tracks.find(t => (t.vssId || '').startsWith('a.')) || tracks[0];
        if (base) loadSubtitle(base, 'secondary', settings.secondaryLang);
      }
    }
  }

  // 找主字幕 track：優先用 vssId 精確比對；其次偏好手動 track（non-ASR）
  function findPrimaryTrack(tracks) {
    if (settings.primaryVssId) {
      const byVssId = tracks.find(t => t.vssId === settings.primaryVssId);
      if (byVssId) return byVssId;
    }
    // 同語言中優先手動，次選 ASR
    return tracks.find(t => t.languageCode === settings.primaryLang && !(t.vssId || '').startsWith('a.'))
      || tracks.find(t => t.languageCode === settings.primaryLang)
      || null;
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

      item.innerHTML = `
        <span class="yt-sub-time">${formatTime(sub.startTime)}</span>
        <div class="yt-sub-texts">
          <div class="yt-sub-text-primary">${escapeHtml(sub.text)}</div>
          ${settings.dualEnabled && secSub
            ? `<div class="yt-sub-text-secondary">${escapeHtml(secSub.text)}</div>`
            : ''}
        </div>
      `;
      if (settings.clickToSeek) {
        item.addEventListener('click', () => seekTo(sub.startTime));
        item.style.cursor = 'pointer';
      }
      listEl.appendChild(item);
    });
  }

  function findSubAtTime(subs, time) {
    return subs.find(s => time >= s.startTime && time < s.startTime + s.duration) || null;
  }

  // ===== 同步高亮 =====
  function startSync() {
    if (syncInterval) clearInterval(syncInterval);

    syncInterval = setInterval(() => {
      const video = document.querySelector('video');
      if (!video || !primarySubtitles.length) return;

      const t = video.currentTime;
      const primIdx = findActiveIndex(primarySubtitles, t);
      const secIdx  = findActiveIndex(secondarySubtitles, t);

      const curPrimEl = document.getElementById('yt-sub-cur-primary');
      const curSecEl  = document.getElementById('yt-sub-cur-secondary');
      const curWrap   = document.getElementById('yt-sub-current');

      if (curPrimEl) curPrimEl.textContent = primIdx >= 0 ? primarySubtitles[primIdx].text : '';
      if (curSecEl)  curSecEl.textContent  = secIdx  >= 0 && settings.dualEnabled ? secondarySubtitles[secIdx].text : '';
      if (curWrap)   curWrap.classList.toggle('active', primIdx >= 0 || (secIdx >= 0 && settings.dualEnabled));

      document.querySelectorAll('.yt-sub-item').forEach((el, i) => {
        const active = i === primIdx;
        el.classList.toggle('active', active);
        if (active && settings.autoScroll) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      });
    }, 100);
  }

  function findActiveIndex(subs, time) {
    return subs.findIndex(s => time >= s.startTime && time < s.startTime + s.duration);
  }

  function seekTo(time) {
    const video = document.querySelector('video');
    if (video) video.currentTime = time;
  }

  // ===== 工具 =====
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

      const parsed = parseJson3(event.data.data);

      if (tag === 'primary') {
        primarySubtitles = parsed;
        if (statusEl) {
          const name = trackList.find(t => t.languageCode === settings.primaryLang)?.name || settings.primaryLang;
          statusEl.textContent = `主：${name}（${parsed.length} 句）`;
          statusEl.className = 'yt-sub-status success';
        }
      } else {
        secondarySubtitles = parsed;
      }

      renderSubtitleList();
      startSync();
    }
  });

  // ===== SPA 導航 =====
  let lastUrl = location.href;
  new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      primarySubtitles = [];
      secondarySubtitles = [];
      trackList = [];
      if (syncInterval) clearInterval(syncInterval);
      const els = {
        status: document.getElementById('yt-sub-status'),
        list:   document.getElementById('yt-sub-list'),
        primCur: document.getElementById('yt-sub-cur-primary'),
        secCur:  document.getElementById('yt-sub-cur-secondary'),
      };
      if (els.status)  els.status.textContent  = '切換影片，重新載入...';
      if (els.list)    els.list.innerHTML       = '';
      if (els.primCur) els.primCur.textContent  = '';
      if (els.secCur)  els.secCur.textContent   = '';
    }
  }).observe(document.body, { childList: true, subtree: true });

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

  new MutationObserver(() => {
    if (location.pathname.startsWith('/watch') && !document.getElementById('yt-sub-demo-sidebar')) init();
  }).observe(document.body, { childList: true, subtree: true });
})();
