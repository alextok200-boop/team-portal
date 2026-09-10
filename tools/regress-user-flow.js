#!/usr/bin/env node
/* ============================================================
   regress-user-flow.js —— 账号全链路回归（26 项断言）

   为什么会有这个脚本：
     v1.4.0 修过一个「新增用户登录总显示账号密码错误」的 bug ——
     根因是账号只写进了建号那台浏览器的 localStorage，同事的机器上没有。
     这类「本机能过、别人不能过」的问题用肉眼测不出来，必须脚本钉住。

   覆盖：
     ① 同一浏览器：后台建号 → UI 登录
     ② 仓库名单 data/users.json 里的账号 → 全新浏览器 UI 登录  ← 核心回归
     ③ 导出 /api/users/export 结构（sha256$ 前缀 / 不含内置账号）
     ④ 删除源码内置账号 → deleted 墓碑 → 导出可同步
     ⑤ 非安全上下文（无 crypto.subtle）→ 明确报错，不是「账号密码错误」
     ⑥ 共享名单 404 → 管理后台顶部告警可见

   前置：
     1. 在仓库父目录起静态服务（让 /team-portal/ 映射到仓库）
          cd <仓库父目录> && python -m http.server 8971
     2. 安装 puppeteer（含 Chromium）

   运行：
     node tools/regress-user-flow.js
     # 自定义：
     PORTAL_BASE=http://localhost:8971/team-portal \
     CHROME_PATH=/path/to/chrome node tools/regress-user-flow.js

   ⚠️ 脚本会临时改写 data/users.json 写入测试夹具，**结束时自动还原**（含异常路径）。
   ============================================================ */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO = path.resolve(__dirname, '..');
const BASE = (process.env.PORTAL_BASE || 'http://127.0.0.1:8971/team-portal').replace(/\/$/, '');
const USERS_FILE = path.join(REPO, 'data', 'users.json');

const SHARED_USER = 'zhangsan';   // 临时夹具，跑完还原
const SHARED_PASS = 'konllen2026';
const LOCAL_USER = 'lisi_local';
const LOCAL_PASS = 'local2026';

const launchOpts = { headless: 'new', args: ['--no-sandbox'] };
if (process.env.CHROME_PATH) launchOpts.executablePath = process.env.CHROME_PATH;

