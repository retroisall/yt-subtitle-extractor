// inject.js — 運行在 YouTube 頁面的 main world
// 目的：提取字幕資料並傳回給 content script

(function () {
  'use strict';

  // ===== 防止多次注入 =====
  if (window.__YT_SUB_DEMO_INJECTED__) return;
  window.__YT_SUB_DEMO_INJECTED__ = true;
  console.log('[YT-SUB] inject.js 已載入 v10');

  // ===== 攔截 YouTube 播放器自己的 fetch（在任何其他程式碼之前）=====
  // YouTube 播放器可以成功拿到字幕，我們偷聽它的回應
  // subtitleCache[videoId:languageCode] = { text, fmt }
  const subtitleCache = {};
  let allTracks = []; // 保存所有 captionTracks 供 fetchSubtitle 使用

  function cacheTimedtext(url, text) {
    if (!text || text.length < 10) return;
    try {
      const params = new URL(url).searchParams;
      const videoId = params.get('v');
      const lang = params.get('lang') || params.get('tlang') || 'und';
      const fmt = params.get('fmt') || 'xml';
      const key = videoId + ':' + lang;
      subtitleCache[key] = { text, fmt };
      console.log('[YT-SUB] 攔截到字幕 key=' + key + ' fmt=' + fmt + ' len=' + text.length);
      window.postMessage({ type: 'YT_SUBTITLE_DEMO_CACHED', key }, '*');
    } catch (e) {}
  }

  // 攔截 fetch（現代瀏覽器）
  const originalFetch = window.fetch;
  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input?.url || '';
    const response = await originalFetch.call(this, input, init);
    if (url.includes('/api/timedtext')) {
      response.clone().text().then(text => cacheTimedtext(url, text)).catch(() => {});
    }
    return response;
  };

  // 攔截 XHR（YouTube 播放器可能使用）
  const OriginalXHR = window.XMLHttpRequest;
  function PatchedXHR() {
    const xhr = new OriginalXHR();
    let _url = '';
    const origOpen = xhr.open.bind(xhr);
    xhr.open = function (method, url, ...args) {
      _url = url;
      return origOpen(method, url, ...args);
    };
    xhr.addEventListener('load', function () {
      if (_url.includes('/api/timedtext') && xhr.responseText) {
        cacheTimedtext(_url, xhr.responseText);
      }
    });
    return xhr;
  }
  PatchedXHR.prototype = OriginalXHR.prototype;
  window.XMLHttpRequest = PatchedXHR;

  // ===== 取得當前影片 ID =====
  function getCurrentVideoId() {
    return new URLSearchParams(location.search).get('v');
  }

  // ===== 驗證 renderer 是否屬於當前影片 =====
  function isForCurrentVideo(renderer) {
    const videoId = getCurrentVideoId();
    if (!videoId || !renderer?.captionTracks?.length) return false;
    return renderer.captionTracks[0].baseUrl?.includes('v=' + videoId);
  }

  // ===== 從全域變數讀取 =====
  function getFromGlobal() {
    try {
      const renderer = window.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer;
      if (renderer?.captionTracks?.length > 0) return renderer;
    } catch (e) {}
    return null;
  }

  // ===== 從 ytplayer.config 讀取（SPA 導航後最可靠）=====
  function getFromYtplayer() {
    try {
      const renderer = window.ytplayer?.config?.args?.raw_player_response?.captions?.playerCaptionsTracklistRenderer;
      if (renderer?.captionTracks?.length > 0) return renderer;
    } catch (e) {}
    return null;
  }

  // ===== 從頁面 HTML 解析（首次載入備用）=====
  function getFromHTML() {
    try {
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const text = script.textContent;
        if (!text.includes('captionTracks')) continue;
        const match = text.match(/(?:var\s+|let\s+|const\s+|window\.)?ytInitialPlayerResponse\s*=\s*\{/);
        if (!match) continue;
        const startIdx = match.index + match[0].length - 1;
        let depth = 0, i = startIdx;
        for (; i < text.length; i++) {
          if (text[i] === '{') depth++;
          else if (text[i] === '}') { depth--; if (depth === 0) break; }
        }
        const parsed = JSON.parse(text.slice(startIdx, i + 1));
        const renderer = parsed?.captions?.playerCaptionsTracklistRenderer;
        if (renderer?.captionTracks?.length > 0) return renderer;
      }
    } catch (e) {}
    return null;
  }

  // ===== 透過 YouTube 播放器 API 觸發字幕載入 =====
  function triggerYouTubeCaption(languageCode) {
    try {
      const player = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
      if (!player) return false;
      // YouTube 播放器內部 API：設定字幕語言
      if (typeof player.setOption === 'function') {
        player.setOption('captions', 'track', { languageCode });
        console.log('[YT-SUB] 觸發 YouTube 播放器載入字幕:', languageCode);
        return true;
      }
    } catch (e) {}
    return false;
  }

  // ===== 傳送字幕清單 =====
  async function extractAndSend() {
    const videoId = getCurrentVideoId();
    console.log('[YT-SUB] extractAndSend 開始，videoId =', videoId);

    let renderer = null;
    const sources = [
      ['Global', getFromGlobal()],
      ['Ytplayer', getFromYtplayer()],
      ['HTML', getFromHTML()],
    ];
    for (const [name, r] of sources) {
      const valid = r && isForCurrentVideo(r);
      console.log(`[YT-SUB] ${name}: ${r ? (valid ? '✅ 符合' : '⚠️ video ID 不符') : '❌ 無資料'}`);
      if (valid) { renderer = r; break; }
    }

    if (!renderer?.captionTracks) {
      console.log('[YT-SUB] 此影片沒有可用字幕');
      window.postMessage({ type: 'YT_SUBTITLE_DEMO_CAPTIONS', data: null, error: '此影片沒有可用字幕' }, '*');
      return;
    }

    console.log('[YT-SUB] 找到', renderer.captionTracks.length, '個字幕，傳送中...');
    // 保存所有 tracks 供 fetchSubtitle 使用
    allTracks = renderer.captionTracks;

    const tracks = renderer.captionTracks.map(track => ({
      languageCode: track.languageCode,
      name: track.name?.simpleText || track.languageCode,
      baseUrl: track.baseUrl,
      vssId: track.vssId || '',
      kind: track.kind || 'manual'
    }));
    window.postMessage({ type: 'YT_SUBTITLE_DEMO_CAPTIONS', data: tracks, error: null }, '*');
  }

  // ===== 解析各種字幕格式 → 統一 json3 結構 =====
  function parseSubtitleText(text, fmt) {
    // json3 / srv3 格式（都是 JSON）
    if (fmt === 'json3' || fmt === 'srv3' || fmt === 'srv2' || fmt === 'srv1') {
      return JSON.parse(text);
    }
    // XML / ttml / 預設格式
    const parser = new DOMParser();
    const doc = parser.parseFromString(text, 'text/xml');
    const nodes = doc.querySelectorAll('text,p');
    const events = Array.from(nodes).map(n => {
      const start = parseFloat(n.getAttribute('start') || n.getAttribute('begin') || '0');
      const dur = parseFloat(n.getAttribute('dur') || n.getAttribute('duration') || '2');
      return {
        tStartMs: Math.round(start * 1000),
        dDurationMs: Math.round(dur * 1000),
        segs: [{ utf8: n.textContent }]
      };
    }).filter(e => e.segs[0].utf8.trim());
    return { events };
  }

  // ===== 取得字幕內容（vssId 邏輯 + &tlang= 即時翻譯）=====
  async function fetchSubtitle(baseUrl, languageCode) {
    const videoId = getCurrentVideoId();
    const cacheKey = videoId + ':' + languageCode;

    // 先查快取（YouTube 播放器攔截到的）
    if (subtitleCache[cacheKey]) {
      console.log('[YT-SUB] 使用快取 key=' + cacheKey);
      try {
        const { text, fmt } = subtitleCache[cacheKey];
        const json = parseSubtitleText(text, fmt);
        window.postMessage({ type: 'YT_SUBTITLE_DEMO_SUBTITLE_DATA', data: json, error: null }, '*');
        return;
      } catch (e) {}
    }

    // ===== vssId 邏輯：選出最佳 baseUrl + 決定是否加 &tlang= =====
    // vssId: "." 開頭 → 手動字幕；"a." 開頭 → 自動生成（ASR）
    const findTrack = prefix => allTracks.find(t => (t.vssId || '').startsWith(prefix));

    let url;
    const manualTarget = findTrack('.' + languageCode);  // 手動，目標語言
    const asrTarget    = findTrack('a.' + languageCode); // ASR，目標語言
    const anyManual    = findTrack('.');                  // 任意手動
    const anyAsr       = allTracks.find(t => (t.vssId || '').startsWith('a.')); // 任意 ASR

    if (manualTarget) {
      // 最好：有該語言的手動字幕，直接用
      url = manualTarget.baseUrl + '&fmt=json3';
      console.log('[YT-SUB] 使用手動字幕 vssId=' + manualTarget.vssId);
    } else if (asrTarget) {
      // 有該語言的 ASR，直接用（原始語言）
      url = asrTarget.baseUrl + '&fmt=json3';
      console.log('[YT-SUB] 使用 ASR 字幕 vssId=' + asrTarget.vssId);
    } else {
      // 沒有目標語言 → 找任何一個 baseUrl，加上 &tlang= 讓 YouTube 伺服器即時翻譯
      const fallback = anyManual || anyAsr || allTracks[0];
      if (!fallback) {
        window.postMessage({ type: 'YT_SUBTITLE_DEMO_SUBTITLE_DATA', error: '找不到可用字幕來源' }, '*');
        return;
      }
      url = fallback.baseUrl + '&fmt=json3&tlang=' + languageCode;
      console.log('[YT-SUB] 使用 &tlang= 即時翻譯 vssId=' + fallback.vssId + ' → ' + languageCode);
    }

    console.log('[YT-SUB] fetch URL:', url.slice(0, 120));
    try {
      // 生成 YouTube 的 Authorization: SAPISIDHASH 認證 header
      // YouTube 的 ASR/翻譯字幕 API 需要這個才會回傳資料
      const headers = await buildSapiAuthHeader();
      console.log('[YT-SUB] auth header:', headers['Authorization'] ? '✅ 有' : '❌ 無');

      const response = await originalFetch(url, { headers, credentials: 'include' });
      const text = await response.text();
      console.log('[YT-SUB] 結果: status=' + response.status + ' len=' + text.length);
      if (!text || text.length < 10) {
        window.postMessage({ type: 'YT_SUBTITLE_DEMO_SUBTITLE_DATA', error: '字幕回應為空（此影片可能受 YouTube 速率限制）' }, '*');
        return;
      }
      const json = parseSubtitleText(text, 'json3');
      window.postMessage({ type: 'YT_SUBTITLE_DEMO_SUBTITLE_DATA', data: json, error: null }, '*');
    } catch (e) {
      window.postMessage({ type: 'YT_SUBTITLE_DEMO_SUBTITLE_DATA', error: e.message }, '*');
    }
  }

  // ===== 生成 YouTube SAPISIDHASH Authorization header =====
  async function buildSapiAuthHeader() {
    try {
      // 優先找 __Secure-3PAPISID（HTTPS），fallback 到 SAPISID
      const cookies = document.cookie.split('; ');
      const sapisid = cookies.find(c => c.startsWith('__Secure-3PAPISID='))?.split('=')[1]
        || cookies.find(c => c.startsWith('SAPISID='))?.split('=')[1];

      if (!sapisid) {
        console.log('[YT-SUB] 找不到 SAPISID cookie，跳過 auth header');
        return {};
      }

      const origin = 'https://www.youtube.com';
      const ts = Math.floor(Date.now() / 1000);
      const msg = ts + ' ' + sapisid + ' ' + origin;
      const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(msg));
      const hex = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
      return { 'Authorization': 'SAPISIDHASH ' + ts + '_' + hex };
    } catch (e) {
      console.log('[YT-SUB] buildSapiAuthHeader 失敗:', e.message);
      return {};
    }
  }

  // ===== 輪詢等待當前影片資料就緒 =====
  function pollAndExtract() {
    // SPA 導航時清除快取
    Object.keys(subtitleCache).forEach(k => delete subtitleCache[k]);

    let retries = 0;
    const timer = setInterval(async () => {
      retries++;
      const r = getFromGlobal() || getFromYtplayer();
      const ready = r && isForCurrentVideo(r);
      if (ready || retries >= 10) {
        clearInterval(timer);
        await extractAndSend();
      }
    }, 500);
  }

  // ===== 監聽 content script 的請求 =====
  window.addEventListener('message', function (event) {
    if (event.data?.type === 'YT_SUBTITLE_DEMO_REQUEST') extractAndSend();
    if (event.data?.type === 'YT_SUBTITLE_DEMO_FETCH') {
      fetchSubtitle(event.data.baseUrl, event.data.languageCode);
    }
  });

  // ===== YouTube SPA 導航 =====
  document.addEventListener('yt-navigate-finish', pollAndExtract);

  // ===== 首次載入 =====
  pollAndExtract();
})();
