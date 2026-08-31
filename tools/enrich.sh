#!/bin/bash
# travel-bookmark-enrich.sh — 自動提取書籤店名/地區（Gemini 2.5 Flash → Ollama fallback）
# 由 LaunchAgent travel-bookmark.enrich 每 2 分鐘執行一次
#
# v3（2026-08-31）：
#   - 萃取邏輯搬到 tools/enrich_places.py（原本 620 行 python 內嵌在 `python3 -c "…"` 字串裡，
#     每個引號都要逃脫、改不動也驗不了；對應 lessons-coding「python > 5 行一律獨立檔」）
#   - 支援「一篇貼文 → 多個地點書籤」：IG／小紅書清單型貼文會拆成 N 筆，
#     全部用 source_url 指回同一篇原貼文
#   - credential 改用環境變數傳給 python，不再字串插值進原始碼

set -euo pipefail

# 2026-04-24 修：從 .env.local 讀真實 credentials（原 placeholder 是 history wash 殘留）
# 根因：history wash 通用化但 runtime 沒 fallback，沉默失敗連續 5+ 天 enrich 不跑
# 同 lesson 2026-04-23「placeholder 必配合 runtime env fallback」
REPO_DIR="$HOME/travel-bookmark"
ENV_FILE="$REPO_DIR/.env.local"
PLACES_SCRIPT="$REPO_DIR/tools/enrich_places.py"
if [ -f "$ENV_FILE" ]; then
  SUPABASE_URL=$(grep '^NEXT_PUBLIC_SUPABASE_URL=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | head -1)
  SUPABASE_KEY=$(grep '^NEXT_PUBLIC_SUPABASE_ANON_KEY=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | head -1)
  GEMINI_API_KEY=$(grep '^GEMINI_API_KEY=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | head -1)
else
  SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-https://YOUR_SUPABASE_PROJECT_ID.supabase.co}"
  SUPABASE_KEY="${NEXT_PUBLIC_SUPABASE_ANON_KEY:-YOUR_SUPABASE_ANON_KEY}"
  GEMINI_API_KEY="${GEMINI_API_KEY:-}"
fi
OLLAMA_URL="http://localhost:11434/api/generate"
OLLAMA_MODEL="qwen2.5:3b"
GEMINI_MODEL="gemini-2.5-flash"
LOG="$REPO_DIR/logs/enrich.log"

# Pre-flight: 拒絕在 placeholder 狀態啟動
if [[ "$SUPABASE_URL" == *"YOUR_SUPABASE"* ]] || [[ "$SUPABASE_KEY" == *"YOUR_SUPABASE"* ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: Supabase credentials 仍為 placeholder，請檢查 $ENV_FILE" >> "$LOG"
  exit 2
fi

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

# ---- 併發鎖 ----
# LaunchAgent 每 120s 觸發一次，但單輪最多處理 10 筆、每筆最壞情況要等 Gemini 60s + Ollama 30s，
# 一輪跑超過兩分鐘是有可能的 → 沒有鎖就會兩輪重疊，同一批書籤被抓兩次、
# 對 Gemini 與 Supabase 送重複請求。用 mkdir 當原子鎖（macOS 沒有內建 flock）。
LOCK_DIR="$REPO_DIR/logs/.enrich.lock"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  LOCK_PID=$(cat "$LOCK_DIR/pid" 2>/dev/null || echo "")
  if [ -n "$LOCK_PID" ] && kill -0 "$LOCK_PID" 2>/dev/null; then
    log "SKIP: 上一輪還在跑（pid ${LOCK_PID}），本輪跳過"
    exit 0
  fi
  # 走到這裡代表鎖在、持有者卻不在了。先看鎖的年齡再清 ——
  # 剛 mkdir 完但還沒寫 pid 的那一瞬間也會讀不到 pid，年齡防呆避免把活鎖誤清掉。
  LOCK_AGE=$(( $(date +%s) - $(stat -f %m "$LOCK_DIR" 2>/dev/null || date +%s) ))
  if [ "$LOCK_AGE" -lt 60 ]; then
    log "SKIP: 鎖剛建立 ${LOCK_AGE}s 還讀不到 pid，本輪跳過不強清"
    exit 0
  fi
  log "清掉孤兒鎖（pid ${LOCK_PID:-unknown} 已不存在，鎖齡 ${LOCK_AGE}s）"
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR" 2>/dev/null || { log "SKIP: 搶鎖失敗，本輪跳過"; exit 0; }
fi
echo $$ > "$LOCK_DIR/pid"
trap 'rm -rf "$LOCK_DIR"' EXIT

if [ ! -f "$PLACES_SCRIPT" ]; then
  log "ERROR: 找不到 $PLACES_SCRIPT"
  exit 2
fi

# Check Ollama is running
if ! curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
  log "ERROR: Ollama not running, skipping"
  exit 0
fi

# bookmarks.source_url 是 2026-08-31 才加的欄位（migration 由使用者在 Supabase 手動跑）。
# 還沒跑的時候把它放進 select 會整包 400 → enrich 全滅，所以先探一次再決定要不要用。
# 探不到就退回單店模式，功能少一塊但不會壞。
PROBE_CODE=$(curl -s -o /dev/null -w '%{http_code}' \
  "${SUPABASE_URL}/rest/v1/bookmarks?select=source_url&limit=1" \
  -H "apikey: ${SUPABASE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_KEY}" || echo "000")

SELECT_COLS="id,group_id,created_by,platform,title,description,url,city,district,place_type,confidence,image_url"
HAS_SOURCE_URL=0
if [ "$PROBE_CODE" = "200" ]; then
  HAS_SOURCE_URL=1
  SELECT_COLS="${SELECT_COLS},source_url"
else
  # ⚠️ 這裡的變數一定要寫 ${PROBE_CODE} 不能寫 $PROBE_CODE：
  # 後面緊跟全形「）」時，bash 3.2（macOS 內建）會把多位元組字元的第一個 byte 吃進變數名，
  # 變成 "PROBE_CODE?: unbound variable" 當場整支腳本死掉（2026-07-04 教訓同型，本次實測復現）。
  log "NOTE: bookmarks.source_url 不存在（HTTP ${PROBE_CODE}），本輪不拆多地點；請跑 supabase/migrations/2026-08-31-add-source-url.sql"
fi

# Fetch bookmarks that need enrichment:
# - enriched_at IS NULL (never processed)
# - OR confidence < 0.5 (low confidence, retry)
BOOKMARKS=$(curl -sf "${SUPABASE_URL}/rest/v1/bookmarks?or=(enriched_at.is.null,confidence.lt.0.5)&select=${SELECT_COLS}&order=created_at.desc&limit=10" \
  -H "apikey: ${SUPABASE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_KEY}" 2>/dev/null)

COUNT=$(echo "$BOOKMARKS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")

if [ "$COUNT" = "0" ]; then
  log "No bookmarks to enrich"
  exit 0
fi

log "Found ${COUNT} bookmarks to enrich (source_url=${HAS_SOURCE_URL})"

echo "$BOOKMARKS" | SUPABASE_URL="$SUPABASE_URL" \
  SUPABASE_KEY="$SUPABASE_KEY" \
  OLLAMA_URL="$OLLAMA_URL" \
  OLLAMA_MODEL="$OLLAMA_MODEL" \
  GEMINI_API_KEY="$GEMINI_API_KEY" \
  GEMINI_MODEL="$GEMINI_MODEL" \
  HAS_SOURCE_URL="$HAS_SOURCE_URL" \
  python3 "$PLACES_SCRIPT"

log "Enrichment complete"
