#!/bin/bash
# travel-bookmark-enrich.sh — Ollama 自動提取書籤店名/地區
# v2: 抓完整 IG 頁面內容 + structured JSON + confidence + 更多 place_type + re-enrich
# 由 LaunchAgent 定時執行（每 2 分鐘）

set -euo pipefail

# 2026-04-24 修：從 .env.local 讀真實 credentials（原 placeholder 是 history wash 殘留）
# 根因：history wash 通用化但 runtime 沒 fallback，沉默失敗連續 5+ 天 enrich 不跑
# 同 lesson 2026-04-23「placeholder 必配合 runtime env fallback」
ENV_FILE="/Users/xiaoque/travel-bookmark/.env.local"
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
LOG="/Users/xiaoque/travel-bookmark/logs/enrich.log"

# Pre-flight: 拒絕在 placeholder 狀態啟動
if [[ "$SUPABASE_URL" == *"YOUR_SUPABASE"* ]] || [[ "$SUPABASE_KEY" == *"YOUR_SUPABASE"* ]]; then
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: Supabase credentials 仍為 placeholder，請檢查 $ENV_FILE" >> "$LOG"
  exit 2
fi

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$LOG"; }

# Check Ollama is running
if ! curl -sf http://localhost:11434/api/tags > /dev/null 2>&1; then
  log "ERROR: Ollama not running, skipping"
  exit 0
fi

# Fetch bookmarks that need enrichment:
# - enriched_at IS NULL (never processed)
# - OR confidence < 0.5 (low confidence, retry)
BOOKMARKS=$(curl -sf "${SUPABASE_URL}/rest/v1/bookmarks?or=(enriched_at.is.null,confidence.lt.0.5)&select=id,title,description,url,city,district,place_type,confidence,image_url&order=created_at.desc&limit=10" \
  -H "apikey: ${SUPABASE_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_KEY}" 2>/dev/null)

COUNT=$(echo "$BOOKMARKS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")

if [ "$COUNT" = "0" ]; then
  log "No bookmarks to enrich"
  exit 0
fi

log "Found $COUNT bookmarks to enrich"

# Process each bookmark
echo "$BOOKMARKS" | python3 -c "
import json, sys, urllib.request, urllib.parse, re, html

SUPABASE_URL = '${SUPABASE_URL}'
SUPABASE_KEY = '${SUPABASE_KEY}'
OLLAMA_URL = '${OLLAMA_URL}'
OLLAMA_MODEL = '${OLLAMA_MODEL}'
GEMINI_API_KEY = '${GEMINI_API_KEY}'
GEMINI_MODEL = '${GEMINI_MODEL}'

def resolve_short_url(url):
    \"\"\"Resolve short URLs (xhslink.com etc.) to their final destination.\"\"\"
    if 'xhslink.com' not in url:
        return url
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
        })
        with urllib.request.urlopen(req, timeout=10) as resp:
            resolved = resp.url
            print(f'  Resolved short URL -> {resolved[:80]}')
            return resolved
    except Exception as e:
        print(f'  Short URL resolve error: {e}', file=sys.stderr)
        return url

def extract_xhs_content(raw):
    \"\"\"Extract content from Xiaohongshu __INITIAL_STATE__ embedded JSON.\"\"\"
    state_match = re.search(r'__INITIAL_STATE__\s*=\s*(\{.+?\})\s*</script>', raw, re.DOTALL)
    if not state_match:
        return None
    state_str = state_match.group(1)
    texts = []
    # Extract desc and title from embedded JSON
    desc_pat = re.compile(r'\"desc\"\s*:\s*\"([^\"]{10,})\"')
    title_pat = re.compile(r'\"title\"\s*:\s*\"([^\"]{5,})\"')
    for m in desc_pat.findall(state_str)[:2]:
        try:
            decoded = m.encode('raw_unicode_escape').decode('unicode_escape', errors='replace')
            texts.append(decoded)
        except:
            texts.append(m)
    for m in title_pat.findall(state_str)[:2]:
        try:
            decoded = m.encode('raw_unicode_escape').decode('unicode_escape', errors='replace')
            texts.append(decoded)
        except:
            texts.append(m)
    return '\n'.join(texts)[:1500] if texts else None

