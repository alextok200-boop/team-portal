/* ─────────────────────────────────────────────────────────────
   「加入我们」（Careers）展示区 · 共享逻辑
   ─────────────────────────────────────────────────────────────
   被两个页面共用，避免岗位数据写两份：
     · index.html  公开首页（加入我们 + 右上角登录按钮）
     · login.html  登录页（加入我们作为主要展示内容 + 右侧登录栏）

   ⚠️ 岗位数据只在本文件维护一处，两页同步生效。
      新增/下架岗位改下面的 JOBS 数组即可；status: 'open'=在招，其它=储备。
   ───────────────────────────────────────────────────────────── */
(function (global) {
  'use strict';

  /* 转义：不依赖 portal.js，让登录页也能单独引本文件 */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* ── 在招岗位数据 ───────────────────────────────────────────
     字段：title 岗位名 / status open|pool / code 岗位编码 / loc 地点 / type 性质
           dept 部门 / report 汇报对象 / desc 概述 / duties 职责 / reqs 要求
           kpi 考核口径[[项, 权重]] / sys 常用系统 / plus 加分项 / red 红线
           mailto 投递链接 / applyText 按钮文案
     ─────────────────────────────────────────────────────────── */
  var JOBS = [
    {
      title: 'TK 跨境直播运营', status: 'open', code: 'HR-JD-TTS06',
      loc: '南京（江苏）· 深圳可选', type: '全职', dept: '跨境电商',
      report: '跨境负责人 / 平台负责人',
      desc: '负责 TikTok Shop 小店运营，以短视频挂车 + 直播场控 + 达人联盟驱动 GMV，对店铺 GMV、直播间转化与联盟 ROI 负责。',
      duties: ['短视频：挂车选品与转化，维护内容日历', '直播：小店直播排期与场控，输出直播表',
               '联盟：达人联盟带货与佣金管理，维护联盟台账', '投流：Shop Ads 计划搭建与 ROI 优化，维护投流台账',
               '数据：罗盘复盘与优化，输出周报与下一步动作'],
      reqs: ['大专及以上，电子商务 / 市场营销优先', '2 年以上 TikTok Shop 或抖音直播运营经验，有台球 / 运动器材类目优先',
             '熟悉平台规则、流量与转化逻辑，英语能支撑基础商务沟通', '会搭投放计划、控 ROI，能看懂转化漏斗并据此调整动作',
             '数据敏感、执行强、抗压，能接受直播排班（晚间场次）'],
      kpi: [['GMV 达成率', '35%'], ['直播间转化', '20%'], ['短视频转化', '20%'], ['联盟 ROI', '15%'], ['店铺评分', '10%']],
      sys: 'TikTok Shop 后台（短视频 / 直播 / 联盟 / Shop Ads）',
      plus: '台球 / 运动器材类目经验、现有海外达人资源、基础剪辑、小语种（日 / 德）。',
      red: '虚假宣传 / 绝对化用语 / 刷量刷单 / 违规带货 / 侵权仿牌',
      mailto: 'mailto:alextok200@gmail.com?subject=%E5%86%85%E6%8E%A8-TK%E8%B7%A8%E5%A2%83%E7%9B%B4%E6%92%AD%E8%BF%90%E8%90%A5',
      applyText: '内推这个岗位'
    },
    {
      title: '跨境电商运营（Lazada / Shopee 东南亚）', status: 'pool', code: 'HR-JD-LZD03 / HR-JD-SHP04',
      loc: '南通（跨境主阵地）· 南京', type: '全职', dept: '跨境电商',
      report: '跨境负责人 / 平台负责人',
      desc: '负责 Lazada / Shopee 东南亚站点从 0 起盘：开店合规 → 本地化选品上架 → 站内活动与大促 → 履约与评分，对站点 GMV、店铺评分与履约 SLA 负责。储备状态，站点开通时开放，可先投简历进人才池。',
      duties: ['起盘：站点开通与资质合规（执照 / 类目准入 / 税务与清关资料）',
              '本地化：标题 / 主图 / 详情的多语种与币种本地化，维护 Listing 表与本地词库',
              '选品：按站点需求选品与定价，算清头程 / 佣金 / 关税 / 汇率后的到手毛利',
              '活动：报名大促（9.9 / 10.10 / 11.11 / 12.12）与站内资源位，控折扣与毛利',
              '履约与评分：发货时效、物流轨迹与售后响应，店铺评分与罚款项清零',
              '竞品与复盘：维护五站竞品台账，输出周报与下一步动作'],
      reqs: ['大专及以上，电子商务 / 国际贸易 / 市场营销优先',
             '1 年以上 Lazada 或 Shopee 运营经验，有东南亚站点从 0 起盘经历优先',
             '熟悉东南亚市场差异：站点规则、币种与物流方案、大促节奏、消费习惯',
             '会算跨境成本与到手毛利，能做本地化定价，不靠拍脑袋报价',
             '数据敏感、执行强，能自己搭表维护竞品与 Listing；英语可支撑商务沟通'],
      kpi: [['新站起盘进度（开店 / 上架 / 首单）', '30%'], ['GMV 达成率', '25%'], ['店铺评分与履约 SLA', '20%'], ['竞品与选品台账质量', '15%'], ['活动投产 ROI', '10%']],
      sys: 'Lazada Seller Center、Shopee 卖家中心（菲 / 马 / 泰 / 墨 / 阿）、shopee 竞品台账',
      plus: '泰语 / 马来语 / 印尼语 / 西语能力、东南亚海外仓或本地物流资源、台球 / 运动器材类目经验、跨境清关实操。',
      red: '刷单刷评 / 侵权仿牌 / 虚假发货 / 恶意低价扰乱 / 用爬虫或自动化脚本违规采集平台数据',
      mailto: 'mailto:alextok200@gmail.com?subject=%E5%86%85%E6%8E%A8-Lazada-Shopee%E4%B8%9C%E5%8D%97%E4%BA%9A%E8%BF%90%E8%90%A5',
      applyText: '推荐候选人进人才池'
    },
    {
      title: '运营自动化 / AI 技能包工程', status: 'pool', code: 'HR-JD-DA06',
      loc: '远程协作 · 南京', type: '全职 / 兼职', dept: '数据与增长（技术中台）',
      report: '技术负责人 / 副总',
      desc: '技术 / 数据中台支撑岗。打通各平台 API → 沉淀数据底座 → 运维服务器 → 迭代 AI 需求，把投流审核、视觉生产、数据看板、OA 审批这类重复工作封装成可安装的 AI 技能包，交付给零基础同事使用。',
      duties: ['API 打通：京东 / 天猫 / 抖音 / 拼多多 + Amazon / Shopify / Temu / 阿里国际站',
              '数据底座：ERP / 钉钉多维表等异构数据归一化，统一指标口径与质量校验',
              'AI 需求迭代：技能包开发（SKILL.md + run.py）、安全审计与 SHA 校验、语义化版本发布与回滚',
              '服务器部署：云主机 / 容器环境搭建、应用发布与反向代理、公网暴露',
              '日常运维：监控告警、定期备份与恢复演练、日志巡检、安全加固'],
      reqs: ['大专及以上，统计 / 计算机 / 电商数据相关优先', '2 年以上电商数据分析、投流或自动化工程经验',
             '熟悉电商指标体系、投放逻辑与 SQL / 表处理，能用 Python 或 Node 写脚本',
             '做过看板类应用（如 Flask API + ECharts + SQLite）或同等项目',
             '逻辑清晰、有工作流洁癖，能把模糊需求拆成可交付的小步'],
      kpi: [['各平台 API 打通', '25%'], ['AI 需求升级迭代', '25%'], ['数据底座维护', '22%'], ['服务器部署能力', '15%'], ['服务器日常维护', '13%']],
      sys: '数据中台看板、生意参谋、京东商智、蝉妈妈、各平台投流后台',
      plus: '有已发布的可安装技能包作品、熟悉钉钉 / DWS / Aitable 开放平台、做过 OCR 或图像链路。',
      red: '泄露经营数据 / 私自操作生产后台 / 敷衍错录造成资损 / 交付未过审的技能包',
      mailto: 'mailto:alextok200@gmail.com?subject=%E5%86%85%E6%8E%A8-%E8%BF%90%E8%90%A5%E8%87%AA%E5%8A%A8%E5%8C%96',
      applyText: '推荐候选人进人才池'
    },
    {
      title: '跨境电商运营（Amazon / Temu）', status: 'pool', code: 'HR-JD-AMZ01 / HR-JD-TEMU02',
      loc: '南通（跨境主阵地）· 南京', type: '全职', dept: '跨境电商',
      report: '跨境负责人 / 平台负责人',
      desc: '负责 Amazon 多站点与 Temu 半 / 全托管运营：以 Listing + 广告 + FBA 驱动 GMV 与排名，以备货履约与核价驱动走量与毛利。储备状态，业务放量时开放，可先投简历进人才池。',
      duties: ['Listing：标题 / 图文 / A+ 优化与关键词，维护 Listing 表',
              '广告：SP / SB / SD 结构与 ACOS 优化，做否定词与预算再分配',
              'FBA 库存：补货计划与库存周转，控 IPI，不断货不积压',
              '合规与评分：合规索评、类目审核与账户健康维护',
              'Temu 履约：国内仓备货、核价跟进与爆款选品，控退货率',
              '数据复盘：销量与毛利复盘，输出周报与迭代动作'],
      reqs: ['大专及以上，电子商务 / 市场营销优先', '2 年以上 Amazon 或 Temu 运营经验，有台球 / 运动器材类目优先',
             'Amazon：懂 A9 算法、关键词与转化逻辑、FBA 与自发货差异、Coupon / BD / LD 节奏',
             'Temu：懂核价逻辑与毛利空间，能推动备货节奏避免断货 / 积压',
             '数据敏感、执行强、抗压，能用数据定位断点并迭代'],
      kpi: [['GMV 达成率', '35%'], ['ACOS ≤ 红线 / 履约时效 ≤ SLA', '20%'], ['BSR 排名 / 毛利率 ≥ 红线', '20%'], ['库存周转 / 缺货率 ≤ 红线', '15%'], ['评分 ≥ 红线 / 退货率 ≤ 红线', '10%']],
      sys: 'Amazon Seller Central（美 / 加 / 英 / 德 / 日 5 站）、广告与品牌分析、Temu 半托管·全托管后台',
      plus: 'Amazon 多站点（美 / 加 / 英 / 德 / 日）实操、海外仓资源、小语种。',
      red: '刷评 / 刷单 / 跟卖侵权 / 规避二审 / 虚假发货 / 货不对板 / 恶意低价扰乱',
      mailto: 'mailto:alextok200@gmail.com?subject=%E5%86%85%E6%8E%A8-%E8%B7%A8%E5%A2%83%E7%94%B5%E5%95%86%E8%BF%90%E8%90%A5',
      applyText: '推荐候选人进人才池'
    }
  ];

  /* ── 渲染岗位列表 ─────────────────────────────────────────── */
  function renderJobs(root) {
    var openCount = JOBS.filter(function (j) { return j.status === 'open'; }).length;
    root.innerHTML = JOBS.map(function (j) {
      var isOpen = j.status === 'open';
      return '<article class="card job-card' + (isOpen ? '' : ' job-dim') + '">' +
        '<div class="job-head">' +
          '<h3>' + esc(j.title) + '</h3>' +
          (isOpen ? '<span class="tag tag-green">在招</span>' : '<span class="tag tag-blue">储备</span>') +
        '</div>' +
        '<div class="job-meta">' +
          '<span>📍 ' + esc(j.loc) + '</span><span>🕐 ' + esc(j.type) + '</span><span>🏷 ' + esc(j.dept) + '</span>' +
        '</div>' +
        '<p class="job-report">汇报对象：<b>' + esc(j.report) + '</b><span class="job-sep">·</span>岗位编码：<code>' + esc(j.code) + '</code></p>' +
        '<p class="muted">' + esc(j.desc) + '</p>' +
        '<h4>岗位职责</h4><ul class="job-list">' + j.duties.map(function (d) { return '<li>' + esc(d) + '</li>'; }).join('') + '</ul>' +
        '<h4>任职要求</h4><ul class="job-list">' + j.reqs.map(function (d) { return '<li>' + esc(d) + '</li>'; }).join('') + '</ul>' +
        '<h4>考核口径（KPI）</h4><ul class="job-kpi">' + j.kpi.map(function (k) {
          return '<li><span>' + esc(k[0]) + '</span><span class="kpi-w">' + esc(k[1]) + '</span></li>';
        }).join('') + '</ul>' +
        '<p class="job-sys">常用系统：<b>' + esc(j.sys) + '</b></p>' +
        '<p class="muted">加分项：' + esc(j.plus) + '</p>' +
        '<p class="job-redline"><b>红线（一票否决）</b>：' + esc(j.red) + '</p>' +
        '<a class="btn ' + (isOpen ? 'btn-primary' : 'btn-ghost') + ' btn-sm" href="' + j.mailto + '">' + esc(j.applyText) + '</a>' +
      '</article>';
    }).join('');
    return { total: JOBS.length, open: openCount };
  }

  /* ── 渲染右上角操作区（登录态自适应）────────────────────────
     opts.loginHref —— 未登录时的去向。login.html 上传 null 表示「登录表单就在本页」，
     此时不放指向自己的链接，改为锚点跳到登录栏（桌面吸顶栏 / 移动端下方卡片都适用）。

     ⚠️ 锚点必须写全路径：本页有 <base href="/team-portal/">，纯片段链接 `#xxx` 会按 base
        解析成 `/team-portal/#xxx` —— 那是目录根（index.html），会直接跳走而不是本页滚动。
        所以这里用 Site.url('login.html') 拼成绝对路径再挂片段。 */
  var SELF = (global.Site && typeof Site.url === 'function')
    ? Site.url('login.html')
    : 'login.html';

  function renderActions(root, opts) {
    var loginHref = (opts && opts.loginHref !== undefined) ? opts.loginHref : 'login.html';
    function anon() {
      root.innerHTML = loginHref === null
        ? '<a href="' + SELF + '#loginRail" class="btn btn-primary">登录</a>'
        : '<a href="' + loginHref + '" class="btn btn-primary">登录</a>';
    }
    anon();
    if (!global.API || !API.getToken()) return;
    Auth.init().then(function (u) {
      if (!u) { anon(); return; }
      root.innerHTML =
        '<span class="user-chip" style="margin-left:0">' +
          '<span class="avatar" style="background:' + (u.color || '#00ffa3') + '">' + esc((u.name || '?').charAt(0)) + '</span>' +
          esc(u.name) + ' · ' + esc(u.roleName || u.role) +
        '</span>' +
        '<a href="pages/board.html" class="btn btn-primary">进入看板</a>';
    });
  }

  /* ── 入口 ─────────────────────────────────────────────────── */
  function init(opts) {
    opts = opts || {};
    var stats = null;
    var jl = document.getElementById('jobList');
    if (jl) stats = renderJobs(jl);
    /* 岗位计数占位：hero 文案里写 <b data-job-count></b> 自动填在招数 */
    if (stats) {
      Array.prototype.forEach.call(document.querySelectorAll('[data-job-count]'), function (el) {
        el.textContent = String(stats.open);
      });
    }
    var area = document.getElementById('loginArea');
    if (area) renderActions(area, opts);
    return stats;
  }

  global.Landing = { JOBS: JOBS, init: init, renderJobs: renderJobs, esc: esc };
})(window);
