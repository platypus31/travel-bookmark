#!/bin/bash
# import-michelin.sh — 一次性匯入 2025 台灣米其林指南（星級+必比登）到 travel-bookmark。
# 用法：
#   bash tools/import-michelin.sh --dry-run   # 只印出會寫什麼，不寫入 DB
#   bash tools/import-michelin.sh             # 真的寫入
#
# 沿用 tools/enrich.sh 的 credential 讀取慣例：從 .env.local 讀 Supabase anon key
# （公開金鑰，安全靠 RLS），從 ~/ai-twin/.env 讀 GOOGLE_PLACES_API_KEY。
# 不是 LaunchAgent 排程檔，是一次性工具，不受教條 #11 live 檔規範。

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(dirname "$SCRIPT_DIR")"
cd "$REPO_DIR"

ENV_FILE="$REPO_DIR/.env.local"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "找不到 $ENV_FILE，無法讀取 Supabase credential" >&2
  exit 1
fi

# 2026-09-20 codex-review P2：grep 找不到值時在 set -e -o pipefail 下會讓賦值那一行
# 直接終止腳本（cryptic exit，看不到下面 33 行的友善錯誤訊息）—— 加 `|| true` 讓
# 找不到時變數變空字串，交給下面統一判斷。
# 2026-09-20 codex-review P3：tr -d '"' 只去雙引號，不去結尾空白，值若帶尾隨空白
# 會讓 API 呼叫失敗 —— 加 sed 去頭尾空白。
SUPABASE_URL=$(grep '^NEXT_PUBLIC_SUPABASE_URL=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | head -1 || true)
SUPABASE_KEY=$(grep '^NEXT_PUBLIC_SUPABASE_ANON_KEY=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | head -1 || true)

AI_TWIN_ENV="$HOME/ai-twin/.env"
if [[ ! -f "$AI_TWIN_ENV" ]]; then
  echo "找不到 $AI_TWIN_ENV，無法讀取 GOOGLE_PLACES_API_KEY" >&2
  exit 1
fi
GOOGLE_PLACES_API_KEY=$(grep '^GOOGLE_PLACES_API_KEY=' "$AI_TWIN_ENV" | cut -d= -f2- | tr -d '"' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' | head -1 || true)

if [[ -z "$SUPABASE_URL" || -z "$SUPABASE_KEY" || -z "$GOOGLE_PLACES_API_KEY" ]]; then
  echo "SUPABASE_URL / SUPABASE_KEY / GOOGLE_PLACES_API_KEY 有缺，中止" >&2
  exit 1
fi

# 家庭實際在用的 group/profile（2026-09-20 查表得出，不用 schema 種子的預設值）：
# group_id e15e96d3-2354-404d-95d1-8993a96fbbe3（280 筆既有書籤全在這個群組）
# created_by 3677faae-0608-499e-9fd2-7cdffcb61684（既有 280 筆的共同 created_by）
BOOKMARK_GROUP_ID="e15e96d3-2354-404d-95d1-8993a96fbbe3"
BOOKMARK_CREATED_BY="3677faae-0608-499e-9fd2-7cdffcb61684"

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
fi

export SUPABASE_URL SUPABASE_KEY GOOGLE_PLACES_API_KEY BOOKMARK_GROUP_ID BOOKMARK_CREATED_BY
export DRY_RUN

python3 "$SCRIPT_DIR/import-michelin.py"
