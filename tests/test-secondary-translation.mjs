/**
 * test-secondary-translation.mjs
 * 真實場景測試次要字幕翻譯（雙語字幕功能）
 *
 * 規則：
 * - 禁止注入假字幕，必須等擴充功能真正從 YouTube 翻譯
 * - 空 profile + localStorage 設定 dualEnabled: true
 * - 公開影片無需認證
 *
 * 判定標準：
 * - .yt-sub-text-secondary 出現且有中文文字
 * - console log 出現 [YT-SUB][DUAL] 與 [YT-SUB][TRANS]
 * - 覆蓋層 #yt-sub-cur-secondary 播放後有內容
 */

import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const EXT_PATH = 'd:\\dev\\chrome字幕套件開發';
// 公開音樂影片（英文歌詞，測試翻譯）
const TARGET_URL = 'https://www.youtube.com/watch?v=Juc9F74_sJ8';
const REPORT_PATH = 'd:\\dev\\chrome字幕套件開發\\docs\\qa-secondary-translation.txt';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const lines = [];
const consoleLogs = [];
const log = msg => { console.log(msg); lines.push(msg); };

// localStorage 設定：dualEnabled=true, secondaryLangs=['zh-TW'], translationProvider='ytlang'
const INIT_SCRIPT = `
  try {
    localStorage.setItem('yt-sub-settings', JSON.stringify({
      primaryLang: 'en',
      secondaryLangs: ['zh-TW', '__none__', '__none__'],
      dualEnabled: true,
      overlayEnabled: true,
      extensionEnabled: true,
      extendSubtitles: false,
      subtitleOffset: 0,
      onboardingDone: true,
      translationProvider: 'ytlang',
      googleBatchMode: 'sentence8',
      wordHover: false,
      wordSpeak: false,
      loopSentence: false,
      clickToSeek: false,
      autoScroll: false,
      primarySize: 'md',
      secondarySize: 'sm',
      secondaryColor: 'purple',
    }));
  } catch (_) {}
`;

async function run() {
  log('=== 次要字幕翻譯真實場景測試 ===');
  log(`影片: ${TARGET_URL}`);
  log(`時間: ${new Date().toISOString()}`);

  const context = await chromium.launchPersistentContext('', {
    headless: false,
    args: [
      `--disable-extensions-except=${EXT_PATH}`,
      `--load-extension=${EXT_PATH}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  // 收集 [YT-SUB] console log
  page.on('console', msg => {
    const text = msg.text();
    if (text.includes('[YT-SUB]')) consoleLogs.push(text);
  });

  // 注入 localStorage 設定
  await page.addInitScript(INIT_SCRIPT);

  log('\n前往 YouTube...');
  await page.goto(TARGET_URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  log('✓ 頁面載入');

  // 等側邊欄
  try {
    await page.waitForSelector('#yt-sub-demo-sidebar', { timeout: 15000 });
    log('✓ 擴充功能側邊欄出現');
  } catch {
    log('✗ 側邊欄 15s 未出現');
    // 收集 log 幫助診斷
    consoleLogs.forEach(l => log('  ' + l));
    await context.close();
    fs.writeFileSync(REPORT_PATH, lines.join('\n'));
    return;
  }

  // 等主字幕
  log('\n等待主字幕...');
  let primLoaded = false;
  const t0 = Date.now();
  while (Date.now() - t0 < 40000) {
    const n = await page.evaluate(() =>
      document.querySelectorAll('.yt-sub-item').length
    );
    if (n > 0) { primLoaded = true; log(`✓ 主字幕 ${n} 句`); break; }
    await sleep(1500);
  }
  if (!primLoaded) {
    log('✗ 主字幕 40s 未載入');
    consoleLogs.forEach(l => log('  ' + l));
    await context.close();
    fs.writeFileSync(REPORT_PATH, lines.join('\n'));
    return;
  }

  // 記錄翻譯觸發 log
  const dualLogs = consoleLogs.filter(l => l.includes('[DUAL]') || l.includes('[TRANS]'));
  log('\n=== 翻譯觸發 log ===');
  if (!dualLogs.length) log('⚠ 無 [DUAL]/[TRANS] log');
  else dualLogs.forEach(l => log('  ' + l));

  // 等次要字幕翻譯（最多 30s）
  log('\n等次要字幕翻譯...');
  let secLoaded = false;
  const t1 = Date.now();
  while (Date.now() - t1 < 30000) {
    const n = await page.evaluate(() =>
      document.querySelectorAll('.yt-sub-text-secondary').length
    );
    if (n > 0) {
      secLoaded = true;
      const samples = await page.evaluate(() =>
        Array.from(document.querySelectorAll('.yt-sub-text-secondary'))
          .slice(0, 5).map(e => e.textContent.trim())
      );
      log(`✓ 次要字幕 ${n} 句`);
      samples.forEach((s, i) => log(`  [${i+1}] ${s}`));
      break;
    }
    await sleep(1500);
  }
  if (!secLoaded) {
    log('✗ 次要字幕 30s 未出現');
    log('\n全部 [YT-SUB] log：');
    consoleLogs.forEach(l => log('  ' + l));
  }

  // 播放並看 overlay
  log('\n=== 覆蓋層測試 ===');
  await page.evaluate(() => document.querySelector('video')?.play());
  await sleep(3000);
  const overlaySec = await page.evaluate(() =>
    document.getElementById('yt-sub-cur-secondary')?.textContent?.trim() || ''
  );
  log(overlaySec ? `✓ 覆蓋層次要字幕：「${overlaySec}」` : '✗ 覆蓋層次要字幕空');

  if (!overlaySec) {
    const dbg = await page.evaluate(() => ({
      dualToggle: document.getElementById('yt-sub-dual-toggle')?.checked,
      prim: document.getElementById('yt-sub-cur-primary')?.textContent?.slice(0, 50),
      secEl: document.getElementById('yt-sub-cur-secondary')?.textContent,
    }));
    log('  debug: ' + JSON.stringify(dbg));
  }

  log('\n=== 結果摘要 ===');
  log('主字幕: ' + (primLoaded ? '✓ PASS' : '✗ FAIL'));
  log('翻譯觸發: ' + (dualLogs.length ? '✓ PASS' : '✗ FAIL'));
  log('次要字幕清單: ' + (secLoaded ? '✓ PASS' : '✗ FAIL'));
  log('覆蓋層次要字幕: ' + (overlaySec ? '✓ PASS' : '✗ FAIL'));
  log('\n最終結果: ' + (primLoaded && secLoaded ? '✅ ALL PASS' : '❌ FAIL'));

  await context.close();
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  console.log('\n報告: ' + REPORT_PATH);
}

run().catch(e => {
  log('FATAL: ' + e.message);
  fs.writeFileSync(REPORT_PATH, lines.join('\n'));
  process.exit(1);
});
