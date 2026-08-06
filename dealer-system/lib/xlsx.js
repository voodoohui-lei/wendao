'use strict';
/**
 * 零依赖 XLSX / CSV 解析器
 * xlsx 本质是 ZIP + XML，用 node:zlib 手工解包，避免引入任何 npm 包。
 * 支持：sharedStrings、inlineStr、公式结果、错误值(#N/A)、日期序列号。
 */
const zlib = require('node:zlib');

/* ---------------- ZIP 解包 ---------------- */
function unzip(buf) {
  const files = {};
  // 从尾部找 EOCD (0x06054b50)
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 65558; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('不是有效的 xlsx 文件（未找到 ZIP 结构）');

  const entries = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  for (let n = 0; n < entries; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method   = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen  = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen   = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name     = buf.toString('utf8', off + 46, off + 46 + nameLen);

    // 定位 local header 真正的数据起点
    const lNameLen  = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    try {
      files[name] = method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw);
    } catch (e) { /* 跳过损坏条目 */ }

    off += 46 + nameLen + extraLen + cmtLen;
  }
  return files;
}

/* ---------------- XML 小工具 ---------------- */
function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, '&');
}

function parseSharedStrings(xml) {
  const out = [];
  if (!xml) return out;
  // 注意：自闭合分支必须放在前面，否则 <si/> 会吞掉后续内容
  const siRe = /<si\b[^>]*\/>|<si\b[^>]*>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = siRe.exec(xml))) {
    const inner = m[1] || '';
    let text = '';
    const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
    let t;
    while ((t = tRe.exec(inner))) text += decodeXml(t[1]);
    out.push(text);
  }
  return out;
}

/* Excel 列号 A1 -> 0, B1 -> 1 */
function colIndex(ref) {
  const m = /^([A-Z]+)/.exec(ref || '');
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/* Excel 日期序列号 -> YYYY-MM-DD */
function isDateSerial(n) {
  // Excel 日期序列号合理区间：1900-01-01 ~ 2100-12-31。
  // 防御手机号等长数字被误判成日期（如 13763309809）
  return Number.isFinite(n) && n > 0 && n < 80000;
}
function serialToDate(n) {
  const ms = Math.round((n - 25569) * 86400 * 1000);
  const d = new Date(ms);
  if (isNaN(d.getTime())) return '';
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/* 判断某个 style 是不是日期格式 */
function buildDateStyleSet(stylesXml) {
  const set = new Set();
  if (!stylesXml) return set;
  // 内置日期 numFmtId：14-22, 45-47
  const builtinDate = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);
  const customDate = new Set();
  const nfRe = /<numFmt\b[^>]*numFmtId="(\d+)"[^>]*formatCode="([^"]*)"/g;
  let m;
  while ((m = nfRe.exec(stylesXml))) {
    const code = decodeXml(m[2]);
    if (/[yYmMdD]/.test(code) && !/[#0]/.test(code.replace(/\[[^\]]*\]/g, ''))) customDate.add(Number(m[1]));
  }
  const xfBlock = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(stylesXml);
  if (!xfBlock) return set;
  const xfRe = /<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g;
  let idx = 0, x;
  while ((x = xfRe.exec(xfBlock[1]))) {
    const nf = /numFmtId="(\d+)"/.exec(x[0]);
    const id = nf ? Number(nf[1]) : 0;
    if (builtinDate.has(id) || customDate.has(id)) set.add(idx);
    idx++;
  }
  return set;
}

/* ---------------- 解析工作表为二维数组 ---------------- */
function parseSheet(xml, shared, dateStyles) {
  const rows = [];
  // 自闭合分支必须在前：<row .../> 若被当成开标签会吞掉后续所有行
  const rowRe = /<row\b([^>]*)\/>|<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  let r;
  while ((r = rowRe.exec(xml))) {
    const attrs = r[1] !== undefined ? r[1] : (r[2] || '');
    const body = r[3] || '';
    const rNum = Number((/\br="(\d+)"/.exec(attrs) || [])[1] || rows.length + 1);
    const cells = [];
    // 同理：<c r="F9" s="3"/> 这类空单元格必须优先按自闭合匹配，
    // 否则会把后面几个单元格连同其 <v> 一起吞进来，造成整行列错位。
    const cRe = /<c\b([^>]*)\/>|<c\b([^>]*)>([\s\S]*?)<\/c>/g;
    let c;
    while ((c = cRe.exec(body))) {
      const cAttr = c[1] !== undefined ? c[1] : (c[2] || '');
      const cBody = c[3] || '';
      const ref = (/\br="([A-Z]+\d+)"/.exec(cAttr) || [])[1] || '';
      const type = (/\bt="([^"]+)"/.exec(cAttr) || [])[1] || 'n';
      const sIdx = Number((/\bs="(\d+)"/.exec(cAttr) || [])[1] ?? -1);
      const ci = ref ? colIndex(ref) : cells.length;

      let val = '';
      if (type === 'inlineStr') {
        let t; const tRe = /<t\b[^>]*>([\s\S]*?)<\/t>/g;
        while ((t = tRe.exec(cBody))) val += decodeXml(t[1]);
      } else {
        const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cBody);
        const raw = v ? decodeXml(v[1]) : '';
        if (type === 's') {
          val = shared[Number(raw)] ?? '';
        } else if (type === 'e') {
          val = raw;                       // 错误值：#N/A / #REF! 等，原样保留
        } else if (type === 'str' || type === 'b') {
          val = raw;
        } else {
          // 数字：仅当样式为日期格式且数值落在合理日期区间时才转日期
          const num = Number(raw);
          if (raw !== '' && dateStyles.has(sIdx) && !isNaN(num) && isDateSerial(num)) {
            val = serialToDate(num);
          } else {
            val = raw;
          }
        }
      }
      while (cells.length < ci) cells.push('');
      cells[ci] = val;
    }
    while (rows.length < rNum - 1) rows.push([]);
    rows[rNum - 1] = cells;
  }
  return rows;
}

