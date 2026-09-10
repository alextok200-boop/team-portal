#!/usr/bin/env node
/* ============================================================
   regress-content-flow.js —— 内容管理全链路回归

   为什么要脚本：
     内容管理和账号一样，改动**默认只落在本机 localStorage**，
     必须在管理后台「导出内容配置」→ 覆盖仓库 data/content.json → 提交，
     同事才看得到。这个「本机能过、别人不能过」的差别肉眼测不出来。

   覆盖：
     ① 管理员新增 → 列表出现、来源标「待发布」
     ② 编辑 → 字段与 updatedAt 生效
     ③ 字段校验：空标题 / 非法类型 / 非法状态 / 非法链接 全部拒绝
     ④ 导出 payload 结构 + 只含差异条目
     ⑤ 仓库清单里的内容 → 全新浏览器（同事机器）以成员身份能看到  ← 核心
     ⑥ 成员只读：写接口全部 403，UI 无编辑按钮
     ⑦ 删除：本机条目直接消失；仓库条目走墓碑并进导出 deleted
     ⑧ 搜索 / 状态筛选
     ⑨ 共享清单 404 → 页面告警可见

   前置：仓库父目录起 python -m http.server 8971
   运行：node tools/regress-content-flow.js
   ⚠️ 会临时改写 data/content.json 写夹具，结束自动还原（异常路径也还原）。
   ============================================================ */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const BASE = (process.env.PORTAL_BASE || 'http://127.0.0.1:8971/team-portal').replace(/\/$/, '');
const CONTENT_FILE = path.join(REPO, 'data', 'content.json');

const SEED_ID = 'c_fixture';
const SEED_TITLE = '仓库里的示例内容';
const SEED_TIME = '2026-09-01T02:00:00.000Z';

const launchOpts = { headless: 'new', args: ['--no-sandbox'] };
if (process.env.CHROME_PATH) launchOpts.executablePath = process.env.CHROME_PATH;

