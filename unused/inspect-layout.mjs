// inspect-layout.mjs — 研究 YouTube RWD 版面，找出 sidebar push 的正確計算方式
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const extensionPath = __dirname;
const testVideoId = 'jNQXAC9IVRw';

const context = await chromium.launchPersistentContext('', {
  headless: false,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--no-sandbox',
  ],
});

const page = await context.newPage();
page.on('console', msg => {
  if (msg.text().includes('[YT-SUB]')) console.log('[ext]', msg.text());
});

await page.goto(`https://www.youtube.com/watch?v=${testVideoId}`, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);

// 在多個視窗寬度下量測 YouTube 版面的關鍵元素
const WIDTHS = [1280, 1440, 1600, 1920];
const SIDEBAR_W = 360;

async function measureLayout(width) {
  await page.setViewportSize({ width, height: 800 });
  await page.waitForTimeout(500); // 等 RWD reflow

  return await page.evaluate(() => {
    const sel = s => document.querySelector(s);
    const rect = el => el ? el.getBoundingClientRect() : null;

    const playerRect   = rect(sel('#movie_player') || sel('ytd-player'));
    const primaryRect  = rect(sel('#primary'));
    const secondaryRect= rect(sel('#secondary'));
    const columnsRect  = rect(sel('#columns'));
    const appRect      = rect(sel('ytd-app'));

    const get = (r, k) => r ? Math.round(r[k]) : null;

    return {
      viewport:        window.innerWidth,
      app:             appRect ? { w: get(appRect,'width'), left: get(appRect,'left') } : null,
      columns:         columnsRect ? { w: get(columnsRect,'width'), left: get(columnsRect,'left'), right: get(columnsRect,'right') } : null,
      primary:         primaryRect  ? { w: get(primaryRect,'width'),  left: get(primaryRect,'left'),  right: get(primaryRect,'right') } : null,
      secondary:       secondaryRect? { w: get(secondaryRect,'width'), left: get(secondaryRect,'left'), right: get(secondaryRect,'right') } : null,
      player:          playerRect   ? { w: get(playerRect,'width'),   h: get(playerRect,'height'), left: get(playerRect,'left'), right: get(playerRect,'right'), top: get(playerRect,'top') } : null,
      // 如果 secondary 存在：sidebar 應覆蓋 secondary 的位置
      // 計算 sidebar 左邊緣對應的 primary 右邊緣需要縮減多少
      sidebarLeftEdge: window.innerWidth - 360,
      primaryRightGap: primaryRect ? Math.max(0, window.innerWidth - primaryRect.right) : null,
    };
  });
}

console.log('\n=== YouTube 版面量測（無 push）===\n');
const results = [];
for (const w of WIDTHS) {
  const m = await measureLayout(w);
  results.push(m);
  console.log(`視窗 ${w}px:`);
  console.log(`  player:    w=${m.player?.w}  right=${m.player?.right}  top=${m.player?.top}`);
  console.log(`  primary:   w=${m.primary?.w}  right=${m.primary?.right}`);
  console.log(`  secondary: w=${m.secondary?.w}  left=${m.secondary?.left}`);
  console.log(`  sidebar 左緣=${m.sidebarLeftEdge}  primary 右側空間=${m.primaryRightGap}`);
  console.log(`  → secondary 左緣超出 sidebar 左緣: ${m.secondary ? m.secondary.left - m.sidebarLeftEdge : 'N/A'} px`);
  console.log('');
}

// 模擬加 margin-right: 360px 後重測
console.log('\n=== 加 margin-right: 360px 後重測 ===\n');
await page.evaluate(() => {
  const app = document.querySelector('ytd-app');
  if (app) app.style.setProperty('margin-right', '360px', 'important');
});
await page.waitForTimeout(500);

for (const w of WIDTHS) {
  const m = await measureLayout(w);
  console.log(`視窗 ${w}px（push 後）:`);
  console.log(`  player:    w=${m.player?.w}  right=${m.player?.right}`);
  console.log(`  primary:   w=${m.primary?.w}  right=${m.primary?.right}`);
  console.log(`  secondary: w=${m.secondary?.w}  left=${m.secondary?.left}`);
  console.log('');
}

// 還原
await page.evaluate(() => {
  document.querySelector('ytd-app')?.style.removeProperty('margin-right');
});

console.log('\n研究完成，保持視窗開啟 30 秒供手動觀察...');
await page.waitForTimeout(30000);
await context.close();
