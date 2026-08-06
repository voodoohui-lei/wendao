'use strict';
/**
 * 管理员密码重置工具（忘记后台密码时使用）
 *
 * 用法：
 *   node tools/reset-admin.js                  重置为默认 admin / admin888（下次登录强制改密）
 *   node tools/reset-admin.js 新密码            重置为指定密码（下次登录强制改密）
 *   node tools/reset-admin.js 新密码 --keep     重置为指定密码，且不强制改密
 *
 * 注意：需先停止正在运行的服务，或重置后重新登录一次即可。
 */
const { db, hashPassword, nowISO } = require('../lib/db');

const args = process.argv.slice(2).filter((a) => a !== '--keep');
const keep = process.argv.includes('--keep');
const pwd = args[0] || 'admin888';
const mustChange = keep ? 0 : 1;

if (String(pwd).length < 6) {
  console.error('\x1b[31m密码至少 6 位\x1b[0m');
  process.exit(1);
}

const row = db.prepare('SELECT id, username FROM admin ORDER BY id LIMIT 1').get();
const { hash, salt } = hashPassword(pwd);

if (row) {
  db.prepare('UPDATE admin SET password_hash=?, salt=?, must_change=? WHERE id=?')
    .run(hash, salt, mustChange, row.id);
  console.log(`\x1b[32m✓ 已重置管理员「${row.username}」的密码\x1b[0m`);
} else {
  db.prepare('INSERT INTO admin (username,password_hash,salt,must_change,created_at) VALUES (?,?,?,?,?)')
    .run('admin', hash, salt, mustChange, nowISO());
  console.log('\x1b[32m✓ 管理员账号不存在，已新建「admin」\x1b[0m');
}

// 踢掉所有已登录的管理员会话，强制重新登录
const n = db.prepare("DELETE FROM session WHERE role='admin'").run();

console.log(`  新密码：${pwd}`);
console.log(`  强制改密：${mustChange ? '是（下次登录需修改）' : '否'}`);
console.log(`  已清除 ${n.changes} 个管理员会话，请重新登录 /admin`);