/**
 * 解析 xlsx Buffer -> { sheetName, rows: string[][] }
 */
function parseXlsx(buf) {
  const files = unzip(buf);
  const dec = (n) => (files[n] ? files[n].toString('utf8') : '');

  const shared = parseSharedStrings(dec('xl/sharedStrings.xml'));
  const dateStyles = buildDateStyleSet(dec('xl/styles.xml'));

  // 找第一个工作表
  const wbXml = dec('xl/workbook.xml');
  const relXml = dec('xl/_rels/workbook.xml.rels');
  let target = 'xl/worksheets/sheet1.xml';
  let sheetName = 'Sheet1';
  const sm = /<sheet\b[^>]*name="([^"]*)"[^>]*r:id="([^"]*)"/.exec(wbXml)
          || /<sheet\b[^>]*r:id="([^"]*)"[^>]*name="([^"]*)"/.exec(wbXml);
  if (sm) {
    sheetName = decodeXml(sm[1].startsWith('rId') ? sm[2] : sm[1]);
    const rid = sm[1].startsWith('rId') ? sm[1] : sm[2];
    const rm = new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]*)"`).exec(relXml);
    if (rm) {
      let t = rm[1].replace(/^\//, '');
      target = t.startsWith('xl/') ? t : 'xl/' + t;
    }
  }
  if (!files[target]) {
    const k = Object.keys(files).find((n) => /^xl\/worksheets\/.*\.xml$/.test(n));
    if (!k) throw new Error('xlsx 中未找到工作表');
    target = k;
  }
  return { sheetName, rows: parseSheet(files[target].toString('utf8'), shared, dateStyles) };
}

/* ---------------- CSV 解析 ---------------- */
function parseCsv(text) {
  const rows = [];
  let row = [], cur = '', q = false;
  const s = text.replace(/^\uFEFF/, '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) {
      if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; }
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}

/* ---------------- 表头映射 ---------------- */
const FIELD_ALIASES = {
  user_id:         ['用户id', '用户 id', 'userid', '会员id', '代理id'],
  nickname:        ['昵称', '微信昵称', '用户昵称'],
  name:            ['姓名', '真实姓名', '名字'],
  agent_level:     ['代理等级', '等级', '身份等级'],
  period:          ['业绩周期', '周期', '统计周期', '月份', '结算周期'],
  senior_id:       ['归属高级id', '归属高级 id', '上级id', '高级id'],
  senior_nickname: ['归属高级昵称', '上级昵称', '高级昵称'],
  senior_name:     ['归属高级姓名', '上级姓名', '高级姓名'],
  phone:           ['电话', '手机号', '手机', '联系电话', '归属高级电话', '高级电话'],
  senior_level:    ['归属高级等级', '上级等级', '高级等级'],
  amount:          ['金额', '业绩金额', '销售额', '业绩'],
  commission:      ['佣金', '提成', '分佣'],
};

function normHeader(h) {
  return String(h == null ? '' : h)
    .replace(/^\uFEFF/, '')
    .replace(/[\s\u00A0]/g, '')
    .replace(/[（）()：:]/g, '')
    .toLowerCase();
}

function mapHeaders(headerRow) {
  const map = {};
  const missing = [];
  const normed = headerRow.map(normHeader);
  for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
    let idx = -1;
    for (const a of aliases) {
      const na = normHeader(a);
      idx = normed.findIndex((h) => h === na);
      if (idx >= 0) break;
    }
    if (idx < 0) {
      for (const a of aliases) {          // 退化为包含匹配
        const na = normHeader(a);
        idx = normed.findIndex((h) => h && (h.includes(na) || na.includes(h)));
        if (idx >= 0) break;
      }
    }
    if (idx < 0) missing.push(field); else map[field] = idx;
  }
  return { map, missing };
}

/* ---------------- 值清洗 ---------------- */
const NA_TOKENS = new Set(['#n/a', '#na', 'n/a', 'na', '#value!', '#ref!', '#name?', '#null!', '#div/0!', '-', '无', 'null', 'none', 'undefined', '']);

