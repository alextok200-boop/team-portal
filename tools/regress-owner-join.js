#!/usr/bin/env node
/* ============================================================
   regress-owner-join.js —— 「负责人」派生列回归（第 5 套）

   为什么需要这一套：
     看板第 9 张表（15.负责人业绩日报）原来 17 行「负责人」全是「—」。
     真因不是前端 bug，而是 **源表侧没有这一列**：perf 源表只有一个
     filterUp（查找引用）字段「负责人_自动匹配」，而钉钉 OpenAPI 会把
     filterUp / formula 整类字段静默过滤掉（perf 源表 15 字段 → 快照 14，
     overview 源表 55 → 快照 7，其余 7 表一个不缺）。前端拿不到，只能显示「—」。

     修法是在抓取侧派生：多抓一张普通表「11.店铺负责人」，按「平台」相等
     把负责人拼到 perf 行上（复现源表自己那条引用规则）。这条链路横跨
       fetch-openapi.js（抓+派生） → data/daily.json（快照） → board.js（渲染+钻取）
     → pages/tables.html（落点+搜索），任何一环断掉，用户看到的又是「—」，
     而且**静默**——页面不会报错。所以这里三层都断言：

     A. 派生逻辑单测（纯函数，合成夹具，不依赖网络/快照）
        —— 去重、保序、同平台多行、对照表缺该平台、空平台不污染映射、
           任一表缺失/失败 → 返回 null（宁可不给，不给错的）。
     B. 快照一致性（读 data/daily.json）
        —— 拿快照里的 owners 行**重新推一遍**，与快照里 perf 行的「负责人」
           逐行比对；再核对 ownerJoin.filled 与溯源字段。
           （快照尚未重抓时记 PENDING，不算通过 —— 见汇总行。）
     C. 真实渲染 + 钻取落点（浏览器，临时换入夹具快照，跑完还原）
        —— 多负责人平台拼成「A / B」、对照表缺的平台仍优雅显示「—」、
           data-href 带 q= 且能落到 tables.html 并回填搜索框、
           快照没有该列时页面**显式提示**而不是默不作声地一片「—」。

   前置：仓库父目录起静态服务（默认 8971，建议 PORTAL_BASE 指到 8973）
   运行：NODE_PATH=... node tools/regress-owner-join.js
   ============================================================ */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const fetchScript = require(path.join(__dirname, '..', 'scripts', 'fetch-openapi.js'));
const deriveOwners = fetchScript.deriveOwners;

const BASE = (process.env.PORTAL_BASE || 'http://127.0.0.1:8971/team-portal').replace(/\/$/, '');
const DAILY = path.join(__dirname, '..', 'data', 'daily.json');
const SHARED_USER = process.env.ADMIN_USER || 'admin';
const SHARED_PASS = process.env.ADMIN_PASS || 'admin2026';

let pass = 0, fail = 0, pending = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}
function note(msg) { pending++; console.log('  ⏳ ' + msg); }

/* ══════════ A. 派生逻辑单测（合成夹具） ══════════ */
function fixtureTables(ownersRows, perfRows, mutate) {
  const t = {
    owners: { key: 'owners', name: '11.店铺负责人', tableId: 'jLVFycP', columns: ['店铺全名', '平台', '负责人'], rows: ownersRows.slice() },
    perf: { key: 'perf', name: '15.负责人业绩日报', tableId: 'mVmsNph', columns: ['日期', '平台', '区域', 'GMV'], rows: perfRows.slice() }
  };
  if (mutate) mutate(t);
  return [t.owners, t.perf];
}

