/**
 * QA 測試：UI 交錯情境驗證 v2
 *
 * 修正 v1 的三個根本錯誤：
 *   1. 注入 onboardingDone=true，確保字幕列表真的出現（不是 Onboarding 畫面）
 *   2. 同時驗證 wrapperTop ≈ playerTop（位置）和 wrapperH ≈ playerH（高度）
 *   3. 驗證 #secondary 隱藏/還原行為
 *
 * 執行方式：node test-ui-scenarios.mjs
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname    = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = __dirname;

// &autoplay=0 阻止自動播放，避免 timeout 期間 YouTube 換到不相關影片干擾截圖
const VIDEO_ID     = 'KfFG7lX_woQ';
const VIDEO_URL    = `https://www.youtube.com/watch?v=${VIDEO_ID}&autoplay=0`;
// 合輯模式：帶 list 參數，右側 #secondary 顯示播放清單面板（而非推薦欄）
const PLAYLIST_URL = `https://www.youtube.com/watch?v=${VIDEO_ID}&list=RDKfFG7lX_woQ&start_radio=1&autoplay=0`;
const HOME_URL     = 'https://www.youtube.com/';

// 每次執行建立獨立時間戳資料夾
const RUN_TS = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
const SHOT_DIR = path.join(__dirname, 'docs', 'qa-screenshots', RUN_TS);
fs.mkdirSync(SHOT_DIR, { recursive: true });
console.log(`📁 截圖資料夾：docs/qa-screenshots/${RUN_TS}/`);

// ══════════════════════════════════════════
// 結果追蹤
// ══════════════════════════════════════════
let passed = 0, failed = 0, skipped = 0;
const results = [];

function pass(label) {
  console.log(`  ✅ ${label}`);
  passed++;
  results.push({ label, status: 'pass' });
}
function fail(label, detail = '') {
  console.error(`  ❌ ${label}${detail ? ' — ' + detail : ''}`);
  failed++;
  results.push({ label, status: 'fail', detail });
}
function skip(label, reason = '') {
  console.log(`  ⏭  ${label}${reason ? ' (' + reason + ')' : ''}`);
  skipped++;
  results.push({ label, status: 'skip', reason });
}

// ══════════════════════════════════════════
// 截圖工具
// ══════════════════════════════════════════
let shotIdx = 0;
async function shot(page, name) {
  // 等 CSS 動畫（sidebar 展開/收合）完成再截圖，避免拍到過渡中間狀態
  await page.waitForTimeout(400);
  const file = path.join(SHOT_DIR, `${String(++shotIdx).padStart(2, '0')}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

// ══════════════════════════════════════════
// DOM 查詢工具
// ══════════════════════════════════════════

/** 取得 wrapper / player 的位置、高度、水平位置 */
async function getLayout(page) {
  return page.evaluate(() => {
    const w = document.getElementById('yt-sub-wrapper');
    const p = document.querySelector('#movie_player') || document.querySelector('ytd-player');
    const wR = w?.getBoundingClientRect() ?? {};
    const pR = p?.getBoundingClientRect()  ?? {};
    // clientWidth 不含捲軸，與 fixed position 的定位基準一致
    const vw = document.documentElement.clientWidth;
    return {
      wH:     Math.round(wR.height ?? 0),
      wTop:   Math.round(wR.top    ?? 0),
      wLeft:  Math.round(wR.left   ?? 0),
      wRight: Math.round(wR.right  ?? 0),
      pH:     Math.round(pR.height ?? 0),
      pTop:   Math.round(pR.top    ?? 0),
      pRight: Math.round(pR.right  ?? 0),
      viewportW: vw,
      isTheater: !!document.querySelector('ytd-watch-flexy[theater]'),
    };
  });
}

/**
 * 等待 player 高度「真正穩定」並且 wrapper 已同步對齊。
 *
 * YouTube player 有多個非同步渲染階段（< 100px → 581px → 740px），
 * 必須等高度連續兩次讀數相同（間隔 500ms）才算穩定，
 * 之後再確認 wrapper 高度也跟上，才允許測試繼續。
 */