function cleanPhone(v) {
  const raw = String(v == null ? '' : v).trim();
  if (NA_TOKENS.has(raw.toLowerCase())) return { phone: '', raw: raw || '#N/A' };
  let d = raw.replace(/[^\d]/g, '');
  if (d.length === 13 && d.startsWith('86')) d = d.slice(2);
  if (d.length === 14 && d.startsWith('0086')) d = d.slice(4);
  if (/^1[3-9]\d{9}$/.test(d)) return { phone: d, raw };
  return { phone: '', raw: raw || '#N/A' };
}

function cleanNumber(v) {
  if (v == null || v === '') return 0;
  const s = String(v).replace(/[,¥\s元]/g, '');
  if (NA_TOKENS.has(s.toLowerCase())) return 0;
  const n = Number(s);
  return isNaN(n) ? 0 : n;
}

function cleanPeriod(v) {
  let s = String(v == null ? '' : v).trim();
  if (!s) return '';
  if (/^\d+(\.\d+)?$/.test(s) && Number(s) > 20000 && Number(s) < 80000) return serialToDate(Number(s));
  s = s.replace(/[年月]/g, '-').replace(/日/g, '').replace(/\//g, '-');
  const m = /(\d{4})-(\d{1,2})(?:-(\d{1,2}))?/.exec(s);
  if (m) {
    const p = (x) => String(x).padStart(2, '0');
    return `${m[1]}-${p(m[2])}-${p(m[3] || 1)}`;
  }
  return s.slice(0, 20);
}

function cleanText(v) {
  const s = String(v == null ? '' : v).trim();
  return NA_TOKENS.has(s.toLowerCase()) && s !== '' ? s : s;
}

/**
 * 统一入口：Buffer(xlsx) 或 字符串(csv) -> 结构化记录
 */
function parseWorkbookToRecords(buf, filename) {
  let grid;
  if (/\.csv$/i.test(filename || '')) {
    grid = parseCsv(buf.toString('utf8'));
  } else {
    grid = parseXlsx(buf).rows;
  }
  grid = grid.filter((r) => Array.isArray(r));

  // 找表头行（前 10 行内命中字段最多的一行）
  let headerIdx = -1, best = null, bestScore = -1;
  for (let i = 0; i < Math.min(grid.length, 10); i++) {
    const { map, missing } = mapHeaders(grid[i] || []);
    const score = Object.keys(map).length;
    if (score > bestScore) { bestScore = score; best = { map, missing }; headerIdx = i; }
  }
  if (!best || bestScore < 6) {
    throw new Error('未识别到有效表头，请确认第一行是 12 个标准字段名（用户ID、昵称、姓名、代理等级、业绩周期、归属高级ID、归属高级昵称、归属高级姓名、电话、归属高级等级、金额、佣金）');
  }
  if (best.missing.length) {
    const cn = { user_id: '用户ID', nickname: '昵称', name: '姓名', agent_level: '代理等级', period: '业绩周期', senior_id: '归属高级ID', senior_nickname: '归属高级昵称', senior_name: '归属高级姓名', phone: '电话', senior_level: '归属高级等级', amount: '金额', commission: '佣金' };
    throw new Error('Excel 缺少必需列：' + best.missing.map((f) => cn[f] || f).join('、'));
  }

  const map = best.map;
  const at = (row, f) => (map[f] != null ? row[map[f]] : '');
  const records = [];
  const invalid = [];

  for (let i = headerIdx + 1; i < grid.length; i++) {
    const row = grid[i] || [];
    if (!row.length || row.every((c) => String(c ?? '').trim() === '')) continue;

    const userId = cleanText(at(row, 'user_id'));
    const period = cleanPeriod(at(row, 'period'));
    if (!userId && !period) continue;

    if (!userId) { invalid.push({ line: i + 1, reason: '用户ID为空' }); continue; }
    if (!period) { invalid.push({ line: i + 1, reason: '业绩周期为空或无法识别' }); continue; }

    const ph = cleanPhone(at(row, 'phone'));
    records.push({
      user_id: userId,
      nickname: cleanText(at(row, 'nickname')),
      name: cleanText(at(row, 'name')),
      agent_level: cleanText(at(row, 'agent_level')),
      period,
      senior_id: cleanText(at(row, 'senior_id')),
      senior_nickname: cleanText(at(row, 'senior_nickname')),
      senior_name: cleanText(at(row, 'senior_name')),
      phone: ph.phone,
      phone_raw: ph.raw,
      senior_level: cleanText(at(row, 'senior_level')),
      amount: cleanNumber(at(row, 'amount')),
      commission: cleanNumber(at(row, 'commission')),
      _line: i + 1,
    });
  }
  return { records, invalid, headerIdx };
}

module.exports = { parseWorkbookToRecords, parseXlsx, parseCsv, cleanPhone, cleanPeriod, cleanNumber };
