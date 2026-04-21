// vocab-dashboard.js — 學習Bar 後台管理主程式

// ===== Firebase 設定（同 firebase.js）=====
const FB_API_KEY  = 'AIzaSyBbuou26FoYbXt1OpMJVLy3m9zz6VDfAM8';
const FB_PROJECT  = 'yt-vocab-learner';
const FS_BASE     = `https://firestore.googleapis.com/v1/projects/${FB_PROJECT}/databases/(default)/documents`;

// ===== 全域狀態 =====
let _idToken    = null;
let _uid        = null;
let _userInfo   = null;
let _gasUrl     = '';
let _lineUserId = '';

// 各 tab 的資料快取
const cache = {};

// ===== DOM 工具 =====
const $  = id => document.getElementById(id);
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

// ===== Firestore 資料格式 =====
function _fromFsValue(v) {
  if (v.nullValue    !== undefined) return null;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.integerValue !== undefined) return parseInt(v.integerValue);
  if (v.doubleValue  !== undefined) return v.doubleValue;
  if (v.stringValue  !== undefined) return v.stringValue;
  if (v.timestampValue !== undefined) return new Date(v.timestampValue);
  if (v.arrayValue   !== undefined) return (v.arrayValue.values || []).map(_fromFsValue);
  if (v.mapValue     !== undefined) return _fromFsDoc({ fields: v.mapValue.fields });
  return null;
}
function _fromFsDoc(doc) {
  if (!doc.fields) return {};
  const obj = {};
  for (const [k, v] of Object.entries(doc.fields)) obj[k] = _fromFsValue(v);
  if (doc.name) obj._id = doc.name.split('/').pop();
  return obj;
}

