// background.js — Service Worker
// 處理 Firebase 認證 + Firestore 單字同步

import {
  signInWithGoogle, signOut, restoreSession, getCurrentUser, getIdToken,
  setDoc, getDoc, updateDoc, getCollection, getCollectionPublic, deleteDoc,
  __qaSetAuth,
} from './firebase.js';

// 啟動時嘗試恢復登入狀態（Promise 存起來供 handler 等待，解決 SW 重啟 race condition）
let _sessionReady = restoreSession().then(user => {
  if (user) console.log('[YT-SUB] Firebase session 恢復：', user.email);
}).catch(() => {});

// 管理員 email 從 Firestore app_config/admin_config 讀取並快取
let _adminEmailsCache = null;
async function getAdminEmails() {
  if (_adminEmailsCache) return _adminEmailsCache;
  try {
    const doc = await getDoc('app_config/admin_config');
    _adminEmailsCache = doc?.admin_emails || [];
  } catch (_) {
    _adminEmailsCache = [];
  }
  return _adminEmailsCache;
}

// ===== 編輯器：TabId 追蹤 =====
// 記錄最後一個 active 的 YouTube 分頁
let lastYtTabId = null;

// 當分頁切換時，若是 YouTube 分頁則記錄 tabId
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.url?.includes('youtube.com')) lastYtTabId = tabId;
});

// 分頁更新時，若是 YouTube 分頁則記錄 tabId
chrome.tabs.onUpdated.addListener((tabId, _, tab) => {
  if (tab.url?.includes('youtube.com')) lastYtTabId = tabId;
});

// ===== 編輯器：字幕資料暫存 =====
// 以 tabId 為 key 儲存各分頁的字幕資料
const subtitleStore = {}; // { [tabId]: { videoId, videoTitle, primarySubtitles, secondarySubtitles } }

