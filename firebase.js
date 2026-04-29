// firebase.js — Firebase REST API 封裝（MV3 service worker 用）
// 認證改用 launchWebAuthFlow（不需要上架 Web Store）

const FIREBASE_CONFIG = {
  apiKey:    'AIzaSyBbuou26FoYbXt1OpMJVLy3m9zz6VDfAM8',
  projectId: 'yt-vocab-learner',
};

const CLIENT_ID     = '778663949144-hc65i88kr5mr1h5ap9npmcoh6gq6t0c7.apps.googleusercontent.com';
const CLIENT_SECRET = 'REDACTED_CLIENT_SECRET';
const REDIRECT_URI  = chrome.identity.getRedirectURL();

// ===== 認證狀態 =====
let _idToken     = null;
let _uid         = null;
let _userInfo    = null;
let _tokenExpiry = 0;

// ===== PKCE 工具函數 =====
function _generateCodeVerifier() {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return btoa(String.fromCharCode(...array))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

async function _generateCodeChallenge(verifier) {
  const data   = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ===== Google 登入（launchWebAuthFlow + PKCE）=====
export async function signInWithGoogle() {
  const verifier   = _generateCodeVerifier();
  const challenge  = await _generateCodeChallenge(verifier);
  const redirectUri = chrome.identity.getRedirectURL();

  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id',            CLIENT_ID);
  url.searchParams.set('redirect_uri',         redirectUri);
  url.searchParams.set('response_type',        'code');
  url.searchParams.set('scope',                'openid email profile');
  url.searchParams.set('code_challenge',       challenge);
  url.searchParams.set('code_challenge_method','S256');

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: url.toString(), interactive: true },
      async (redirectUrl) => {
        if (chrome.runtime.lastError || !redirectUrl) {
          reject(new Error(chrome.runtime.lastError?.message || '登入取消'));
          return;
        }
        // 從 redirect query 取 code
        const code = new URL(redirectUrl).searchParams.get('code');
        if (!code) { reject(new Error('未取得 authorization code')); return; }

        try {
          // 用 code + verifier 換 access_token
          const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              code,
              client_id:     CLIENT_ID,
              client_secret: CLIENT_SECRET,
              redirect_uri:  redirectUri,
              grant_type:    'authorization_code',
              code_verifier: verifier,
            }),
          });
          const tokenData = await tokenRes.json();
          if (tokenData.error) throw new Error(tokenData.error_description || tokenData.error);
          const accessToken = tokenData.access_token;

          // 用 Google access_token 換 Firebase ID token
          const res = await fetch(
            `https://identitytoolkit.googleapis.com/v1/accounts:signInWithIdp?key=${FIREBASE_CONFIG.apiKey}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                postBody:            `access_token=${accessToken}&providerId=google.com`,
                requestUri:          redirectUri,
                returnIdpCredential: true,
                returnSecureToken:   true,
              }),
            }
          );
          const data = await res.json();
          if (data.error) throw new Error(data.error.message);

          _idToken     = data.idToken;
          _uid         = data.localId;
          _tokenExpiry = Date.now() + (data.expiresIn * 1000) - 60000;
          _userInfo    = {
            uid:         data.localId,
            email:       data.email,
            displayName: data.displayName,
            photoUrl:    data.photoUrl,
          };

          await chrome.storage.local.set({
            firebaseUser:         _userInfo,
            firebaseRefreshToken: data.refreshToken,
          });

          resolve(_userInfo);
        } catch (e) {
          reject(e);
        }
      }
    );
  });
}

// ===== 登出 =====
export async function signOut() {
  _idToken  = null;
  _uid      = null;
  _userInfo = null;
  await chrome.storage.local.remove(['firebaseUser', 'firebaseRefreshToken']);
}

// ===== 從 storage 恢復 session =====
export async function restoreSession() {
  const { firebaseUser, firebaseRefreshToken } = await chrome.storage.local.get([
    'firebaseUser', 'firebaseRefreshToken',
  ]);
  if (!firebaseUser || !firebaseRefreshToken) return null;
  _userInfo = firebaseUser;
  _uid      = firebaseUser.uid;
  try {
    await _refreshIdToken(firebaseRefreshToken);
  } catch {
    // refresh 失敗代表 token 過期，清除
    await chrome.storage.local.remove(['firebaseUser', 'firebaseRefreshToken']);
    _userInfo = null;
    _uid      = null;
    return null;
  }
  return _userInfo;
}

// ===== 自動更新 token =====
async function _refreshIdToken(refreshToken) {
  if (refreshToken === '__qa_mock_token__') {
    _idToken     = 'qa-mock-token-do-not-use-in-prod';
    _tokenExpiry = Date.now() + 3600000;
    return _idToken;
  }
  const res = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_CONFIG.apiKey}`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  _idToken     = data.id_token;
  _uid         = data.user_id;
  _tokenExpiry = Date.now() + (parseInt(data.expires_in) * 1000) - 60000;
  await chrome.storage.local.set({ firebaseRefreshToken: data.refresh_token });
  return _idToken;
}

