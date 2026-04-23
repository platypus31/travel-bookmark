#!/bin/bash
# bootstrap.sh — Travel Bookmark 完整環境一鍵安裝
# 包含：Next.js 前端 + LINE webhook + Ollama enrich 定時任務
#
# 使用方式：
#   git clone https://github.com/platypus31/travel-bookmark.git
#   cd travel-bookmark
#   bash bootstrap.sh
#
# 前提條件：
#   - macOS（LaunchAgent 僅支援 macOS）
#   - Node.js 18+
#   - Ollama 已安裝（brew install ollama）
#   - Vercel CLI（前端部署用，可選）

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="travel-bookmark.enrich"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
ENRICH_SCRIPT="$PROJECT_DIR/tools/enrich.sh"
LOG_DIR="$PROJECT_DIR/logs"
ENV_FILE="$PROJECT_DIR/.env.local"
OLLAMA_MODEL="qwen2.5:3b"

# --- Colors ---
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }
fail() { echo -e "${RED}✗${NC} $*"; }

echo "═══════════════════════════════════════════"
echo "  📍 Travel Bookmark — Bootstrap"
echo "═══════════════════════════════════════════"
echo ""

# ──────────────────────────────────────
# 1. 檢查前提條件
# ──────────────────────────────────────
echo "▶ 檢查前提條件..."

# Node.js
if command -v node &>/dev/null; then
  NODE_VER=$(node -v)
  ok "Node.js $NODE_VER"
else
  fail "Node.js 未安裝 — 請先安裝 Node.js 18+"
  exit 1
fi

# Ollama
if command -v ollama &>/dev/null; then
  ok "Ollama 已安裝"
else
  warn "Ollama 未安裝 — enrich 功能需要 Ollama"
  echo "  安裝方式：brew install ollama"
  echo "  如果只需要前端，可以跳過此步驟"
fi

# ──────────────────────────────────────
# 2. 安裝 Node.js 依賴
# ──────────────────────────────────────
echo ""
echo "▶ 安裝 Node.js 依賴..."
cd "$PROJECT_DIR"
if [ -f package-lock.json ]; then
  npm ci --silent 2>/dev/null && ok "npm ci 完成" || { npm install --silent && ok "npm install 完成"; }
else
  npm install --silent && ok "npm install 完成"
fi

# ──────────────────────────────────────
# 3. 設定環境變數（互動式）
# ──────────────────────────────────────
echo ""
echo "▶ 設定環境變數..."

# 互動式問使用者：如果 .env.local 不存在且是互動 terminal，引導填寫
prompt_env() {
  local var_name="$1"
  local prompt_msg="$2"
  local hint_url="$3"
  local default_val="${4:-}"

  echo ""
  echo "  ${prompt_msg}"
  [ -n "$hint_url" ] && echo "  👉 拿 key 的網址：$hint_url"
  [ -n "$default_val" ] && echo "  （按 Enter 使用預設值：$default_val）"
  printf "  貼入 $var_name: "
  read -r input
  if [ -z "$input" ]; then
    echo "${var_name}=${default_val}"
  else
    echo "${var_name}=${input}"
  fi
}

if [ -f "$ENV_FILE" ] && grep -q "YOUR_SUPABASE_PROJECT_ID\|YOUR_LINE_CHANNEL" "$ENV_FILE" 2>/dev/null; then
  warn ".env.local 存在但還是 placeholder — 重新引導填寫"
  rm "$ENV_FILE"
fi

if [ -f "$ENV_FILE" ]; then
  ok ".env.local 已填好（跳過）"
elif [ -t 0 ]; then
  # 互動 terminal — 引導填寫
  echo "══════════════════════════════════════════════════════════"
  echo "  需要 6 個環境變數。現在引導你去每個網站拿並貼回來。"
  echo "══════════════════════════════════════════════════════════"

  echo ""
  echo "📦 Supabase（資料庫）"
  echo "  沒有帳號的話：https://supabase.com/dashboard/new/_/new-project"
  echo "  拿 key 的位置：Project Settings → API"
  SUPA_URL_LINE=$(prompt_env "NEXT_PUBLIC_SUPABASE_URL" "Supabase Project URL（https://xxx.supabase.co）" "")
  SUPA_KEY_LINE=$(prompt_env "NEXT_PUBLIC_SUPABASE_ANON_KEY" "Supabase anon public key（eyJ... 開頭很長的字串）" "")

  echo ""
  echo "🤖 LINE Bot"
  echo "  沒有 Bot 的話：https://developers.line.biz/console/"
  echo "  Channel Secret 在：Basic settings 頁最下"
  echo "  Access Token 在：Messaging API 頁 → Channel access token → Issue"
  LINE_SECRET_LINE=$(prompt_env "LINE_CHANNEL_SECRET" "LINE Channel Secret" "")
  LINE_TOKEN_LINE=$(prompt_env "LINE_CHANNEL_ACCESS_TOKEN" "LINE Channel Access Token（huiT... 開頭）" "")

  echo ""
  echo "🏷️  LINE 預設 Group / User（跟 supabase-schema.sql 裡 insert 的 UUID 一致）"
  GROUP_LINE=$(prompt_env "LINE_DEFAULT_GROUP_ID" "LINE Default Group ID" "" "00000000-0000-0000-0000-000000000001")
  USER_LINE=$(prompt_env "LINE_DEFAULT_USER_ID" "LINE Default User ID" "" "00000000-0000-0000-0000-000000000002")

  cat > "$ENV_FILE" <<ENVEOF
