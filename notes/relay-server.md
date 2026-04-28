# relay-server.js

## 基本資訊

| 項目 | 值 |
|------|-----|
| 檔案 | `relay-server.js` |
| 行數 | 119 行 |
| 執行環境 | Node.js（本地開發工具，非套件的一部分） |
| 依賴 | `http`、`crypto`（Node 標準庫） |

## 功能說明

本地 Debug 工具。建立 WebSocket 伺服器（`ws://localhost:9527`），接收 [[content]] 注入到 YouTube 頁面的 console 訊息，並轉發到本地終端機。解決 Chrome 擴充套件 console 難以持續監看的問題。

---

## 依賴關係

### 上游（relay-server.js 依賴）

- Node.js 標準庫：`require('http')`、`require('crypto')`
- 無任何擴充套件模組依賴

### 下游（依賴 relay-server 的模組）

- [[content]] — 在 debug 模式下透過 WebSocket 傳送 console 訊息

---

## 核心機制

### WebSocket Server 實作（純 Node，無第三方庫）

```javascript
const http = require('http');
const crypto = require('crypto');

const server = http.createServer();
server.listen(9527);

server.on('upgrade', (req, socket) => {
  // WebSocket 握手
  const key = req.headers['sec-websocket-key'];
  const acceptKey = crypto
    .createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
  );
  
  // 接收並解碼 WebSocket frame
  socket.on('data', (buffer) => {
    const message = decodeWebSocketFrame(buffer);
    console.log('[套件訊息]', message);
  });
});
```

### content.js 端的連接（debug 模式）

```javascript
// content.js 的 debug 輔助
if (DEBUG_MODE) {
  const ws = new WebSocket('ws://localhost:9527');
  const originalLog = console.log;
  console.log = function(...args) {
    originalLog(...args);
    ws.send(JSON.stringify({ type: 'log', args }));
  };
}
```

---

## 使用方式

```bash
# 啟動 relay server
node relay-server.js

# 終端機會顯示來自 YouTube 頁面的 console 輸出
# [套件訊息] { type: 'log', args: ['字幕載入完成', { tracks: 3 }] }
```

---

## 適用場景

- 需要監看 content.js 在 YouTube 頁面的即時 log
- Chrome DevTools 的 Sources 面板在擴充套件 debug 時不夠方便
- 需要將 log 輸出到檔案做後續分析

---

## 反向依賴

- [[content]] — debug 模式下連接此 WebSocket server
- 不被 [[manifest]] 宣告（非套件本體）

---

## 相關

- [[content]]
- [[qa_batch_test]]
- [[專案索引]]