function unitTests() {
  console.log('\nA. 派生逻辑单测（deriveOwners，合成夹具）');

  // 淘宝 3 行（杨秋 重复）→ 去重保序；TEMU 2 行；eBay 负责人为空；空平台行不得污染映射
  const ownersRows = [
    { 平台: '淘宝', 负责人: '杨秋' },
    { 平台: '淘宝', 负责人: '曹伟' },
    { 平台: '淘宝', 负责人: '杨秋' },
    { 平台: 'TEMU', 负责人: '丁杨' },
    { 平台: 'TEMU', 负责人: '崔羽' },
    { 平台: 'eBay', 负责人: '' },
    { 平台: '', 负责人: '孤儿' },
    { 店铺全名: '某店' }
  ];
  const perfRows = [
    { 平台: '淘宝', GMV: '100' },
    { 平台: 'TEMU', GMV: '200' },
    { 平台: 'eBay', GMV: '300' },
    { 平台: '从未出现在对照表', GMV: '400' },
    { 平台: '淘宝', GMV: '500' }
  ];
  const real = deriveOwners(fixtureTables(ownersRows, perfRows));

  check('返回派生元信息（不是 null）', !!real);
  check('多负责人去重 + 保首次出现顺序 →「杨秋 / 曹伟」',
        !!real && real.byPlatform['淘宝'] && real.byPlatform['淘宝'].join('/') === '杨秋/曹伟',
        real && JSON.stringify(real.byPlatform['淘宝']));
  check('同一平台的**多行**都被填充（淘宝 2 行，共 3 行命中）',
        !!real && real.filled === 3, real && ('filled=' + real.filled));
  check('filled === 命中行数、total === perf 总行数',
        !!real && real.filled === 3 && real.total === 5,
        real && (real.filled + '/' + real.total));
  check('对照表里负责人为空的平台（eBay）→ 不写该键（前端显示「—」）',
        !!real && real.byPlatform['eBay'] === undefined);
  check('对照表里根本没有的平台 → 不写该键',
        !!real && real.byPlatform['从未出现在对照表'] === undefined);
  check('空「平台」行不进映射（否则会用空串命中一片行）',
        !!real && Object.prototype.hasOwnProperty.call(real.byPlatform, '') === false,
        real && Object.keys(real.byPlatform).join(','));

  check('派生列名登记为「负责人」', !!real && real.column === '负责人');
  check('溯源信息保留「替代了源表哪个字段」',
        !!real && /负责人_自动匹配/.test(real.replaces || '') && /5PSjsAQ/.test(real.replaces || ''),
        real && real.replaces);
  check('溯源信息写明规则是按「平台」聚合', !!real && /平台/.test(real.rule || ''), real && real.rule);

  // columns 追加 & 幂等
  (function () {
    const p = { key: 'perf', name: 'p', tableId: 'x', columns: ['平台', 'GMV'], rows: [{ 平台: '淘宝', GMV: '100' }] };
    const o = { key: 'owners', name: 'o', tableId: 'y', columns: ['平台', '负责人'], rows: [{ 平台: '淘宝', 负责人: '杨秋' }] };
    deriveOwners([o, p]);
    check('「负责人」被追加进 perf.columns（否则 tables.html 不渲染这一列）',
          p.columns.indexOf('负责人') !== -1, JSON.stringify(p.columns));
    deriveOwners([o, p]);   // 再跑一次
    check('重复派生不会把「负责人」重复追加进 columns',
          p.columns.filter(function (c) { return c === '负责人'; }).length === 1,
          JSON.stringify(p.columns));
    check('派生只加「负责人」，不动其它列/其它键',
          p.columns.join(',') === '平台,GMV,负责人' && p.rows[0]['GMV'] === '100' && p.rows[0]['平台'] === '淘宝',
          JSON.stringify(p.rows[0]) + ' / ' + JSON.stringify(p.columns));
  })();

  // 缺表 / 失败 → 不派生（宁可不给，不给错的）
  const perfOnly = [{ key: 'perf', name: 'p', tableId: 'x', columns: ['平台'], rows: [{ 平台: '淘宝' }] }];
  check('缺 owners 表 → null（不猜、不报错）', deriveOwners(perfOnly) === null);
  const ownersOnly = [{ key: 'owners', name: 'o', tableId: 'y', columns: ['平台', '负责人'], rows: [{ 平台: '淘宝', 负责人: '杨秋' }] }];
  check('缺 perf 表 → null', deriveOwners(ownersOnly) === null);
  check('owners 抓取失败(error) → null', deriveOwners(fixtureTables(ownersRows, perfRows, function (t) { t.owners.error = 'boom'; })) === null);
  check('perf 抓取失败(error) → null', deriveOwners(fixtureTables(ownersRows, perfRows, function (t) { t.perf.error = 'boom'; })) === null);
  check('owners 表 0 行 → 派生成功但 filled=0（行数不突然变负数/异常）',
        (function () { const r = deriveOwners(fixtureTables([], perfRows)); return r && r.filled === 0; })());
}