// ===== Firestore 查詢（需登入）=====
async function fsQuery(collection, { orderBy, limit } = {}) {
  const token = await _getIdToken();
  const parts = collection.split('/');
  const query = {
    structuredQuery: {
      from: [{ collectionId: parts[parts.length - 1] }],
      orderBy: orderBy ? [{ field: { fieldPath: orderBy.field }, direction: orderBy.dir || 'DESCENDING' }] : undefined,
      limit: limit || 500,
    },
  };
  const parentPath = parts.slice(0, -1).join('/');
  const res = await fetch(`${FS_BASE}/${parentPath}:runQuery?key=${FB_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(query),
  });
  const json = await res.json();
  if (!Array.isArray(json)) throw new Error('查詢失敗');
  return json.filter(r => r.document).map(r => _fromFsDoc(r.document));
}

// ===== Firestore 公開查詢（只限有 allow read: if true 的 collection）=====
async function fsQueryPublic(collection, opts = {}) {
  const parts = collection.split('/');
  const query = {
    structuredQuery: {
      from: [{ collectionId: parts[parts.length - 1] }],
      orderBy: opts.orderBy ? [{ field: { fieldPath: opts.orderBy.field }, direction: opts.orderBy.dir || 'DESCENDING' }] : undefined,
      limit: opts.limit || 500,
    },
  };
  const parentPath = parts.slice(0, -1).join('/');
  const res = await fetch(`${FS_BASE}/${parentPath}:runQuery?key=${FB_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${_idToken}` },
    body: JSON.stringify(query),
  });
  const json = await res.json();
  if (!Array.isArray(json)) return [];
  return json.filter(r => r.document).map(r => _fromFsDoc(r.document));
}

// ===== Firestore 刪除（需登入）=====
async function fsDelete(docPath) {
  const token = await _getIdToken();
  await fetch(`${FS_BASE}/${docPath}?key=${FB_API_KEY}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bearer ${token}` },
  });
}

// ===== Firestore 寫入（需登入）=====
function _toFsValue(val) {
  if (val === null || val === undefined) return { nullValue: null };
  if (typeof val === 'boolean') return { booleanValue: val };
  if (val instanceof Date) return { timestampValue: val.toISOString() };
  if (typeof val === 'number') return Number.isInteger(val) ? { integerValue: String(val) } : { doubleValue: val };
  if (typeof val === 'string') return { stringValue: val };
  if (Array.isArray(val)) return { arrayValue: { values: val.map(_toFsValue) } };
  if (typeof val === 'object') {
    const fields = {};
    for (const [k, v] of Object.entries(val)) fields[k] = _toFsValue(v);
    return { mapValue: { fields } };
  }
  return { stringValue: String(val) };
}
async function fsSet(docPath, data) {
  const token = await _getIdToken();
  const fields = {};
  for (const [k, v] of Object.entries(data)) fields[k] = _toFsValue(v);
  const res = await fetch(`${FS_BASE}/${docPath}?key=${FB_API_KEY}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ fields }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return _fromFsDoc(json);
}
async function fsAdd(collection, data) {
  const token = await _getIdToken();
  const fields = {};
  for (const [k, v] of Object.entries(data)) fields[k] = _toFsValue(v);
  const res = await fetch(`${FS_BASE}/${collection}?key=${FB_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ fields }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return _fromFsDoc(json);
}

// ===== 認證（透過 background.js）=====
function sendMsg(type, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...extra }, res => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(res);
    });
  });
}

async function _getIdToken() {
  if (_idToken) return _idToken;
  throw new Error('未登入');
}

// 從 background 恢復 Firebase token
async function restoreAuth() {
  const res = await sendMsg('fb_getUser');
  const user = res?.user;
  if (!user) return null;
  // 觸發一次 getWords 讓 background 取得/更新 idToken
  const wordsRes = await sendMsg('fb_getWords');
  // background.js 自己管理 token，我們透過它中轉認證
  _userInfo = user;
  _uid = user.uid;
  // 取得 idToken（需要從 background 中繼）
  return user;
}

// 所有 Firestore 操作走 background 中繼
async function bgFsQuery(collection, opts = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'fs_query', collection, opts }, res => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else if (res?.ok) resolve(res.data || []);
      else reject(new Error(res?.error || '查詢失敗'));
    });
  });
}

// ===== GAS API 呼叫 =====
async function callGAS(action, params = {}) {
  if (!_gasUrl) throw new Error('未設定 Apps Script URL，請到設定頁面填寫');
  const res = await fetch(_gasUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...params }),
    redirect: 'follow',
  });
  return await res.json();
}

// ===== 設定管理 =====
async function loadSettings() {
  const data = await chrome.storage.local.get(['gasUrl', 'lineUserId']);
  _gasUrl     = data.gasUrl     || '';
  _lineUserId = data.lineUserId || '';
  if ($('cfg-gas-url'))  $('cfg-gas-url').value  = _gasUrl;
  if ($('cfg-line-uid')) $('cfg-line-uid').value  = _lineUserId;
}

async function saveSettings() {
  _gasUrl     = $('cfg-gas-url').value.trim();
  _lineUserId = $('cfg-line-uid').value.trim();
  await chrome.storage.local.set({ gasUrl: _gasUrl, lineUserId: _lineUserId });
  showToast('設定已儲存');
}

// ===== 格式化工具 =====
function fmtDate(val) {
  if (!val) return '—';
  const d = val instanceof Date ? val : new Date(typeof val === 'number' ? val : (val.seconds ? val.seconds * 1000 : val));
  if (isNaN(d)) return String(val);
  return `${d.getFullYear()}/${String(d.getMonth()+1).padStart(2,'0')}/${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function tsMs(w) {
  const a = w.addedAt || w.learnedAt || w.timestamp || w.createdAt;
  if (!a) return 0;
  if (a instanceof Date) return a.getTime();
  if (typeof a === 'number') return a;
  if (a.seconds) return a.seconds * 1000;
  return 0;
}
function tierBadge(tier) {
  const t = (tier || '').toUpperCase() || 'unknown';
  return `<span class="tier-badge tier-${t}">${t === 'UNKNOWN' ? '—' : t}</span>`;
}
function statusBadge(status) {
  const cls = { PENDING:'badge-yellow', ACTIVE:'badge-green', DONE:'badge-gray', EXPIRED:'badge-red' }[status] || 'badge-gray';
  return `<span class="status-badge ${cls}">${status}</span>`;
}

// ===== Toast =====
function showToast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `vd-toast toast-${type}`;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 3000);
}

// ===== 匯出 CSV =====
function exportCsv(headers, rows, filename) {
  const csv = [headers.join(','), ...rows.map(r => r.map(v => `"${String(v||'').replace(/"/g,'""')}"`).join(','))].join('\n');
  const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ===== Tab 切換 =====
let activeTab = 'overview';
function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === `tab-${tabId}`));
  activeTab = tabId;
  loadTab(tabId);
}

function loadTab(tabId) {
  switch(tabId) {
    case 'overview': loadOverview(); break;
    case 'line-log': loadLineLog(); break;
    case 'vocab':    loadVocab(); break;
    case 'keywords': loadKeywords(); break;
    case 'schedule': loadSchedule(); break;
    case 'memory':   loadMemory(); break;
    case 'games':    loadGames(); break;
    case 'settings':     break;
    case 'permissions':  loadPermissions(); break;
  }
}

// ----- 權限管理 -----
const ADMIN_EMAIL = 'kuoway79@gmail.com';

let _permEntries = []; // 快取所有申請，供篩選重用

async function loadPermissions() {
  const isAdmin = _userInfo?.email === ADMIN_EMAIL;
  document.getElementById('permissions-admin-only').style.display = isAdmin ? '' : 'none';
  document.getElementById('permissions-no-access').style.display  = isAdmin ? 'none' : '';
  if (!isAdmin) return;
  await _renderPermTable();
  document.getElementById('perm-refresh-btn').onclick = _renderPermTable;
  document.getElementById('perm-filter').addEventListener('change', _applyPermFilter);
}

