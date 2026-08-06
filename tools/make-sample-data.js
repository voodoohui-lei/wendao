#!/usr/bin/env node
/**
 * 从真实业绩 Excel 生成脱敏样例 CSV。
 *
 * 脱敏规则：
 *   - 真实手机号     → 13800000001, 13800000002 ... 顺序编号
 *   - 真实姓名       → 高级甲/乙/丙..., 门店一/二/三...
 *   - 真实昵称       → "经销商-A" / "门店-A1" 等
 *   - 真实 user_id   → 保留前 1 位 + 递增尾号 (D0001/A00001)
 *   - 金额/佣金/周期 → 保留不变（业务字段，非隐私）
 *
 * 用法：
 *   node tools/make-sample-data.js
 *   # 输出 sample-data/sample.csv
 *
 * 零外部依赖，复用 lib/xlsx.js 的解析器。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseWorkbookToRecords } = require('../dealer-system/lib/xlsx');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, '业绩统计-46204-门店代理.xlsx');
const DST_DIR = path.join(ROOT, 'sample-data');
const DST = path.join(DST_DIR, 'sample.csv');
const PERIOD_COUNT = 3;   // 只保留最近 N 个周期，避免样例太大
const ROW_LIMIT = 250;    // 最多保留 N 行（够覆盖代表性，又不至于太大）

function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`[ERR] 找不到源 Excel: ${SRC}`);
    process.exit(1);
  }
  if (!fs.existsSync(DST_DIR)) fs.mkdirSync(DST_DIR, { recursive: true });

  const buf = fs.readFileSync(SRC);
  const { records, invalid } = parseWorkbookToRecords(buf, SRC);
  console.log(`解析到 ${records.length} 行有效数据（${invalid.length} 行无效）`);

  // 保留最近 PERIOD_COUNT 个周期
  const periods = [...new Set(records.map((r) => r.period))].sort().slice(-PERIOD_COUNT);
  let filtered = records.filter((r) => periods.includes(r.period));
  console.log(`保留最近 ${PERIOD_COUNT} 个周期: ${periods.join(', ')} → ${filtered.length} 行`);

  // 限定最大行数
  if (filtered.length > ROW_LIMIT) filtered = filtered.slice(0, ROW_LIMIT);

  // 脱敏映射
  const seniorMap = new Map();   // 原 senior_id → 新 senior_id
  const agentMap  = new Map();   // 原 user_id  → 新 user_id
  const phoneMap  = new Map();   // 原 phone    → 新 phone
  const nameMap   = new Map();   // (kind, origKey) → 新 name
  const nickMap   = new Map();   // (kind, origKey) → 新 nickname
  let sIdx = 0, aIdx = 0;
  const newPhone = (orig) => {
    if (phoneMap.has(orig)) return phoneMap.get(orig);
    const i = phoneMap.size + 1;
    const p = i < 100 ? `1380000${String(i).padStart(4, '0')}` : `138${String(i).padStart(8, '0')}`;
    phoneMap.set(orig, p);
    return p;
  };
  const newSenior = (orig) => {
    if (seniorMap.has(orig)) return seniorMap.get(orig);
    sIdx++;
    const id = `D${String(sIdx).padStart(4, '0')}`;
    seniorMap.set(orig, id);
    nameMap.set('sr:' + orig, sIdx <= 26 ? `高级${String.fromCharCode(0x4e00 + sIdx - 1)}` : `高级${sIdx}`);
    nickMap.set('sr:' + orig, `经销商-${String.fromCharCode(65 + (sIdx - 1) % 26)}`);
    return id;
  };
  const newAgent = (orig) => {
    if (agentMap.has(orig)) return agentMap.get(orig);
    aIdx++;
    const id = `A${String(aIdx).padStart(5, '0')}`;
    agentMap.set(orig, id);
    nameMap.set('ag:' + orig, `门店${aIdx}`);
    nickMap.set('ag:' + orig, `门店-A${aIdx}`);
    return id;
  };

  // 写 CSV
  const HEADER = ['用户ID','昵称','姓名','代理等级','业绩周期','归属高级ID','归属高级昵称','归属高级姓名','电话','归属高级等级','金额','佣金'];
  const lines = [HEADER.join(',')];
  for (const r of filtered) {
    const aId = newAgent(String(r.user_id || ''));
    const sId = newSenior(String(r.senior_id || ''));
    const phone = r.phone ? newPhone(String(r.phone)) : '';
    const row = [
      aId,
      nickMap.get('ag:' + r.user_id) || '',
      nameMap.get('ag:' + r.user_id) || '',
      r.agent_level || '门店代理',
      String(r.period).slice(0, 10),
      sId,
      nickMap.get('sr:' + r.senior_id) || '',
      nameMap.get('sr:' + r.senior_id) || '',
      phone,
      r.senior_level || '经销商',
      r.amount || 0,
      r.commission || 0,
    ];
    // CSV 转义：含逗号/引号/换行的字段加双引号，内部双引号变 ""
    lines.push(row.map((v) => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(','));
  }

  fs.writeFileSync(DST, '\uFEFF' + lines.join('\r\n'), 'utf8');
  console.log(`\n✅ 生成 ${filtered.length} 行脱敏样例 → ${path.relative(ROOT, DST)}`);
  console.log(`   ${sIdx} 个经销商、${aIdx} 个门店代理、${phoneMap.size} 个手机号`);
  console.log(`   金额范围: ¥${Math.min(...filtered.map(r => r.amount)).toFixed(2)} ~ ¥${Math.max(...filtered.map(r => r.amount)).toFixed(2)}`);
  console.log(`   样例手机号: ${[...phoneMap.values()].slice(0, 5).join(', ')}...`);
}

try { main(); }
catch (e) { console.error('[ERR]', e.message); process.exit(2); }