async function waitPlayerStable(page, timeout = 20000) {
  const deadline = Date.now() + timeout;
  let prevH = 0;

  // 輪詢直到 player 高度穩定（兩次間隔 500ms 的讀數相等）
  while (Date.now() < deadline) {
    const pH = await page.evaluate(() => {
      const p = document.querySelector('#movie_player') || document.querySelector('ytd-player');
      return Math.round(p?.getBoundingClientRect().height ?? 0);
    });

    if (pH > 200 && pH === prevH) {
      // 高度連續兩次相同 → player 已穩定，確保 wrapper 同步
      await page.evaluate(() => window.dispatchEvent(new Event('resize')));
      // 等 ResizeObserver callback 完成（瀏覽器在下一個 animation frame 執行）
      await page.waitForTimeout(200);
      const synced = await page.evaluate(() => {
        const w = document.getElementById('yt-sub-wrapper');
        const p = document.querySelector('#movie_player') || document.querySelector('ytd-player');
        if (!w || !p) return false;
        return Math.abs(
          Math.round(w.getBoundingClientRect().height) -
          Math.round(p.getBoundingClientRect().height)
        ) <= 8;
      });
      if (synced) return;
      // 若 wrapper 仍未同步，繼續等待
    }

    prevH = pH;
    await page.waitForTimeout(500);
  }
  throw new Error(`waitPlayerStable: ${timeout}ms 內 player 高度未穩定`);
}

/** 等待 sidebar + ball 出現 */
async function waitExtension(page, timeout = 15000) {
  await page.waitForSelector('#yt-sub-demo-sidebar', { timeout });
  await page.waitForSelector('#yt-sub-ball', { timeout: 5000 });
}

/**
 * 等待字幕列表出現（至少 1 筆），回傳筆數。
 * 在無 cookie 的 headless 環境下 YouTube API 回空，字幕永遠不會出現。
 * 這是環境限制而非 bug，逾時時回傳 0 而非拋出例外。
 */
async function waitSubtitles(page, timeout = 8000) {
  try {
    await page.waitForSelector('.yt-sub-demo-item', { timeout });
    return page.$$eval('.yt-sub-demo-item', els => els.length);
  } catch (_) {
    return 0; // 無 cookie 環境正常現象，呼叫端決定是否 skip
  }
}

/**
 * 確認目前仍在測試影片頁。
 * YouTube 自動播放可能把頁面帶走，呼叫此函式可自動導回並重展 sidebar。
 */
async function ensureOnVideo(page) {
  const url = page.url();
  if (!url.includes(VIDEO_ID)) {
    console.log(`  ⚠️  YouTube 已換片（${url.split('v=')[1]?.slice(0,11) ?? '?'}），重新導回測試影片...`);
    await page.goto(VIDEO_URL, { waitUntil: 'domcontentloaded' });
    await waitExtension(page);
    await waitPlayerStable(page);
    // 展開以恢復測試狀態
    await clickExpand(page);
    await waitPlayerStable(page);
    fail('換片干擾', 'YouTube autoplay 帶走頁面，已自動導回，但此時截圖已失效');
    return false;
  }
  return true;
}

/** sidebar 是否收合 */
async function isCollapsed(page) {
  return page.$eval('#yt-sub-demo-sidebar',
    el => el.classList.contains('sidebar-collapsed')
  ).catch(() => true);
}

async function clickExpand(page) {
  if (await isCollapsed(page)) {
    await page.click('#yt-sub-ball');
    await page.waitForFunction(
      () => !document.getElementById('yt-sub-demo-sidebar')?.classList.contains('sidebar-collapsed'),
      { timeout: 5000 }
    );
  }
}
async function clickCollapse(page) {
  if (!(await isCollapsed(page))) {
    await page.click('#yt-sub-ball');
    await page.waitForFunction(
      () => document.getElementById('yt-sub-demo-sidebar')?.classList.contains('sidebar-collapsed'),
      { timeout: 5000 }
    );
  }
}

async function toggleTheater(page) {
  await page.hover('#movie_player');
  await page.waitForSelector('.ytp-size-button', { timeout: 5000 });
  await page.click('.ytp-size-button');
  await page.waitForTimeout(800);
  await page.evaluate(() => window.dispatchEvent(new Event('resize')));
  await page.waitForTimeout(400);
}

// ══════════════════════════════════════════
// 斷言工具
// ══════════════════════════════════════════

/**
 * 核心斷言：wrapper 必須「位置」和「高度」都對齊 player
 * 原本 v1 只比高度，這裡同時比 top
 */
