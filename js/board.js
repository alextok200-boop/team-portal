/* ============================================================
   board.js —— 业务数据看板（指标卡 + 4 图 + 2 表）
   ------------------------------------------------------------
   数据源：data/daily.json（钉钉 AI 表格快照，Actions 自动更新）
   依赖：vendor/echarts.min.js（已入库，不外链 CDN）+ Portal/API/Auth

   口径说明（重要）：
     · 核心指标 = domestic(国内) + crossborder(跨境) 两张分店铺日报聚合
       （日报总览的 GMV/订单/UV 是钉钉公式字段，OpenAPI 取不到）
     · 负责人业绩 = perf 表，属「负责人认领口径」，与分店铺口径不可直接相加
     · perf 的「负责人」列**不在源表里**（源表那列是 filterUp 查找引用字段，
       钉钉接口整类不返回），由 scripts/fetch-openapi.js 从「11.店铺负责人」
       按平台派生。所以它可能缺席 —— 缺席时本页会显式提示，不静默显示成「—」。
   ============================================================ */
(function () {
  'use strict';

  var esc = Portal.esc;

  /* ── 主题色（与 css/portal.css 的 :root 对齐）──────────── */
  var C = {
    green: '#00ffa3', blue: '#00c8ff', pink: '#ff5ec9',
    text: '#eef0ff', dim: '#a79fc4', mute: '#6f6790',
    border: '#2a2040', card: '#120b1f', elev: '#1a1230'
  };
  var PALETTE = [C.green, C.blue, C.pink, '#ffd166', '#a06bff',
                 '#00e0b0', '#ff8f5e', '#5ea9ff', '#ff6b8a', '#7ef0c8', '#c9a0ff'];

  /* ── 工具 ──────────────────────────────────────────────── */
  function num(v) { var n = Number(v); return isNaN(n) ? 0 : n; }
  function fmtMoney(v) {
    var n = Number(v);
    if (isNaN(n)) return '—';
    return '¥' + n.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
  }
  function fmtInt(v) {
    var n = Number(v);
    if (isNaN(n)) return '—';
    return n.toLocaleString('zh-CN');
  }
  function fmtPct(v) {
    var n = Number(v);
    if (isNaN(n)) return '—';
    return (n * 100).toFixed(2) + '%';
  }
  function compact(v) {
    var n = Number(v) || 0;
    if (n >= 1e8) return (n / 1e8).toFixed(2) + '亿';
    if (n >= 1e4) return (n / 1e4).toFixed(1) + '万';
    return String(Math.round(n));
  }

  /* 图④ 的 y 轴标签：以「负责人」领衔（那块的标题就是「各负责人 GMV 与净利润」），
     负责人缺席时退回原先的「平台 · 区域」，旧快照也不会出现空标签。
     ⚠️ 手动截断，不用 axisLabel.overflow —— 免得依赖 echarts 版本。
     ⚠️ perf 表一行 = 一个平台（同平台可能有两行，如 淘宝/Amazon），
        所以 `负责人 · 平台` 重复是数据本身如此，不是标签拼错。 */
  function perfAxisLabel(r) {
    var pf = r['平台'] || '—';
    var who = r['负责人'];
    var s = who ? (who + ' · ' + pf) : (pf + (r['区域'] ? ' · ' + r['区域'] : ''));
    return s.length > 20 ? s.slice(0, 20) + '…' : s;
  }

  /* ── 钻取链接（唯一入口，别在调用点各写各的）───────────────
     ⚠️ 必须用 Site.url() 拼成「站内绝对路径」。
     本页 <base href="/team-portal/">，若裸写相对路径 `tables.html`，
     浏览器会解析成 `/team-portal/tables.html` —— 少一层 `pages/`，必然 404。
     全站其它跳转（auth.js / portal.js / landing.js）都走 Site.url()，这里是原先漏掉的三处。
     本函数返回的是**未做 HTML 转义的普通 URL**（含裸 `&`），
     放进 href / data-href 属性时浏览器对 `&q=` 这种非实体写法按字面解析，与改前行为一致。 */
  function tableUrl(key, q) {
    var u = 'pages/tables.html?table=' + encodeURIComponent(key);
    if (q) u += '&q=' + encodeURIComponent(q);
    return (window.Site && typeof Site.url === 'function') ? Site.url(u) : u;
  }

  var charts = [];
  function mountChart(id) {
    var el = document.getElementById(id);
    if (!el || typeof echarts === 'undefined') return null;
    var c = echarts.init(el, null, { renderer: 'canvas' });
    charts.push(c);
    return c;
  }
  window.addEventListener('resize', function () {
    charts.forEach(function (c) { try { c.resize(); } catch (e) {} });
  });

  function tooltipBase() {
    return {
      backgroundColor: 'rgba(18,11,31,.96)',
      borderColor: C.border,
      borderWidth: 1,
      textStyle: { color: C.text, fontSize: 12 },
      extraCssText: 'box-shadow:0 4px 24px rgba(0,0,0,.5);border-radius:8px'
    };
  }
  function axisBase() {
    return {
      axisLine: { lineStyle: { color: C.border } },
      axisTick: { show: false },
      axisLabel: { color: C.dim, fontSize: 11 },
      splitLine: { lineStyle: { color: 'rgba(42,32,64,.55)', type: 'dashed' } }
    };
  }

  /* ── 主流程 ────────────────────────────────────────────── */
  Portal.boot({ title: '团队门户' }).then(function (u) {
    if (!u) return;

    API.get('/api/data/daily').then(function (res) {
      if (!res.ok || res.empty) {
        document.getElementById('coreStats').innerHTML =
          '<div class="empty"><div class="icon">📭</div><div>' +
          esc(res.message || '暂无数据') + '</div></div>';
        ['storeRows', 'perfRows'].forEach(function (id) {
          document.getElementById(id).innerHTML =
            '<tr><td colspan="7" class="loading">暂无数据</td></tr>';
        });
        document.getElementById('dataNote').textContent = '尚无数据快照。';
        return;
      }

      var D = res.data;
      var tables = D.tables || [];
      var byKey = function (k) {
        return tables.filter(function (t) { return t.key === k; })[0] || { rows: [] };
      };

      document.getElementById('srcBox').style.display = '';
      document.getElementById('srcName').textContent = D.source;
      /* 新鲜度用 fetchedAt（UTC ISO）算，展示用 fetchedAtLocal（北京字符串）—— 两者不可互替 */
      document.getElementById('srcTime').innerHTML =
        '最近同步：' + Portal.esc(D.fetchedAtLocal) + ' ' + Portal.freshnessTag(D.fetchedAt);

      /* ============ 1. 分店铺聚合（口径：国内 + 跨境） ============ */
      var agg = { domGmv: 0, domOrders: 0, domUv: 0, crossGmv: 0, crossOrders: 0, crossUv: 0, fee: 0 };
      var stores = {};
      var byDate = {};          // 日期 → {dom, cross}
      var platformGmv = {};

      ['domestic', 'crossborder'].forEach(function (key) {
        var isDom = key === 'domestic';
        byKey(key).rows.forEach(function (r) {
          var gmv = num(r['全店GMV']);
          var orders = num(r['订单量']);
          var uv = num(r['UV']);
          agg.fee += num(r['推广费']);
          if (isDom) { agg.domGmv += gmv; agg.domOrders += orders; agg.domUv += uv; }
          else { agg.crossGmv += gmv; agg.crossOrders += orders; agg.crossUv += uv; }

          if (gmv <= 0) return;


          var dt = r['日期'] || '';
          if (dt) {
            if (!byDate[dt]) byDate[dt] = { dom: 0, cross: 0 };
            byDate[dt][isDom ? 'dom' : 'cross'] += gmv;
          }

          var name = r['店铺名'];
          if (name) {
            if (!stores[name]) stores[name] = { name: name, platform: r['平台'] || '', gmv: 0, orders: 0, uv: 0, fee: 0, conv: null, tableKey: key };
            stores[name].gmv += gmv;
            stores[name].orders += orders;
            stores[name].uv += uv;
            stores[name].fee += num(r['推广费']);
            if (r['转化率'] != null && r['转化率'] !== '') stores[name].conv = r['转化率'];
          }

          var pf = r['平台'] || '未知';
          platformGmv[pf] = (platformGmv[pf] || 0) + gmv;
        });
      });

      var storeList = Object.keys(stores).map(function (k) { return stores[k]; })
        .sort(function (a, b) { return b.gmv - a.gmv; });

      /* ============ 2. 核心指标卡 ============ */
      var totalGmv = agg.domGmv + agg.crossGmv;
      var cards = [
        { label: '全公司 GMV（累计）', value: fmtMoney(totalGmv), sub: '国内 + 跨境' },
        { label: '全公司订单量', value: fmtInt(agg.domOrders + agg.crossOrders), sub: '已录入明细合计' },
        { label: '跨境 GMV', value: fmtMoney(agg.crossGmv), sub: totalGmv ? (agg.crossGmv / totalGmv * 100).toFixed(1) + '% 占比' : '—' },
        { label: '国内 GMV', value: fmtMoney(agg.domGmv), sub: totalGmv ? (agg.domGmv / totalGmv * 100).toFixed(1) + '% 占比' : '—' },
        { label: '推广费', value: fmtMoney(agg.fee), sub: totalGmv ? '费比 ' + (agg.fee / totalGmv * 100).toFixed(2) + '%' : '—' },
        { label: 'UV', value: fmtInt(agg.domUv + agg.crossUv), sub: '已录入明细合计' }
      ];
      document.getElementById('coreStats').innerHTML = cards.map(function (c) {
        return '<a class="stat stat-link" href="' + tableUrl('domestic') + '" title="点击查看分店铺明细">' +
          '<div class="label">' + c.label + '</div>' +
          '<div class="value">' + c.value + '</div>' +
          '<div class="stat-sub">' + c.sub + '</div></a>';
      }).join('');

      /* ============ 3. 数据完整性提示 ============ */
      var dates = Object.keys(byDate).sort();
      var dropped = num(D.droppedEmptyRowsTotal);
      /* 未出图的表：优先读快照里的 emptyTables；旧快照没这个字段时按「表内零行」兜底推导。
         列表随抓取结果自动更新，不在前端硬编码表名。 */
      var empties = (D.emptyTables || []).map(function (t) { return t.name; });
      if (!empties.length && D.tables) {
        empties = D.tables.filter(function (t) {
          return !(t && t.rows && t.rows.length) && !t.error;
        }).map(function (t) { return t.name; });
      }
      var emptyNote = empties.length
        ? '<span class="muted">另有 <b>' + empties.length + '</b> 张表当前仅有占位行、数值字段尚未录入，故未出图：' +
          empties.join('、') + '。</span> '
        : '';
      document.getElementById('dataNote').innerHTML =
        '保留 <b>' + fmtInt(D.totalRows) + '</b> 条有效记录（扫描 ' + fmtInt(D.rawRowsTotal || D.totalRows) +
        ' 行' + (dropped ? '，已过滤 <b>' + fmtInt(dropped) + '</b> 行空白模板行' : '') + '）· ' +
        '分店铺明细覆盖 <b>' + dates.length + '</b> 个日期' +
        (dates.length ? '（' + dates[0] + ' – ' + dates[dates.length - 1] + '）' : '') +
        '、<b>' + storeList.length + '</b> 家店铺。' +
        emptyNote +
        (D.complete === false ? '<span class="muted">⚠ 本次抓取有表触及扫描上限（' + (D.truncatedTables || []).join('、') + '），数据可能不完整。</span>' : '');

      /* ============ 4. 图① 日 GMV 趋势 ============ */
      var cTrend = mountChart('chartTrend');
      if (cTrend) {
        var dts = dates.slice(-30);
        cTrend.setOption({
          color: [C.green, C.blue],
          tooltip: Object.assign({ trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: C.border } },
            valueFormatter: function (v) { return fmtMoney(v); },
            formatter: function (ps) {
              var s = '<b>' + ps[0].axisValue + '</b>';
              var tot = 0;
              ps.forEach(function (p) { s += '<br/>' + p.marker + p.seriesName + ' ' + fmtMoney(p.value); tot += num(p.value); });
              return s + '<br/><span style="color:' + C.mute + '">合计 ' + fmtMoney(tot) + '</span>';
            } }, tooltipBase()),
          legend: { data: ['国内', '跨境'], textStyle: { color: C.dim }, top: 4, right: 8, icon: 'roundRect', itemWidth: 12, itemHeight: 6 },
          grid: { left: 8, right: 14, top: 42, bottom: 6, containLabel: true },
          xAxis: Object.assign({ type: 'category', boundaryGap: false, data: dts }, axisBase()),
          yAxis: Object.assign({ type: 'value', axisLabel: { color: C.dim, fontSize: 11, formatter: compact } }, axisBase()),
          series: [
            { name: '国内', type: 'line', smooth: true, symbol: 'circle', symbolSize: 5,
              lineStyle: { width: 2 }, itemStyle: { color: C.green },
              areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                { offset: 0, color: 'rgba(0,255,163,.28)' }, { offset: 1, color: 'rgba(0,255,163,0)' }]) },
              data: dts.map(function (d) { return byDate[d].dom; }) },
            { name: '跨境', type: 'line', smooth: true, symbol: 'circle', symbolSize: 5,
              lineStyle: { width: 2 }, itemStyle: { color: C.blue },
              areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                { offset: 0, color: 'rgba(0,200,255,.28)' }, { offset: 1, color: 'rgba(0,200,255,0)' }]) },
              data: dts.map(function (d) { return byDate[d].cross; }) }
          ]
        });
      }

      /* ============ 5. 图② 分店铺 GMV Top10 ============ */
      var cStore = mountChart('chartStore');
      if (cStore) {
        var top = storeList.slice(0, 10).slice().reverse();
        cStore.setOption({
          tooltip: Object.assign({ trigger: 'axis', axisPointer: { type: 'shadow' },
            formatter: function (ps) {
              var p = ps[0];
              var s = storeList.filter(function (x) { return x.name === p.name; })[0] || {};
              return '<b>' + p.name + '</b><br/>' + p.marker + 'GMV ' + fmtMoney(p.value) +
                '<br/><span style="color:' + C.mute + '">' + esc(s.platform || '') + ' · 订单 ' +
                fmtInt(s.orders) + ' · UV ' + fmtInt(s.uv) + '</span>';
            } }, tooltipBase()),
          grid: { left: 8, right: 60, top: 10, bottom: 6, containLabel: true },
          // 店铺间量级差异极大（头部 30 万 vs 尾部几百），线性轴下小条不可见 → 用对数刻度
          xAxis: Object.assign({ type: 'log', min: 100,
            axisLabel: { color: C.dim, fontSize: 11, formatter: compact } }, axisBase()),
          yAxis: Object.assign({ type: 'category',
            data: top.map(function (s) { return s.name.length > 14 ? s.name.slice(0, 14) + '…' : s.name; }),
            axisLabel: { color: C.dim, fontSize: 11 } }, axisBase(), { splitLine: { show: false } }),
          series: [{
            type: 'bar', barWidth: '58%',
            itemStyle: { borderRadius: [0, 6, 6, 0],
              color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
                { offset: 0, color: 'rgba(0,200,255,.45)' }, { offset: 1, color: C.green }]) },
            label: { show: true, position: 'right', color: C.text, fontSize: 11, formatter: function (p) { return compact(p.value); } },
            data: top.map(function (s) { return s.gmv; })
          }]
        });
      }

      /* ============ 6. 图③ 平台 GMV 占比 ============ */
      var cPf = mountChart('chartPlatform');
      if (cPf) {
        var pfList = Object.keys(platformGmv).map(function (k) { return { name: k, value: platformGmv[k] }; })
          .sort(function (a, b) { return b.value - a.value; });
        cPf.setOption({
          color: PALETTE,
          tooltip: Object.assign({ trigger: 'item',
            formatter: function (p) { return '<b>' + p.name + '</b><br/>' + fmtMoney(p.value) + '（' + p.percent + '%）'; } },
            tooltipBase()),
          legend: { type: 'scroll', orient: 'vertical', right: 4, top: 'middle',
            textStyle: { color: C.dim, fontSize: 11 }, itemWidth: 10, itemHeight: 10,
            formatter: function (n) { return n.length > 10 ? n.slice(0, 10) + '…' : n; } },
          series: [{
            type: 'pie', radius: ['46%', '70%'], center: ['36%', '52%'],
            avoidLabelOverlap: true, padAngle: 2,
            itemStyle: { borderColor: C.card, borderWidth: 2 },
            label: { show: false }, labelLine: { show: false },
            emphasis: { scale: true, scaleSize: 6, label: { show: true, color: C.text, fontSize: 12, fontWeight: 'bold', formatter: '{b}\n{d}%' } },
            data: pfList
          }]
        });
      }

      /* ============ 7. 图④ 负责人业绩（perf 口径） ============ */
      var perfRows = byKey('perf').rows.filter(function (r) { return num(r['GMV']) > 0; })
        .sort(function (a, b) { return num(b['GMV']) - num(a['GMV']); });
      var perfGmv = perfRows.reduce(function (s, r) { return s + num(r['GMV']); }, 0);
      var perfProfit = perfRows.reduce(function (s, r) { return s + num(r['净利润']); }, 0);

      /* perf 行的「负责人」是抓取侧从「11.店铺负责人」按平台派生出来的
         （见 scripts/fetch-openapi.js 的 deriveOwners —— 源表那一列是 filterUp
         查找引用字段，钉钉接口整类不返回）。所以它**可能缺席**：旧快照、或
         抓取时对照表失败。缺席时这里必须说明白，不能让用户对着一列「—」猜。 */
      var ownerColMissing = perfRows.length > 0 && !perfRows.some(function (r) { return r['负责人']; });
      var ownerMissingHint = ownerColMissing
        ? '<span class="muted">⚠ 本快照未含「负责人」列：该列在源表里是查找引用字段，钉钉接口不返回，' +
          '由抓取时从「11.店铺负责人」按平台派生 —— 等下一次抓取跑完即可恢复。</span>'
        : '';

      document.getElementById('perfSummary').innerHTML = perfRows.length
        ? '共 <b>' + perfRows.length + '</b> 条负责人业绩 · GMV 合计 <b>' + fmtMoney(perfGmv) +
          '</b> · 净利润合计 <b>' + fmtMoney(perfProfit) + '</b> · 综合利润率 <b>' +
          (perfGmv ? (perfProfit / perfGmv * 100).toFixed(1) : '—') + '%</b>' +
          '<span class="muted">（负责人认领口径，与上方分店铺口径不可直接相加）</span>' +
          ownerMissingHint
        : '暂无负责人业绩数据';

      var cPerf = mountChart('chartPerf');
      if (cPerf && perfRows.length) {
        var p10 = perfRows.slice(0, 10).slice().reverse();
        cPerf.setOption({
          color: [C.pink, C.green],
          tooltip: Object.assign({ trigger: 'axis', axisPointer: { type: 'shadow' },
            formatter: function (ps) {
              var r = p10[ps[0].dataIndex] || {};
              var s = '<b>' + esc(r['平台'] || '—') + (r['区域'] ? ' · ' + esc(r['区域']) : '') + '</b>';
              s += '<br/><span style="color:' + C.dim + '">负责人：' +
                (r['负责人'] ? esc(r['负责人']) : '未配置') + '</span>';
              ps.forEach(function (p) { s += '<br/>' + p.marker + p.seriesName + ' ' + fmtMoney(p.value); });
              return s;
            } }, tooltipBase()),
          legend: { data: ['GMV', '净利润'], textStyle: { color: C.dim }, top: 4, right: 8, icon: 'roundRect', itemWidth: 12, itemHeight: 6 },
          grid: { left: 8, right: 14, top: 42, bottom: 6, containLabel: true },
          xAxis: Object.assign({ type: 'value', axisLabel: { color: C.dim, fontSize: 11, formatter: compact } }, axisBase()),
          yAxis: Object.assign({ type: 'category',
            data: p10.map(perfAxisLabel),
            axisLabel: { color: C.dim, fontSize: 11 } }, axisBase(), { splitLine: { show: false } }),
          series: [
            { name: 'GMV', type: 'bar', barWidth: '30%', itemStyle: { borderRadius: [0, 4, 4, 0] },
              data: p10.map(function (r) { return num(r['GMV']); }) },
            { name: '净利润', type: 'bar', barWidth: '30%', itemStyle: { borderRadius: [0, 4, 4, 0] },
              data: p10.map(function (r) { return num(r['净利润']); }) }
          ]
        });
      }

      /* ============ 8. 表格：分店铺排名 ============ */
      var storeTb = document.getElementById('storeRows');
      storeTb.innerHTML = storeList.length
        ? storeList.slice(0, 20).map(function (s, i) {
            return '<tr class="row-click" data-href="' + tableUrl(s.tableKey, s.name) + '" title="点击查看该店铺明细">' +
              '<td class="mono muted">' + (i + 1) + '</td>' +
              '<td><strong>' + esc(s.name) + '</strong></td>' +
              '<td><span class="tag tag-blue">' + esc(s.platform) + '</span></td>' +
              '<td class="num">' + fmtMoney(s.gmv) + '</td>' +
              '<td class="num">' + fmtInt(s.orders) + '</td>' +
              '<td class="num">' + fmtInt(s.uv) + '</td>' +
              '<td class="num">' + fmtPct(s.conv) + '</td></tr>';
          }).join('')
        : '<tr><td colspan="7" class="loading">暂无分店铺数据</td></tr>';

      /* ============ 9. 表格：负责人业绩 ============ */
      var perfTb = document.getElementById('perfRows');
      perfTb.innerHTML = perfRows.length
        ? perfRows.map(function (r) {
            return '<tr class="row-click" data-href="' + tableUrl('perf', r['负责人'] || '') + '" title="点击查看该负责人业绩明细">' +
              '<td><strong>' + esc(r['负责人'] || '—') + '</strong></td>' +
              '<td><span class="tag tag-green">' + esc(r['平台'] || '—') + '</span></td>' +
              '<td class="num">' + fmtMoney(r['GMV']) + '</td>' +
              '<td class="num">' + fmtMoney(r['净利润']) + '</td>' +
              '<td class="num">' + (r['利润率'] != null ? esc(r['利润率']) + '%' : '—') + '</td>' +
              '<td class="num">' + fmtMoney(r['客单价']) + '</td>' +
              '<td class="num">' + (r['认领成单率'] != null ? esc(r['认领成单率']) + '%' : '—') + '</td></tr>';
          }).join('')
        : '<tr><td colspan="7" class="loading">暂无负责人业绩数据</td></tr>';

      /* ============ 10. 行点击钻取 ============ */
      ['storeRows', 'perfRows'].forEach(function (id) {
        document.getElementById(id).addEventListener('click', function (e) {
          var tr = e.target.closest('tr.row-click');
          if (tr && tr.dataset.href) location.href = tr.dataset.href;
        });
      });
    });
  });
})();
