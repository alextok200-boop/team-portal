/* ============================================================
   portal.js —— 公共 UI（导航 / 守卫 / 提示）
   ------------------------------------------------------------
   依赖：api.js + auth.js（须先加载）
   提供：Portal.boot(opts) / toast / esc / fmtTime / fmtNum
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

  /* ── 渲染顶栏 ────────────────────────────────── */
  function renderNav(user, nav, title) {
    var current = window.Site && Site.strip ? Site.strip(window.location.pathname) : window.location.pathname;
    var links = (nav || []).filter(function (item) {
      return Auth.canAccess(item.path);
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

  return {
    boot: boot,
    loadConfig: loadConfig,
    renderNav: renderNav,
    toast: toast,
    esc: esc,
    fmtTime: fmtTime,
    fmtNum: fmtNum
  };
})();
