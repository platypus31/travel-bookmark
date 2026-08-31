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
LOCK_HELD=0
# 只清「確定是自己的」鎖。SKIP 路徑不能無條件 rm，否則會把別人的活鎖砍掉。
# 用 if 不用 `[ ... ] && rm`：後者在條件不成立時整個函式回非 0，
# EXIT trap 的最後一個回傳值會蓋掉腳本原本的退出碼，讓正常結束被記成失敗。
cleanup_lock() {
  if [ "$LOCK_HELD" = "1" ]; then rm -rf "$LOCK_DIR"; fi
}
trap cleanup_lock EXIT

# 回收上輩子留下的 .stale.* 垃圾（mv 完還沒 rm 就被 kill -9 會殘留）。
# 只清超過 1 小時的，免得砍到別的行程正在處理中的那一個。
find "$REPO_DIR/logs" -maxdepth 1 -type d -name '.enrich.lock.stale.*' -mmin +60 -exec rm -rf {} + 2>/dev/null || true

if mkdir "$LOCK_DIR" 2>/dev/null; then
  LOCK_HELD=1
  echo $$ > "$LOCK_DIR/pid"
  # 寫後驗證：極端情況下別的行程可能剛好把這個鎖當孤兒搬走並重建。
  # 停一下讀回來，不是自己的 pid 就讓給對方（LOCK_HELD 歸零，trap 才不會砍到人家的鎖）。
  sleep 1
  if [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" != "$$" ]; then
    LOCK_HELD=0
    log "SKIP: 鎖被別的行程搶走，本輪跳過"
    exit 0
  fi
else
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

  # 清孤兒鎖用 mv 不用 rm：mv 只有一個行程會成功，第二個拿到 ENOENT 就知道別人先處理了。
  # 直接 rm -rf 再 mkdir 的話，兩個行程同時判定孤兒時，B 的 rm 會把 A 剛建好的鎖砍掉，
  # 結果兩邊都以為自己拿到鎖 —— 正是這段機制要防的重疊（codex review R2 P2）。
  # 🔴 這一整段不准出現「對可能是活鎖的目錄做 rm」。
  # BSD/GNU 的 mv 搬到「已存在的目錄」是**巢狀塞進去**而且回傳 0（實測 2026-08-31），
  # 所以不能用 mv 的退出碼判斷「還原成功了沒」，一律改用 `[ -e ]` 做結構判斷。
  STALE_DIR="${LOCK_DIR}.stale.$$"
  # pid 有機會回捲重複使用，同名 stale 殘骸會讓下面的 mv 變成巢狀搬入、
  # 讀到的是殘骸的 pid 而不是剛搬進去那個 → 先把同名的清掉（那必定是自己上輩子的垃圾）。
  rm -rf "$STALE_DIR"
  if ! MV_ERR=$(mv "$LOCK_DIR" "$STALE_DIR" 2>&1); then
    # 用「鎖還在不在」判競態，不比對 mv 的英文錯誤字串 ——
    # locale 不是 C 的時候訊息會變成別種語言，字串比對會把正常競態誤報成故障。
    if [ ! -e "$LOCK_DIR" ]; then
      log "SKIP: 孤兒鎖已被別的行程處理，本輪跳過"
    else
      log "WARN: 清孤兒鎖失敗（非競態）：${MV_ERR}"
    fi
    exit 0
  fi

  # 搬完、刪掉之前再確認一次：搬到手上的還是原本判定為死掉的那一個嗎？
  # 有可能在我讀完 pid 到 mv 之間，別的行程已經完成回收並重建了活鎖，
  # 那我 mv 到的就是人家的活鎖，直接 rm 掉會讓兩邊同時在跑（codex review R3 P1）。
  STALE_PID=$(cat "$STALE_DIR/pid" 2>/dev/null || echo "")
  if [ "$STALE_PID" != "${LOCK_PID}" ] || { [ -n "$STALE_PID" ] && kill -0 "$STALE_PID" 2>/dev/null; }; then
    # 搬錯了：手上這包可能是別人的活鎖，**絕對不能刪**。
    # 目標位置已被第三個行程佔走時也不要硬還（會巢狀塞進人家的鎖目錄裡），
    # 直接留著讓上面的 stale GC 一小時後回收（codex review R4 P1）。
    if [ -e "$LOCK_DIR" ]; then
      log "WARN: 想還原孤兒鎖但 ${LOCK_DIR} 已被佔用，保留 ${STALE_DIR} 待回收"
    elif ! mv "$STALE_DIR" "$LOCK_DIR" 2>/dev/null; then
      log "WARN: 還原孤兒鎖失敗，保留 ${STALE_DIR} 待回收"
    fi
    log "SKIP: 搬到的已不是原本那個孤兒（pid ${STALE_PID:-unknown}），本輪跳過"
    exit 0
  fi

  log "清掉孤兒鎖（pid ${LOCK_PID:-unknown} 已不存在，鎖齡 ${LOCK_AGE}s）"
  rm -rf "$STALE_DIR"

  if ! mkdir "$LOCK_DIR" 2>/dev/null; then
    log "SKIP: 清完孤兒鎖後被別的行程搶先，本輪跳過"
    exit 0
  fi
  LOCK_HELD=1
  echo $$ > "$LOCK_DIR/pid"

  # mv 仍有極小視窗可能搬走「別人剛建好的活鎖」。寫完 pid 停一下再讀回來，
  # 不是自己的就讓給對方，並且把 LOCK_HELD 歸零免得 trap 砍掉人家的鎖。
  sleep 1
  if [ "$(cat "$LOCK_DIR/pid" 2>/dev/null)" != "$$" ]; then
    LOCK_HELD=0
    log "SKIP: 鎖被別的行程搶走，本輪跳過"
    exit 0
  fi
fi

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
