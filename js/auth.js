/* ============================================================
   auth.js —— 认证与权限（API 驱动）
   ------------------------------------------------------------
   依赖：api.js（须先加载）
   提供：Auth.login / logout / init / getUser / canAccess / requireRole

   ⚠️ 权限的唯一事实源在服务端 data/roles.json。
      前端只在渲染时做过滤，真正的拦截由后端接口鉴权兜底。
   ============================================================ */

var Auth = (function () {
  'use strict';

  /* ── 当前用户（内存缓存 + localStorage 回填）──── */
  function getUser() {
    if (_user) return _user;
    _user = API.getCachedUser();
    return _user;
  }
  var _user = null;

  function setUser(u) {
    _user = u || null;
    API.setCachedUser(u);
  }

  function isAuthenticated() {
    return !!API.getToken() && !!getUser();
  }

  /* ── 登录 ────────────────────────────────────── */
  function login(username, password) {
    return API.post('/api/login', { username: username, password: password }).then(function (res) {
      if (res.ok && res.token) {
        API.setToken(res.token);
        setUser(res.user);
      }
      return res;
    });
  }

  /* ── 登出 ────────────────────────────────────── */
  function logout() {
    return API.post('/api/logout', {}).then(function () {
      API.clear();
      _user = null;
      window.location.href = Site.url('/login.html');
    }).catch(function () {
      API.clear();
      window.location.href = Site.url('/login.html');
    });
  }

  /* ── 页面初始化：校验会话并刷新用户信息 ──────── */
  function init() {
    if (!API.getToken()) return Promise.resolve(null);
    return API.get('/api/me').then(function (res) {
      if (res.ok && res.user) {
        setUser(res.user);
        return res.user;
      }
      API.clear();
      _user = null;
      return null;
    });
  }

  /* ── 权限判断（前端过滤用）──────────────────── */
  function pages() {
    var u = getUser();
    return (u && u.pages) || [];
  }

  function canAccess(pagePath) {
    var list = pages();
    if (!list.length) return false;
    if (list.indexOf('*') !== -1) return true;

    var target = String(pagePath || '').split('?')[0];
    target = target.replace(/^\.+/, '');
    if (target.charAt(0) !== '/') target = '/' + target;
    // 剥掉 SITE_BASE 前缀（GitHub Pages 子路径部署时 location.pathname 含 /team-portal/）
    if (window.Site && Site.strip) target = Site.strip(target);

    return list.some(function (p) {
      if (target === p) return true;
      // 允许目录级匹配：/pages/data.html 命中 /pages/data
      var base = p.replace(/\.html$/, '');
      return target === base || target.indexOf(base + '/') === 0;
    });
  }

  function hasRole(role) {
    var u = getUser();
    if (!u) return false;
    if (Object.prototype.toString.call(role) === '[object Array]') return role.indexOf(u.role) !== -1;
    return u.role === role;
  }

  /* ── 页面守卫 ────────────────────────────────── */
  function guard(requiredRoles) {
    if (!isAuthenticated()) {
      window.location.href = Site.url('/login.html?next=' + encodeURIComponent(window.location.pathname));
      return null;
    }
    var u = getUser();
    if (!canAccess(window.location.pathname)) {
      window.location.href = Site.url('/pages/denied.html?from=' + encodeURIComponent(window.location.pathname));
      return null;
    }
    if (requiredRoles) {
      var arr = Object.prototype.toString.call(requiredRoles) === '[object Array]' ? requiredRoles : [requiredRoles];
      if (arr.indexOf(u.role) === -1) {
        window.location.href = Site.url('/pages/denied.html?from=' + encodeURIComponent(window.location.pathname));
        return null;
      }
    }
    return u;
  }

  return {
    login: login,
    logout: logout,
    init: init,
    getUser: getUser,
    isAuthenticated: isAuthenticated,
    canAccess: canAccess,
    hasRole: hasRole,
    guard: guard
  };
})();