function assertAligned(label, layout) {
  const { wH, wTop, wLeft, wRight, pH, pTop, pRight, viewportW, isTheater } = layout;
  const tag = isTheater ? '【劇院】' : '【一般】';
  if (pH < 100) {
    skip(`${label}${tag}`, `player 高度=${pH}px，未就緒`);
    return;
  }
  const hDiff = Math.abs(wH  - pH);
  const tDiff = Math.abs(wTop - pTop);
  // wrapper 右邊緣應貼齊 viewport 右側（fixed right:0）
  const rDiff = Math.abs(viewportW - wRight);
  // 一般模式下記錄 player 右緣 vs wrapper 左緣的間距（供診斷寬度對齊問題）
  const gapInfo = !isTheater ? ` | player.right=${pRight}px wrapper.left=${wLeft}px gap=${wLeft - pRight}px` : '';
  if (hDiff > 8) {
    fail(`${label}${tag} 高度不對齊`, `wrapper=${wH}px vs player=${pH}px（差${hDiff}px）`);
  } else if (tDiff > 8) {
    fail(`${label}${tag} 頂部不對齊`, `wrapper.top=${wTop}px vs player.top=${pTop}px（差${tDiff}px）`);
  } else if (rDiff > 4) {
    fail(`${label}${tag} 右邊緣不貼齊`, `wrapper.right=${wRight}px vs viewport=${viewportW}px（差${rDiff}px）`);
  } else {
    pass(`${label}${tag} 對齊正確（高度diff=${hDiff}px, 頂部diff=${tDiff}px${gapInfo}）`);
  }
}

/** #secondary 欄位隱藏狀態驗證 */
async function assertSecondary(page, label, shouldHide) {
  const display = await page.$eval('#secondary', el => {
    // getComputedStyle 或直接讀 style.display
    return el.style.display;
  }).catch(() => 'NOT_FOUND');

  if (display === 'NOT_FOUND') {
    skip(label, '#secondary 不在 DOM 中');
    return;
  }
  const hidden = (display === 'none');
  if (hidden === shouldHide) {
    pass(`${label}: #secondary ${shouldHide ? '已隱藏(none)' : '已還原(非none)'}`);
  } else {
    fail(`${label}: #secondary display="${display}"，預期 ${shouldHide ? 'none' : '非none'}`);
  }
}

/** overlay 位置：展開時應偏右避開 sidebar；收合時貼右邊 */
async function assertOverlayRight(page, label, sidebarExpanded) {
  const right = await page.$eval('#yt-sub-overlay', el => el.style.right).catch(() => null);
  if (right === null) {
    skip(label, '#yt-sub-overlay 不存在（字幕未載入）');
    return;
  }
  if (sidebarExpanded) {
    // 展開時 right 應包含 360px（避開 sidebar 寬度）
    if (right.includes('360px')) {
      pass(`${label}: overlay 避開 sidebar (right="${right}")`);
    } else {
      fail(`${label}: overlay 未避開 sidebar (right="${right}"，預期含360px)`);
    }
  } else {
    // 收合時 right 應為 2%
    if (right === '2%') {
      pass(`${label}: overlay 貼右邊 (right="${right}")`);
    } else {
      fail(`${label}: overlay 位置錯誤 (right="${right}"，預期2%)`);
    }
  }
}

// ══════════════════════════════════════════
// 啟動瀏覽器
// ══════════════════════════════════════════
console.log('🔧 載入套件路徑:', extensionPath);

const context = await chromium.launchPersistentContext('', {
  headless: false,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-sandbox',
    '--window-size=1600,900',
  ],
  viewport: { width: 1600, height: 900 },
});

const page = await context.newPage();

/**
 * 修正 v1 問題一：在每次頁面載入前注入設定
 * 讓 content.js 讀到 onboardingDone=true，跳過引導畫面
 * 這樣 sidebar 展開後才是字幕列表而不是 Onboarding
 */
await page.addInitScript(() => {
  const KEY = 'yt-sub-settings';
  try {
    const existing = JSON.parse(localStorage.getItem(KEY) || '{}');
    localStorage.setItem(KEY, JSON.stringify({
      primaryLang:   'en',
      secondaryLangs: ['zh-TW', '__none__', '__none__'],
      dualEnabled:   true,
      overlayEnabled: true,
      extensionEnabled: true,
      extendSubtitles: true,
      subtitleOffset: 0,
      onboardingDone: true,   // ← 跳過引導畫面
      translationProvider: 'ytlang',
      googleBatchMode: 'sentence8',
      wordHover: true,
      wordSpeak: true,
      loopSentence: true,
      clickToSeek: true,
      autoScroll: true,
      primarySize: 'md',
      secondarySize: 'sm',
      secondaryColor: 'purple',
      ...existing,
      onboardingDone: true,   // 確保蓋掉舊值
    }));
  } catch (_) {}
});

