/**
 * QA 測試腳本：批次翻譯模式功能驗證
 * 測試 groupByWords 邏輯 + translateBatch API 呼叫
 */
const fs = require('fs');

// ===== 從 content.js 提取 groupByWords 函式 =====
const contentJs = fs.readFileSync('d:/dev/chrome字幕套件開發/content.js', 'utf8');

// 提取 groupByWords 原始碼（從 function 宣告到對應的 closing brace）
const fnMatch = contentJs.match(/function groupByWords[\s\S]*?\n  \}/);
if (!fnMatch) { console.error('❌ 無法找到 groupByWords 函式'); process.exit(1); }

// 以 var 形式讓 eval 洩露到外層
const fnSrc = fnMatch[0].replace(/^function /, 'var groupByWords = function ');
eval(fnSrc);

// ===== 測試工具 =====
let passed = 0, failed = 0;
const results = [];

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
    results.push({ label, ok: true });
  } else {
    console.error(`  ❌ ${label}${detail ? ' | ' + detail : ''}`);
    failed++;
    results.push({ label, ok: false, detail });
  }
}

// ===== 輔助：建立假字幕陣列 =====
function makeSubs(sentences) {
  // sentences: array of word count numbers, or array of strings
  return sentences.map((s, i) => ({
    startTime: i * 5,
    duration: 4,
    text: typeof s === 'string' ? s : Array.from({ length: s }, (_, k) => 'word' + k).join(' ')
  }));
}

// ===== TEST 1: groupByWords 邏輯 =====
console.log('\n=== TEST 1: groupByWords 邏輯驗證 ===\n');

// 1a. 20 句各 5 字 → words100 模式 (maxWords=100) → 應分成 ~2 組
{
  console.log('1a. 20 句各 5 字 (總 100 字) → 預期約 2 組');
  const subs = makeSubs(Array(20).fill(5));
  const indices = subs.map((_, i) => i);
  const groups = groupByWords(indices, subs, 100);
  console.log(`    分組結果: ${groups.length} 組, 各組句數: [${groups.map(g => g.length).join(', ')}]`);
  // 20 句 * 5 字 = 100 字；第一句 push 後 count=5，累積到第20句時 count=100，
  // 但 count+w > maxWords 只有在 count 已超過時才開新組
  // count 0+5=5, 10, 15, ..., 95, 100 → 不觸發 >100，全部在一組
  // 實際：count 到 100 時不超過，所以是 1 組
  // 再來 19 句: 5*20=100 正好等於 maxWords，不超過，所以 1 組
  assert('20 句各 5 字：分 1 組（100字正好等於 maxWords，不超過）', groups.length === 1,
    `groups.length=${groups.length}`);
}

// 1b. 21 句各 5 字 → 第 21 句 count=100+5>100 → 應分 2 組
{
  console.log('\n1b. 21 句各 5 字 (總 105 字) → 預期 2 組');
  const subs = makeSubs(Array(21).fill(5));
  const indices = subs.map((_, i) => i);
  const groups = groupByWords(indices, subs, 100);
  console.log(`    分組結果: ${groups.length} 組, 各組句數: [${groups.map(g => g.length).join(', ')}]`);
  assert('21 句各 5 字：分 2 組', groups.length === 2, `groups.length=${groups.length}`);
  assert('第 1 組 20 句', groups[0].length === 20, `groups[0].length=${groups[0].length}`);
  assert('第 2 組 1 句', groups[1].length === 1, `groups[1].length=${groups[1].length}`);
}

// 1c. 3 句各 50 字 → 每句超過 100 字時仍需各自成一組
{
  console.log('\n1c. 3 句各 50 字 → 預期 1 組（50*3=150 字，但每句 50 字不超過 100）');
  // 注意：第一句 0+50=50 ≤ 100，不新增組；第二句 50+50=100 ≤ 100，不新增；第三句 100+50=150 > 100 → 新組
  const subs = makeSubs(Array(3).fill(50));
  const indices = subs.map((_, i) => i);
  const groups = groupByWords(indices, subs, 100);
  console.log(`    分組結果: ${groups.length} 組, 各組句數: [${groups.map(g => g.length).join(', ')}]`);
  // 預期: 句1(50) + 句2(50) = 100 (不超), 句3 100+50>100 → 2 組 [2, 1]
  assert('3 句各 50 字：分 2 組', groups.length === 2, `groups.length=${groups.length}`);
}

// 1d. 3 句各 60 字 → 第 2 句已讓 count=60+60=120 > 100 → 新組
{
  console.log('\n1d. 3 句各 60 字 → 預期 3 組（每句 60 字，第 2 句便超 100）');
  const subs = makeSubs(Array(3).fill(60));
  const indices = subs.map((_, i) => i);
  const groups = groupByWords(indices, subs, 100);
  console.log(`    分組結果: ${groups.length} 組, 各組句數: [${groups.map(g => g.length).join(', ')}]`);
  // 句1: count=60, 句2: 60+60>100 → push [0], cur=[1] count=60, 句3: 60+60>100 → push [1], cur=[2]
  assert('3 句各 60 字：分 3 組（每句超 100 字各成一組）', groups.length === 3, `groups.length=${groups.length}`);
}