// ===== 取得有效 ID token（過期自動更新，service worker 重啟後自動從 storage 恢復）=====
async function _getIdToken() {
  if (!_idToken) {
    // service worker 被瀏覽器終止重啟後，in-memory token 遺失 → 從 storage 嘗試恢復
    const { firebaseUser, firebaseRefreshToken } = await chrome.storage.local.get([
      'firebaseUser', 'firebaseRefreshToken',
    ]);
    if (!firebaseRefreshToken) throw new Error('未登入');
    if (firebaseUser) { _userInfo = firebaseUser; _uid = firebaseUser.uid; }
    await _refreshIdToken(firebaseRefreshToken);
  }
  if (Date.now() > _tokenExpiry) {
    const { firebaseRefreshToken } = await chrome.storage.local.get('firebaseRefreshToken');
    await _refreshIdToken(firebaseRefreshToken);
  }
  return _idToken;
}

// ===== 取得目前使用者 =====
export function getCurrentUser() {
  return _userInfo;
}

// ===== 取得目前 ID Token（供 Dashboard 使用）=====
export function getIdToken() {
  return _idToken;
}

// ===== QA 後門（本地測試用，不進 git）=====
export function __qaSetAuth(user) {
  _userInfo    = user;
  _uid         = user.uid;
  _idToken     = 'qa-mock-token-do-not-use-in-prod';
  _tokenExpiry = Date.now() + 3600000;
}
// 掛到 service worker global，讓 Playwright worker.evaluate() 可以呼叫
self.__qaSetAuth = __qaSetAuth;

// ===== Firestore helpers =====
const FIRESTORE_BASE =
  `https://firestore.googleapis.com/v1/projects/${FIREBASE_CONFIG.projectId}/databases/(default)/documents`;

function _toFsValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (typeof val === 'number')
    return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  if (typeof val === 'string') return { stringValue: val };
  if (val instanceof Date)     return { timestampValue: val.toISOString() };
  if (Array.isArray(val))      return { arrayValue: { values: val.map(_toFsValue) } };
  if (typeof val === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(val)) fields[k] = _toFsValue(v);
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}

function _fromFsValue(val) {
  if (val.nullValue    !== undefined) return null;
  if (val.booleanValue !== undefined) return val.booleanValue;
  if (val.integerValue !== undefined) return parseInt(val.integerValue);
  if (val.doubleValue  !== undefined) return val.doubleValue;
  if (val.stringValue  !== undefined) return val.stringValue;
  if (val.timestampValue !== undefined) return new Date(val.timestampValue);
  if (val.arrayValue   !== undefined) return (val.arrayValue.values || []).map(_fromFsValue);
  if (val.mapValue     !== undefined) return _fromFsDoc({ fields: val.mapValue.fields });
  return null;
}

function _fromFsDoc(doc) {
  if (!doc.fields) return {};
  const obj = {};
  for (const [k, v] of Object.entries(doc.fields)) obj[k] = _fromFsValue(v);
  if (doc.name) obj._id = doc.name.split('/').pop();
  return obj;
}

function _toFsDoc(data) {
  const fields = {};
  for (const [k, v] of Object.entries(data)) fields[k] = _toFsValue(v);
  return { fields };
}