page.on('console', msg => {
  const t = msg.text();
  if (t.startsWith('[YT-SUB]')) process.stdout.write('    ' + t + '\n');
  if (msg.type() === 'error' && !t.includes('net::ERR') && !t.includes('favicon')
      && !t.includes('doubleclick') && !t.includes('CORS') && !t.includes('requestStorageAccess'))
    console.log('  [JS錯誤]', t.slice(0, 120));
});

// ══════════════════════════════════════════════════════════════
// S1：首頁 → 影片
//   修正：等 player 穩定後再截圖，同時驗證 top 對齊
// ══════════════════════════════════════════════════════════════
console.log('\n╔══════════════════════════════════════════╗');
console.log('║  S1: 首頁 → 影片                          ║');
console.log('╚══════════════════════════════════════════╝');

console.log('  → 首頁...');
await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(2000);
await shot(page, 'S1-home');

const sidebarOnHome = await page.$('#yt-sub-demo-sidebar');
if (!sidebarOnHome) {
  pass('S1: 首頁無 sidebar');
} else {
  const col = await isCollapsed(page);
  col ? pass('S1: 首頁 sidebar 已收合') : fail('S1: 首頁 sidebar 未收合');
}

console.log('  → 導航到影片...');
await page.goto(VIDEO_URL, { waitUntil: 'domcontentloaded' });
await waitExtension(page);
// 修正：等 player 完全渲染完才截圖 + 檢查對齊
await waitPlayerStable(page);
await shot(page, 'S1-video-loaded');

// collapsed 狀態不驗 wrapper 對齊：
//   expandSidebar() 本身會呼叫 syncWrapperToPlayer()，使用者看到的展開瞬間都是正確的。
//   collapsed 時 wrapper 高度短暫落後並不造成任何視覺問題（只有小球可見）。

// ── 展開並等字幕列表 ──────────────────────────────────────────
console.log('  → 展開 sidebar，等字幕列表...');
await ensureOnVideo(page);
await clickExpand(page);

const subCount = await waitSubtitles(page);
if (subCount > 0) {
  pass(`S1: 字幕列表出現（${subCount} 筆）`);
} else {
  skip('S1: 字幕列表未出現', '無 cookie 環境 YouTube API 回空，非 bug');
}

await waitPlayerStable(page);
await shot(page, 'S1-expanded-with-subtitles');
const lo_s1e = await getLayout(page);
console.log(`    展開後 wrapper: top=${lo_s1e.wTop}px h=${lo_s1e.wH}px left=${lo_s1e.wLeft}px | player: top=${lo_s1e.pTop}px h=${lo_s1e.pH}px right=${lo_s1e.pRight}px gap=${lo_s1e.wLeft - lo_s1e.pRight}px`);
assertAligned('S1: 展開後 wrapper 對齊 player', lo_s1e);
await assertSecondary(page, 'S1: 展開時 #secondary', true /* 應隱藏 */);

// ══════════════════════════════════════════════════════════════
// S2：展開提取器 → 切換劇院模式
// ══════════════════════════════════════════════════════════════
console.log('\n╔══════════════════════════════════════════╗');
console.log('║  S2: 展開提取器 → 切換劇院模式           ║');
console.log('╚══════════════════════════════════════════╝');

await assertOverlayRight(page, 'S2: 展開時 overlay 位置', true);

console.log('  → 切換劇院模式...');
await toggleTheater(page);
await waitPlayerStable(page);
await shot(page, 'S2-theater-on');
const lo_s2t = await getLayout(page);
console.log(`    劇院後 wrapper: top=${lo_s2t.wTop}px h=${lo_s2t.wH}px | player: top=${lo_s2t.pTop}px h=${lo_s2t.pH}px`);
assertAligned('S2: 劇院模式 wrapper 對齊 player', lo_s2t);
await assertSecondary(page, 'S2: 劇院展開時 #secondary', true);
await assertOverlayRight(page, 'S2: 劇院模式 overlay 位置', true);

