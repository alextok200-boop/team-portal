#!/usr/bin/env node
/* ============================================================
   smoke-site.js —— 全站页面冒烟（每页都真的打开一遍）

   为什么需要：
     纯静态站没有构建期校验。改了公共 js（api/datastore/portal）或版本号，
     很容易出现「某个页面 404 了依赖」「某个页面少引入了公共脚本」
     「console 报错但肉眼看不出来」——只有逐页打开才发现。

   覆盖：
     ① 全站版本号一致性（静态读盘）：js/api.js?v= / js/datastore.js?v= /
        js/portal.js?v= / js/config/roles.js?v= / css/portal.css?v= 全站唯一
     ② 逐页打开：HTTP 200、无 4xx/5xx 资源、无 console error / 未捕获异常
     ③ 公共脚本引用自洽：凡用了 Portal./API./Auth./Landing./DataStore.
        就必须引入对应脚本（静态读盘 —— 不查 window.*，因为已登录访问
        login.html 会被重定向，查到的其实是别的页面的全局对象）
     ④ 抓取脚本 scripts/fetch-openapi.js 的「本地时间」在 TZ=UTC 下
        仍按北京时间渲染（runner 是 ubuntu-latest = UTC，漏写 timeZone 会差 8 小时）
     ⑤ 数据新鲜度判定（浏览器内**真跑**，不是正则）：5h/18h → ok、
        22h → warn、40h → stale、无值 → unknown
     ⑥ 凡渲染「最近同步」的地方都必须带新鲜度标签（静态读盘）
        —— 实测共 6 处（data / tables / board / settings / dashboard / admin）。
           只给其中一处加等于没加：用户看到过期数据的那一页很可能正是漏掉的那页。
     ⑦ 抓取失败通知接线自洽：workflow 有 if: failure() 步骤，且**真跑一次**
        `scripts/notify-failure.js --dry-run`，parse 它吐出的 JSON
        验关键词与运行日志链接（只做源码正则匹配的话，改坏了实现也照样绿）
     ⑧ 页面间跳转可落地：因每页有 <base href="/team-portal/">，相对 URL 是按
        **站点根**解析的 —— 在 pages/ 页里裸写 `tables.html` 会去请求根下的
        tables.html 而真实文件在 pages/ 下 ⇒ 点卡片直接 404。断言相对链接必须
        带 pages/ 前缀（根级 index/login 除外），且目标文件真实存在。

   前置：仓库父目录起 python -m http.server 8971
   运行：node tools/smoke-site.js
   ============================================================ */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const REPO = path.resolve(__dirname, '..');
const BASE = (process.env.PORTAL_BASE || 'http://127.0.0.1:8971/team-portal').replace(/\/$/, '');

const launchOpts = { headless: 'new', args: ['--no-sandbox'] };
if (process.env.CHROME_PATH) launchOpts.executablePath = process.env.CHROME_PATH;

/* 收集所有要测的页面（相对 BASE 的路径） */
function collectPages() {
  const out = [];
  for (const f of fs.readdirSync(REPO)) {
    if (f.endsWith('.html')) out.push('/' + f);
  }
  const pagesDir = path.join(REPO, 'pages');
  if (fs.existsSync(pagesDir)) {
    for (const f of fs.readdirSync(pagesDir).sort()) {
      if (f.endsWith('.html')) out.push('/pages/' + f);
    }
  }
  return out.sort();
}

/* 仓库里所有 HTML 页面（根目录 + pages/） */
function allHtmlFiles() {
  const files = [];
  for (const f of fs.readdirSync(REPO)) if (f.endsWith('.html')) files.push(path.join(REPO, f));
  const pagesDir = path.join(REPO, 'pages');
  if (fs.existsSync(pagesDir)) {
    for (const f of fs.readdirSync(pagesDir)) if (f.endsWith('.html')) files.push(path.join(pagesDir, f));
  }
  return files;
}