async function _renderPermTable() {
  const tbody = document.getElementById('perm-tbody');
  tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#71717a">載入中...</td></tr>';
  let res;
  try { res = await sendMsg('fb_getEditorPermissions'); }
  catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:#ef4444">連線失敗，請重試（${e.message}）</td></tr>`;
    return;
  }
  if (!res?.ok) {
    tbody.innerHTML = `<tr><td colspan="5" style="color:#ef4444">讀取失敗：${res?.error || '未知'}</td></tr>`;
    return;
  }
  _permEntries = res.entries || [];

  // 統計
  const editorCount = _permEntries.filter(e => e.enabled).length;
  const userCount   = _permEntries.filter(e => !e.enabled).length;
  const statsEl = document.getElementById('perm-stats');
  if (statsEl) {
    statsEl.innerHTML = `
      <span class="perm-stat-item"><span class="perm-tier-badge tier-editor">editor</span> ${editorCount} 人</span>
      <span class="perm-stat-item"><span class="perm-tier-badge tier-user">user</span> ${userCount} 人待審核</span>
    `;
  }

  _applyPermFilter();
}

function _applyPermFilter() {
  const filter = document.getElementById('perm-filter')?.value || 'all';
  const tbody = document.getElementById('perm-tbody');
  if (!tbody) return;

  const entries = _permEntries.filter(e => {
    if (filter === 'editor') return e.enabled;
    if (filter === 'user')   return !e.enabled;
    return true;
  });

  if (!entries.length) {
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#71717a">無符合記錄</td></tr>';
    return;
  }

  tbody.innerHTML = '';
  for (const entry of entries) {
    const tr = document.createElement('tr');
    const date = entry.requestedAt ? new Date(entry.requestedAt).toLocaleString('zh-TW') : '—';
    const tier = entry.enabled ? 'editor' : 'user';
    const tierBadgeHtml = `<span class="perm-tier-badge tier-${tier}">${tier}</span>`;
    const actionBtn = entry.enabled
      ? `<button class="vd-tool-btn perm-toggle-btn perm-btn-revoke" data-uid="${entry.uid}" data-enabled="false">撤銷 Editor</button>`
      : `<button class="vd-tool-btn perm-toggle-btn perm-btn-grant" data-uid="${entry.uid}" data-enabled="true">授予 Editor</button>`;
    tr.innerHTML = `
      <td>${esc(entry.email || '—')}</td>
      <td>${esc(entry.displayName || '—')}</td>
      <td style="white-space:nowrap">${date}</td>
      <td>${tierBadgeHtml}</td>
      <td>${actionBtn}</td>
    `;
    tbody.appendChild(tr);
  }

  // 綁定核准/撤銷按鈕
  tbody.querySelectorAll('.perm-toggle-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const enabled = btn.dataset.enabled === 'true';
      const confirmMsg = enabled
        ? `確定授予此帳號 Editor 權限？`
        : `確定撤銷此帳號的 Editor 權限？撤銷後將降為 user 等級。`;
      if (!confirm(confirmMsg)) return;
      btn.disabled = true;
      btn.textContent = '處理中...';
      const r = await sendMsg('fb_setEditorPermission', { uid: btn.dataset.uid, enabled });
      if (r?.ok) {
        await _renderPermTable();
      } else {
        btn.disabled = false;
        btn.textContent = enabled ? '授予 Editor' : '撤銷 Editor';
        alert('操作失敗：' + (r?.error || '未知'));
      }
    });
  });
}

// ===========================
// ===== 各 Tab 邏輯 =========
// ===========================

// ----- 概覽 -----
async function loadOverview() {
  // 並行載入各集合
  const loads = await Promise.allSettled([
    sendMsg('fb_getWords'),
    loadCollection('line_messages'),
    loadCollection('learn_words'),
    loadCollection('keywords'),
    loadCollection('memory'),
    loadCollection('schedule'),
    loadCollection('scores'),
  ]);
  const ytWords   = loads[0].status === 'fulfilled' ? (loads[0].value?.words || []) : [];
  const lineMsg   = loads[1].status === 'fulfilled' ? loads[1].value : [];
  const learnWords= loads[2].status === 'fulfilled' ? loads[2].value : [];
  const keywords  = loads[3].status === 'fulfilled' ? loads[3].value : [];
  const memory    = loads[4].status === 'fulfilled' ? loads[4].value : [];
  const schedule  = loads[5].status === 'fulfilled' ? loads[5].value : [];
  const scores    = loads[6].status === 'fulfilled' ? loads[6].value : [];

  $('ov-vocab').textContent  = ytWords.length;
  $('ov-line').textContent   = lineMsg.length;
  $('ov-learn').textContent  = learnWords.length;
  $('ov-kw').textContent     = keywords.length;
  $('ov-mem').textContent    = memory.length;
  $('ov-sched').textContent  = schedule.filter(s => s.status === 'PENDING' || s.status === 'ACTIVE').length;
  $('ov-score').textContent  = scores.length;

  // 最近 LINE 訊息
  const recentLine = [...lineMsg].sort((a,b) => tsMs(b) - tsMs(a)).slice(0, 5);
  $('ov-recent-line').innerHTML = recentLine.map(m =>
    `<div class="recent-item"><span class="recent-time">${fmtDate(m.timestamp)}</span><span class="recent-name">${esc(m.userName||'')}</span><span class="recent-msg">${esc((m.msgContent||'').substring(0,30))}</span></div>`
  ).join('') || '<div class="recent-empty">暫無資料</div>';

  // 最近 YT 單字
  const recentVocab = [...ytWords].sort((a,b) => tsMs(b) - tsMs(a)).slice(0, 5);
  $('ov-recent-vocab').innerHTML = recentVocab.map(w =>
    `<div class="recent-item"><span class="recent-word">${esc(w.word||'')}</span><span class="recent-zh">${esc(w.wordZh||'')}</span>${tierBadge(w.tier)}</div>`
  ).join('') || '<div class="recent-empty">暫無資料</div>';
}