def fetch_page_text(url):
    \"\"\"Fetch full page content from URL for better extraction.\"\"\"
    try:
        # Resolve short URLs first
        url = resolve_short_url(url)

        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
            'Accept-Language': 'zh-TW,zh;q=0.9,en;q=0.8'
        })
        with urllib.request.urlopen(req, timeout=15) as resp:
            raw = resp.read().decode('utf-8', errors='ignore')

            # Xiaohongshu: extract from __INITIAL_STATE__
            if 'xiaohongshu.com' in url:
                xhs_content = extract_xhs_content(raw)
                if xhs_content:
                    print(f'  Extracted XHS content: {len(xhs_content)} chars')
                    return xhs_content

            # General: extract from OG meta tags
            texts = []
            og_match = re.search(r'<meta[^>]*property=[\"\\']og:description[\"\\'][^>]*content=[\"\\']([^\"\\'>]+)', raw)
            if og_match:
                texts.append(html.unescape(og_match.group(1)))
            og_title = re.search(r'<meta[^>]*property=[\"\\']og:title[\"\\'][^>]*content=[\"\\']([^\"\\'>]+)', raw)
            if og_title:
                texts.append(html.unescape(og_title.group(1)))
            desc_match = re.search(r'<meta[^>]*name=[\"\\']description[\"\\'][^>]*content=[\"\\']([^\"\\'>]+)', raw)
            if desc_match:
                texts.append(html.unescape(desc_match.group(1)))
            # JSON-LD
            ld_match = re.search(r'<script type=[\"\\']application/ld\+json[\"\\']>([^<]+)</script>', raw)
            if ld_match:
                try:
                    ld = json.loads(ld_match.group(1))
                    if isinstance(ld, dict):
                        for key in ['articleBody', 'description', 'name', 'caption']:
                            if key in ld:
                                texts.append(str(ld[key]))
                except:
                    pass
            combined = '\n'.join(texts)
            return combined[:1500] if combined else None
    except Exception as e:
        print(f'  Page fetch error: {e}', file=sys.stderr)
        return None

def _build_extract_prompt(title, description, page_text):
    \"\"\"Build the extraction prompt. Shared by Gemini + Ollama.\"\"\"
    sources = []
    if page_text:
        sources.append(f'網頁內容：{page_text[:1200]}')
    if description:
        desc_clean = html.unescape(description)
        if len(desc_clean) > 600:
            desc_clean = desc_clean[:600]
        sources.append(f'描述：{desc_clean}')
    if title:
        sources.append(f'標題：{title}')

    all_text = '\n'.join(sources) if sources else '無'

    # 2026-04-24 prompt 升級（配合 Gemini 2.5 Flash 能力）：
    # - 加入「地標 → 行政區」推理規則（西子灣→鼓山區、逢甲→西屯區 等）
    # - 強化 place_type 判斷（「以為 X 實際 Y」類誘餌句式要挑出真正類型）
    return f'''你是台灣餐廳 / 景點 / 旅遊地點資訊提取助手。從以下文字中提取結構化資訊。

{all_text}

請提取以下欄位，回傳純 JSON 不要其他文字：

- **place_name**：實際店名或景點名稱（不是 IG 文章標題，是真正的店名 / 地名）。
  - ⚠️ 必須是文字中明確出現的店名，絕不猜測或編造。若文字沒明確提到，填 null。
  - 🎯 IG 常見格式「店名：XXX」「地址：XXX」「#tag 店名」都可以抓。

- **city**：台灣縣市名（不帶「市」「縣」後綴）。例：台北、新北、嘉義、高雄、台東、南投、彰化、宜蘭、花蓮。
  - ⚠️ 若描述說「台南」但地址是「高雄市鳳山區」以**地址為準**。

- **district**：**具體行政區**（必填，不要只填縣市名 fallback）。如：東區、左營區、中山區、鼓山區、苓雅區、新興區、鳳山區、前鎮區、三民區、仁愛鄉、太麻里。
  - 🎯 **地標 → 行政區推理**（Gemini 應該做得到）：
    - 高雄：西子灣 / 哈瑪星 / 駁二 → 鼓山區；蓮池潭 / 巨蛋 / 瑞豐 → 左營區；新崛江 / 玉竹街 → 新興區；衛武營 → 苓雅區；夢時代 → 前鎮區；佛光山 → 大樹區
    - 台北：信義 101 → 信義區；東區 / 頂好 → 大安區；饒河 / 松山車站 → 松山區；迪化街 → 大同區
    - 台中：勤美 / 草悟道 → 西區；逢甲 → 西屯區；國美館 → 西區；東海 → 龍井區
    - 台南：赤崁 / 國華街 / 神農街 → 中西區；奇美博物館 → 仁德區；安平古堡 → 安平區
    - 嘉義：文化路夜市 / 嘉義車站 → 東區
  - 若真的完全無法判斷具體行政區，才用縣市名 fallback。

- **place_type**：類型，嚴格從以下挑一個：restaurant, cafe, bar, hotel, attraction, bakery, dessert, nightmarket, other
  - 🎯 判斷原則：
    - 主打「咖啡廳 / café / coffee / 咖啡館」→ cafe（即使也賣輕食）
    - 主打「酒吧 / bar / pub / 調酒」→ bar
    - 主打「麵包 / 烘焙 / bakery」→ bakery
    - 主打「甜點 / 蛋糕 / 布丁 / 豆花 / 刨冰 / 泡芙」→ dessert
    - 自然景點 / 溫泉 / 步道 / 峽谷 / 展覽 → attraction
    - 夜市 / 市集 → nightmarket
    - 早午餐 / 牛排 / 火鍋 / 川菜 / 日料 / 韓食 / 拉麵 / 漢堡 → restaurant
  - ⚠️ **誘餌句式注意**：若 title 說「以為是 X，結果是 Y」，以 **Y** 為準（例：「以為網美咖啡廳結果是中式料理」→ place_type = restaurant）

- **confidence**：提取結果的整體信心（0.0-1.0）。
  - 店名明確 + 地址明確 + 類型清楚 → 0.9
  - 店名有但地址靠推理（地標→行政區）→ 0.8
  - 店名靠猜或文字模糊 → < 0.4

回傳格式（純 JSON）：
{{\"place_name\": \"...\", \"city\": \"...\", \"district\": \"...\", \"place_type\": \"...\", \"confidence\": 0.9}}

無法判斷的欄位填 null（confidence 除外，必填）。'''


def gemini_extract(title, description, page_text):
    \"\"\"2026-04-24 主模型：Gemini 2.5 Flash。品質 > Ollama qwen2.5:3b，每天 1500 次免費。\"\"\"
    if not GEMINI_API_KEY:
        return None
    prompt = _build_extract_prompt(title, description, page_text)
    endpoint = f'https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}'
    payload = json.dumps({
        'contents': [{'parts': [{'text': prompt}]}],
        'generationConfig': {
            'temperature': 0.1,
            'maxOutputTokens': 512,
            'responseMimeType': 'application/json',
        }
    }).encode()
    req = urllib.request.Request(endpoint, data=payload,
                                  headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            body = json.loads(resp.read())
            # 解析 Gemini response 結構
            candidates = body.get('candidates') or []
            if not candidates:
                print(f'  Gemini: no candidates in response', file=sys.stderr)
                return None
            parts = candidates[0].get('content', {}).get('parts') or []
            if not parts:
                print(f'  Gemini: no parts in candidate', file=sys.stderr)
                return None
            text = parts[0].get('text', '').strip()
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                m = re.search(r'\{[^{}]*\}', text, re.DOTALL)
                if m:
                    return json.loads(m.group())
                print(f'  Gemini: unparseable JSON: {text[:100]}', file=sys.stderr)
    except urllib.error.HTTPError as e:
        body = ''
        try: body = e.read().decode('utf-8', errors='ignore')[:200]
        except: pass
        print(f'  Gemini HTTP {e.code}: {body}', file=sys.stderr)
    except Exception as e:
        print(f'  Gemini error: {e}', file=sys.stderr)
    return None


def ollama_extract(title, description, page_text):
    \"\"\"Fallback：Ollama qwen2.5:3b。Gemini 不可用 / 被限流時用。\"\"\"
    prompt = _build_extract_prompt(title, description, page_text)
    payload = json.dumps({
        'model': OLLAMA_MODEL,
        'prompt': prompt,
        'stream': False,
        'format': 'json',
        'options': {'temperature': 0.1, 'num_predict': 300}
    }).encode()
    req = urllib.request.Request(OLLAMA_URL, data=payload,
                                  headers={'Content-Type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            result = json.loads(resp.read())
            text = result.get('response', '')
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                match = re.search(r'\{[^{}]*\}', text)
                if match:
                    return json.loads(match.group())
    except Exception as e:
        print(f'  Ollama error: {e}', file=sys.stderr)
    return None


def extract_place_info(title, description, page_text):
    \"\"\"主入口：Gemini 2.5 Flash first，失敗 fallback Ollama qwen2.5:3b。\"\"\"
    # 先 Gemini
    result = gemini_extract(title, description, page_text)
    if result:
        print(f'  [extracted by gemini]')
        return result
    # Fallback Ollama
    print(f'  [gemini failed, fallback ollama]')
    result = ollama_extract(title, description, page_text)
    if result:
        print(f'  [extracted by ollama]')
    return result

def check_duplicate(bookmark_id, title, city):
    \"\"\"Check if another bookmark has the same title + city. Returns duplicate ID or None.\"\"\"
    if not title or len(title) < 2:
        return None
    # Normalize: strip whitespace, lowercase for comparison
    norm_title = title.strip()
    # Query for bookmarks with same title and city (excluding self)
    params = f'title=eq.{urllib.parse.quote(norm_title)}&id=neq.{bookmark_id}&select=id,title,city,url'
    if city:
        params += f'&city=eq.{urllib.parse.quote(city)}'
    try:
        req = urllib.request.Request(
            f'{SUPABASE_URL}/rest/v1/bookmarks?{params}&limit=1',
            headers={
                'apikey': SUPABASE_KEY,
                'Authorization': f'Bearer {SUPABASE_KEY}',
            }
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            results = json.loads(resp.read())
            if results:
                return results[0]
    except Exception as e:
        print(f'  Duplicate check error: {e}', file=sys.stderr)
    return None

def add_tag(bookmark_id, new_tag):
    \"\"\"Add a tag to bookmark's tags array if not already present.\"\"\"
    # Fetch current tags
    try:
        req = urllib.request.Request(
            f'{SUPABASE_URL}/rest/v1/bookmarks?id=eq.{bookmark_id}&select=tags',
            headers={
                'apikey': SUPABASE_KEY,
                'Authorization': f'Bearer {SUPABASE_KEY}',
            }
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            rows = json.loads(resp.read())
            tags = rows[0].get('tags') or [] if rows else []
        if new_tag in tags:
            return
        tags.append(new_tag)
        patch = json.dumps({'tags': tags}).encode()
        req2 = urllib.request.Request(
            f'{SUPABASE_URL}/rest/v1/bookmarks?id=eq.{bookmark_id}',
            data=patch,
            headers={
                'apikey': SUPABASE_KEY,
                'Authorization': f'Bearer {SUPABASE_KEY}',
                'Content-Type': 'application/json',
                'Prefer': 'return=minimal'
            },
            method='PATCH'
        )
        urllib.request.urlopen(req2, timeout=10)
    except Exception as e:
        print(f'  Add tag error: {e}', file=sys.stderr)

def update_bookmark(bookmark_id, updates):
    \"\"\"Patch bookmark in Supabase.\"\"\"
    updates['enriched_at'] = 'now()'

    data = json.dumps(updates).encode()
    req = urllib.request.Request(
        f'{SUPABASE_URL}/rest/v1/bookmarks?id=eq.{bookmark_id}',
        data=data,
        headers={
            'apikey': SUPABASE_KEY,
            'Authorization': f'Bearer {SUPABASE_KEY}',
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal'
        },
        method='PATCH'
    )
    try:
        urllib.request.urlopen(req, timeout=10)
        return True
    except Exception as e:
        print(f'  Update error: {e}', file=sys.stderr)
        return False

def upload_image_to_storage(bookmark_id, image_url):
    \"\"\"Download image and upload to Supabase Storage. Returns public URL or None.\"\"\"
    try:
        # Download image
        req = urllib.request.Request(image_url, headers={
            'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
        })
        with urllib.request.urlopen(req, timeout=15) as resp:
            img_data = resp.read()
            content_type = resp.headers.get('Content-Type', 'image/jpeg')

        # Determine extension
        ext = 'jpg'
        if 'png' in content_type:
            ext = 'png'
        elif 'webp' in content_type:
            ext = 'webp'

        file_path = f'{bookmark_id}.{ext}'

        # Upload to Supabase Storage
        upload_req = urllib.request.Request(
            f'{SUPABASE_URL}/storage/v1/object/bookmark-images/{file_path}',
            data=img_data,
            headers={
                'apikey': SUPABASE_KEY,
                'Authorization': f'Bearer {SUPABASE_KEY}',
                'Content-Type': content_type,
                'x-upsert': 'true'
            },
            method='POST'
        )
        urllib.request.urlopen(upload_req, timeout=15)

        public_url = f'{SUPABASE_URL}/storage/v1/object/public/bookmark-images/{file_path}'
        return public_url
    except Exception as e:
        print(f'  Image upload error: {e}', file=sys.stderr)
        return None

bookmarks = json.load(sys.stdin)
enriched = 0

for bm in bookmarks:
    bid = bm['id']
    title = bm.get('title') or ''
    desc = bm.get('description') or ''
    url = bm.get('url') or ''
    old_confidence = bm.get('confidence')
    old_image = bm.get('image_url') or ''
    print(f'Processing: {title[:40]}... (prev confidence: {old_confidence})')

    # Fetch full page content for better extraction
    page_text = fetch_page_text(url) if url else None
    if page_text:
        print(f'  Fetched {len(page_text)} chars from page')

    result = extract_place_info(title, desc, page_text)
    if not result:
        # Mark as processed with low confidence so it retries next time (up to 3 attempts)
        if old_confidence is None:
            update_bookmark(bid, {'confidence': 0.1})
            print(f'  No result, set confidence=0.1 for retry')
        else:
            update_bookmark(bid, {'confidence': 0.6})
            print(f'  No result on retry, marking as done')
        continue

    updates = {}
    confidence = result.get('confidence', 0.5)
    try:
        confidence = float(confidence)
        confidence = max(0.0, min(1.0, confidence))
    except (ValueError, TypeError):
        confidence = 0.5
    updates['confidence'] = confidence

    # Update title if Ollama found a better place name (only if confident enough)
    place_name = result.get('place_name')
    if place_name and place_name != title and len(place_name) <= 40 and confidence >= 0.5:
        updates['title'] = place_name
        print(f'  Title: {title[:30]} -> {place_name}')
    elif place_name and confidence < 0.5:
        print(f'  Title skipped (low confidence {confidence}): {place_name}')

    # Update city
    if result.get('city'):
        city = re.sub(r'[市縣]$', '', result['city'])
        if city != bm.get('city'):
            updates['city'] = city
            print(f'  City: {city}')

    # Update district (fallback to city if not detected)
    if result.get('district'):
        district = result['district']
        if district != bm.get('district'):
            updates['district'] = district
            print(f'  District: {district}')
    elif not bm.get('district'):
        fallback_city = updates.get('city') or bm.get('city') or ''
        if fallback_city:
            updates['district'] = fallback_city
            print(f'  District (fallback to city): {fallback_city}')

    # Update place_type
    if result.get('place_type'):
        valid_types = ['restaurant', 'cafe', 'bar', 'hotel', 'attraction', 'bakery', 'dessert', 'nightmarket', 'other']
        pt = result['place_type']
        if pt in valid_types and pt != bm.get('place_type'):
            updates['place_type'] = pt
            print(f'  Type: {pt}')

    # Upload image to Supabase Storage if we have a CDN URL (IG CDN URLs expire)
    if old_image and 'cdninstagram.com' in old_image and 'supabase' not in old_image:
        print(f'  Uploading IG image to Storage...')
        perm_url = upload_image_to_storage(bid, old_image)
        if perm_url:
            updates['image_url'] = perm_url
            print(f'  Image saved: {perm_url[:60]}')

    if update_bookmark(bid, updates):
        enriched += 1
        print(f'  Updated (confidence: {confidence})')

        # Check for same-name duplicates after enrichment
        final_title = updates.get('title') or title
        final_city = updates.get('city') or bm.get('city')
        if final_title and len(final_title) >= 2:
            dup = check_duplicate(bid, final_title, final_city)
            if dup:
                print(f'  ⚠️ DUPLICATE DETECTED: same as {dup["id"][:8]}... ({dup.get("title")})')
                add_tag(bid, '疑似重複')
                add_tag(dup['id'], '疑似重複')
    else:
        print(f'  Failed to update')
        # 2026-04-24 修無限迴圈：主 PATCH 失敗時，去掉可疑欄位（image_url、超長 title）降級重試一次
        # 若降級仍失敗，硬塞 confidence=0.55 防 query or=(enriched.is.null,confidence.lt.0.5) 再撿
        # 根因：某些 IG CDN image_url 過長或含特殊字元觸發 Supabase PATCH 400，舊版無迴圈防護導致單筆跑 ~40 次
        safe_updates = {k: v for k, v in updates.items() if k != 'image_url'}
        if 'title' in safe_updates and isinstance(safe_updates['title'], str) and len(safe_updates['title']) > 40:
            safe_updates.pop('title')
        if safe_updates and update_bookmark(bid, safe_updates):
            print(f'  Retried without image_url/long-title: OK')
            enriched += 1
        else:
            # 最終降級：只寫 confidence + enriched_at 阻止無限重試
            if update_bookmark(bid, {'confidence': 0.55}):
                print(f'  Retry failed, marked confidence=0.55 to stop re-queue')
            else:
                print(f'  All retries failed for {bid}, will be picked next tick')

print(f'Done: {enriched}/{len(bookmarks)} enriched')
"

log "Enrichment complete"
