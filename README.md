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
├── index.html              # 首页（加入我们展示 + 视频背景 + 右上角登录按钮）
├── login.html              # 登录页
├── css/portal.css          # 门户样式（深色霓虹）
├── js/
│   ├── api.js              # 静态版本地数据层（模拟原后端 API）
│   ├── auth.js             # 认证与权限
│   ├── portal.js           # 顶栏 / 守卫 / 提示
│   ├── board.js            # 业务数据看板的图表与聚合逻辑（ECharts）
│   └── config/roles.js     # 默认角色 + 默认用户（密码哈希）
├── pages/                  # 业务页面
│   ├── board.html          # 业务数据看板（登录后通用首页，指标卡可钻取）
│   ├── tables.html         # 数据中心（9 张表浏览 / 搜索 / 钻取）
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
├── data/daily.json              # 日报数据快照（钉钉 AI 表格，Actions 自动更新）
├── assets/showcase.mp4          # 首页背景视频（1080p H.264，约 3.9MB）
├── assets/favicon.svg           # 站点图标
├── vendor/echarts.min.js        # ECharts 5.5.1（已入库，**不外链 CDN**）
├── scripts/fetch-openapi.js     # 钉钉 OpenAPI 抓取脚本（纯 OpenAPI，无需本机）
├── .github/workflows/fetch.yml  # GitHub Actions 定时抓取（每日 11:05）
├── tools/sync-local.sh          # 本地仓库对齐远端（API 推送后必跑）
├── tools/fetch-remote-commit.py # 上述脚本的 API 兜底（github.com 不通时用）
└── .nojekyll                    # 防 Jekyll 处理
```

**导航顺序**（登录后顶栏）：业务数据看板 → 工作台 → 日报数据 → 数据中心 → 数据指标 → 内容管理 → 成员管理 → 加入我们 → 管理后台 → 系统设置 → 登录日志

**角色权限**（`js/config/roles.js` 的 `DEFAULT_ROLES`）：

| 角色 | 可访问页面 |
|---|---|
| `admin` | `['*']` 全部 |
| `team_leader` | board / dashboard / data / tables / metrics / members / careers |
| `member` | board / dashboard / data / tables / content / careers |


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

### 3. 日报数据（钉钉自动抓取链路）

`data/daily.json` 是钉钉 AI 表格《电商营销备战-日报追踪表》的静态快照，**全自动更新**：

```
钉钉 AI 表格 → GitHub Actions（每天 11:05）→ scripts/fetch-openapi.js
             → data/daily.json → 自动 commit/push → 网站自动更新