// ----- LINE 紀錄 -----
let lineData = [];
async function loadLineLog() {
  showTableState('line', 'loading');
  lineData = await loadCollection('line_messages', { orderBy: { field: 'timestamp', dir: 'DESCENDING' }, limit: 300 });
  renderLineLog();
}
function renderLineLog() {
  const q    = ($('line-search')?.value || '').toLowerCase();
  const type = $('line-filter-type')?.value || '';
  const rows = lineData.filter(m => {
    if (type && m.msgType !== type) return false;
    if (q && ![m.userName, m.msgContent, m.groupName].join(' ').toLowerCase().includes(q)) return false;
    return true;
  });
  $('line-count').textContent = `${rows.length} 筆`;
  if (!rows.length) { showTableState('line', 'empty'); return; }
  showTableState('line', 'table');
  $('line-tbody').innerHTML = rows.map((m, i) => `
    <tr>
      <td class="th-num" style="color:var(--ed-text2)">${i+1}</td>
      <td class="td-time">${fmtDate(m.timestamp)}</td>
      <td>${esc(m.groupName||m.groupId||'個人')}</td>
      <td>${esc(m.userName||m.userId||'')}</td>
      <td><span class="type-badge">${esc(m.msgType||'')}</span></td>
      <td class="td-msg-content">${esc((m.msgContent||'').substring(0,80))}${(m.msgContent||'').length > 80 ? '...' : ''}</td>
    </tr>
  `).join('');
}

// ----- 單字庫 -----
let ytVocabData = [], lineVocabData = [];
let activeVocabSubtab = 'yt-vocab';

async function loadVocab() {
  if (activeVocabSubtab === 'yt-vocab') {
    await loadYtVocab();
  } else {
    await loadLineVocab();
  }
}
async function loadYtVocab() {
  showTableState('yt-vocab', 'loading');
  const res = await sendMsg('fb_getWords');
  ytVocabData = res?.words || [];
  renderYtVocab();
}
async function loadLineVocab() {
  showTableState('line-vocab', 'loading');
  lineVocabData = await loadCollection('learn_words', { orderBy: { field: 'learnedAt', dir: 'DESCENDING' } });
  renderLineVocab();
}
function renderYtVocab() {
  const q    = ($('vocab-search')?.value || '').toLowerCase();
  const tier = $('vocab-tier')?.value || '';
  const rows = ytVocabData.filter(w => {
    if (tier && tier !== 'unknown' && (w.tier||'').toUpperCase() !== tier) return false;
    if (tier === 'unknown' && w.tier) return false;
    if (q && ![w.word, w.wordZh, w.definitionZh, w.context].join(' ').toLowerCase().includes(q)) return false;
    return true;
  });
  $('vocab-count').textContent = `${rows.length} 筆`;
  if (!rows.length) { showTableState('yt-vocab', 'empty'); return; }
  showTableState('yt-vocab', 'table');
  const ytUrl = w => w.videoId ? `https://www.youtube.com/watch?v=${w.videoId}${w.startTime ? '&t='+Math.floor(w.startTime) : ''}` : '';
  $('yt-vocab-tbody').innerHTML = rows.map((w, i) => `
    <tr>
      <td class="th-num" style="color:var(--ed-text2)">${i+1}</td>
      <td class="td-word">${esc(w.word||'')}</td>
      <td><div style="font-size:12px">${esc(w.wordZh||'')}</div><div style="font-size:11px;color:var(--ed-text2)">${esc(w.definitionZh||'')}</div></td>
      <td>${tierBadge(w.tier)}</td>
      <td class="td-context">${esc((w.context||'').substring(0,60))}</td>
      <td class="td-count" style="text-align:center">${w.count||1}</td>
      <td class="td-time">${fmtDate(w.addedAt)}</td>
      <td>${w.videoId ? `<a href="${ytUrl(w)}" target="_blank" style="color:var(--ed-accent);font-size:11px">${esc(w.videoId)}</a>` : '—'}</td>
      <td style="white-space:nowrap">
        <button class="vd-del-btn push-btn" data-word="${esc(w.word)}" title="推播到 LINE">📱</button>
        <button class="vd-del-btn" data-word="${esc(w.word)}" data-action="del-yt-vocab" title="刪除">✕</button>
      </td>
    </tr>
  `).join('');
  $('yt-vocab-tbody').querySelectorAll('.push-btn').forEach(btn => btn.addEventListener('click', () => openPushModal(btn.dataset.word)));
  $('yt-vocab-tbody').querySelectorAll('[data-action="del-yt-vocab"]').forEach(btn => btn.addEventListener('click', () => deleteYtWord(btn.dataset.word)));
}
function renderLineVocab() {
  if (!lineVocabData.length) { showTableState('line-vocab', 'empty'); return; }
  showTableState('line-vocab', 'table');
  $('line-vocab-tbody').innerHTML = lineVocabData.map((w, i) => `
    <tr>
      <td class="th-num" style="color:var(--ed-text2)">${i+1}</td>
      <td class="td-word">${esc(w.word||'')}</td>
      <td>${esc(w.translation||'')}</td>
      <td>${esc(w.partOfSpeech||'')}</td>
      <td class="td-context">${esc((w.example||'').substring(0,50))}</td>
      <td>${esc(w.userName||'')}</td>
      <td class="td-time">${fmtDate(w.learnedAt)}</td>
      <td>
        <button class="vd-del-btn push-btn" data-word="${esc(w.word)}" data-zh="${esc(w.translation||'')}" title="推播到 LINE">📱</button>
      </td>
    </tr>
  `).join('');
  $('line-vocab-tbody').querySelectorAll('.push-btn').forEach(btn => btn.addEventListener('click', () => openPushModal(btn.dataset.word, btn.dataset.zh)));
}

