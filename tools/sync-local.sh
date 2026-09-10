#!/usr/bin/env bash
# ============================================================
# 本地仓库对齐远端 main（单一事实源）
#
# 为什么需要这个脚本：
#   本项目的推送有时走「Git Data API 绕行」（blob → tree → commit → ref），
#   原因是 github.com:443 的 git push 会被 reset。API 推送到不了本地 git，
#   于是本地历史会与远端分叉：本地 git log 看不到真实版本、git pull 会冲突、
#   本地不能当回滚点。
#
#   凡做过 API 推送、或在别的机器上推过、或不确定本地是否落后时 —— 跑它。
#
# 用法：
#   bash tools/sync-local.sh              # 有未提交改动会自动备份再对齐
#   bash tools/sync-local.sh --check      # 只看差多少，不动文件
#
# 退出码：0 = 已对齐；1 = 参数/环境错误；2 = --check 模式下本地落后
# ============================================================
set -uo pipefail

cd "$(dirname "$0")/.." || exit 1

REMOTE="${REMOTE:-origin}"
BRANCH="${BRANCH:-main}"
BACKUP_DIR="${BACKUP_DIR:-../_backup}"
CHECK_ONLY=0
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

echo "▶ 仓库：$(pwd)"
echo "▶ 远端：$REMOTE/$BRANCH"

# ---------- 1) 取远端 ----------
if ! git fetch "$REMOTE" "$BRANCH" 2>&1 | sed 's/^/  /'; then
  echo "✗ git fetch 失败。github.com:443 可能不通 —— 检查网络/代理后重试。"
  exit 1
fi
TARGET="$(git rev-parse FETCH_HEAD)"
LOCAL="$(git rev-parse HEAD)"
echo "  远端 ${TARGET:0:8}  $(git log -1 --format=%s "$TARGET")"
echo "  本地 ${LOCAL:0:8}  $(git log -1 --format=%s "$LOCAL")"

# ---------- 2) 确保 remote-tracking ref 正确 ----------
# 某些受限环境（沙箱/权限）git 自己写 .git/refs/remotes/** 会静默失败，
# 导致 `git status` 永远显示 up-to-date 且 origin/main 解析不到。这里幂等兜底。
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

# ---------- 5) 未提交内容先备份 ----------
if [ -n "$(git status --porcelain)" ]; then
  mkdir -p "$BACKUP_DIR"
  STAMP="$(date +%Y%m%d-%H%M%S)"
  BK="$BACKUP_DIR/team-portal-precheck-$STAMP.tar.gz"
  tar -czf "$BK" -C "$(dirname "$(pwd)")" "$(basename "$(pwd)")" 2>/dev/null \
    && echo "  ⚠ 本地有未提交改动，已备份 → $BK" \
    || echo "  ⚠ 备份失败（继续执行，请自行确认本地改动已无用）"
fi

# ---------- 6) 强制对齐 ----------
git reset --hard "$TARGET" >/dev/null 2>&1
NOW="$(git rev-parse HEAD)"
if [ "$NOW" = "$TARGET" ]; then
  echo "✅ 本地已对齐远端 ${TARGET:0:8}"
  git log --oneline -3 | sed 's/^/  /'
else
  echo "✗ 对齐失败，HEAD 仍在 ${NOW:0:8}"; exit 1
fi