```

- 数据源 baseId：`OG9lyrgJPzYDzl1ESvXRdpEYWzN67Mw4`（共 17 张表，抓取其中 9 张）
- 定时器：`.github/workflows/fetch.yml`，**每日两次** —— UTC 03:05（北京 11:05）与 UTC 10:30（北京 18:30），另支持手动 `workflow_dispatch`
- 每表行数上限：`DINGTALK_ROW_CAP`（默认 **4000**，可用环境变量或手动触发的输入覆盖）
- 抓取脚本 v1.2.0：带**指数退避重试**（网络抖动不再整表失败），并输出 `truncated` / `filledRows` / `failedTables` 元数据 —— **截断不再无声**
- 所需 4 个 GitHub Secret：`DINGTALK_APP_KEY` / `DINGTALK_APP_SECRET` / `DINGTALK_OPERATOR_ID` / `DINGTALK_BASE_ID`

> ⚠️ **钉钉 OpenAPI 拿不到「公式 / 查找引用 / 关联引用 / 自动编号」字段**（官方限制）。
> 日报总览的 GMV / 订单 / UV 是公式字段，所以看板核心指标**改从「分店铺日报」聚合**
> （分店铺的 GMV / 订单 / UV 是手工录入，可以拿到）。

手动补跑：Actions 页面 → `fetch` workflow → `Run workflow`。

### 4. 本地 Git 同步（重要）
本项目的推送常需走 **Git Data API 绕行**（blob → tree → commit → ref），
因为本机 `git push` 走 github.com:443 会被 reset / SSL 中断。**API 推送不会回写本地 git**，
长期下来本地历史会与远端分叉（本地 `git log` 看不到真实版本、`git pull` 冲突、本地无法当回滚点）。

因此：**凡做过 API 推送，或不确定本地是否落后，跑一次**

```bash
bash tools/sync-local.sh            # 对齐；工作区有未提交改动则先备份并停下（不丢东西）
bash tools/sync-local.sh --check    # 只报告差多少，不动文件（落后时退出码 2）
bash tools/sync-local.sh --force    # 确认丢弃未提交改动，强制对齐
```

> 🔒 **防误删闸门**：工作区有未提交改动时，脚本会先整包备份到 `../_backup/`，
> 然后**停下并列出**将被丢弃的文件，必须显式加 `--force` 才继续。
> （这条闸门是踩坑换来的：早期版本直接 reset，把刚改好的文件无声冲掉了。）

脚本走**双通路**，因为本机 `github.com` 时通时断：

| 通路 | 触发条件 | 做法 |
|---|---|---|
| ① `git fetch` | github.com:443 可达 | 直接取回对象（首选） |
| ② `api.github.com` 兜底 | fetch 被 reset / 502 / SSL eof | `tools/fetch-remote-commit.py` 从 API 取远端 SHA，**在本地重建同 SHA 的 commit 对象**，再 reset |

另有两个环境坑已在脚本内处理：
- **代理干扰**：脚本开头 `unset http_proxy/https_proxy/...`（沙箱注入的代理常让 github.com 的 CONNECT 隧道 502）
- **`git update-ref` 静默失效**：受限环境下 git 写 `.git/refs/remotes/**` 会无声失败，导致 `origin/main` 解析不到、`git status` 永远显示 up-to-date —— 脚本用幂等直写兜底

> ⚠️ `git reset --hard` 会删掉「只在旧提交里存在」的文件（实测踩过：回退时把整个 `tools/` 目录删了）。
> 该脚本只用于**向前对齐**，不要拿它当回退工具。
>
> 正常网络下 `git push` / `git pull` 可直接用；只有 443 被中断时才需要 API 绕行。
> 无论走哪条路，推送后养成跑一次 `sync-local.sh` 的习惯。

### 5. 业务数据看板（图表口径）

`pages/board.html` + `js/board.js`，图表用**仓库内**的 `vendor/echarts.min.js`（5.5.1），不外链 CDN —— 内部团队在国内网络下也能稳定加载。

| 图 | 内容 | 数据来源 |
|---|---|---|
| 日 GMV 趋势 | 国内 / 跨境双折线 | domestic + crossborder，按「日期」聚合 |
| 分店铺 GMV Top 10 | 横向条（**X 轴对数刻度**） | 同上，同店多日累计 |
| 平台 GMV 占比 | 环形 | 按店铺所属「平台」归类 |
| 负责人 GMV / 净利润 | 横向双系列条 | perf 表 |

**两条口径不可混用**（页面上也有标注）：

- **核心指标 = 国内 + 跨境 分店铺日报聚合**。日报总览的 GMV/订单/UV 是钉钉**公式字段**，OpenAPI 取不到，所以只能从分店铺聚合。
- **负责人业绩 = perf 表**，属「负责人认领口径」，与分店铺口径**不可直接相加**。

> 看板顶部有一条数据完整性提示：显示抓取了多少表/行、其中**有效记录**多少条、覆盖多少日期。
> 报表里绝大多数行是**预建的空日期占位行**（投放/内容/流量/供应链 4 表数值字段目前填充率为 0），
> 所以这 4 张表暂不出图 —— 等数据录入后加图即可。

## 📤 部署（GitHub Pages）

1. 在 GitHub 新建仓库 `team-portal`（Public）
2. 推送本目录内容到仓库
3. 仓库 **Settings → Pages → Source 选 `main` 分支 `/ (root)`** 保存
4. 等待约 1 分钟，访问 `https://alextok200-boop.github.io/team-portal/`

> 已含 `.nojekyll` 空文件，确保 GitHub Pages 不经过 Jekyll 处理（避免 `_` 开头目录被忽略）。

## 📝 变更日志

> 站点版本与资源版本分开：站点版本走语义化（v1.x.x），HTML 里的 `?v=` 是**缓存击穿号**（当前 2.2.0）。

- **v1.2.0**（2026-09-10）· 资源版本 `?v=2.2.0`：
  - **看板增强**：新增 4 张图表（日 GMV 趋势 / 分店铺 Top10 / 平台占比 / 负责人业绩），逻辑抽到 `js/board.js`；ECharts 5.5.1 **入库**到 `vendor/`（不外链 CDN）；指标卡加副标（占比 / 费比）；新增数据完整性提示条与负责人业绩小结。
  - **抓取配置调整**：每表行数上限 200 → **4000**（原上限导致 domestic/crossborder/ads/content 四表被**静默截断**）；新增 `truncated` / `filledRows` / `failedTables` 元数据；HTTP 层加**指数退避重试**；截断精确切齐；抓取改为**每日两次**（11:05 / 18:30）；workflow 推送前加 `git pull --rebase` + `concurrency` 锁，避免与人工推送撞车。
  - 统一全站 `css/portal.css?v=2.2.0`（原先 2.0.0/2.1.0 混用）。
- **v1.1.1**（2026-09-10）：同步脚本加固
  - 双通路：`git fetch` 不通时自动走 `api.github.com` 兜底（新增 `tools/fetch-remote-commit.py`，在本地重建同 SHA 的 commit 对象）
  - 新增**防误删闸门** `--force`：工作区脏时先备份再停下，不再无声丢弃未提交改动
  - 修掉两个隐蔽坑：`git update-ref` 在本环境静默失效（改直写兜底）；Windows 下 Python 文本模式把 `\n` 转成 `\r\n` 致重建 SHA 永不匹配（改字节流）
  - 新增 `.gitignore`（`__pycache__`、API 推送临时产物）
- **v1.1.0**（2026-09-10）：
  - 新增 `tools/sync-local.sh` —— 本地仓库对齐远端 main；修复本地 git 与远端历史分叉（本地曾只有 1 个 commit，远端已 8 个）。
  - README 补齐：业务数据看板 / 数据中心 / 钉钉自动抓取链路 / 角色权限表 / 完整目录结构。
  - **修正过时说明**：原「日报数据更新方式」仍写手工从 login-portal 拷 JSON，实际早已改为 GitHub Actions 自动抓取。
- **静态版 v1.0.0**（2026-09-10）：由 login-portal v2.0.0 改造为纯前端静态版，
  适配 GitHub Pages 子路径部署，登录/权限/数据全部本地化。



