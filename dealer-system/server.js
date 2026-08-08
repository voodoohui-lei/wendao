'use strict';
/**
 * 经销商业绩查询系统 - 服务端
 * 零外部依赖：仅使用 Node 内置模块（http / sqlite / crypto / zlib / fs / path）
 *
 * 安全模型：
 *   1) 经销商所有数据接口，SQL 强制 WHERE phone = <session 中的手机号>，
 *      前端传入的任何 phone 参数一律忽略，从根上杜绝越权。
 *   2) 管理员与经销商使用不同 Cookie 与不同路由前缀，权限互不继承。
 *   3) 密码 scrypt 加盐哈希，明文不落库、不出网。
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { db, hashPassword, verifyPassword, nowISO, ensureDefaultAdmin, audit, cleanupSessions } = require('./lib/db');
const A = require('./lib/auth');
const { parseWorkbookToRecords } = require('./lib/xlsx');

const PORT = Number(process.env.PORT || 8080);
// 默认监听 '::'（双栈：同时接受 IPv6 ::1 与 IPv4 127.0.0.1/局域网）。
// 若用 '0.0.0.0' 仅 IPv4，浏览器把 localhost 解析到 ::1 时连不上会回退 127.0.0.1，
// 导致注册下发的 cookie 作用域（按实际连接地址）与后续请求不一致 → 登录态丢失、弹回登录页。
const HOST = process.env.HOST || '::';
const PUBLIC_DIR = path.join(__dirname, 'public');
const MAX_BODY = 30 * 1024 * 1024; // 30MB

/* ============ 基础工具 ============ */
const json = (res, code, obj) => {
  const b = Buffer.from(JSON.stringify(obj), 'utf8');
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': b.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(b);
};
const ok = (res, data) => json(res, 200, { ok: true, ...data });
const fail = (res, code, msg) => json(res, code, { ok: false, error: msg });

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('请求体过大（上限 30MB）')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const b = await readBody(req);
  if (!b.length) return {};
  try { return JSON.parse(b.toString('utf8')); } catch { throw new Error('请求格式错误'); }
}

const isPhone = (p) => /^1[3-9]\d{9}$/.test(String(p || '').trim());
const maskName = (n) => {
  const s = String(n || '').trim();
  if (!s) return '';
  if (s.length <= 1) return s + '**';
  return s[0] + '*'.repeat(Math.max(1, s.length - 1));
};
const maskPhone = (p) => (String(p).length === 11 ? String(p).slice(0, 3) + '****' + String(p).slice(7) : p);
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

/* ============ 权限守卫 ============ */
function requireDealer(req, res) {
  const s = A.getSession(req, 'dealer');
  if (!s) { fail(res, 401, '未登录或登录已过期，请重新登录'); return null; }
  const d = db.prepare(`SELECT * FROM dealer WHERE phone=?`).get(s.subject);
  if (!d) { fail(res, 401, '账号不存在'); return null; }
  if (d.status !== 'active') { fail(res, 403, '账号已被停用，请联系管理员'); return null; }
  return { session: s, dealer: d, phone: s.subject };
}
function requireAdmin(req, res) {
  const s = A.getSession(req, 'admin');
  if (!s) { fail(res, 401, '管理员未登录'); return null; }
  const a = db.prepare(`SELECT * FROM admin WHERE username=?`).get(s.subject);
  if (!a) { fail(res, 401, '管理员账号不存在'); return null; }
  return { session: s, admin: a };
}

/* ============ 查询构造 ============ */
/** 经销商侧：phone 由服务端注入，调用方无法覆盖 */
function buildDealerWhere(phone, q) {
  const w = ['phone = ?'];
  const p = [phone];
  if (q.period) { w.push('period = ?'); p.push(q.period); }
  if (q.kw) {
    w.push('(user_id LIKE ? OR nickname LIKE ? OR name LIKE ?)');
    const k = `%${q.kw}%`; p.push(k, k, k);
  }
  return { sql: w.join(' AND '), params: p };
}
/** 管理员侧：可查全部，含无手机号(#N/A)数据 */
function buildAdminWhere(q) {
  const w = ['1=1'];
  const p = [];
  if (q.period) { w.push('period = ?'); p.push(q.period); }
  if (q.phone) { w.push('phone = ?'); p.push(q.phone); }
  if (q.onlyNa === '1') w.push("phone = ''");
  if (q.kw) {
    w.push('(user_id LIKE ? OR nickname LIKE ? OR name LIKE ? OR senior_name LIKE ? OR senior_nickname LIKE ? OR phone LIKE ? OR senior_id LIKE ?)');
    const k = `%${q.kw}%`; p.push(k, k, k, k, k, k, k);
  }
  return { sql: w.join(' AND '), params: p };
}