const origContent = fs.readFileSync(CONTENT_FILE, 'utf8');
function seedFixture() {
  const payload = {
    version: 1,
    updatedAt: SEED_TIME,
    note: 'REGRESSION TEST FIXTURE — 测试结束会还原',
    deleted: [],
    items: [{
      id: SEED_ID, title: SEED_TITLE, type: '文档', status: '已发布',
      owner: '张三', channel: '天猫', body: '仓库里的内容要点', link: '',
      createdAt: SEED_TIME, updatedAt: SEED_TIME, author: '戴程鹏'
    }]
  };
  fs.writeFileSync(CONTENT_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}
function restoreFixture() { fs.writeFileSync(CONTENT_FILE, origContent, 'utf8'); }

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

async function apiLogin(page, u, p) {
  return page.evaluate((u, p) => API.post('/api/login', { username: u, password: p })
    .then(r => ({ ok: r.ok, error: r.error || null, role: r.user ? r.user.role : null })), u, p);
}
async function listContent(page) {
  return page.evaluate(() => API.get('/api/content').then(r => ({
    ok: r.ok, canEdit: r.canEdit, error: r.error || null,
    items: (r.items || []).map(x => ({
      id: x.id, title: x.title, type: x.type, status: x.status,
      source: x.source, owner: x.owner, channel: x.channel, link: x.link, updatedAt: x.updatedAt
    }))
  })));
}
async function openPage(browser, ctx) {
  const page = ctx ? await ctx.newPage() : await browser.newPage();
  await page.goto(BASE + '/pages/content.html', { waitUntil: 'domcontentloaded' });
  return page;
}

(async () => {
  seedFixture();
  let browser = null;
  try {
    browser = await puppeteer.launch(launchOpts);

    /* ① 管理员新增 */
    console.log('\n① 管理员新增内容');
    const ctxA = await browser.createBrowserContext();
    const page = await ctxA.newPage();
    await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
    let r = await apiLogin(page, 'admin', 'admin2026');
    check('admin 登录', r.ok, JSON.stringify(r));

    // 前面几组断言都走 API，但 ⑦⑧ 要在真实 DOM 上数行数/看提示条，
    // 所以管理员页面必须真的停在内容页（一直待在 login.html 会全空）
    await page.goto(BASE + '/pages/content.html', { waitUntil: 'domcontentloaded' });

    let lst = await listContent(page);
    check('初始列表 = 仓库夹具 1 条', lst.items.length === 1 && lst.items[0].id === SEED_ID, JSON.stringify(lst.items.map(x => x.title)));
    check('仓库条目来源 = remote', lst.items[0].source === 'remote', JSON.stringify(lst.items[0]));
    check('管理员 canEdit = true', lst.canEdit === true, JSON.stringify(lst.canEdit));

    const created = await page.evaluate(() => API.post('/api/content', {
      title: '本机新增内容', type: '视频', status: '草稿', owner: '李四', channel: '亚马逊',
      body: '新增的说明', link: 'https://example.com/x'
    }).then(x => ({ ok: x.ok, error: x.error, pending: x.pending, id: x.item && x.item.id })));
    check('新增成功且标记 pending', created.ok && created.pending === true, JSON.stringify(created));
    const NEW_ID = created.id;

    lst = await listContent(page);
    check('列表变为 2 条', lst.items.length === 2, JSON.stringify(lst.items.map(x => x.title)));
    const mine = lst.items.find(x => x.id === NEW_ID) || {};
    check('新条目来源 = local（待发布）', mine.source === 'local', JSON.stringify(mine));
    check('新条目字段落盘正确',
          mine.type === '视频' && mine.status === '草稿' && mine.owner === '李四' && mine.channel === '亚马逊',
          JSON.stringify(mine));
    check('列表按更新时间倒序（新的在前）', lst.items[0].id === NEW_ID, JSON.stringify(lst.items.map(x => x.title)));

    /* ② 编辑 */
    console.log('\n② 编辑内容');
    const edited = await page.evaluate((id) => API.put('/api/content/' + id, {
      title: '本机新增内容（已改）', type: '图片', status: '已发布', owner: '李四', channel: '独立站',
      body: '改过的说明', link: ''
    }).then(x => ({ ok: x.ok, error: x.error, pending: x.pending, t: x.item && x.item.title, s: x.item && x.item.status })), NEW_ID);
    check('编辑成功', edited.ok && edited.t === '本机新增内容（已改）' && edited.s === '已发布', JSON.stringify(edited));
    lst = await listContent(page);
    const m2 = lst.items.find(x => x.id === NEW_ID) || {};
    check('编辑后类型/渠道/链接已更新', m2.type === '图片' && m2.channel === '独立站' && m2.link === '', JSON.stringify(m2));
    check('编辑后 updatedAt 比仓库夹具新', String(m2.updatedAt) > SEED_TIME, m2.updatedAt);

    /* ③ 校验 */
    console.log('\n③ 字段校验');
    const cases = [
      [{ title: '', type: '文档', status: '草稿' }, '空标题被拒'],
      [{ title: 'X', type: '音频', status: '草稿' }, '非法类型被拒'],
      [{ title: 'X', type: '文档', status: '上线了' }, '非法状态被拒'],
      [{ title: 'X', type: '文档', status: '草稿', link: 'javascript:alert(1)' }, '非法链接被拒']
    ];
    for (const [payload, label] of cases) {
      const rr = await page.evaluate((b) => API.post('/api/content', b).then(x => ({ ok: x.ok, error: x.error })), payload);
      check(label, rr.ok === false, JSON.stringify(rr));
    }
    const tooLong = await page.evaluate(() => API.post('/api/content', { title: 'A'.repeat(81), type: '文档', status: '草稿' }).then(x => ({ ok: x.ok, error: x.error })));
    check('标题超 80 字被拒', tooLong.ok === false, JSON.stringify(tooLong));
    lst = await listContent(page);
    check('校验失败没有污染列表（仍 2 条）', lst.items.length === 2, JSON.stringify(lst.items.map(x => x.title)));

    /* ④ 导出 */
    console.log('\n④ 导出 /api/content/export');
    const ex = await page.evaluate(() => API.get('/api/content/export').then(x => ({
      ok: x.ok, stats: x.stats, p: x.payload,
      titles: (x.payload.items || []).map(i => i.title)
    })));
    check('导出成功', ex.ok, JSON.stringify(ex));
    check('payload 结构完整（version/updatedAt/deleted/items）',
          ex.p && ex.p.version === 1 && !!ex.p.updatedAt && Array.isArray(ex.p.deleted) && Array.isArray(ex.p.items));
    check('导出只含与本机差异的条目（不含未改动的仓库条目）',
          ex.titles.length === 1 && ex.titles[0] === '本机新增内容（已改）', JSON.stringify(ex.titles));
    check('导出 stats 正确', ex.stats.exported === 1, JSON.stringify(ex.stats));

    /* ⑤ 仓库清单 → 全新浏览器（成员身份） */
    console.log('\n⑤ 全新浏览器（同事机器）以成员身份查看仓库内容  ← 核心');
    const ctxB = await browser.createBrowserContext();
    const page2 = await ctxB.newPage();
    await page2.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
    const freshStore = await page2.evaluate(() => localStorage.getItem('portal_content'));
    check('全新上下文本机覆盖层为空（确认没共享 localStorage）', !freshStore, JSON.stringify(freshStore));
    r = await apiLogin(page2, 'member', 'view2026');
    check('member 登录', r.ok && r.role === 'member', JSON.stringify(r));

    // 登录后必须真的停在内容页 —— 上面的 login.html 没有表格，UI 断言会全空
    await page2.goto(BASE + '/pages/content.html', { waitUntil: 'domcontentloaded' });
    await page2.waitForFunction(() => {
      var tb = document.getElementById('rows');
      return !!tb && !!tb.querySelector('button[data-act="view"]');
    }, { timeout: 8000 }).catch(() => {});

    lst = await listContent(page2);
    check('成员能看到仓库里的内容', lst.items.some(x => x.id === SEED_ID), JSON.stringify(lst.items.map(x => x.title)));
    check('成员看不到别人本机未发布的内容', !lst.items.some(x => x.id === NEW_ID), JSON.stringify(lst.items.map(x => x.title)));
    check('成员 canEdit = false', lst.canEdit === false, JSON.stringify(lst.canEdit));

    // UI 渲染 + 只读
    const ui = await page2.evaluate(() => {
      const tb = document.getElementById('rows');
      return {
        html: tb.innerHTML,
        editBtns: tb.querySelectorAll('button[data-act="edit"]').length,
        viewBtns: tb.querySelectorAll('button[data-act="view"]').length,
        rowText: tb.textContent.replace(/\s+/g, ' ').trim(),
        btnNewHidden: document.getElementById('btnNew').hidden,
        btnExportHidden: document.getElementById('btnExport').hidden,
        perm: document.getElementById('permNotice').textContent.replace(/\s+/g, ' ').trim()
      };
    });
    check('页面渲染出仓库里的那条内容', ui.rowText.indexOf(SEED_TITLE) !== -1, ui.rowText.slice(0, 90));
    check('成员视图有「查看」无「编辑」', ui.viewBtns === 1 && ui.editBtns === 0, JSON.stringify({ v: ui.viewBtns, e: ui.editBtns }));
    check('成员看不到新增/导出按钮', ui.btnNewHidden === true && ui.btnExportHidden === true, JSON.stringify(ui));
    check('权限提示写明只读', /只读/.test(ui.perm), ui.perm);
    check('来源列标「仓库」', /仓库/.test(ui.rowText), ui.rowText.slice(0, 90));

    // 成员写接口全部 403
    const memberWrite = await page2.evaluate(() => Promise.all([
      API.post('/api/content', { title: 'X', type: '文档', status: '草稿' }).then(x => x._status),
      API.put('/api/content/' + 'c_fixture', { title: 'X' }).then(x => x._status),
      API.del('/api/content/' + 'c_fixture').then(x => x._status),
      API.get('/api/content/export').then(x => x._status)
    ]));
    check('成员写接口 + 导出全部 403', memberWrite.every(s => s === 403), JSON.stringify(memberWrite));
    await page2.close();

    /* ⑥ 删除 */
    console.log('\n⑥ 删除');
    const delLocal = await page.evaluate((id) => API.del('/api/content/' + id).then(x => ({ ok: x.ok })), NEW_ID);
    check('删除本机条目成功', delLocal.ok, JSON.stringify(delLocal));
    lst = await listContent(page);
    check('删除后只剩仓库条目', lst.items.length === 1 && lst.items[0].id === SEED_ID, JSON.stringify(lst.items.map(x => x.title)));
    let delEx = await page.evaluate(() => API.get('/api/content/export').then(x => ({ n: x.payload.items.length, del: x.payload.deleted })));
    check('删本机条目不进 deleted（本来就不在仓库）', delEx.del.length === 0, JSON.stringify(delEx));

    const delShared = await page.evaluate((id) => API.del('/api/content/' + id).then(x => ({ ok: x.ok })), SEED_ID);
    check('删除仓库条目成功', delShared.ok, JSON.stringify(delShared));
    lst = await listContent(page);
    check('仓库条目已从列表消失', lst.items.length === 0, JSON.stringify(lst.items.map(x => x.title)));
    delEx = await page.evaluate(() => API.get('/api/content/export').then(x => ({ n: x.payload.items.length, del: x.payload.deleted })));
    check('删仓库条目写进 deleted 墓碑', delEx.del.indexOf(SEED_ID) !== -1, JSON.stringify(delEx));

    // 清掉本机覆盖层 → 墓碑只在本机，仓库条目应还原
    await page.evaluate(() => { localStorage.removeItem('portal_content'); });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await new Promise(x => setTimeout(x, 700));
    lst = await listContent(page);
    check('清掉本机覆盖层后仓库条目还原（墓碑只在本机）', lst.items.some(x => x.id === SEED_ID), JSON.stringify(lst.items.map(x => x.title)));

    /* ⑦ 搜索 / 筛选（UI） */
    console.log('\n⑦ 搜索与状态筛选');
    await page.evaluate(() => API.post('/api/content', { title: '抖音短视频脚本', type: '视频', status: '草稿', owner: '王五', channel: '抖音' }));
    await page.evaluate(() => API.post('/api/content', { title: '亚马逊主图组', type: '图片', status: '已发布', owner: '赵六', channel: '亚马逊' }));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await new Promise(x => setTimeout(x, 700));
    const countRows = () => page.evaluate(() => document.querySelectorAll('#rows tr').length);
    check('共 3 条', await countRows() === 3, String(await countRows()));

    await page.type('#kw', '抖音');
    await new Promise(x => setTimeout(x, 250));
    let txt = await page.evaluate(() => document.getElementById('rows').textContent);
    check('搜索「抖音」命中 1 条', await countRows() === 1 && /抖音短视频脚本/.test(txt), txt.replace(/\s+/g, ' ').slice(0, 80));

    await page.evaluate(() => { document.getElementById('kw').value = ''; document.getElementById('kw').dispatchEvent(new Event('input')); });
    await page.select('#statusFilter', '已发布');
    await new Promise(x => setTimeout(x, 250));
    txt = await page.evaluate(() => document.getElementById('rows').textContent);
    check('筛选「已发布」命中 2 条', await countRows() === 2, txt.replace(/\s+/g, ' ').slice(0, 90));
    check('筛选结果不含草稿条目', !/抖音短视频脚本/.test(txt), txt.replace(/\s+/g, ' ').slice(0, 90));

    await page.select('#statusFilter', '');
    await new Promise(x => setTimeout(x, 250));

    /* ⑧ 待发布汇总条 */
    console.log('\n⑧ 待发布汇总条');
    const pend = await page.evaluate(() => {
      const b = document.getElementById('pendingBar');
      return { hidden: b.hidden, cls: b.className, txt: b.textContent.replace(/\s+/g, ' ').trim() };
    });
    check('有本机改动时显示待发布提示条', pend.hidden === false && /待发布|尚未发布/.test(pend.txt), JSON.stringify(pend));
    check('提示条为醒目样式', /alert-error/.test(pend.cls), pend.cls);

    /* ⑨ 共享清单 404 */
    console.log('\n⑨ 共享清单拉取失败时的可见性');
    const ctxC = await browser.createBrowserContext();
    const page3 = await ctxC.newPage();
    await page3.setRequestInterception(true);
    page3.on('request', req => {
      if (req.url().indexOf('data/content.json') !== -1) req.respond({ status: 404, contentType: 'text/plain', body: 'not found' });
      else req.continue();
    });
    await page3.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
    r = await apiLogin(page3, 'admin', 'admin2026');
    check('清单拉取失败不影响登录', r.ok, JSON.stringify(r));
    const st = await page3.evaluate(() => API.contentRemote());
    check('API.contentRemote() 暴露出错误', !!st.error, JSON.stringify(st));
    await page3.goto(BASE + '/pages/content.html', { waitUntil: 'domcontentloaded' });
    await new Promise(x => setTimeout(x, 2200));
    const notice = await page3.evaluate(() => {
      const el = document.getElementById('sharedNotice');
      return { cls: el ? el.className : '(无)', txt: el ? el.textContent.replace(/\s+/g, ' ').slice(0, 70) : '', retry: !!document.getElementById('btnRetryContent') };
    });
    check('页面显示清单加载失败告警', /alert-error/.test(notice.cls) && /加载失败/.test(notice.txt), JSON.stringify(notice));
    check('告警带「重试」按钮', notice.retry, JSON.stringify(notice));
    await page3.close();

  } finally {
    restoreFixture();
    if (browser) await browser.close();
  }

  console.log('\n══════ 汇总 ══════');
  console.log(' PASS: ' + pass + '   FAIL: ' + fail);
  console.log(' data/content.json 已还原（夹具未留在仓库里）');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('脚本异常:', e); try { restoreFixture(); } catch (_) {} process.exit(1); });