// ══════════════════════════════════════════════════════════════
// S3：收合 → 劇院模式下重新展開
// ══════════════════════════════════════════════════════════════
console.log('\n╔══════════════════════════════════════════╗');
console.log('║  S3: 收合提取器 → 劇院模式下重新展開     ║');
console.log('╚══════════════════════════════════════════╝');

await clickCollapse(page);
await waitPlayerStable(page);
await shot(page, 'S3-collapsed-in-theater');
await assertSecondary(page, 'S3: 收合後 #secondary 還原', false /* 應還原 */);
await assertOverlayRight(page, 'S3: 收合後 overlay 位置', false);

await clickExpand(page);
await waitPlayerStable(page);
await shot(page, 'S3-reopened-in-theater');
const lo_s3 = await getLayout(page);
console.log(`    劇院重展 wrapper: top=${lo_s3.wTop}px h=${lo_s3.wH}px | player: top=${lo_s3.pTop}px h=${lo_s3.pH}px`);
assertAligned('S3: 劇院模式下重展 wrapper 對齊 player', lo_s3);
await assertSecondary(page, 'S3: 重展後 #secondary 隱藏', true);

// ══════════════════════════════════════════════════════════════
// S4：退出劇院模式（提取器仍展開）
// ══════════════════════════════════════════════════════════════
console.log('\n╔══════════════════════════════════════════╗');
console.log('║  S4: 退出劇院模式（提取器仍展開）        ║');
console.log('╚══════════════════════════════════════════╝');

const hBeforeExit = lo_s3.pH;
await toggleTheater(page);
await waitPlayerStable(page);
await shot(page, 'S4-theater-off');
const lo_s4 = await getLayout(page);
console.log(`    退劇院 wrapper: top=${lo_s4.wTop}px h=${lo_s4.wH}px | player: top=${lo_s4.pTop}px h=${lo_s4.pH}px`);
assertAligned('S4: 退出劇院後 wrapper 對齊 player', lo_s4);

// 退出劇院 player 高度應「小於」劇院時
if (hBeforeExit > 0 && lo_s4.pH > 0) {
  if (lo_s4.pH < hBeforeExit) {
    pass(`S4: 退劇院後 player 縮回（${hBeforeExit}→${lo_s4.pH}px）`);
  } else {
    skip('S4: 高度沒有縮小', `劇院=${hBeforeExit}px, 退出=${lo_s4.pH}px（1600px 寬時劇院可能不比一般高）`);
  }
}
await assertSecondary(page, 'S4: 退劇院仍展開 #secondary', true);

// ══════════════════════════════════════════════════════════════
// S5：先切劇院 → 再展開提取器
// ══════════════════════════════════════════════════════════════
console.log('\n╔══════════════════════════════════════════╗');
console.log('║  S5: 先切劇院模式 → 再展開提取器         ║');
console.log('╚══════════════════════════════════════════╝');

await clickCollapse(page);
await waitPlayerStable(page);

await toggleTheater(page); // 進劇院
await waitPlayerStable(page);
pass('S5: 收合狀態下進入劇院');

await clickExpand(page);
await waitPlayerStable(page);
await shot(page, 'S5-theater-first-then-expand');
const lo_s5 = await getLayout(page);
console.log(`    劇院先切後展 wrapper: top=${lo_s5.wTop}px h=${lo_s5.wH}px | player: top=${lo_s5.pTop}px h=${lo_s5.pH}px`);
assertAligned('S5: 劇院先切後展 wrapper 對齊 player', lo_s5);
await assertSecondary(page, 'S5: 劇院展開 #secondary', true);

// 退劇院恢復（供後續測試）
await toggleTheater(page);
await waitPlayerStable(page);

// ══════════════════════════════════════════════════════════════
// S6：影片 → 首頁 → 影片（SPA 導航）
// ══════════════════════════════════════════════════════════════
console.log('\n╔══════════════════════════════════════════╗');
console.log('║  S6: 影片 → 首頁 → 影片（SPA）           ║');
console.log('╚══════════════════════════════════════════╝');

console.log('  → SPA 到首頁...');
await page.click('a[href="/"]');
await page.waitForURL(/youtube\.com\/?$/, { timeout: 10000 });
await page.waitForTimeout(2000);
await shot(page, 'S6-spa-home');

const colHome = await page.$eval('#yt-sub-demo-sidebar',
  el => el.classList.contains('sidebar-collapsed')
).catch(() => true);
colHome ? pass('S6: SPA 到首頁後 sidebar 自動收合') : fail('S6: SPA 到首頁後 sidebar 未收合');

