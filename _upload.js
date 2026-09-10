// 用 Git Data API 把 team-portal 全部文件上传到 GitHub（绕过 github.com:443 直连）
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = 'alextok200-boop/team-portal';
const API = 'https://api.github.com';

// 1. 从环境变量或 git credential 获取 token
let token = process.env.GH_TOKEN || '';
if (!token) {
  try {
    const out = execSync('printf "protocol=https\\nhost=github.com\\n\\n" | git credential fill', { shell: '/bin/bash' }).toString();
    const m = out.match(/password=(.+)/);
    token = m ? m[1].trim() : '';
  } catch (e) { }
}
if (!token) { console.error('未获取到 token'); process.exit(1); }

async function gh(method, url, body) {
  const r = await fetch(API + url, {
    method,
    headers: {
      'Authorization': 'token ' + token,
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'workbuddy-agent',
      'X-GitHub-Api-Version': '2022-11-28'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await r.text();
  let json; try { json = JSON.parse(text); } catch (e) { json = text; }
  if (r.status >= 400) throw new Error(method + ' ' + url + ' -> ' + r.status + ': ' + text.slice(0, 300));
  return json;
}

// 2. 收集文件（排除 .git）
const files = [];
(function walk(d, base) {
  for (const f of fs.readdirSync(d)) {
    if (f === '.git' || f === 'node_modules') continue;
    const abs = path.join(d, f);
    const st = fs.statSync(abs);
    if (st.isDirectory()) walk(abs, base);
    else files.push({ abs, rel: path.relative(base, abs).replace(/\\/g, '/') });
  }
})(process.cwd(), process.cwd());

console.log('共 ' + files.length + ' 个文件');

// 3. 逐个上传 blob（base64）
async function blobFor(abs) {
  const content = fs.readFileSync(abs).toString('base64');
  const r = await gh('POST', `/repos/${REPO}/git/blobs`, { content, encoding: 'base64' });
  return r.sha;
}

(async function main() {
  // 空仓库必须先通过 Contents API 创建第一个文件（隐式创建初始 commit + main 分支）
  console.log('创建初始文件（触发 main 分支）...');
  const initRes = await gh('PUT', `/repos/${REPO}/contents/.nojekyll`, {
    message: 'init',
    content: Buffer.from('').toString('base64'),
    branch: 'main'
  });
  const initCommitSha = (initRes.commit && initRes.commit.sha) || '';
  console.log('初始 commit:', initCommitSha, '\n');

  const tree = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    process.stdout.write('  [' + (i + 1) + '/' + files.length + '] ' + f.rel + ' ... ');
    const sha = await blobFor(f.abs);
    tree.push({ path: f.rel, mode: '100644', type: 'blob', sha });
    console.log('ok');
  }

  console.log('\n创建完整 tree ...');
  const treeRes = await gh('POST', `/repos/${REPO}/git/trees`, { tree });
  console.log('tree sha:', treeRes.sha);

  console.log('创建 commit ...');
  const commitRes = await gh('POST', `/repos/${REPO}/git/commits`, {
    message: '团队门户静态版 v1.0.0：GitHub Pages 部署（前端鉴权 + localStorage 用户/角色 + 日报数据快照）',
    tree: treeRes.sha,
    parents: [initCommitSha]
  });
  console.log('commit sha:', commitRes.sha);

  console.log('更新 ref refs/heads/main ...');
  await gh('PATCH', `/repos/${REPO}/git/refs/heads/main`, { sha: commitRes.sha, force: false });
  console.log('ref 更新成功');

  console.log('\n✅ 推送完成，仓库: https://github.com/' + REPO);
})().catch(function (e) {
  console.error('\n❌ 失败:', e.message);
  process.exit(1);
});