/* 从磁盘读源文件，核对全站引用的版本号是否一致 */
function versionAudit() {
  const files = allHtmlFiles();

  const targets = ['js/api.js', 'js/datastore.js', 'js/portal.js', 'js/config/roles.js', 'css/portal.css'];
  const seen = {};       // target -> { version -> [pages] }
  const missing = {};    // target -> [pages] 完全没引用
  const unversioned = []; // "page: target 没带 ?v="

  for (const file of files) {
    const rel = path.relative(REPO, file).split(path.sep).join('/');
    /* ⚠️ 必须先剥掉注释（HTML + JS）：这是全文正则扫描，注释里提到「js/portal.js」这类字样
       会被误判成「引用了却没带 ?v=」。注释不是引用。 */
    const html = stripComments(fs.readFileSync(file, 'utf8'), true);
    for (const t of targets) {
      const re = new RegExp(t.replace(/[.\/]/g, '\\$&') + '(\\?v=([A-Za-z0-9._-]+))?', 'g');
      const hits = [...html.matchAll(re)];
      if (!hits.length) {
        (missing[t] = missing[t] || []).push(rel);
        continue;
      }
      for (const h of hits) {
        const v = h[2];
        if (!v) { unversioned.push(rel + ' → ' + t); continue; }
        seen[t] = seen[t] || {};
        (seen[t][v] = seen[t][v] || []).push(rel);
      }
    }
  }
  return { targets, seen, missing, unversioned, total: files.length };
}

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? '  → ' + extra : '')); }
}

/* 剥掉 HTML 注释与 JS 注释（块注释 + 行注释）—— **注释不是引用**。
   这个项目已经因此栽过两次：
     ① v1.7.0：注释里提到 `js/portal.js` / `Portal.`，被误判成「引用了却没带 ?v= / 用了没引」；
     ② v1.7.5：freshness 那段说明注释里提到 `fetchedAtLocal`，被误判成一个「没配标签的渲染点」。
   所以凡静态扫描都先过这里，别再各写各的。
   ⚠️ 只把注释字符换成空格、**保留换行** —— ⑥ 组要按行号报位置，行号必须稳定。 */
