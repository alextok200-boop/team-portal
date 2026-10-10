/* ============================================================
   portal.js —— 公共 UI（导航 / 守卫 / 提示）
   ------------------------------------------------------------
   依赖：api.js + auth.js（须先加载）
   提供：Portal.boot(opts) / toast / esc / fmtTime / fmtNum
         / freshness(fetchedAt) / freshnessTag(fetchedAt)
         / palette（⌘K 命令面板：搜页面 / 数据表 / 动作，键盘直达）
   ============================================================ */

var Portal = (function () {
  'use strict';

  var CONFIG_KEY = 'portal_config';
  var _nav = null;
  var _roles = null;

  /* ── 站点配置（导航项 + 角色清单）────────────── */
  function loadConfig() {
    if (_nav) return Promise.resolve({ nav: _nav, roles: _roles });
    try {
      var c = JSON.parse(sessionStorage.getItem(CONFIG_KEY) || 'null');
      if (c && c.nav) { _nav = c.nav; _roles = c.roles || {}; return Promise.resolve({ nav: _nav, roles: _roles }); }
    } catch (e) { /* ignore */ }
    return API.get('/api/config').then(function (res) {
      _nav = (res.ok && res.nav) || [];
      _roles = (res.ok && res.roles) || {};
      try { sessionStorage.setItem(CONFIG_KEY, JSON.stringify({ nav: _nav, roles: _roles })); } catch (e) { /* ignore */ }
      return { nav: _nav, roles: _roles };
    });
  }

  /* ── 渲染顶栏 ──────────────────────────────────
     nav: false 的页面（数据中心/数据指标/内容管理/成员管理/系统设置/登录日志）
     对**能进管理后台的人**不再占顶栏 —— 这些入口已收进「管理后台 → 后台入口」。
     进不了管理后台的角色（主管、成员）必须照旧保留：入口藏了又没给替代路径 = 把页面锁死。 */
  function usesAdminHub() {
    return Auth.canAccess('/pages/admin.html');
  }

  function renderNav(user, nav, title) {
    var current = window.Site && Site.strip ? Site.strip(window.location.pathname) : window.location.pathname;
    var hub = usesAdminHub();
    var links = (nav || []).filter(function (item) {
      if (!Auth.canAccess(item.path)) return false;
      if (hub && item.nav === false) return false;
      return true;
    }).map(function (item) {
      var active = current === item.path ? ' class="active"' : '';
      // 去前导 / 变相对路径，让 <base> 正确解析到子路径
      return '<a href="' + esc(String(item.path).replace(/^\//, '')) + '"' + active + '>' + esc(item.label) + '</a>';
    }).join('');

    var initial = esc((user.name || '?').charAt(0));
    var roleName = esc(user.roleName || user.role);

    var html =
      '<header class="portal-header">' +
        '<nav class="portal-nav">' +
          '<a href="' + esc(Site.url('/pages/board.html')) + '" class="portal-logo">' +
            '<span class="dot"></span>' + esc(title || '团队门户') +
          '</a>' +
          '<div class="portal-nav-links">' +
            links +
            '<span class="user-chip">' +
              '<span class="avatar" style="background:' + (user.color || '#00ffa3') + '">' + initial + '</span>' +
              esc(user.name) + ' · ' + roleName +
            '</span>' +
            '<button class="logout-btn" type="button" id="logoutBtn">登出</button>' +
          '</div>' +
        '</nav>' +
      '</header>';

    document.body.insertAdjacentHTML('afterbegin', html);
    var btn = document.getElementById('logoutBtn');
    if (btn) btn.addEventListener('click', function () { Auth.logout(); });

    /* ⌘K 命令面板：顶栏按钮 + 全局快捷键（数据与样式纪律见 installPalette 注释） */
    installPalette();
  }

  /* ── 页面启动流程：校验 → 鉴权 → 渲染导航 ────── */
  function boot(opts) {
    opts = opts || {};
    return Auth.init().then(function (user) {
      if (!user) {
        window.location.href = Site.url('/login.html?next=' + encodeURIComponent(window.location.pathname));
        return null;
      }
      if (!Auth.canAccess(window.location.pathname)) {
        window.location.href = Site.url('/pages/denied.html?from=' + encodeURIComponent(window.location.pathname));
        return null;
      }
      if (opts.roles && !Auth.hasRole(opts.roles)) {
        window.location.href = Site.url('/pages/denied.html?from=' + encodeURIComponent(window.location.pathname));
        return null;
      }
      return loadConfig().then(function (cfg) {
        renderNav(user, cfg.nav, opts.title);
        return user;
      });
    }).catch(function () {
      window.location.href = Site.url('/login.html');
      return null;
    });
  }

  /* ── 轻提示 ──────────────────────────────────── */
  function toast(msg, type) {
    var el = document.createElement('div');
    el.textContent = msg;
    el.style.cssText =
      'position:fixed;bottom:28px;left:50%;transform:translateX(-50%);' +
      'padding:12px 22px;border-radius:8px;font-size:14px;z-index:999;' +
      'background:' + (type === 'error' ? 'rgba(255,94,201,0.95)' : 'rgba(0,255,163,0.95)') + ';' +
      'color:#07130d;font-weight:600;box-shadow:0 6px 24px rgba(0,0,0,0.4);max-width:80vw';
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 2600);
  }

  /* ── 通用弹窗（admin / content 等页共用，页面无需自己写 markup）── */
  var _onSubmit = null;

  function closeModal() {
    var m = document.getElementById('portalModal');
    if (m) m.classList.remove('show');
    _onSubmit = null;
  }

  function ensureModal() {
    var m = document.getElementById('portalModal');
    if (m) return m;
    document.body.insertAdjacentHTML('beforeend',
      '<div class="modal" id="portalModal">' +
        '<div class="modal-box">' +
          '<h3 id="portalModalTitle">编辑</h3>' +
          '<form id="portalModalForm">' +
            '<div id="portalModalBody"></div>' +
            '<div class="modal-foot">' +
              '<button type="button" class="btn btn-ghost" id="portalModalCancel">取消</button>' +
              '<button type="submit" class="btn btn-primary" id="portalModalSave">保存</button>' +
            '</div>' +
          '</form>' +
        '</div>' +
      '</div>');
    m = document.getElementById('portalModal');
    m.addEventListener('click', function (e) { if (e.target === m) closeModal(); });
    document.getElementById('portalModalCancel').addEventListener('click', closeModal);
    document.getElementById('portalModalForm').addEventListener('submit', function (e) {
      e.preventDefault();
      if (_onSubmit) _onSubmit();
    });
    return m;
  }

  /* modal({ title, body, submitText, onSubmit }) → { close } */
  function modal(opts) {
    opts = opts || {};
    var m = ensureModal();
    document.getElementById('portalModalTitle').textContent = opts.title || '';
    document.getElementById('portalModalBody').innerHTML = opts.body || '';
    document.getElementById('portalModalSave').textContent = opts.submitText || '保存';
    _onSubmit = opts.onSubmit || null;
    m.classList.add('show');
    var first = document.querySelector('#portalModalBody input, #portalModalBody textarea, #portalModalBody select');
    if (first) setTimeout(function () { try { first.focus(); } catch (e) { /* ignore */ } }, 30);
    return { close: closeModal, root: m };
  }

  /* ── 工具 ────────────────────────────────────── */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso);
      var p = function (n) { return n < 10 ? '0' + n : n; };
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
             ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    } catch (e) { return String(iso); }
  }

  /* 数字格式化：带千分位，保留必要小数 */
  function fmtNum(v) {
    if (v === null || v === undefined || v === '') return '—';
    var n = Number(String(v).replace(/,/g, ''));
    if (isNaN(n)) return String(v);
    var s = (Math.abs(n) >= 1000)
      ? n.toLocaleString('zh-CN', { maximumFractionDigits: 2 })
      : String(Math.round(n * 10000) / 10000);
    return s;
  }

  /* ── 数据新鲜度 ────────────────────────────────
     为什么需要这个：抓取跑在 GitHub Actions 的机器上（每日 11:00 / 17:00 北京时间），
     失败只体现为 Actions 页面里的一个红叉。而页面上照旧写着「最近同步：2026/9/9 17:00」，
     **看着完全正常** —— 没人会发现它已经两天没动了。这里把它变成一眼能看出来的标签。

     ⚠️ 时间差一律用 fetchedAt（UTC ISO，带 Z）跟 Date.now() 相减，**与浏览者所在时区无关**。
        不要去 parse fetchedAtLocal —— 那只是给人和 CI 看的展示字符串（格式随时可能变）。

     阈值怎么定的（对应 .github/workflows/fetch.yml 的排期）：
       两次抓取之间最长的自然间隔 = 17:00 → 次日 11:00 = **18 小时**。
       所以 < 20h 都算正常（18h + 2h 容错，GitHub 的 schedule 本身就会延迟）。
       ≥ 26h（24h 再宽限 2h）说明至少漏掉一整个轮次，必须标红。 */
  var FRESH_WARN_H  = 20;
  var FRESH_STALE_H = 26;

  var FRESH_TONE = {
    ok:      { bg: 'rgba(0,255,163,0.12)',   fg: 'var(--neon-green)', bd: 'rgba(0,255,163,0.3)' },
    warn:    { bg: 'rgba(255,196,0,0.12)',   fg: '#ffc400',           bd: 'rgba(255,196,0,0.35)' },
    stale:   { bg: 'rgba(255,77,94,0.15)',   fg: '#ff4d5e',           bd: 'rgba(255,77,94,0.45)' },
    unknown: { bg: 'rgba(160,170,190,0.12)', fg: 'var(--text-dim)',   bd: 'rgba(160,170,190,0.3)' }
  };

  function freshness(fetchedAt) {
    if (!fetchedAt) return { level: 'unknown', hours: null, text: '同步时间未知' };
    var t = new Date(fetchedAt).getTime();
    if (isNaN(t)) return { level: 'unknown', hours: null, text: '同步时间无法识别' };
    var hours = (Date.now() - t) / 3600000;
    if (hours < 0) hours = 0;            // 轻微时钟漂移，不要报成异常
    var ago = hours < 1 ? '不到 1 小时'
            : (hours < 48 ? Math.round(hours) + ' 小时' : Math.round(hours / 24) + ' 天');
    if (hours < FRESH_WARN_H)  return { level: 'ok',   hours: hours, text: '数据正常 · ' + ago + '前更新' };
    if (hours < FRESH_STALE_H) return { level: 'warn', hours: hours, text: '数据偏旧 · ' + ago + '前更新' };
    return { level: 'stale', hours: hours, text: '⚠ 数据已过期 · 已 ' + ago + '未更新' };
  }

  /* 返回可直接塞进 innerHTML 的标签。
     样式**内联**（故意不写进 portal.css）：这样加功能不必动 css，
     全站 15 个 HTML 的 css 版本号也不用跟着跳 —— 少一个缓存维度就少一类「改了不起效」。
     data-fresh / class 上的 level 是给回归断言用的：断言状态码比断言中文文案稳。 */
  function freshnessTag(fetchedAt) {
    var f = freshness(fetchedAt);
    var c = FRESH_TONE[f.level] || FRESH_TONE.unknown;
    return '<span class="fresh-tag fresh-' + f.level + '" data-fresh="' + f.level + '"' +
      ' title="抓取排期：每日 11:00 / 17:00（北京时间）"' +
      ' style="display:inline-block;padding:2px 10px;border-radius:999px;font-size:12px;' +
      'font-weight:600;white-space:nowrap;background:' + c.bg + ';color:' + c.fg +
      ';border:1px solid ' + c.bd + '">' + esc(f.text) + '</span>';
  }

  /* ── ⌘K 命令面板（全局搜索：页面 / 数据表 / 动作）──────────
     学自品牌官网的命令面板工作流：键盘直达任何页面，不用先记住入口在哪一层。
     数据纪律（与顶栏导航吃同一份数据，绝不另抄清单）：
       · 页面项 = loadConfig() 的 nav（即 PAGE_CATALOG），按 Auth.canAccess 过滤。
         nav:false 的页面（收进管理后台的工具页）在面板里**照常可达** ——
         面板是快捷方式不是权限边界，能过 canAccess 就该搜得到。
       · 数据表项懒加载 /api/data/daily 的表清单（仅当能进 tables.html 才加载），
         每个会话只拉一遍并缓存；表名/分组/行数全部来自快照本身，不硬编码。
       · 样式由 JS 注入 <style id="portalPaletteStyle">（沿用 freshnessTag 的
         「样式跟功能走」惯例，不动 css/portal.css —— 否则 15 页 css ?v= 全要跳）。 */
  var _paletteStyleDone = false;
  var _ppPageItems = [];    // 页面 + 动作（同步，来自 loadConfig）
  var _ppTableItems = [];   // 数据表（懒加载缓存；[] = 加载过但为空/失败/无权）
  var _ppFiltered = [];     // 当前过滤结果（键盘导航的下标映射）
  var _ppBox = null;        // 面板 wrap（懒创建，页面级单例）
  var _ppActive = 0;        // 当前高亮项在 _ppFiltered 里的下标

  function ensurePaletteStyle() {
    if (_paletteStyleDone) return;
    _paletteStyleDone = true;
    var s = document.createElement('style');
    s.id = 'portalPaletteStyle';
    /* 色值与 board.js 的 C 常量对齐（card #120b1f / text #eef0ff）；
       token 只用 portal.css 里确定存在的 --border / --text-dim / --neon-* */
    s.textContent =
      '.pp-btn{display:inline-flex;align-items:center;gap:6px;padding:4px 12px;border-radius:999px;' +
        'background:rgba(0,200,255,0.08);border:1px solid var(--border);color:var(--text-dim);' +
        'font-size:12px;cursor:pointer;white-space:nowrap}' +
      '.pp-btn:hover{color:var(--neon-blue);border-color:rgba(0,200,255,0.4)}' +
      '.pp-btn kbd{font-family:inherit;font-size:11px;padding:0 5px;border-radius:4px;' +
        'border:1px solid var(--border);background:rgba(0,0,0,0.3);color:var(--text-dim)}' +
      '.pp-wrap{position:fixed;inset:0;z-index:2000;background:rgba(4,2,10,0.72);' +
        'display:none;align-items:flex-start;justify-content:center;padding-top:12vh}' +
      '.pp-wrap.show{display:flex}' +
      '.pp-box{width:min(560px,92vw);background:#120b1f;border:1px solid rgba(0,255,163,0.25);' +
        'border-radius:12px;box-shadow:0 24px 80px rgba(0,0,0,0.6);overflow:hidden}' +
      '.pp-input{width:100%;box-sizing:border-box;padding:14px 18px;background:transparent;border:none;' +
        'outline:none;color:#eef0ff;font-size:15px}' +
      '.pp-list{max-height:46vh;overflow:auto;border-top:1px solid var(--border)}' +
      '.pp-group{padding:8px 18px 4px;font-size:11px;color:var(--text-dim);letter-spacing:2px}' +
      '.pp-item{display:flex;align-items:center;justify-content:space-between;gap:12px;' +
        'padding:9px 18px;cursor:pointer;border-left:2px solid transparent}' +
      '.pp-item.active{background:rgba(0,255,163,0.08);border-left-color:var(--neon-green)}' +
      '.pp-t{color:#eef0ff;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '.pp-s{color:var(--text-dim);font-size:12px;white-space:nowrap}' +
      '.pp-empty{padding:22px 18px;color:var(--text-dim);font-size:13px;text-align:center}';
    document.head.appendChild(s);
  }

  /* 页面项 + 动作项。当前页不列（已经在上面了，搜它没有意义）。 */
  function palettePageItems(cfg) {
    var items = [];
    var current = window.Site && Site.strip
      ? Site.strip(window.location.pathname) : window.location.pathname;
    ((cfg && cfg.nav) || []).forEach(function (item) {
      if (!Auth.canAccess(item.path)) return;                 // 权限过滤同 renderNav，不多不少
      var p = String(item.path);
      var stripped = Site.strip ? Site.strip(p) : p;
      if (stripped === current) return;
      items.push({
        group: '页面',
        title: item.label,
        sub: item.nav === false ? '后台入口' : stripped,
        path: p
      });
    });
    items.push({ group: '动作', title: '登出', sub: '退出当前账号', run: function () { Auth.logout(); } });
    return items;
  }

  /* 数据表项：懒加载快照表清单（一次性，失败/无权 → 空数组，不报错不重试） */
  function loadTableItems() {
    if (_ppTableItems.length) return Promise.resolve(_ppTableItems);
    if (_ppTableItems.loaded) return Promise.resolve([]);
    if (!Auth.canAccess('/pages/tables.html')) { _ppTableItems.loaded = true; return Promise.resolve([]); }
    _ppTableItems.loaded = true;
    return API.get('/api/data/daily').then(function (res) {
      var tables = (res && res.ok && res.data && res.data.tables) || [];
      _ppTableItems = tables.filter(function (t) { return t && t.key && !t.error; }).map(function (t) {
        return {
          group: '数据表',
          title: t.name || t.key,
          sub: (t.group || '') + (t.rows && t.rows.length ? ' · ' + t.rows.length + ' 行' : ''),
          path: '/pages/tables.html?table=' + encodeURIComponent(t.key)
        };
      });
      return _ppTableItems;
    }).catch(function () { return []; });
  }

  function paletteRender(query) {
    if (!_ppBox) return;
    var listEl = _ppBox.querySelector('.pp-list');
    var q = String(query || '').trim().toLowerCase();
    _ppFiltered = _ppPageItems.concat(_ppTableItems).filter(function (it) {
      if (!q) return true;
      return (it.title + ' ' + (it.sub || '') + ' ' + it.group).toLowerCase().indexOf(q) !== -1;
    });
    var html = '', lastGroup = null;
    _ppActive = 0;
    _ppFiltered.forEach(function (it, i) {
      if (it.group !== lastGroup) { html += '<div class="pp-group">' + esc(it.group) + '</div>'; lastGroup = it.group; }
      html += '<div class="pp-item' + (i === 0 ? ' active' : '') + '" data-idx="' + i + '">' +
        '<span class="pp-t">' + esc(it.title) + '</span>' +
        '<span class="pp-s">' + esc(it.sub || '') + '</span></div>';
    });
    if (!_ppFiltered.length) html = '<div class="pp-empty">没有匹配的结果</div>';
    listEl.innerHTML = html;
  }

  function paletteMove(dir) {
    if (!_ppBox || !_ppFiltered.length) return;
    var items = _ppBox.querySelectorAll('.pp-item');
    var cur = _ppActive;
    var next = Math.min(items.length - 1, Math.max(0, cur + dir));
    if (items[cur]) items[cur].classList.remove('active');
    if (items[next]) {
      items[next].classList.add('active');
      try { items[next].scrollIntoView({ block: 'nearest' }); } catch (e) { /* ignore */ }
    }
    _ppActive = next;
  }

  function paletteGo(idx) {
    var it = _ppFiltered[idx];
    if (!it) return;
    closePalette();
    if (it.run) { it.run(); return; }
    window.location.href = Site.url(it.path);
  }

  function openPalette() {
    ensurePaletteStyle();
    if (!_ppBox) {
      _ppBox = document.createElement('div');
      _ppBox.className = 'pp-wrap';
      _ppBox.id = 'paletteWrap';
      _ppBox.innerHTML =
        '<div class="pp-box">' +
          '<input class="pp-input" type="text" placeholder="搜索页面 / 数据表 / 动作…" autocomplete="off">' +
          '<div class="pp-list"></div>' +
        '</div>';
      document.body.appendChild(_ppBox);
      _ppBox.addEventListener('click', function (e) { if (e.target === _ppBox) closePalette(); });
      var inp = _ppBox.querySelector('.pp-input');
      inp.addEventListener('input', function () { paletteRender(this.value); });
      /* ↑↓ 移动 / Enter 跳转 —— 挂在 input 上，别挂 document（会跟全局快捷键打架） */
      inp.addEventListener('keydown', function (e) {
        if (e.key === 'ArrowDown') { e.preventDefault(); paletteMove(1); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); paletteMove(-1); }
        else if (e.key === 'Enter') { e.preventDefault(); paletteGo(_ppActive); }
      });
      _ppBox.querySelector('.pp-list').addEventListener('click', function (e) {
        var el = e.target && e.target.closest ? e.target.closest('.pp-item') : null;
        if (el) paletteGo(Number(el.getAttribute('data-idx')));
      });
    }
    _ppBox.classList.add('show');
    var input = _ppBox.querySelector('.pp-input');
    input.value = '';
    setTimeout(function () { try { input.focus(); } catch (e) { /* ignore */ } }, 20);
    loadConfig().then(function (cfg) {
      _ppPageItems = palettePageItems(cfg);
      paletteRender('');
    });
    loadTableItems().then(function () {
      if (_ppBox && _ppBox.classList.contains('show')) {
        paletteRender(_ppBox.querySelector('.pp-input').value);
      }
    });
  }

  function closePalette() {
    if (_ppBox) _ppBox.classList.remove('show');
  }

  function togglePalette() {
    if (_ppBox && _ppBox.classList.contains('show')) closePalette();
    else openPalette();
  }

  /* 安装：顶栏按钮 + 全局快捷键。renderNav 每页只跑一次；
     面板元素是懒创建的，这里只装按钮和监听器（幂等，防重复注入）。 */
  function installPalette() {
    if (document.getElementById('paletteBtn')) return;
    ensurePaletteStyle();
    var chip = document.querySelector('.portal-nav-links .user-chip');
    if (!chip) return;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pp-btn';
    btn.id = 'paletteBtn';
    btn.title = '搜索页面 / 数据表（Ctrl+K）';
    btn.innerHTML = '搜索 <kbd>Ctrl K</kbd>';
    btn.addEventListener('click', openPalette);
    chip.parentNode.insertBefore(btn, chip);

    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        togglePalette();
      } else if (e.key === 'Escape') {
        closePalette();
      }
    });
  }

  return {
    boot: boot,
    loadConfig: loadConfig,
    renderNav: renderNav,
    modal: modal,
    closeModal: closeModal,
    toast: toast,
    esc: esc,
    fmtTime: fmtTime,
    fmtNum: fmtNum,
    freshness: freshness,
    freshnessTag: freshnessTag,
    palette: { open: openPalette, close: closePalette, toggle: togglePalette }
  };
})();
