#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""只走 api.github.com 取远端分支头，并在本地重建同 SHA 的 commit 对象。

用途：`git fetch` 打不通 github.com:443 时，让本地仍能对齐远端。
      由 tools/sync-local.sh 自动调用，也可单独用：

    python tools/fetch-remote-commit.py            # 打印远端 main 的 SHA
    python tools/fetch-remote-commit.py --check    # 只打印，不写对象

原理：API 创建的 commit 本地没有该对象，`git reset <sha>` 会报
      "Could not parse object"。这里用 API 返回的 tree/parent/author/时间/message
      在本地重算 commit 对象并落盘，SHA 与远端逐位相同 —— 于是 git reset 可用。

      补齐是**按需**的：从目标 commit 逐级上溯，缺哪个 commit/blob/tree 就取哪个，
      直到整条链在本地完整。不做整仓下载。

⚠️ 每次运行都会走一遍链校验（即使目标 commit 已存在），因为「目标在、父提交缺」
   的断链会让 `git log` 静默空输出。已在本地完整的部分只读本地对象，几乎零成本。

依赖：仅标准库 + api.github.com；token 从系统凭据管理器（git credential）读取。
"""
from __future__ import print_function

import argparse
import base64
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

DEFAULT_REPO = "alextok200-boop/team-portal"
DEFAULT_BRANCH = "main"
API = "https://api.github.com"

# 由 main() 按 --repo 覆盖；下面的辅助函数直接引用它
REPO = DEFAULT_REPO


def run(args, cwd=None, stdin=None, env=None):
    return subprocess.run(args, cwd=cwd, input=stdin, capture_output=True,
                          text=True, encoding="utf-8", env=env)


def repo_root():
    p = run(["git", "rev-parse", "--show-toplevel"])
    if p.returncode != 0:
        raise SystemExit("当前目录不是 git 仓库")
    return p.stdout.strip()


def get_token():
    """从系统凭据管理器取 GitHub token（不落盘、不打印）。"""
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0", GCM_INTERACTIVE="never")
    p = run(["git", "credential", "fill"],
            stdin="protocol=https\nhost=github.com\n\n", env=env)
    for line in p.stdout.splitlines():
        if line.startswith("password="):
            return line[len("password="):]
    raise SystemExit("凭据管理器里没有 github.com 凭据，无法走 API 兜底")


def api_get(path, token, attempts=4):
    """GET api.github.com。网络抖动/传输被截断时退避重试（实测 1MB+ blob 会 IncompleteRead）。"""
    last = None
    for i in range(attempts):
        req = urllib.request.Request(
            API + path,
            headers={"Authorization": "Bearer " + token,
                     "Accept": "application/vnd.github+json",
                     "X-GitHub-Api-Version": "2022-11-28",
                     "User-Agent": "workbuddy-sync-helper"})
        try:
            with urllib.request.urlopen(req, timeout=90) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            body = e.read().decode("utf-8", "replace")[:200]
            if e.code in (429, 500, 502, 503, 504) and i < attempts - 1:
                last = "HTTP %s" % e.code
            else:
                raise SystemExit("api.github.com 返回 %s：%s" % (e.code, body))
        except Exception as e:
            last = str(e)
        if i < attempts - 1:
            time.sleep(1.5 * (i + 1))
    raise SystemExit("api.github.com 不可达（%s）。先解决网络再试。" % last)


def object_exists(root, sha):
    return run(["git", "cat-file", "-e", sha], cwd=root).returncode == 0


def write_object(root, obj_type, body):
    """把对象的原始字节写进本地库，返回算出的 SHA。

    ⚠️ 必须传 bytes 且不用 text=True：Windows 下文本模式会把 \\n 翻成 \\r\\n，
    悄悄改坏内容，导致 SHA 永远对不上（实测踩坑）。

    必须检查退出码：git 在拒绝非法对象时只往 stderr 报错、stdout 为空，
    不查就会变成「得到 空」这种看不出原因的报错（实测踩坑）。
    """
    p = subprocess.run(["git", "hash-object", "-t", obj_type, "-w", "--stdin"],
                       cwd=root, input=body, capture_output=True)
    if p.returncode != 0:
        raise SystemExit("写入 %s 对象被 git 拒绝：%s"
                         % (obj_type, p.stderr.decode("utf-8", "replace").strip()))
    return p.stdout.decode("utf-8").strip()


def ensure_blob(root, sha, token, stats):
    """本地缺这个 blob 时，从 API 取 base64 内容写回本地。"""
    if object_exists(root, sha):
        return
    info = api_get("/repos/%s/git/blobs/%s" % (REPO, sha), token)
    raw = base64.b64decode(info["content"])
    got = write_object(root, "blob", raw)
    if got != sha:
        raise SystemExit("blob 重建失败：期望 %s 得到 %s" % (sha[:8], got[:8]))
    stats["blobs"] += 1


def ensure_tree(root, sha, token, stats, seen=None):
    """递归补齐树对象（及其子树/子 blob）。GitHub 的 trees 接口一次只给一层。"""
    seen = seen if seen is not None else set()
    if sha in seen or object_exists(root, sha):
        return
    seen.add(sha)
    data = api_get("/repos/%s/git/trees/%s" % (REPO, sha), token)
    entries = []
    for e in data.get("tree", []):
        if e["type"] == "tree":
            ensure_tree(root, e["sha"], token, stats, seen)
        elif e["type"] == "blob":
            ensure_blob(root, e["sha"], token, stats)
        # commit（submodule）：直接引用 sha，无需本地对象
        #
        # ⚠️ 模式串必须去零填充：GitHub API 返回 "040000"，而 git 树的规范格式是 "40000"。
        #    原样写回会被 git 判为 zeroPaddedFilemode 而拒绝（fsck 不过）—— 实测踩坑。
        mode = e["mode"].lstrip("0") or "0"
        raw = bytes.fromhex(e["sha"])
        entries.append((mode, e["path"], raw))

    # git 的树对象排序：tree 条目按「名字+/」参与比较
    entries.sort(key=lambda x: (x[1] + "/") if x[0] == "40000" else x[1])
    body = b""
    for mode, name, raw in entries:
        body += mode.encode() + b" " + name.encode("utf-8") + b"\x00" + raw
    got = write_object(root, "tree", body)
    if got != sha:
        raise SystemExit("tree 重建失败：期望 %s 得到 %s" % (sha[:8], got[:8]))
    stats["trees"] += 1


def hash_commit(root, body, write=False):
    """把 commit 正文喂给 git hash-object（走 bytes，理由见 write_object）。"""
    args = ["git", "hash-object", "-t", "commit"] + (["-w"] if write else []) + ["--stdin"]
    p = subprocess.run(args, cwd=root, input=body.encode("utf-8"), capture_output=True)
    return p.stdout.decode("utf-8").strip()


def rebuild_commit(root, d, sha, token, stats):
    """穷举时区/尾部换行组合，重算出与远端逐位相同的 commit 对象并落盘。

    注意 d 需要同时含「commit 子对象」和「顶层 parents」：
      /repos/{r}/commits/{ref} 的 tree/author/committer/message 在 commit 子对象里，
      而 parents 在**顶层** —— 这个不对称是实测踩过的坑，故由 main() 归一化后传入。

    远端新提交常带有本地没有的 tree/blob（典型：Actions 自动提交的数据更新）。
    这些按需从 API 补齐后再重建 commit，否则 git reset 会报 Could not parse object。
    """
    tree = d["tree"]["sha"]
    parents = d.get("parents") or []
    parent = parents[0]["sha"] if parents else None

    ensure_tree(root, tree, token, stats)   # 需要哪个对象就补哪个，不整仓下载

    p = run(["date", "-u", "-d", d["author"]["date"], "+%s"])
    ts = p.stdout.strip()
    if not ts.isdigit():
        # BSD/macOS 的 date 不支持 -d
        p = run(["date", "-u", "-j", "-f", "%Y-%m-%dT%H:%M:%SZ", d["author"]["date"], "+%s"])
        ts = p.stdout.strip()
    if not ts.isdigit():
        raise SystemExit("无法把 %s 转成时间戳" % d["author"]["date"])

    # GitHub API 的 date 返回 ...Z，但 commit 对象里存的是作者本地时区（本机实测 +0800）。
    # 不猜，直接全量枚举 —— 60 次哈希计算成本可忽略。
    tzs = ["%+03d%02d" % (h, m)
           for h in range(-14, 15) for m in (0, 30, 45)]
    for tz in tzs:
        for msg in (d["message"], d["message"] + "\n"):
            body = ("tree %s\n%s"
                    "author %s <%s> %s %s\n"
                    "committer %s <%s> %s %s\n\n%s" % (
                        tree,
                        ("parent %s\n" % parent) if parent else "",
                        d["author"]["name"], d["author"]["email"], ts, tz,
                        d["committer"]["name"], d["committer"]["email"], ts, tz, msg))
            out = hash_commit(root, body)
            if out == sha:
                hash_commit(root, body, write=True)
                return tz
    raise SystemExit("重建失败：穷举时区/换行后 SHA 仍不匹配（远端可能用了其它时区）")


def local_parents(root, sha):
    """本地对象里读父提交（不打 API）；对象不存在返回 None。"""
    p = run(["git", "cat-file", "-p", sha], cwd=root)
    if p.returncode != 0:
        return None
    return [ln.split()[1] for ln in p.stdout.splitlines() if ln.startswith("parent ")]


def ensure_commit_chain(root, sha, token, stats, seen=None, max_commits=1000):
    """递归补齐 commit 及其祖先，直到整条链在本地区都完整。

    为什么必须补祖先：本工具生成的是 API 提交，本地原本没有该对象；
    若只补目标 commit 而不补它的父提交，`git reset --hard <sha>` 虽能成功，
    但历史链在此断开 —— `git log` 直接输出为空、`git pull` 也会报错。
    （实测踩坑：补齐 a66a9e12 后 git log 无任何输出。）

    ⚠️ 不能「目标已存在就整个跳过」：那样恰好漏掉「目标在、祖先缺」的断链
    （正是上面那个场景）。所以本地已有的 commit 也继续上溯，只是不必打 API
    —— 父提交从本地对象里读，成本极低。
    """
    seen = seen if seen is not None else set()
    stack = [sha]
    while stack:
        if len(seen) >= max_commits:
            raise SystemExit("上溯超过 %d 个提交，疑似历史异常，已中止" % max_commits)
        s = stack.pop()
        if s in seen:
            continue
        seen.add(s)
        parents = local_parents(root, s)
        if parents is not None:
            stack.extend(parents)          # 本地已有 → 继续上溯找断点
            continue
        info = api_get("/repos/%s/commits/%s" % (REPO, s), token)
        c = info["commit"]
        meta = {"tree": c["tree"], "author": c["author"], "committer": c["committer"],
                "message": c["message"], "parents": info.get("parents") or []}
        rebuild_commit(root, meta, s, token, stats)
        stats["commits"] = stats.get("commits", 0) + 1
        for p in meta["parents"]:
            stack.append(p["sha"])


def main():
    global REPO
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=DEFAULT_REPO)
    ap.add_argument("--branch", default=DEFAULT_BRANCH)
    ap.add_argument("--check", action="store_true", help="只打印，不写对象")
    args = ap.parse_args()
    REPO = args.repo

    root = repo_root()
    token = get_token()
    info = api_get("/repos/%s/commits/%s" % (args.repo, args.branch), token)
    sha = info["sha"]

    if args.check:
        print(sha)
        return

    # 注意：即使目标 commit 本地已存在，也要走一遍链校验 ——
    # 「目标在、父提交缺」的断链只有逐级上溯才能发现（git log 会因此空输出）。
    stats = {"blobs": 0, "trees": 0, "commits": 0}
    ensure_commit_chain(root, sha, token, stats)
    print(sha)
    if stats["commits"] or stats["blobs"] or stats["trees"]:
        print("# 已重建 commit 对象链（从 API 补齐 %d commit / %d blob / %d tree）"
              % (stats["commits"], stats["blobs"], stats["trees"]), file=sys.stderr)
    else:
        print("# 本地对象链已完整，无需补齐", file=sys.stderr)


if __name__ == "__main__":
    main()
