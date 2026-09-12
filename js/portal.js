/* ============================================================
   portal.js —— 公共 UI（导航 / 守卫 / 提示）
   ------------------------------------------------------------
   依赖：api.js + auth.js（须先加载）
   提供：Portal.boot(opts) / toast / esc / fmtTime / fmtNum
         / freshness(fetchedAt) / freshnessTag(fetchedAt)
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
    freshnessTag: freshnessTag
  };
})();