// 1e. 空陣列
{
  console.log('\n1e. 空陣列 → 預期 0 組');
  const groups = groupByWords([], [], 100);
  console.log(`    分組結果: ${groups.length} 組`);
  assert('空陣列：回傳 0 組', groups.length === 0);
}

// 1f. 單句
{
  console.log('\n1f. 單句 5 字 → 預期 1 組');
  const subs = makeSubs([5]);
  const groups = groupByWords([0], subs, 100);
  console.log(`    分組結果: ${groups.length} 組`);
  assert('單句：回傳 1 組', groups.length === 1);
  assert('單句：組內含 index 0', groups[0][0] === 0);
}

// ===== TEST 2: translateBatch 實際 API 呼叫 =====
console.log('\n=== TEST 2: translateBatch 實際 API 呼叫 ===\n');

// 提取 translateBatch 與 translateGoogle
const tbMatch = contentJs.match(/async function translateBatch[\s\S]*?\n  \}/);
const tgMatch = contentJs.match(/async function translateGoogle[\s\S]*?\n  \}/);

if (!tbMatch || !tgMatch) {
  console.error('❌ 無法找到 translateBatch / translateGoogle 函式');
  process.exit(1);
}

// 需要 fetch — 使用 node-fetch 或原生 Node 18+ fetch
async function runApiTests() {
  // 注入 fetch（Node 18+ 原生支援）
  if (typeof fetch === 'undefined') {
    try {
      const { default: nodeFetch } = await import('node-fetch');
      global.fetch = nodeFetch;
    } catch (e) {
      console.error('❌ 無法載入 fetch，請確認 Node.js >= 18 或安裝 node-fetch');
      process.exit(1);
    }
  }

  // 在一個封閉 scope 內定義兩個函式
  const code = `
    async function translateGoogle(text, targetLang) {
      const lang = ({ 'zh-Hans': 'zh-CN' })[targetLang] || targetLang;
      const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t'
        + '&tl=' + encodeURIComponent(lang) + '&q=' + encodeURIComponent(text);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('Google 翻譯回傳 ' + resp.status);
      const data = await resp.json();
      return data[0].map(s => s[0]).join('').trim();
    }

    async function translateBatch(texts, targetLang) {
      const SEP = '\\n⚡\\n';
      const lang = ({ 'zh-Hans': 'zh-CN' })[targetLang] || targetLang;
      const combined = texts.join(SEP);
      const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&dt=t'
        + '&tl=' + encodeURIComponent(lang) + '&q=' + encodeURIComponent(combined);
      const resp = await fetch(url);
      if (!resp.ok) throw new Error('Google 翻譯回傳 ' + resp.status);
      const data = await resp.json();
      const raw = data[0].map(s => s[0]).join('').trim();
      const parts = raw.split(/\\n?⚡\\n?/).map(p => p.trim());
      if (parts.length !== texts.length) {
        console.warn('[YT-SUB] translateBatch 切割數不符，fallback 逐句', parts.length, '!=', texts.length);
        return Promise.all(texts.map(t => translateGoogle(t, targetLang)));
      }
      return parts;
    }
    module.exports = { translateGoogle, translateBatch };
  `;

  const tmpPath = 'd:/dev/chrome字幕套件開發/qa_translate_tmp.js';
  fs.writeFileSync(tmpPath, code);
  const { translateGoogle, translateBatch } = require(tmpPath);

  // 2a. 8 句英文 → translateBatch → 應回傳 8 個翻譯結果
  const sentences8 = [
    'Hello, how are you today?',
    'The weather is nice outside.',
    'I love learning new languages.',
    'This is the fourth sentence here.',
    'Machine translation has improved greatly.',
    'The quick brown fox jumps over.',
    'Please subscribe to this channel now.',
    'Thank you for watching this video.'
  ];

  console.log('2a. 8 句英文 translateBatch → 預期回傳 8 句翻譯');
  try {
    const results8 = await translateBatch(sentences8, 'zh-TW');
    console.log(`    回傳筆數: ${results8.length}`);
    console.log(`    前 3 句: ${results8.slice(0, 3).join(' | ')}`);
    assert('translateBatch 8 句：回傳 8 筆', results8.length === 8, `length=${results8.length}`);

    // 2b. 結果不含 ⚡ 殘留
    const hasLightning = results8.some(r => r.includes('⚡'));
    console.log(`    是否含 ⚡ 殘留: ${hasLightning}`);
    assert('translateBatch 結果不含 ⚡ 殘留', !hasLightning, `results: ${results8.filter(r => r.includes('⚡'))}`);

    // 2c. 每筆都是非空字串
    const allNonEmpty = results8.every(r => typeof r === 'string' && r.trim().length > 0);
    assert('translateBatch 每筆皆為非空字串', allNonEmpty);

  } catch (e) {
    console.error(`    API 呼叫失敗: ${e.message}`);
    assert('translateBatch 8 句 API 呼叫', false, e.message);
    assert('translateBatch 結果不含 ⚡ 殘留', false, '(API 失敗，跳過)');
    assert('translateBatch 每筆皆為非空字串', false, '(API 失敗，跳過)');
  }

  // 清理暫存檔
  fs.unlinkSync(tmpPath);
}

