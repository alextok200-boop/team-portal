#!/usr/bin/env node
/* ============================================================
   regress-publish-flow.js —— 「一键发布到仓库」全链路回归

   为什么不直接打真 GitHub：
     那是**真的会往仓库提交**的写操作。测试必须能随便跑、随便失败，
     所以这里拦截 https://api.github.com/** 做**模拟端点**。
     而且 PUT 成功时会把请求体里的内容**真的写回本地 data/content.json**，
     以此模拟「仓库确实被更新了」—— 否则发布完成后
     store.refresh() 拉到的还是旧文件，「来源列变仓库」根本验不出来。

   覆盖：
     ① 未配置 Token：状态正确、发布被拒
     ② 配置 Token：保存成功、只回尾号、**Token 不落进任何导出**
     ③ 配置失败：坏 Token 被拒且**不会把坏配置存进去**
     ④ 正常发布：提交 data/content.json、来源列由「待发布」变「仓库」、待发布归零
     ⑤ 冲突 409：错误可读且明确提示重试
     ⑥ 无待发布改动时的提示
     ⑦ 成员无权：status / publish / config 三个接口全 403
     ⑧ UI：配了 Token 才出现「一键发布」，未配不出现

   前置：仓库父目录起 python -m http.server 8971
   运行：node tools/regress-publish-flow.js
   ⚠️ 会临时改写 data/content.json（模拟远端被提交），结束自动还原。
   ============================================================ */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const BASE = (process.env.PORTAL_BASE || 'http://127.0.0.1:8971/team-portal').replace(/\/$/, '');
const GH = 'https://api.github.com';
const CONTENT_FILE = path.join(REPO, 'data', 'content.json');

const SEED_ID = 'c_pubfix';
const SEED_TITLE = '仓库里的内容（发布测试）';
const SEED_TIME = '2026-09-01T02:00:00.000Z';

const launchOpts = { headless: 'new', args: ['--no-sandbox'] };
if (process.env.CHROME_PATH) launchOpts.executablePath = process.env.CHROME_PATH;

const origContent = fs.readFileSync(CONTENT_FILE, 'utf8');
function seedFixture() {
  const payload = {
    version: 1, updatedAt: SEED_TIME, note: 'PUBLISH REGRESSION FIXTURE — 测试结束会还原',
    deleted: [], items: [{
      id: SEED_ID, title: SEED_TITLE, type: '文档', status: '已发布',
      owner: '张三', channel: '天猫', body: 'x', link: '',
      createdAt: SEED_TIME, updatedAt: SEED_TIME, author: '戴程鹏'
    }]
  };
  fs.writeFileSync(CONTENT_FILE, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}
function restoreFixture() { fs.writeFileSync(CONTENT_FILE, origContent, 'utf8'); }

/* ── 模拟 GitHub ─────────────────────────────────────────── */
const mock = {
  sha: 'sha_initial',
  badToken: false,     // token 以 'bad' 开头 → 401
  noPush: false,       // 仓库不可写
  forceConflict: false // PUT 一律 409
};
let ghCalls = [];

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin || '*',
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type, accept, x-github-api-version',
    'Access-Control-Max-Age': '600'
  };
}

async function handleGh(req, origin) {
  const u = req.url().replace(GH, '');
  const method = req.method();
  const h = corsHeaders(origin);
  ghCalls.push(method + ' ' + u.split('?')[0]);

  if (method === 'OPTIONS') {                       // 预检
    return req.respond({ status: 204, headers: h, body: '' });
  }

  const auth = String((req.headers()['authorization'] || ''));
  const isBad = mock.badToken || /bad/i.test(auth);

  // GET /repos/{o}/{r}  —— 保存配置时的校验
  if (/^\/repos\/[^\/]+\/[^\/]+$/.test(u.split('?')[0]) && method === 'GET') {
    if (isBad) return req.respond({ status: 401, headers: h, body: JSON.stringify({ message: 'Bad credentials' }) });
    return req.respond({
      status: 200, headers: h,
      body: JSON.stringify({ full_name: 'probe/team-portal', default_branch: 'main', permissions: { push: !mock.noPush } })
    });
  }

  // /repos/{o}/{r}/contents/{path}
  const m = /^\/repos\/([^\/]+)\/([^\/]+)\/contents\/(.+)$/.exec(u.split('?')[0]);
  if (m) {
    const filePath = decodeURIComponent(m[3].replace(/\/$/, ''));
    if (isBad) return req.respond({ status: 401, headers: h, body: JSON.stringify({ message: 'Bad credentials' }) });
    if (mock.noPush) return req.respond({ status: 403, headers: h, body: JSON.stringify({ message: 'Resource not accessible' }) });

    if (method === 'GET') {
      return req.respond({
        status: 200, headers: h,
        body: JSON.stringify({ sha: mock.sha, path: filePath, type: 'file', content: '' })
      });
    }

    if (method === 'PUT') {
      if (mock.forceConflict) {
        return req.respond({ status: 409, headers: h, body: JSON.stringify({ message: 'sha does not match' }) });
      }
      let body = {};
      try { body = JSON.parse(req.postData() || '{}'); } catch (e) { /* ignore */ }
      if (body.sha && body.sha !== mock.sha) {
        return req.respond({ status: 409, headers: h, body: JSON.stringify({ message: 'sha does not match' }) });
      }
      // ★ 关键：真的把内容写回本地文件，模拟"仓库已被更新"
      if (filePath === 'data/content.json') {
        try { fs.writeFileSync(CONTENT_FILE, Buffer.from(body.content || '', 'base64').toString('utf8'), 'utf8'); }
        catch (e) { /* ignore */ }
      }
      mock.sha = 'sha_' + Date.now();
      const commit = 'c0ffee' + Math.random().toString(16).slice(2, 8);
      return req.respond({
        status: 200, headers: h,
        body: JSON.stringify({ commit: { sha: commit, html_url: 'https://github.com/probe/commit/' + commit }, content: { path: filePath } })
      });
    }
  }

  return req.respond({ status: 404, headers: h, body: JSON.stringify({ message: 'Not Found (mock)' }) });
}

