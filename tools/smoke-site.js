#!/usr/bin/env node
/* ============================================================
   smoke-site.js —— 全站页面冒烟（每页都真的打开一遍）

   为什么需要：
     纯静态站没有构建期校验。改了公共 js（api/datastore/portal）或版本号，
     很容易出现「某个页面 404 了依赖」「某个页面少引入了公共脚本」
     「console 报错但肉眼看不出来」——只有逐页打开才发现。

   覆盖（每个 HTML 页面）：
     ① HTTP 200，无 4xx/5xx 资源请求
     ② 无 console error / 未捕获异常
     ③ 公共脚本就位：window.API / window.DataStore / window.Portal
     ④ 缓存击穿版本号全站一致（js/api.js?v=、js/datastore.js?v=、
        js/portal.js?v=、css/portal.css?v=）

   前置：仓库父目录起 python -m http.server 8971
   运行：node tools/smoke-site.js
   ============================================================ */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

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
    /* ⚠️ 必须先剥掉 HTML 注释：这是全文正则扫描，注释里提到「js/portal.js」这类字样
       会被误判成「引用了却没带 ?v=」。注释不是引用。 */
    const html = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
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
      // 同样先剥掉 HTML 注释：注释里写「Portal.xxx」不该被当成"用了没引"
      const html = fs.readFileSync(f, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
      const miss = RULES.filter(r => r.use.test(html) && html.indexOf(r.need) === -1).map(r => r.label);
      if (miss.length) refBad.push(rel + ' 用了 ' + miss.join('/') + ' 但未引入对应脚本');
    }
    check('凡使用公共库必先引入（' + htmlFiles.length + ' 页）', refBad.length === 0, JSON.stringify(refBad));

    await page.close();
    await ctx.close();
  } finally {
    if (browser) await browser.close();
  }

  console.log('\n══════ 汇总 ══════');
  console.log(' PASS: ' + pass + '   FAIL: ' + fail);
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('脚本异常:', e); process.exit(1); });
