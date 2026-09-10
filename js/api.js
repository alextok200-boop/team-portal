/* ============================================================
   api.js —— 静态版「本地数据层」
   ------------------------------------------------------------
   替代原 Node 后端：把 /api/* 调用映射到本地实现。
   - 登录鉴权：SHA-256 哈希比对（异步 crypto.subtle）
   - 会话 / 用户 / 角色 / 日志：localStorage 持久化
   - 日报数据：fetch data/daily.json（静态快照）

   ⚠️ 静态版是「弱鉴权」：源码可见、可被绕过，仅供内部轻量使用。
      密码哈希的作用只是避免明文裸奔，不构成真正的安全边界。
   ============================================================ */

var API = (function () {
  'use strict';

  var K = {
    token: 'portal_token',
    user:  'portal_user',
    users: 'portal_users',
    roles: 'portal_roles',
    logs:  'portal_logs'
  };

  /* ── 基础存储 ────────────────────────────────── */
  function readJSON(key, fb) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fb; }
    catch (e) { return fb; }
  }
  function writeJSON(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* 满则忽略 */ }
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ── 用户 / 角色 / 日志（默认 + localStorage 覆盖）──── */
  function loadUsers() {
    var u = readJSON(K.users, null);
    return (u && u.length) ? u : clone(DEFAULT_USERS);
  }
  function saveUsers(list) { writeJSON(K.users, list); }

  function loadRoles() {
    var r = readJSON(K.roles, null);
    return (r && Object.keys(r).length) ? r : clone(DEFAULT_ROLES);
  }
  function saveRoles(r) { writeJSON(K.roles, r); }

  function loadLogs() { return readJSON(K.logs, []); }
  function saveLogs(l) { writeJSON(K.logs, l); }
  function appendLog(entry) {
    var logs = loadLogs();
    logs.unshift(entry);
    if (logs.length > 300) logs = logs.slice(0, 300);
    saveLogs(logs);
  }

  /* ── SHA-256（异步）──────────────────────────── */
  function sha256Hex(str) {
    if (window.crypto && crypto.subtle) {
      return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
        .then(function (buf) {
          return Array.from(new Uint8Array(buf)).map(function (b) {
            return b.toString(16).padStart(2, '0');
          }).join('');
        });
    }
    // 降级：非加密上下文（file:// 等）用简单散列
    return Promise.resolve(djb2(str));
  }
  function djb2(s) {
    var h = 5381;
    for (var i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
    return ('00000000' + h.toString(16)).slice(-8);
  }

  /* ── 会话 ────────────────────────────────────── */
  function getToken() { try { return localStorage.getItem(K.token) || ''; } catch (e) { return ''; } }
  function setToken(t) { try { t ? localStorage.setItem(K.token, t) : localStorage.removeItem(K.token); } catch (e) { } }
  function getCachedUser() { try { return JSON.parse(localStorage.getItem(K.user) || 'null'); } catch (e) { return null; } }
  function setCachedUser(u) { try { u ? localStorage.setItem(K.user, JSON.stringify(u)) : localStorage.removeItem(K.user); } catch (e) { } }
  function clear() { setToken(''); setCachedUser(null); }

  /* 会话令牌：base64(uid.loginTime) */
  function makeToken(uid) {
    try { return btoa(unescape(encodeURIComponent(uid + '.' + Date.now()))); }
    catch (e) { return uid + '.' + Date.now(); }
  }
  function parseToken(t) {
    try {
      var s = decodeURIComponent(escape(atob(t)));
      var i = s.lastIndexOf('.');
      return { uid: s.slice(0, i), t: parseInt(s.slice(i + 1), 10) };
    } catch (e) { return null; }
  }

  /* 会话是否过期 */
  function sessionExpired(p) {
    var ttl = (typeof SESSION_TTL !== 'undefined' && SESSION_TTL > 0) ? SESSION_TTL : 8 * 3600 * 1000;
    return !p || !p.t || (Date.now() - p.t > ttl);
  }

  /* ── 用户视图 ────────────────────────────────── */
  function publicUser(u) {
    return {
      id: u.id, username: u.username, name: u.name, role: u.role,
      active: u.active !== false, createdAt: u.createdAt, lastLogin: u.lastLogin || null,
      builtin: !!u.builtin
    };
  }
  /* 完整用户视图（带角色名/颜色/落地页/权限） */
  function fullUser(u) {
    var roles = loadRoles();
    var cfg = roles[u.role] || { name: u.role, color: '#888', landing: '/pages/dashboard.html', pages: [] };
    return {
      id: u.id, username: u.username, name: u.name, role: u.role,
      roleName: cfg.name, color: cfg.color, landing: cfg.landing, pages: cfg.pages || [],
      active: u.active !== false
    };
  }

  /* ── 鉴权：当前用户 ──────────────────────────── */
  function currentUser() {
    var t = getToken();
    if (!t) return null;
    var p = parseToken(t);
    if (sessionExpired(p)) { clear(); return null; }
    var u = loadUsers().filter(function (x) { return x.id === p.uid; })[0];
    if (!u || u.active === false) return null;
    return fullUser(u);
  }
  function isAdmin() {
    var u = currentUser();
    return !!u && u.role === 'admin';
  }

  /* ── 响应包装（对齐后端返回结构）────────────── */
  function ok(code, data) { var d = clone(data || {}); d.ok = true; d._status = code || 200; return Promise.resolve(d); }
  function err(code, msg) { return Promise.resolve({ ok: false, _status: code, error: msg }); }

  /* ══════════════════════════════════════════════
     路由：把 method + url 映射到本地实现
     ══════════════════════════════════════════════ */
  function request(method, url, body) {
    body = body || {};

    /* ── 登录 ──────────────────────────────────── */
    if (url === '/api/login' && method === 'POST') {
      var username = String(body.username || '').trim();
      var password = String(body.password || '');
      if (!username || !password) return err(400, '请输入账号与密码');
      var users = loadUsers();
      var u = users.filter(function (x) { return x.username.toLowerCase() === username.toLowerCase(); })[0];
      if (!u) return err(401, '账号或密码错误');
      if (u.active === false) return err(403, '账号已停用，请联系管理员');
      return sha256Hex(password).then(function (h) {
        if (h !== u.passwordHash) {
          appendLog({ time: new Date().toISOString(), username: u.username, name: u.name, role: u.role, ok: false, reason: '密码错误', ip: 'local' });
          return err(401, '账号或密码错误');
        }
        u.lastLogin = new Date().toISOString();
        saveUsers(users);
        setToken(makeToken(u.id));
        setCachedUser(fullUser(u));
        appendLog({ time: u.lastLogin, username: u.username, name: u.name, role: u.role, ok: true, reason: '登录成功', ip: 'local' });
        return ok(200, { token: getToken(), user: fullUser(u) });
      });
    }

    /* ── 登出 ──────────────────────────────────── */
    if (url === '/api/logout' && method === 'POST') {
      var cu = currentUser();
      if (cu) appendLog({ time: new Date().toISOString(), username: cu.username, name: cu.name, role: cu.role, ok: true, reason: '登出', ip: 'local' });
      clear();
      return ok(200, {});
    }

    /* ── 当前用户 ──────────────────────────────── */
    if (url === '/api/me' && method === 'GET') {
      var me = currentUser();
      if (!me) return err(401, '未登录或会话已过期');
      return ok(200, { user: me });
    }

    /* ── 公开配置（角色清单 + 页面目录）────────── */
    if (url === '/api/config' && method === 'GET') {
      var roles = loadRoles();
      var brief = {};
      Object.keys(roles).forEach(function (k) {
        brief[k] = { name: roles[k].name, color: roles[k].color, desc: roles[k].desc || '', landing: roles[k].landing, pageCount: (roles[k].pages || []).length };
      });
      return ok(200, { roles: brief, nav: PAGE_CATALOG, ttl: SESSION_TTL });
    }

    /* ── 用户管理（admin）──────────────────────── */
    if (url === '/api/users' && method === 'GET') {
      if (!isAdmin()) return err(403, '需要管理员权限');
      return ok(200, { users: loadUsers().map(publicUser) });
    }
    if (url === '/api/users' && method === 'POST') {
      if (!isAdmin()) return err(403, '需要管理员权限');
      var b = body;
      var nu = String(b.username || '').trim();
      var np = String(b.password || '');
      var nn = String(b.name || '').trim();
      var nr = String(b.role || '').trim();
      if (!nu || !/^[A-Za-z0-9_.@-]{3,32}$/.test(nu)) return err(400, '账号需 3-32 位字母/数字/_.@-');
      if (np.length < 6) return err(400, '密码至少 6 位');
      if (!nn) return err(400, '请填写姓名');
      if (!loadRoles()[nr]) return err(400, '角色不存在');
      var us = loadUsers();
      if (us.some(function (x) { return x.username.toLowerCase() === nu.toLowerCase(); })) return err(409, '该账号已存在');
      return sha256Hex(np).then(function (h) {
        var uu = { id: 'u_' + Date.now().toString(36), username: nu, passwordHash: h, name: nn, role: nr, active: true, builtin: false, createdAt: new Date().toISOString(), lastLogin: null };
        us.push(uu);
        saveUsers(us);
        var cu2 = currentUser();
        if (cu2) appendLog({ time: new Date().toISOString(), username: cu2.username, name: cu2.name, role: cu2.role, ok: true, reason: '新增用户 ' + nu + '（' + nr + '）', ip: 'local' });
        return ok(200, { user: publicUser(uu) });
      });
    }
    var mUsers = url.match(/^\/api\/users\/([^\/]+)$/);
    if (mUsers && method === 'PUT') {
      if (!isAdmin()) return err(403, '需要管理员权限');
      var id = mUsers[1];
      var us = loadUsers();
      var u = us.filter(function (x) { return x.id === id; })[0];
      if (!u) return err(404, '用户不存在');
      var b = body;
      if (b.name !== undefined) u.name = String(b.name).trim() || u.name;
      if (b.role !== undefined) {
        if (!loadRoles()[b.role]) return err(400, '角色不存在');
        if (u.username === 'admin' && b.role !== 'admin') return err(400, '内置 admin 账号不可降级');
        u.role = String(b.role);
      }
      if (b.active !== undefined) {
        if (u.username === 'admin' && b.active === false) return err(400, '内置 admin 账号不可停用');
        u.active = !!b.active;
      }
      if (b.username !== undefined && b.username !== u.username) {
        var xnu = String(b.username).trim();
        if (!/^[A-Za-z0-9_.@-]{3,32}$/.test(xnu)) return err(400, '账号格式不合法');
        if (us.some(function (x) { return x.id !== u.id && x.username.toLowerCase() === xnu.toLowerCase(); })) return err(409, '该账号已存在');
        if (u.username === 'admin') return err(400, '内置 admin 账号不可改名');
        u.username = xnu;
      }
      if (b.password) {
        if (String(b.password).length < 6) return err(400, '密码至少 6 位');
        return sha256Hex(String(b.password)).then(function (h) {
          u.passwordHash = h;
          saveUsers(us);
          var cu3 = currentUser();
          if (cu3) appendLog({ time: new Date().toISOString(), username: cu3.username, name: cu3.name, role: cu3.role, ok: true, reason: '修改用户 ' + u.username, ip: 'local' });
          return ok(200, { user: publicUser(u) });
        });
      }
      saveUsers(us);
      var cu4 = currentUser();
      if (cu4) appendLog({ time: new Date().toISOString(), username: cu4.username, name: cu4.name, role: cu4.role, ok: true, reason: '修改用户 ' + u.username, ip: 'local' });
      return ok(200, { user: publicUser(u) });
    }
    if (mUsers && method === 'DELETE') {
      if (!isAdmin()) return err(403, '需要管理员权限');
      var id = mUsers[1];
      var us = loadUsers();
      var u = us.filter(function (x) { return x.id === id; })[0];
      if (!u) return err(404, '用户不存在');
      if (u.username === 'admin') return err(400, '内置 admin 账号不可删除');
      var cu5 = currentUser();
      if (cu5 && u.id === cu5.id) return err(400, '不能删除自己');
      saveUsers(us.filter(function (x) { return x.id !== id; }));
      if (cu5) appendLog({ time: new Date().toISOString(), username: cu5.username, name: cu5.name, role: cu5.role, ok: true, reason: '删除用户 ' + u.username, ip: 'local' });
      return ok(200, {});
    }

    /* ── 角色配置（admin）──────────────────────── */
    if (url === '/api/roles' && method === 'GET') {
      if (!isAdmin()) return err(403, '需要管理员权限');
      return ok(200, { roles: loadRoles(), pages: PAGE_CATALOG });
    }
    var mRoles = url.match(/^\/api\/roles\/([^\/]+)$/);
    if (mRoles && method === 'PUT') {
      if (!isAdmin()) return err(403, '需要管理员权限');
      var key = mRoles[1];
      var roles = loadRoles();
      var r = roles[key];
      if (!r) return err(404, '角色不存在');
      if (r.builtin) return err(400, '内置管理员角色不可修改权限');
      var b = body;
      if (b.name !== undefined) r.name = String(b.name).trim() || r.name;
      if (b.desc !== undefined) r.desc = String(b.desc);
      if (b.color !== undefined) r.color = String(b.color);
      if (b.landing !== undefined) r.landing = String(b.landing);
      if (Array.isArray(b.pages)) {
        var valid = PAGE_CATALOG.map(function (p) { return p.path; });
        r.pages = b.pages.filter(function (p) { return p === '*' || valid.indexOf(p) !== -1; });
        if (!r.pages.length) r.pages = ['/pages/dashboard.html'];
      }
      saveRoles(roles);
      var cu6 = currentUser();
      if (cu6) appendLog({ time: new Date().toISOString(), username: cu6.username, name: cu6.name, role: cu6.role, ok: true, reason: '修改角色权限 ' + key, ip: 'local' });
      return ok(200, { role: r });
    }

    /* ── 日报数据（静态快照）───────────────────── */
    if (url === '/api/data/daily' && method === 'GET') {
      var me2 = currentUser();
      if (!me2) return err(401, '未登录');
      var base = (window.SITE_BASE || '/');
      return fetch(base + 'data/daily.json', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (d) { return ok(200, { empty: false, data: d }); })
        .catch(function () {
          return ok(200, { empty: true, message: '尚未同步日报数据。请在本地运行抓取脚本，将 data/daily.json 更新后重新部署。' });
        });
    }

    /* ── 数据刷新（静态版不支持）───────────────── */
    if (url === '/api/data/refresh' && method === 'POST') {
      if (!isAdmin()) return err(403, '需要管理员权限');
      return err(501, '静态版不支持在线抓取。请在本机运行抓取脚本生成 data/daily.json 后推送到 GitHub。');
    }

    /* ── 日志 ──────────────────────────────────── */
    if (url === '/api/logs' && method === 'GET') {
      if (!isAdmin()) return err(403, '需要管理员权限');
      return ok(200, { logs: loadLogs() });
    }
    if (url === '/api/logs' && method === 'DELETE') {
      if (!isAdmin()) return err(403, '需要管理员权限');
      saveLogs([]);
      return ok(200, {});
    }

    /* ── 健康 ──────────────────────────────────── */
    if (url === '/api/health' && method === 'GET') {
      var df = readJSON('__daily_fetched_at__', null);
      return ok(200, {
        uptime: 0, users: loadUsers().length, roles: Object.keys(loadRoles()).length,
        dataFetchedAt: df, node: 'static'
      });
    }

    /* ── 未匹配 ────────────────────────────────── */
    return err(404, '接口不存在：' + method + ' ' + url);
  }

  /* ── 对外 API（与原后端同签名）────────────── */
  return {
    get:  function (u) { return request('GET', u); },
    post: function (u, b) { return request('POST', u, b); },
    put:  function (u, b) { return request('PUT', u, b); },
    del:  function (u) { return request('DELETE', u); },

    getToken: getToken,
    setToken: setToken,
    getCachedUser: getCachedUser,
    setCachedUser: setCachedUser,
    clear: clear
  };
})();