function stripComments(src, isHtml) {
  const keepLines = m => m.replace(/[^\n]/g, ' ');
  let s = String(src);
  if (isHtml) s = s.replace(/<!--[\s\S]*?-->/g, keepLines);
  s = s.replace(/\/\*[\s\S]*?\*\//g, keepLines);
  return s.split('\n').map(l => {
    const i = l.indexOf('//');
    return i === -1 ? l : l.slice(0, i);
  }).join('\n');
}

(async () => {
  let browser = null;
  try {
    /* ── 先做静态版本号审计（不依赖浏览器）── */
    console.log('\n① 全站版本号一致性（静态读盘）');
    const va = versionAudit();
    console.log('   共 ' + va.total + ' 个 HTML 页面');
    for (const t of va.targets) {
      const versions = Object.keys(va.seen[t] || {});
      const refCount = Object.values(va.seen[t] || {}).reduce((n, a) => n + a.length, 0);
      // 口径：只要求「凡引用的页面版本号一致」。不需要每页都引某个库
      // （login.html 就不使用 Portal.，不该被要求引入 portal.js）；
      // 「用了却没引」由 ③ 静态自洽检查负责。
      check(t + ' 版本号唯一' + (versions.length ? '（' + versions.join(', ') + '，' + refCount + ' 处引用）' : ''),
            versions.length === 1,
            '版本=' + JSON.stringify(versions) + ' 未引用页面=' + JSON.stringify(va.missing[t] || []));
    }
    check('所有引用都带 ?v= 缓存击穿参数', va.unversioned.length === 0,
          JSON.stringify(va.unversioned.slice(0, 8)));

    /* ── 逐页打开 ── */
    console.log('\n② 逐页打开');
    browser = await puppeteer.launch(launchOpts);
    const ctx = await browser.createBrowserContext();
    const page = await ctx.newPage();

    // 先登录，避免 pages/*.html 被 auth 重定向，掩盖真实问题
    await page.goto(BASE + '/login.html', { waitUntil: 'domcontentloaded' });
    const login = await page.evaluate(() => API.post('/api/login', { username: 'admin', password: 'admin2026' })
      .then(r => ({ ok: r.ok, error: r.error })));
    check('admin 登录（用于访问受限页）', login.ok, JSON.stringify(login));

    const pages = collectPages();
    for (const p of pages) {
      const errors = [];
      const bad = [];
      const onConsole = msg => { if (msg.type() === 'error') errors.push(msg.text().slice(0, 120)); };
      const onPageErr = e => errors.push('pageerror: ' + String(e.message).slice(0, 120));
      const onResp = r => {
        const u = r.url();
        if (u.indexOf(BASE) === 0 && r.status() >= 400) bad.push(r.status() + ' ' + u.replace(BASE, ''));
      };
      page.on('console', onConsole);
      page.on('pageerror', onPageErr);
      page.on('response', onResp);

      let status = 0, finalPath = '';
      try {
        const resp = await page.goto(BASE + p, { waitUntil: 'domcontentloaded' });
        status = resp ? resp.status() : 0;
        await new Promise(x => setTimeout(x, 450));  // 让 init 跑完，暴露竞态类报错
        finalPath = page.url().replace(BASE, '') || '/';
      } catch (e) {
        errors.push('goto: ' + String(e.message).slice(0, 120));
      }

      page.off('console', onConsole);
      page.off('pageerror', onPageErr);
      page.off('response', onResp);
      await page.goto('about:blank');

      const okStatus = status === 200;
      const okRes = bad.length === 0;
      const okErr = errors.length === 0;
      // 重定向不算失败（已登录访问 login.html 会被送回落地页），但必须显示出来，
      // 否则「在 A 页测到的结果其实来自 B 页」这类假阳性会被完全掩盖
      const note = (finalPath && finalPath !== p) ? '（重定向 → ' + finalPath + '）' : '';
      check(p + ' 打开正常' + note, okStatus && okRes && okErr,
            JSON.stringify({ status, final: finalPath, bad: bad.slice(0, 4), errors: errors.slice(0, 4) }));
    }

    /* ── 公共脚本引用自洽 ──
       为什么不查 window.Portal：已登录时访问 login.html 会被重定向到落地页，
       测到的其实是另一个页面的全局对象（本次就因此产生过假阳性）。
       直接静态读源码判断「用了就必须引」才可靠。 */
    console.log('\n③ 公共脚本引用自洽（静态读盘）');
    const RULES = [
      { use: /Portal\./,  need: 'js/portal.js',  label: 'Portal' },
      { use: /API\./,     need: 'js/api.js',     label: 'API' },
      { use: /Auth\./,    need: 'js/auth.js',    label: 'Auth' },
      { use: /Landing\./, need: 'js/landing.js', label: 'Landing' },
      { use: /DataStore\./, need: 'js/datastore.js', label: 'DataStore' }
    ];
    const htmlFiles = allHtmlFiles();
    const refBad = [];
    for (const f of htmlFiles) {
      const rel = path.relative(REPO, f).split(path.sep).join('/');
      // 同样先剥掉注释（HTML + JS）：注释里写「Portal.xxx」不该被当成"用了没引"
      const html = stripComments(fs.readFileSync(f, 'utf8'), true);
      const miss = RULES.filter(r => r.use.test(html) && html.indexOf(r.need) === -1).map(r => r.label);
      if (miss.length) refBad.push(rel + ' 用了 ' + miss.join('/') + ' 但未引入对应脚本');
    }
    check('凡使用公共库必先引入（' + htmlFiles.length + ' 页）', refBad.length === 0, JSON.stringify(refBad));

    /* ── ④ 抓取脚本的「本地时间」必须真的按北京时间渲染 ──
       为什么要有这条：抓取跑在 GitHub Actions 的 ubuntu-latest 上，那台机器本地时区是 **UTC**。
       `toLocaleString` 不带 timeZone 就按 runner 的本地时间渲染 ⇒ 页面上的「最近同步」
       会比北京时间早 8 小时（排期 11:00/17:00 显示成 03:00/09:00，看着像抓取时间完全不对）。
       这里**不是正则匹配**，而是把脚本里那行真代码抽出来、在 TZ=UTC 下跑一遍 ——
       所以改了实现也能测到，不会因为"写法换了"就假绿。 */
    console.log('\n④ 抓取脚本时区正确性（UTC 环境下必须是北京时间）');
    const fetchSrc = fs.readFileSync(path.join(REPO, 'scripts', 'fetch-openapi.js'), 'utf8');
    const line = (fetchSrc.split('\n').find(l => l.indexOf('fetchedAtLocal:') !== -1) || '').trim();
    const m = line.match(/new Date\(\)\.toLocaleString\([^)]*\)/);
    check('能定位到 fetchedAtLocal 的格式化代码', !!m, line.slice(0, 120));
    if (m) {
      const probe = 'const t=new Date("2026-09-11T13:11:57.000Z");'
        + 'process.stdout.write(t.' + m[0].replace(/^new Date\(\)\./, '') + ');';
      let out = '';
      try {
        out = childProcess.execFileSync(process.execPath, ['-e', probe],
          { env: Object.assign({}, process.env, { TZ: 'UTC' }), encoding: 'utf8' }).trim();
      } catch (e) { out = 'ERR ' + e.message; }
      check('TZ=UTC 下 13:11:57Z 渲染为北京 21:11:57（而非 13:11:57）',
            /^2026\/9\/11 21:11:57/.test(out), '实际输出: ' + JSON.stringify(out));
    }

    /* ── ⑤ 数据新鲜度判定（真跑，不是正则）──
       为什么要有：抓取失败时页面照旧显示上次的同步时间、**看着很正常**，
       「⚠ 数据已过期」标签是唯一能一眼看出来的东西 —— 它算错了就等于没有。
       阈值来源见 js/portal.js 注释：两次抓取最长的自然间隔是 17:00 → 次日 11:00 = 18 小时，
       所以 <20h 正常（留 2h 给 GitHub schedule 的延迟），≥26h 说明漏了一整个轮次。
       ⚠️ 这里必须 goto 一个真实页面：② 的循环最后把 page 停在了 about:blank，那上面没有 Portal。 */
    console.log('\n⑤ 数据新鲜度判定（浏览器内真跑）');
    await page.goto(BASE + '/index.html', { waitUntil: 'domcontentloaded' });
    const fresh = await page.evaluate(() => {
      const mk = h => new Date(Date.now() - h * 3600e3).toISOString();
      return {
        hasFn: typeof Portal.freshness === 'function' && typeof Portal.freshnessTag === 'function',
        h5: Portal.freshness(mk(5)).level,
        h18: Portal.freshness(mk(18)).level,
        h22: Portal.freshness(mk(22)).level,
        h40: Portal.freshness(mk(40)).level,
        none: Portal.freshness(undefined).level,
        bad: Portal.freshness('不是时间').level,
        tag: Portal.freshnessTag(mk(1))
      };
    });
    check('Portal.freshness / freshnessTag 已导出', fresh.hasFn, JSON.stringify(fresh).slice(0, 160));
    check('5 小时前 → ok', fresh.h5 === 'ok', '实际 ' + fresh.h5);
    check('18 小时前 → ok（跨夜 17:00→次日 11:00 属正常间隔，不能报黄）', fresh.h18 === 'ok', '实际 ' + fresh.h18);
    check('22 小时前 → warn（最近一次抓取可能没成功）', fresh.h22 === 'warn', '实际 ' + fresh.h22);
    check('40 小时前 → stale（至少漏了一整个轮次）', fresh.h40 === 'stale', '实际 ' + fresh.h40);
    check('无时间戳 → unknown（不是崩掉，也不是 ok）', fresh.none === 'unknown', '实际 ' + fresh.none);
    check('时间戳不可解析 → unknown', fresh.bad === 'unknown', '实际 ' + fresh.bad);
    /* 断言用 data-fresh 属性而不是中文文案：文案随时会改，状态码不会 */
    check('标签带 data-fresh 状态属性与文案',
          /data-fresh="ok"/.test(fresh.tag) && /数据正常/.test(fresh.tag), fresh.tag.slice(0, 160));

    /* ── ⑥ 每个「最近同步」渲染点都要带标签（静态读盘）──
       这条是**防复发**：本次实测「最近同步」散在 6 处
       （data.html / tables.html / board.js / settings.html / dashboard.html / admin.html），
       只给其中一处加标签等于没加 —— 用户看到过期数据的那一页很可能正是漏掉的那页。
       以后谁再加一处「最近同步」却忘了配标签，这里会红。
       ⚠️ 排除 js/portal.js：它是 freshness 的定义处，注释里本来就提到 fetchedAtLocal，
          不能被当成"渲染点"。 */
    console.log('\n⑥ 「最近同步」渲染点是否都接了新鲜度标签（静态读盘）');
    const renderFiles = allHtmlFiles().concat(
      fs.readdirSync(path.join(REPO, 'js'))
        .filter(f => f.endsWith('.js'))
        .map(f => path.join(REPO, 'js', f))
    ).filter(f => f.split(path.sep).join('/').indexOf('js/portal.js') === -1);
    const noTag = [];
    let renderPoints = 0;
    for (const f of renderFiles) {
      const rel = path.relative(REPO, f).split(path.sep).join('/');
      const raw = fs.readFileSync(f, 'utf8');
      // HTML 注释和 JS 注释都要剥（本项目已经因为"注释被当成引用"栽过两次）
      const lines = stripComments(raw, f.endsWith('.html')).split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].indexOf('fetchedAtLocal') === -1) continue;
        renderPoints++;
        // 前后各 3 行窗口：dashboard / settings 的标签与时间戳分写两行
        const win = lines.slice(Math.max(0, i - 3), i + 4).join('\n');
        if (win.indexOf('freshnessTag') === -1) noTag.push(rel + ':' + (i + 1));
      }
    }
    check('找到 ' + renderPoints + ' 个「最近同步」渲染点，且每个都带新鲜度标签',
          renderPoints >= 6 && noTag.length === 0,
          noTag.length ? JSON.stringify(noTag) : '渲染点只有 ' + renderPoints + ' 个（<6，断言几乎空转）');

    /* ── ⑦ 抓取失败通知接线自洽 ──
       定时任务跑在 GitHub 的机器上，失败只有一个红叉，没人会天天去看。
       这条通知是"数据悄悄过期"的第一道防线（第二道是页面上的过期标签）。
       ⚠️ 真跑一次 --dry-run 再 parse 它的 JSON，而不是只 grep 源码关键词 ——
          后者改坏了实现也照样绿。 */
    console.log('\n⑦ 抓取失败通知接线自洽');
    const wfSrc = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'fetch.yml'), 'utf8');
    check('workflow 有失败才跑的步骤（if: failure()）', /if:\s*failure\(\)/.test(wfSrc), '未找到 if: failure()');
    check('workflow 调用通知脚本', /node scripts\/notify-failure\.js/.test(wfSrc));
    check('workflow 注入 DINGTALK_ROBOT_WEBHOOK Secret', /secrets\.DINGTALK_ROBOT_WEBHOOK/.test(wfSrc));

    const notifyPath = path.join(REPO, 'scripts', 'notify-failure.js');
    check('通知脚本 scripts/notify-failure.js 存在', fs.existsSync(notifyPath));
    if (fs.existsSync(notifyPath)) {
      const notifySrc = fs.readFileSync(notifyPath, 'utf8');
      /* 通知是附加动作：发不出去不该把 job 再弄红一次，否则真正的原因
         （抓取那一步的日志）会被淹没在第二个红叉里。 */
      check('通知脚本不会因发送失败而非 0 退出（不得出现 process.exit(1)）',
            !/process\.exit\(1\)/.test(notifySrc), '发现 process.exit(1)');

      let dump = '', dumpErr = '';
      try {
        dump = childProcess.execFileSync(process.execPath, [notifyPath, '--dry-run'], {
          cwd: REPO, encoding: 'utf8',
          env: Object.assign({}, process.env, {
            GITHUB_SERVER_URL: 'https://github.com',
            GITHUB_REPOSITORY: 'alextok200-boop/team-portal',
            GITHUB_RUN_ID: '42',
            GITHUB_WORKFLOW: '钉钉日报数据抓取',
            GITHUB_EVENT_NAME: 'schedule'
          })
        });
      } catch (e) { dumpErr = e.message; }
      check('dry-run 能跑通（退出码 0）', !dumpErr, dumpErr);

      const jsonLine = (dump.split('\n').find(l => l.trim().charAt(0) === '{') || '').trim();
      let payload = null;
      try { payload = JSON.parse(jsonLine); } catch (e) { /* 由下一条断言报出 */ }
      check('dry-run 吐出的 body 是合法 JSON', !!payload, jsonLine.slice(0, 140));
      if (payload) {
        const text = (payload.text && payload.text.content) || '';
        check('msgtype=text 且正文含机器人安全设置的关键词「日报抓取」',
              payload.msgtype === 'text' && text.indexOf('日报抓取') !== -1, text.slice(0, 90));
        check('正文含可点的运行日志链接', /actions\/runs\/42/.test(text), text.slice(0, 200));
      }
    }

    /* ── ⑧ 页面间跳转必须能落到真实文件 ──
       为什么要有这条：每页 <head> 都写了 <base href="/team-portal/">，
       相对 URL 一律相对**站点根**解析，而不是相对当前目录。
       于是在 pages/ 下的页面里裸写 `tables.html`，浏览器会去请求
       /team-portal/tables.html —— 真实文件却在 /team-portal/pages/tables.html ⇒ 404。
       最坑的是静态看代码"像是对的"：文件名没错、目标页也在、路径也没打错字。
       本仓踩过：js/board.js 的看板钻取链接（核心指标卡 ×6 + 两张表）三处都少一层 pages/。
       判定基准 = 站点根：相对链接要么写成 pages/xxx.html，要么是根级页面（index/login）。
       ⚠️ 两个坑：① 必须先剥注释（landing.js 注释里就写着 index.html / login.html，不剥即假阳性）；
                  ② 只认「链接位置」上的相对路径，别把 `c.html_url` 这类字段名当成链接。
       反过来，写全 `pages/xxx.html` 但目标页不存在（打错字 / 改名没同步）也一并拦下。 */
    console.log('\n⑧ 页面间跳转链接可落地（静态读盘）');
    const ROOT_LEVEL_PAGES = ['index.html', 'login.html'];
    const walkJs = [];
    (function walk(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        if (e.name === 'vendor' || e.name === 'node_modules') continue;
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.js')) walkJs.push(p);
      }
    })(path.join(REPO, 'js'));

    const scanTargets = walkJs.map(f => ({ f: f, isHtml: false }))
      .concat(allHtmlFiles().map(f => ({ f: f, isHtml: true })));

    /* 只匹配链接位置上、以引号包起来的相对 .html 路径；
       绝对 URL（https://…）和字段名（c.html_url）都不会命中。 */
    const LINK_RE = /(?:href|data-href)\s*=\s*(["'])((?:\.\.\/)*[A-Za-z0-9_.-]+\.html(?:\?[^"']*)?)\1/g;
    const badLinks = [];
    const missingTargets = [];
    for (const t of scanTargets) {
      const rel = path.relative(REPO, t.f).split(path.sep).join('/');
      const src = stripComments(fs.readFileSync(t.f, 'utf8'), t.isHtml);
      let m;
      while ((m = LINK_RE.exec(src)) !== null) {
        const url = m[2];
        const file = url.split('?')[0];
        if (ROOT_LEVEL_PAGES.indexOf(file) !== -1) continue;   // 根级页面，合法
        if (file.indexOf('pages/') !== 0) {
          badLinks.push(rel + ' → ' + url + '  （相对站点根应为 pages/' + file + '）');
          continue;
        }
        if (!fs.existsSync(path.join(REPO, file))) missingTargets.push(rel + ' → ' + url);
      }
    }
    check('页面内跳转都按「相对站点根」写对（扫 ' + scanTargets.length + ' 个文件）',
          badLinks.length === 0, JSON.stringify(badLinks));
    check('引用的页面文件都真实存在', missingTargets.length === 0, JSON.stringify(missingTargets));

    await page.close();
    await ctx.close();
  } finally {
    if (browser) await browser.close();
  }

  console.log('\n══════ 汇总 ══════');
  console.log(' PASS: ' + pass + '   FAIL: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('脚本异常:', e); process.exit(1); });
