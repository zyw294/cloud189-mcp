// Session cache shared with the existing Python cloud189-sync toolchain.
// The cache file is a flat JSON object:
//   web_cookies, typed_cookies, pc_sessionKey, pc_sessionSecret, pc_accessToken,
//   pc_refreshToken, pc_cookies, savedAt
// This module only reads/updates the keys it owns and preserves everything else.
import { readFileSync, writeFileSync, renameSync, chmodSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:74.0) Gecko/20100101 Firefox/76.0';
export const API = 'https://api.cloud.189.cn';
export const CLOUD = 'https://cloud.189.cn';
export const SUFFIX = 'clientType=TELEMAC&version=1.0.0&channelId=web_cloud.189.cn';
export const PC_APP_ID = '8025431004';
export const PC_CLIENT_TYPE = '10020';

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
  }
}

export function defaultSessionPath() {
  const fromEnv = process.env.CLOUD189_SESSION_PATH || process.env.CLOUD189_SESSION;
  if (fromEnv && fromEnv.trim()) return resolve(fromEnv.trim());
  return join(homedir(), '.cloud189', 'session.json');
}

export function readSession(sessionPath) {
  if (!existsSync(sessionPath)) {
    throw new AuthError(
      `找不到天翼云盘会话文件：${sessionPath}\n` +
        '请先在 cloud189-sync 中完成一次扫码登录，或用 CLOUD189_SESSION_PATH 指向已有的 .c189_session.json。'
    );
  }
  let raw;
  try {
    raw = readFileSync(sessionPath, 'utf8');
  } catch (error) {
    throw new AuthError(`会话文件不可读：${sessionPath}（${error.message}）`);
  }
  let cache;
  try {
    cache = JSON.parse(raw);
  } catch (error) {
    throw new AuthError(`会话文件不是合法 JSON：${sessionPath}（${error.message}）`);
  }
  if (!cache || typeof cache !== 'object') {
    throw new AuthError(`会话文件结构异常：${sessionPath}`);
  }
  return cache;
}

// Atomic write that keeps unknown keys (the Python side owns web_cookies etc.).
export function writeSession(sessionPath, cache) {
  const payload = { ...cache, savedAt: Math.floor(Date.now() / 1000) };
  const tmp = `${sessionPath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
  try {
    chmodSync(tmp, 0o600);
  } catch {
    /* Windows has no POSIX mode */
  }
  renameSync(tmp, sessionPath);
  return payload;
}

function cookieHeaderFromTyped(typedCookies) {
  const pairs = (typedCookies || [])
    .filter((c) => c && c.name)
    .map((c) => `${c.name}=${c.value}`);
  return pairs.join('; ');
}

export function cookieHeader(cache) {
  const typed = cookieHeaderFromTyped(cache && cache.typed_cookies);
  if (typed) return typed;
  return Object.entries((cache && cache.web_cookies) || {})
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

// PC channel keys live for hours~days. Re-mint them from the live web SSO
// (unifyLoginForPC -> getSessionForPC) exactly like c189_keepalive.py does,
// so no password or QR is needed while the web SSO is still alive.
export async function remintPcSession(cache) {
  const cookie = cookieHeader(cache);
  if (!cookie) {
    throw new AuthError('会话文件既无 typed_cookies 也无 web_cookies，无法免密重签 PC 密钥');
  }
  const ts = String(Date.now());
  const entry =
    `${CLOUD}/unifyLoginForPC.action?appId=${PC_APP_ID}&clientType=${PC_CLIENT_TYPE}` +
    `&returnURL=${encodeURIComponent(
      'https://m.cloud.189.cn/zhuanti/2020/loginErrorPc/index.html'
    )}&timeStamp=${ts}`;
  const authorize = await fetch(entry, {
    headers: { 'User-Agent': UA, Cookie: cookie, Accept: 'text/html,application/json' },
    redirect: 'follow',
  });
  const finalUrl = authorize.url || '';
  if (!finalUrl.includes('paras=') || !finalUrl.includes('loginErrorPc')) {
    throw new AuthError(
      '网页 SSO 已失效，无法免密重签 PC 密钥。请先完成一次扫码登录' +
        '（cloud189-sync skill 的「扫码登录→双通道复活」流程），再重试。'
    );
  }
  const sessionUrl =
    `${API}/getSessionForPC.action?clientType=TELEMAC&version=1.0.0` +
    `&channelId=web_cloud.189.cn&redirectURL=${encodeURIComponent(finalUrl)}`;
  const res = await fetch(sessionUrl, {
    headers: { 'User-Agent': UA, Cookie: cookie, Accept: 'application/json;charset=UTF-8' },
  });
  const text = await res.text();
  const grab = (tag) => {
    const m = text.match(new RegExp(`<${tag}>(.*?)</${tag}>`, 's'));
    return m ? m[1].trim() : '';
  };
  let sessionKey = '';
  let sessionSecret = '';
  if (text.trim().startsWith('{')) {
    try {
      const j = JSON.parse(text);
      sessionKey = j.sessionKey || '';
      sessionSecret = j.sessionSecret || '';
      cache.pc_accessToken = j.accessToken || cache.pc_accessToken || '';
    } catch {
      /* fall through to XML parsing */
    }
  }
  if (!sessionKey) {
    sessionKey = grab('sessionKey');
    sessionSecret = grab('sessionSecret');
    const accessToken = grab('accessToken');
    if (accessToken) cache.pc_accessToken = accessToken;
  }
  if (!sessionKey || !sessionSecret) {
    throw new AuthError('getSessionForPC 未返回 sessionKey，网页 SSO 可能已失效，需扫码登录');
  }
  cache.pc_sessionKey = sessionKey;
  cache.pc_sessionSecret = sessionSecret;
  return cache;
}
