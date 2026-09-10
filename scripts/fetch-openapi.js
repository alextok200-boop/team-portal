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

   权限要求：应用需开通「AI 表格应用读权限」并已发布。

   接口（钉钉开放平台）：
     - access_token: POST /v1.0/oauth2/accessToken
     - 字段列表:     GET  /v1.0/notable/bases/{baseId}/sheets/{sheetId}/fields?operatorId=
     - 记录列表:     POST /v1.0/notable/bases/{baseId}/sheets/{sheetId}/records/list?operatorId=
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

/* ── 抓取的表（key → 表 ID / 中文名 / 分组）──────────────── */
const TABLES = [
  { key: 'overview',    id: '3a6wqi6k4dsbe617zhkre', name: '1.日报总览',           group: '总览' },
  { key: 'domestic',    id: 'lb3j254h8wqiur8qchavd', name: '2.分店铺日报（国内）', group: '分店铺' },
  { key: 'crossborder', id: 'Nra7g5p',                name: '2.分店铺日报（跨境）', group: '分店铺' },
  { key: 'ads',         id: 'p8b405p6gt2jgntr1ul26',  name: '3.投放日报',           group: '投放' },
  { key: 'content',     id: '6z8rcxay1hhhv4xmbbc89',  name: '4.内容达人日报',       group: '内容' },
  { key: 'traffic',     id: '56p4no5umzcmokaaefh63',  name: '5.流量竞品日报',       group: '流量' },
  { key: 'supply',      id: 'v5wnul31vkbcdwulr9v0b',  name: '6.供应链客服日报',     group: '供应链' },
  { key: 'team',        id: 'hcxjxotvzquyybjr9kvvi',  name: '7.团队战力评估',       group: '团队' },
  { key: 'perf',        id: 'mVmsNph',                name: '15.负责人业绩日报',    group: '业绩' }
];

/* ── HTTP 封装 ──────────────────────────────────────────── */
async function http(method, url, body, token) {
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
  let nameOf = {};
  try {
    const fr = await http('GET',
      API + '/notable/bases/' + BASE_ID + '/sheets/' + t.id + '/fields?operatorId=' + OPERATOR_ID,
      undefined, token);
    const fields = (fr && fr.value) || [];
    fields.forEach(function (f) { if (f && f.id) nameOf[f.id] = f.name; });
  } catch (e) {
    console.warn('  [警告] 字段读取失败 ' + t.name + '：' + e.message.split('\n')[0]);
  }

  // 2. 记录列表（分页）
  const rows = [];
  let nextToken = '';
  let guard = 0;
  do {
    const body = { maxResults: 100 };
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
      rows.push(o);
    });
    nextToken = (rr && rr.nextToken) || '';
    if (++guard > 50) break; // 安全上限
  } while (nextToken);

  return {
    key: t.key, name: t.name, group: t.group, tableId: t.id,
    fieldCount: Object.keys(nameOf).length, rowCount: rows.length,
    columns: Object.values(nameOf), rows: rows
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

  console.log('钉钉日报抓取 · ' + SOURCE_NAME + '（baseId=' + BASE_ID + '）\n');
  const token = await getToken();
  console.log('access_token 获取成功\n');

  const results = [];
  let totalRows = 0, okTables = 0;

  for (let i = 0; i < TABLES.length; i++) {
    const t = TABLES[i];
    process.stdout.write('  [' + (i + 1) + '/' + TABLES.length + '] ' + t.name + ' ... ');
    try {
      const r = await fetchTable(token, t);
      results.push(r);
      totalRows += r.rowCount;
      if (r.rowCount > 0) okTables++;
      console.log(r.rowCount + ' 行 / ' + r.fieldCount + ' 字段');
    } catch (e) {
      console.log('失败：' + e.message.split('\n')[0]);
      results.push({ key: t.key, name: t.name, group: t.group, tableId: t.id, fieldCount: 0, rowCount: 0, columns: [], rows: [] });
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
    limitPerTable: 100,
    tableCount: results.length,
    okTables: okTables,
    totalRows: totalRows,
    tables: results
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2), 'utf8');

  console.log('\n完成：' + okTables + '/' + results.length + ' 张表有数据，共 ' + totalRows + ' 行');
  console.log('已写入：' + OUT_FILE + '\n');
})().catch(function (e) {
  console.error('\n[异常] ' + e.message + '\n');
  process.exit(1);
});