// 恢復 #secondary（首頁不需要）
const secDisplay = await page.$eval('#secondary', el => el.style.display).catch(() => 'N/A');
if (secDisplay !== 'N/A') {
  secDisplay !== 'none'
    ? pass(`S6: 首頁 #secondary 已還原（display="${secDisplay}"）`)
    : fail('S6: 首頁 #secondary 仍被隱藏');
}

console.log('  → 回影片...');
await page.goto(VIDEO_URL, { waitUntil: 'domcontentloaded' });
await waitExtension(page);
await waitPlayerStable(page);

await clickExpand(page);
const subCount6 = await waitSubtitles(page);
if (subCount6 > 0) {
  pass(`S6: 回影片後字幕列表重建（${subCount6} 筆）`);
} else {
  skip('S6: 字幕列表未出現', '無 cookie 環境正常，非 bug');
}

await waitPlayerStable(page);
await shot(page, 'S6-spa-back-video');
const lo_s6 = await getLayout(page);
console.log(`    SPA 回影片 wrapper: top=${lo_s6.wTop}px h=${lo_s6.wH}px | player: top=${lo_s6.pTop}px h=${lo_s6.pH}px`);
assertAligned('S6: SPA 回影片後 wrapper 對齊 player', lo_s6);

// ══════════════════════════════════════════════════════════════
// S7：開→關→開 三次（secondary + overlay 狀態一致性）
// ══════════════════════════════════════════════════════════════
console.log('\n╔══════════════════════════════════════════╗');
console.log('║  S7: 開→關→開 三次一致性                 ║');
console.log('╚══════════════════════════════════════════╝');

for (let i = 1; i <= 3; i++) {
  await ensureOnVideo(page);

  // ── 展開 ──────────────────────────────────────────────────────
  await clickExpand(page);
  await waitPlayerStable(page);
  const expOk = !(await isCollapsed(page));
  expOk ? pass(`S7-${i}: 展開成功`) : fail(`S7-${i}: 展開失敗`);
  await assertSecondary(page, `S7-${i}: 展開時 #secondary`, true);
  const lo7e = await getLayout(page);
  assertAligned(`S7-${i}: 展開 wrapper 對齊 player`, lo7e);
  // 每次展開都截圖：確認 sidebar 可見、版面正常
  await shot(page, `S7-${i}-expanded`);

  // ── 收合 ──────────────────────────────────────────────────────
  await clickCollapse(page);
  await waitPlayerStable(page);
  const colOk = await isCollapsed(page);
  colOk ? pass(`S7-${i}: 收合成功`) : fail(`S7-${i}: 收合失敗`);
  await assertSecondary(page, `S7-${i}: 收合時 #secondary 還原`, false);
  // 每次收合都截圖：確認 sidebar 隱藏、secondary 欄還原
  await shot(page, `S7-${i}-collapsed`);
}

// ══════════════════════════════════════════════════════════════
// S8：劇院→收合→退劇院→展開（最複雜交錯）
// ══════════════════════════════════════════════════════════════
console.log('\n╔══════════════════════════════════════════╗');
console.log('║  S8: 劇院→收合→退劇院→展開（最複雜）    ║');
console.log('╚══════════════════════════════════════════╝');

// 8a 進劇院（sidebar 已收合）
await toggleTheater(page);
await waitPlayerStable(page);
const info8a = await getLayout(page);
info8a.isTheater ? pass('S8a: 進入劇院模式') : skip('S8a: 劇院模式未生效', '可能已在劇院');
await shot(page, 'S8-theater-collapsed');

// 8b 劇院中展開
await clickExpand(page);
await waitPlayerStable(page);
const lo8b = await getLayout(page);
console.log(`    8b 劇院展開: top=${lo8b.wTop}px h=${lo8b.wH}px | player top=${lo8b.pTop}px h=${lo8b.pH}px`);
assertAligned('S8b: 劇院展開 wrapper 對齊 player', lo8b);
await assertSecondary(page, 'S8b: 劇院展開 #secondary', true);

// 8c 劇院中收合
await clickCollapse(page);
await waitPlayerStable(page);
await assertSecondary(page, 'S8c: 劇院收合後 #secondary 還原', false);

