/**
 * 從本機 Chrome 抓取 YouTube cookies，輸出成 Playwright 可用的 JSON 格式
 * 使用 PowerShell DPAPI 解密 Chrome 的 AES key，再用 crypto 解密各 cookie 值
 */
import { execSync, spawnSync } from 'child_process';
import { readFileSync, copyFileSync, writeFileSync, existsSync } from 'fs';
import { createDecipheriv } from 'crypto';
import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';

const CHROME_USER_DATA = path.join(os.homedir(), 'AppData/Local/Google/Chrome/User Data');
const LOCAL_STATE_PATH = path.join(CHROME_USER_DATA, 'Local State');
const COOKIES_PATH = path.join(CHROME_USER_DATA, 'Default/Network/Cookies');
const COOKIES_COPY = path.join(os.tmpdir(), 'chrome_cookies_copy.db');
const OUTPUT_PATH = new URL('../tests/yt-cookies.json', import.meta.url).pathname.replace(/^\//, '');

// Step 1: 讀取 Local State 取得加密的 AES key
const localState = JSON.parse(readFileSync(LOCAL_STATE_PATH, 'utf8'));
const encryptedKeyB64 = localState.os_crypt.encrypted_key;
const encryptedKeyBuf = Buffer.from(encryptedKeyB64, 'base64');
// 前 5 bytes 是 "DPAPI" 標頭，去掉後才是真正的 DPAPI blob
const dpapiBuf = encryptedKeyBuf.slice(5);

// Step 2: 用 PowerShell 呼叫 DPAPI 解密
const dpapiBufB64 = dpapiBuf.toString('base64');
const psScript = `Add-Type -AssemblyName System.Security; [System.Convert]::ToBase64String([System.Security.Cryptography.ProtectedData]::Unprotect([System.Convert]::FromBase64String('${dpapiBufB64}'), $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser))`;
const psResult = spawnSync('powershell.exe', ['-NoProfile', '-Command', psScript], { encoding: 'utf8' });
if (psResult.error) throw psResult.error;
if (psResult.status !== 0) throw new Error('PowerShell DPAPI 解密失敗:\n' + psResult.stderr);
const aesKeyB64 = psResult.stdout.trim();
const aesKey = Buffer.from(aesKeyB64, 'base64');

// Step 3: 複製 Cookies DB（避免 Chrome 鎖定）
copyFileSync(COOKIES_PATH, COOKIES_COPY);
const db = new Database(COOKIES_COPY, { readonly: true });

// Step 4: 查詢 YouTube cookies
const rows = db.prepare(`
  SELECT name, encrypted_value, host_key, path, expires_utc, is_secure, is_httponly, samesite
  FROM cookies
  WHERE host_key LIKE '%.youtube.com' OR host_key LIKE '%.google.com'
  ORDER BY host_key, name
`).all();
db.close();

// Step 5: 解密每個 cookie 值
function decryptCookieValue(encryptedValue) {
  const buf = Buffer.from(encryptedValue);
  // Chrome v80+ 格式：前 3 bytes = 'v10' 或 'v11'，接著 12 bytes nonce，其餘是 ciphertext+tag
  const prefix = buf.slice(0, 3).toString();
  if (prefix === 'v10' || prefix === 'v11') {
    const nonce = buf.slice(3, 15);
    const ciphertextWithTag = buf.slice(15);
    const ciphertext = ciphertextWithTag.slice(0, -16);
    const tag = ciphertextWithTag.slice(-16);
    try {
      const decipher = createDecipheriv('aes-256-gcm', aesKey, nonce);
      decipher.setAuthTag(tag);
      return decipher.update(ciphertext, null, 'utf8') + decipher.final('utf8');
    } catch {
      return null;
    }
  }
  // 舊版 DPAPI 加密
  return buf.toString('utf8');
}

// Step 6: 轉成 Playwright cookies 格式
const playwrightCookies = [];
for (const row of rows) {
  const value = decryptCookieValue(row.encrypted_value);
  if (!value) continue;
  // Chrome epoch 是從 1601-01-01，Unix epoch 是 1970-01-01，差 11644473600 秒
  const expires = row.expires_utc > 0
    ? Math.floor(row.expires_utc / 1_000_000) - 11644473600
    : -1;
  playwrightCookies.push({
    name: row.name,
    value,
    domain: row.host_key.startsWith('.') ? row.host_key : row.host_key,
    path: row.path || '/',
    expires,
    httpOnly: !!row.is_httponly,
    secure: !!row.is_secure,
    sameSite: ['Strict', 'Lax', 'None'][row.samesite] || 'None',
  });
}

writeFileSync(OUTPUT_PATH, JSON.stringify(playwrightCookies, null, 2), 'utf8');
console.log(`✓ 共匯出 ${playwrightCookies.length} 個 cookie → ${OUTPUT_PATH}`);
const ytCookies = playwrightCookies.filter(c => c.domain.includes('youtube.com'));
const gCookies = playwrightCookies.filter(c => c.domain.includes('google.com'));
console.log(`  youtube.com: ${ytCookies.length} 個`);
console.log(`  google.com:  ${gCookies.length} 個`);
const keyNames = ['SAPISID','__Secure-3PAPISID','SID','HSID','SSID','LOGIN_INFO','VISITOR_INFO1_LIVE'];
keyNames.forEach(n => {
  const found = playwrightCookies.find(c => c.name === n);
  console.log(`  ${n}: ${found ? '✓' : '✗ 缺少'}`);
});