# 自動產生 by bootstrap.sh — 不要 commit！
$SUPA_URL_LINE
$SUPA_KEY_LINE

# LINE Bot
$LINE_SECRET_LINE
$LINE_TOKEN_LINE

# LINE Bot default group/user
$GROUP_LINE
$USER_LINE
ENVEOF
  ok ".env.local 已建立並填入你的值"
else
  # 非互動 terminal（例如 CI）— 寫 placeholder
  cat > "$ENV_FILE" << 'ENVEOF'
NEXT_PUBLIC_SUPABASE_URL=https://YOUR_SUPABASE_PROJECT_ID.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=YOUR_SUPABASE_ANON_KEY

# LINE Bot
LINE_CHANNEL_SECRET=YOUR_LINE_CHANNEL_SECRET
LINE_CHANNEL_ACCESS_TOKEN=YOUR_LINE_CHANNEL_ACCESS_TOKEN

# LINE Bot default group/user
LINE_DEFAULT_GROUP_ID=00000000-0000-0000-0000-000000000001
LINE_DEFAULT_USER_ID=00000000-0000-0000-0000-000000000002
ENVEOF
  ok ".env.local 已建立 placeholder（請手動編輯填入實際值）"
fi

# ──────────────────────────────────────
# 4. 建立 log 目錄
# ──────────────────────────────────────
echo ""
echo "▶ 建立 log 目錄..."
mkdir -p "$LOG_DIR"
ok "$LOG_DIR"

# ──────────────────────────────────────
# 5. 設定 Ollama 模型
# ──────────────────────────────────────
echo ""
echo "▶ 檢查 Ollama 模型..."

if command -v ollama &>/dev/null; then
  if curl -sf http://localhost:11434/api/tags >/dev/null 2>&1; then
    ok "Ollama 服務運行中"
    # Check if model exists
    if ollama list 2>/dev/null | grep -q "$OLLAMA_MODEL"; then
      ok "模型 $OLLAMA_MODEL 已安裝"
    else
      echo "  下載模型 $OLLAMA_MODEL（約 1.5GB）..."
      ollama pull "$OLLAMA_MODEL" && ok "模型下載完成" || warn "模型下載失敗，請手動執行 ollama pull $OLLAMA_MODEL"
    fi
  else
    warn "Ollama 未啟動 — 請先執行 ollama serve"
  fi
else
  warn "跳過 Ollama 設定（未安裝）"
fi

# ──────────────────────────────────────
# 6. 設定 enrich 腳本權限
# ──────────────────────────────────────
echo ""
echo "▶ 設定 enrich 腳本..."
chmod +x "$ENRICH_SCRIPT"
ok "已設定執行權限"

# ──────────────────────────────────────
# 7. 安裝 LaunchAgent（macOS 定時任務）
# ──────────────────────────────────────
echo ""
echo "▶ 安裝 LaunchAgent（每 2 分鐘自動 enrich）..."

# Unload existing if present
if launchctl list 2>/dev/null | grep -q "$LABEL"; then
  launchctl unload "$PLIST_PATH" 2>/dev/null || true
fi

cat > "$PLIST_PATH" << PLISTEOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${LABEL}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${ENRICH_SCRIPT}</string>
    </array>
    <key>StartInterval</key>
    <integer>120</integer>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/enrich-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/enrich-stderr.log</string>
    <key>RunAtLoad</key>
    <false/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin</string>
    </dict>
</dict>
</plist>
PLISTEOF

launchctl load "$PLIST_PATH" && ok "LaunchAgent 已安裝並啟動" || warn "LaunchAgent 安裝失敗"

# ──────────────────────────────────────
# 8. 驗證
# ──────────────────────────────────────
echo ""
echo "▶ 驗證安裝..."

# Test enrich script (dry run)
if bash "$ENRICH_SCRIPT" 2>/dev/null; then
  ok "enrich 腳本執行正常"
else
  warn "enrich 腳本執行有問題，請檢查 Ollama 和 Supabase 設定"
fi

# Check LaunchAgent
if launchctl list 2>/dev/null | grep -q "$LABEL"; then
  ok "LaunchAgent 已載入"
else
  warn "LaunchAgent 未載入"
fi

# ──────────────────────────────────────
# Done
# ──────────────────────────────────────
echo ""
echo "═══════════════════════════════════════════"
echo "  ✅ Bootstrap 完成！"
echo "═══════════════════════════════════════════"
echo ""
echo "架構："
echo "  LINE Bot → Vercel webhook → Supabase（即時存入）"
echo "  LaunchAgent → Ollama enrich（每 2 分鐘補齊店名/地區）"
echo "  Next.js → 網頁瀏覽/編輯/篩選"
echo ""
echo "常用指令："
echo "  npm run dev              本地開發"
echo "  bash tools/enrich.sh     手動執行一次 enrich"
echo "  tail -f logs/enrich.log  查看 enrich 日誌"
echo ""
echo "移除 enrich 定時任務："
echo "  launchctl unload $PLIST_PATH"
echo "  rm $PLIST_PATH"
echo ""
