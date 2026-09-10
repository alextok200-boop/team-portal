#!/usr/bin/env node
/* ============================================================
   fetch-openapi.js —— 用钉钉 AI 表格 OpenAPI 抓取数据
   ------------------------------------------------------------
   供 GitHub Actions 定时调用（无需本机 dws 登录态）。
   凭证通过环境变量注入（GitHub Secrets）：

     DINGTALK_APP_KEY      钉钉企业内部应用 AppKey
     DINGTALK_APP_SECRET   钉钉企业内部应用 AppSecret
     DINGTALK_OPERATOR_ID  操作人 unionId（必填）
     DINGTALK_BASE_ID      多维表 ID（默认已填）
     DINGTALK_ROW_CAP      每表行数上限（可选，默认 4000）

   权限要求：应用需开通「AI 表格应用读权限」并已发布。

   接口（钉钉开放平台）：
     - access_token: POST /v1.0/oauth2/accessToken
     - 字段列表:     GET  /v1.0/notable/bases/{baseId}/sheets/{sheetId}/fields?operatorId=
     - 记录列表:     POST /v1.0/notable/bases/{baseId}/sheets/{sheetId}/records/list?operatorId=

   版本：v1.2.0（2026-09-10）
     · 行数上限 200 → 4000（原上限导致 domestic/crossborder/ads/content 四表被静默截断）
     · 新增 truncated / filledRows / error 元数据，截断与空表不再无声
     · HTTP 层加指数退避重试（网络抖动不再整表失败）
     · 截断改为精确切齐（原来会超上限最多 100 行）
   ============================================================ */

'use strict';

const fs = require('fs');
const path = require('path');

const API = 'https://api.dingtalk.com/v1.0';

/* ── 凭证（环境变量，缺一不可）──────────────────────────── */
const APP_KEY = process.env.DINGTALK_APP_KEY || '';
const APP_SECRET = process.env.DINGTALK_APP_SECRET || '';
const OPERATOR_ID = process.env.DINGTALK_OPERATOR_ID || '';
const BASE_ID = process.env.DINGTALK_BASE_ID || 'OG9lyrgJPzYDzl1ESvXRdpEYWzN67Mw4';

const SOURCE_NAME = '电商营销备战-日报追踪表';
const OUT_FILE = path.join(__dirname, '..', 'data', 'daily.json');

/* ── 抓取参数 ───────────────────────────────────────────── */
const PAGE_SIZE = 100;   // 单次请求条数（接口上限 100）

/* 上限分两层，这是关键设计：
     rawCap  —— 每表最多「扫描」多少原始行（含空白模板行）
     keepCap —— 每表最多「保留」多少有数据的行
   背景：日报追踪表里预建了整年的空白模板行（只有日期/星期/促销节点）。
   单一上限会让空白行挤占配额、把真数据截断 —— 200 行上限时国内表只捞到
   24 条有效记录，而实际有 799 条。 */
const RAW_CAP = Number(process.env.DINGTALK_RAW_CAP || 4000);
const KEEP_CAP = Number(process.env.DINGTALK_KEEP_CAP || 8000);
/* 丢弃「只有结构字段、无任何数值/文本」的空白模板行（默认丢；DINGTALK_DROP_EMPTY=0 可保留） */
const DROP_EMPTY = process.env.DINGTALK_DROP_EMPTY !== '0';
const RETRY = 3;                 // 单请求最大尝试次数
const RETRY_BASE_MS = 800;

/* ── 抓取的表（key → 表 ID / 中文名 / 分组 / 可选 rawCap）── */
const TABLES = [
  { key: 'overview',    id: '3a6wqi6k4dsbe617zhkre', name: '1.日报总览',           group: '总览' },
  { key: 'domestic',    id: 'lb3j254h8wqiur8qchavd', name: '2.分店铺日报（国内）', group: '分店铺', rawCap: 16000 },
  { key: 'crossborder', id: 'Nra7g5p',               name: '2.分店铺日报（跨境）', group: '分店铺', rawCap: 24000 },
  { key: 'ads',         id: 'p8b405p6gt2jgntr1ul26', name: '3.投放日报',           group: '投放' },
  { key: 'content',     id: '6z8rcxay1hhhv4xmbbc89', name: '4.内容达人日报',       group: '内容' },
  { key: 'traffic',     id: '56p4no5umzcmokaaefh63', name: '5.流量竞品日报',       group: '流量' },
  { key: 'supply',      id: 'v5wnul31vkbcdwulr9v0b', name: '6.供应链客服日报',     group: '供应链' },
  { key: 'team',        id: 'hcxjxotvzquyybjr9kvvi', name: '7.团队战力评估',       group: '团队' },
  { key: 'perf',        id: 'mVmsNph',               name: '15.负责人业绩日报',    group: '业绩' }
];

/* 结构字段：只填这些的行算「空占位行」（表里预建了整年的日期行） */
const STRUCTURAL = ['日期', '星期', '促销节点', '店铺', '店铺名', '平台', '备注', '父记录', '评估周'];

