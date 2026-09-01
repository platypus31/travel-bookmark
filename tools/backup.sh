#!/bin/bash
# backup.sh — Supabase → iCloud 每日 JSON dump（travel-bookmark 唯一還原路徑）
# ==============================================================================
# 為什麼要有這支：Supabase 免費方案沒有時間點還原，網頁前端直接用 anon key
# 做 delete/update，知道網址的人可以把收藏一次刪光 —— 那是這個系統唯一
# 「不可逆」的後果。所以做備份，而不是做登入（2026-08-31 架構盤點的判斷）。
#
# 產出：$ICLOUD_DIR/travel-bookmark-YYYY-MM-DD.json
#   { "exported_at": ..., "supabase_url": ..., "counts": {...},
#     "tables": { "bookmarks": [...], "groups": [...], "profiles": [...] } }
#
# 還原（手動，故意不自動化 —— 覆寫線上資料要有人看著）：
#   python3 -c 'import json;d=json.load(open("<備份檔>"));print(len(d["tables"]["bookmarks"]))'
#   再用 curl POST $SUPABASE_URL/rest/v1/bookmarks（apikey + Prefer: resolution=merge-duplicates）
#   把 tables.bookmarks 整包送回去。
#
# 🔴 紅線：credential 只從 .env.local / 環境變數讀，永不寫死、永不進 log。
#         備份檔含 243 筆個人收藏 → 只落 iCloud，不進 git（repo .gitignore 已擋 /backups/，
#         本腳本根本不寫進 repo 內）。
#
# 語義退出碼：0=成功 2=credential 缺/placeholder 3=iCloud 目錄不可寫 1=抓取或驗證失敗
# ==============================================================================
set -uo pipefail

REPO_DIR="$HOME/travel-bookmark"
ENV_FILE="$REPO_DIR/.env.local"
ICLOUD_DIR="$HOME/Library/Mobile Documents/com~apple~CloudDocs/travel-bookmark-backup"
LOG="$REPO_DIR/logs/backup.log"
TABLES=(bookmarks groups profiles)
# 分頁大小可用環境變數壓低來實測翻頁（正常執行不需要設）：TB_BACKUP_PAGE_SIZE=100 bash tools/backup.sh
PAGE_SIZE="${TB_BACKUP_PAGE_SIZE:-1000}"
KEEP=30

mkdir -p "$REPO_DIR/logs" || { echo "❌ 無法建立 log 目錄 $REPO_DIR/logs" >&2; exit 1; }
log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

