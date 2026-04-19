// background.js — Service Worker
// 處理 Firebase 認證 + Firestore 單字同步

import {
  signInWithGoogle, signOut, restoreSession, getCurrentUser, getIdToken,
  setDoc, getCollection, getCollectionPublic, deleteDoc,
} from './firebase.js';

// 啟動時嘗試恢復登入狀態
restoreSession().then(user => {
  if (user) console.log('[YT-SUB] Firebase session 恢復：', user.email);
}).catch(() => {});

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
      const user = getCurrentUser();
      if (!user) { sendResponse({ ok: false, error: '未登入' }); return false; }
      setDoc(`users/${user.uid}/words/${msg.word.word}`, msg.word)
        .then(() => sendResponse({ ok: true }))
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;
    }

    // 從雲端讀取全部單字
    case 'fb_getWords': {
      const user = getCurrentUser();
      if (!user) { sendResponse({ ok: false, words: [] }); return false; }
      getCollection(`users/${user.uid}/words`, {
        orderBy: { field: 'addedAt', dir: 'DESCENDING' },
      })
        .then(words => sendResponse({ ok: true, words }))
        .catch(e    => sendResponse({ ok: false, error: e.message, words: [] }));
      return true;
    }

    // 把本地單字全部同步上雲端
    case 'fb_syncLocal': {
      const user = getCurrentUser();
      if (!user) { sendResponse({ ok: false, error: '未登入' }); return false; }
      const words = msg.words || [];
      Promise.all(words.map(w => setDoc(`users/${user.uid}/words/${w.word}`, w)))
        .then(() => sendResponse({ ok: true, count: words.length }))
        .catch(e  => sendResponse({ ok: false, error: e.message }));
      return true;
    }

    // 刪除雲端單字
    case 'fb_deleteWord': {
      const user = getCurrentUser();
      if (!user) { sendResponse({ ok: false }); return false; }
      deleteDoc(`users/${user.uid}/words/${msg.word}`)
        .then(() => sendResponse({ ok: true }))
        .catch(e  => sendResponse({ ok: false, error: e.message }));
      return true;
    }

    // 雙向同步：以 addedAt 較新者為準，軟刪除以 deletedAt 為準
    case 'fb_biSync': {
      const user = getCurrentUser();
      if (!user) { sendResponse({ ok: false, error: '未登入' }); return false; }

      const localWords = msg.localWords || {};

      getCollection(`users/${user.uid}/words`, {})
        .then(async cloudArr => {
          // 把雲端陣列轉成 map
          const cloudWords = {};
          for (const w of cloudArr) { if (w.word) cloudWords[w.word] = w; }

          // 所有 key 的聯集
          const allKeys = new Set([...Object.keys(localWords), ...Object.keys(cloudWords)]);

          const merged       = {};   // 最終本地要存的
          const toUpload     = [];   // 要寫到 Firestore
          const toCloudDelete= [];   // 要從 Firestore 刪除

          for (const key of allKeys) {
            const L = localWords[key]  || null;
            const C = cloudWords[key]  || null;

            if (L && C) {
              // 雙方都有 → 比較時間戳（deletedAt 優先於 addedAt）
              const lTime = L.deletedAt || L.addedAt || 0;
              const cTime = C.deletedAt || C.addedAt || 0;
              const winner = lTime >= cTime ? L : C;
              merged[key] = winner;
              if (lTime >= cTime) {
                toUpload.push(winner);           // 本地較新，推上去
              }
              // 本地較舊：merged 已取 C，不需寫 Firestore（已是最新）
            } else if (L) {
              // 只有本地 → 上傳
              merged[key] = L;
              toUpload.push(L);
            } else {
              // 只有雲端 → 拉下來
              merged[key] = C;
            }
          }

          // 上傳需要更新的記錄
          await Promise.all(toUpload.map(w => {
            if (w.deletedAt) {
              // 軟刪除的記錄也上傳（讓其他裝置知道）
              return setDoc(`users/${user.uid}/words/${w.word}`, w);
            }
            return setDoc(`users/${user.uid}/words/${w.word}`, w);
          }));

          sendResponse({ ok: true, merged });
        })
        .catch(e => sendResponse({ ok: false, error: e.message }));
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
      const user = getCurrentUser();
      if (!user) { sendResponse({ ok: false, error: '未登入' }); return false; }
      const { videoId, authorName, subtitleName, primarySubtitles: ps, secondarySubtitles: ss } = msg;
      const docId = `${user.uid}_${Date.now()}`;
      setDoc(`customSubtitles/${videoId}/entries/${docId}`, {
        authorName,
        subtitleName,
        uploadedAt: Date.now(),
        uploaderUid: user.uid,
        primarySubtitles: ps,
        secondarySubtitles: ss,
      })
        .then(() => sendResponse({ ok: true, docId }))
        .catch(e  => sendResponse({ ok: false, error: e.message }));
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

    default:
      return false;
  }
});
