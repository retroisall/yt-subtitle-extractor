// patch.js — document_start，main world
// 在 YouTube 任何程式碼執行前：
//   1. 攔截 ytInitialPlayerResponse 設值（HTML embed + SPA 更新都抓得到）
//   2. 攔截 fetch / XHR 的 /youtubei/v1/player 和 /api/timedtext

(function () {
  'use strict';
  if (window.__YT_SUB_PATCH__) return;
  window.__YT_SUB_PATCH__ = true;

  window.__YT_SUB_ORIG_FETCH__      = window.fetch;
  window.__YT_SUB_PLAYER_CACHE__    = {};
  window.__YT_SUB_TIMEDTEXT_CACHE__ = {};

  // ── 統一入口：收到 player 資料就快取並通知 ─────────────────
  function onPlayerData(json) {
    try {
      const renderer = json?.captions?.playerCaptionsTracklistRenderer;
      const videoId  = json?.videoDetails?.videoId;
      if (!renderer?.captionTracks?.length || !videoId) return;
      window.__YT_SUB_PLAYER_CACHE__[videoId] = { renderer, ts: Date.now() };
      window.dispatchEvent(new CustomEvent('__yt_sub_player__', { detail: { videoId } }));
    } catch (e) {}
  }

  // ── 攔截 ytInitialPlayerResponse 的設值 ────────────────────
  // 初始頁面載入時 YouTube 直接把 JSON embed 在 HTML <script> 裡，
  // 執行 `window.ytInitialPlayerResponse = {...}` —— 我們在這裡抓到它
  // SPA 導航時 YouTube 也會再次 set，一樣觸發
  let _ipr = undefined;
  try {
    Object.defineProperty(window, 'ytInitialPlayerResponse', {
      configurable: true,
      get: () => _ipr,
      set: (v) => {
        _ipr = v;
        onPlayerData(v);
      },
    });
  } catch (e) {}

  // 若頁面已有值（例如擴充套件晚載），直接讀一次
  if (window.ytInitialPlayerResponse) onPlayerData(window.ytInitialPlayerResponse);

  // ── relay helper（inject.js 設好後才可用，Debug Relay 關閉時為 no-op）──
  function dbg(msg) {
    // if (typeof window.__dbgSend === 'function') window.__dbgSend(msg);
  }

  // ── timedtext 快取 ──────────────────────────────────────────
  function onTimedtext(url, text) {
    // 不論有無內容，先 relay 完整 URL 供分析
    try {
      const p    = new URL(url);
      const v    = p.searchParams.get('v') || '?';
      const lang = p.searchParams.get('lang') || '—';
      const tlang= p.searchParams.get('tlang') || '—';
      const hasPot = p.searchParams.has('pot') ? '✅pot' : '—';
      const len  = text?.length || 0;
      dbg(`[patch:timedtext] v=${v} lang=${lang} tlang=${tlang} pot=${hasPot} len=${len}`);
    } catch (e) {}

    if (!text || text.length < 10) return;
    try {
      const p   = new URL(url).searchParams;
      const v   = p.get('v');
      const lang = p.get('lang') || p.get('tlang') || 'und';
      const fmt  = p.get('fmt') || 'xml';
      if (!v) return;
      const key = v + ':' + lang;
      // url 一併存入，供 inject.js 取用完整 pot/signature 驗證參數
      window.__YT_SUB_TIMEDTEXT_CACHE__[key] = { text, fmt, url };
      window.dispatchEvent(new CustomEvent('__yt_sub_timedtext__', { detail: { key } }));
    } catch (e) {}
  }

  // ── Patch fetch ─────────────────────────────────────────────
  const _origFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : (input?.url || '');
    const response = await _origFetch.call(this, input, init);
    if (url.includes('/api/timedtext'))
      response.clone().text().then(t => onTimedtext(url, t)).catch(() => {});
    if (url.includes('/youtubei/v1/player'))
      response.clone().json().then(j => onPlayerData(j)).catch(() => {});
    // SHIFT+N / SPA 導航時 YouTube 呼叫 /get_watch 或 /next，response 內嵌 playerResponse
    if (url.includes('/youtubei/v1/get_watch') || url.includes('/youtubei/v1/next'))
      response.clone().json().then(j => {
        // YouTube 有時回傳陣列，有時回傳物件
        const candidates = Array.isArray(j) ? j : [j];
        for (const item of candidates) {
          if (!item || typeof item !== 'object') continue;
          const embedded = item?.playerResponse
            || item?.currentVideoEndpoint?.watchEndpoint?.playerResponse
            || item?.currentVideoEndpoint?.playerResponse;
          if (embedded) { console.log('[YT-SUB] get_watch: 找到 playerResponse'); onPlayerData(embedded); return; }
        }
      }).catch(() => {});
    return response;
  };

  // ── Patch XHR ───────────────────────────────────────────────
  const OrigXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OrigXHR();
    let _url = '';
    const origOpen = xhr.open.bind(xhr);
    xhr.open = function (method, url, ...args) { _url = url; return origOpen(method, url, ...args); };
    xhr.addEventListener('load', function () {
      if (_url.includes('/api/timedtext') && xhr.responseText)
        onTimedtext(_url, xhr.responseText);
      if (_url.includes('/youtubei/v1/player') && xhr.responseText)
        try { onPlayerData(JSON.parse(xhr.responseText)); } catch (e) {}
      if ((_url.includes('/youtubei/v1/get_watch') || _url.includes('/youtubei/v1/next')) && xhr.responseText)
        try {
          const j = JSON.parse(xhr.responseText);
          const candidates = Array.isArray(j) ? j : [j];
          for (const item of candidates) {
            if (!item || typeof item !== 'object') continue;
            const embedded = item?.playerResponse
              || item?.currentVideoEndpoint?.watchEndpoint?.playerResponse
              || item?.currentVideoEndpoint?.playerResponse;
            if (embedded) { onPlayerData(embedded); break; }
          }
        } catch (e) {}
    });
    return xhr;
  }
  PatchedXHR.prototype = OrigXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;
})();