/* ══════════ B. 快照一致性 ══════════ */
function snapshotTests() {
  console.log('\nB. 快照一致性（data/daily.json）');
  if (!fs.existsSync(DAILY)) { note('data/daily.json 不存在（未抓取过）'); return null; }
  const D = JSON.parse(fs.readFileSync(DAILY, 'utf8'));
  const tbl = (k) => (D.tables || []).filter(function (t) { return t.key === k; })[0];

  const perf = tbl('perf'), owners = tbl('owners');
  check('快照里抓到了 perf 表「15.负责人业绩日报」', !!perf);
  if (!perf) return D;

  /* owners 表要先抓过一次才会出现在快照里 —— 这是**待抓取**状态，不是缺陷。
     所以这里记 PENDING（不计入 PASS），并且直接返回：下面那些一致性断言
     没有 owners 就无从谈起，硬跑等于自己给自己发绿。抓取跑完重跑本套即为 0。 */
  if (!owners) {
    note('快照尚未包含 owners 表「11.店铺负责人」→ B 段其余一致性断言本次不生效' +
         '（当前 tables=' + (D.tables || []).map(function (t) { return t.key; }).join(',') + '）');
    return D;
  }
  check('快照里抓到了 owners 表「11.店铺负责人」', owners.rowCount > 0, 'rowCount=' + owners.rowCount);
  check('perf 表 columns 含「负责人」', (perf.columns || []).indexOf('负责人') !== -1,
        JSON.stringify(perf.columns || []));
  check('快照带有 ownerJoin 溯源对象（谁都能从发布的数据里看出这列怎么来的）', !!D.ownerJoin);

  /* 用快照里的 owners 行**重推一遍**，与快照里 perf 行的「负责人」逐行比对。
     规则与 scripts/fetch-openapi.js 的 deriveOwners 一致（同样的跳过条件），
     所以任一处被改坏都会被这里抓住。 */
  const byPlatform = {};
  owners.rows.forEach(function (r) {
    const pf = r['平台'], ow = r['负责人'];
    if (!pf || !ow) return;
    if (!byPlatform[pf]) byPlatform[pf] = [];
    if (byPlatform[pf].indexOf(ow) === -1) byPlatform[pf].push(ow);
  });
  let mismatch = [], filled = 0, expectFilled = 0, orphan = [];
  perf.rows.forEach(function (r) {
    const exp = (byPlatform[r['平台']] || []).join(' / ');
    const got = r['负责人'] || '';
    if (exp) expectFilled++;
    if (got) filled++;
    if (exp !== got) mismatch.push((r['平台'] || '?') + ' 期望「' + exp + '」实得「' + got + '」');
    if (got && !exp) orphan.push((r['平台'] || '?') + ' → ' + got);
  });

  check('perf 每行的「负责人」都能由 owners 行重推出来（0 条不一致）',
        mismatch.length === 0, mismatch.slice(0, 5).join(' | '));
  check('没有凭空冒出的负责人（对照表里没有该平台，却带了值）',
        orphan.length === 0, orphan.slice(0, 5).join(' | '));
  check('ownerJoin.filled 与实测填充行数、应有行数三者一致',
        !!D.ownerJoin && D.ownerJoin.filled === filled && D.ownerJoin.filled === expectFilled,
        D.ownerJoin ? ('meta=' + D.ownerJoin.filled + ' 实测=' + filled + ' 应有=' + expectFilled) : '无 ownerJoin');
  check('确实填上了（不是 0 行——否则等于没修）', filled > 0, 'filled=' + filled);
  check('对照表里查不到负责人的平台行保持为空（不硬编「未知」等假值）',
        perf.rows.filter(function (r) { return !byPlatform[r['平台']] && r['负责人']; }).length === 0);

  return D;
}