const origUsers = fs.readFileSync(USERS_FILE, 'utf8');
function seedFixture() {
  const payload = {
    version: 1,
    updatedAt: new Date().toISOString(),
    note: 'REGRESSION TEST FIXTURE — 测试结束会还原',
    deleted: [],
    users: [{
      id: 'u_fixture', username: SHARED_USER, name: '张三', role: 'member',
      passwordHash: 'sha256$' + crypto.createHash('sha256').update(SHARED_PASS).digest('hex'),
      active: true, builtin: false, createdAt: new Date().toISOString(), lastLogin: null
    }]
  };
  fs.writeFileSync(USERS_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}
function restoreFixture() { fs.writeFileSync(USERS_FILE, origUsers, 'utf8'); }

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

async function uiLogin(page, u, p) {
  await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
  try { await page.waitForSelector('#username', { timeout: 5000 }); }
  catch (e) { return { ok: false, msg: '登录页被重定向（已有会话未清）' }; }
  await page.evaluate(() => { const e = document.getElementById('password'); if (e) e.value = ''; });
  await page.type('#username', u);
  await page.type('#password', p);
  await page.click('#submitBtn');
  const t0 = Date.now();
  while (Date.now() - t0 < 6000) {
    let st;
    try {
      st = await page.evaluate(() => ({
        url: location.pathname,
        cls: (document.getElementById('alert') || {}).className || '',
        txt: (document.getElementById('alert') || {}).textContent || ''
      }));
    } catch (e) {
      if (/context was destroyed|navigation/i.test(String(e))) return { ok: true, url: page.url() };
      throw e;
    }
    if (st.url.indexOf('/pages/') !== -1) return { ok: true, url: st.url };
    if (st.cls.indexOf('alert-ok') !== -1 && st.txt) return { ok: true, msg: st.txt };
    if (st.cls.indexOf('alert-error') !== -1 && st.txt) return { ok: false, msg: st.txt };
    await new Promise(r => setTimeout(r, 120));
  }
  return { ok: false, msg: '超时无响应' };
}

async function apiLogin(page, u, p) {
  return page.evaluate((u, p) => API.post('/api/login', { username: u, password: p })
    .then(r => ({ ok: r.ok, status: r._status, error: r.error || null, role: r.user ? r.user.role : null })), u, p);
}

(async () => {
  seedFixture();
  let browser = null;
  try {
    browser = await puppeteer.launch(launchOpts);

    /* ① 同浏览器 建号 → 登录 */
    console.log('\n① 同一浏览器：后台建号 → UI 登录');
    const page = await browser.newPage();
    await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => localStorage.clear());
    let r = await apiLogin(page, 'admin', 'admin2026');
    check('admin 登录', r.ok, JSON.stringify(r));

    r = await page.evaluate((u, p) => API.post('/api/users', { name: '李四', username: u, password: p, role: 'member' })
      .then(x => ({ ok: x.ok, error: x.error, pending: x.pending })), LOCAL_USER, LOCAL_PASS);
    check('建号成功且标记 pending', r.ok && r.pending === true, JSON.stringify(r));

    r = await apiLogin(page, LOCAL_USER, LOCAL_PASS);
    check('新号在【本机】立即可登录', r.ok, JSON.stringify(r));

    const localStore = await page.evaluate(() => JSON.parse(localStorage.getItem('portal_users') || '[]'));
    check('本机覆盖层只存差异（不再落整表）', localStore.length === 1 && localStore[0].username === LOCAL_USER,
          '实际 ' + JSON.stringify(localStore.map(x => x.username)));

    /* ② 共享名单账号 → 全新浏览器 */
    console.log('\n② 全新浏览器（模拟同事机器）：登录仓库名单里的账号  ← 核心回归');
    const ctx2 = await browser.createBrowserContext();
    const page2 = await ctx2.newPage();
    await page2.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
    const fresh = await page2.evaluate(() => localStorage.getItem('portal_users'));
    check('全新上下文 portal_users 为空（确认没共享 localStorage）', !fresh, JSON.stringify(fresh));
    r = await uiLogin(page2, SHARED_USER, SHARED_PASS);
    check('仓库名单账号在【全新浏览器】能登录', r.ok, r.msg || r.url);
    await new Promise(x => setTimeout(x, 900));   // 成功提示后 300ms 才跳转
    check('登录后跳到 pages/ 下的页面', page2.url().indexOf('/pages/') !== -1, page2.url());
    await page2.evaluate(() => { API.clear(); });
    r = await uiLogin(page2, SHARED_USER, 'wrong-password-xyz');
    check('错误密码仍被拒（不能放开）', !r.ok, JSON.stringify(r));
    await page2.close();

    /* ③ 导出 payload */
    console.log('\n③ 导出 /api/users/export');
    r = await apiLogin(page, 'admin', 'admin2026');
    check('切回 admin 会话', r.ok, JSON.stringify(r));
    const ex = await page.evaluate(() => API.get('/api/users/export').then(x => ({
      ok: x.ok, stats: x.stats, p: x.payload,
      names: (x.payload.users || []).map(u => u.username),
      algos: (x.payload.users || []).map(u => String(u.passwordHash).slice(0, 7))
    })));
    check('导出成功', ex.ok, JSON.stringify(ex));
    check('导出不含源码内置账号（admin/leader/member）',
          !ex.names.includes('admin') && !ex.names.includes('leader') && !ex.names.includes('member'),
          JSON.stringify(ex.names));
    check('导出含本机新建账号', ex.names.includes(LOCAL_USER), JSON.stringify(ex.names));
    check('哈希带 sha256$ 前缀', ex.algos.every(a => a === 'sha256$'), JSON.stringify(ex.algos));
    check('payload 结构完整（version/updatedAt/deleted/users）',
          ex.p && ex.p.version === 1 && !!ex.p.updatedAt && Array.isArray(ex.p.deleted) && Array.isArray(ex.p.users));

    /* ④ 删除内置账号 → 墓碑 */
    console.log('\n④ 删除内置账号 member → 墓碑 → 导出 deleted');
    const delRes = await page.evaluate(() => API.get('/api/users').then(g => {
      const m = (g.users || []).find(x => x.username === 'member');
      return m ? API.del('/api/users/' + m.id).then(x => ({ ok: x.ok, error: x.error })) : { ok: false, error: '找不到 member' };
    }));
    check('删除内置账号成功', delRes.ok, JSON.stringify(delRes));
    const after = await page.evaluate(() => API.get('/api/users').then(x => (x.users || []).map(u => u.username)));
    check('member 已从列表消失', !after.includes('member'), JSON.stringify(after));
    const ex2 = await page.evaluate(() => API.get('/api/users/export').then(x => x.payload.deleted));
    check('导出 deleted 含 member', ex2.includes('member'), JSON.stringify(ex2));
    await page.evaluate(() => { localStorage.removeItem('portal_users'); });
    const restored = await page.evaluate(() => API.get('/api/users').then(x => (x.users || []).map(u => u.username)));
    check('清掉本机覆盖层后 member 还原（墓碑只在本机）', restored.includes('member'), JSON.stringify(restored));
    const srcBadge = await page.evaluate(() => API.get('/api/users').then(x =>
      x.users.find(u => u.username === 'member') || {}));
    check('member 来源标为源码', srcBadge.source === 'builtin', JSON.stringify(srcBadge));

    /* ⑤ 非安全上下文 */
    console.log('\n⑤ 非安全上下文（crypto.subtle 不可用）');
    const page3 = await browser.newPage();
    await page3.evaluateOnNewDocument(() => {
      Object.defineProperty(window, 'crypto', { configurable: true, get() { return { getRandomValues: a => a }; } });
    });
    await page3.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
    const sec = await page3.evaluate(() => ({ isSecure: API.isSecure() }));
    check('API.isSecure() 正确识别为不安全', sec.isSecure === false, JSON.stringify(sec));
    r = await apiLogin(page3, 'admin', 'admin2026');
    check('登录给出【不安全】明确提示，而不是账号密码错误',
          !r.ok && /不安全/.test(r.error || ''), JSON.stringify(r));
    await page3.close();

    /* ⑥ 共享名单 404 */
    console.log('\n⑥ 共享名单拉取失败时管理员的可见性');
    const page4 = await browser.newPage();
    await page4.setRequestInterception(true);
    page4.on('request', req => {
      if (req.url().indexOf('data/users.json') !== -1) req.respond({ status: 404, contentType: 'text/plain', body: 'not found' });
      else req.continue();
    });
    await page4.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
    r = await apiLogin(page4, 'admin', 'admin2026');
    check('名单拉取失败也不影响源码内置账号登录', r.ok, JSON.stringify(r));
    const rs = await page4.evaluate(() => ({ remote: API.remote(), canRetry: typeof API.refreshRemote === 'function' }));
    check('API.remote() 暴露出加载错误', !!rs.remote.error, JSON.stringify(rs.remote));
    check('管理员可手动重试（API.refreshRemote 存在）', rs.canRetry, JSON.stringify(rs));
    await page4.goto(BASE + '/pages/admin.html', { waitUntil: 'domcontentloaded' });
    await new Promise(x => setTimeout(x, 2500));
    const notice = await page4.evaluate(() => {
      const el = document.getElementById('sharedNotice');
      return {
        url: location.pathname,
        cls: el ? el.className : '(元素不存在)',
        text: el ? el.textContent.replace(/\s+/g, ' ').slice(0, 80) : '',
        hasRetryBtn: !!document.getElementById('btnRetryRemote')
      };
    });
    check('管理后台顶部显示加载失败告警', /alert-error/.test(notice.cls) && /加载失败/.test(notice.text),
          JSON.stringify(notice));
    check('告警里带「重试」按钮', notice.hasRetryBtn, JSON.stringify(notice));
    await page4.close();

  } finally {
    restoreFixture();
    if (browser) await browser.close();
  }

  console.log('\n══════ 汇总 ══════');
  console.log(' PASS: ' + pass + '   FAIL: ' + fail);
  console.log(' data/users.json 已还原（夹具未留在仓库里）');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('脚本异常:', e); try { restoreFixture(); } catch (_) {} process.exit(1); });
