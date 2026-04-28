# qa_batch_test.js

## 基本資訊

| 項目 | 值 |
|------|-----|
| 檔案 | `qa_batch_test.js` |
| 行數 | 294 行 |
| 執行環境 | Node.js（QA 工具，非套件的一部分） |
| 依賴 | `fs`、`vm`（Node 標準庫） |

## 功能說明

針對 [[content]] 中 `groupByWords` 批次翻譯邏輯的單元測試工具。使用 Node.js `vm` 模組執行從 content.js 提取出的函式，模擬 Google Translate API 呼叫，驗證批次翻譯的正確性與效能。

---

## 依賴關係

### 上游（qa_batch_test.js 依賴）

- `fs` — 讀取 `content.js` 原始碼
- `vm` — 在沙箱環境中執行 content.js 的特定函式
- [[content]] — 測試目標（`groupByWords`、翻譯批次函式）

### 下游（依賴此測試的模組）

- 無（純測試工具）

---

## 核心機制

### 使用 Node vm 提取函式

```javascript
const fs = require('fs');
const vm = require('vm');

// 讀取 content.js
const code = fs.readFileSync('./content.js', 'utf-8');

// 在沙箱中執行，取得測試目標函式
const sandbox = { exports: {} };
vm.runInNewContext(code, sandbox);

const { groupByWords, translateBatch } = sandbox;
```

### 測試案例結構

```javascript
const testCases = [
  {
    name: '基本批次翻譯',
    input: ['Hello World', 'How are you', 'Good morning'],
    expected: { batchCount: 1, totalTime: '<2s' }
  },
  {
    name: '超過 8 句觸發多批次',
    input: Array(20).fill('Test sentence'),
    expected: { batchCount: 3 }  // ceil(20/8) = 3 批
  },
  {
    name: '空輸入處理',
    input: [],
    expected: { result: [] }
  }
];
```

### Google Translate API 模擬

```javascript
// Mock fetch 避免實際呼叫 API
global.fetch = async (url, options) => {
  if (url.includes('translate.googleapis.com')) {
    return {
      ok: true,
      json: async () => mockTranslationResponse(options.body)
    };
  }
  return originalFetch(url, options);
};
```

---

## 測試涵蓋範圍

| 功能 | 測試類型 |
|------|---------|
| `groupByWords` | 單字分組邏輯 |
| 批次大小（8 句一批） | 邊界值測試 |
| 翻譯間隔（400ms） | 計時驗證 |
| Google Translate API 格式 | Mock 驗證 |
| 空陣列/null 輸入 | 錯誤處理 |
| 快取命中率 | 效能測試 |

---

## 執行方式

```bash
node qa_batch_test.js

# 輸出範例
# ✓ 基本批次翻譯 (342ms)
# ✓ 超過 8 句觸發多批次 (1201ms)
# ✗ 空輸入處理 - Expected [] but got null
```

---

## 與 Playwright 測試的差異

| 項目 | qa_batch_test.js | tests/*.mjs（Playwright） |
|------|-----------------|--------------------------|
| 層級 | 單元測試 | E2E 整合測試 |
| 環境 | Node vm 沙箱 | 真實 Chrome 瀏覽器 |
| 速度 | 快（秒級） | 慢（分鐘級） |
| 適用 | 邏輯函式驗證 | UI 行為驗證 |

---

## 反向依賴

- [[content]] — 測試目標（不被 content.js import，單向依賴）
- 不被 [[manifest]] 宣告

---

## 相關

- [[content]]
- [[relay-server]]
- [[TECHNICAL]]
- [[專案索引]]