/* ══════════ C. 真实渲染 + 钻取落点 ══════════ */
function buildFixture(D) {
  /* 夹具策略：拿**真实快照**当底，只把 owners 表的行换成"按 perf 平台生成的确定值"，
     再走真实 deriveOwners 派生 —— 这样既证明链路通，又不把业务名单写死进测试文件。
       · 平台 A：故意给两个不同负责人 → 断言拼成「A / B」
       · 平台 B：故意不给 owners 行     → 断言仍优雅显示「—」
       · 其余平台：一人一条
     这一步测的是「快照→渲染→钻取」这条链，与真实名单是谁无关。 */
  const perf = (D.tables || []).filter(function (t) { return t.key === 'perf'; })[0];
  if (!perf) throw new Error('快照无 perf 表');
  const platforms = [];
  perf.rows.forEach(function (r) { if (r['平台'] && platforms.indexOf(r['平台']) === -1) platforms.push(r['平台']); });
  if (platforms.length < 3) throw new Error('perf 平台数不足，夹具构造不了：' + platforms.length);

  const multi = platforms[0], missing = platforms[1];
  const ownersRows = [];
  platforms.forEach(function (p) {
    if (p === multi) {
      ownersRows.push({ 平台: p, 负责人: '多负责人甲' });
      ownersRows.push({ 平台: p, 负责人: '多负责人乙' });
      return;
    }
    if (p === missing) return;
    ownersRows.push({ 平台: p, 负责人: '负责人·' + p });
  });

  const out = JSON.parse(JSON.stringify(D));
  /* ⚠️ 必须先清掉原快照里 perf 行上已有的「负责人」，再按夹具设计重建。
     否则真实快照一旦带上该列（v1.7.7 抓过之后就是这样），被故意留空的
     「missing」平台仍会顶着真实值，夹具的预期全部落空 —— 2026-09-16 真栽过：
     4 条断言红，红的是夹具的假设，不是产品。 */
  const outPerf = out.tables.filter(function (t) { return t.key === 'perf'; })[0];
  outPerf.rows.forEach(function (r) { delete r['负责人']; });
  outPerf.columns = (outPerf.columns || []).filter(function (c) { return c !== '负责人'; });

  const tables = out.tables.filter(function (t) { return t.key !== 'owners'; });
  tables.splice(tables.length - 1, 0, {
    key: 'owners', name: '11.店铺负责人', group: '负责人', tableId: 'jLVFycP',
    fieldCount: 3, rowCount: ownersRows.length, rawRows: ownersRows.length, droppedEmptyRows: 0,
    truncated: false, pagesFetched: 1, columns: ['店铺全名', '平台', '负责人'], rows: ownersRows
  });
  out.tables = tables;
  out.ownerJoin = deriveOwners(out.tables);
  /* 故意让 missing 这个平台在对照表里查不到 → 断言它回退成「平台 · 区域」 */
  const missRow = perf.rows.filter(function (r) { return r['平台'] === missing; })[0] || {};
  out._fixture = {
    multi: multi,
    missing: missing,
    expectMulti: '多负责人甲 / 多负责人乙',
    missingLabel: missing + (missRow['区域'] ? ' · ' + missRow['区域'] : ''),
    /* missing 平台在 perf 里有几行，就会有几行显示「—」 */
    expectDash: perf.rows.filter(function (r) { return r['平台'] === missing; }).length
  };
  return out;
}

function fixtureWithoutOwners(D) {
  /* 模拟「抓取侧还没派生过」的快照：owners 表、ownerJoin、perf 的「负责人」列**三样都没有**。
     只删 owners 而留着负责人列，是模拟不出来的（页面照旧有名字，提示自然不该出）。 */
  const out = JSON.parse(JSON.stringify(D));
  out.tables = out.tables.filter(function (t) { return t.key !== 'owners'; });
  const p = out.tables.filter(function (t) { return t.key === 'perf'; })[0];
  if (p) {
    p.rows.forEach(function (r) { delete r['负责人']; });
    p.columns = (p.columns || []).filter(function (c) { return c !== '负责人'; });
  }
  out.ownerJoin = null;
  return out;
}

