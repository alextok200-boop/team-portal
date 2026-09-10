/* ============================================================
   config/roles.js —— 静态版默认配置（单一事实源）
   ------------------------------------------------------------
   本文件是「首次访问」的默认配置：
   - DEFAULT_USERS  默认账号（密码以 SHA-256 哈希存储，非明文）
   - DEFAULT_ROLES  默认角色与页面权限
   - PAGE_CATALOG   页面目录（导航 + 权限勾选用）

   ⚠️ admin 在「管理后台」中的修改会保存到浏览器 localStorage，
      覆盖这里的默认值——但只在该浏览器生效（静态版无服务端）。
      要全局改默认配置，就改本文件后重新部署。
   ============================================================ */

var DEFAULT_ROLES = {

  /* ── 管理员：全权 ───────────────────────────── */
  admin: {
    name: '管理员',
    color: '#00ffa3',
    landing: '/pages/board.html',
    desc: '全部页面 + 用户与权限管理',
    builtin: true,
    pages: ['*']
  },

  /* ── 团队主管：数据与管理 ───────────────────── */
  team_leader: {
    name: '团队主管',
    color: '#00c8ff',
    landing: '/pages/board.html',
    desc: '业务数据看板 + 日报数据 + 数据中心 + 数据指标 + 成员管理',
    builtin: false,
    pages: [
      '/pages/board.html',
      '/pages/dashboard.html',
      '/pages/data.html',
      '/pages/tables.html',
      '/pages/metrics.html',
      '/pages/members.html',
      '/pages/careers.html'
    ]
  },

  /* ── 团队成员：只读工作台 ───────────────────── */
  member: {
    name: '团队成员',
    color: '#ff5ec9',
    landing: '/pages/board.html',
    desc: '业务数据看板 + 工作台 + 日报数据 + 数据中心 + 内容管理（只读）',
    builtin: false,
    pages: [
      '/pages/board.html',
      '/pages/dashboard.html',
      '/pages/data.html',
      '/pages/tables.html',
      '/pages/content.html',
      '/pages/careers.html'
    ]
  }
};

/* ── 默认账号（密码 SHA-256 哈希）────────────── */
var DEFAULT_USERS = [
  {
    id: 'u_admin',
    username: 'admin',
    name: '戴程鹏',
    role: 'admin',
    passwordHash: '6051fc84a7a0d74c225fb18a496b09952da5642e60723ecae543298edd7d82d6', // admin2026
    active: true,
    builtin: true,
    createdAt: '2026-09-10T00:00:00.000Z',
    lastLogin: null
  },
  {
    id: 'u_leader',
    username: 'leader',
    name: '团队主管',
    role: 'team_leader',
    passwordHash: '9304f394b0a1094be8852558181308fe7434fc51c6cdb055dda6b70c9f1ea8a6', // team2026
    active: true,
    builtin: false,
    createdAt: '2026-09-10T00:00:00.000Z',
    lastLogin: null
  },
  {
    id: 'u_member',
    username: 'member',
    name: '团队成员',
    role: 'member',
    passwordHash: 'd5202e6904b89534425e3e52d9173445bf493805ad2c40edddd1529d497cde18', // view2026
    active: true,
    builtin: false,
    createdAt: '2026-09-10T00:00:00.000Z',
    lastLogin: null
  }
];

/* ── 页面目录（导航 + 权限勾选）──────────────── */
var PAGE_CATALOG = [
  { path: '/pages/board.html',     label: '业务数据看板', group: '核心' },
  { path: '/pages/dashboard.html', label: '工作台',       group: '核心' },
  { path: '/pages/data.html',      label: '日报数据',     group: '核心' },
  { path: '/pages/tables.html',    label: '数据中心',     group: '核心' },
  { path: '/pages/metrics.html',   label: '数据指标',     group: '数据' },
  { path: '/pages/content.html',   label: '内容管理',     group: '内容' },
  { path: '/pages/members.html',   label: '成员管理',     group: '数据' },
  { path: '/pages/careers.html',   label: '加入我们',     group: '内容' },
  { path: '/pages/admin.html',     label: '管理后台',     group: '系统' },
  { path: '/pages/settings.html',  label: '系统设置',     group: '系统' },
  { path: '/pages/logs.html',      label: '登录日志',     group: '系统' }
];

/* 会话有效期（毫秒）8 小时 */
var SESSION_TTL = 8 * 60 * 60 * 1000;