/* ── 工具 ───────────────────────────────────────────────── */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isRetriable(msg) {
  return /HTTP (5\d\d|429)|fetch failed|ETIMEDOUT|ECONNRESET|EAI_AGAIN|network|socket hang up/i.test(String(msg));
}

function isNumericCell(v) {
  if (typeof v === 'number') return true;
  return /^-?\d+(\.\d+)?$/.test(String(v == null ? '' : v).trim());
}

/* 「有效行」= 至少有一个数值字段非空且非 0 */
function rowHasData(row) {
  const keys = Object.keys(row);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (STRUCTURAL.indexOf(k) !== -1) continue;
    const v = row[k];
    if (v === null || v === undefined || v === '') continue;
    if (isNumericCell(v) && Number(v) !== 0) return true;
    if (!isNumericCell(v)) return true;   // 非数值但有内容（状态/文本）也算有数据
  }
  return false;
}

/* ── HTTP 封装（带重试）─────────────────────────────────── */
async function httpOnce(method, url, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['x-acs-dingtalk-access-token'] = token;
  const opt = { method, headers };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const r = await fetch(url, opt);
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch (e) { json = null; }
  if (!r.ok || (json && json.code !== undefined && String(json.code) !== '0')) {
    throw new Error(method + ' ' + url + ' -> HTTP ' + r.status + ': ' + text.slice(0, 400));
  }
  return json;
}

async function http(method, url, body, token) {
  let lastErr;
  for (let i = 0; i < RETRY; i++) {
    try {
      return await httpOnce(method, url, body, token);
    } catch (e) {
      lastErr = e;
      if (!isRetriable(e.message) || i === RETRY - 1) throw e;
      const wait = RETRY_BASE_MS * Math.pow(2, i);
      console.warn('\n    ↻ 重试 ' + (i + 1) + '/' + (RETRY - 1) + '（' + wait + 'ms）：' + e.message.split('\n')[0]);
      await sleep(wait);
    }
  }
  throw lastErr;
}

/* ── 获取 access_token ───────────────────────────────────── */
async function getToken() {
  const r = await http('POST', API + '/oauth2/accessToken', { appKey: APP_KEY, appSecret: APP_SECRET });
  const t = r && r.accessToken;
  if (!t) throw new Error('获取 access_token 失败：' + JSON.stringify(r));
  return t;
}

/* ── 值提取（兼容多种字段值格式）────────────────────────── */
function cellValue(v) {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) {
    if (!v.length) return null;
    const flat = v.map(function (x) {
      if (x === null || x === undefined) return '';
      if (typeof x === 'object') return x.text || x.name || x.value || JSON.stringify(x);
      return String(x);
    }).filter(Boolean);
    return flat.length <= 1 ? (flat[0] || null) : flat.join(' / ');
  }
  if (typeof v === 'object') return v.text || v.name || v.value || JSON.stringify(v);
  return v;
}

/* ── 单表抓取 ───────────────────────────────────────────── */
async function fetchTable(token, t) {
  // 1. 字段列表（fieldId → fieldName）
  const nameOf = {};
  const fieldNames = [];
  try {
    const fr = await http('GET',
      API + '/notable/bases/' + BASE_ID + '/sheets/' + t.id + '/fields?operatorId=' + OPERATOR_ID,
      undefined, token);
    const fields = (fr && fr.value) || [];
    fields.forEach(function (f) { if (f && f.id) { nameOf[f.id] = f.name; fieldNames.push(f.name); } });
  } catch (e) {
    console.warn('  [警告] 字段读取失败 ' + t.name + '：' + e.message.split('\n')[0]);
  }

  // 2. 记录列表（分页扫描 + 双层上限：rawCap 控扫描量、keepCap 控保留量）
  const rawCap = t.rawCap || RAW_CAP;
  const rows = [];          // 保留的行（有数据的）
  let rawRows = 0;          // 扫描到的原始行数
  let droppedEmpty = 0;     // 被丢掉的空白模板行
  let nextToken = '';
  let pages = 0;
  let truncated = false;

  do {
    const body = { maxResults: PAGE_SIZE, calcFields: true };
    if (nextToken) body.nextToken = nextToken;
    const rr = await http('POST',
      API + '/notable/bases/' + BASE_ID + '/sheets/' + t.id + '/records/list?operatorId=' + OPERATOR_ID,
      body, token);
    const records = (rr && (rr.records || rr.value)) || [];
    records.forEach(function (rec) {
      const cells = rec.fields || rec.cells || rec;
      const o = {};
      Object.keys(cells || {}).forEach(function (fid) {
        if (fid === 'recordId' || fid === 'id') return;
        const key = nameOf[fid] || fid;
        const val = cellValue(cells[fid]);
        if (val !== null && val !== '' && val !== undefined) o[key] = val;
      });
      rawRows++;
      if (DROP_EMPTY && !rowHasData(o)) { droppedEmpty++; return; }
      rows.push(o);
    });
    nextToken = (rr && rr.nextToken) || '';
    pages++;

    if (rawRows >= rawCap) {                    // 扫描量到顶
      truncated = !!nextToken;
      break;
    }
    if (rows.length >= KEEP_CAP) {              // 保留量到顶
      if (rows.length > KEEP_CAP) rows.length = KEEP_CAP;
      truncated = true;
      break;
    }
  } while (nextToken);

  // 3. columns：基础字段 + 记录里出现的额外字段（公式/查找字段）
  const seen = {};
  const columns = fieldNames.slice();
  rows.forEach(function (r) {
    Object.keys(r).forEach(function (k) { if (!seen[k]) { seen[k] = true; if (fieldNames.indexOf(k) === -1) columns.push(k); } });
  });

  return {
    key: t.key, name: t.name, group: t.group, tableId: t.id,
    fieldCount: columns.length,
    rowCount: rows.length,            // 保留的行（有数据的）
    rawRows: rawRows,                 // 扫描到的原始行
    droppedEmptyRows: droppedEmpty,   // 丢掉的空白模板行
    truncated: truncated, pagesFetched: pages,
    columns: columns, rows: rows
  };
}

