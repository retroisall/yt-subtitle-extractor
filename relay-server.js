// relay-server.js — Debug WebSocket relay server（無外部依賴）
// 用途：接收套件的 console log / error，直接印到終端機
// 啟動：node relay-server.js
// 停止：Ctrl+C

const http   = require('http');
const crypto = require('crypto');

const PORT      = 9527;
const WS_MAGIC  = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

// ANSI 顏色
const C = {
  reset:  '\x1b[0m',
  gray:   '\x1b[90m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
  bold:   '\x1b[1m',
};

function colorLine(line) {
  if (line.includes(':error]') || line.includes('Uncaught') || line.includes('TypeError'))
    return C.red + line + C.reset;
  if (line.includes(':warn]') || line.includes('⚠️'))
    return C.yellow + line + C.reset;
  if (line.includes('✅'))
    return C.green + line + C.reset;
  if (line.includes('[inject]') || line.includes('[YT-SUB]'))
    return C.cyan + line + C.reset;
  return C.gray + line + C.reset;
}

// ===== 簡易 WebSocket frame 解析器 =====
function readFrames(buf, onText) {
  let pos = 0;
  while (pos + 2 <= buf.length) {
    const opcode = buf[pos] & 0x0f;
    const masked  = (buf[pos + 1] & 0x80) !== 0;
    let len = buf[pos + 1] & 0x7f;
    pos += 2;

    if (len === 126) {
      if (pos + 2 > buf.length) break;
      len = buf.readUInt16BE(pos); pos += 2;
    } else if (len === 127) {
      if (pos + 8 > buf.length) break;
      len = Number(buf.readBigUInt64BE(pos)); pos += 8;
    }

    const maskEnd = masked ? pos + 4 : pos;
    const end     = maskEnd + len;
    if (end > buf.length) break;

    const payload = Buffer.alloc(len);
    if (masked) {
      const mask = buf.slice(pos, pos + 4);
      for (let i = 0; i < len; i++) payload[i] = buf[maskEnd + i] ^ mask[i % 4];
    } else {
      buf.copy(payload, 0, maskEnd, end);
    }
    pos = end;

    if (opcode === 1) onText(payload.toString('utf8')); // text frame
    if (opcode === 8) return -1; // close frame
  }
  return pos;
}

// ===== HTTP → WebSocket Upgrade =====
const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('relay-server running\n');
});

server.on('upgrade', (req, socket) => {
  const key    = req.headers['sec-websocket-key'];
  const accept = crypto.createHash('sha1').update(key + WS_MAGIC).digest('base64');

  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'Upgrade: websocket\r\n' +
    'Connection: Upgrade\r\n' +
    `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
  );

  const ts = () => new Date().toLocaleTimeString('zh-TW', { hour12: false });
  console.log(C.green + C.bold + `[${ts()}] ✅ Browser connected` + C.reset);

  let pending = Buffer.alloc(0);

  socket.on('data', chunk => {
    pending = Buffer.concat([pending, chunk]);
    const consumed = readFrames(pending, text => {
      const lines = text.split('\n').filter(Boolean);
      lines.forEach(l => console.log(colorLine(`[${ts()}] ${l}`)));
    });
    if (consumed === -1) {
      console.log(C.yellow + `[${ts()}] Browser disconnected` + C.reset);
      socket.end();
      pending = Buffer.alloc(0);
    } else {
      pending = pending.slice(consumed);
    }
  });

  socket.on('close', () =>
    console.log(C.yellow + `[${ts()}] ❌ Socket closed` + C.reset));
  socket.on('error', e =>
    console.error(C.red + `[RELAY] Socket error: ${e.message}` + C.reset));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(C.bold + C.green + `\n[RELAY] WebSocket relay server on ws://localhost:${PORT}` + C.reset);
  console.log(C.gray + '  等待套件連線...\n' + C.reset);
});

process.on('SIGINT', () => { console.log('\n[RELAY] Stopped.'); process.exit(); });