async function attachMock(page) {
  await page.setRequestInterception(true);
  page.on('request', req => {
    if (req.url().indexOf(GH) === 0) {
      return handleGh(req, req.headers()['origin']);
    }
    return req.continue();
  });
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

async function apiLogin(page, u, p) {
  return page.evaluate((u, p) => API.post('/api/login', { username: u, password: p })
    .then(r => ({ ok: r.ok, role: r.user ? r.user.role : null, error: r.error || null })), u, p);
}

(async () => {
  seedFixture();
  let browser = null;
  try {
    browser = await puppeteer.launch(launchOpts);

    /* ── 管理员上下文 ── */
    const ctxA = await browser.createBrowserContext();
    const page = await ctxA.newPage();
    await attachMock(page);
    page.on('pageerror', e => console.log('  ⚠️ pageerror: ' + e.message));

    await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
    let r = await apiLogin(page, 'admin', 'admin2026');
    check('admin 登录', r.ok, JSON.stringify(r));

    /* ① 未配置 */
    console.log('\n① 未配置 Token');
    let st = await page.evaluate(() => API.get('/api/publish/status').then(x => ({
      configured: x.configured, tail: x.tokenTail, owner: x.owner, repo: x.repo, branch: x.branch, pending: x.pending
    })));
    check('状态=未配置', st.configured === false && st.tail === '', JSON.stringify(st));
    check('待发布计数正确（1 条仓库内容不算差异）', st.pending.content === 0 && st.pending.users === 0, JSON.stringify(st.pending));

    let noTok = await page.evaluate(() => API.post('/api/publish', {}).then(x => ({ s: x._status, e: x.error })));
    check('未配置时发布被拒（400）', noTok.s === 400 && /Token/.test(noTok.e || ''), JSON.stringify(noTok));

    await page.goto(BASE + '/pages/content.html', { waitUntil: 'domcontentloaded' });
    await new Promise(x => setTimeout(x, 700));
    let btn = await page.evaluate(() => { var b = document.getElementById('btnPublish'); return b ? b.hidden : 'missing'; });
    check('内容页未配置时不显示「一键发布」', btn === true, JSON.stringify(btn));

    /* ② 配置 Token（成功） */
    console.log('\n② 配置 Token');
    let cfgOk = await page.evaluate(() => API.post('/api/publish/config', {
      token: 'ghp_goodtoken1234', owner: 'probe', repo: 'team-portal', branch: 'main'
    }).then(x => ({ s: x._status, ok: x.ok, repo: x.repo && x.repo.fullName, err: x.error })));
    check('保存配置成功（已过 GitHub 校验）', cfgOk.s === 200 && cfgOk.ok, JSON.stringify(cfgOk));

    st = await page.evaluate(() => API.get('/api/publish/status').then(x => ({ configured: x.configured, tail: x.tokenTail })));
    check('状态=已配置，且只暴露 Token 尾号', st.configured === true && st.tail === '1234', JSON.stringify(st));

    const leak = await page.evaluate(async () => {
      const usr = await API.get('/api/users/export');
      const con = await API.get('/api/content/export');
      const blob = JSON.stringify(usr.payload) + JSON.stringify(con.payload);
      const ls = JSON.stringify(Object.keys(localStorage).map(k => [k, localStorage.getItem(k)]));
      return {
        inExport: /ghp_|github_pat_|Bearer/.test(blob),
        cfgKeySeparate: localStorage.getItem('portal_gh_cfg') !== null,
        // Token 只应在独立键里，绝不在 users/content 的存储或导出里
        inPortalData: /ghp_|github_pat_/.test(JSON.stringify([
          localStorage.getItem('portal_users'), localStorage.getItem('portal_content'),
          localStorage.getItem('portal_users_remote'), localStorage.getItem('portal_content_remote')
        ]))
      };
    });
    check('Token 不出现在任何导出 payload 里', leak.inExport === false, JSON.stringify(leak));
    check('Token 只存在独立配置键，不混入 users/content 数据', leak.cfgKeySeparate && leak.inPortalData === false, JSON.stringify(leak));

    /* ③ 配置 Token（失败不能落盘） */
    console.log('\n③ 坏 Token 被拒且不落盘');
    mock.badToken = true;
    let cfgBad = await page.evaluate(() => API.post('/api/publish/config', {
      token: 'bad_token', owner: 'probe', repo: 'team-portal', branch: 'main'
    }).then(x => ({ s: x._status, e: x.error })));
    check('坏 Token 被拒（400，提示 401）', cfgBad.s === 400 && /401/.test(cfgBad.e || ''), JSON.stringify(cfgBad));
    mock.badToken = false;

    let st2 = await page.evaluate(() => API.get('/api/publish/status').then(x => ({ configured: x.configured, tail: x.tokenTail })));
    check('坏配置没有被存进去（仍是上一把好 Token）', st2.configured === true && st2.tail === '1234', JSON.stringify(st2));

    /* ④ 正常发布 */
    console.log('\n④ 正常发布');
    const created = await page.evaluate(() => API.post('/api/content', {
      title: '待发布的内容', type: '文档', status: '草稿', owner: '李四', channel: '独立站'
    }).then(x => ({ ok: x.ok, id: x.item && x.item.id, source: x.item && x.item.source })));
    check('新增一条本机内容', created.ok && created.source === 'local', JSON.stringify(created));

    let pend = await page.evaluate(() => API.get('/api/publish/status').then(x => x.pending));
    check('待发布计数变成 1', pend.content === 1, JSON.stringify(pend));

    const pub = await page.evaluate(() => API.post('/api/publish', { targets: ['content'] }).then(x => ({
      s: x._status, ok: x.ok, err: x.error || null,
      published: (x.published || []).map(p => ({ path: p.path, ok: p.ok, count: p.count, commit: p.commit }))
    })));
    check('发布成功且提交 data/content.json', pub.ok && pub.published.length === 1 && pub.published[0].path === 'data/content.json', JSON.stringify(pub));
    check('返回了 commit sha', /^c0ffee/.test(String(pub.published[0].commit)), JSON.stringify(pub.published));

    const onDisk = JSON.parse(fs.readFileSync(CONTENT_FILE, 'utf8'));
    check('内容真的进了仓库文件（模拟远端已更新）',
          onDisk.items.some(i => i.title === '待发布的内容'), JSON.stringify(onDisk.items.map(i => i.title)));

    const after = await page.evaluate(() => API.get('/api/content').then(x => ({
      items: (x.items || []).map(i => ({ title: i.title, source: i.source }))
    })));
    const mine = after.items.filter(i => i.title === '待发布的内容')[0] || {};
    check('发布后来源列由「待发布」变「仓库」', mine.source === 'remote', JSON.stringify(after.items));

    pend = await page.evaluate(() => API.get('/api/publish/status').then(x => x.pending));
    check('发布后待发布归零', pend.content === 0, JSON.stringify(pend));

    /* ⑤ 冲突 409 */
    console.log('\n⑤ 冲突（409）');
    await page.evaluate(() => API.post('/api/content', { title: '冲突测试条目', type: '文档', status: '草稿' }));
    mock.forceConflict = true;
    const conflict = await page.evaluate(() => API.post('/api/publish', { targets: ['content'] }).then(x => ({
      s: x._status, ok: x.ok, e: x.error, published: x.published
    })));
    check('冲突时发布失败', conflict.ok === false, JSON.stringify(conflict));
    check('错误里明确提示「刷新后重试」', /重试/.test(conflict.e || ''), JSON.stringify(conflict.e));
    check('失败时如实回报已尝试的文件', Array.isArray(conflict.published) && conflict.published.length === 1, JSON.stringify(conflict.published));
    mock.forceConflict = false;

    /* ⑥ 无待发布 */
    console.log('\n⑥ 无待发布改动');
    mock.sha = 'sha_' + Date.now();     // 让 sha 重新对齐，允许再次提交
    await page.evaluate(() => API.post('/api/publish', { targets: ['content'] }));   // 把冲突那条发出去
    const none = await page.evaluate(() => API.post('/api/publish', { targets: ['content'] }).then(x => ({
      ok: x.ok, n: (x.published || []).length, msg: x.message
    })));
    check('没有待发布时给出明确提示', none.ok && none.n === 0 && /没有待发布/.test(none.msg || ''), JSON.stringify(none));

    /* ⑦ 成员无权 */
    console.log('\n⑦ 成员无权（全新浏览器）');
    const ctxB = await browser.createBrowserContext();
    const page2 = await ctxB.newPage();
    await page2.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
    const m = await apiLogin(page2, 'member', 'view2026');
    check('member 登录', m.ok && m.role === 'member', JSON.stringify(m));

    const mw = await page2.evaluate(() => Promise.all([
      API.get('/api/publish/status').then(x => x._status),
      API.post('/api/publish', {}).then(x => x._status),
      API.post('/api/publish/config', { token: 'x', owner: 'a', repo: 'b' }).then(x => x._status),
      API.del('/api/publish/config').then(x => x._status)
    ]));
    check('成员访问四个发布接口全部 403', mw.every(s => s === 403), JSON.stringify(mw));

    await page2.goto(BASE + '/pages/content.html', { waitUntil: 'domcontentloaded' });
    await new Promise(x => setTimeout(x, 700));
    const mBtn = await page2.evaluate(() => { var b = document.getElementById('btnPublish'); return b ? b.hidden : 'missing'; });
    check('成员看不到「一键发布」按钮', mBtn === true, JSON.stringify(mBtn));
    await page2.close();

    /* ⑧ UI（admin，配了 Token 且有存量时可见可点） */
    console.log('\n⑧ 管理端 UI');
    await page.evaluate(() => API.post('/api/content', { title: 'UI 测试条目', type: '文档', status: '草稿' }));
    await page.goto(BASE + '/pages/content.html', { waitUntil: 'domcontentloaded' });
    await new Promise(x => setTimeout(x, 900));
    const ui = await page.evaluate(() => {
      var b = document.getElementById('btnPublish');
      return { hidden: b.hidden, disabled: b.disabled, text: b.textContent };
    });
    check('配了 Token 且有存量 → 按钮可见可点且带数量', ui.hidden === false && ui.disabled === false && /1/.test(ui.text), JSON.stringify(ui));

    await page.goto(BASE + '/pages/admin.html', { waitUntil: 'domcontentloaded' });
    await new Promise(x => setTimeout(x, 900));
    const adm = await page.evaluate(() => {
      var t = document.getElementById('tabs');
      var hasTab = !![].slice.call(t.querySelectorAll('.tab')).filter(x => x.dataset.tab === 'publish').length;
      return {
        hasTab: hasTab,
        state: document.getElementById('ghState').textContent,
        barText: document.getElementById('ghPendingBar').textContent.replace(/\s+/g, ' ').trim().slice(0, 60),
        publishBtn: !document.getElementById('btnPublishUsers').hidden,
        ownerFilled: document.getElementById('ghOwner').value,
        repoFilled: document.getElementById('ghRepo').value
      };
    });
    check('管理后台有「自动提交」页签', adm.hasTab, JSON.stringify(adm));
    check('显示已配置（尾号）', /已配置/.test(adm.state) && /1234/.test(adm.state), adm.state);
    check('待发布条提示可见', /待发布/.test(adm.barText), adm.barText);
    check('用户页出现「一键发布」按钮', adm.publishBtn, JSON.stringify(adm));
    check('owner/repo 已回填', adm.ownerFilled === 'probe' && adm.repoFilled === 'team-portal', JSON.stringify(adm));

    /* ⑨ 清除配置 */
    console.log('\n⑨ 清除配置');
    const clr = await page.evaluate(() => API.del('/api/publish/config').then(x => ({ s: x._status, ok: x.ok })));
    check('清除成功', clr.s === 200 && clr.ok, JSON.stringify(clr));
    const st3 = await page.evaluate(() => API.get('/api/publish/status').then(x => ({ configured: x.configured, tail: x.tokenTail })));
    check('清除后状态回到未配置', st3.configured === false && st3.tail === '', JSON.stringify(st3));

    await page.close();
    await ctxA.close();
    await ctxB.close();

    console.log('\n（共拦截 ' + ghCalls.length + ' 次 GitHub API 调用，全部为模拟，未触达真实仓库）');
  } finally {
    restoreFixture();
    if (browser) await browser.close();
  }

  console.log('\n══════ 汇总 ══════');
  console.log(' PASS: ' + pass + '   FAIL: ' + fail);
  console.log(' data/content.json 已还原（夹具未留在仓库里）');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('脚本异常:', e); try { restoreFixture(); } catch (_) { } process.exit(1); });
