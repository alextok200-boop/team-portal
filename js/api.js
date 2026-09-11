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
    users: 'portal_users',               // 用户表：本机覆盖层（仅在管理员这台浏览器生效）
    usersRemote: 'portal_users_remote',  // data/users.json 的本地缓存（全站共享名单）
    lastLogin: 'portal_lastlogin',       // {uid: iso} 独立存放，避免登录时重写用户表
    content: 'portal_content',           // 内容表：本机覆盖层
    contentRemote: 'portal_content_remote',
    // 自动提交配置（GitHub Token 等）。★ 只存本机、绝不进仓库 —— 见 §自动提交
    ghCfg: 'portal_gh_cfg',
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

  /* ══════════════════════════════════════════════════════════
     数据表：三源合并（合并/墓碑/导出逻辑在 js/datastore.js，只写一遍）
     ──────────────────────────────────────────────────────────
       ① 源码常量      js/config/*.js   随源码部署   全站生效
       ② 仓库数据文件  data/*.json      随仓库部署   全站生效 ← 改动到同事机器的唯一通路
       ③ 本机覆盖层    localStorage     仅本机       即时可用但别人看不到

     ⚠️ GitHub Pages 是纯静态托管，浏览器没有服务端可写。
        所以在后台点「新增/编辑/删除」只落在本机，
        必须「导出」→ 覆盖仓库文件 → 提交，才会全站生效。
     ══════════════════════════════════════════════════════════ */

  var usersStore = DataStore.create({
    localKey: K.users,
    remoteKey: K.usersRemote,
    remoteUrl: 'data/users.json',
    itemsField: 'users',
    key: 'username',
    /* 只有这些字段参与「与共享名单是否等价」的判定；
       lastLogin / createdAt 之类的高频噪声字段不参与，否则永远判定为"有差异" */
    identity: ['role', 'active', 'passwordHash', 'name'],
    boolFields: ['active'],
    defaults: function () { return DEFAULT_USERS; },
    note: '团队门户共享账号名单。本文件随仓库部署，所有设备/浏览器通用。'
        + '新增用户请在管理后台点「导出用户配置」下载 users.json，覆盖本文件后提交即可全站生效'
        + '（也可用 tools/add-user.py 命令行加号）。'
        + 'passwordHash 为 SHA-256（sha256$ 前缀），非明文。'
        + 'deleted 为已删除账号的用户名列表（用于删除源码内置账号时全站同步）。'
  });

  var contentStore = DataStore.create({
    localKey: K.content,
    remoteKey: K.contentRemote,
    remoteUrl: 'data/content.json',
    itemsField: 'items',
    key: 'id',
    identity: ['title', 'type', 'status', 'owner', 'channel', 'body', 'link', 'updatedAt'],
    defaults: function () { return []; },
    note: '团队门户内容清单。本文件随仓库部署，所有设备/浏览器通用。'
        + '管理后台「内容管理 → 导出内容配置」下载本文件覆盖后提交即可全站生效。'
        + 'deleted 为已删除条目的 id 列表。'
  });

  function ensureRemote() { return usersStore.ready(); }
  /* 用户路由统一入口：先等 data/users.json 落地再读。
     只在 login 里 await 是不够的 —— 管理员带 token 直接进后台时没人 await，
     GET /api/users 会在共享名单落地前读到空表（列表闪空、少人）。 */
  function withUsers(fn) { return usersStore.ready().then(fn); }

  function loadLastLogin() { return readJSON(K.lastLogin, {}) || {}; }
  function touchLastLogin(id, iso) {
    var m = loadLastLogin();
    m[id] = iso;
    writeJSON(K.lastLogin, m);
  }

  /* ── 用户表 ─────────────────────────────────── */
  function loadUsers() {
    var merged = usersStore.load();
    var ll = loadLastLogin();
    merged.forEach(function (u) { if (ll[u.id]) u.lastLogin = ll[u.id]; });
    return merged;
  }
  function userSource(u) { return usersStore.sourceOf(u); }
  /* 写回「本机覆盖层」：只落差异记录，不再把整表写进 localStorage */
  function saveUsers(list) { usersStore.save(list); }

  /* ── 内容表 ─────────────────────────────────── */
  function loadContent() { return contentStore.load(); }
  function saveContent(list) { contentStore.save(list); }
  /* 内容路由统一入口：先等 data/content.json 拉取落地再读。
     否则首次请求时远端缓存还没写入 localStorage，列表会被读成空表，
     连「这条是仓库条目还是本机条目」都会判错（inShared 失效）。 */
  function withContent(fn) { return contentStore.ready().then(fn); }
  var CONTENT_TYPES = ['文档', '图片', '视频', '链接'];
  var CONTENT_STATUS = ['草稿', '已发布', '已归档'];

  function publicContent(c) {
    return {
      id: c.id, title: c.title, type: c.type, status: c.status,
      owner: c.owner || '', channel: c.channel || '',
      body: c.body || '', link: c.link || '', author: c.author || '',
      createdAt: c.createdAt || null, updatedAt: c.updatedAt || null,
      source: contentStore.sourceOf(c)
    };
  }

  /* 内容字段校验。base 非空表示编辑，未传的字段沿用原值 */
  function validateContent(b, base) {
    b = b || {};
    function pick(k, fb) {
      if (b[k] !== undefined && b[k] !== null) return b[k];
      if (base && base[k] !== undefined && base[k] !== null) return base[k];
      return fb;
    }
    var title = String(pick('title', '')).trim();
    if (!title) return { error: '请填写标题' };
    if (title.length > 80) return { error: '标题最多 80 字' };
    var type = String(pick('type', CONTENT_TYPES[0])).trim();
    if (CONTENT_TYPES.indexOf(type) === -1) return { error: '类型只能是：' + CONTENT_TYPES.join(' / ') };
    var status = String(pick('status', CONTENT_STATUS[0])).trim();
    if (CONTENT_STATUS.indexOf(status) === -1) return { error: '状态只能是：' + CONTENT_STATUS.join(' / ') };
    var body = String(pick('body', ''));
    if (body.length > 2000) return { error: '说明最多 2000 字' };
    var link = String(pick('link', '')).trim();
    if (link && !/^(https?:\/\/|\/)/i.test(link)) return { error: '链接需以 http(s):// 或 / 开头' };
    return {
      item: {
        id: (base && base.id) || '',
        title: title, type: type, status: status,
        owner: String(pick('owner', '')).trim().slice(0, 20),
        channel: String(pick('channel', '')).trim().slice(0, 20),
        body: body, link: link,
        createdAt: (base && base.createdAt) || '',
        updatedAt: (base && base.updatedAt) || '',
        author: (base && base.author) || ''
      }
    };
  }

  /* 内容改动写日志（与用户表日志同结构，登录日志页可读） */
  function logContent(reason) {
    var u = currentUser();
    appendLog({
      time: new Date().toISOString(),
      username: u ? u.username : 'local', name: u ? u.name : '', role: u ? u.role : '',
      ok: true, reason: reason, ip: 'local'
    });
  }

  /* ══ 自动提交（GitHub Contents API）═════════════════════════
     把「导出文件 → 手工 git 提交」升级成管理后台一键完成。

     安全边界（必须保持）：
     - Token 只存在**本机浏览器的 localStorage**（K.ghCfg），
       绝不写进仓库、也绝不随 users.json / content.json 导出泄漏。
     - 建议用 fine-grained PAT，只授权**本仓库**的 Contents: Read and write。
     - 怀疑泄漏就去 GitHub 撤销重发一个，本机删掉配置即可。
     ══════════════════════════════════════════════════════ */
  var GH_API = 'https://api.github.com';

  function loadGhCfg() { return readJSON(K.ghCfg, null) || {}; }
  function saveGhCfg(c) { writeJSON(K.ghCfg, c); }
  function clearGhCfg() { try { localStorage.removeItem(K.ghCfg); } catch (e) { } }

  /* 从 Pages 域名/路径推断 owner/repo（本地跑时只推得出 repo，owner 要手填） */
  function inferRepo() {
    var m = /^([^.]+)\.github\.io$/i.exec(location.hostname);
    var seg = location.pathname.split('/').filter(Boolean);
    return { owner: m ? m[1] : '', repo: seg.length ? seg[0] : '' };
  }

  /* UTF-8 安全的 base64（文件里有中文） */
  function b64utf8(str) {
    var bytes = new TextEncoder().encode(str), bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }
  function brief(t) { return String(t || '').replace(/\s+/g, ' ').slice(0, 160); }

  function ghHeaders(cfg) {
    return {
      'Authorization': 'Bearer ' + cfg.token,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    };
  }

  /* ★ 写权限探针 —— 只靠 GET /repos 是**验不出能不能写**的，必须真的试写一次。
     两个坑都踩过：
       ① GET /repos/{o}/{r} 只需要 Metadata: read，所以「只读 Token」也能 200；
       ② 返回体里的 permissions.push 反映的是**你这个账号在仓库里的角色**
          —— 仓库是你自己的，它恒为 true，跟 Token 勾了什么无关。
     所以改用 POST /repos/{o}/{r}/git/blobs：GitHub 要求它必须持 Contents: write，
     而它只往对象库丢一个「游离 blob」—— 不产生 commit、不动分支、不影响任何文件、
     不触发 Pages 重建。成功 201 = 确认可写；403 = 确认只读（保存直接拦下）。
     网络抖动 / 404 / 422 这类「判定不了」的情况**不阻断保存**，留给真正发布时兜底报错。 */
  function ghWriteProbe(cfg) {
    var url = GH_API + '/repos/' + cfg.owner + '/' + cfg.repo + '/git/blobs';
    var h = Object.assign({ 'Content-Type': 'application/json' }, ghHeaders(cfg));
    return fetch(url, {
      method: 'POST', headers: h, cache: 'no-store',
      body: JSON.stringify({ content: 'team-portal write probe ' + Date.now(), encoding: 'utf-8' })
    }).then(function (r) {
      if (r.status === 201) return true;
      if (r.status === 403) {
        var e = new Error('这个 Token 只能读、不能写（403）：请到 GitHub 打开该 Token，把 Contents 权限改成 Read and write，再回来保存');
        e.blocking = true;
        throw e;
      }
      if (r.status === 401) {
        var e2 = new Error('Token 无效或已过期（401）');
        e2.blocking = true;
        throw e2;
      }
      return null;                        // 判定不了（如企业版无此端点）→ 不阻断
    }, function () {
      return null;                        // 网络异常 → 不阻断保存，发布时再报
    });
  }

  /* 校验 token + 仓库可达 + **确认可写**（保存配置前先跑一次，早失败好过发布时才发现） */
  function ghProbe(cfg) {
    return fetch(GH_API + '/repos/' + cfg.owner + '/' + cfg.repo, { headers: ghHeaders(cfg), cache: 'no-store' })
      .then(function (r) {
        if (r.status === 401) throw new Error('Token 无效或已过期（401）');
        if (r.status === 404) throw new Error('仓库不存在，或该 Token 无权访问（404）');
        if (!r.ok) return r.text().then(function (t) { throw new Error('校验失败 HTTP ' + r.status + '：' + brief(t)); });
        return r.json().then(function (d) {
          return {
            fullName: d.full_name || (cfg.owner + '/' + cfg.repo),
            defaultBranch: d.default_branch || 'main',
            /* 仅供参考：这是「你的账号角色」，不是 Token 的实际写权限 */
            canPush: !!(d.permissions && d.permissions.push)
          };
        });
      })
      .then(function (info) {
        return ghWriteProbe(cfg).then(function (w) {
          info.canWrite = (w === true);      // 只有试写成功才是 true
          info.writeChecked = (w !== null);  // false 表示「没验出来」，别当成「不能写」
          return info;
        });
      });
  }

  /* 提交单个文件。文件已存在时**必须带 sha** —— Contents API 的乐观锁：
     拿的是读到的那个 sha，期间远端变了就会 409，而不是被默默覆盖。 */
  function ghPutFile(cfg, path, text, message) {
    var url = GH_API + '/repos/' + cfg.owner + '/' + cfg.repo + '/contents/' + path;
    var h = ghHeaders(cfg);
    function mapErr(r, phase) {
      if (r.status === 401) return 'Token 无效或已过期（401）';
      if (r.status === 403) return 'Token 权限不足（403）：需要该仓库的 Contents 读写权限';
      if (r.status === 409) return '仓库刚被别处更新（可能是 GitHub Actions 或另一次发布），请刷新后重试';
      if (r.status === 404) return '仓库 / 分支不存在（404）：请检查 owner、repo、branch';
      return phase + ' ' + path + ' 失败 HTTP ' + r.status;
    }
    return fetch(url + '?ref=' + encodeURIComponent(cfg.branch), { headers: h, cache: 'no-store' })
      .then(function (r) {
        if (r.status === 404) return null;                 // 文件还不存在 → 新建
        if (!r.ok) throw new Error(mapErr(r, '读取'));
        return r.json().then(function (d) { return d && d.sha; });
      })
      .then(function (sha) {
        var body = { message: message, content: b64utf8(text), branch: cfg.branch };
        if (sha) body.sha = sha;
        var putHeaders = Object.assign({ 'Content-Type': 'application/json' }, h);
        return fetch(url, { method: 'PUT', headers: putHeaders, body: JSON.stringify(body) });
      })
      .then(function (r) {
        if (!r.ok) {
          return r.text().then(function (t) {
            throw new Error(mapErr(r, '提交') + '：' + brief(t));
          });
        }
        return r.json().then(function (d) {
          var c = (d && d.commit) || {};
          return { path: path, commit: c.sha || '', commitUrl: c.html_url || '' };
        });
      });
  }

  /* 与「导出用户配置」共用同一份构造逻辑 —— 保证一键提交写进仓库的格式
     和手工导出的**完全一致**，不会出现两条路两种格式。 */
  function buildUsersPayload() {
    var p = usersStore.exportPayload();
    p.users = p.users.map(function (u) {
      return {
        id: u.id, username: u.username, name: u.name, role: u.role,
        passwordHash: u.passwordHash, active: u.active !== false,
        builtin: false, createdAt: u.createdAt || new Date().toISOString(), lastLogin: null
      };
    });
    return p;
  }
  function buildContentPayload() { return contentStore.exportPayload(); }

  function pendingCounts() {
    var u = buildUsersPayload(), c = buildContentPayload();
    return { users: u.users.length, content: c.items.length, deleted: u.deleted.length + c.deleted.length };
  }

  /* ★ 绝不回传 token 本身，只给后 4 位用于确认「填的是哪一把」 */
  function publishStatus() {
    var cfg = loadGhCfg(), guess = inferRepo();
    return {
      configured: !!cfg.token,
      tokenTail: cfg.token ? String(cfg.token).slice(-4) : '',
      /* 保存时是否**试写成功过**。undefined = 老配置没验过（不显示为「只读」，只是「未验证」）。
         故意不在这里实时探一次：状态查询会被频繁调用，每次打一次 GitHub 太吵。 */
      canWrite: cfg.canWrite,
      writeCheckedAt: cfg.writeCheckedAt || '',
      owner: cfg.owner || guess.owner,
      repo: cfg.repo || guess.repo,
      branch: cfg.branch || 'main',
      guess: guess,
      pending: pendingCounts()
    };
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
      return withUsers(function () { return ok(200, { users: loadUsers().map(publicUser) }); });
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
      return withUsers(function () {
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
      });
    }

    /* ── 导出共享名单（admin）
       供管理后台一键下载 data/users.json —— 提交到仓库后全站生效 ── */
    if (url === '/api/users/export' && method === 'GET') {
      if (!isAdmin()) return err(403, '需要管理员权限');
      return withUsers(function () {
        var uPayload = buildUsersPayload();
        return ok(200, {
          payload: uPayload,
          stats: { total: loadUsers().length, exported: uPayload.users.length, deleted: uPayload.deleted.length }
        });
      });
    }
    var mUsers = url.match(/^\/api\/users\/([^\/]+)$/);
    if (mUsers && method === 'PUT') {
      if (!isAdmin()) return err(403, '需要管理员权限');
      if (!isSecureContext()) return err(400, INSECURE_MSG);
      var id = mUsers[1];
      return withUsers(function () {
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
      });
    }
    if (mUsers && method === 'DELETE') {
      if (!isAdmin()) return err(403, '需要管理员权限');
      var id = mUsers[1];
      return withUsers(function () {
        var us = loadUsers();
        var u = us.filter(function (x) { return x.id === id; })[0];
        if (!u) return err(404, '用户不存在');
        if (u.username === 'admin') return err(400, '内置 admin 账号不可删除');
        var cu5 = currentUser();
        if (cu5 && u.id === cu5.id) return err(400, '不能删除自己');
        // 源码/仓库里的账号删不掉（合并时会被还原），改用「墓碑」标记：导出后全站同步删除
        var inShared = usersStore.inShared(u);
        saveUsers(us.filter(function (x) { return x.id !== id; }));
        if (inShared) usersStore.tombstone(u);
        if (cu5) appendLog({ time: new Date().toISOString(), username: cu5.username, name: cu5.name, role: cu5.role, ok: true, reason: '删除用户 ' + u.username + ' · 本机', ip: 'local' });
        return ok(200, { pending: true });
      });
    }

    /* ══ 内容管理 ══════════════════════════════════
       读：登录即可；写：仅管理员（页面上对成员呈现为只读）
       同样受「本机覆盖层」限制 —— 写完要导出 data/content.json 并提交才全站生效 ══ */
    if (url === '/api/content' && method === 'GET') {
      return withContent(function () {
        var meC = currentUser();
        if (!meC) return err(401, '未登录');
        var list = loadContent().slice().sort(function (a, b) {
          return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
        });
        return ok(200, {
          items: list.map(publicContent),
          types: CONTENT_TYPES,
          status: CONTENT_STATUS,
          canEdit: meC.role === 'admin'
        });
      });
    }

    if (url === '/api/content' && method === 'POST') {
      if (!isAdmin()) return err(403, '仅管理员可创建内容');
      return withContent(function () {
        var nc = validateContent(body, null);
        if (nc.error) return err(400, nc.error);
        var items = loadContent();
        var nowIso = new Date().toISOString();
        nc.item.id = 'c_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        nc.item.createdAt = nowIso;
        nc.item.updatedAt = nowIso;
        nc.item.author = currentUser().name;
        items.push(nc.item);
        saveContent(items);
        logContent('新增内容《' + nc.item.title + '》· 本机');
        return ok(200, { item: publicContent(nc.item), pending: true });
      });
    }

    var mContent = url.match(/^\/api\/content\/([^\/]+)$/);
    if (mContent && method === 'PUT') {
      if (!isAdmin()) return err(403, '仅管理员可编辑内容');
      var cid = mContent[1];
      return withContent(function () {
        var items2 = loadContent();
        var ci = items2.filter(function (x) { return x.id === cid; })[0];
        if (!ci) return err(404, '内容不存在');
        var vc = validateContent(body, ci);
        if (vc.error) return err(400, vc.error);
        ci.title = vc.item.title;
        ci.type = vc.item.type;
        ci.status = vc.item.status;
        ci.owner = vc.item.owner;
        ci.channel = vc.item.channel;
        ci.body = vc.item.body;
        ci.link = vc.item.link;
        ci.updatedAt = new Date().toISOString();
        ci.author = ci.author || currentUser().name;
        saveContent(items2);
        logContent('编辑内容《' + ci.title + '》· 本机');
        return ok(200, { item: publicContent(ci), pending: true });
      });
    }

    if (mContent && method === 'DELETE') {
      if (!isAdmin()) return err(403, '仅管理员可删除内容');
      var did = mContent[1];
      return withContent(function () {
        var items3 = loadContent();
        var di = items3.filter(function (x) { return x.id === did; })[0];
        if (!di) return err(404, '内容不存在');
        // 仓库里已存在的条目删不掉（合并会还原），改加墓碑：导出后全站同步删除
        var inSharedC = contentStore.inShared(di);
        saveContent(items3.filter(function (x) { return x.id !== did; }));
        if (inSharedC) contentStore.tombstone(di);
        logContent('删除内容《' + di.title + '》· 本机');
        return ok(200, { pending: true });
      });
    }

    if (url === '/api/content/export' && method === 'GET') {
      if (!isAdmin()) return err(403, '需要管理员权限');
      return withContent(function () {
        var cPayload = contentStore.exportPayload();
        return ok(200, {
          payload: cPayload,
          stats: { total: loadContent().length, exported: cPayload.items.length, deleted: cPayload.deleted.length }
        });
      });
    }

    /* ══ 自动提交（admin）══════════════════════════════
       把待发布的差异直接 PUT 进仓库，省掉「下载文件 → 手工覆盖 → git 提交」。
       Token 只在本机，不进仓库、不进导出。详见上方 §自动提交 注释。 ══ */
    if (url === '/api/publish/status' && method === 'GET') {
      if (!isAdmin()) return err(403, '需要管理员权限');
      return withUsers(function () {
        return withContent(function () { return ok(200, publishStatus()); });
      });
    }

    if (url === '/api/publish/config' && method === 'POST') {
      if (!isAdmin()) return err(403, '需要管理员权限');
      var gt = String(body.token || '').trim();
      if (!gt) return err(400, '请填写 GitHub Token');
      var guess2 = inferRepo();
      var gOwner = String(body.owner || '').trim() || guess2.owner;
      var gRepo = String(body.repo || '').trim() || guess2.repo;
      var gBranch = String(body.branch || '').trim() || 'main';
      if (!gOwner || !gRepo) return err(400, '请填写仓库 owner 与 repo');
      var probeCfg = { token: gt, owner: gOwner, repo: gRepo, branch: gBranch };
      // 保存前先验一次：Token 错 / 仓库无权限 / **只能读不能写**，此刻就该报出来
      return ghProbe(probeCfg).then(function (info) {
        /* 把「保存时确认可写」记进配置，供状态栏回显。
           老配置没有这个字段 → 状态栏不显示「已确认可写」，不误报。 */
        probeCfg.canWrite = (info.canWrite === true);
        probeCfg.writeCheckedAt = new Date().toISOString();
        saveGhCfg(probeCfg);
        var cu1 = currentUser();
        if (cu1) appendLog({ time: new Date().toISOString(), username: cu1.username, name: cu1.name, role: cu1.role, ok: true, reason: '配置自动提交：' + gOwner + '/' + gRepo + '@' + gBranch + (probeCfg.canWrite ? '（已确认可写）' : '（写权限未验证）'), ip: 'local' });
        return ok(200, { saved: true, repo: info });
      }).catch(function (e) {
        return err(400, String((e && e.message) || e));
      });
    }

    if (url === '/api/publish/config' && method === 'DELETE') {
      if (!isAdmin()) return err(403, '需要管理员权限');
      clearGhCfg();
      var cu2 = currentUser();
      if (cu2) appendLog({ time: new Date().toISOString(), username: cu2.username, name: cu2.name, role: cu2.role, ok: true, reason: '清除自动提交配置（本机）', ip: 'local' });
      return ok(200, { cleared: true });
    }

    if (url === '/api/publish' && method === 'POST') {
      if (!isAdmin()) return err(403, '需要管理员权限');
      var pcfg = loadGhCfg();
      if (!pcfg.token) return err(400, '尚未配置 GitHub Token，请先在「自动提交」里填写并保存');
      return withUsers(function () {
        return withContent(function () {
          var up = buildUsersPayload(), cp = buildContentPayload();
          var want = (body && Array.isArray(body.targets)) ? body.targets : null;
          var jobs = [];
          if ((!want || want.indexOf('users') !== -1) && (up.users.length || up.deleted.length)) {
            jobs.push({ key: 'users', path: 'data/users.json', text: JSON.stringify(up, null, 2) + '\n', n: up.users.length, d: up.deleted.length });
          }
          if ((!want || want.indexOf('content') !== -1) && (cp.items.length || cp.deleted.length)) {
            jobs.push({ key: 'content', path: 'data/content.json', text: JSON.stringify(cp, null, 2) + '\n', n: cp.items.length, d: cp.deleted.length });
          }
          if (!jobs.length) return ok(200, { published: [], message: '没有待发布的改动' });

          var pmsg = String((body && body.message) || '').trim() ||
            ('portal: 管理后台更新共享数据（' + jobs.map(function (j) { return j.path.split('/').pop(); }).join(' + ') + '）');

          var results = [];
          var chain = Promise.resolve();                 // 串行提交，避免并发写同一个 ref
          jobs.forEach(function (j) {
            chain = chain.then(function () {
              return ghPutFile(pcfg, j.path, j.text, pmsg).then(function (r) {
                results.push({ key: j.key, path: j.path, ok: true, count: j.n, deleted: j.d, commit: r.commit, commitUrl: r.commitUrl });
              }, function (e) {
                // 失败也要如实回报「试过哪个文件」—— 否则界面只知道"失败了"，
                // 分不清是第一个文件就挂还是第二个才挂
                results.push({ key: j.key, path: j.path, ok: false, count: j.n, deleted: j.d, error: String((e && e.message) || e) });
                throw e;
              });
            });
          });
          return chain
            .then(function () {
              /* 把**本次真正提交成功**的文件直接写进本地「仓库缓存」，让「待发布」立刻归零。
                 为什么不能只靠下面的 refresh 回源：
                 GitHub Pages 收到新提交后要几十秒才重建完，这期间回源拿到的还是**旧文件**，
                 于是界面继续显示「待发布 N 条」、按钮继续可点 —— 用户以为没成功而重复点击。
                 （实测：提交成功到页面数据更新之间约 40 秒，正是这个窗口。） */
              var doneKeys = {};
              results.forEach(function (r) { if (r.ok) doneKeys[r.key] = 1; });
              jobs.forEach(function (j) {
                if (!doneKeys[j.key]) return;
                try {
                  writeJSON(j.key === 'users' ? K.usersRemote : K.contentRemote, JSON.parse(j.text));
                } catch (e) { /* 解析异常不该吞掉发布成功的结果 */ }
              });
              /* 没发布的那一类照常回源；已发布的跳过 —— 免得被 Pages 上的旧副本又盖回去 */
              var rf = Promise.resolve();
              if (!doneKeys.users) rf = rf.then(function () { return usersStore.refresh(); });
              if (!doneKeys.content) rf = rf.then(function () { return contentStore.refresh(); });
              return rf;
            })
            .then(function () {
              var cu3 = currentUser();
              if (cu3) appendLog({
                time: new Date().toISOString(), username: cu3.username, name: cu3.name, role: cu3.role, ok: true,
                reason: '一键发布到仓库：' + results.map(function (r) { return r.path.split('/').pop() + '(' + r.count + ')'; }).join('、'),
                ip: 'local'
              });
              return ok(200, { published: results, repo: pcfg.owner + '/' + pcfg.repo + '@' + pcfg.branch });
            })
            .catch(function (e) {
              // 一个文件失败就不再继续；已成功的部分如实回报（不做静默回滚）
              return Promise.resolve({ ok: false, _status: 500, error: String((e && e.message) || e), published: results });
            });
        });
      });
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
          return ok(200, { empty: true, message: '尚未同步日报数据。抓取跑在 GitHub Actions 上（每日 11:00 / 17:00），也可到 Actions 页面点 Run workflow 手动补一次。' });
        });
    }

    /* ── 数据刷新：**已移除** ─────────────────────
       原来这里是 POST /api/data/refresh，恒返回 501「请在本机运行抓取脚本」。
       但纯静态站没有服务端，抓取只能在 GitHub Actions 里跑，所以这个接口
       从来没有真正工作过 —— 它只是让管理后台那个按钮变成"点了必报错"的摆设。
       现在按钮换成直达 Actions 页的链接，这段也随之删掉（别留会骗人的代码）。
       要手动补抓：GitHub → Actions → 钉钉日报数据抓取 → Run workflow。 */

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
  /* 页面一打开就预热共享名单与内容清单，让登录/列表拿到的都是最新数据 */
  try { ensureRemote(); } catch (e) { /* 忽略 */ }
  try { contentStore.ready(); } catch (e) { /* 忽略 */ }

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
    remote: function () { return usersStore.status(); },
    remoteReady: function () { return ensureRemote(); },   // 等名单拉取落地（含失败）后再读 remote()
    refreshRemote: function () { return ensureRemote(true); },

    /* 内容表（data/content.json）状态与手动刷新 */
    contentRemote: function () { return contentStore.status(); },
    contentReady: function () { return contentStore.ready(); },
    refreshContent: function () { return contentStore.refresh(); },
    contentTypes: function () { return CONTENT_TYPES.slice(); },
    contentStatus: function () { return CONTENT_STATUS.slice(); },

    isSecure: isSecureContext,
    insecureMsg: INSECURE_MSG
  };
})();
