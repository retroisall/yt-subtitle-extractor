// 快速 debug T3 popup 偵測
import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_PATH = path.resolve(__dirname, '..');

const ctx = await chromium.launchPersistentContext('', {
  headless: false,
  args: [
    '--no-sandbox',
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
  ],
});

const page = await ctx.newPage();
await page.goto('https://www.youtube.com/watch?v=jNQXAC9IVRw', { waitUntil: 'domcontentloaded', timeout: 30000 });
await new Promise(r => setTimeout(r, 5000));

// 1. 確認 wrapper 和 popup container 存在
const domInfo = await page.evaluate(() => {
  const wrapper = document.getElementById('yt-sub-wrapper');
  const popup = document.querySelector('ytd-popup-container');
  return {
    hasWrapper: !!wrapper,
    hasPopup: !!popup,
    wrapperZIndex: wrapper ? (wrapper.style.zIndex || getComputedStyle(wrapper).zIndex) : 'N/A',
    popupChildCount: popup ? popup.children.length : 0,
    popupChildren: popup ? Array.from(popup.children).slice(0,5).map(el => el.tagName + '#' + el.id + ' aria-hidden=' + el.getAttribute('aria-hidden')) : [],
  };
});
console.log('DOM 狀態:', JSON.stringify(domInfo, null, 2));

// 2. 模擬加入 tp-yt-iron-dropdown 後看 wrapper zIndex
const result = await page.evaluate(() => {
  const wrapper = document.getElementById('yt-sub-wrapper');
  const popup = document.querySelector('ytd-popup-container');
  if (!wrapper || !popup) return { error: 'missing element' };

  const zBefore = wrapper.style.zIndex;
  
  const fakeDropdown = document.createElement('tp-yt-iron-dropdown');
  fakeDropdown.setAttribute('aria-hidden', 'false');
  fakeDropdown.style.cssText = 'display:block; height:200px; width:200px; position:fixed; top:60px; right:0; background:red; z-index:99999;';
  popup.appendChild(fakeDropdown);

  return new Promise(resolve => {
    setTimeout(() => {
      const zAfter = wrapper.style.zIndex;
      // 測試直接查詢是否能找到元素
      const found = popup.querySelector('tp-yt-iron-dropdown:not([aria-hidden="true"])');
      fakeDropdown.remove();
      setTimeout(() => {
        const zRestored = wrapper.style.zIndex;
        resolve({ zBefore, zAfter, zRestored, foundInSelector: !!found });
      }, 300);
    }, 500); // 等更長時間
  });
});

console.log('T3 結果:', JSON.stringify(result, null, 2));

await new Promise(r => setTimeout(r, 2000));
await ctx.close();