function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
const CSV_HEADER = ['用户ID', '昵称', '姓名', '代理等级', '业绩周期', '归属高级ID', '归属高级昵称', '归属高级姓名', '电话', '归属高级等级', '金额'];
function rowsToCsv(rows) {
  const lines = [CSV_HEADER.join(',')];
  for (const r of rows) {
    lines.push([r.user_id, r.nickname, r.name, r.agent_level, r.period, r.senior_id,
      r.senior_nickname, r.senior_name, r.phone || r.phone_raw || '#N/A', r.senior_level,
      r.amount].map(csvEscape).join(','));
  }
  return '\uFEFF' + lines.join('\r\n');
}

/* ============ 导入 ============ */
function importRecords(records, { filename, mode, operator }) {
  const periods = [...new Set(records.map((r) => r.period))].sort();
  let inserted = 0, duplicated = 0, naRows = 0;

  const batchInfo = db.prepare(
    `INSERT INTO import_batch(filename,mode,total_rows,inserted,duplicated,invalid,na_rows,periods,operator,created_at)
     VALUES(?,?,?,0,0,0,0,?,?,?)`
  ).run(filename, mode, records.length, periods.join(','), operator, nowISO());
  const batchId = Number(batchInfo.lastInsertRowid);

  const occ = new Map();
  const insert = db.prepare(`
    INSERT OR IGNORE INTO performance
      (user_id,nickname,name,agent_level,period,senior_id,senior_nickname,senior_name,
       phone,phone_raw,senior_level,amount,commission,row_hash,batch_id,created_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const ts = nowISO();

  db.exec('BEGIN');
  try {
    if (mode === 'replace_period') {
      for (const p of periods) db.prepare(`DELETE FROM performance WHERE period=?`).run(p);
    }
    for (const r of records) {
      if (!r.phone) naRows++;
      const base = [r.user_id, r.nickname, r.name, r.agent_level, r.period, r.senior_id,
        r.senior_nickname, r.senior_name, r.phone, r.senior_level, r.amount, r.commission].join('\u0001');
      const n = (occ.get(base) || 0) + 1;
      occ.set(base, n);
      const hash = crypto.createHash('sha256').update(base + '\u0001#' + n).digest('hex');
      const res = insert.run(r.user_id, r.nickname, r.name, r.agent_level, r.period, r.senior_id,
        r.senior_nickname, r.senior_name, r.phone, r.phone_raw, r.senior_level,
        r.amount, r.commission, hash, batchId, ts);
      if (res.changes > 0) inserted++; else duplicated++;
    }
    db.prepare(`UPDATE import_batch SET inserted=?,duplicated=?,na_rows=? WHERE id=?`)
      .run(inserted, duplicated, naRows, batchId);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return { batchId, total: records.length, inserted, duplicated, naRows, periods };
}

/* ============ 路由 ============ */
const routes = {
  /* ---------- 经销商：注册 / 登录 ---------- */
  'POST /api/dealer/check-phone': async (req, res) => {
    const b = await readJson(req);
    const phone = String(b.phone || '').trim();
    const ip = A.clientIp(req);
    const rl = A.rateLimit('chk:' + ip, 30, 60 * 1000);
    if (!rl.ok) return fail(res, 429, `操作过于频繁，请 ${rl.retryAfter} 秒后再试`);
    if (!isPhone(phone)) return fail(res, 400, '请输入正确的 11 位手机号');

    const row = db.prepare(`SELECT COUNT(*) c, MAX(senior_name) nm FROM performance WHERE phone=?`).get(phone);
    const registered = !!db.prepare(`SELECT 1 FROM dealer WHERE phone=?`).get(phone);
    if (!row.c) return ok(res, { inTable: false, registered, message: '该手机号不在业绩名单中，无法注册。请联系管理员核对。' });
    return ok(res, { inTable: true, registered, rows: row.c, name: maskName(row.nm) });
  },

  'POST /api/dealer/register': async (req, res) => {
    const b = await readJson(req);
    const ip = A.clientIp(req);
    // 注：按 IP 限流。阈值放宽到 50/10min，兼容同一公司/门店 NAT 下数十名
    // 经销商同时注册的“开注册日”高峰；单手机号仍只能注册一次（见下方 409）。
    const rl = A.rateLimit('reg:' + ip, 50, 10 * 60 * 1000);
    if (!rl.ok) return fail(res, 429, `注册过于频繁，请 ${rl.retryAfter} 秒后再试`);

    const phone = String(b.phone || '').trim();
    const pwd = String(b.password || '');
    if (!isPhone(phone)) return fail(res, 400, '请输入正确的 11 位手机号');
    if (pwd.length < 6 || pwd.length > 32) return fail(res, 400, '密码长度需为 6-32 位');
    if (/^\d+$/.test(pwd) && new Set(pwd).size <= 2) return fail(res, 400, '密码过于简单，请更换');

    // 核心校验：手机号必须存在于业绩表
    const hit = db.prepare(`SELECT COUNT(*) c, MAX(senior_name) nm FROM performance WHERE phone=?`).get(phone);
    if (!hit.c) { audit('dealer', phone, 'register_reject', '手机号不在业绩表', ip); return fail(res, 403, '该手机号不在业绩名单中，无法注册'); }
    if (db.prepare(`SELECT 1 FROM dealer WHERE phone=?`).get(phone)) return fail(res, 409, '该手机号已注册，请直接登录');

    const { hash, salt } = hashPassword(pwd);
    db.prepare(`INSERT INTO dealer(phone,password_hash,salt,display_name,status,created_at,login_count) VALUES(?,?,?,?,'active',?,0)`)
      .run(phone, hash, salt, hit.nm || '', nowISO());
    audit('dealer', phone, 'register', '注册成功', ip);

    const token = A.createSession('dealer', phone, ip);
    A.setCookie(res, 'dealer', token, false);
    db.prepare(`UPDATE dealer SET last_login_at=?, login_count=login_count+1 WHERE phone=?`).run(nowISO(), phone);
    return ok(res, { phone: maskPhone(phone), name: hit.nm || '' });
  },

  'POST /api/dealer/login': async (req, res) => {
    const b = await readJson(req);
    const ip = A.clientIp(req);
    const phone = String(b.phone || '').trim();
    const rl = A.rateLimit('login:' + ip + ':' + phone, 8, 10 * 60 * 1000);
    if (!rl.ok) return fail(res, 429, `密码错误次数过多，请 ${Math.ceil(rl.retryAfter / 60)} 分钟后再试`);
    if (!isPhone(phone)) return fail(res, 400, '请输入正确的 11 位手机号');

    const d = db.prepare(`SELECT * FROM dealer WHERE phone=?`).get(phone);
    if (!d || !verifyPassword(String(b.password || ''), d.password_hash, d.salt)) {
      audit('dealer', phone, 'login_fail', '手机号或密码错误', ip);
      return fail(res, 401, '手机号或密码错误');
    }
    if (d.status !== 'active') return fail(res, 403, '账号已被停用，请联系管理员');

    A.rateLimitReset('login:' + ip + ':' + phone);
    const token = A.createSession('dealer', phone, ip);
    A.setCookie(res, 'dealer', token, false);
    db.prepare(`UPDATE dealer SET last_login_at=?, login_count=login_count+1 WHERE phone=?`).run(nowISO(), phone);
    audit('dealer', phone, 'login', '登录成功', ip);
    return ok(res, { phone: maskPhone(phone), name: d.display_name });
  },

  'POST /api/dealer/logout': async (req, res) => {
    A.destroySession(req, 'dealer'); A.clearCookie(res, 'dealer'); return ok(res, {});
  },

  'GET /api/dealer/me': async (req, res) => {
    const c = requireDealer(req, res); if (!c) return;
    const periods = db.prepare(`SELECT DISTINCT period FROM performance WHERE phone=? ORDER BY period DESC`).all(c.phone).map((r) => r.period);
    return ok(res, { phone: maskPhone(c.phone), name: c.dealer.display_name, periods, lastLogin: c.dealer.last_login_at });
  },

  'POST /api/dealer/change-password': async (req, res) => {
    const c = requireDealer(req, res); if (!c) return;
    const b = await readJson(req);
    if (!verifyPassword(String(b.oldPassword || ''), c.dealer.password_hash, c.dealer.salt)) return fail(res, 400, '原密码不正确');
    const np = String(b.newPassword || '');
    if (np.length < 6 || np.length > 32) return fail(res, 400, '新密码长度需为 6-32 位');
    const { hash, salt } = hashPassword(np);
    db.prepare(`UPDATE dealer SET password_hash=?, salt=? WHERE phone=?`).run(hash, salt, c.phone);
    db.prepare(`DELETE FROM session WHERE role='dealer' AND subject=?`).run(c.phone);
    A.clearCookie(res, 'dealer');
    audit('dealer', c.phone, 'change_password', '', A.clientIp(req));
    return ok(res, { message: '密码修改成功，请重新登录' });
  },

  /* ---------- 经销商：数据查询（行级隔离）。
   注意：经销商端不展示佣金，API 也不再返回 commission 字段。---------- */
  'GET /api/dealer/summary': async (req, res, q) => {
    const c = requireDealer(req, res); if (!c) return;
    const { sql, params } = buildDealerWhere(c.phone, { period: q.period });
    const t = db.prepare(`SELECT COUNT(*) rows, COUNT(DISTINCT user_id) agents,
        COALESCE(SUM(amount),0) amount
      FROM performance WHERE ${sql}`).get(...params);
    const byPeriod = db.prepare(`SELECT period, COUNT(*) rows, COALESCE(SUM(amount),0) amount
      FROM performance WHERE phone=? GROUP BY period ORDER BY period DESC`).all(c.phone);
    const top = db.prepare(`SELECT user_id, MAX(name) name, MAX(nickname) nickname,
        SUM(amount) amount
      FROM performance WHERE ${sql} GROUP BY user_id ORDER BY amount DESC LIMIT 10`).all(...params);
    return ok(res, { total: t, byPeriod, top });
  },

  'GET /api/dealer/records': async (req, res, q) => {
    const c = requireDealer(req, res); if (!c) return;
    const page = Math.max(1, num(q.page, 1));
    const size = Math.min(100, Math.max(10, num(q.size, 20)));
    const { sql, params } = buildDealerWhere(c.phone, { period: q.period, kw: (q.kw || '').trim() });
    const total = db.prepare(`SELECT COUNT(*) c FROM performance WHERE ${sql}`).get(...params).c;
    // commission 已对经销商隐藏，不再作为排序维度
    const sortMap = { amount: 'amount', period: 'period', user_id: 'user_id' };
    const sort = sortMap[q.sort] || 'amount';
    const dir = q.dir === 'asc' ? 'ASC' : 'DESC';
    const rows = db.prepare(`SELECT user_id,nickname,name,agent_level,period,amount
      FROM performance WHERE ${sql} ORDER BY ${sort} ${dir}, id ASC LIMIT ? OFFSET ?`)
      .all(...params, size, (page - 1) * size);
    return ok(res, { rows, total, page, size, pages: Math.ceil(total / size) || 1 });
  },

  /* ---------- 管理员 ---------- */
  'POST /api/admin/login': async (req, res) => {
    const b = await readJson(req);
    const ip = A.clientIp(req);
    const u = String(b.username || '').trim();
    const rl = A.rateLimit('alogin:' + ip, 10, 10 * 60 * 1000);
    if (!rl.ok) return fail(res, 429, `尝试过于频繁，请 ${Math.ceil(rl.retryAfter / 60)} 分钟后再试`);
    const a = db.prepare(`SELECT * FROM admin WHERE username=?`).get(u);
    if (!a || !verifyPassword(String(b.password || ''), a.password_hash, a.salt)) {
      audit('admin', u, 'login_fail', '', ip);
      return fail(res, 401, '用户名或密码错误');
    }
    A.rateLimitReset('alogin:' + ip);
    const token = A.createSession('admin', u, ip);
    A.setCookie(res, 'admin', token, false);
    db.prepare(`UPDATE admin SET last_login_at=? WHERE id=?`).run(nowISO(), a.id);
    audit('admin', u, 'login', '', ip);
    return ok(res, { username: u, mustChange: !!a.must_change });
  },

  'POST /api/admin/logout': async (req, res) => {
    A.destroySession(req, 'admin'); A.clearCookie(res, 'admin'); return ok(res, {});
  },

  'GET /api/admin/me': async (req, res) => {
    const c = requireAdmin(req, res); if (!c) return;
    return ok(res, { username: c.admin.username, mustChange: !!c.admin.must_change, lastLogin: c.admin.last_login_at });
  },

  'POST /api/admin/change-password': async (req, res) => {
    const c = requireAdmin(req, res); if (!c) return;
    const b = await readJson(req);
    if (!verifyPassword(String(b.oldPassword || ''), c.admin.password_hash, c.admin.salt)) return fail(res, 400, '原密码不正确');
    const np = String(b.newPassword || '');
    if (np.length < 8 || np.length > 64) return fail(res, 400, '管理员密码需 8-64 位');
    if (np === 'admin888') return fail(res, 400, '不能沿用初始密码');
    const { hash, salt } = hashPassword(np);
    db.prepare(`UPDATE admin SET password_hash=?, salt=?, must_change=0 WHERE id=?`).run(hash, salt, c.admin.id);
    audit('admin', c.admin.username, 'change_password', '', A.clientIp(req));
    return ok(res, { message: '密码已更新' });
  },

  'GET /api/admin/stats': async (req, res) => {
    const c = requireAdmin(req, res); if (!c) return;
    const s = db.prepare(`SELECT COUNT(*) rows, COUNT(DISTINCT user_id) agents,
        COALESCE(SUM(amount),0) amount,
        SUM(CASE WHEN phone='' THEN 1 ELSE 0 END) naRows,
        COUNT(DISTINCT CASE WHEN phone<>'' THEN phone END) phones
      FROM performance`).get();
    const dealers = db.prepare(`SELECT COUNT(*) c, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) a FROM dealer`).get();
    const periods = db.prepare(`SELECT period, COUNT(*) rows, COALESCE(SUM(amount),0) amount
        FROM performance GROUP BY period ORDER BY period DESC`).all();
    const unregistered = db.prepare(`SELECT COUNT(DISTINCT phone) c FROM performance
      WHERE phone<>'' AND phone NOT IN (SELECT phone FROM dealer)`).get().c;
    return ok(res, { stats: s, dealers: { total: dealers.c || 0, active: dealers.a || 0, unregistered }, periods });
  },

  'GET /api/admin/records': async (req, res, q) => {
    const c = requireAdmin(req, res); if (!c) return;
    const page = Math.max(1, num(q.page, 1));
    const size = Math.min(200, Math.max(10, num(q.size, 30)));
    const { sql, params } = buildAdminWhere(q);
    const total = db.prepare(`SELECT COUNT(*) c FROM performance WHERE ${sql}`).get(...params).c;
    const agg = db.prepare(`SELECT COALESCE(SUM(amount),0) amount FROM performance WHERE ${sql}`).get(...params);
    const rows = db.prepare(`SELECT id,user_id,nickname,name,agent_level,period,senior_id,senior_nickname,
        senior_name,phone,phone_raw,senior_level,amount
      FROM performance WHERE ${sql} ORDER BY id ASC LIMIT ? OFFSET ?`).all(...params, size, (page - 1) * size);
    return ok(res, { rows, total, agg, page, size, pages: Math.ceil(total / size) || 1 });
  },

  'GET /api/admin/dealers': async (req, res, q) => {
    const c = requireAdmin(req, res); if (!c) return;
    const kw = (q.kw || '').trim();
    const rows = db.prepare(`
      SELECT p.phone,
             MAX(p.senior_name) AS name,
             COUNT(*) AS rows,
             COALESCE(SUM(p.amount),0) AS amount,
             d.id IS NOT NULL AS registered,
             COALESCE(d.status,'') AS status,
             d.created_at AS reg_at,
             d.last_login_at AS last_login,
             COALESCE(d.login_count,0) AS login_count
      FROM performance p LEFT JOIN dealer d ON d.phone = p.phone
      WHERE p.phone <> '' ${kw ? `AND (p.phone LIKE ? OR p.senior_name LIKE ? OR p.senior_nickname LIKE ?)` : ''}
      GROUP BY p.phone ORDER BY amount DESC`).all(...(kw ? [`%${kw}%`, `%${kw}%`, `%${kw}%`] : []));
    return ok(res, { rows });
  },

  'POST /api/admin/dealer-action': async (req, res) => {
    const c = requireAdmin(req, res); if (!c) return;
    const b = await readJson(req);
    const phone = String(b.phone || '').trim();
    if (!isPhone(phone)) return fail(res, 400, '手机号不正确');
    const d = db.prepare(`SELECT * FROM dealer WHERE phone=?`).get(phone);
    if (!d) return fail(res, 404, '该手机号尚未注册账号');

    if (b.action === 'toggle') {
      const ns = d.status === 'active' ? 'disabled' : 'active';
      db.prepare(`UPDATE dealer SET status=? WHERE phone=?`).run(ns, phone);
      if (ns === 'disabled') db.prepare(`DELETE FROM session WHERE role='dealer' AND subject=?`).run(phone);
      audit('admin', c.admin.username, 'dealer_' + ns, phone, A.clientIp(req));
      return ok(res, { status: ns });
    }
    if (b.action === 'reset') {
      const tmp = 'ds' + crypto.randomInt(100000, 999999);
      const { hash, salt } = hashPassword(tmp);
      db.prepare(`UPDATE dealer SET password_hash=?, salt=? WHERE phone=?`).run(hash, salt, phone);
      db.prepare(`DELETE FROM session WHERE role='dealer' AND subject=?`).run(phone);
      audit('admin', c.admin.username, 'dealer_reset_pwd', phone, A.clientIp(req));
      return ok(res, { tempPassword: tmp });
    }
    if (b.action === 'delete') {
      db.prepare(`DELETE FROM dealer WHERE phone=?`).run(phone);
      db.prepare(`DELETE FROM session WHERE role='dealer' AND subject=?`).run(phone);
      audit('admin', c.admin.username, 'dealer_delete', phone, A.clientIp(req));
      return ok(res, {});
    }
    return fail(res, 400, '未知操作');
  },

  'POST /api/admin/import': async (req, res) => {
    const c = requireAdmin(req, res); if (!c) return;
    const b = await readJson(req);
    const filename = String(b.filename || 'upload.xlsx');
    const mode = b.mode === 'replace_period' ? 'replace_period' : 'append';
    if (!b.data) return fail(res, 400, '未收到文件内容');
    let buf;
    try { buf = Buffer.from(String(b.data).replace(/^data:[^,]+,/, ''), 'base64'); }
    catch { return fail(res, 400, '文件内容解析失败'); }
    if (!buf.length) return fail(res, 400, '文件为空');

    let parsed;
    try { parsed = parseWorkbookToRecords(buf, filename); }
    catch (e) { return fail(res, 400, e.message); }
    if (!parsed.records.length) return fail(res, 400, '未解析到有效数据行');

    if (b.preview) {
      const phones = new Set(parsed.records.filter((r) => r.phone).map((r) => r.phone));
      return ok(res, {
        preview: true,
        total: parsed.records.length,
        invalid: parsed.invalid,
        naRows: parsed.records.filter((r) => !r.phone).length,
        phones: phones.size,
        periods: [...new Set(parsed.records.map((r) => r.period))].sort(),
        amount: parsed.records.reduce((s, r) => s + r.amount, 0),
        sample: parsed.records.slice(0, 5),
      });
    }

    const r = importRecords(parsed.records, { filename, mode, operator: c.admin.username });
    db.prepare(`UPDATE import_batch SET invalid=? WHERE id=?`).run(parsed.invalid.length, r.batchId);
    audit('admin', c.admin.username, 'import',
      `${filename} 模式=${mode} 总${r.total} 入库${r.inserted} 重复${r.duplicated}`, A.clientIp(req));
    return ok(res, { ...r, invalid: parsed.invalid });
  },

  'GET /api/admin/batches': async (req, res) => {
    const c = requireAdmin(req, res); if (!c) return;
    return ok(res, { rows: db.prepare(`SELECT * FROM import_batch ORDER BY id DESC LIMIT 50`).all() });
  },

  'POST /api/admin/delete-batch': async (req, res) => {
    const c = requireAdmin(req, res); if (!c) return;
    const b = await readJson(req);
    const id = num(b.batchId, 0);
    if (!id) return fail(res, 400, '批次不存在');
    const n = db.prepare(`DELETE FROM performance WHERE batch_id=?`).run(id);
    db.prepare(`DELETE FROM import_batch WHERE id=?`).run(id);
    audit('admin', c.admin.username, 'delete_batch', `批次${id} 删除${n.changes}行`, A.clientIp(req));
    return ok(res, { deleted: n.changes });
  },

  'GET /api/admin/audit': async (req, res) => {
    const c = requireAdmin(req, res); if (!c) return;
    return ok(res, { rows: db.prepare(`SELECT * FROM audit_log ORDER BY id DESC LIMIT 200`).all() });
  },
};

/* 导出：单独处理（非 JSON 响应） */
function handleExport(req, res, q) {
  const c = requireAdmin(req, res); if (!c) return;
  const { sql, params } = buildAdminWhere(q);
  const rows = db.prepare(`SELECT * FROM performance WHERE ${sql} ORDER BY id ASC`).all(...params);
  const csv = rowsToCsv(rows);
  const name = `业绩台账_${q.period || '全部'}_${new Date().toISOString().slice(0, 10)}.csv`;
  audit('admin', c.admin.username, 'export', `导出 ${rows.length} 行`, A.clientIp(req));
  const buf = Buffer.from(csv, 'utf8');
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Length': buf.length,
    'Content-Disposition': `attachment; filename="export.csv"; filename*=UTF-8''${encodeURIComponent(name)}`,
  });
  res.end(buf);
}

/* 经销商导出自己的数据（明确允许：仅本人数据，非全量台账）。
   注意：佣金对经销商+管理员均隐藏，导出同步去掉。 */
function handleDealerExport(req, res, q) {
  const c = requireDealer(req, res); if (!c) return;
  const { sql, params } = buildDealerWhere(c.phone, { period: q.period });
  const rows = db.prepare(`SELECT user_id,nickname,name,period,amount FROM performance WHERE ${sql} ORDER BY id ASC`).all(...params);
  const lines = ['\uFEFF' + ['用户ID', '昵称', '姓名', '业绩周期', '金额'].join(',')];
  for (const r of rows) lines.push([r.user_id, r.nickname, r.name, r.period, r.amount].map(csvEscape).join(','));
  const buf = Buffer.from(lines.join('\r\n'), 'utf8');
  audit('dealer', c.phone, 'export_self', `${rows.length} 行`, A.clientIp(req));
  res.writeHead(200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Length': buf.length,
    'Content-Disposition': `attachment; filename="my-performance.csv"; filename*=UTF-8''${encodeURIComponent('我的业绩_' + (q.period || '全部') + '.csv')}`,
  });
  res.end(buf);
}

/* ============ 静态文件 ============ */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
function serveStatic(res, file) {
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full)) { res.writeHead(404); return res.end('Not Found'); }
  const buf = fs.readFileSync(full);
  // no-store：页面改版后浏览器必定拉取最新版，避免用户停留在缓存的旧页面
  res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream', 'Cache-Control': 'no-store, must-revalidate', 'Pragma': 'no-cache', 'X-Frame-Options': 'SAMEORIGIN' });
  res.end(buf);
}

/* ============ 服务 ============ */
const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, 'http://localhost');
    const pathname = decodeURIComponent(u.pathname);
    const q = Object.fromEntries(u.searchParams);

    if (pathname === '/api/admin/export.csv' && req.method === 'GET') return handleExport(req, res, q);
    if (pathname === '/api/dealer/export.csv' && req.method === 'GET') return handleDealerExport(req, res, q);

    const key = `${req.method} ${pathname}`;
    if (routes[key]) return await routes[key](req, res, q);
    if (pathname.startsWith('/api/')) return fail(res, 404, '接口不存在');

    if (pathname === '/' || pathname === '/index.html') return serveStatic(res, 'index.html');
    if (pathname === '/admin' || pathname === '/admin.html') return serveStatic(res, 'admin.html');
    return serveStatic(res, pathname.replace(/^\//, ''));
  } catch (e) {
    console.error('[ERR]', e);
    if (!res.headersSent) fail(res, 500, e.message || '服务器内部错误');
  }
});

const created = ensureDefaultAdmin();
cleanupSessions();
setInterval(cleanupSessions, 30 * 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  const ips = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) ips.push(i.address);
  }
  const c = db.prepare(`SELECT COUNT(*) c FROM performance`).get().c;
  console.log('');
  console.log('  经销商业绩查询系统 已启动');
  console.log('  ─────────────────────────────────────────');
  console.log(`  经销商入口   http://localhost:${PORT}/`);
  console.log(`  管理员后台   http://localhost:${PORT}/admin`);
  for (const ip of ips) console.log(`  局域网访问   http://${ip}:${PORT}/   （手机同 WiFi 可开）`);
  console.log('  ─────────────────────────────────────────');
  console.log(`  业绩记录 ${c} 条`);
  if (created) console.log('  已创建默认管理员：admin / admin888  ← 请登录后立即修改');
  console.log('');
});
