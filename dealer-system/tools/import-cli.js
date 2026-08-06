'use strict';
/**
 * 命令行导入工具（无需登录后台，适合首次初始化 / 定时任务）
 *
 * 用法：
 *   node tools/import-cli.js <Excel路径> [--replace]
 *
 *   --replace   按周期覆盖：先删除文件中出现的周期的旧数据再导入
 *   不加参数     追加导入，完全重复的行自动跳过
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, nowISO, audit } = require('../lib/db');
const { parseWorkbookToRecords } = require('../lib/xlsx');

const file = process.argv[2];
const replace = process.argv.includes('--replace');

if (!file) {
  console.log('\n用法: node tools/import-cli.js <Excel路径> [--replace]\n');
  process.exit(1);
}
if (!fs.existsSync(file)) { console.error('文件不存在：' + file); process.exit(1); }

const buf = fs.readFileSync(file);
const name = path.basename(file);

let parsed;
try { parsed = parseWorkbookToRecords(buf, name); }
catch (e) { console.error('\n解析失败：' + e.message + '\n'); process.exit(1); }

const { records, invalid } = parsed;
const periods = [...new Set(records.map((r) => r.period))].sort();
const phones = new Set(records.filter((r) => r.phone).map((r) => r.phone));
const na = records.filter((r) => !r.phone).length;

console.log('\n  文件      ' + name);
console.log('  有效行    ' + records.length + (invalid.length ? `（跳过无效 ${invalid.length} 行）` : ''));
console.log('  业绩周期  ' + periods.join('、'));
console.log('  手机号    ' + phones.size + ' 个可注册');
console.log('  无手机号  ' + na + ' 行（#N/A，仅后台可见）');
console.log('  金额合计  ¥' + records.reduce((s, r) => s + r.amount, 0).toFixed(2));
console.log('  佣金合计  ¥' + records.reduce((s, r) => s + r.commission, 0).toFixed(2));
console.log('  模式      ' + (replace ? '按周期覆盖（会删除同周期旧数据）' : '追加导入（重复行跳过）'));

const mode = replace ? 'replace_period' : 'append';
const batch = db.prepare(
  `INSERT INTO import_batch(filename,mode,total_rows,inserted,duplicated,invalid,na_rows,periods,operator,created_at)
   VALUES(?,?,?,0,0,?,?,?,?,?)`
).run(name, mode, records.length, invalid.length, na, periods.join(','), 'cli', nowISO());
const batchId = Number(batch.lastInsertRowid);

const insert = db.prepare(`
  INSERT OR IGNORE INTO performance
    (user_id,nickname,name,agent_level,period,senior_id,senior_nickname,senior_name,
     phone,phone_raw,senior_level,amount,commission,row_hash,batch_id,created_at)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

const occ = new Map();
const ts = nowISO();
let inserted = 0, dup = 0;

db.exec('BEGIN');
try {
  if (replace) for (const p of periods) db.prepare(`DELETE FROM performance WHERE period=?`).run(p);
  for (const r of records) {
    const base = [r.user_id, r.nickname, r.name, r.agent_level, r.period, r.senior_id,
      r.senior_nickname, r.senior_name, r.phone, r.senior_level, r.amount, r.commission].join('\u0001');
    const n = (occ.get(base) || 0) + 1; occ.set(base, n);
    const hash = crypto.createHash('sha256').update(base + '\u0001#' + n).digest('hex');
    const res = insert.run(r.user_id, r.nickname, r.name, r.agent_level, r.period, r.senior_id,
      r.senior_nickname, r.senior_name, r.phone, r.phone_raw, r.senior_level,
      r.amount, r.commission, hash, batchId, ts);
    if (res.changes > 0) inserted++; else dup++;
  }
  db.prepare(`UPDATE import_batch SET inserted=?,duplicated=? WHERE id=?`).run(inserted, dup, batchId);
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error('\n导入失败，已回滚：' + e.message + '\n');
  process.exit(1);
}

audit('admin', 'cli', 'import', `${name} 模式=${mode} 入库${inserted} 重复${dup}`, 'localhost');

const total = db.prepare(`SELECT COUNT(*) c FROM performance`).get().c;
console.log('\n  \x1b[32m导入完成\x1b[0m  新增入库 ' + inserted + ' 行，跳过重复 ' + dup + ' 行');
console.log('  当前台账共 ' + total + ' 行（批次 #' + batchId + '）\n');
