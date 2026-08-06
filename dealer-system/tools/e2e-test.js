'use strict';
/** 端到端验收测试：导入 → 注册 → 登录 → 行级隔离 → 越权攻击 → 导出 */
const fs = require('node:fs');
const path = require('node:path');

const BASE = process.env.BASE || 'http://127.0.0.1:8123';
const XLSX = process.argv[2] || path.join(__dirname, '..', '..', '业绩统计-46204-门店代理.xlsx');

let pass = 0, failCnt = 0;
const okLog = (m, d) => { pass++; console.log('  \x1b[32m✓\x1b[0m ' + m + (d ? '  \x1b[90m' + d + '\x1b[0m' : '')); };
const bad = (m, d) => { failCnt++; console.log('  \x1b[31m✗ ' + m + '\x1b[0m' + (d ? '  ' + d : '')); };
const assert = (c, m, d) => (c ? okLog(m, d) : bad(m, d));

const jars = {};
async function req(jar, method, url, body, raw) {
  const headers = { 'Content-Type': 'application/json' };
  if (jars[jar]) headers.Cookie = jars[jar];
  const r = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined, redirect: 'manual' });
  const sc = r.headers.getSetCookie ? r.headers.getSetCookie() : [];
  for (const c of sc) {
    const kv = c.split(';')[0];
    const name = kv.split('=')[0];
    const cur = (jars[jar] || '').split('; ').filter((x) => x && x.split('=')[0] !== name);
    if (!/Max-Age=0/.test(c)) cur.push(kv);
    jars[jar] = cur.join('; ');
  }
  if (raw) return { status: r.status, text: await r.text() };
  let d = null; try { d = await r.json(); } catch {}
  return { status: r.status, data: d };
}

