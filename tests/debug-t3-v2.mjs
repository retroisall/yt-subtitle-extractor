import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..');

const ctx = await chromium.launchPersistentContext('', {
  headless: false,
  args: ['--no-sandbox', `--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`],
});

const page = await ctx.newPage();
await page.goto('https://www.youtube.com/watch?v=jNQXAC9IVRw', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise(r => setTimeout(r, 5000));

// 1. 查頁面上有多少 tp-yt-iron-dropdown
const existing = await page.evaluate(() => {
  const els = document.querySelectorAll('tp-yt-iron-dropdown, iron-dropdown');
  return els.length + ' 個，aria-hidden: ' + Array.from(els).map(e => e.getAttribute('aria-hidden')).join(',');
});
console.log('現有 dropdown:', existing);

// 2. 直接測試 setInterval 能否偵測到頁面 JS 加入的元素
const result = await page.evaluate(() => {
  const wrapper = document.getElementById('yt-sub-wrapper');
  if (!wrapper) return { error: 'no wrapper' };
  
  const zBefore = wrapper.style.zIndex;
  
  // 直接改 wrapper z-index 測試「頁面 JS 能否改」
  wrapper.style.zIndex = '5000';
  const directSet = wrapper.style.zIndex;
  wrapper.style.zIndex = zBefore; // reset
  
  // 試試在頁面 context 觸發一個 CustomEvent 讓 content script 監聽
  document.dispatchEvent(new CustomEvent('yt-sub-test-popup-open'));
  
  return new Promise(resolve => {
    setTimeout(() => {
      const zAfter = wrapper.style.zIndex;
      document.dispatchEvent(new CustomEvent('yt-sub-test-popup-close'));
      setTimeout(() => {
        resolve({ zBefore, directSet, zAfter });
      }, 400);
    }, 500);
  });
});

console.log('結果:', JSON.stringify(result));
await new Promise(r => setTimeout(r, 1000));
await ctx.close();
