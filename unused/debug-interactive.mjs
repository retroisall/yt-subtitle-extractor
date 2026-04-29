/**
 * debug-interactive.mjs
 * 開啟帶套件的 Chrome，自動偵測 sidebar 展開，抓 DOM 快照
 * 不需要按 Enter，sidebar 展開就自動觸發
 */
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname     = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = __dirname;

const VIDEO_ID   = 'KfFG7lX_woQ';
const VIDEO_URL  = `https://www.youtube.com/watch?v=${VIDEO_ID}&list=RDKfFG7lX_woQ&start_radio=1&autoplay=0`;

// ── 啟動 ────────────────────────────────────────────────────
console.log('🚀 啟動 Chrome（帶套件）...');
const ctx = await chromium.launchPersistentContext('', {
  headless: false,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-sandbox',
    '--start-maximized',
  ],
  viewport: null, // 跟隨視窗實際大小
});

const page = await ctx.newPage();
page.on('console', msg => {
  const t = msg.text();
  if (t.includes('[YT-SUB]')) console.log('[ext]', t);
});

await page.goto(VIDEO_URL, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);

console.log('✅ 瀏覽器已開啟');
console.log('👉 請在瀏覽器中展開 sidebar，系統會自動偵測並抓快照（每 2 秒檢查一次）\n');

// ── DOM 快照函式 ───────────────────────────────────────────
async function captureSnapshot(label) {
  const snap = await page.evaluate(() => {
    const sel   = s => document.querySelector(s);
    const rect  = el => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height),
               top: Math.round(r.top), left: Math.round(r.left),
               right: Math.round(r.right), bottom: Math.round(r.bottom) };
    };
    const cs = (el, prop) => el ? getComputedStyle(el).getPropertyValue(prop).trim() : null;
    const is = (el, prop) => el?.style?.getPropertyValue(prop) ?? null;

    const app       = sel('ytd-app');
    const columns   = sel('#columns');
    const primary   = sel('#primary');
    const secondary = sel('#secondary');
    const player    = sel('#movie_player') || sel('ytd-player');
    const wrapper   = sel('#yt-sub-wrapper');
    const flexy     = sel('ytd-watch-flexy');

    return {
      viewport: {
        innerW:  window.innerWidth,
        clientW: document.documentElement.clientWidth,
      },
      isTheater: !!flexy?.hasAttribute('theater'),
      ytdApp: {
        rect:            rect(app),
        computedMarginR: cs(app, 'margin-right'),
        inlineMarginR:   is(app, 'margin-right'),
      },
      primary: { rect: rect(primary) },
      secondary: {
        rect:    rect(secondary),
        display: cs(secondary, 'display'),
      },
      player: { rect: rect(player) },
      wrapper: {
        exists:        !!wrapper,
        rect:          rect(wrapper),
        computedPos:   cs(wrapper, 'position'),
        computedRight: cs(wrapper, 'right'),
        computedWidth: cs(wrapper, 'width'),
        display:       cs(wrapper, 'display'),
      },
    };
  });

  console.log('\n' + '='.repeat(60));
  console.log(`📸 快照觸發：${label}`);
  console.log('='.repeat(60));
  console.log(`📐 視窗  innerW=${snap.viewport.innerW}  clientW=${snap.viewport.clientW}`);
  console.log(`   劇院模式=${snap.isTheater}`);

  console.log('\n🗂  ytd-app');
  console.log(`   rect:            ${JSON.stringify(snap.ytdApp.rect)}`);
  console.log(`   computedMarginR: ${snap.ytdApp.computedMarginR}`);
  console.log(`   inlineMarginR:   "${snap.ytdApp.inlineMarginR}"`);

  console.log('\n📦 #primary');
  console.log(`   rect: ${JSON.stringify(snap.primary.rect)}`);

  console.log('\n📦 #secondary');
  console.log(`   rect:    ${JSON.stringify(snap.secondary.rect)}`);
  console.log(`   display: ${snap.secondary.display}`);

  console.log('\n🎬 player');
  console.log(`   rect: ${JSON.stringify(snap.player.rect)}`);

  console.log('\n📋 #yt-sub-wrapper');
  console.log(`   exists:  ${snap.wrapper.exists}`);
  console.log(`   display: ${snap.wrapper.display}`);
  console.log(`   rect:    ${JSON.stringify(snap.wrapper.rect)}`);
  console.log(`   pos:     ${snap.wrapper.computedPos}  right:${snap.wrapper.computedRight}  width:${snap.wrapper.computedWidth}`);

  if (snap.player.rect && snap.wrapper.rect) {
    const overlap = snap.player.rect.right - snap.wrapper.rect.left;
    const gap     = snap.wrapper.rect.left - snap.player.rect.right;
    console.log('\n🔎 關鍵診斷');
    console.log(`   player.right = ${snap.player.rect.right}px`);
    console.log(`   wrapper.left = ${snap.wrapper.rect.left}px`);
    if (overlap > 0) {
      console.log(`   ❌ sidebar 遮住影片 ${overlap}px（push 模式無效）`);
    } else {
      console.log(`   ✅ 無遮擋，gap = ${gap}px`);
    }
    const expectedMargin = snap.ytdApp.computedMarginR;
    console.log(`   ytd-app margin-right = ${expectedMargin}`);
  }
  console.log('='.repeat(60) + '\n');

  return snap;
}

// ── 輪詢：sidebar 展開就抓快照 ──────────────────────────────
let lastState = 'collapsed';
let snapCount = 0;

async function poll() {
  try {
    const state = await page.evaluate(() => {
      const w = document.querySelector('#yt-sub-wrapper');
      if (!w) return 'no-wrapper';
      const d = getComputedStyle(w).display;
      if (d === 'none') return 'collapsed';
      const r = w.getBoundingClientRect();
      return r.width > 100 ? 'expanded' : 'collapsed';
    });

    if (state === 'expanded' && lastState !== 'expanded') {
      snapCount++;
      await captureSnapshot(`sidebar 展開（第 ${snapCount} 次）`);
    }
    if (state !== 'expanded' && lastState === 'expanded') {
      console.log('ℹ️  sidebar 已收合');
    }
    lastState = state;
  } catch (e) {
    // page 可能正在導航，忽略
  }
}

// 每 2 秒輪詢一次
const timer = setInterval(poll, 2000);

console.log('⏱  每 2 秒自動偵測 sidebar 狀態，Ctrl+C 關閉\n');

// 保持開啟
await new Promise(() => {});
