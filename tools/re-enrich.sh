#!/bin/bash
# re-enrich.sh — 強制重跑 travel-bookmark Ollama 辨識（店名/地點/類型）
#
# 用法：
#   bash re-enrich.sh --latest 3                  # 重跑最新 3 筆
#   bash re-enrich.sh --id <uuid>                 # 重跑特定一筆
#   bash re-enrich.sh --id <uuid1>,<uuid2>        # 重跑多筆（逗號分隔）
#   bash re-enrich.sh --wrong-type                # 重跑 place_type 疑似錯誤的（title/desc 含「咖啡」但 type 不是 cafe）
#   bash re-enrich.sh --low-confidence            # 重跑 confidence < 0.7 的（最多 20 筆）
#   bash re-enrich.sh --fallback-district         # 重跑 district == city 的（fallback 沒抓到行政區）
#   bash re-enrich.sh --dry-run                   # 列出會處理哪些但不實際跑
#
# 原理：強制把選到的書籤 confidence=0.4 + enriched_at=null，讓 enrich.sh 下次 tick 自動撿
#       或直接內嵌跑一次 enrich（--now 模式）
#
# 2026-04-24 建立：泰叡 Discord 要求「撈 supabase + 重跑 enrich 回填」工作流腳本化（麵包機器）
# 對應 CLAUDE.md 教條 #7 — 重複性工作必腳本化

set -euo pipefail

SCRIPT_NAME="re-enrich"
ENV_FILE="$HOME/travel-bookmark/.env.local"
LOG_DIR="$HOME/travel-bookmark/logs"
LOG_FILE="$LOG_DIR/re-enrich.log"
ENRICH_SCRIPT="$HOME/travel-bookmark/tools/enrich.sh"

mkdir -p "$LOG_DIR"

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" | tee -a "$LOG_FILE"; }

if [ ! -f "$ENV_FILE" ]; then
    echo "❌ $ENV_FILE 不存在" >&2
    exit 2
fi

SUPABASE_URL=$(grep '^NEXT_PUBLIC_SUPABASE_URL=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | head -1)
SUPABASE_KEY=$(grep '^NEXT_PUBLIC_SUPABASE_ANON_KEY=' "$ENV_FILE" | cut -d= -f2- | tr -d '"' | head -1)

if [[ "$SUPABASE_URL" == *"YOUR_SUPABASE"* ]] || [[ "$SUPABASE_KEY" == *"YOUR_SUPABASE"* ]]; then
    log "❌ Supabase credentials 仍為 placeholder"
    exit 2
fi

# ---- Parse args ----
MODE=""
COUNT=3
IDS=""
DRY_RUN=0
RUN_NOW=1  # 預設直接跑 enrich.sh

while [ $# -gt 0 ]; do
    case "$1" in
        --latest)
            MODE="latest"
            COUNT="${2:-3}"
            shift 2
            ;;
        --id)
            MODE="id"
            IDS="${2}"
            shift 2
            ;;
        --wrong-type)
            MODE="wrong-type"
            shift
            ;;
        --low-confidence)
            MODE="low-confidence"
            shift
            ;;
        --fallback-district)
            MODE="fallback-district"
            shift
            ;;
        --dry-run)
            DRY_RUN=1
            shift
            ;;
        --no-run)
            RUN_NOW=0
            shift
            ;;
        -h|--help)
            sed -n '2,20p' "$0"
            exit 0
            ;;
        *)
            echo "未知參數：$1" >&2
            exit 2
            ;;
    esac
done

if [ -z "$MODE" ]; then
    echo "請指定模式：--latest N / --id UUID / --wrong-type / --low-confidence / --fallback-district" >&2
    echo "看 --help 查全部" >&2
    exit 2
fi

log "模式=$MODE dry-run=$DRY_RUN run-now=$RUN_NOW"

# ---- 取得要重跑的 id 清單 ----
TARGET_IDS=$(python3 <<PY
import urllib.request, urllib.parse, json, sys

SURL = "$SUPABASE_URL"
SKEY = "$SUPABASE_KEY"
MODE = "$MODE"
COUNT = int("$COUNT") if "$COUNT".isdigit() else 3
IDS = "$IDS".strip()

def q(url):
    req = urllib.request.Request(url, headers={'apikey': SKEY, 'Authorization': f'Bearer {SKEY}'})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)

rows = []
if MODE == 'latest':
    rows = q(f"{SURL}/rest/v1/bookmarks?select=id,title,city,district,place_type,confidence&order=created_at.desc&limit={COUNT}")
elif MODE == 'id':
    for bid in IDS.split(','):
        bid = bid.strip()
        if not bid: continue
        try:
            r = q(f"{SURL}/rest/v1/bookmarks?id=eq.{bid}&select=id,title,city,district,place_type,confidence&limit=1")
            rows.extend(r)
        except Exception as e:
            print(f"ERROR fetch id={bid}: {e}", file=sys.stderr)
