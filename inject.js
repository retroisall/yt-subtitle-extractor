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

  // 檢查 baseUrl 是否過期（expire 參數 < 現在）
  function isBaseUrlExpired(baseUrl) {
    try {
      const expire = new URL(baseUrl).searchParams.get('expire');
      if (!expire) return false;
      return parseInt(expire, 10) < Math.floor(Date.now() / 1000);
    } catch (e) { return false; }
  }

  // 從 patch.js 全域快取讀取最新 player renderer
  function syncPlayerCache() {
    const g = window.__YT_SUB_PLAYER_CACHE__ || {};
    const videoId = getCurrentVideoId();
    if (!videoId) return;
    const entry = g[videoId];
    if (entry?.renderer?.captionTracks?.length > 0) {
      // 驗證 baseUrl 是否已過期
      const firstUrl = entry.renderer.captionTracks[0]?.baseUrl || '';
      if (isBaseUrlExpired(firstUrl)) {
        console.log('[YT-SUB] ⚠️ 快取 baseUrl 已過期，清除 videoId=' + videoId);
        delete g[videoId];
        if (cachedVideoId === videoId) { cachedRenderer = null; cachedVideoId = null; allTracks = []; }
        return;
      }
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
  let _captionsModuleLoaded = false;

  function triggerYouTubeCaption(languageCode) {
    try {
      const player = document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
      if (!player) return false;
      // loadModule 只呼叫一次（重複呼叫可能重置 CC 系統狀態）
      if (!_captionsModuleLoaded && typeof player.loadModule === 'function') {
        try { player.loadModule('captions'); } catch (e) {}
        _captionsModuleLoaded = true;
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

    // ── 路徑零：sessionStorage 持久快取 ──────────────────────────
    const scCached = scGet(videoId, languageCode);
    if (scCached) {
      // 驗證快取內容語言是否與請求一致（防止之前錯誤快取的中文被當作英文回傳）
      const cachedSample = sampleParsedText(scCached);
      if (!isCJKLanguage(languageCode) && looksLikeCJK(cachedSample)) {
        console.warn('[YT-SUB] sessionStorage 快取語言不符（請求=' + languageCode + '，內容為 CJK），清除並重新 fetch');
        try { sessionStorage.removeItem(scKey(videoId, languageCode)); } catch (e) {}
      } else {
        console.log('[YT-SUB] sessionStorage 命中 key=' + cacheKey);
        window.postMessage({ type: 'YT_SUBTITLE_DEMO_SUBTITLE_DATA', data: null, parsed: scCached, error: null, tag }, '*');
        return;
      }
    }

    // ── 路徑一：快取（YouTube 播放器已自動 fetch 過）──────────────
    syncTimedtextCache(); // 先把 patch.js 攔截到的資料合併進來
    if (subtitleCache[cacheKey]) {
      console.log('[YT-SUB] 使用快取 key=' + cacheKey);
      const { text, fmt } = subtitleCache[cacheKey];
      if (dispatchSubtitle(text, fmt, videoId, languageCode, tag)) return;
    }

    // ── 路徑二：請 YouTube 播放器自己去 fetch，我們偷聽 ──────────
    // 翻譯目標（不在原生 tracks）跳過此路徑，播放器不會主動 fetch 翻譯字幕
    const isNativeTrack = allTracks.some(t => t.languageCode === languageCode);
    if (isNativeTrack) {
      // 暖機：CC 關閉時 setOption 無效，需先用任意一條 track 激活字幕系統
      // 優先選不同語言的 ASR；找不到就用任意其他 track；實在只有一條就用自己
      const warmupTrack = allTracks.find(t => (t.vssId || '').startsWith('a.') && t.languageCode !== languageCode)
        || allTracks.find(t => t.languageCode !== languageCode)
        || allTracks[0];
      if (warmupTrack) {
        triggerYouTubeCaption(warmupTrack.languageCode);
        await new Promise(r => setTimeout(r, 300));
      }
      const triggered = triggerYouTubeCaption(languageCode);
      if (triggered) {
        console.log('[YT-SUB] 觸發播放器載入字幕，等待攔截...');
        for (let i = 0; i < 8; i++) {
          await new Promise(r => setTimeout(r, 500));
          if (subtitleCache[cacheKey]) {
            console.log('[YT-SUB] 播放器路徑成功！key=' + cacheKey);
            const { text, fmt } = subtitleCache[cacheKey];
            if (dispatchSubtitle(text, fmt, videoId, languageCode, tag)) return;
          }
        }
        console.log('[YT-SUB] 播放器 4 秒內無回應，改用直接 fetch');
      }
    }

    // ── 路徑三：直接 fetch（帶 SAPISIDHASH）───────────────────────
    // baseUrl 過期 → 重新從 Innertube 拿最新 tracks
    if (allTracks.length > 0 && isBaseUrlExpired(allTracks[0]?.baseUrl || '')) {
      console.log('[YT-SUB] ⚠️ allTracks baseUrl 過期，重新 fetch Innertube...');
      const videoId2 = getCurrentVideoId();
      const freshRenderer = await getFromInnertube(videoId2);
      if (freshRenderer?.captionTracks?.length) {
        allTracks = freshRenderer.captionTracks;
        console.log('[YT-SUB] ✅ 取得新 baseUrl，tracks=' + allTracks.length);
      }
    }

    const findTrack = prefix => allTracks.find(t => (t.vssId || '').startsWith(prefix));

    let url;
    const manualTarget = findTrack('.' + languageCode);
    const asrTarget    = findTrack('a.' + languageCode);
    // &tlang= 翻譯：優先英文源（翻譯品質最佳），其次 ASR，最後任意 manual
    const enManual  = findTrack('.en');
    const enAsr     = findTrack('a.en');
    const anyAsr    = allTracks.find(t => (t.vssId || '').startsWith('a.'));
    const anyManual = findTrack('.');

    // 用 URL 物件設定參數，避免 baseUrl 本身已含 &fmt= 造成重複
    function buildUrl(baseUrl, tlang) {
      try {
        const u = new URL(baseUrl);
        u.searchParams.set('fmt', 'json3');
        if (tlang) u.searchParams.set('tlang', tlang);
        return u.toString();
      } catch (e) {
        return baseUrl.replace(/&fmt=[^&]*/g, '')
          + '&fmt=json3' + (tlang ? '&tlang=' + tlang : '');
      }
    }

    if (manualTarget) {
      url = buildUrl(manualTarget.baseUrl);
      console.log('[YT-SUB] 使用手動字幕 vssId=' + manualTarget.vssId);
    } else if (asrTarget) {
      url = buildUrl(asrTarget.baseUrl);
      console.log('[YT-SUB] 使用 ASR 字幕 vssId=' + asrTarget.vssId);
    } else {
      const fallback = enAsr || enManual || anyAsr || anyManual || allTracks[0];
      if (!fallback) {
        window.postMessage({ type: 'YT_SUBTITLE_DEMO_SUBTITLE_DATA', error: '找不到可用字幕來源', tag }, '*');
        return;
      }
      url = buildUrl(fallback.baseUrl, languageCode);
      console.log('[YT-SUB] 使用 &tlang= 即時翻譯 vssId=' + fallback.vssId + ' → ' + languageCode);
    }

    console.log('[YT-SUB] 直接 fetch URL:', url.slice(0, 120));
    try {
      // 先不帶 auth 試（大部分公開字幕不需要）
      let response = await originalFetch(url, { credentials: 'include' });
      let text = await response.text();
      console.log('[YT-SUB] 結果(no-auth): status=' + response.status + ' len=' + text.length);

      // 404 → 直接報錯，不重試（URL 本身無效）
      if (response.status === 404) {
        window.postMessage({ type: 'YT_SUBTITLE_DEMO_SUBTITLE_DATA', error: `字幕不存在 (404)，請重新整理頁面`, tag }, '*');
        return;
      }

      // len=0 或非 2xx → 補 auth 重試
      if (!text || text.length < 10 || !response.ok) {
        const headers = await buildSapiAuthHeader();
        console.log('[YT-SUB] 補 auth header:', headers['Authorization'] ? '✅ 有' : '❌ 無');
        response = await originalFetch(url, { headers, credentials: 'include' });
        text = await response.text();
        console.log('[YT-SUB] 結果(auth): status=' + response.status + ' len=' + text.length);
      }

      if (!text || text.length < 10) {
        window.postMessage({ type: 'YT_SUBTITLE_DEMO_SUBTITLE_DATA', error: `字幕回應為空 (status=${response.status})`, tag }, '*');
        return;
      }
      // 驗證 &tlang= 翻譯是否成功：若請求 Latin 語言但回傳 CJK，代表 YouTube 翻譯功能不支援此影片
      if (!isCJKLanguage(languageCode) && looksLikeCJK(text)) {
        console.warn('[YT-SUB] &tlang=' + languageCode + ' 翻譯失敗，YouTube 回傳原文（CJK），不快取');
        window.postMessage({ type: 'YT_SUBTITLE_DEMO_SUBTITLE_DATA', error: `此影片不支援翻譯為「${langName(languageCode)}」字幕（YouTube 翻譯功能不適用於此影片）`, tag }, '*');
        return;
      }
      dispatchSubtitle(text, 'json3', videoId, languageCode, tag);
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

    // 換影片時重置 loadModule flag
    _captionsModuleLoaded = false;

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

  // ===== sessionStorage 字幕快取 =====
  const SC_PREFIX = 'yt-sub-sc:';
  const SC_MAX_ENTRIES = 20; // 最多存 20 條，避免 sessionStorage 爆滿

  function scKey(videoId, languageCode) {
    return SC_PREFIX + videoId + ':' + languageCode;
  }

  function scGet(videoId, languageCode) {
    try {
      const raw = sessionStorage.getItem(scKey(videoId, languageCode));
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  }

  function scSet(videoId, languageCode, parsed) {
    try {
      // LRU：超過上限就刪最舊的
      const keys = Object.keys(sessionStorage).filter(k => k.startsWith(SC_PREFIX));
      if (keys.length >= SC_MAX_ENTRIES) {
        sessionStorage.removeItem(keys[0]);
      }
      sessionStorage.setItem(scKey(videoId, languageCode), JSON.stringify(parsed));
    } catch (e) {} // QuotaExceededError 靜默忽略
  }

  // ===== 解析 + 快取 + 送出（三條路徑共用）=====
  function dispatchSubtitle(text, fmt, videoId, languageCode, tag) {
    try {
      const json = parseSubtitleText(text, fmt);
      const parsed = parseJson3Compact(json);
      scSet(videoId, languageCode, parsed);
      window.postMessage({ type: 'YT_SUBTITLE_DEMO_SUBTITLE_DATA', data: null, parsed, error: null, tag }, '*');
      return true;
    } catch (e) { return false; }
  }

  // ===== 精簡解析（減少 postMessage 資料量）=====
  function parseJson3Compact(json) {
    if (!json?.events) return [];
    return json.events
      .filter(e => e.segs?.length > 0)
      .map(e => ({
        s: (e.tStartMs || 0) / 1000,
        d: (e.dDurationMs || 2000) / 1000,
        t: e.segs.map(s => s.utf8 || '').join('').trim(),
      }))
      .filter(e => e.t.length > 0);
  }

  // ===== 字幕語言驗證（防止 tlang 翻譯靜默失敗）=====

  // 判斷語言碼是否為 CJK 系（中/日/韓）
  function isCJKLanguage(code) {
    return /^(zh|ja|ko)/i.test(code || '');
  }

  // 判斷文字是否含大量 CJK 字元（比例 > 20%）；涵蓋中日韓及 CJK 相容漢字
  function looksLikeCJK(text) {
    if (!text || text.length < 10) return false;
    const cjk = (text.match(/[\u3000-\u9fff\uac00-\ud7af\u3040-\u30ff\uf900-\ufaff]/g) || []).length;
    return cjk / text.length > 0.2;
  }

  // 語言代碼轉用戶友善名稱
  const LANG_NAME = { en:'英文', fr:'法文', de:'德文', es:'西班牙文', pt:'葡萄牙文', it:'義大利文', nl:'荷蘭文', ru:'俄文', ar:'阿拉伯文', hi:'印地文' };
  function langName(code) { return LANG_NAME[code] || code; }

  // 從已解析的字幕陣列取樣文字
  function sampleParsedText(parsed) {
    return (parsed || []).slice(0, 8).map(e => e.t).join(' ');
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
