#!/usr/bin/env bash
# ============================================================
# 本地仓库对齐远端 main（单一事实源）
#
# 为什么需要这个脚本：
#   本项目推送常需走「Git Data API 绕行」（blob → tree → commit → ref），
#   因为本机 git push 走 github.com:443 会被 reset / SSL 中断。
#   API 推送不会回写本地 git → 本地历史会与远端分叉：
#   本地 git log 看不到真实版本、git pull 冲突、本地不能当回滚点。
#
#   凡做过 API 推送、或在别的机器上推过、或不确定本地是否落后 —— 跑它。
#
# 两条通路：
#   ① git fetch 可达 github.com → 直接取回对象（首选）
#   ② github.com 打不通但 api.github.com 通 → 调 tools/fetch-remote-commit.py
#      从 API 取远端 SHA 并在本地重建同 SHA 的 commit 对象
#      （本机实测 github.com 时通时断，所以必须有这条兜底）
#
# 用法：
#   bash tools/sync-local.sh            # 对齐；工作区脏则先备份并停下（不丢东西）
#   bash tools/sync-local.sh --check    # 只报告差多少，不动文件
#   bash tools/sync-local.sh --force    # 确认丢弃未提交改动，强制对齐
#
# 退出码：0 = 已对齐；1 = 环境/网络错误或工作区脏需确认；2 = --check 模式下本地落后
# ============================================================
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1
# 注意：Windows Python 不认 /c/Users/... 这类 MSYS 路径（会被转成 C:\c\Users\...），
# 所以这里取「相对仓库根」的 tools 目录名来调用 python 脚本。
TOOLS_REL="$(basename "$(cd "$(dirname "$0")" && pwd)")"

REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-main}"
BACKUP_DIR="${BACKUP_DIR:-../_backup}"
CHECK_ONLY=0
FORCE=0
for a in "$@"; do
  case "$a" in
    --check) CHECK_ONLY=1 ;;
    --force) FORCE=1 ;;
  esac
done

# 沙箱/代理注入的 http_proxy 常让 github.com 的 CONNECT 隧道失败，先清掉
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy

PY=python
command -v "$PY" >/dev/null 2>&1 || PY=python3

echo "▶ 仓库：$(pwd)"
echo "▶ 远端：$REMOTE/$BRANCH"

# ---------- 1) 取远端 SHA（双通路） ----------
TARGET=""
SRC=""
if git fetch "$REMOTE" "$BRANCH" >/dev/null 2>&1; then
  TARGET="$(git rev-parse FETCH_HEAD 2>/dev/null)"
  SRC="git fetch"
else
  echo "  ⚠ git fetch 打不通 github.com（reset / SSL eof / CONNECT 502 都属常见）"
  echo "  → 改走 api.github.com 兜底"
  TARGET=""
  if [ -f "$TOOLS_REL/fetch-remote-commit.py" ]; then
    RAW="$("$PY" "$TOOLS_REL/fetch-remote-commit.py" --branch "$BRANCH" 2>&1 | tail -1)"
    case "$RAW" in
      *[!0-9a-f]*|"") echo "  · API 兜底失败：$RAW" ;;
      *) TARGET="$RAW" ;;
    esac
  else
    echo "  · 缺少 $TOOLS_REL/fetch-remote-commit.py，跳过兜底"
  fi
  SRC="api.github.com"
fi

if [ -z "$TARGET" ]; then
  echo "✗ 两条通路都失败：git fetch 不通，api.github.com 兜底也没拿到 SHA。"
  echo "  · 检查网络/代理后重试；"
  echo "  · 或确认系统凭据管理器里有 github.com 的 token（git credential fill 可查到）。"
  exit 1
fi

LOCAL="$(git rev-parse HEAD)"
echo "  来源 $SRC"
echo "  远端 ${TARGET:0:8}  $(git log -1 --format=%s "$TARGET" 2>/dev/null)"
echo "  本地 ${LOCAL:0:8}  $(git log -1 --format=%s "$LOCAL" 2>/dev/null)"

# ---------- 2) 确保 remote-tracking ref 正确 ----------
# 受限环境下 git update-ref 会静默失效（本机实测），导致 origin/main 解析不到、
# git status 永远显示 up-to-date。这里幂等兜底直写。
TRACK_REF=".git/refs/remotes/$REMOTE/$BRANCH"
git update-ref "refs/remotes/$REMOTE/$BRANCH" "$TARGET" 2>/dev/null || true
if [ "$(git rev-parse -q --verify "refs/remotes/$REMOTE/$BRANCH" 2>/dev/null || echo none)" != "$TARGET" ]; then
  mkdir -p "$(dirname "$TRACK_REF")" && printf '%s' "$TARGET" > "$TRACK_REF"
  echo "  · 已直写补正 $TRACK_REF（git update-ref 在本环境静默失效）"
fi

# ---------- 3) 已对齐？ ----------
if [ "$LOCAL" = "$TARGET" ]; then
  DIRTY="$(git status --porcelain)"
  if [ -z "$DIRTY" ]; then
    echo "✅ 本地已与远端一致，工作区干净。"
    exit 0
  fi
  echo "✅ 提交已一致，但工作区有未提交改动："
  echo "$DIRTY" | sed 's/^/  /'
  exit 0
fi

# ---------- 4) 落后多少 ----------
BEHIND="$(git rev-list --count "$LOCAL..$TARGET" 2>/dev/null || echo '?')"
AHEAD="$(git rev-list --count "$TARGET..$LOCAL" 2>/dev/null || echo '?')"
echo "  落后 $BEHIND 个提交，领先 $AHEAD 个提交"

if [ "$CHECK_ONLY" = "1" ]; then
  echo "ℹ --check 模式：未改动任何文件。去掉 --check 即可对齐。"
  [ "$BEHIND" != "0" ] && exit 2
  exit 0
fi

# ---------- 5) 未提交内容：先备份，默认拒绝丢弃 ----------
if [ -n "$(git status --porcelain)" ]; then
  mkdir -p "$BACKUP_DIR"
  STAMP="$(date +%Y%m%d-%H%M%S)"
  BK="$BACKUP_DIR/team-portal-precheck-$STAMP.tar.gz"
  if tar -czf "$BK" -C "$(dirname "$(pwd)")" "$(basename "$(pwd)")" 2>/dev/null; then
    echo "  ⚠ 本地有未提交改动，已备份 → $BK"
  else
    echo "  ⚠ 备份失败（$BK）"
  fi
  if [ "$FORCE" != "1" ]; then
    echo "  未提交内容如下（对齐会丢弃它们）："
    git status --porcelain | sed 's/^/    /'
    echo "✗ 已停下，未改动任何文件。"
    echo "  · 要保留：先 git add/commit（或用 API 推送）再跑本脚本；"
    echo "  · 要丢弃并对齐：加 --force 重跑。"
    exit 1
  fi
  echo "  --force：丢弃上述未提交改动，继续对齐"
fi

# ---------- 6) 强制对齐 ----------
# 注意：reset --hard 会删掉「只在旧提交里存在」的文件；只用于向前对齐，
#       不要拿它当回退工具。
git reset --hard "$TARGET" >/dev/null 2>&1
NOW="$(git rev-parse HEAD)"
if [ "$NOW" = "$TARGET" ]; then
  echo "✅ 本地已对齐远端 ${TARGET:0:8}"
  git log --oneline -3 | sed 's/^/  /'
else
  echo "✗ 对齐失败，HEAD 仍在 ${NOW:0:8}"
  exit 1
fi