async function browserTests(D) {
  console.log('\nC. 真实渲染 + 钻取落点（浏览器，临时夹具快照）');

  const original = fs.readFileSync(DAILY, 'utf8');
  let browser = null;
  const restore = function () { fs.writeFileSync(DAILY, original, 'utf8'); };
  /* BASE 已含站点根（如 /team-portal），href 是站内绝对路径，按 pathname 前缀剥即可，
     不写死 '/team-portal' —— 换端口/换子路径时断言不该跟着坏。 */
  const basePath = new URL(BASE).pathname.replace(/\/$/, '');

  try {
    browser = await puppeteer.launch(Object.assign({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] }));
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 1000 });

    async function login(p) {
      await p.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
      try { await p.waitForSelector('#username', { timeout: 8000 }); }
      catch (e) { return { ok: false, msg: '登录页被重定向（已有会话未清）' }; }
      await p.evaluate(function () { localStorage.clear(); });
      await p.reload({ waitUntil: 'domcontentloaded' });
      await p.waitForSelector('#username', { timeout: 8000 });
      await p.type('#username', SHARED_USER);
      await p.type('#password', SHARED_PASS);
      await p.click('#submitBtn');
      const t0 = Date.now();
      while (Date.now() - t0 < 8000) {
        let url = '';
        try { url = await p.evaluate(function () { return location.pathname; }); } catch (e) {
          if (/context was destroyed|navigation/i.test(String(e))) return { ok: true };
          throw e;
        }
        if (url.indexOf('/pages/') !== -1 || /dashboard/.test(url)) return { ok: true, url: url };
        await new Promise(function (r) { setTimeout(r, 150); });
      }
      return { ok: false, msg: '登录超时' };
    }

    /* ── C1. 有 owners：负责人列真实、多负责人拼接、缺对照表的行优雅降级 ── */
    const fx = buildFixture(D);
    fs.writeFileSync(DAILY, JSON.stringify(fx, null, 2), 'utf8');
    const lr = await login(page);
    check('登录成功（C 段前置）', lr.ok, JSON.stringify(lr));
    await page.goto(BASE + '/pages/board.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#perfRows tr', { timeout: 20000 });
    await page.waitForFunction(function () {
      var t = document.getElementById('perfRows');
      return t && t.textContent.indexOf('加载中') === -1 && t.querySelectorAll('tr').length > 0;
    }, { timeout: 20000 });

    const cells = await page.evaluate(function () {
      var out = [];
      document.querySelectorAll('#perfRows tr').forEach(function (tr) {
        out.push({
          name: tr.cells[0] ? tr.cells[0].textContent.trim() : '',
          platform: tr.cells[1] ? tr.cells[1].textContent.trim() : '',
          href: tr.getAttribute('data-href') || ''
        });
      });
      return out;
    });
    const names = cells.map(function (c) { return c.name; });
    const dashCount = names.filter(function (n) { return n === '—'; }).length;

    check('负责人列不再是满屏「—」（' + cells.length + ' 行中 ' + dashCount + ' 行为「—」，夹具预期 ' + fx._fixture.expectDash + '）',
          cells.length > 0 && dashCount === fx._fixture.expectDash && dashCount < cells.length,
          JSON.stringify(names.slice(0, 6)));
    check('多负责人平台拼成「多负责人甲 / 多负责人乙」',
          names.indexOf(fx._fixture.expectMulti) !== -1, JSON.stringify(names.slice(0, 8)));
    check('对照表里没有的平台（' + fx._fixture.missing + '）仍优雅显示「—」，不报错、不写假值',
          names.filter(function (n, i) { return cells[i].platform === fx._fixture.missing; })
            .every(function (n) { return n === '—'; }),
          JSON.stringify(cells.filter(function (c) { return c.platform === fx._fixture.missing; })));
    check('负责人行的钻取链接是站内绝对路径 + 带 q= 关键词',
          cells.filter(function (c) { return c.name !== '—'; })
            .every(function (c) { return c.href.indexOf(basePath + '/pages/tables.html?table=perf&q=') === 0; }),
          JSON.stringify(cells.filter(function (c) { return c.name !== '—'; }).slice(0, 2)));

    /* 图④ 的 y 轴：改前只有「平台 · 区域」，图上根本看不出这是**谁**的业绩，
       而那一块的标题偏偏是「各负责人 GMV 与净利润」。
       夹具里故意留了一个「对照表查不到负责人」的平台，所以这里要验证的是
       **两种走法各就各位**：有负责人的 → 负责人领衔；没有的 → 回退「平台 · 区域」。 */
    const axis = await page.evaluate(function () {
      try {
        var inst = echarts.getInstanceByDom(document.getElementById('chartPerf'));
        return inst ? (inst.getOption().yAxis[0].data || []) : null;
      } catch (e) { return null; }
    });
    const withOwner = (axis || []).filter(function (s) {
      return s.indexOf('负责人·') === 0 || s.indexOf(fx._fixture.expectMulti + ' · ') === 0;
    });
    const fallback = (axis || []).filter(function (s) { return / · (国内|跨境)$/.test(s); });
    check('图④ y 轴以「负责人 · 平台」领衔（多负责人平台亦然）',
          !!axis && axis.some(function (s) { return s.indexOf(fx._fixture.expectMulti + ' · ') === 0; }),
          JSON.stringify(axis));
    check('图④ y 轴只有「无负责人」的平台才用旧写法「平台 · 区域」（两类恰好互补）',
          !!axis && withOwner.length > 0 && withOwner.length + fallback.length === axis.length,
          'withOwner=' + withOwner.length + ' fallback=' + fallback.length + ' total=' + (axis || []).length);
    check('图④ y 轴：无负责人的平台回退标签与夹具预期一致（' + fx._fixture.missingLabel + '）',
          fallback.indexOf(fx._fixture.missingLabel) !== -1, JSON.stringify(fallback));
    check('图④ y 轴没有空标签（回退兜底真的兜住了）',
          !!axis && axis.every(function (s) { return s && s.length > 1; }), JSON.stringify(axis));

    /* ── C2. 点它，落到 tables.html 且关键词回填、搜索真的命中 ── */
    const target = cells.filter(function (c) { return c.name !== '—'; })[0];
    if (target) {
      const rel = target.href.indexOf(basePath) === 0 ? target.href.slice(basePath.length) : target.href;
      await page.goto(BASE + rel, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('#tableTabs .tab', { timeout: 20000 });
      await page.waitForFunction(function () {
        var t = document.getElementById('tbody');
        return t && t.textContent.indexOf('加载中') === -1;
      }, { timeout: 20000 });
      const st = await page.evaluate(function () {
        return {
          url: location.pathname + location.search,
          active: (function () { var t = document.querySelector('#tableTabs .tab.active'); return t ? t.textContent.trim() : ''; })(),
          search: document.getElementById('search') ? document.getElementById('search').value : '',
          meta: document.getElementById('rowMeta') ? document.getElementById('rowMeta').textContent : '',
          head: document.getElementById('thead') ? document.getElementById('thead').textContent : ''
        };
      });
      check('点负责人行落到 tables.html（URL 是 pages/tables.html，不是 404）',
            /\/pages\/tables\.html/.test(st.url), JSON.stringify(st.url));
      check('激活页签是「负责人业绩日报」', /负责人业绩日报/.test(st.active), JSON.stringify(st.active));
      check('搜索框回填了负责人名', st.search === target.name, JSON.stringify(st.search) + ' vs ' + target.name);
      check('搜索真的命中（rowMeta 显示匹配行数，不是"无匹配记录"）',
            /匹配\s*\d+\s*行/.test(st.meta), JSON.stringify(st.meta));
      check('表格表头里出现了「负责人」这一列（派生列进 columns 的直接证据）',
            /负责人/.test(st.head), JSON.stringify(st.head.slice(0, 160)));
    }

    /* ── C3. 没有该列的快照：页面必须显式提示，而不是静默一片「—」 ── */
    fs.writeFileSync(DAILY, JSON.stringify(fixtureWithoutOwners(D), null, 2), 'utf8');
    await page.goto(BASE + '/pages/board.html', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('#perfRows tr', { timeout: 20000 });
    await page.waitForFunction(function () {
      var t = document.getElementById('perfRows');
      return t && t.textContent.indexOf('加载中') === -1;
    }, { timeout: 20000 });
    const noOwner = await page.evaluate(function () {
      var s = document.getElementById('perfSummary');
      return { summary: s ? s.textContent : '', note: (document.getElementById('perfNote') || {}).textContent || '' };
    });
    check('快照缺「负责人」列时，负责人业绩区有显式提示（不静默显示「—」）',
          /负责人/.test(noOwner.summary + noOwner.note) && /(未含|没有|缺失|未取到|抓取)/.test(noOwner.summary + noOwner.note),
          JSON.stringify(noOwner));

    await page.close();
  } finally {
    restore();
    if (browser) await browser.close();
  }
}

/* ══════════ 主流程 ══════════ */
(async function () {
  console.log('══════ 「负责人」派生列回归 ══════');
  console.log(' BASE=' + BASE);

  unitTests();
  const D = snapshotTests();

  if (D) {
    const hasOwners = (D.tables || []).some(function (t) { return t.key === 'owners'; });
    if (!hasOwners) {
      note('快照里还没有 owners 表 → C 段夹具照跑（夹具自带 owners），' +
           'B 段「快照一致性」需等下一次抓取跑完才是真的（当前是 PENDING，不算通过）');
    }
    try {
      await browserTests(D);
    } catch (e) {
      fail++;
      console.log('  ❌ C 段浏览器用例异常：' + (e && e.message));
    }
  }

  console.log('\n══════ 汇总 ══════');
  console.log(' PASS: ' + pass + '   FAIL: ' + fail + '   PENDING: ' + pending);
  if (pending) console.log(' （PENDING = 依赖「下一次抓取」的快照状态，不算通过；抓取跑完重跑本套应为 0）');
  console.log(' data/daily.json 已还原（夹具未留在仓库里）');
  process.exit(fail ? 1 : 0);
})().catch(function (e) { console.error('脚本异常:', e); process.exit(1); });