// ----- 關鍵字 -----
let kwData = [];
async function loadKeywords() {
  showTableState('kw', 'loading');
  kwData = await loadCollection('keywords');
  renderKeywords();
}
function renderKeywords() {
  $('kw-count').textContent = `${kwData.length} 組`;
  if (!kwData.length) { showTableState('kw', 'empty'); return; }
  showTableState('kw', 'table');
  $('kw-tbody').innerHTML = kwData.map((k, i) => `
    <tr>
      <td class="th-num" style="color:var(--ed-text2)">${i+1}</td>
      <td class="td-word">${esc(k.keyword||k._id||'')}</td>
      <td>${k.fileId ? `<a href="https://drive.google.com/thumbnail?id=${esc(k.fileId)}&sz=w60" target="_blank"><img src="https://drive.google.com/thumbnail?id=${esc(k.fileId)}&sz=w60" style="height:40px;border-radius:4px"></a>` : '—'}</td>
      <td>${esc(k.createdBy||'')}</td>
      <td class="td-time">${fmtDate(k.createdAt)}</td>
      <td><button class="vd-del-btn" data-id="${esc(k._id||k.keyword||'')}" data-action="del-kw">✕</button></td>
    </tr>
  `).join('');
  $('kw-tbody').querySelectorAll('[data-action="del-kw"]').forEach(btn => btn.addEventListener('click', () => deleteKeyword(btn.dataset.id)));
}
async function saveNewKeyword() {
  const keyword = $('kw-new-keyword').value.trim();
  const fileId  = $('kw-new-fileid').value.trim();
  if (!keyword || !fileId) { showToast('請填寫關鍵字和檔案 ID', 'error'); return; }
  try {
    // 同時寫 Firebase + Google Sheets
    await Promise.all([
      fetch(`${FS_BASE}/keywords/${encodeURIComponent(keyword)}?key=${FB_API_KEY}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: { keyword: { stringValue: keyword }, fileId: { stringValue: fileId }, createdAt: { timestampValue: new Date().toISOString() } } }),
      }),
      callGAS('add_keyword', { keyword, fileId }),
    ]);
    showToast('新增成功');
    $('kw-add-form').style.display = 'none';
    $('kw-new-keyword').value = '';
    $('kw-new-fileid').value = '';
    await loadKeywords();
  } catch(e) { showToast('新增失敗：' + e.message, 'error'); }
}
async function deleteKeyword(id) {
  if (!confirm(`確定要刪除關鍵字「${id}」？`)) return;
  try {
    await Promise.all([
      fetch(`${FS_BASE}/keywords/${encodeURIComponent(id)}?key=${FB_API_KEY}`, { method: 'DELETE' }),
      callGAS('delete_by_key', { sheetName: 'Keywords', key: id }),
    ]);
    showToast('已刪除');
    await loadKeywords();
  } catch(e) { showToast('刪除失敗：' + e.message, 'error'); }
}

// ----- 排程 -----
let schedData = [];
async function loadSchedule() {
  showTableState('sched', 'loading');
  schedData = await loadCollection('schedule', { orderBy: { field: 'createdAt', dir: 'DESCENDING' } });
  renderSchedule();
}
function renderSchedule() {
  const filter = $('sched-filter')?.value || '';
  const rows = filter ? schedData.filter(s => s.status === filter) : schedData;
  $('sched-count').textContent = `${rows.length} 筆`;
  if (!rows.length) { showTableState('sched', 'empty'); return; }
  showTableState('sched', 'table');
  $('sched-tbody').innerHTML = rows.map((s, i) => `
    <tr>
      <td class="th-num" style="color:var(--ed-text2)">${i+1}</td>
      <td style="font-size:11px;color:var(--ed-text2)">${esc((s.to||'').substring(0,16))}...</td>
      <td>${esc(s.userName||'')}</td>
      <td>${esc(s.targetTime instanceof Date ? fmtDate(s.targetTime) : (s.targetTime||''))}</td>
      <td class="td-context">${esc(s.notes||'')}</td>
      <td>${statusBadge(s.status||'')}</td>
      <td class="td-time">${fmtDate(s.createdAt)}</td>
      <td>
        <button class="vd-del-btn" data-id="${esc(s._id||'')}" data-action="del-sched">✕</button>
      </td>
    </tr>
  `).join('');
  $('sched-tbody').querySelectorAll('[data-action="del-sched"]').forEach(btn => btn.addEventListener('click', () => deleteSchedule(btn.dataset.id)));
}
async function deleteSchedule(id) {
  if (!id || !confirm('確定要刪除此排程？')) return;
  await fetch(`${FS_BASE}/schedule/${id}?key=${FB_API_KEY}`, { method: 'DELETE' });
  showToast('排程已刪除');
  await loadSchedule();
}

// ----- 記憶 -----
let memData = [];
async function loadMemory() {
  showTableState('mem', 'loading');
  memData = await loadCollection('memory');
  renderMemory();
}
function renderMemory() {
  $('mem-count').textContent = `${memData.length} 條`;
  if (!memData.length) { showTableState('mem', 'empty'); return; }
  showTableState('mem', 'table');
  $('mem-tbody').innerHTML = memData.map((m, i) => `
    <tr>
      <td class="th-num" style="color:var(--ed-text2)">${i+1}</td>
      <td class="td-word">${esc(m.trigger||m._id||'')}</td>
      <td>${esc(m.response||'')}</td>
      <td>${esc(m.userId||'')}</td>
      <td class="td-time">${fmtDate(m.createdAt)}</td>
      <td><button class="vd-del-btn" data-id="${esc(m._id||m.trigger||'')}" data-action="del-mem">✕</button></td>
    </tr>
  `).join('');
  $('mem-tbody').querySelectorAll('[data-action="del-mem"]').forEach(btn => btn.addEventListener('click', () => deleteMemory(btn.dataset.id)));
}
async function saveNewMemory() {
  const trigger  = $('mem-trigger').value.trim();
  const response = $('mem-response').value.trim();
  if (!trigger || !response) { showToast('請填寫觸發詞和回覆', 'error'); return; }
  await Promise.all([
    fetch(`${FS_BASE}/memory/${encodeURIComponent(trigger)}?key=${FB_API_KEY}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fields: { trigger: { stringValue: trigger }, response: { stringValue: response }, createdAt: { timestampValue: new Date().toISOString() } } }),
    }),
    callGAS('add_memory', { trigger, response }),
  ]);
  showToast('記憶新增成功');
  $('mem-add-form').style.display = 'none';
  $('mem-trigger').value = $('mem-response').value = '';
  await loadMemory();
}
async function deleteMemory(id) {
  if (!confirm(`確定要刪除記憶「${id}」？`)) return;
  await Promise.all([
    fetch(`${FS_BASE}/memory/${encodeURIComponent(id)}?key=${FB_API_KEY}`, { method: 'DELETE' }),
    callGAS('delete_by_key', { sheetName: 'Memory', key: id }),
  ]);
  showToast('已刪除');
  await loadMemory();
}

