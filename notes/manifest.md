# manifest.json

## 基本資訊

| 項目 | 值 |
|------|-----|
| 檔案 | `manifest.json` |
| 行數 | 45 行 |
| 類型 | 擴充套件配置 |
| Manifest 版本 | MV3 |

## 功能說明

Chrome 擴充套件的入口配置檔，宣告所有權限、腳本注入規則與可存取資源。

---

## 依賴關係

### 本模組宣告的檔案（由 Chrome 引用）

- [[patch]] — `content_scripts[0].js`，`run_at: document_start`，`world: MAIN`
- [[content]] — `content_scripts[1].js`，`run_at: document_idle`
- [[styles]] — `content_scripts[1].css`
- [[background]] — `background.service_worker`
- [[inject]] — `web_accessible_resources[0].resources`
- [[editor]] — `web_accessible_resources[1].resources`（editor.html / editor.js / editor.css）
- [[vocab-dashboard]] — `web_accessible_resources[1].resources`（vocab-dashboard.html / .js / .css）

---

## 關鍵配置

### Permissions

```json
"permissions": ["storage", "identity", "tabs"]
```

| Permission | 用途 |
|-----------|------|
| `storage` | chrome.storage.local 儲存設定、字幕快取、單字本 |
| `identity` | launchWebAuthFlow 執行 Google OAuth |
| `tabs` | 查詢/管理分頁（取得 YouTube tabId、開啟編輯器分頁） |

### Host Permissions

```json
"host_permissions": [
  "*://www.youtube.com/*",
  "https://translate.googleapis.com/*",
  "https://api.dictionaryapi.dev/*",
  "https://api.datamuse.com/*",
  "https://firestore.googleapis.com/*",
  "https://identitytoolkit.googleapis.com/*",
  "https://securetoken.googleapis.com/*",
  "https://accounts.google.com/*"
]
```

### Content Scripts 注入順序

```
1. patch.js      → document_start, world: MAIN
                  （最先執行，攔截 fetch/XHR 之前 YouTube 初始化）
2. content.js    → document_idle, world: ISOLATED
   styles.css    → 同時注入
```

### Web Accessible Resources

```json
[
  {
    "resources": ["inject.js", "banner.png"],
    "matches": ["*://www.youtube.com/*", "<all_urls>"]
  },
  {
    "resources": [
      "editor.html", "editor.js", "editor.css",
      "vocab-dashboard.html", "vocab-dashboard.js", "vocab-dashboard.css"
    ],
    "matches": ["<all_urls>"]
  }
]
```

---

## 架構筆記

- MV3 強制使用 Service Worker（不再支援 background page 常駐）
- `world: MAIN` 讓 patch.js 直接存取 `window` 物件（繞過 Isolated World 限制）
- `identity` permission 為 Firebase Google 登入所必需

---

## 反向依賴（誰依賴此模組）

此檔案為 Chrome 讀取的根配置，所有模組皆由此宣告。無程式碼層級的 `import`。

---

## 相關

- [[專案索引]]
- [[TECHNICAL]]
