#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
add-user.py —— 往共享账号名单 data/users.json 里加/改/删账号

为什么需要它：
  团队门户托管在 GitHub Pages（纯静态），浏览器没有服务端可写。
  管理后台里「新增用户」只会落在管理员那台电脑的 localStorage，
  同事在别的电脑上根本看不到。所以真正让账号全站生效的动作是——

     把账号写进仓库的 data/users.json 并部署。

  本脚本就是干这个的：算出 SHA-256、写进文件，你只要 commit + push。

用法：
  # 加人（已存在则改密/改角色）
  python tools/add-user.py --user zhangsan --pass konllen2026 --name 张三 --role member

  # 改密码 / 改角色（只传要改的）
  python tools/add-user.py --user zhangsan --pass newpass2026
  python tools/add-user.py --user zhangsan --role team_leader

  # 停用 / 启用
  python tools/add-user.py --user zhangsan --disable
  python tools/add-user.py --user zhangsan --enable

  # 删除（写进 deleted 列表，全站同步删除内置账号时用）
  python tools/add-user.py --del zhangsan

  # 看当前名单（不显示哈希）
  python tools/add-user.py --list

角色取值见 js/config/roles.js：admin / team_leader / member

⚠️ 本文件是「账号密码哈希」的落盘处。仓库若为公开仓库，
   passwordHash 会被所有人看到（SHA-256，不可逆但可离线爆破弱口令）。
   请用足够强的密码，不要用 123456 这类。
"""

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
DATA = os.path.join(ROOT, "data", "users.json")

USERNAME_RE = re.compile(r"^[A-Za-z0-9_.@-]{3,32}$")
MIN_PASS = 6


def now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.") + \
           "%03dZ" % (datetime.now(timezone.utc).microsecond // 1000)


def sha256_hex(s):
    return hashlib.sha256(s.encode("utf-8")).hexdigest()


def load():
    if not os.path.exists(DATA):
        return {"version": 1, "updatedAt": None, "note": "", "deleted": [], "users": []}
    with open(DATA, "r", encoding="utf-8") as f:
        d = json.load(f)
    d.setdefault("version", 1)
    d.setdefault("deleted", [])
    d.setdefault("users", [])
    return d


def save(d):
    d["updatedAt"] = now_iso()
    os.makedirs(os.path.dirname(DATA), exist_ok=True)
    with open(DATA, "w", encoding="utf-8", newline="\n") as f:
        json.dump(d, f, ensure_ascii=False, indent=2)
        f.write("\n")


def find(d, username):
    low = username.lower()
    for u in d["users"]:
        if str(u.get("username", "")).lower() == low:
            return u
    return None


def valid_roles():
    """从 roles.js 里读出可选角色，避免写错角色名。"""
    p = os.path.join(ROOT, "js", "config", "roles.js")
    try:
        with open(p, "r", encoding="utf-8") as f:
            txt = f.read()
        m = re.search(r"var\s+DEFAULT_ROLES\s*=\s*\{", txt)
        if not m:
            return None
        # 粗提取顶层 key（缩进 2 空格的 identifier: {）
        seg = txt[m.end():]
        roles = re.findall(r"^\s{2}([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\{", seg, re.M)
        return roles or None
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser(description="往 data/users.json 加/改/删账号")
    ap.add_argument("--user", help="账号")
    ap.add_argument("--pass", dest="password", help="密码（至少 6 位）")
    ap.add_argument("--name", help="姓名")
    ap.add_argument("--role", help="角色：admin / team_leader / member")
    ap.add_argument("--disable", action="store_true", help="停用该账号")
    ap.add_argument("--enable", action="store_true", help="启用该账号")
    ap.add_argument("--del", dest="delete", metavar="USERNAME", help="删除该账号（写进 deleted）")
    ap.add_argument("--list", action="store_true", help="列出当前名单")
    args = ap.parse_args()

    d = load()

    if args.list:
        print("文件：%s" % DATA)
        print("更新：%s" % (d.get("updatedAt") or "-"))
        if d["deleted"]:
            print("已删除：%s" % ", ".join(d["deleted"]))
        if not d["users"]:
            print("共享名单为空（源码内置的 admin / leader / member 不在此文件里）")
        else:
            print("%-16s %-10s %-14s %-6s %s" % ("账号", "姓名", "角色", "状态", "创建时间"))
            for u in d["users"]:
                print("%-16s %-10s %-14s %-6s %s" % (
                    u.get("username", ""), u.get("name", ""), u.get("role", ""),
                    "正常" if u.get("active", True) else "停用", u.get("createdAt", "")))
        return 0

    if args.delete:
        name = args.delete.strip()
        u = find(d, name)
        d["users"] = [x for x in d["users"] if str(x.get("username", "")).lower() != name.lower()]
        if name not in d["deleted"]:
            d["deleted"].append(name)
        save(d)
        print("已删除 %s（%s）" % (name, "名单内" if u else "不在名单，已加墓碑以覆盖源码内置账号"))
        print("下一步：git add data/users.json && git commit && git push")
        return 0

    if not args.user:
        ap.print_help()
        return 1

    username = args.user.strip()
    if not USERNAME_RE.match(username):
        print("❌ 账号需 3-32 位字母/数字/_.@-", file=sys.stderr)
        return 1

    u = find(d, username)
    created = False
    if u is None:
        roles = valid_roles()
        if args.role and roles and args.role not in roles:
            print("❌ 角色不存在：%s（可选：%s）" % (args.role, " / ".join(roles)), file=sys.stderr)
            return 1
        if not args.name:
            print("❌ 新增账号必须给 --name 姓名", file=sys.stderr)
            return 1
        u = {
            "id": "u_%s" % hashlib.md5(username.lower().encode()).hexdigest()[:10],
            "username": username,
            "name": args.name.strip(),
            "role": args.role or "member",
            "passwordHash": "",
            "active": True,
            "builtin": False,
            "createdAt": now_iso(),
            "lastLogin": None,
        }
        d["users"].append(u)
        created = True

    changed = []
    if args.password:
        if len(args.password) < MIN_PASS:
            print("❌ 密码至少 %d 位" % MIN_PASS, file=sys.stderr)
            return 1
        u["passwordHash"] = "sha256$" + sha256_hex(args.password)
        changed.append("密码")
    if args.name:
        u["name"] = args.name.strip()
        changed.append("姓名")
    if args.role:
        roles = valid_roles()
        if roles and args.role not in roles:
            print("❌ 角色不存在：%s（可选：%s）" % (args.role, " / ".join(roles)), file=sys.stderr)
            return 1
        u["role"] = args.role
        changed.append("角色")
    if args.disable:
        u["active"] = False
        changed.append("停用")
    if args.enable:
        u["active"] = True
        changed.append("启用")

    if created and not u["passwordHash"]:
        print("❌ 新增账号必须给 --pass 初始密码", file=sys.stderr)
        return 1
    if not created and not changed:
        print("没有要改的内容。用 --list 查看，或补 --pass / --name / --role / --disable / --enable")
        return 1

    if username in d["deleted"]:
        d["deleted"] = [x for x in d["deleted"] if x != username]

    save(d)
    print("%s %s（%s）%s" % ("已新增" if created else "已更新", username,
                             "/".join(changed) or "-", " · " + u["name"]))
    print("下一步：git add data/users.json && git commit -m \"chore(user): %s %s\" && git push"
          % ("add" if created else "update", username))
    return 0


if __name__ == "__main__":
    sys.exit(main())
