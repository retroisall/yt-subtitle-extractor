// content.js — Content Script（隔離世界）
// 職責：注入 inject.js、接收字幕資料、渲染側邊欄 UI

(function () {
  'use strict';

  let subtitleData = [];     // 當前字幕清單
  let currentSubtitles = []; // 當前語言的完整字幕
  let syncInterval = null;
  let injected = false;      // 防止 inject.js 重複注入

  // ===== 注入 inject.js 到頁面的 main world =====
  function injectScript() {
    if (injected) {
      // 已注入過，直接請求重新提取
      window.postMessage({ type: 'YT_SUBTITLE_DEMO_REQUEST' }, '*');
      return;
    }
    injected = true;
    const script = document.createElement('script');
    script.src = chrome.runtime.getURL('inject.js');
    script.onload = function () {
      this.remove();
      // inject.js 自動輪詢，不需要額外發訊息
    };
    (document.head || document.documentElement).appendChild(script);
  }

  // ===== 建立側邊欄 UI =====
  function createSidebar() {
    if (document.getElementById('yt-sub-demo-sidebar')) return;

    const sidebar = document.createElement('div');
    sidebar.id = 'yt-sub-demo-sidebar';
    sidebar.innerHTML = `
      <div class="yt-sub-demo-header">
        <span class="yt-sub-demo-title">📝 字幕提取器</span>
        <button class="yt-sub-demo-toggle" id="yt-sub-demo-toggle">▲</button>
      </div>
      <div class="yt-sub-demo-body" id="yt-sub-demo-body">
        <div class="yt-sub-demo-status" id="yt-sub-demo-status">載入中...</div>
        <div class="yt-sub-demo-langs" id="yt-sub-demo-langs"></div>
        <div class="yt-sub-demo-current" id="yt-sub-demo-current"></div>
        <div class="yt-sub-demo-list" id="yt-sub-demo-list"></div>
      </div>
    `;
    document.body.appendChild(sidebar);

    // 收合/展開
    document.getElementById('yt-sub-demo-toggle').addEventListener('click', function () {
      sidebar.classList.toggle('collapsed');
      this.textContent = sidebar.classList.contains('collapsed') ? '▼' : '▲';
    });
  }

  // ===== 顯示可用語言清單 =====
  function renderLanguages(tracks) {
    const container = document.getElementById('yt-sub-demo-langs');
    const status = document.getElementById('yt-sub-demo-status');

    if (!tracks || tracks.length === 0) {
      status.textContent = '此影片沒有可用字幕';
      status.className = 'yt-sub-demo-status error';
      container.innerHTML = '';
      return;
    }

    status.textContent = `找到 ${tracks.length} 個字幕語言`;
    status.className = 'yt-sub-demo-status success';

    container.innerHTML = '<div class="yt-sub-demo-section-title">選擇語言：</div>';

    tracks.forEach(track => {
      const btn = document.createElement('button');
      btn.className = 'yt-sub-demo-lang-btn';
      btn.textContent = `${track.name} ${track.kind === 'asr' ? '(自動)' : ''}`;
      btn.dataset.lang = track.languageCode;
      btn.addEventListener('click', () => loadSubtitle(track));
      container.appendChild(btn);
    });
  }

  // ===== 載入選定語言的字幕（透過 inject.js 主世界 fetch，確保帶 cookie）=====
  let pendingTrackName = null;

  function loadSubtitle(track) {
    const status = document.getElementById('yt-sub-demo-status');

    // 高亮選中的按鈕
    document.querySelectorAll('.yt-sub-demo-lang-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.lang === track.languageCode);
    });

    status.textContent = `載入 ${track.name} 字幕中...`;
    status.className = 'yt-sub-demo-status';
    pendingTrackName = track.name;

    // 請 inject.js（主世界）去 fetch，它可以觸發 YouTube 播放器或使用快取
    window.postMessage({ type: 'YT_SUBTITLE_DEMO_FETCH', baseUrl: track.baseUrl, languageCode: track.languageCode }, '*');
  }

  // ===== 解析 JSON3 格式字幕 =====
  function parseJson3(json) {
    if (!json.events) return [];

    return json.events
      .filter(event => event.segs && event.segs.length > 0)
      .map(event => ({
        startTime: (event.tStartMs || 0) / 1000,
        duration: (event.dDurationMs || 0) / 1000,
        text: event.segs.map(seg => seg.utf8 || '').join('').trim()
      }))
      .filter(sub => sub.text.length > 0);
  }

  // ===== 渲染字幕清單 =====
  function renderSubtitleList() {
    const listEl = document.getElementById('yt-sub-demo-list');
    listEl.innerHTML = '';

    currentSubtitles.forEach((sub, index) => {
      const item = document.createElement('div');
      item.className = 'yt-sub-demo-item';
      item.dataset.index = index;
      item.innerHTML = `
        <span class="yt-sub-demo-time">${formatTime(sub.startTime)}</span>
        <span class="yt-sub-demo-text">${escapeHtml(sub.text)}</span>
      `;
      item.addEventListener('click', () => seekTo(sub.startTime));
      listEl.appendChild(item);
    });
  }

  // ===== 跳轉到指定時間 =====
  function seekTo(time) {
    const video = document.querySelector('video');
    if (video) {
      video.currentTime = time;
    }
  }

  // ===== 同步高亮當前字幕 =====
  function startSync() {
    if (syncInterval) clearInterval(syncInterval);

    syncInterval = setInterval(() => {
      const video = document.querySelector('video');
      if (!video || currentSubtitles.length === 0) return;

      const currentTime = video.currentTime;
      const currentEl = document.getElementById('yt-sub-demo-current');
      const items = document.querySelectorAll('.yt-sub-demo-item');
      let activeIndex = -1;

      for (let i = 0; i < currentSubtitles.length; i++) {
        const sub = currentSubtitles[i];
        const endTime = sub.startTime + sub.duration;
        if (currentTime >= sub.startTime && currentTime < endTime) {
          activeIndex = i;
          break;
        }
      }

      // 更新高亮
      items.forEach((item, i) => {
        if (i === activeIndex) {
          item.classList.add('active');
          // 自動滾動到可見範圍
          item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        } else {
          item.classList.remove('active');
        }
      });

      // 更新當前字幕顯示
      if (activeIndex >= 0) {
        currentEl.textContent = currentSubtitles[activeIndex].text;
        currentEl.className = 'yt-sub-demo-current active';
      } else {
        currentEl.textContent = '';
        currentEl.className = 'yt-sub-demo-current';
      }
    }, 100);
  }

  // ===== 工具函式 =====
  function formatTime(seconds) {
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  // ===== 監聽 inject.js 傳回的資料 =====
  window.addEventListener('message', function (event) {
    if (event.data?.type === 'YT_SUBTITLE_DEMO_CAPTIONS') {
      subtitleData = event.data.data || [];
      renderLanguages(subtitleData);
    }

    if (event.data?.type === 'YT_SUBTITLE_DEMO_SUBTITLE_DATA') {
      const status = document.getElementById('yt-sub-demo-status');
      if (event.data.error) {
        status.textContent = `載入失敗：${event.data.error}`;
        status.className = 'yt-sub-demo-status error';
        return;
      }
      currentSubtitles = parseJson3(event.data.data);
      status.textContent = `${pendingTrackName}：${currentSubtitles.length} 句字幕`;
      status.className = 'yt-sub-demo-status success';
      renderSubtitleList();
      startSync();
    }
  });

  // ===== 監聽 YouTube SPA 導航（content script 層） =====
  let lastUrl = location.href;
  const observer = new MutationObserver(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      // URL 變了，重置狀態
      currentSubtitles = [];
      if (syncInterval) clearInterval(syncInterval);

      const status = document.getElementById('yt-sub-demo-status');
      const listEl = document.getElementById('yt-sub-demo-list');
      const currentEl = document.getElementById('yt-sub-demo-current');

      if (status) status.textContent = '切換影片，重新載入...';
      if (listEl) listEl.innerHTML = '';
      if (currentEl) currentEl.textContent = '';

      // inject.js 會透過 yt-navigate-finish 事件自動重新提取
      // 若已注入，主動發送 REQUEST（inject.js 的輪詢機制也會處理）
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  // ===== 只在影片頁面啟動 =====
  function init() {
    if (!location.pathname.startsWith('/watch')) return;
    createSidebar();
    injectScript();
  }

  // 首次載入
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // SPA 導航時重新初始化
  const navObserver = new MutationObserver(() => {
    if (location.pathname.startsWith('/watch')) {
      if (!document.getElementById('yt-sub-demo-sidebar')) {
        init();
      }
    }
  });
  navObserver.observe(document.body, { childList: true, subtree: true });
})();