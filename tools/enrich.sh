#!/bin/bash
# travel-bookmark-enrich.sh — Ollama 自動提取書籤店名/地區
# v2: 抓完整 IG 頁面內容 + structured JSON + confidence + 更多 place_type + re-enrich
# 由 LaunchAgent 定時執行（每 2 分鐘）

set -euo pipefail

SUPABASE_URL="https://YOUR_SUPABASE_PROJECT_ID.supabase.co"
SUPABASE_KEY="YOUR_SUPABASE_ANON_KEY"
OLLAMA_URL="http://localhost:11434/api/generate"
MODEL="qwen2.5:3b"
LOG="/Users/xiaoque/travel-bookmark/logs/enrich.log"

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
MODEL = '${MODEL}'

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

def ollama_extract(title, description, page_text):
    \"\"\"Ask Ollama to extract place info with confidence score.\"\"\"
    # Build the best available text
    sources = []
    if page_text:
        sources.append(f'網頁內容：{page_text[:1000]}')
    if description:
        desc_clean = html.unescape(description)
        if len(desc_clean) > 500:
            desc_clean = desc_clean[:500]
        sources.append(f'描述：{desc_clean}')
    if title:
        sources.append(f'標題：{title}')

    all_text = '\n'.join(sources) if sources else '無'

    prompt = f'''你是餐廳/景點資訊提取助手。從以下文字中提取資訊，只回傳 JSON。

{all_text}

請提取以下欄位：
- place_name：實際店名或景點名稱（不是文章標題，是真正的店名/地名）。**重要：必須是文字中明確出現的店名，絕對不要猜測或編造不存在的名字。如果文字中沒有明確提到店名，填 null。**
- city：台灣縣市名（不帶「市」「縣」後綴，如：台北、新北、嘉義、高雄、台東）
- district：行政區（如：東區、左營區、中山區）。如果無法判斷具體行政區，填入縣市名
- place_type：類型，只能是以下之一：restaurant, cafe, bar, hotel, attraction, bakery, dessert, nightmarket, other
- confidence：你對提取結果的信心程度，0.0 到 1.0 之間的小數。如果店名是猜的或不確定，confidence 必須低於 0.3

回傳格式（純 JSON，不要其他文字）：
{{\"place_name\": \"...\", \"city\": \"...\", \"district\": \"...\", \"place_type\": \"...\", \"confidence\": 0.9}}

如果某個欄位無法判斷，填 null（confidence 除外，必填）。'''

    payload = json.dumps({
        'model': MODEL,
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
            # With format: json, Ollama should return valid JSON directly
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                # Fallback: extract JSON from response text
                match = re.search(r'\{[^{}]*\}', text)
                if match:
                    return json.loads(match.group())
    except Exception as e:
        print(f'  Ollama error: {e}', file=sys.stderr)
    return None

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

    result = ollama_extract(title, desc, page_text)
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

print(f'Done: {enriched}/{len(bookmarks)} enriched')
"

log "Enrichment complete"