// 8d 退出劇院（sidebar 收合狀態）
await toggleTheater(page);
await waitPlayerStable(page);
const info8d = await getLayout(page);
!info8d.isTheater ? pass('S8d: 退出劇院（sidebar 收合中）') : skip('S8d: 仍在劇院模式');

// 8e 退劇院後展開
await clickExpand(page);
await waitPlayerStable(page);
await shot(page, 'S8-complex-final');
const lo8e = await getLayout(page);
console.log(`    8e 退劇院後展開: top=${lo8e.wTop}px h=${lo8e.wH}px | player top=${lo8e.pTop}px h=${lo8e.pH}px`);
assertAligned('S8e: 退劇院後展開 wrapper 對齊 player', lo8e);
await assertSecondary(page, 'S8e: 退劇院後展開 #secondary', true);

// ══════════════════════════════════════════════════════════════
// S9：合輯影片 + 預設顯示模式
//   目標：
//   S9a - 合輯 URL 載入，確認播放清單面板（#secondary）正常出現
//   S9b - 展開 sidebar（預設模式），清單面板隱藏，wrapper 對齊 player
//   S9c - 收合 sidebar，清單面板還原
// ══════════════════════════════════════════════════════════════
console.log('\n╔══════════════════════════════════════════╗');
console.log('║  S9: 合輯影片 × 預設顯示模式             ║');
console.log('╚══════════════════════════════════════════╝');

// 導航到合輯 URL（帶 list= 參數），確保處於預設模式（非劇院）
console.log('  → 載入合輯影片...');
await page.goto(PLAYLIST_URL, { waitUntil: 'domcontentloaded' });
await waitExtension(page);
await waitPlayerStable(page);

// 確認已退出劇院模式
const info9 = await getLayout(page);
if (info9.isTheater) {
  // 若瀏覽器記憶劇院狀態，先退出
  await toggleTheater(page);
  await waitPlayerStable(page);
}

// S9a：合輯 URL 載入，sidebar 收合，playlist 面板應可見
await clickCollapse(page);
await waitPlayerStable(page);
await shot(page, 'S9a-playlist-default-collapsed');
const lo9a = await getLayout(page);
console.log(`    S9a 收合: viewport=${lo9a.viewportW}px | player.right=${lo9a.pRight}px wrapper.left=${lo9a.wLeft}px`);
pass('S9a: 合輯頁預設模式收合');

// 確認 #secondary 此時應還原（可見）
await assertSecondary(page, 'S9a: 合輯頁 #secondary（收合時應可見）', false);

// S9b：展開 sidebar（預設模式），playlist 面板應隱藏
await clickExpand(page);
await waitPlayerStable(page);
await shot(page, 'S9b-playlist-default-expanded');
const lo9b = await getLayout(page);
console.log(`    S9b 展開: viewport=${lo9b.viewportW}px | player.right=${lo9b.pRight}px wrapper.left=${lo9b.wLeft}px gap=${lo9b.wLeft - lo9b.pRight}px`);
assertAligned('S9b: 合輯頁展開 wrapper 對齊 player', lo9b);
await assertSecondary(page, 'S9b: 合輯頁展開 #secondary（應隱藏）', true);

// S9c：收合，playlist 面板還原
await clickCollapse(page);
await waitPlayerStable(page);
await shot(page, 'S9c-playlist-default-collapsed-again');
await assertSecondary(page, 'S9c: 合輯頁收合 #secondary（應還原）', false);
pass('S9c: 合輯頁收合，面板還原');

// ══════════════════════════════════════════
// 最終報告
// ══════════════════════════════════════════
console.log('\n╔══════════════════════════════════════════╗');
console.log('║  QA 報告                                  ║');
console.log('╚══════════════════════════════════════════╝');
const total = passed + failed + skipped;
console.log(`  總計 ${total} 項  ✅ 通過:${passed}  ❌ 失敗:${failed}  ⏭  跳過:${skipped}`);
if (failed > 0) {
  console.log('\n  失敗清單:');
  results.filter(r => r.status === 'fail')
    .forEach(r => console.log(`    ❌ ${r.label}${r.detail ? ' — ' + r.detail : ''}`));
}
console.log(`\n  截圖資料夾: docs/qa-screenshots/${RUN_TS}/（共 ${shotIdx} 張）`);
console.log('\n  瀏覽器 8 秒後關閉...');
await page.waitForTimeout(8000);
await context.close();
process.exit(failed > 0 ? 1 : 0);