elif MODE == 'wrong-type':
    # title/description 含「咖啡」但 place_type 不是 cafe
    rows = q(f"{SURL}/rest/v1/bookmarks?or=(title.ilike.*%E5%92%96%E5%95%A1*,description.ilike.*%E5%92%96%E5%95%A1*)&place_type=neq.cafe&select=id,title,city,district,place_type,confidence&order=created_at.desc&limit=20")
elif MODE == 'low-confidence':
    rows = q(f"{SURL}/rest/v1/bookmarks?confidence=lt.0.7&select=id,title,city,district,place_type,confidence&order=created_at.desc&limit=20")
elif MODE == 'fallback-district':
    # district == city 表示沒抓到具體行政區，fallback 機制兜底
    all_rows = q(f"{SURL}/rest/v1/bookmarks?select=id,title,city,district,place_type,confidence&order=created_at.desc&limit=100")
    rows = [r for r in all_rows if r.get('city') and r.get('district') and r['city'] == r['district']]

# 印出兩部分：一部分給人看（title 摘要），另一部分是 id 清單給 shell 繼續用
for r in rows:
    title = (r.get('title') or '')[:40]
    print(f"INFO id={r['id']} type={r.get('place_type')} city={r.get('city')} district={r.get('district')} confidence={r.get('confidence')} title={title}", file=sys.stderr)
print(','.join(r['id'] for r in rows))
PY
)

if [ -z "$TARGET_IDS" ]; then
    log "⚠️ 沒有符合條件的書籤"
    exit 0
fi

log "目標 id 清單：$TARGET_IDS"

if [ "$DRY_RUN" = "1" ]; then
    log "--dry-run 模式，停止於此不實際改資料"
    exit 0
fi

# ---- Reset 這些書籤的 confidence 讓 enrich.sh 重跑 ----
python3 <<PY
import urllib.request, urllib.parse, json, sys

SURL = "$SUPABASE_URL"
SKEY = "$SUPABASE_KEY"
IDS = "$TARGET_IDS".split(',')

reset = 0
for bid in IDS:
    bid = bid.strip()
    if not bid: continue
    # 把 confidence 設成 0.3 + enriched_at = null 讓 enrich query 再撿到
    data = json.dumps({'confidence': 0.3, 'enriched_at': None}).encode()
    req = urllib.request.Request(
        f"{SURL}/rest/v1/bookmarks?id=eq.{bid}",
        data=data,
        headers={
            'apikey': SKEY,
            'Authorization': f'Bearer {SKEY}',
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal',
        },
        method='PATCH'
    )
    try:
        urllib.request.urlopen(req, timeout=10)
        reset += 1
        print(f"RESET id={bid}")
    except Exception as e:
        print(f"FAILED reset id={bid}: {e}", file=sys.stderr)

print(f"RESET_DONE {reset}/{len(IDS)}", file=sys.stderr)
PY

log "已 reset confidence + enriched_at，書籤會被 enrich.sh 重新撿到"

# ---- 直接跑一次 enrich.sh（預設模式）----
if [ "$RUN_NOW" = "1" ]; then
    log "跑 enrich.sh 立刻處理（不等 LaunchAgent 2 min tick）"
    if [ -x "$ENRICH_SCRIPT" ]; then
        bash "$ENRICH_SCRIPT" >> "$LOG_FILE" 2>&1
        log "enrich.sh 結束 rc=$?"
    else
        log "⚠️ $ENRICH_SCRIPT 不可執行，跳過即時處理，等 LaunchAgent 2 min 後撿"
    fi
fi

# ---- 驗證結果 ----
log "驗證重跑後狀態："
python3 <<PY
import urllib.request, urllib.parse, json, sys

SURL = "$SUPABASE_URL"
SKEY = "$SUPABASE_KEY"
IDS = "$TARGET_IDS".split(',')

for bid in IDS:
    bid = bid.strip()
    if not bid: continue
    try:
        req = urllib.request.Request(
            f"{SURL}/rest/v1/bookmarks?id=eq.{bid}&select=id,title,city,district,place_type,confidence,enriched_at",
            headers={'apikey': SKEY, 'Authorization': f'Bearer {SKEY}'}
        )
        with urllib.request.urlopen(req, timeout=10) as r:
            data = json.load(r)
            if data:
                r = data[0]
                print(f"  {r['title'][:35]:35s} | {r['city']:>4s} / {r.get('district') or 'null':>8s} | {r.get('place_type') or 'null':>12s} | {r.get('confidence')}")
    except Exception as e:
        print(f"  ERROR {bid}: {e}", file=sys.stderr)
PY

log "✅ re-enrich 結束"