// ----- 遊戲 -----
let scoreData = [], questionsData = [];
let activeGameSubtab = 'game-scores';

async function loadGames() {
  if (activeGameSubtab === 'game-scores') {
    showTableState('score', 'loading');
    scoreData = await loadCollection('scores', { orderBy: { field: 'timestamp', dir: 'DESCENDING' } });
    renderScores();
  } else {
    $('questions-loading').style.display = 'flex';
    questionsData = await loadCollection('games');
    renderQuestions();
  }
}
function renderScores() {
  $('game-count').textContent = `${scoreData.length} 筆`;
  if (!scoreData.length) { showTableState('score', 'empty'); return; }
  showTableState('score', 'table');
  $('score-tbody').innerHTML = scoreData.map((s, i) => `
    <tr>
      <td class="th-num" style="color:var(--ed-text2)">${i+1}</td>
      <td>${esc(s.userName||s.userId||'')}</td>
      <td>${esc(s.gameName||'')}</td>
      <td><span class="type-badge">${esc(s.mode||'')}</span></td>
      <td style="text-align:center;font-weight:600;color:var(--ed-accent)">${s.score??'—'}</td>
      <td class="td-time">${fmtDate(s.timestamp)}</td>
    </tr>
  `).join('');
}
function renderQuestions() {
  $('questions-loading').style.display = 'none';
  if (!questionsData.length) { $('questions-empty').style.display = 'flex'; return; }
  $('questions-table').style.display = 'table';
  $('questions-tbody').innerHTML = questionsData.map((q, i) => `
    <tr>
      <td class="th-num" style="color:var(--ed-text2)">${i+1}</td>
      <td>${esc(q.gameName||'')}</td>
      <td><span class="type-badge">${esc(q.mode||'')}</span></td>
      <td style="text-align:center">${q.chapterIdx??'—'}</td>
      <td class="td-context">${esc((q.content||'').substring(0,50))}</td>
      <td>${esc(q.answer||'')}</td>
    </tr>
  `).join('');
}

