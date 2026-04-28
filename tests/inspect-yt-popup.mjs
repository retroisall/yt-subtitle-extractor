import { chromium } from 'playwright';
const ctx = await chromium.launchPersistentContext('', {
  headless: false,
  args: ['--no-sandbox']
});
const page = await ctx.newPage();
await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded', timeout: 20000 });
await new Promise(r => setTimeout(r, 3000));

// 點擊通知鈴鐺
const bell = await page.$('ytd-notification-topbar-button-renderer button, #notification-button button, button[aria-label*="通知"], button[aria-label*="Notification"]');
if (bell) {
  await bell.click();
  await new Promise(r => setTimeout(r, 1500));

  const info = await page.evaluate(() => {
    const popup = document.querySelector('ytd-popup-container');
    if (!popup) return { noPopup: true };
    const children = Array.from(popup.children).map(el => ({
      tag: el.tagName,
      id: el.id,
      classes: el.className.slice(0, 80),
      display: getComputedStyle(el).display,
      ariaHidden: el.getAttribute('aria-hidden'),
      opened: el.hasAttribute('opened'),
      style: (el.getAttribute('style') || '').slice(0, 120),
      innerTags: Array.from(el.children).slice(0, 3).map(c => c.tagName + (c.id ? '#'+c.id : '')),
    }));
    // 也找找 iron-dropdown
    const irons = Array.from(document.querySelectorAll('iron-dropdown, tp-yt-iron-dropdown')).map(el => ({
      tag: el.tagName, ariaHidden: el.getAttribute('aria-hidden'), opened: el.hasAttribute('opened'),
      style: (el.getAttribute('style') || '').slice(0, 100),
    }));
    return { children, irons };
  });
  console.log(JSON.stringify(info, null, 2));
} else {
  console.log('找不到通知按鈕，抓一下可用按鈕:');
  const btns = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button')).slice(0, 20).map(b => ({
      label: b.getAttribute('aria-label'), id: b.id, class: b.className.slice(0,40)
    }))
  );
  console.log(JSON.stringify(btns, null, 2));
}
await new Promise(r => setTimeout(r, 2000));
await ctx.close();
