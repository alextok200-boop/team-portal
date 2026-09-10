# 团队门户（静态版）

内部权限门户的 **GitHub Pages 静态部署版**。

> 由 Node 后端版（`login-portal` v2.0.0）改造而来，去掉后端，改为**纯前端**实现，
> 以便免费托管在 GitHub Pages。

## ✨ 与后端版的差异

| 能力 | 后端版（login-portal） | 本静态版 |
|---|---|---|
| 登录鉴权 | 服务端 scrypt 哈希 | **前端 SHA-256 哈希比对** |
| 用户/角色管理 | 服务端落盘，全员共享 | **localStorage 本地存储**（admin 后台配置仅本浏览器生效） |
| 日报数据 | 服务端每日 11:05 自动抓取 | **静态 JSON 快照**（本地抓取后推送更新） |
| 会话 | HMAC 签名令牌 | localStorage 令牌（8 小时） |
| 部署 | 需 Node 服务器 | **GitHub Pages 免费静态托管** |

> ⚠️ **静态版是「弱鉴权」**：源码可见、前端密码哈希可被绕过，仅供内部轻量使用。
> 若需要真正的服务端鉴权与共享用户管理，请用后端版（`C:\Users\alext\Web\login-portal`）。

## 🚀 访问地址

部署后访问：`https://alextok200-boop.github.io/team-portal/`

## 🔑 默认账号

| 账号 | 密码 | 角色 |
|---|---|---|
| `admin` | `admin2026` | 管理员（全部权限） |
| `leader` | `team2026` | 团队主管 |
| `member` | `view2026` | 团队成员 |

⚠️ 密码以 SHA-256 哈希存储在 `js/config/roles.js`，登录时前端比对。
首次使用建议在「管理后台 → 用户管理」中改密（改后仅保存在当前浏览器）。

## 📂 目录结构

```
team-portal/
├── index.html              # 入口（智能跳转）
├── login.html              # 登录页
├── css/portal.css          # 门户样式（深色霓虹）
├── js/
│   ├── api.js              # 静态版本地数据层（模拟原后端 API）
│   ├── auth.js             # 认证与权限
│   ├── portal.js           # 顶栏 / 守卫 / 提示
│   └── config/roles.js     # 默认角色 + 默认用户（密码哈希）
├── pages/                  # 业务页面
│   ├── dashboard.html      # 工作台
│   ├── admin.html          # 管理后台（用户/角色/数据/日志）
│   ├── data.html           # 日报数据（钉钉快照）
│   ├── careers.html        # 加入我们
│   ├── metrics.html        # 数据指标
│   ├── members.html        # 成员管理
│   ├── content.html        # 内容管理
│   ├── settings.html       # 系统设置
│   ├── logs.html           # 登录日志
│   ├── denied.html         # 无权访问
│   └── 404.html
├── data/daily.json         # 日报数据快照（钉钉 AI 表格）
└── assets/favicon.svg
```

## ⚙️ 关键实现说明

### 1. base 前缀（GitHub Pages 子路径部署）

本项目部署在 `/team-portal/` 子路径，所有资源引用采用**相对路径 + 静态 `<base>` 标签**：

- 每个 HTML `<head>` 顶部有 `<base href="/team-portal/">`
- 资源引用（`css/...`、`js/...`、`pages/...`）为相对路径，由 `<base>` 统一解析
- JS 里的跳转通过 `Site.url('/xxx')` 拼接、权限比对通过 `Site.strip()` 剥前缀

> ⚠️ **若改了仓库名，需同步修改每个 HTML 里的 `<base href="/team-portal/">`**
> 为 `/<新仓库名>/`。

### 2. 登录鉴权（前端）

`js/api.js` 把原后端 `/api/*` 调用映射到本地实现：
- 登录：`crypto.subtle.digest('SHA-256', 密码)` 与 `roles.js` 里的哈希比对
- 会话：localStorage 存令牌（8 小时过期）
- 用户/角色/日志：localStorage 持久化（首次用 roles.js 默认值）

### 3. 日报数据（静态快照）

`data/daily.json` 是钉钉 AI 表格的静态快照。更新方式：
1. 在 `C:\Users\alext\Web\login-portal` 项目里运行 `node scripts/fetch-dingtalk.js`
2. 把生成的 `data/daily.json` 复制到本项目的 `data/` 目录
3. 提交推送，线上即更新

## 📤 部署（GitHub Pages）

1. 在 GitHub 新建仓库 `team-portal`（Public）
2. 推送本目录内容到仓库
3. 仓库 **Settings → Pages → Source 选 `main` 分支 `/ (root)`** 保存
4. 等待约 1 分钟，访问 `https://alextok200-boop.github.io/team-portal/`

> 已含 `.nojekyll` 空文件，确保 GitHub Pages 不经过 Jekyll 处理（避免 `_` 开头目录被忽略）。

## 📝 变更日志

- **静态版 v1.0.0**（2026-09-10）：由 login-portal v2.0.0 改造为纯前端静态版，
  适配 GitHub Pages 子路径部署，登录/权限/数据全部本地化。