/* ── 主流程 ─────────────────────────────────────────────── */
(async function main() {
  if (!APP_KEY || !APP_SECRET) {
    console.error('缺少凭证：请设置 DINGTALK_APP_KEY / DINGTALK_APP_SECRET');
    process.exit(2);
  }
  if (!OPERATOR_ID) {
    console.error('缺少 DINGTALK_OPERATOR_ID（操作人 unionId）');
    process.exit(2);
  }

  console.log('钉钉日报抓取 · ' + SOURCE_NAME + '（baseId=' + BASE_ID + '）');
  console.log('扫描上限 rawCap=' + RAW_CAP + '（分店铺表另有 16000/24000）· 保留上限 keepCap=' + KEEP_CAP +
    ' · 空白模板行：' + (DROP_EMPTY ? '丢弃' : '保留') + ' · 单页 ' + PAGE_SIZE + ' 条\n');
  const token = await getToken();
  console.log('access_token 获取成功\n');

  const results = [];
  let totalRows = 0, okTables = 0, rawRowsTotal = 0, droppedEmptyTotal = 0;
  const failed = [], truncatedTables = [];

  for (let i = 0; i < TABLES.length; i++) {
    const t = TABLES[i];
    process.stdout.write('  [' + (i + 1) + '/' + TABLES.length + '] ' + t.name + ' ... ');
    try {
      const r = await fetchTable(token, t);
      results.push(r);
      totalRows += r.rowCount;
      rawRowsTotal += r.rawRows;
      droppedEmptyTotal += r.droppedEmptyRows;
      if (r.rowCount > 0) okTables++;
      if (r.truncated) truncatedTables.push(t.key);
      console.log(r.rowCount + ' 条有效（扫描 ' + r.rawRows + ' 行，丢空白 ' + r.droppedEmptyRows +
        '）/ ' + r.fieldCount + ' 字段' +
        (r.truncated ? '  ⚠ 已到上限，可能截断' : ''));
    } catch (e) {
      const msg = e.message.split('\n')[0];
      console.log('失败：' + msg);
      failed.push({ key: t.key, name: t.name, error: msg });
      results.push({
        key: t.key, name: t.name, group: t.group, tableId: t.id,
        fieldCount: 0, rowCount: 0, rawRows: 0, droppedEmptyRows: 0,
        truncated: false, columns: [], rows: [], error: msg
      });
    }
  }

  if (okTables === 0) {
    console.error('\n[失败] 所有表均未取到数据');
    process.exit(2);
  }

  const payload = {
    fetchedAt: new Date().toISOString(),
    fetchedAtLocal: new Date().toLocaleString('zh-CN', { hour12: false }),
    source: SOURCE_NAME,
    sourceUrl: 'https://alidocs.dingtalk.com/i/nodes/' + BASE_ID,
    baseId: BASE_ID,
    pageSize: PAGE_SIZE,
    limitPerTable: KEEP_CAP,              // 保留旧字段名（admin 页「每表上限」在用）
    keepCap: KEEP_CAP,
    rawCap: RAW_CAP,
    dropEmptyRows: DROP_EMPTY,
    tableCount: results.length,
    okTables: okTables,
    totalRows: totalRows,                 // 保留（有数据的）行数
    rawRowsTotal: rawRowsTotal,           // 扫描到的原始行数
    droppedEmptyRowsTotal: droppedEmptyTotal,
    truncatedTables: truncatedTables,
    complete: truncatedTables.length === 0 && failed.length === 0,
    failedTables: failed,
    tables: results
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2), 'utf8');

  console.log('\n完成：' + okTables + '/' + results.length + ' 张表有数据 · 保留 ' + totalRows +
    ' 条有效记录（扫描 ' + rawRowsTotal + ' 行，丢弃空白模板行 ' + droppedEmptyTotal + '）');
  if (truncatedTables.length) console.log('⚠ 被截断的表：' + truncatedTables.join(', ') +
    '（可调大 DINGTALK_RAW_CAP / 表级 rawCap）');
  if (failed.length) console.log('✗ 失败的表：' + failed.map(function (f) { return f.name; }).join(', '));
  console.log('已写入：' + OUT_FILE + '\n');
})().catch(function (e) {
  console.error('\n[异常] ' + e.message + '\n');
  process.exit(1);
});