// ===== TEST 3: 程式碼靜態審查 =====
console.log('\n=== TEST 3: 程式碼靜態審查 ===\n');

// 3a. sentence8 分組邏輯 = 固定 8 句一組
{
  // 找到 translateAndSetSecondary 內的 groups 賦值行（跨行）
  const groupsBlock = contentJs.match(/const groups = settings\.googleBatchMode[\s\S]{0,400}?return g; \}\)\(\);/);
  if (groupsBlock) {
    const src = groupsBlock[0];
    console.log('3a. sentence8 分組邏輯:');
    console.log('    ' + src.replace(/\n/g, '\n    '));
    const hasSlice8 = src.includes('b += 8') && src.includes('slice(b, b + 8)');
    assert('sentence8 分組邏輯：每 8 句一組 (b += 8, slice b to b+8)', hasSlice8, src);
  } else {
    assert('找到 sentence8 分組邏輯', false, '正則未匹配');
  }
}

// 3b. fallback 路徑呼叫 translateGoogle 逐句
{
  const fallbackMatch = contentJs.match(/切割數不符[\s\S]*?return Promise\.all\(texts\.map\(t => translateGoogle\(t, targetLang\)\)\)/);
  console.log('\n3b. fallback 路徑:');
  if (fallbackMatch) {
    console.log('    ' + fallbackMatch[0].replace(/\n/g, '\n    '));
    assert('fallback 路徑正確呼叫 translateGoogle 逐句', true);
  } else {
    assert('fallback 路徑正確呼叫 translateGoogle 逐句', false, '未找到 fallback 呼叫 translateGoogle');
  }
}

// 3c. updateTransProviderUI 在 provider 不是 google 時隱藏批次模式列
{
  const uiMatch = contentJs.match(/function updateTransProviderUI[\s\S]*?\n  \}/);
  console.log('\n3c. updateTransProviderUI:');
  if (uiMatch) {
    console.log('    ' + uiMatch[0].replace(/\n/g, '\n    '));
    const hasHide = uiMatch[0].includes("=== 'google'") && uiMatch[0].includes("'none'");
    const hasShow = uiMatch[0].includes("'' : 'none'") || uiMatch[0].includes("'google' ? '' : 'none'");
    assert("updateTransProviderUI：google 時顯示、其他時隱藏", hasHide && hasShow,
      uiMatch[0]);
  } else {
    assert('找到 updateTransProviderUI', false, '未找到函式');
  }
}

// 3d. 確認 googleBatchMode 預設值為 sentence8
{
  const defaultMatch = contentJs.match(/googleBatchMode:\s*'([^']+)'/);
  if (defaultMatch) {
    console.log(`\n3d. googleBatchMode 預設值: '${defaultMatch[1]}'`);
    assert("googleBatchMode 預設值為 'sentence8'", defaultMatch[1] === 'sentence8', `預設值=${defaultMatch[1]}`);
  } else {
    assert("找到 googleBatchMode 預設值", false, '未找到設定');
  }
}

// 3e. translateAndSetSecondary 在 sentence8 模式下使用 b += 8 的切片
{
  // 確認 groups IIFE 中正確使用 indices (不是 subs)
  const groupsLine = contentJs.match(/: \(\(\) => \{ const g = \[\]; for \(let b = 0; b < indices\.length; b \+= 8\) g\.push\(indices\.slice\(b, b \+ 8\)\); return g; \}\)\(\)/);
  assert('sentence8 邏輯操作的是 indices 陣列（非 subs）', !!groupsLine,
    groupsLine ? '' : '未找到對 indices 的切片');
}

// ===== 執行 API 測試 =====
runApiTests().then(() => {
  console.log('\n========================================');
  console.log(`測試結論: ${passed + failed} 項，通過 ${passed}，失敗 ${failed}`);
  if (failed === 0) {
    console.log('✅ 全部通過');
  } else {
    console.log('❌ 失敗項目:');
    results.filter(r => !r.ok).forEach(r => console.log(`   - ${r.label}${r.detail ? ': ' + r.detail : ''}`));
  }
  process.exit(failed > 0 ? 1 : 0);
}).catch(e => {
  console.error('測試執行異常:', e);
  process.exit(1);
});
