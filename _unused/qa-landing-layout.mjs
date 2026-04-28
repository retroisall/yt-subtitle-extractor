/**
 * QA 腳本：landing.html 版面檢查
 * 檢查項目：
 *   1. journey-section padding-bottom 是否為 140px
 *   2. journey-section 底部到 loop-section 頂部的像素距離
 *   3. 整體頁面截圖（Hero 到 #contribute）
 */

import { chromium } from 'playwright';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE_DIR = 'd:/dev/chrome字幕套件開發';
const FILE_URL = `file:///d:/dev/chrome字幕套件開發/landing.html`;
const PROFILE_DIR = path.join(BASE_DIR, '.playwright-profile-qa-landing');
const SCREENSHOT_DIR = path.join(BASE_DIR, 'qa-screenshots');

// 確保截圖目錄存在
import { mkdirSync } from 'fs';
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const browser = await chromium.launchPersistentContext(PROFILE_DIR, {
  headless: true,
  viewport: { width: 1440, height: 900 },
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

const page = await browser.newPage();

console.log('開啟 landing.html...');
await page.goto(FILE_URL, { waitUntil: 'networkidle' });
await page.waitForTimeout(500);

// ────────────────────────────────────────────────
// 1. 量測 journey-section padding-bottom 與間距
// ────────────────────────────────────────────────
const layoutData = await page.evaluate(() => {
  // journey-section computed style
  const journey = document.querySelector('.journey-section');
  const loopSection = document.querySelector('#contribute') || document.querySelector('.loop-section');

  const journeyStyle = journey ? window.getComputedStyle(journey) : null;
  const journeyRect  = journey ? journey.getBoundingClientRect() : null;
  const loopRect     = loopSection ? loopSection.getBoundingClientRect() : null;

  // 生字本 demo 卡片底部
  const vocabCard = document.querySelector('.demo-card') || document.querySelector('.vocab-card');
  const vocabRect = vocabCard ? vocabCard.getBoundingClientRect() : null;

  // 計算距離：journey 底部（含 padding）到 loop 頂部
  const journeyBottom = journeyRect ? journeyRect.bottom + window.scrollY : null;
  const loopTop       = loopRect    ? loopRect.top    + window.scrollY : null;
  const gap = (journeyBottom !== null && loopTop !== null) ? loopTop - journeyBottom : null;

  // 取得頁面總高度
  const totalHeight = document.documentElement.scrollHeight;

  return {
    journeyPaddingBottom: journeyStyle ? journeyStyle.paddingBottom : 'N/A',
    journeyRect: journeyRect ? {
      top:    Math.round(journeyRect.top    + window.scrollY),
      bottom: Math.round(journeyRect.bottom + window.scrollY),
      height: Math.round(journeyRect.height),
    } : null,
    loopSectionSelector: loopSection ? (loopSection.id || loopSection.className) : 'NOT FOUND',
    loopRect: loopRect ? {
      top:    Math.round(loopRect.top    + window.scrollY),
      bottom: Math.round(loopRect.bottom + window.scrollY),
    } : null,
    gap: gap !== null ? Math.round(gap) : 'N/A',
    vocabCardRect: vocabRect ? {
      bottom: Math.round(vocabRect.bottom + window.scrollY),
    } : null,
    totalHeight,
    // 額外：列出所有主要 section
    sections: Array.from(document.querySelectorAll('section, [id]')).map(el => ({
      tag: el.tagName,
      id: el.id || '',
      cls: el.className.substring(0, 60),
      top:    Math.round(el.getBoundingClientRect().top + window.scrollY),
      bottom: Math.round(el.getBoundingClientRect().bottom + window.scrollY),
    })),
  };
});

console.log('\n===== 版面量測結果 =====');
console.log(`journey-section padding-bottom：${layoutData.journeyPaddingBottom}`);
console.log(`journey-section 頂部：${layoutData.journeyRect?.top}px`);
console.log(`journey-section 底部：${layoutData.journeyRect?.bottom}px`);
console.log(`loop/contribute section 識別：${layoutData.loopSectionSelector}`);
console.log(`loop/contribute section 頂部：${layoutData.loopRect?.top}px`);
console.log(`journey底部 → loop頂部 間距：${layoutData.gap}px`);
console.log(`總頁面高度：${layoutData.totalHeight}px`);
console.log('\n--- 所有主要 section ---');
for (const s of layoutData.sections) {
  console.log(`  [${s.tag}#${s.id}] ${s.cls.trim()} | top:${s.top} bottom:${s.bottom}`);
}

// ────────────────────────────────────────────────
// 2. 截圖：journey-section 底部區域（局部放大）
// ────────────────────────────────────────────────
// 截圖 1：journey 底部往上 300px 到 loop section 往下 200px（捲動到對應位置後截 viewport）
if (layoutData.journeyRect && layoutData.loopRect) {
  // 直接捲動到 journey 底部附近，截 viewport 截圖
  const scrollTo = Math.max(0, layoutData.journeyRect.bottom - 500);
  await page.evaluate((y) => window.scrollTo(0, y), scrollTo);
  await page.waitForTimeout(400);
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, '01-journey-to-loop-gap.png'),
    fullPage: false,
  });
  console.log('\n截圖 1 儲存：qa-screenshots/01-journey-to-loop-gap.png');
}

// ────────────────────────────────────────────────
// 3. 整體頁面截圖（全頁）
// ────────────────────────────────────────────────
await page.evaluate(() => window.scrollTo(0, 0));
await page.waitForTimeout(300);
await page.screenshot({
  path: path.join(SCREENSHOT_DIR, '02-full-page.png'),
  fullPage: true,
});
console.log('截圖 2 儲存：qa-screenshots/02-full-page.png');

// ────────────────────────────────────────────────
// 4. 截圖：Hero + 第一個 section 分隔
// ────────────────────────────────────────────────
await page.screenshot({
  path: path.join(SCREENSHOT_DIR, '03-hero-viewport.png'),
  fullPage: false,
});
console.log('截圖 3 儲存：qa-screenshots/03-hero-viewport.png');

// ────────────────────────────────────────────────
// 5. 針對 journey-section 截全圖
// ────────────────────────────────────────────────
// 截圖 4：捲到 journey section 頂部，截 viewport 截圖
if (layoutData.journeyRect) {
  const jTop = layoutData.journeyRect.top;
  await page.evaluate((y) => window.scrollTo(0, Math.max(0, y - 80)), jTop);
  await page.waitForTimeout(300);
  await page.screenshot({
    path: path.join(SCREENSHOT_DIR, '04-journey-section-top.png'),
    fullPage: false,
  });
  console.log('截圖 4 儲存：qa-screenshots/04-journey-section-top.png');
}

await browser.close();
console.log('\n===== QA 執行完畢 =====');
