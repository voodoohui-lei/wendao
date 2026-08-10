'use strict';
/**
 * 数据层：SQLite（Node 内置 node:sqlite，零外部依赖）
 * 表结构见 docs/操作手册.md「一、数据表搭建」
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'app.db');
const db = new DatabaseSync(DB_FILE);

// WAL 模式：读写并发，数百经销商同时查询无阻塞
db.exec(`PRAGMA journal_mode = WAL;`);
db.exec(`PRAGMA synchronous = NORMAL;`);
db.exec(`PRAGMA busy_timeout = 5000;`);
db.exec(`PRAGMA foreign_keys = ON;`);

// ---------- 在线迁移：旧库若还有 commission 列，删掉（业务调整：佣金彻底移除）----------
try {
  const cols = db.prepare(`PRAGMA table_info(performance)`).all();
  if (cols.some((c) => c.name === 'commission')) {
    db.exec(`ALTER TABLE performance DROP COLUMN commission`);
    console.log('[db] migration: dropped performance.commission');
  }
} catch (e) { console.warn('[db] migration commission-drop failed:', e.message); }

db.exec(`
-- ========== 1. 业绩台账（Excel 12 个固定字段落库）==========
CREATE TABLE IF NOT EXISTS performance (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id         TEXT    NOT NULL,           -- 用户ID
  nickname        TEXT    DEFAULT '',         -- 昵称
  name            TEXT    DEFAULT '',         -- 姓名
  agent_level     TEXT    DEFAULT '',         -- 代理等级
  period          TEXT    NOT NULL,           -- 业绩周期 YYYY-MM-DD
  senior_id       TEXT    DEFAULT '',         -- 归属高级ID
  senior_nickname TEXT    DEFAULT '',         -- 归属高级昵称
  senior_name     TEXT    DEFAULT '',         -- 归属高级姓名
  phone           TEXT    NOT NULL DEFAULT '',-- 电话（归属高级手机号；#N/A 存空串）
  phone_raw       TEXT    DEFAULT '',         -- 原始电话文本（保留 #N/A 供后台排查）
  senior_level    TEXT    DEFAULT '',         -- 归属高级等级
  amount          REAL    NOT NULL DEFAULT 0, -- 金额
  row_hash        TEXT    NOT NULL UNIQUE,    -- 行指纹，重复导入自动去重
  batch_id        INTEGER,
  created_at      TEXT    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_perf_phone        ON performance(phone);
CREATE INDEX IF NOT EXISTS idx_perf_period       ON performance(period);
CREATE INDEX IF NOT EXISTS idx_perf_phone_period ON performance(phone, period);
CREATE INDEX IF NOT EXISTS idx_perf_batch        ON performance(batch_id);
CREATE INDEX IF NOT EXISTS idx_perf_userid       ON performance(user_id);

-- ========== 2. 经销商账号 ==========
CREATE TABLE IF NOT EXISTS dealer (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  phone          TEXT    NOT NULL UNIQUE,
  password_hash  TEXT    NOT NULL,
  salt           TEXT    NOT NULL,
  display_name   TEXT    DEFAULT '',
  status         TEXT    NOT NULL DEFAULT 'active', -- active | disabled
  created_at     TEXT    NOT NULL,
  last_login_at  TEXT,
  login_count    INTEGER NOT NULL DEFAULT 0
);

-- ========== 3. 管理员 ==========
CREATE TABLE IF NOT EXISTS admin (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT    NOT NULL UNIQUE,
  password_hash TEXT    NOT NULL,
  salt          TEXT    NOT NULL,
  must_change   INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT    NOT NULL,
  last_login_at TEXT
);

-- ========== 4. 会话（服务端 Session，前端只持 HttpOnly Cookie）==========
CREATE TABLE IF NOT EXISTS session (
  token      TEXT PRIMARY KEY,
  role       TEXT NOT NULL,   -- dealer | admin
  subject    TEXT NOT NULL,   -- dealer=手机号 / admin=用户名
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ip         TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_session_exp ON session(expires_at);

-- ========== 5. 导入批次 ==========
CREATE TABLE IF NOT EXISTS import_batch (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  filename    TEXT NOT NULL,
  mode        TEXT NOT NULL,          -- append 追加 | replace_period 按周期覆盖
  total_rows  INTEGER DEFAULT 0,
  inserted    INTEGER DEFAULT 0,
  duplicated  INTEGER DEFAULT 0,
  invalid     INTEGER DEFAULT 0,
  na_rows     INTEGER DEFAULT 0,
  periods     TEXT DEFAULT '',
  operator    TEXT DEFAULT '',
  created_at  TEXT NOT NULL
);

-- ========== 6. 审计日志 ==========
CREATE TABLE IF NOT EXISTS audit_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     TEXT NOT NULL,
  role   TEXT DEFAULT '',
  actor  TEXT DEFAULT '',
  action TEXT NOT NULL,
  detail TEXT DEFAULT '',
  ip     TEXT DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts);
`);

// ---------- 密码哈希：scrypt ----------
function hashPassword(pwd, salt) {
  const s = salt || crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pwd), s, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
  return { hash: h, salt: s };
}
function verifyPassword(pwd, hash, salt) {
  try {
    const h = crypto.scryptSync(String(pwd), salt, 32, { N: 16384, r: 8, p: 1 }).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'));
  } catch { return false; }
}

const nowISO = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).replace('T', ' ');

// 首次运行创建默认管理员
function ensureDefaultAdmin() {
  const row = db.prepare(`SELECT COUNT(*) AS c FROM admin`).get();
  if (row.c === 0) {
    const { hash, salt } = hashPassword('admin888');
    db.prepare(`INSERT INTO admin(username,password_hash,salt,must_change,created_at) VALUES(?,?,?,1,?)`)
      .run('admin', hash, salt, nowISO());
    return true;
  }
  return false;
}

function audit(role, actor, action, detail, ip) {
  try {
    db.prepare(`INSERT INTO audit_log(ts,role,actor,action,detail,ip) VALUES(?,?,?,?,?,?)`)
      .run(nowISO(), role || '', actor || '', action, detail || '', ip || '');
  } catch { /* 审计失败不影响主流程 */ }
}

function cleanupSessions() {
  try { db.prepare(`DELETE FROM session WHERE expires_at < ?`).run(Date.now()); } catch {}
}

module.exports = { db, hashPassword, verifyPassword, nowISO, ensureDefaultAdmin, audit, cleanupSessions, DB_FILE, DATA_DIR };