// 新增文件（自動 ID）
export async function addDoc(collectionPath, data) {
  const token = await _getIdToken();
  const res   = await fetch(`${FIRESTORE_BASE}/${collectionPath}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body:    JSON.stringify(_toFsDoc(data)),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return _fromFsDoc(json);
}

// 設定文件（指定 doc ID，用 word 作 key）
export async function setDoc(docPath, data) {
  const token = await _getIdToken();
  const res   = await fetch(`${FIRESTORE_BASE}/${docPath}`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body:    JSON.stringify(_toFsDoc(data)),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return _fromFsDoc(json);
}

// 讀取集合
export async function getCollection(collectionPath, { orderBy, limit } = {}) {
  const token = await _getIdToken();
  const parts = collectionPath.split('/');
  const query = {
    structuredQuery: {
      from:    [{ collectionId: parts[parts.length - 1] }],
      orderBy: orderBy ? [{ field: { fieldPath: orderBy.field }, direction: orderBy.dir || 'DESCENDING' }] : undefined,
      limit:   limit || 1000,
    },
  };
  const parentPath = parts.slice(0, -1).join('/');
  const queryUrl = parentPath
    ? `${FIRESTORE_BASE}/${parentPath}:runQuery`
    : `${FIRESTORE_BASE}:runQuery`;
  const res = await fetch(queryUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body:    JSON.stringify(query),
  });
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error(json?.error?.message || '查詢失敗');
  return json.filter(r => r.document).map(r => _fromFsDoc(r.document));
}

// 跨集合群組公開查詢（allDescendants: true，不需登入）
// 回傳的每筆資料額外帶 _parentId（上一層 doc ID，例如 videoId）
// select: ['field1','field2'] 可限制回傳欄位，避免拉回大量字幕內容
export async function getCollectionGroupPublic(collectionId, { orderBy, limit, select } = {}) {
  const query = {
    structuredQuery: {
      select:  select ? { fields: select.map(f => ({ fieldPath: f })) } : undefined,
      from:    [{ collectionId, allDescendants: true }],
      orderBy: orderBy ? [{ field: { fieldPath: orderBy.field }, direction: orderBy.dir || 'DESCENDING' }] : undefined,
      limit:   limit || 1000,
    },
  };
  const url = `${FIRESTORE_BASE}:runQuery?key=${FIREBASE_CONFIG.apiKey}`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(query),
  });
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error('查詢失敗');
  return json.filter(r => r.document).map(r => {
    const segments = r.document.name.split('/');
    // path: ...documents/customSubtitles/{videoId}/entries/{docId}
    // segments from end: [docId, entries, videoId, customSubtitles, documents, ...]
    const parentId = segments[segments.length - 3] ?? null;
    return { ...(_fromFsDoc(r.document)), _parentId: parentId };
  });
}

// 公開查詢（不需登入，適用 Firestore rules allow read: if true 的 collection）
export async function getCollectionPublic(collectionPath, { orderBy, limit } = {}) {
  const parts = collectionPath.split('/');
  const query = {
    structuredQuery: {
      from:    [{ collectionId: parts[parts.length - 1] }],
      orderBy: orderBy ? [{ field: { fieldPath: orderBy.field }, direction: orderBy.dir || 'DESCENDING' }] : undefined,
      limit:   limit || 1000,
    },
  };
  const parentPath = parts.slice(0, -1).join('/');
  const queryUrl = parentPath
    ? `${FIRESTORE_BASE}/${parentPath}:runQuery`
    : `${FIRESTORE_BASE}:runQuery`;
  const url = `${queryUrl}?key=${FIREBASE_CONFIG.apiKey}`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(query),
  });
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error('查詢失敗');
  return json.filter(r => r.document).map(r => _fromFsDoc(r.document));
}

// 刪除文件
export async function deleteDoc(docPath) {
  const token = await _getIdToken();
  await fetch(`${FIRESTORE_BASE}/${docPath}`, {
    method:  'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  });
}

// 讀取單一 doc（不存在回傳 null）
export async function getDoc(docPath) {
  const token = await _getIdToken();
  const res   = await fetch(`${FIRESTORE_BASE}/${docPath}`, {
    headers: { 'Authorization': `Bearer ${token}` },
  });
  if (res.status === 404) return null;
  const json = await res.json();
  if (json.error) return null;
  return _fromFsDoc(json);
}

// 部分更新 doc（PATCH 只更新指定欄位）
export async function updateDoc(docPath, data) {
  const token  = await _getIdToken();
  const fields = Object.keys(data).map(k => `updateMask.fieldPaths=${encodeURIComponent(k)}`).join('&');
  const res    = await fetch(`${FIRESTORE_BASE}/${docPath}?${fields}`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body:    JSON.stringify(_toFsDoc(data)),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return _fromFsDoc(json);
}
