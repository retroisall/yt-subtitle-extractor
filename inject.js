// inject.js — 運行在 YouTube 頁面的 main world
// 目的：提取字幕資料並傳回給 content script

(function () {
  'use strict';

  // ===== 防止多次注入 =====
  if (window.__YT_SUB_DEMO_INJECTED__) return;
  window.__YT_SUB_DEMO_INJECTED__ = true;
  console.log('[YT-SUB] inject.js 已載入 v10');

  // ===== 快取（優先讀 patch.js 在 document_start 就已攔截的全域資料）=====
  // patch.js 在 YouTube 任何程式碼之前就接管了 fetch/XHR，這裡只讀它留下的結果
  const subtitleCache = {};  // videoId:lang → { text, fmt }（本地 mirror）
  let allTracks = [];

  // 用 patch.js 儲存的真正原始 fetch 做 Path 3 的直接請求，不觸發雙重攔截
  const originalFetch = window.__YT_SUB_ORIG_FETCH__ || window.fetch;

  let cachedRenderer = null;
  let cachedVideoId  = null;
  let _extractDebounce = null;

  // 從 patch.js 全域快取同步 timedtext 資料到本地 subtitleCache
  function syncTimedtextCache() {
    const g = window.__YT_SUB_TIMEDTEXT_CACHE__ || {};
    Object.assign(subtitleCache, g);
  }

  // 從 patch.js 全域快取讀取最新 player renderer
  function syncPlayerCache() {
    const g = window.__YT_SUB_PLAYER_CACHE__ || {};
    const videoId = getCurrentVideoId();
    if (!videoId) return;
    const entry = g[videoId];
    if (entry?.renderer?.captionTracks?.length > 0) {
      cachedRenderer = entry.renderer;
      cachedVideoId  = videoId;
      allTracks      = entry.renderer.captionTracks;
      console.log('[YT-SUB] 讀取 patch.js 快取：videoId=' + videoId + ' tracks=' + allTracks.length);
    }
  }

  // 監聽 patch.js 的事件（SPA 導航時 player API 被呼叫後觸發）
  window.addEventListener('__yt_sub_player__', function (e) {
    const videoId = e.detail?.videoId;
    if (!videoId) return;
    const entry = window.__YT_SUB_PLAYER_CACHE__?.[videoId];
    if (!entry) return;
    cachedRenderer = entry.renderer;
    cachedVideoId  = videoId;
    allTracks      = entry.renderer.captionTracks;
    console.log('[YT-SUB] patch.js 事件：取得 videoId=' + videoId + ' tracks=' + allTracks.length);
    if (videoId === getCurrentVideoId()) {
      clearTimeout(_extractDebounce);
      _extractDebounce = setTimeout(() => extractAndSend(), 150);
    }
  });

  window.addEventListener('__yt_sub_timedtext__', function (e) {
    const key = e.detail?.key;
    if (key && window.__YT_SUB_TIMEDTEXT_CACHE__?.[key]) {
      subtitleCache[key] = window.__YT_SUB_TIMEDTEXT_CACHE__[key];
    }
  });

  // ===== 取得當前影片 ID =====
  function getCurrentVideoId() {
    return new URLSearchParams(location.search).get('v');
  }

  // ===== 驗證 renderer 是否屬於當前影片 =====
  function isForCurrentVideo(renderer) {
    const videoId = getCurrentVideoId();
    if (!videoId) return false;

    // 優先：用 videoDetails.videoId 驗證（比 baseUrl 更可靠，合輯/播放清單也適用）
    const globalVideoId =
      window.ytInitialPlayerResponse?.videoDetails?.videoId ||
      window.ytplayer?.config?.args?.raw_player_response?.videoDetails?.videoId;
    if (globalVideoId === videoId && renderer?.captionTracks?.length > 0) return true;

    // 備用：檢查 captionTrack baseUrl（原本的方式）
    if (!renderer?.captionTracks?.length) return false;
    return renderer.captionTracks[0].baseUrl?.includes('v=' + videoId);
  }

  // ===== 從攔截快取讀取（最可靠，baseUrl 最新）=====
  function getFromCached() {
    syncPlayerCache(); // 先同步 patch.js 的最新資料
    if (cachedRenderer?.captionTracks?.length > 0 && cachedVideoId === getCurrentVideoId()) {
      return cachedRenderer;
    }
    return null;
  }

  // ===== 從全域變數讀取 =====
  function getFromGlobal() {
    try {
      const renderer = window.ytInitialPlayerResponse?.captions?.playerCaptionsTracklistRenderer;
      if (renderer?.captionTracks?.length > 0) return renderer;
    } catch (e) {}
    return null;
  }

  // ===== 直接從播放器元素讀取（SPA 導航後最可靠，SHIFT+N 也適用）=====
  function getFromPlayerElement() {
    try {
      const player = document.querySelector('#movie_player');
      if (typeof player?.getPlayerResponse !== 'function') return null;
      const data = player.getPlayerResponse();
      const vid = data?.videoDetails?.videoId;
      if (vid !== getCurrentVideoId()) return null;
      const renderer = data?.captions?.playerCaptionsTracklistRenderer;
      if (renderer?.captionTracks?.length > 0) {
        console.log('[YT-SUB] ✅ getPlayerResponse() 命中，tracks=' + renderer.captionTracks.length);
        // 同步回全域快取
        if (window.__YT_SUB_PLAYER_CACHE__) {
          window.__YT_SUB_PLAYER_CACHE__[vid] = { renderer, ts: Date.now() };
        }
        return renderer;
      }
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
      // 確保字幕模組已載入（CC 關閉時 setOption 可能無效）
      if (typeof player.loadModule === 'function') {
        try { player.loadModule('captions'); } catch (e) {}
      }
      if (typeof player.setOption !== 'function') return false;
      player.setOption('captions', 'track', { languageCode });
      console.log('[YT-SUB] 觸發 YouTube 播放器載入字幕:', languageCode);
      return true;
    } catch (e) {}
    return false;
  }

  // ===== 透過 Innertube API 取得播放器資料（最後備用）=====
  async function getFromInnertube(videoId) {
    try {
      // 用 ytcfg 取得 YouTube 自己的正確版本號，避免用過期的硬編碼值
      const ytcfg = window.ytcfg?.data_ || {};
      const clientVersion = ytcfg.INNERTUBE_CLIENT_VERSION || '2.20240101.00.00';
      const apiKey        = ytcfg.INNERTUBE_API_KEY || '';
      const hl            = ytcfg.HL || navigator.language || 'en';
      const visitorData   = ytcfg.VISITOR_DATA || '';

      const apiUrl = apiKey
        ? `https://www.youtube.com/youtubei/v1/player?key=${apiKey}`
        : 'https://www.youtube.com/youtubei/v1/player';

      const resp = await originalFetch(apiUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-YouTube-Client-Name': '1',
          'X-YouTube-Client-Version': clientVersion,
        },
        credentials: 'include',
        body: JSON.stringify({
          videoId,
          context: {
            client: { clientName: 'WEB', clientVersion, hl, visitorData },
          }
        })
      });
      const data = await resp.json();
      const renderer = data?.captions?.playerCaptionsTracklistRenderer;
      const trackCount = renderer?.captionTracks?.length || 0;
      console.log('[YT-SUB] Innertube 回應: status=' + resp.status
        + ' videoId=' + (data?.videoDetails?.videoId || '?')
        + ' tracks=' + trackCount
        + ' playability=' + (data?.playabilityStatus?.status || '?')
        + (trackCount === 0 && data?.playabilityStatus?.reason
            ? ' reason=' + data.playabilityStatus.reason : ''));
      if (renderer?.captionTracks?.length > 0) {
        console.log('[YT-SUB] Innertube API 成功，找到', renderer.captionTracks.length, '個字幕');
        // 更新 patch.js 全域快取
        if (window.__YT_SUB_PLAYER_CACHE__) {
          window.__YT_SUB_PLAYER_CACHE__[videoId] = { renderer, ts: Date.now() };
        }
        cachedRenderer = renderer;
        cachedVideoId  = videoId;
        allTracks      = renderer.captionTracks;
        return renderer;
      }
    } catch (e) {
      console.log('[YT-SUB] Innertube API 失敗:', e.message);
    }
    return null;
  }

  // ===== 傳送字幕清單 =====
  async function extractAndSend() {
    const videoId = getCurrentVideoId();
    if (!videoId) return;

    // ① 優先讀 patch.js 全域快取（ytInitialPlayerResponse setter + fetch 攔截都寫到這）
    syncPlayerCache();
    let renderer = (cachedVideoId === videoId && cachedRenderer?.captionTracks?.length)
      ? cachedRenderer : null;
    if (renderer) console.log('[YT-SUB] ✅ 快取命中 videoId=' + videoId);

    // ② 備用：播放器元素 + 其他全域變數
    if (!renderer) {
      const playerElem = getFromPlayerElement();
      if (playerElem) {
        console.log('[YT-SUB] ✅ PlayerElement 命中');
        renderer = playerElem;
      }
    }
    if (!renderer) {
      for (const [name, r] of [
        ['Global',   getFromGlobal()],
        ['Ytplayer', getFromYtplayer()],
        ['HTML',     getFromHTML()],
      ]) {
        if (r && isForCurrentVideo(r)) {
          console.log('[YT-SUB] ✅ ' + name + ' 命中');
          renderer = r; break;
        }
      }
    }

    // ③ 最後備用：Innertube API
    if (!renderer) {
      console.log('[YT-SUB] 嘗試 Innertube API...');
      renderer = await getFromInnertube(videoId);
    }

    if (!renderer?.captionTracks) {
      console.log('[YT-SUB] 此影片沒有可用字幕');
      window.postMessage({ type: 'YT_SUBTITLE_DEMO_CAPTIONS', data: null, error: '此影片沒有可用字幕' }, '*');
      return;
    }

    allTracks = renderer.captionTracks;
    console.log('[YT-SUB] 找到', allTracks.length, '個字幕，傳送中...');
    const tracks = allTracks.map(t => ({
      languageCode: t.languageCode,
      name: t.name?.simpleText || t.languageCode,
      baseUrl: t.baseUrl,
      vssId: t.vssId || '',
      kind: t.kind || 'manual',
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
  async function fetchSubtitle(baseUrl, languageCode, tag) {
    const videoId = getCurrentVideoId();
    const cacheKey = videoId + ':' + languageCode;

    // 主字幕：立即切換 YouTube 播放器字幕語言（不受快取影響）
    if (tag === 'primary') {
      triggerYouTubeCaption(languageCode);
    }

    // ── 路徑一：快取（YouTube 播放器已自動 fetch 過）──────────────
    syncTimedtextCache(); // 先把 patch.js 攔截到的資料合併進來
    if (subtitleCache[cacheKey]) {
      console.log('[YT-SUB] 使用快取 key=' + cacheKey);
      try {
        const { text, fmt } = subtitleCache[cacheKey];
        const json = parseSubtitleText(text, fmt);
        window.postMessage({ type: 'YT_SUBTITLE_DEMO_SUBTITLE_DATA', data: json, error: null, tag }, '*');
        return;
      } catch (e) {}
    }

    // ── 路徑二：請 YouTube 播放器自己去 fetch，我們偷聽 ──────────
    // 先用 ASR 暖機：CC 關閉時 setOption 無效，需先激活字幕系統
    const asrForWarmup = allTracks.find(t => (t.vssId || '').startsWith('a.') && t.languageCode !== languageCode);
    if (asrForWarmup) {
      triggerYouTubeCaption(asrForWarmup.languageCode);
      await new Promise(r => setTimeout(r, 300));
    }
    const triggered = triggerYouTubeCaption(languageCode);
    if (triggered) {
      console.log('[YT-SUB] 觸發播放器載入字幕，等待攔截...');
      for (let i = 0; i < 8; i++) {
        await new Promise(r => setTimeout(r, 500));
        if (subtitleCache[cacheKey]) {
          console.log('[YT-SUB] 播放器路徑成功！key=' + cacheKey);
          try {
            const { text, fmt } = subtitleCache[cacheKey];
            const json = parseSubtitleText(text, fmt);
            window.postMessage({ type: 'YT_SUBTITLE_DEMO_SUBTITLE_DATA', data: json, error: null, tag }, '*');
            return;
          } catch (e) {}
        }
      }
      console.log('[YT-SUB] 播放器 4 秒內無回應，改用直接 fetch');
    }

    // ── 路徑三：直接 fetch（帶 SAPISIDHASH）───────────────────────
    const findTrack = prefix => allTracks.find(t => (t.vssId || '').startsWith(prefix));

    let url;
    const manualTarget = findTrack('.' + languageCode);
    const asrTarget    = findTrack('a.' + languageCode);
    const anyManual    = findTrack('.');
    const anyAsr       = allTracks.find(t => (t.vssId || '').startsWith('a.'));

    if (manualTarget) {
      url = manualTarget.baseUrl + '&fmt=json3';
      console.log('[YT-SUB] 使用手動字幕 vssId=' + manualTarget.vssId);
    } else if (asrTarget) {
      url = asrTarget.baseUrl + '&fmt=json3';
      console.log('[YT-SUB] 使用 ASR 字幕 vssId=' + asrTarget.vssId);
    } else {
      const fallback = anyManual || anyAsr || allTracks[0];
      if (!fallback) {
        window.postMessage({ type: 'YT_SUBTITLE_DEMO_SUBTITLE_DATA', error: '找不到可用字幕來源', tag }, '*');
        return;
      }
      url = fallback.baseUrl + '&fmt=json3&tlang=' + languageCode;
      console.log('[YT-SUB] 使用 &tlang= 即時翻譯 vssId=' + fallback.vssId + ' → ' + languageCode);
    }

    console.log('[YT-SUB] 直接 fetch URL:', url.slice(0, 120));
    try {
      const headers = await buildSapiAuthHeader();
      console.log('[YT-SUB] auth header:', headers['Authorization'] ? '✅ 有' : '❌ 無');

      const response = await originalFetch(url, { headers, credentials: 'include' });
      const text = await response.text();
      console.log('[YT-SUB] 結果: status=' + response.status + ' len=' + text.length);
      if (!text || text.length < 10) {
        window.postMessage({ type: 'YT_SUBTITLE_DEMO_SUBTITLE_DATA', error: '字幕回應為空（auth header 缺失或此影片受 YouTube 限制）', tag }, '*');
        return;
      }
      const json = parseSubtitleText(text, 'json3');
      window.postMessage({ type: 'YT_SUBTITLE_DEMO_SUBTITLE_DATA', data: json, error: null, tag }, '*');
    } catch (e) {
      window.postMessage({ type: 'YT_SUBTITLE_DEMO_SUBTITLE_DATA', error: e.message, tag }, '*');
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

  // ===== 等待並提取字幕（事件驅動，不再輪詢）=====
  let _waitTimer = null;
  let _playerListener = null;

  function pollAndExtract() {
    // 清除上一次的等待
    if (_waitTimer) { clearTimeout(_waitTimer); _waitTimer = null; }
    if (_playerListener) { window.removeEventListener('__yt_sub_player__', _playerListener); _playerListener = null; }

    // 清除字幕快取（換影片 / 手動刷新）
    Object.keys(subtitleCache).forEach(k => delete subtitleCache[k]);
    syncTimedtextCache(); // 把 patch.js 已攔截到的合入

    const videoId = getCurrentVideoId();

    // 同步嘗試（快取通常已有資料）
    syncPlayerCache();
    const hasData = (cachedVideoId === videoId && cachedRenderer?.captionTracks?.length > 0)
      || (getFromGlobal() && isForCurrentVideo(getFromGlobal()))
      || (getFromYtplayer() && isForCurrentVideo(getFromYtplayer()))
      || getFromPlayerElement() !== null;

    if (hasData) {
      extractAndSend();
      return;
    }

    // 資料還沒好 → 等 patch.js 的事件（YouTube 更新 ytInitialPlayerResponse 時觸發）
    console.log('[YT-SUB] 等待 player 資料...');

    _playerListener = function (e) {
      if (e.detail?.videoId !== getCurrentVideoId()) return;
      cleanup();
      extractAndSend();
    };

    const cleanup = () => {
      if (_playerListener) { window.removeEventListener('__yt_sub_player__', _playerListener); _playerListener = null; }
      if (_waitTimer)      { clearTimeout(_waitTimer); _waitTimer = null; }
    };

    window.addEventListener('__yt_sub_player__', _playerListener);

    // 3 秒後放棄等待，改用 Innertube API fallback
    // （SHIFT+N 走 /get_watch 而非 /player，不會觸發 __yt_sub_player__ 事件）
    _waitTimer = setTimeout(() => {
      cleanup();
      extractAndSend();
    }, 3000);
  }

  // ===== 監聽 content script 的請求 =====
  window.addEventListener('message', function (event) {
    if (event.data?.type === 'YT_SUBTITLE_DEMO_REQUEST') pollAndExtract();
    if (event.data?.type === 'YT_SUBTITLE_DEMO_FETCH') {
      fetchSubtitle(event.data.baseUrl, event.data.languageCode, event.data.tag);
    }
  });

  // ===== YouTube SPA 導航 =====
  document.addEventListener('yt-navigate-finish', pollAndExtract);

  // ===== 首次載入 =====
  pollAndExtract();
})();
