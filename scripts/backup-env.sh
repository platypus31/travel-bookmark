#!/bin/bash
# backup-env.sh — 把當前 .env.local 推到 GitHub secret Gist
#
# 無腦使用：
#   bash scripts/backup-env.sh
#
# 行為：
#   - 如果已有 travel-bookmark gist：更新它
#   - 如果沒有：建一個新的 secret gist
#
# 前提：
#   - 已安裝 gh CLI（brew install gh）
#   - 已 gh auth login 登入你的 GitHub 帳號
#   - .env.local 存在

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }
fail() { echo -e "${RED}✗${NC} $*"; }

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

echo "═══════════════════════════════════════════"
echo "  📤 Backup .env.local to GitHub Gist"
echo "═══════════════════════════════════════════"
echo ""

# 1. .env.local 存在？
if [ ! -f .env.local ]; then
  fail ".env.local 不存在"
  echo "   先跑：bash bootstrap.sh 建立"
  exit 1
fi

# 2. .env.local 還是 placeholder？不要備份垃圾
if grep -q "YOUR_SUPABASE_PROJECT_ID\|YOUR_LINE_CHANNEL" .env.local; then
  fail ".env.local 還是 placeholder（YOUR_xxx）"
  echo "   先跑：bash bootstrap.sh 填入實際值再備份"
  exit 1
fi

# 3. gh 檢查
if ! command -v gh >/dev/null 2>&1; then
  fail "gh CLI 未安裝（brew install gh）"
  exit 1
fi
if ! gh auth status >/dev/null 2>&1; then
  fail "未登入 GitHub CLI（gh auth login）"
  exit 1
fi
GH_USER=$(gh api user --jq .login 2>/dev/null || echo "?")
ok "GitHub 帳號：$GH_USER"

# 4. 找既有 gist
echo ""
echo "🔍 搜尋既有 travel-bookmark gist..."
GIST_ID=$(gh gist list --limit 100 2>/dev/null | grep -i "travel-bookmark" | head -1 | awk '{print $1}')

if [ -n "$GIST_ID" ]; then
  # 更新既有
  ok "找到既有 gist: $GIST_ID"
  echo ""
  echo "📤 更新 gist 內容..."
  gh gist edit "$GIST_ID" -f .env.local .env.local
  ok "Gist 已更新 → https://gist.github.com/$GH_USER/$GIST_ID"
else
  # 建新的
  warn "沒找到既有 gist，建立新的..."
  echo ""
  NEW_URL=$(gh gist create --filename ".env.local" --desc "travel-bookmark .env — 換電腦用 gh gist view 拉回" .env.local 2>&1 | tail -1)
  ok "新 secret gist 建立 → $NEW_URL"
fi

echo ""
echo "下次換電腦："
echo "  1. gh auth login"
echo "  2. git clone https://github.com/$GH_USER/travel-bookmark.git"
echo "  3. cd travel-bookmark"
echo "  4. bash scripts/restore-env.sh   # 自動拉 .env.local"
