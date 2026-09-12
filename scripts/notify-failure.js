#!/usr/bin/env node
/* ============================================================
   notify-failure.js —— 抓取失败时，推一条钉钉群机器人消息

   为什么需要：
     fetch.yml 的两条定时任务跑在 GitHub 的机器上，失败只体现为
     Actions 页面里的一个红叉 —— 没有任何人会天天去看。
     于是「数据悄悄停止更新」，而门户页面上照旧写着上次的同步时间，
     看上去一切正常。（这和同期加「⚠ 数据已过期」标签是同一个起因。）

   ⚠️ 它兜不住的情况（别指望它，这几条是页面标签负责的）：
     ① **压根没跑** —— GitHub 官方说明 schedule 在负载高峰可能被延迟甚至跳过；
        被跳过时不会有 run，也就不会有失败通知。这个场景由门户页面的
        「⚠ 数据已过期」标签兜住（见 js/portal.js 的 freshness）。
     ② workflow 文件本身语法错误 —— job 起不来，任何 step 都不会执行。
     ③ 抓取「成功」但数据其实是错的（上游改了字段名之类）—— 通知只看退出码。
     ⇒ 这个脚本与页面标签是**互补**关系，不是二选一。

   环境变量：
     DINGTALK_ROBOT_WEBHOOK  钉钉群「自定义机器人」的 Webhook（配在 GitHub Secret）
     其余读 GITHUB_* 自动变量，用来拼日志链接。

   用法：
     node scripts/notify-failure.js               # 真发
     node scripts/notify-failure.js --dry-run     # 只打印要发的 body，不发（本地/回归用）

   ⚠️ 本脚本退出码恒为 0。通知是**附加动作**：发不出去不该把 job 再弄红一次，
      否则真正的原因（抓取那一步的日志）会被淹没在第二个红叉里。
   ============================================================ */
'use strict';

const https = require('https');
const http = require('http');

/* 必须与钉钉机器人「安全设置 → 自定义关键词」里填的那个词一字不差。
   机器人会直接拒收不含关键词的消息（返回 errcode 310000），
   所以下面 buildText() 的第一行必须含它。 */
const KEYWORD = '日报抓取';

const WEBHOOK = process.env.DINGTALK_ROBOT_WEBHOOK || '';
const DRY = process.argv.indexOf('--dry-run') !== -1;

function beijing() {
  /* 和 scripts/fetch-openapi.js 同一个坑：runner 的本地时区是 UTC，
     toLocaleString 不带 timeZone 会写成比北京时间早 8 小时的时间。 */
  return new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' });
}

function buildText() {
  const server = process.env.GITHUB_SERVER_URL || 'https://github.com';
  const repo = process.env.GITHUB_REPOSITORY || '';
  const runId = process.env.GITHUB_RUN_ID || '';
  const runUrl = runId
    ? server + '/' + repo + '/actions/runs/' + runId
    : server + '/' + repo + '/actions';
  const ev = process.env.GITHUB_EVENT_NAME || '';
  const when = ev === 'schedule' ? '定时（每日 11:00 / 17:00 北京时间）'
    : ev === 'workflow_dispatch' ? '手动触发'
      : (ev || '未知');
  return [
    '【' + KEYWORD + '失败】',
    '时间：' + beijing() + '（北京时间）',
    '任务：' + (process.env.GITHUB_WORKFLOW || '钉钉日报数据抓取'),
    '触发：' + when,
    '日志：' + runUrl,
    '影响：门户「日报数据」等页面会停在上一版，并显示「⚠ 数据已过期」。',
    '处置：点上面日志链接查原因；修好后到 Actions 页点 Run workflow 手动补抓一次。'
  ].join('\n');
}

function postJson(url, body) {
  return new Promise(function (resolve) {
    let u;
    try { u = new URL(url); }
    catch (e) { return resolve({ status: 0, body: 'Webhook 地址不合法：' + String(url).slice(0, 40) }); }
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({
      method: 'POST',
      hostname: u.hostname,
      port: u.port || undefined,
      path: u.pathname + u.search,
      headers: {
        'Content-Type': 'application/json;charset=utf-8',
        'Content-Length': Buffer.byteLength(body)
      }
    }, function (res) {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', function (c) { d += c; });
      res.on('end', function () { resolve({ status: res.statusCode, body: d }); });
    });
    req.on('error', function (e) { resolve({ status: 0, body: e.message }); });
    req.setTimeout(15000, function () { req.destroy(); resolve({ status: 0, body: '请求超时（15s）' }); });
    req.end(body);
  });
}

/* 钉钉即使 HTTP 200 也可能在 body 里报错（errcode != 0），所以要看 errcode。 */
function dingResult(r) {
  if (r.status < 200 || r.status >= 300) {
    return { ok: false, why: 'HTTP ' + r.status + ' ' + String(r.body).slice(0, 200) };
  }
  try {
    const j = JSON.parse(r.body);
    if (j.errcode === 0) return { ok: true, why: 'errcode=0' };
    return { ok: false, why: 'errcode=' + j.errcode + ' ' + (j.errmsg || '') };
  } catch (e) {
    return { ok: true, why: 'HTTP ' + r.status + '（响应非 JSON，按成功处理）' };
  }
}

(async function () {
  const content = buildText();
  const payload = JSON.stringify({ msgtype: 'text', text: { content: content } });

  /* 自检：正文不含关键词的话钉钉一定拒收。提前拦下，比发一次、再对着
     errcode 310000 回头猜原因要省事。 */
  if (content.indexOf(KEYWORD) === -1) {
    console.log('::warning::通知正文没包含关键词「' + KEYWORD + '」，钉钉会拒收，已跳过。');
    return;
  }

  if (DRY) {
    console.log('[dry-run] 不发送，仅打印将 POST 的 body：');
    console.log(payload);
    return;
  }

  if (!WEBHOOK) {
    console.log('::warning::未配置 DINGTALK_ROBOT_WEBHOOK，跳过钉钉失败通知。');
    console.log('配置方法：仓库 Settings → Secrets and variables → Actions → New repository secret');
    console.log('  Name  = DINGTALK_ROBOT_WEBHOOK');
    console.log('  Value = 钉钉群 → 群设置 → 智能群助手 → 添加机器人 → 自定义 → Webhook 地址');
    console.log('  安全设置选「自定义关键词」，关键词填：' + KEYWORD);
    return;
  }

  const r = await postJson(WEBHOOK, payload);
  const v = dingResult(r);
  if (v.ok) {
    console.log('钉钉失败通知已发出（' + v.why + '）');
    return;
  }
  console.log('::warning::钉钉失败通知未发出 —— ' + v.why);
  if (String(v.why).indexOf('310000') !== -1) {
    console.log('  errcode 310000 = 关键词不匹配：机器人「安全设置」里的关键词必须出现在通知正文中，应填「'
      + KEYWORD + '」。');
  }
})().catch(function (e) {
  console.log('::warning::通知脚本异常（不影响原始失败原因）：' + (e && e.message));
});