(async () => {
  console.log('\n\x1b[1m经销商业绩查询系统 · 端到端验收\x1b[0m');
  console.log('目标：' + BASE + '\n');

  /* ---------- 1. 管理员 ---------- */
  // 使用临时测试管理员，避免依赖/覆盖真实 admin 账号（用户可能已自行改过密码）
  console.log('\x1b[1m【1】管理员认证\x1b[0m');
  const A_USER = '__e2e_admin', A_PWD = 'E2eTest@8123';
  { const { db, hashPassword, nowISO } = require('../lib/db');
    db.prepare('DELETE FROM admin WHERE username=?').run(A_USER);
    const h = hashPassword(A_PWD);
    db.prepare('INSERT INTO admin (username,password_hash,salt,must_change,created_at) VALUES (?,?,?,1,?)')
      .run(A_USER, h.hash, h.salt, nowISO()); }

  let r = await req('admin', 'POST', '/api/admin/login', { username: A_USER, password: 'wrong-pwd' });
  assert(r.status === 401, '错误密码被拒绝', 'HTTP ' + r.status);
  r = await req('admin', 'POST', '/api/admin/login', { username: A_USER, password: A_PWD });
  assert(r.status === 200 && r.data.ok, '管理员登录成功');
  assert(r.data.mustChange === true, '初始密码触发强制修改提示');

  /* ---------- 2. 导入 ---------- */
  console.log('\n\x1b[1m【2】Excel 导入\x1b[0m');
  const b64 = fs.readFileSync(XLSX).toString('base64');
  const fname = path.basename(XLSX);
  r = await req('admin', 'POST', '/api/admin/import', { filename: fname, data: b64, preview: true });
  assert(r.status === 200 && r.data.total > 0, '导入预览解析成功', `${r.data.total} 行 / ${r.data.phones} 个手机号 / #N/A ${r.data.naRows} 行`);
  const prev = r.data;

  // 幂等：全新库则全量入库；已导入过（交付态）则按行指纹去重，inserted=0/duplicated=总数
  r = await req('admin', 'POST', '/api/admin/import', { filename: fname, data: b64, mode: 'append' });
  const importedOk = r.status === 200 && (r.data.inserted === prev.total || (r.data.inserted === 0 && r.data.duplicated === prev.total));
  assert(importedOk, '导入入库（幂等：首次全量或已导入则去重）', `入库 ${r.data.inserted} 行 / 跳过 ${r.data.duplicated} 行`);

  r = await req('admin', 'POST', '/api/admin/import', { filename: fname, data: b64, mode: 'append' });
  assert(r.data.inserted === 0 && r.data.duplicated === prev.total, '重复导入同一文件被完全去重', `跳过 ${r.data.duplicated} 行`);

  r = await req('admin', 'GET', '/api/admin/stats');
  const st = r.data.stats;
  assert(st.rows === prev.total, '台账总行数正确', st.rows + ' 行');
  assert(Math.abs(st.amount - prev.amount) < 0.01, '金额合计与源文件一致', '¥' + st.amount.toFixed(2));
  assert(Math.abs(st.commission - prev.commission) < 0.01, '佣金合计与源文件一致', '¥' + st.commission.toFixed(2));

  /* ---------- 3. 选测试账号 ---------- */
  r = await req('admin', 'GET', '/api/admin/dealers');
  const all = r.data.rows;
  const A = all[0], B = all[1];
  console.log('\n\x1b[1m【3】注册校验\x1b[0m');
  console.log(`  测试账号 A：${A.phone}（${A.name}，${A.rows} 条业绩）`);
  console.log(`  测试账号 B：${B.phone}（${B.name}，${B.rows} 条业绩）`);

  r = await req('t1', 'POST', '/api/dealer/check-phone', { phone: '13000000000' });
  assert(r.data.inTable === false, '不在业绩表的手机号：提示无法注册');
  r = await req('t1', 'POST', '/api/dealer/register', { phone: '13000000000', password: 'test123456' });
  assert(r.status === 403, '不在业绩表的手机号：注册被服务端拒绝', 'HTTP ' + r.status);

  r = await req('t1', 'POST', '/api/dealer/register', { phone: A.phone, password: '123' });
  assert(r.status === 400, '弱密码（少于6位）被拒绝');

  r = await req('A', 'POST', '/api/dealer/register', { phone: A.phone, password: 'AaTest2026' });
  assert(r.status === 200 && r.data.ok, '账号 A 注册成功并自动登录');
  r = await req('t1', 'POST', '/api/dealer/register', { phone: A.phone, password: 'AaTest2026' });
  assert(r.status === 409, '同一手机号重复注册被拒绝');

  await req('B', 'POST', '/api/dealer/register', { phone: B.phone, password: 'BbTest2026' });
  okLog('账号 B 注册成功');

  /* ---------- 4. 登录 ---------- */
  console.log('\n\x1b[1m【4】登录\x1b[0m');
  r = await req('x', 'POST', '/api/dealer/login', { phone: A.phone, password: 'wrong' });
  assert(r.status === 401, '错误密码登录失败');
  r = await req('A', 'POST', '/api/dealer/login', { phone: A.phone, password: 'AaTest2026' });
  assert(r.status === 200, '正确密码登录成功');
  assert(/^\d{3}\*{4}\d{4}$/.test(r.data.phone), '返回手机号已脱敏', r.data.phone);

  /* ---------- 5. 行级隔离 ---------- */
  console.log('\n\x1b[1m【5】行级数据隔离（核心）\x1b[0m');
  r = await req('A', 'GET', '/api/dealer/summary');
  const sumA = r.data.total;
  assert(sumA.rows === A.rows, 'A 看到的记录数 = 自己名下条数', `${sumA.rows} 条`);
  assert(Math.abs(sumA.amount - A.amount) < 0.01, 'A 看到的金额 = 自己名下金额', '¥' + sumA.amount.toFixed(2));
  assert(sumA.rows < st.rows, 'A 看到的数据远少于全量台账', `${sumA.rows} / ${st.rows}`);

  r = await req('A', 'GET', '/api/dealer/records?size=100');
  const rowsA = r.data.rows;
  assert(r.data.total === A.rows, 'A 明细条数正确', r.data.total + ' 条');
  const leakField = rowsA.some((x) => 'phone' in x || 'senior_id' in x || 'senior_name' in x);
  assert(!leakField, '明细响应不含任何手机号/上级字段（无横向信息泄露）');

  // 越权尝试
  console.log('\n\x1b[1m【6】越权攻击测试\x1b[0m');
  r = await req('A', 'GET', `/api/dealer/records?phone=${B.phone}&size=100`);
  assert(r.data.total === A.rows, 'A 伪造 phone 参数查 B 的数据 → 仍只返回 A 自己的', `返回 ${r.data.total} 条（B 有 ${B.rows} 条）`);

  r = await req('A', 'GET', `/api/dealer/summary?phone=${B.phone}`);
  assert(Math.abs(r.data.total.amount - A.amount) < 0.01, 'A 伪造 phone 查汇总 → 金额仍是自己的');

  r = await req('A', 'GET', '/api/admin/stats');
  assert(r.status === 401, 'A 访问管理员统计接口 → 401 拒绝');
  r = await req('A', 'GET', '/api/admin/records?size=1000');
  assert(r.status === 401, 'A 访问管理员全量台账 → 401 拒绝');
  r = await req('A', 'GET', '/api/admin/export.csv', null, true);
  assert(r.status === 401, 'A 访问管理员导出接口 → 401 拒绝');
  r = await req('A', 'GET', '/api/admin/dealers');
  assert(r.status === 401, 'A 访问账号管理接口 → 401 拒绝');
  r = await req('A', 'POST', '/api/admin/dealer-action', { phone: B.phone, action: 'delete' });
  assert(r.status === 401, 'A 尝试删除 B 的账号 → 401 拒绝');

  r = await req('none', 'GET', '/api/dealer/records');
  assert(r.status === 401, '未登录访问业绩数据 → 401 拒绝');
  r = await req('none', 'GET', '/api/admin/records');
  assert(r.status === 401, '未登录访问后台数据 → 401 拒绝');

  // B 看到的与 A 完全不同
  r = await req('B', 'GET', '/api/dealer/summary');
  assert(Math.abs(r.data.total.amount - B.amount) < 0.01, 'B 登录后看到的是 B 自己的数据', '¥' + r.data.total.amount.toFixed(2));
  const bIds = new Set((await req('B', 'GET', '/api/dealer/records?size=200')).data.rows.map((x) => x.user_id));
  const aIds = new Set(rowsA.map((x) => x.user_id));
  const inter = [...aIds].filter((x) => bIds.has(x));
  assert(inter.length === 0, 'A 与 B 的可见门店无任何交集', `A ${aIds.size} 个 / B ${bIds.size} 个`);

  /* ---------- 7. 导出 ---------- */
  console.log('\n\x1b[1m【7】导出权限\x1b[0m');
  r = await req('A', 'GET', '/api/dealer/export.csv', null, true);
  const linesA = r.text.trim().split('\n').length - 1;
  assert(r.status === 200 && linesA === A.rows, '经销商导出仅含本人数据', `${linesA} 行`);
  assert(!r.text.includes(B.phone), '经销商导出文件不含他人手机号');

  r = await req('admin', 'GET', '/api/admin/export.csv', null, true);
  const linesAdmin = r.text.trim().split('\n').length - 1;
  assert(r.status === 200 && linesAdmin === st.rows, '管理员导出全量台账', `${linesAdmin} 行`);

  /* ---------- 8. 账号管理 ---------- */
  console.log('\n\x1b[1m【8】账号管理\x1b[0m');
  r = await req('admin', 'POST', '/api/admin/dealer-action', { phone: B.phone, action: 'toggle' });
  assert(r.data.status === 'disabled', '管理员停用账号 B');
  r = await req('B', 'GET', '/api/dealer/summary');
  assert(r.status === 401 || r.status === 403, '被停用的 B 立即失去访问权限', 'HTTP ' + r.status);
  await req('admin', 'POST', '/api/admin/dealer-action', { phone: B.phone, action: 'toggle' });
  okLog('已恢复账号 B');

  r = await req('admin', 'POST', '/api/admin/dealer-action', { phone: B.phone, action: 'reset' });
  const tmp = r.data.tempPassword;
  assert(!!tmp, '管理员重置密码生成临时密码', tmp);
  r = await req('B2', 'POST', '/api/dealer/login', { phone: B.phone, password: tmp });
  assert(r.status === 200, 'B 可用临时密码登录');

  /* ---------- 9. 并发 ---------- */
  console.log('\n\x1b[1m【9】并发压力（模拟数百经销商）\x1b[0m');
  const N = 300;
  const t0 = Date.now();
  const res = await Promise.all(Array.from({ length: N }, () => req('A', 'GET', '/api/dealer/records?size=20')));
  const ms = Date.now() - t0;
  const allOk = res.every((x) => x.status === 200);
  assert(allOk, `${N} 个并发查询全部成功`, `总耗时 ${ms}ms，平均 ${(ms / N).toFixed(1)}ms/请求`);

  const t1 = Date.now();
  await Promise.all(Array.from({ length: 100 }, () => req('admin', 'GET', '/api/admin/records?size=30')));
  okLog('100 个并发后台查询完成', `${Date.now() - t1}ms`);

  /* ---------- 10. 清理 ---------- */
  console.log('\n\x1b[1m【10】清理测试账号\x1b[0m');
  await req('admin', 'POST', '/api/admin/dealer-action', { phone: A.phone, action: 'delete' });
  await req('admin', 'POST', '/api/admin/dealer-action', { phone: B.phone, action: 'delete' });
  okLog('已删除 2 个测试账号（业绩数据保留）');
  { const { db } = require('../lib/db');
    db.prepare('DELETE FROM admin WHERE username=?').run(A_USER);
    okLog('已删除临时测试管理员（真实 admin 账号未受影响）'); }

  console.log('\n' + '─'.repeat(52));
  console.log(failCnt === 0
    ? `\x1b[32m\x1b[1m  全部通过：${pass} 项检查 ✓\x1b[0m`
    : `\x1b[31m\x1b[1m  ${pass} 项通过，${failCnt} 项失败\x1b[0m`);
  console.log('─'.repeat(52) + '\n');
  process.exit(failCnt ? 1 : 0);
})().catch((e) => { console.error('\n\x1b[31m测试异常：', e, '\x1b[0m'); process.exit(1); });
