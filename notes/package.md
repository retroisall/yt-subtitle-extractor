# package.json

## 基本資訊

| 項目 | 值 |
|------|-----|
| 檔案 | `package.json` |
| 行數 | 10 行 |
| 用途 | Node.js 測試環境依賴管理（非套件本體） |

## 內容

```json
{
  "name": "yt-subtitle-ext-test",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "dependencies": {
    "better-sqlite3": "^12.9.0",
    "playwright": "^1.59.1"
  }
}
```

---

## 依賴說明

| 套件 | 版本 | 用途 |
|------|------|------|
| `playwright` | ^1.59.1 | E2E 測試框架，所有 `tests/*.mjs` 腳本都依賴此套件 |
| `better-sqlite3` | ^12.9.0 | SQLite 支援，用於部分測試的本地資料儲存或 cookie 處理 |

---

## 重要設定

- `"type": "module"` — 所有 `.js`/`.mjs` 預設為 ES Module（`import/export` 語法）
- `"private": true` — 防止誤發佈到 npm

---

## 安裝與使用

```bash
cd "d:\dev\chrome字幕套件開發"
npm install

# 安裝 Playwright 瀏覽器
npx playwright install chromium

# 執行測試
node tests/qa-subtitle-mode.mjs
node test.mjs
```

---

## 反向依賴

- 所有 `tests/*.mjs` 測試腳本依賴此環境
- 不被 [[manifest]] 宣告（開發工具，非套件本體）

---

## 相關

- [[tests]]
- [[test-tools]]
- [[qa_batch_test]]
- [[專案索引]]