// ----- 刪除 YT 單字 -----
async function deleteYtWord(word) {
  if (!confirm(`確定要刪除「${word}」？`)) return;
  const res = await sendMsg('fb_deleteWord', { word });
  if (res?.ok) { showToast('已刪除'); await loadYtVocab(); }
  else showToast('刪除失敗', 'error');
}

// ----- LINE 推播 -----
let _pushWord = null;
function openPushModal(word, wordZh = '') {
  _pushWord = { word, wordZh };
  $('push-word-preview').textContent = `將推播「${word}」${wordZh ? '（' + wordZh + '）' : ''} 到 LINE`;
  $('push-modal').style.display = 'flex';
}
async function doPush() {
  $('push-modal').style.display = 'none';
  if (!_lineUserId) { showToast('請先在設定頁填寫 LINE User ID', 'error'); return; }
  if (!_gasUrl)     { showToast('請先在設定頁填寫 Apps Script URL', 'error'); return; }

  const w = ytVocabData.find(x => x.word === _pushWord.word) ||
            lineVocabData.find(x => x.word === _pushWord.word) || _pushWord;

  try {
    const res = await callGAS('push_vocab_card', {
      to:          _lineUserId,
      word:        w.word        || '',
      wordZh:      w.wordZh      || w.translation || _pushWord.wordZh || '',
      definitionZh:w.definitionZh|| '',
      tier:        w.tier        || '',
      context:     w.context     || w.example     || '',
      contextZh:   w.contextZh   || '',
      videoId:     w.videoId     || '',
      startTime:   w.startTime   || 0,
    });
    if (res?.success) showToast('推播成功 ✓');
    else showToast('推播失敗：' + (res?.error || ''), 'error');
  } catch(e) { showToast('推播失敗：' + e.message, 'error'); }
}

// ===== 通用：載入 Firestore 集合 =====
async function loadCollection(collection, opts = {}) {
  try {
    const parts = collection.split('/');
    const query = {
      structuredQuery: {
        from: [{ collectionId: parts[parts.length - 1] }],
        orderBy: opts.orderBy ? [{ field: { fieldPath: opts.orderBy.field }, direction: opts.orderBy.dir || 'DESCENDING' }] : undefined,
        limit: opts.limit || 500,
      },
    };
    const parentPath = parts.slice(0, -1).join('/');
    // 根層集合不加多餘的斜線
    const url = parentPath
      ? `${FS_BASE}/${parentPath}:runQuery?key=${FB_API_KEY}`
      : `${FS_BASE}:runQuery?key=${FB_API_KEY}`;
    const headers = { 'Content-Type': 'application/json' };
    if (_idToken) headers['Authorization'] = `Bearer ${_idToken}`;
    const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(query) });
    const json = await res.json();
    if (!Array.isArray(json)) return [];
    return json.filter(r => r.document).map(r => _fromFsDoc(r.document));
  } catch(e) {
    console.error('[Dashboard] loadCollection error:', e);
    return [];
  }
}

// ===== 狀態顯示控制 =====
function showTableState(prefix, state) {
  const loadingEl  = $(`${prefix}-loading`);
  const emptyEl    = $(`${prefix}-empty`);
  const tableEl    = $(`${prefix}-table`) || $(`${prefix}-wrap`)?.querySelector('table');
  const wrapEl     = $(`${prefix}-table-wrap`) || $(`${prefix}-wrap`);
  if (loadingEl) loadingEl.style.display = state === 'loading' ? 'flex' : 'none';
  if (emptyEl)   emptyEl.style.display   = state === 'empty'   ? 'flex' : 'none';
  if (tableEl)   tableEl.style.display   = state === 'table'   ? 'table': 'none';
}

// ===== 認證 UI =====
async function handleSignIn() {
  $('vd-auth-btn').textContent = '登入中...';
  $('vd-auth-btn').disabled = true;
  const res = await sendMsg('fb_signIn');
  if (res?.ok) {
    _userInfo = res.user;
    _uid      = res.user.uid;
    setAuthUI(res.user);
    const tokenRes = await sendMsg('fb_getIdToken');
    if (tokenRes?.token) _idToken = tokenRes.token;
    showToast('登入成功');
    loadTab(activeTab);
  } else {
    showToast('登入失敗：' + (res?.error || ''), 'error');
    $('vd-auth-btn').textContent = '登入 Google';
    $('vd-auth-btn').disabled = false;
  }
}
async function handleSignOut() {
  await sendMsg('fb_signOut');
  _userInfo = _uid = _idToken = null;
  setAuthUI(null);
  showToast('已登出');
}
function setAuthUI(user) {
  $('vd-user-name').textContent = user ? (user.displayName || user.email || '') : '';
  $('vd-auth-btn').textContent  = user ? '登出' : '登入 Google';
  $('vd-auth-btn').disabled = false;
  $('vd-auth-btn').onclick = user ? handleSignOut : handleSignIn;
  if ($('settings-user-info')) {
    $('settings-user-info').innerHTML = user
      ? `<div style="font-size:12px;color:var(--ed-text)">已登入：${esc(user.displayName||'')} (${esc(user.email||'')})</div>`
      : '<div style="font-size:12px;color:var(--ed-text2)">尚未登入</div>';
  }
}

