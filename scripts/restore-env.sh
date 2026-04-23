#!/bin/bash
# restore-env.sh — 從 GitHub secret Gist 拉回 .env.local
#
# 無腦使用：
#   bash scripts/restore-env.sh
#
# 前提：
#   - 已安裝 gh CLI（brew install gh）
#   - 已 gh auth login 登入你的 GitHub 帳號
#   - 你自己的帳號下有一個 secret gist 名為 travel-bookmark .env
#     （首次用 bash scripts/backup-env.sh 建）

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
echo "  📥 Restore .env.local from GitHub Gist"
echo "═══════════════════════════════════════════"
echo ""

# 1. gh CLI 存在？
if ! command -v gh >/dev/null 2>&1; then
  fail "gh CLI 未安裝"
  echo "   裝法：brew install gh"
  exit 1
fi

# 2. gh 登入？
if ! gh auth status >/dev/null 2>&1; then
  fail "未登入 GitHub CLI"
  echo "   請先跑：gh auth login"
  exit 1
fi
GH_USER=$(gh api user --jq .login 2>/dev/null || echo "?")
ok "GitHub 帳號：$GH_USER"

# 3. 找 travel-bookmark secret gist
echo ""
echo "🔍 搜尋 travel-bookmark secret gist..."
GIST_LIST=$(gh gist list --limit 100 2>/dev/null | grep -i "travel-bookmark" || true)

if [ -z "$GIST_LIST" ]; then
  fail "找不到 travel-bookmark gist"
  echo ""
  echo "原因之一："
  echo "  - 你是第一次用這台電腦 → 還沒把 .env.local 備份到 Gist"
  echo "    跑：bash scripts/backup-env.sh（但你得先有 .env.local）"
  echo "  - 你用錯 GitHub 帳號登入 → gh auth logout && gh auth login"
  echo "  - Gist 被刪了 → 去 https://gist.github.com/ 看"
  echo ""
  echo "沒有 Gist 的話改用：bash bootstrap.sh 互動式填入"
  exit 1
fi

GIST_COUNT=$(echo "$GIST_LIST" | wc -l | tr -d ' ')
if [ "$GIST_COUNT" -gt 1 ]; then
  warn "找到 $GIST_COUNT 個 gist 含 travel-bookmark，預設取第一個："
  echo "$GIST_LIST"
  echo ""
fi

GIST_ID=$(echo "$GIST_LIST" | head -1 | awk '{print $1}')
GIST_DESC=$(echo "$GIST_LIST" | head -1 | cut -f2)
ok "找到 gist: $GIST_ID ($GIST_DESC)"

# 4. 備份現有 .env.local（如果有）
ENV_FILE="$PROJECT_DIR/.env.local"
if [ -f "$ENV_FILE" ]; then
  BAK="${ENV_FILE}.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$ENV_FILE" "$BAK"
  ok "舊 .env.local 備份到 $(basename $BAK)"
fi

# 5. 拉 gist 內容（暫存後 atomic rename）
TMP="/tmp/restore-env-$$.tmp"
echo ""
echo "📥 拉取 gist 內容..."
gh gist view "$GIST_ID" -r > "$TMP"

if [ ! -s "$TMP" ]; then
  fail "gist 內容為空"
  rm -f "$TMP"
  exit 1
fi

# 6. atomic rename 到 .env.local
mv "$TMP" "$ENV_FILE"
ok ".env.local 已從 gist 恢復（$(wc -l < $ENV_FILE | tr -d ' ') 行）"

# 7. 顯示欄位名（不含 token 值）
echo ""
echo "包含變數："
grep -E "^[A-Z_]+=" "$ENV_FILE" | cut -d= -f1 | sed 's/^/  - /'

echo ""
ok "完成！下一步："
echo "  1. bash bootstrap.sh  # 偵測到 .env.local 會跳過互動"
echo "  2. npm run dev"
