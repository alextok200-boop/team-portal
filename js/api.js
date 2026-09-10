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
    users: 'portal_users',          // 本机新增/修改的「覆盖层」（仅在管理员这台浏览器生效）
    usersRemote: 'portal_users_remote', // data/users.json 的本地缓存（全站共享名单）
    lastLogin: 'portal_lastlogin',  // {uid: iso} 独立存放，避免登录时重写用户表
    roles: 'portal_roles',
    logs:  'portal_logs'
  };

  var REMOTE_URL = 'data/users.json';

  /* ── 基础存储 ────────────────────────────────── */
  function readJSON(key, fb) {
    try { var v = localStorage.getItem(key); return v ? JSON.parse(v) : fb; }
    catch (e) { return fb; }
  }
  function writeJSON(key, v) {
    try { localStorage.setItem(key, JSON.stringify(v)); } catch (e) { /* 满则忽略 */ }
  }

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  /* ══════════════════════════════════════════════════════════
     用户表：三源合并
     ──────────────────────────────────────────────────────────
       ① DEFAULT_USERS     js/config/roles.js   随源码部署，全站生效
       ② data/users.json   仓库文件           随源码部署，全站生效 ← 新增用户靠它
       ③ localStorage      本机覆盖层         只在管理员这台浏览器生效
     优先级：③ > ② > ①，按 username（忽略大小写）去重。
     同名用户被高优先级整体覆盖，不做字段级合并。

     ⚠️ 为什么会这样：GitHub Pages 是纯静态托管，浏览器没有服务端可写。
        所以「新增用户」在后台点完只落在本机 localStorage，
        必须导出 data/users.json 并提交，同事才登得上。
     ══════════════════════════════════════════════════════════ */

  var REMOTE = { loaded: false, error: null, count: 0 };

  /* ② data/users.json：拉取 + 缓存 */
  function loadRemoteCache() {
    var d = readJSON(K.usersRemote, null);
    return (d && d.users && d.users.length) ? d.users : [];
  }
  function loadRemoteDeleted() {
    var d = readJSON(K.usersRemote, null);
    return (d && d.deleted) || [];
  }
  function ensureRemote(force) {
    if (REMOTE.loaded && !force) return Promise.resolve(REMOTE);
    var base = (window.SITE_BASE || '/');
    return fetch(base + REMOTE_URL, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        var list = (d && d.users) || [];
        writeJSON(K.usersRemote, { version: (d && d.version) || 1, updatedAt: (d && d.updatedAt) || null, deleted: (d && d.deleted) || [], users: list });
        REMOTE = { loaded: true, error: null, count: list.length };
        return REMOTE;
      })
      .catch(function (e) {
        REMOTE = { loaded: true, error: String((e && e.message) || e), count: loadRemoteCache().length };
        return REMOTE;
      });
  }

  /* ③ 本机覆盖层 */
  function loadLocal() { return readJSON(K.users, null) || []; }
  function saveLocal(list) { writeJSON(K.users, list); }

  /* 同名去重合并（低优先级在前） */
  function mergeByUsername() {
    var layers = arguments, idx = {}, out = [];
    for (var i = 0; i < layers.length; i++) {
      (layers[i] || []).forEach(function (u) {
        if (!u || !u.username) return;
        var key = String(u.username).toLowerCase();
        if (Object.prototype.hasOwnProperty.call(idx, key)) out[idx[key]] = u;
        else { idx[key] = out.length; out.push(u); }
      });
    }
    return out;
  }

  /* 两条记录「身份字段」是否等价（忽略 lastLogin / createdAt 之类噪声） */
  function sameIdentity(a, b) {
    if (!a || !b) return false;
    return String(a.role) === String(b.role)
      && (a.active !== false) === (b.active !== false)
      && String(a.passwordHash || '') === String(b.passwordHash || '')
      && String(a.name || '') === String(b.name || '');
  }

  /* 清掉「本机覆盖层」里与共享名单等价的陈旧副本
     （历史版本登录时会把整表写进 localStorage，成员浏览器里会留下快照，
       若不清理，管理员远端改了密码，成员本机的旧快照会把它盖回去） */
  function pruneLocal(local, shared) {
    var byName = {};
    shared.forEach(function (u) { if (u && u.username) byName[String(u.username).toLowerCase()] = u; });
    return local.filter(function (u) {
      var b = byName[String(u.username || '').toLowerCase()];
      return !b || !sameIdentity(u, b);
    });
  }

  function loadLastLogin() { return readJSON(K.lastLogin, {}) || {}; }
  function touchLastLogin(id, iso) {
    var m = loadLastLogin();
    m[id] = iso;
    writeJSON(K.lastLogin, m);
  }

  /* 最终用户表 */
  function loadUsers() {
    var rawLocal = loadLocal();
    var shared = clone(DEFAULT_USERS).concat(loadRemoteCache());
    var local = pruneLocal(rawLocal, shared);
    if (local.length !== rawLocal.length) saveLocal(local);   // 清掉陈旧整表副本，避免盖住仓库里的新改动
    var merged = mergeByUsername(clone(DEFAULT_USERS), loadRemoteCache(), local);
    var gone = {};
    loadRemoteDeleted().forEach(function (n) { gone[String(n).toLowerCase()] = 1; });
    local.forEach(function (u) { if (u && u._deleted) gone[String(u.username).toLowerCase()] = 1; });
    merged = merged.filter(function (u) { return !u._deleted && !gone[String(u.username).toLowerCase()]; });
    var ll = loadLastLogin();
    merged.forEach(function (u) { if (ll[u.id]) u.lastLogin = ll[u.id]; });
    return merged;
  }

  /* 账号来源：源码内置 / 仓库共享名单 / 仅本机 */
  function userSource(u) {
    if (u.builtin) return 'builtin';
    if (loadLocal().some(function (x) { return !x._deleted && x.username && x.username.toLowerCase() === String(u.username).toLowerCase(); })) return 'local';
    if (loadRemoteCache().some(function (x) { return x.username && x.username.toLowerCase() === String(u.username).toLowerCase(); })) return 'remote';
    return 'builtin';
  }

  /* 写回「本机覆盖层」：只落差异记录，不再把整表写进 localStorage */
  function saveUsers(list) {
    var shared = clone(DEFAULT_USERS).concat(loadRemoteCache());
    var byName = {};
    shared.forEach(function (u) { if (u && u.username) byName[String(u.username).toLowerCase()] = u; });
    // 与共享名单等价的不需要落盘；_deleted 墓碑必须保留
    saveLocal(list.filter(function (u) {
      if (u && u._deleted) return true;
      var b = byName[String((u && u.username) || '').toLowerCase()];
      return !b || !sameIdentity(u, b);
    }));
  }

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
  /* ⚠️ crypto.subtle 只在「安全上下文」可用：https:// 、localhost 、file:// 。
     用 http://192.168.x.x 这类内网 IP 打开时它不存在。
     历史版本在这里降级成 djb2 8 位散列，结果是：
       内网 IP 下建的号 → 哈希是 djb2 → 换成 https 登录时算 SHA-256 → 永远比对不上。
     所以这里不再降级，直接拒绝并给出明确提示，从源头杜绝「同一个号两种哈希」。 */
  function isSecureContext() {
    return !!(window.crypto && crypto.subtle);
  }
  function sha256Hex(str) {
    if (!isSecureContext()) return Promise.reject(new Error('INSECURE_CONTEXT'));
    return crypto.subtle.digest('SHA-256', new TextEncoder().encode(str))
      .then(function (buf) {
        return Array.from(new Uint8Array(buf)).map(function (b) {
          return b.toString(16).padStart(2, '0');
        }).join('');
      });
  }

  /* 新哈希带算法前缀，便于将来换算法时平滑迁移 */
  function hashPassword(pw) {
    return sha256Hex(pw).then(function (h) { return 'sha256$' + h; });
  }
  /* 兼容历史无前缀的裸 SHA-256；旧 djb2（8 位）已无法校验，判定为不匹配 */
  function hashMatches(computedHex, stored) {
    var s = String(stored || '');
    if (!s) return false;
    if (s.indexOf('sha256$') === 0) return s.slice(7) === computedHex;
    if (/^[0-9a-f]{64}$/.test(s)) return s === computedHex;   // 历史裸 SHA-256
    return false;                                             // 历史 djb2 等，需管理员重置
  }
  function hashAlgo(stored) {
    var s = String(stored || '');
    if (s.indexOf('sha256$') === 0 || /^[0-9a-f]{64}$/.test(s)) return 'sha256';
    if (/^[0-9a-f]{8}$/.test(s)) return 'legacy-djb2';
    return 'unknown';
  }
  var INSECURE_MSG = '当前访问方式不安全（非 https / 非 localhost），浏览器已禁用加密模块，无法校验密码。请改用 https:// 地址访问门户。';

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
      builtin: !!u.builtin,
      source: userSource(u),              // builtin=源码 / remote=仓库名单 / local=仅本机
      hashAlgo: hashAlgo(u.passwordHash)  // legacy-djb2 说明该账号需重置密码
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
      if (!isSecureContext()) return err(400, INSECURE_MSG);
      // 先确保共享名单（data/users.json）已加载，再比对——否则新同事第一次访问会漏账号
      return ensureRemote().then(function () {
        var users = loadUsers();
        var u = users.filter(function (x) { return x.username.toLowerCase() === username.toLowerCase(); })[0];
        if (!u) return err(401, '账号或密码错误');
        if (u.active === false) return err(403, '账号已停用，请联系管理员');
        return sha256Hex(password).then(function (h) {
          if (!hashMatches(h, u.passwordHash)) {
            appendLog({ time: new Date().toISOString(), username: u.username, name: u.name, role: u.role, ok: false, reason: '密码错误', ip: 'local' });
            return err(401, '账号或密码错误');
          }
          u.lastLogin = new Date().toISOString();
          touchLastLogin(u.id, u.lastLogin);   // 只记登录时间，不再回写整张用户表
          setToken(makeToken(u.id));
          setCachedUser(fullUser(u));
          appendLog({ time: u.lastLogin, username: u.username, name: u.name, role: u.role, ok: true, reason: '登录成功', ip: 'local' });
          return ok(200, { token: getToken(), user: fullUser(u) });
        });
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
      if (!isSecureContext()) return err(400, INSECURE_MSG);
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
      return hashPassword(np).then(function (h) {
        var uu = { id: 'u_' + Date.now().toString(36), username: nu, passwordHash: h, name: nn, role: nr, active: true, builtin: false, createdAt: new Date().toISOString(), lastLogin: null };
        us.push(uu);
        saveUsers(us);
        var cu2 = currentUser();
        if (cu2) appendLog({ time: new Date().toISOString(), username: cu2.username, name: cu2.name, role: cu2.role, ok: true, reason: '新增用户 ' + nu + '（' + nr + '）· 本机', ip: 'local' });
        return ok(200, { user: publicUser(uu), pending: true });
      });
    }

    /* ── 导出共享名单（admin）
       供管理后台一键下载 data/users.json —— 提交到仓库后全站生效 ── */
    if (url === '/api/users/export' && method === 'GET') {
      if (!isAdmin()) return err(403, '需要管理员权限');
      var shared = clone(DEFAULT_USERS).concat(loadRemoteCache());
      var local = loadLocal();
      var rows = loadUsers().filter(function (u) {
        var base = shared.filter(function (x) { return x.username && u.username && x.username.toLowerCase() === u.username.toLowerCase(); })[0];
        return !base || !sameIdentity(u, base);   // 与源码/仓库等价的不用重复导出
      });
      var deleted = loadRemoteDeleted().slice();
      local.forEach(function (u) { if (u && u._deleted && u.username && deleted.indexOf(u.username) === -1) deleted.push(u.username); });
      rows = rows.filter(function (u) { return deleted.indexOf(u.username) === -1; });
      return ok(200, {
        payload: {
          version: 1,
          updatedAt: new Date().toISOString(),
          note: '团队门户共享账号名单。由管理后台「导出用户配置」生成。passwordHash 为 sha256$ 前缀的 SHA-256，非明文。deleted 为已删除账号的用户名列表。',
          deleted: deleted,
          users: rows.map(function (u) {
            return {
              id: u.id, username: u.username, name: u.name, role: u.role,
              passwordHash: u.passwordHash, active: u.active !== false,
              builtin: false, createdAt: u.createdAt || new Date().toISOString(), lastLogin: null
            };
          })
        },
        stats: { total: loadUsers().length, exported: rows.length, deleted: deleted.length }
      });
    }
    var mUsers = url.match(/^\/api\/users\/([^\/]+)$/);
    if (mUsers && method === 'PUT') {
      if (!isAdmin()) return err(403, '需要管理员权限');
      if (!isSecureContext()) return err(400, INSECURE_MSG);
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
        return hashPassword(String(b.password)).then(function (h) {
          u.passwordHash = h;
          saveUsers(us);
          var cu3 = currentUser();
          if (cu3) appendLog({ time: new Date().toISOString(), username: cu3.username, name: cu3.name, role: cu3.role, ok: true, reason: '修改用户 ' + u.username + ' · 本机', ip: 'local' });
          return ok(200, { user: publicUser(u), pending: true });
        });
      }
      saveUsers(us);
      var cu4 = currentUser();
      if (cu4) appendLog({ time: new Date().toISOString(), username: cu4.username, name: cu4.name, role: cu4.role, ok: true, reason: '修改用户 ' + u.username + ' · 本机', ip: 'local' });
      return ok(200, { user: publicUser(u), pending: true });
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
      // 源码/仓库里的账号删不掉（合并时会被还原），改用「墓碑」标记：导出后全站同步删除
      var shared = clone(DEFAULT_USERS).concat(loadRemoteCache());
      var inShared = shared.some(function (x) { return x.username && x.username.toLowerCase() === u.username.toLowerCase(); });
      saveUsers(us.filter(function (x) { return x.id !== id; }));
      if (inShared) {
        var lc = loadLocal();
        lc.push({ id: 'del_' + Date.now().toString(36), username: u.username, name: u.name, role: u.role, _deleted: true, deletedAt: new Date().toISOString() });
        saveLocal(lc);
      }
      if (cu5) appendLog({ time: new Date().toISOString(), username: cu5.username, name: cu5.name, role: cu5.role, ok: true, reason: '删除用户 ' + u.username + ' · 本机', ip: 'local' });
      return ok(200, { pending: true });
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
  /* 页面一打开就预热共享名单，让登录/用户列表拿到的都是最新数据 */
  try { ensureRemote(); } catch (e) { /* 忽略 */ }

  return {
    get:  function (u) { return request('GET', u); },
    post: function (u, b) { return request('POST', u, b); },
    put:  function (u, b) { return request('PUT', u, b); },
    del:  function (u) { return request('DELETE', u); },

    getToken: getToken,
    setToken: setToken,
    getCachedUser: getCachedUser,
    setCachedUser: setCachedUser,
    clear: clear,

    /* 共享名单（data/users.json）状态与手动刷新 */
    remote: function () { return REMOTE; },
    remoteReady: function () { return ensureRemote(); },   // 等名单拉取落地（含失败）后再读 remote()
    refreshRemote: function () { return ensureRemote(true); },
    isSecure: isSecureContext,
    insecureMsg: INSECURE_MSG
  };
})();
