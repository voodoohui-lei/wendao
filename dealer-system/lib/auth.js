'use strict';
/**
 * 认证与会话：服务端 Session + HttpOnly Cookie + 登录限流
 * 经销商与管理员使用不同 Cookie 名，互不干扰。
 */
const crypto = require('node:crypto');
const { db, nowISO, audit } = require('./db');

const DEALER_COOKIE = 'ds_dealer';
const ADMIN_COOKIE = 'ds_admin';
const SESSION_TTL = 12 * 60 * 60 * 1000; // 12 小时

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function createSession(role, subject, ip) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.prepare(`INSERT INTO session(token,role,subject,created_at,expires_at,ip) VALUES(?,?,?,?,?,?)`)
    .run(token, role, subject, now, now + SESSION_TTL, ip || '');
  return token;
}

function getSession(req, role) {
  const cookies = parseCookies(req);
  const token = cookies[role === 'admin' ? ADMIN_COOKIE : DEALER_COOKIE];
  if (!token) return null;
  const s = db.prepare(`SELECT * FROM session WHERE token=? AND role=?`).get(token, role);
  if (!s) return null;
  if (s.expires_at < Date.now()) {
    db.prepare(`DELETE FROM session WHERE token=?`).run(token);
    return null;
  }
  return s;
}

function destroySession(req, role) {
  const cookies = parseCookies(req);
  const token = cookies[role === 'admin' ? ADMIN_COOKIE : DEALER_COOKIE];
  if (token) db.prepare(`DELETE FROM session WHERE token=?`).run(token);
}

function setCookie(res, role, token, secure) {
  const name = role === 'admin' ? ADMIN_COOKIE : DEALER_COOKIE;
  const attrs = [`${name}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${SESSION_TTL / 1000}`];
  if (secure) attrs.push('Secure');
  appendCookie(res, attrs.join('; '));
}
function clearCookie(res, role) {
  const name = role === 'admin' ? ADMIN_COOKIE : DEALER_COOKIE;
  appendCookie(res, `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
function appendCookie(res, v) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', [v]);
  else res.setHeader('Set-Cookie', Array.isArray(prev) ? prev.concat(v) : [prev, v]);
}

/* ---------------- 登录限流（内存滑动窗口）---------------- */
const buckets = new Map();
function rateLimit(key, max, windowMs) {
  const now = Date.now();
  let arr = buckets.get(key);
  if (!arr) { arr = []; buckets.set(key, arr); }
  while (arr.length && now - arr[0] > windowMs) arr.shift();
  if (arr.length >= max) {
    return { ok: false, retryAfter: Math.ceil((windowMs - (now - arr[0])) / 1000) };
  }
  arr.push(now);
  return { ok: true };
}
function rateLimitReset(key) { buckets.delete(key); }

setInterval(() => {
  const now = Date.now();
  for (const [k, arr] of buckets) {
    while (arr.length && now - arr[0] > 30 * 60 * 1000) arr.shift();
    if (!arr.length) buckets.delete(k);
  }
}, 10 * 60 * 1000).unref();

function clientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

module.exports = {
  DEALER_COOKIE, ADMIN_COOKIE, SESSION_TTL,
  parseCookies, createSession, getSession, destroySession,
  setCookie, clearCookie, rateLimit, rateLimitReset, clientIp,
};