// ===== 訊息處理 =====
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    // 取得目前使用者
    case 'fb_getUser':
      sendResponse({ user: getCurrentUser() });
      return false;

    // Google 登入
    case 'fb_signIn':
      signInWithGoogle()
        .then(user => sendResponse({ ok: true, user }))
        .catch(e  => sendResponse({ ok: false, error: e.message }));
      return true; // async

    // 登出
    case 'fb_signOut':
      signOut()
        .then(() => sendResponse({ ok: true }))
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    // 儲存單字到雲端（以 word 為 doc ID，同字覆寫）
    case 'fb_saveWord': {
      _sessionReady.then(() => {
        const user = getCurrentUser();
        if (!user) { sendResponse({ ok: false, error: '未登入' }); return; }
        setDoc(`users/${user.uid}/words/${encodeURIComponent(msg.word.word)}`, msg.word)
          .then(() => sendResponse({ ok: true }))
          .catch(e => sendResponse({ ok: false, error: e.message }));
      });
      return true;
    }

    // 從雲端讀取全部單字
    case 'fb_getWords': {
      _sessionReady.then(() => {
        const user = getCurrentUser();
        if (!user) { sendResponse({ ok: false, words: [] }); return; }
        getCollection(`users/${user.uid}/words`, {
          orderBy: { field: 'addedAt', dir: 'DESCENDING' },
        })
          .then(words => sendResponse({ ok: true, words }))
          .catch(e    => sendResponse({ ok: false, error: e.message, words: [] }));
      });
      return true;
    }

    // 把本地單字全部同步上雲端
    case 'fb_syncLocal': {
      _sessionReady.then(() => {
        const user = getCurrentUser();
        if (!user) { sendResponse({ ok: false, error: '未登入' }); return; }
        const words = msg.words || [];
        Promise.all(words.map(w => setDoc(`users/${user.uid}/words/${encodeURIComponent(w.word)}`, w)))
          .then(() => sendResponse({ ok: true, count: words.length }))
          .catch(e  => sendResponse({ ok: false, error: e.message }));
      });
      return true;
    }

    // 刪除雲端單字
    case 'fb_deleteWord': {
      _sessionReady.then(() => {
        const user = getCurrentUser();
        if (!user) { sendResponse({ ok: false }); return; }
        deleteDoc(`users/${user.uid}/words/${encodeURIComponent(msg.word)}`)
          .then(() => sendResponse({ ok: true }))
          .catch(e  => sendResponse({ ok: false, error: e.message }));
      });
      return true;
    }

    // 雙向同步：以 addedAt 較新者為準，軟刪除以 deletedAt 為準
    case 'fb_biSync': {
      _sessionReady.then(() => {
        const user = getCurrentUser();
        if (!user) { sendResponse({ ok: false, error: '未登入' }); return; }

        const localWords = msg.localWords || {};

        getCollection(`users/${user.uid}/words`, {})
          .then(async cloudArr => {
            const cloudWords = {};
            for (const w of cloudArr) { if (w.word) cloudWords[w.word] = w; }

            const allKeys = new Set([...Object.keys(localWords), ...Object.keys(cloudWords)]);
            const merged   = {};
            const toUpload = [];

            for (const key of allKeys) {
              const L = localWords[key] || null;
              const C = cloudWords[key] || null;
              if (L && C) {
                const lTime = L.deletedAt || L.addedAt || 0;
                const cTime = C.deletedAt || C.addedAt || 0;
                const winner = lTime >= cTime ? L : C;
                merged[key] = winner;
                if (lTime >= cTime) toUpload.push(winner);
              } else if (L) {
                merged[key] = L;
                toUpload.push(L);
              } else {
                merged[key] = C;
              }
            }

            await Promise.all(toUpload.map(w =>
              setDoc(`users/${user.uid}/words/${encodeURIComponent(w.word)}`, w)
            ));

            sendResponse({ ok: true, merged });
          })
          .catch(e => sendResponse({ ok: false, error: e.message }));
      });
      return true;
    }

    // ===== 編輯器 case =====

    // 接收 content.js 傳送的字幕資料，以 tabId 為 key 暫存
    case 'editor_setSubtitles': {
      const tabId = sender.tab?.id;
      if (tabId) {
        lastYtTabId = tabId;
        subtitleStore[tabId] = {
          ytTabId: tabId,
          videoId: msg.videoId,
          videoTitle: msg.videoTitle,
          primarySubtitles: msg.primarySubtitles,
          secondarySubtitles: msg.secondarySubtitles,
        };
      }
      sendResponse({ ok: true });
      return false;
    }

    // 開啟編輯器分頁
    case 'editor_open': {
      const tabId = sender.tab?.id || lastYtTabId;
      const url = chrome.runtime.getURL(`editor.html?tabId=${tabId}`);
      chrome.tabs.create({ url });
      sendResponse({ ok: true });
      return false;
    }

    // QA 後門：直接設定假登入狀態（本地測試用，不進 git）
    // storage 由測試端寫好，這裡只更新 in-memory 狀態，同步回應
    case '__qa_bypass_auth': {
      const mockUser = msg.user || { uid: 'qa-uid', email: 'qa@test.com', displayName: 'QA Bot', photoUrl: '' };
      __qaSetAuth(mockUser);
      sendResponse({ ok: true, user: mockUser });
      return false; // 同步完成，不等 callback
    }

    // 開啟單字庫儀表板
    case 'dashboard_open': {
      chrome.tabs.create({ url: chrome.runtime.getURL('vocab-dashboard.html') });
      sendResponse({ ok: true });
      return false;
    }

    // 取得目前 ID Token（Dashboard 讀 Firestore 用）
    case 'fb_getIdToken': {
      sendResponse({ ok: true, token: getIdToken() });
      return false;
    }

    // 編輯器分頁取得字幕資料
    case 'editor_getSubtitles': {
      const data = subtitleStore[msg.ytTabId] || null;
      sendResponse({ ok: !!data, data });
      return false;
    }

    // 編輯器發送指令轉發給 YT 分頁
    case 'editor_relay': {
      const targetTabId = msg.ytTabId || lastYtTabId;
      if (targetTabId) {
        chrome.tabs.sendMessage(targetTabId, msg.payload).catch(() => {});
      }
      sendResponse({ ok: true });
      return false;
    }

    // 分享字幕至社群（寫入 Firestore customSubtitles collection）
    case 'fb_shareSubtitle': {
      _sessionReady.then(() => {
        const user = getCurrentUser();
        if (!user) { sendResponse({ ok: false, error: '未登入' }); return; }
        const { videoId, authorName, subtitleName, primarySubtitles: ps, secondarySubtitles: ss } = msg;
        const docId = `${user.uid}_${Date.now()}`;
        const now = Date.now();
        Promise.all([
          // 寫入字幕內容
          setDoc(`customSubtitles/${videoId}/entries/${docId}`, {
            authorName, subtitleName,
            uploadedAt: now,
            uploaderUid: user.uid,
            primarySubtitles: ps,
            secondarySubtitles: ss,
          }),
          // 建立/更新頂層 videoId doc（讓社群頁能 list 到此影片）
          updateDoc(`customSubtitles/${videoId}`, { lastUploadedAt: now })
            .catch(() => setDoc(`customSubtitles/${videoId}`, { lastUploadedAt: now })),
        ])
          .then(() => sendResponse({ ok: true, docId }))
          .catch(e  => sendResponse({ ok: false, error: e.message }));
      });
      return true;
    }

    // 讀取指定影片的社群字幕清單（最多20筆，依上傳時間降序，不需登入）
    case 'fb_getCommunitySubtitles': {
      const { videoId } = msg;
      if (!videoId) { sendResponse({ ok: false, entries: [] }); return false; }
      getCollectionPublic(`customSubtitles/${videoId}/entries`, {
        orderBy: { field: 'uploadedAt', dir: 'DESCENDING' },
        limit: 20,
      })
        .then(entries => sendResponse({ ok: true, entries }))
        .catch(e      => sendResponse({ ok: false, error: e.message, entries: [] }));
      return true;
    }

    // 登入後自動建立編輯器權限申請 doc（若已存在則不覆寫）
    case 'fb_registerEditorPermission': {
      _sessionReady.then(() => {
        const user = getCurrentUser();
        if (!user) { sendResponse({ ok: false, error: '未登入' }); return; }
        const docPath = `editor_permissions/${user.uid}`;
        getDoc(docPath)
          .then(existing => {
            if (existing) { sendResponse({ ok: true, existed: true, data: existing }); return; }
            return setDoc(docPath, {
              uid: user.uid,
              email: user.email,
              displayName: user.displayName || '',
              enabled: false,
              requestedAt: new Date().toISOString(),
            }).then(() => sendResponse({ ok: true, existed: false }));
          })
          .catch(e => sendResponse({ ok: false, error: e.message }));
      });
      return true;
    }

    // 查詢目前使用者是否有編輯器權限
    case 'fb_checkEditorPermission': {
      _sessionReady.then(async () => {
        const user = getCurrentUser();
        if (!user) { sendResponse({ ok: true, enabled: false, reason: 'not_logged_in' }); return; }
        // 管理員帳號從 Firestore app_config/admin_config 讀取，永遠有編輯權限
        const adminEmails = await getAdminEmails();
        if (adminEmails.includes(user.email)) {
          sendResponse({ ok: true, enabled: true });
          return;
        }
        getDoc(`editor_permissions/${user.uid}`)
          .then(doc => sendResponse({ ok: true, enabled: doc?.enabled === true }))
          .catch(()  => sendResponse({ ok: true, enabled: false }));
      });
      return true;
    }

    // 管理員：取得所有申請列表
    case 'fb_getEditorPermissions': {
      _sessionReady.then(() => {
        const user = getCurrentUser();
        if (!user) { sendResponse({ ok: false, entries: [] }); return; }
        getCollection('editor_permissions', { orderBy: { field: 'requestedAt', dir: 'DESCENDING' } })
          .then(entries => sendResponse({ ok: true, entries }))
          .catch(e      => sendResponse({ ok: false, error: e.message, entries: [] }));
      });
      return true;
    }

    // 管理員：更新某使用者的 enabled 狀態
    case 'fb_setEditorPermission': {
      _sessionReady.then(() => {
        const user = getCurrentUser();
        if (!user) { sendResponse({ ok: false, error: '未登入' }); return; }
        updateDoc(`editor_permissions/${msg.uid}`, { enabled: msg.enabled })
          .then(() => sendResponse({ ok: true }))
          .catch(e  => sendResponse({ ok: false, error: e.message }));
      });
      return true;
    }

    default:
      return false;
  }
});