# ---- credentials（與 enrich.sh 同一套讀法）----
# 檔案值優先，缺的那一個才由環境變數補 —— 不是「檔案存在就整組用檔案」，
# 否則 .env.local 只寫了一半時，環境變數裡明明有的那一個會被空字串蓋掉
# （codex review 2026-09-01 R2 P2）。
SUPABASE_URL=""
SUPABASE_KEY=""
if [ -f "$ENV_FILE" ]; then
  SUPABASE_URL=$(grep '^NEXT_PUBLIC_SUPABASE_URL=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | head -1)
  SUPABASE_KEY=$(grep '^NEXT_PUBLIC_SUPABASE_ANON_KEY=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | head -1)
fi
[ -z "$SUPABASE_URL" ] && SUPABASE_URL="${NEXT_PUBLIC_SUPABASE_URL:-}"
[ -z "$SUPABASE_KEY" ] && SUPABASE_KEY="${NEXT_PUBLIC_SUPABASE_ANON_KEY:-}"
SUPABASE_URL="${SUPABASE_URL%/}"

if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_KEY" ] \
   || [[ "$SUPABASE_URL" == *"YOUR_SUPABASE"* ]] || [[ "$SUPABASE_KEY" == *"YOUR_SUPABASE"* ]]; then
  log "❌ Supabase credentials 缺或仍是 placeholder（檢查 $ENV_FILE）"
  exit 2
fi

if ! mkdir -p "$ICLOUD_DIR" 2>/dev/null; then
  log "❌ 無法建立 iCloud 目錄: $ICLOUD_DIR"
  exit 3
fi

DATE_TAG=$(date '+%Y-%m-%d')
OUT="$ICLOUD_DIR/travel-bookmark-${DATE_TAG}.json"
# 🔴 不能寫 `curl > $OUT`：shell 會先把 $OUT 截成 0-byte 再跑 curl，curl 失敗就留一個
#    空檔覆蓋掉當天的好備份（ai-twin lessons-coding「curl > CACHE 先 truncate」）。
#    一律：抓進 tmp → 驗證 → 原子 mv。
WORK_DIR=$(mktemp -d "${TMPDIR:-/tmp}/tb-backup.XXXXXX") || { log "❌ mktemp 失敗"; exit 1; }
# 組檔的 tmp 必須跟 $OUT 在「同一個檔案系統」，否則 mv 會退化成 copy+unlink（不是原子），
# 中途斷掉就留半截檔覆蓋掉當天的好備份（codex review 2026-09-01 P1）。iCloud 目錄本身也是
# 一般檔案系統，同目錄 mv 才是 rename(2)。
TMP_OUT="$ICLOUD_DIR/.travel-bookmark-${DATE_TAG}.tmp.$$"
cleanup() { rm -rf "$WORK_DIR"; rm -f "$TMP_OUT"; }
trap cleanup EXIT

# ---- 逐表分頁抓取（keyset pagination）----
# PostgREST 預設有 max-rows 上限（常見 1000），所以不能只送一次 limit=99999。
# 🔴 不用 offset：備份掃描期間前端（anon key）可能刪掉前面的列 → 後面的列往前移，
#    offset 就會整段跳過而且完全沒有錯誤訊息（codex review 2026-09-01 P2）。
#    改用 id.gt.<上一頁最後一個 id>，對「掃描中被刪除」冪等。
# 🔴 收尾條件不能只看「這頁少於 PAGE_SIZE」：PostgREST 的 db-max-rows 若小於 PAGE_SIZE，
#    伺服器會靜默截頁 → 每頁都「少於 PAGE_SIZE」→ 第一頁就 break，後面整批漏備份且零錯誤訊息
#    （codex review 2026-09-01 R2 P3，同 ai-twin「靜默失敗最危險」家族）。
#    解法：用 Prefer: count=exact 拿 Content-Range 的總筆數當迴圈控制，撈到總數才收工。
fetch_table() {
  local table="$1" dest="$2"
  local last_id="" page http meta n idx=0 url hdr total="" got=0
  : > "$dest.pages"
  while :; do
    page="$WORK_DIR/${table}-${idx}.json"
    hdr="$WORK_DIR/${table}-${idx}.hdr"
    url="${SUPABASE_URL}/rest/v1/${table}?select=*&order=id.asc&limit=${PAGE_SIZE}"
    [ -n "$last_id" ] && url="${url}&id=gt.${last_id}"
    http=$(curl -sS -w '%{http_code}' -o "$page" -D "$hdr" \
      -H "apikey: $SUPABASE_KEY" \
      -H "Authorization: Bearer $SUPABASE_KEY" \
      -H "Accept: application/json" \
      -H "Prefer: count=exact" \
      --max-time 60 \
      "$url" 2>>"$LOG")
    # 206 Partial Content 是正常的：帶了 limit + Prefer: count=exact 而且還沒撈完時，
    # PostgREST 回 206（實測 2026-09-01，只認 200 會讓多頁備份直接中止）。
    if [ "$http" != "200" ] && [ "$http" != "206" ]; then
      log "❌ ${table} 抓取失敗 HTTP ${http}（第 ${idx} 頁）"
      return 1
    fi
    # 一次拿「筆數」與「最後一筆 id」：非陣列回 -1，讓下面統一判錯
    meta=$(python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
if not isinstance(d,list):
    print("-1\t"); sys.exit(0)
last=d[-1].get("id","") if d and isinstance(d[-1],dict) else ""
print("%d\t%s"%(len(d), last or ""))' "$page" 2>>"$LOG") || {
      log "❌ ${table} 回應不是合法 JSON（第 ${idx} 頁）"; return 1; }
    n="${meta%%	*}"
    last_id="${meta#*	}"
    if [ "$n" -lt 0 ]; then
      log "❌ ${table} 回應不是陣列（第 ${idx} 頁）"
      return 1
    fi
    echo "$page" >> "$dest.pages"
    got=$((got+n))
    # Content-Range: 0-99/243 → 斜線後面是「這次查詢條件下的總筆數」。
    # 因為 URL 帶了 id=gt.<last_id>，第 k 頁拿到的總數＝「剩下還有幾筆」，
    # 所以判斷式是 n >= 本頁宣告的剩餘總數 才收工。
    total=$(grep -i '^content-range:' "$hdr" 2>/dev/null | tail -1 | sed 's|.*/||' | tr -d '\r\n ')
    case "$total" in ''|*[!0-9]*) total="" ;; esac
    [ "$n" -eq 0 ] && break
    if [ -n "$total" ]; then
      [ "$n" -ge "$total" ] && break
    else
      # 拿不到 Content-Range 就只能退回舊判準（有靜默截斷風險）→ 一定要留痕，
      # 否則哪天 PostgREST 不回這個 header，備份會無聲退回舊 bug 且事後查不到
      log "⚠️ ${table} 未取得 Content-Range，改用 PAGE_SIZE 判斷收尾（第 ${idx} 頁）"
      [ "$n" -lt "$PAGE_SIZE" ] && break
    fi
    if [ -z "$last_id" ]; then
      log "❌ ${table} 滿頁卻取不到最後一筆 id，無法安全翻頁，中止"
      return 1
    fi
    idx=$((idx+1))
    if [ "$idx" -gt 200 ]; then
      log "❌ ${table} 分頁超過 200 頁，疑似迴圈，中止"
      return 1
    fi
  done
  log "  ${table}: ${got} 筆（${idx} 頁${total:+，末頁宣告剩餘 ${total}}）"
  return 0
}

for t in "${TABLES[@]}"; do
  fetch_table "$t" "$WORK_DIR/$t" || { log "❌ 備份中止（${t}）"; exit 1; }
done

# ---- 組檔 + 驗證 + 原子寫入 ----（TMP_OUT 已在上面宣告，與 $OUT 同檔案系統）
if ! SUPABASE_URL="$SUPABASE_URL" python3 "$REPO_DIR/tools/backup_assemble.py" \
      "$WORK_DIR" "$TMP_OUT" "${TABLES[@]}" >>"$LOG" 2>&1; then
  log "❌ 組檔失敗，當天備份未更動"
  exit 1
fi

COUNT=$(python3 -c 'import json,sys
d=json.load(open(sys.argv[1]))
print(len(d["tables"]["bookmarks"]))' "$TMP_OUT" 2>>"$LOG") || { log "❌ 產出檔驗證失敗"; exit 1; }

if [ -z "$COUNT" ] || [ "$COUNT" -lt 1 ]; then
  log "❌ bookmarks 為空（${COUNT}），拒絕覆蓋既有備份"
  exit 1
fi

mv "$TMP_OUT" "$OUT" || { log "❌ 原子 mv 失敗"; exit 1; }
log "✅ 備份完成: $(basename "$OUT") — bookmarks ${COUNT} 筆"

# ---- 保留最近 KEEP 份 ----
# 檔名是 YYYY-MM-DD → 字典序＝時間序，ls 排序即可，不依賴 mtime（iCloud 會改 mtime）。
# ⚠️ 不用 mapfile：macOS /bin/bash 是 3.2，沒有 mapfile（LaunchAgent 跑的就是它）。
ALL=()
while IFS= read -r f; do
  [ -n "$f" ] && ALL+=("$f")
done < <(ls -1 "$ICLOUD_DIR" 2>/dev/null | grep -E '^travel-bookmark-[0-9]{4}-[0-9]{2}-[0-9]{2}\.json$' | sort)
TOTAL=${#ALL[@]}
if [ "$TOTAL" -gt "$KEEP" ]; then
  DROP=$((TOTAL-KEEP))
  i=0
  for f in "${ALL[@]}"; do
    [ "$i" -ge "$DROP" ] && break
    rm -f "$ICLOUD_DIR/$f" && log "🗑️ 清除舊備份: $f"
    i=$((i+1))
  done
fi

exit 0