// ===== 事件綁定 =====
function bindEvents() {
  // Tab 切換
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // 子 Tab：單字庫
  document.querySelectorAll('#tab-vocab .subtab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#tab-vocab .subtab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeVocabSubtab = btn.dataset.subtab;
      $('yt-vocab-wrap').style.display   = activeVocabSubtab === 'yt-vocab'   ? 'block' : 'none';
      $('line-vocab-wrap').style.display = activeVocabSubtab === 'line-vocab' ? 'block' : 'none';
      loadVocab();
    });
  });

  // 子 Tab：遊戲
  document.querySelectorAll('#tab-games .subtab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#tab-games .subtab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeGameSubtab = btn.dataset.subtab;
      $('game-scores-wrap').style.display    = activeGameSubtab === 'game-scores'    ? 'block' : 'none';
      $('game-questions-wrap').style.display = activeGameSubtab === 'game-questions' ? 'block' : 'none';
      loadGames();
    });
  });

  // 搜尋/篩選
  $('line-search')?.addEventListener('input', renderLineLog);
  $('line-filter-type')?.addEventListener('change', renderLineLog);
  $('vocab-search')?.addEventListener('input', () => activeVocabSubtab === 'yt-vocab' ? renderYtVocab() : renderLineVocab());
  $('vocab-tier')?.addEventListener('change', renderYtVocab);
  $('sched-filter')?.addEventListener('change', renderSchedule);

  // 重整按鈕
  $('overview-refresh')?.addEventListener('click', loadOverview);
  $('line-refresh')?.addEventListener('click', loadLineLog);
  $('vocab-refresh')?.addEventListener('click', loadVocab);
  $('kw-refresh')?.addEventListener('click', loadKeywords);
  $('sched-refresh')?.addEventListener('click', loadSchedule);
  $('mem-refresh')?.addEventListener('click', loadMemory);
  $('game-refresh')?.addEventListener('click', loadGames);

  // 匯出
  $('line-export')?.addEventListener('click', () => exportCsv(
    ['時間','群組','使用者','類型','訊息'],
    lineData.map(m => [fmtDate(m.timestamp), m.groupName||'', m.userName||'', m.msgType||'', m.msgContent||'']),
    `line-log-${new Date().toISOString().slice(0,10)}.csv`
  ));
  $('vocab-export')?.addEventListener('click', () => exportCsv(
    ['單字','中文','等級','例句','次數','加入時間'],
    ytVocabData.map(w => [w.word, w.wordZh, w.tier, w.context, w.count||1, fmtDate(w.addedAt)]),
    `vocab-${new Date().toISOString().slice(0,10)}.csv`
  ));

  // 關鍵字表單
  $('kw-add-btn')?.addEventListener('click', () => { $('kw-add-form').style.display = $('kw-add-form').style.display === 'none' ? 'flex' : 'none'; });
  $('kw-cancel-btn')?.addEventListener('click', () => { $('kw-add-form').style.display = 'none'; });
  $('kw-save-btn')?.addEventListener('click', saveNewKeyword);

  // 記憶表單
  $('mem-add-btn')?.addEventListener('click', () => { $('mem-add-form').style.display = $('mem-add-form').style.display === 'none' ? 'flex' : 'none'; });
  $('mem-cancel-btn')?.addEventListener('click', () => { $('mem-add-form').style.display = 'none'; });
  $('mem-save-btn')?.addEventListener('click', saveNewMemory);

  // 推播 Modal
  $('push-cancel')?.addEventListener('click', () => { $('push-modal').style.display = 'none'; });
  $('push-confirm')?.addEventListener('click', doPush);
  $('push-modal')?.addEventListener('click', e => { if (e.target === $('push-modal')) $('push-modal').style.display = 'none'; });

  // 設定
  $('cfg-save-btn')?.addEventListener('click', saveSettings);
  $('settings-signout-btn')?.addEventListener('click', handleSignOut);

  // 登入按鈕（初始）
  $('vd-auth-btn').addEventListener('click', handleSignIn);
}

// ===== 初始化 =====
(async () => {
  await loadSettings();
  bindEvents();

  // 嘗試恢復登入狀態
  const res = await sendMsg('fb_getUser');
  if (res?.user) {
    _userInfo = res.user;
    _uid      = res.user.uid;
    setAuthUI(res.user);
    // 觸發 background 更新 token，再取回給 dashboard 用
    await sendMsg('fb_getWords');
    const tokenRes = await sendMsg('fb_getIdToken');
    if (tokenRes?.token) _idToken = tokenRes.token;
  } else {
    setAuthUI(null);
  }

  loadTab(activeTab);
})();
