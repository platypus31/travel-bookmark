"""import-michelin.py — 把 2025 台灣米其林指南（星級 + 必比登）匯入 travel-bookmark。

由 tools/import-michelin.sh 呼叫（負責讀 .env.local / ai-twin/.env 灌環境變數）。
不直接跑：python3 tools/import-michelin.py 缺環境變數會直接 KeyError。

流程：
  1. 讀 tools/michelin-2025.json（見 build 腳本產出的名單 + 來源出處）
  2. 對每一家用 Google Places Text Search 取 place_id / lat,lng / formatted_address
  3. 去重：place_id 對應的 Google Maps URL 已存在 → 跳過；
     店名＋城市已有既存書籤（不論哪個平台）→ 也跳過，避免跟家人手動收藏的重複
  4. 寫入 bookmarks：platform=googlemaps、tags 放獎項標記、description 首行同樣寫獎項＋菜系

環境變數（必填）：
  SUPABASE_URL / SUPABASE_KEY       同 enrich_places.py 慣例
  GOOGLE_PLACES_API_KEY             Google Places API (Text Search) 金鑰
  BOOKMARK_GROUP_ID / BOOKMARK_CREATED_BY  沿用既有家庭群組的真實 id（實測查得，不用 schema 預設值）

環境變數（選填）：
  DRY_RUN=1        只印出會寫什麼，不呼叫 Supabase 寫入（仍會呼叫 Places API 查座標）
  MICHELIN_JSON     預設 tools/michelin-2025.json
"""

import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

SUPABASE_URL = os.environ['SUPABASE_URL'].rstrip('/')
SUPABASE_KEY = os.environ['SUPABASE_KEY']
GOOGLE_PLACES_API_KEY = os.environ['GOOGLE_PLACES_API_KEY']
GROUP_ID = os.environ['BOOKMARK_GROUP_ID']
CREATED_BY = os.environ['BOOKMARK_CREATED_BY']

DRY_RUN = os.environ.get('DRY_RUN') == '1'
MICHELIN_JSON = os.environ.get(
    'MICHELIN_JSON',
    os.path.join(os.path.dirname(os.path.abspath(__file__)), 'michelin-2025.json'),
)

PLACES_TEXTSEARCH_URL = 'https://maps.googleapis.com/maps/api/place/textsearch/json'


def places_text_search(name, city):
    """回傳 (place_id, lat, lng, formatted_address, matched_name) 或 None（查無/失敗）。"""
    query = f'{name} {city}'
    params = urllib.parse.urlencode({
        'query': query,
        'region': 'tw',
        'language': 'zh-TW',
        'key': GOOGLE_PLACES_API_KEY,
    })
    url = f'{PLACES_TEXTSEARCH_URL}?{params}'
    try:
        with urllib.request.urlopen(url, timeout=15) as resp:
            data = json.loads(resp.read())
    except Exception as e:
        print(f'    ! Places API 呼叫失敗（{name}）：{e}', file=sys.stderr)
        return None, 'REQUEST_FAILED'

    status = data.get('status')
    if status == 'ZERO_RESULTS':
        return None, 'ZERO_RESULTS'
    if status != 'OK':
        print(f'    ! Places API 狀態異常（{name}）：{status} {data.get("error_message", "")}',
              file=sys.stderr)
        return None, status

    results = data.get('results') or []
    if not results:
        # status=='OK' 但 results 是空陣列理論上不該發生，但別讓一筆邊界情況把
        # 整個迴圈炸掉、害後面 196 家全部不處理（2026-09-20 codex-review P2）
        print(f'    ! Places API 回 OK 但 results 是空的（{name}）', file=sys.stderr)
        return None, 'OK_EMPTY_RESULTS'
    top = results[0]
    loc = top.get('geometry', {}).get('location', {})
    return {
        'place_id': top.get('place_id'),
        'lat': loc.get('lat'),
        'lng': loc.get('lng'),
        'formatted_address': top.get('formatted_address'),
        'matched_name': top.get('name'),
    }, 'OK'


def maps_place_url(place_id, lat, lng):
    """official 文件記載的 place 連結格式：帶 query_place_id 才會直接開到該店家頁。"""
    q = urllib.parse.quote(f'{lat},{lng}', safe='')
    pid = urllib.parse.quote(place_id, safe='')
    return f'https://www.google.com/maps/search/?api=1&query={q}&query_place_id={pid}'


def _get(path_query):
    req = urllib.request.Request(
        f'{SUPABASE_URL}/rest/v1/{path_query}',
        headers={'apikey': SUPABASE_KEY, 'Authorization': f'Bearer {SUPABASE_KEY}'},
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read() or b'[]')


def _normalize_name_for_search(name):
    """取左括號前的核心店名，去頭尾空白 —— 「牛老大涮牛肉（高雄總店）」這類分店
    標記會讓 ilike 比對失準（2026-09-20 codex-review P3，Claude sonnet reviewer 抓到）。"""
    core = re.split(r'[（(]', name)[0].strip()
    return core or name


def _escape_ilike_pattern(text):
    """PostgREST ilike pattern 裡 %/_ 是萬用字元，店名若剛好含這兩個字元要先跳脫，
    否則會被當 SQL wildcard 造成誤判重複或漏抓（2026-09-20 codex-review P1）。"""
    return text.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')


def already_bookmarked(name, city, maps_url):
    """place_id URL 已存在，或同店名（去分店標記後的核心名）＋同城市已有任何平台的
    書籤 → 視為重複。"""
    try:
        rows = _get(
            'bookmarks?select=id&group_id=eq.' + GROUP_ID
            + '&url=eq.' + urllib.parse.quote(maps_url, safe='')
        )
        if rows:
            return True
    except Exception as e:
        print(f'    ! 查重（url）失敗（{name}）：{e}', file=sys.stderr)

    core_raw = _normalize_name_for_search(name)
    try:
        if len(core_raw) < 3:
            # 短店名（例如米其林二星「A」這種單一英文字母）用 ilike substring
            # 幾乎會命中資料庫裡任何含該字元的既有書籤標題，誤判成重複而永遠寫不進去
            # 且不會出現在任何統計欄位裡（2026-09-20 codex-review P1，Claude sonnet
            # reviewer 抓到）。短名一律改用完全比對，不做模糊比對。
            rows = _get(
                'bookmarks?select=id,title,platform&group_id=eq.' + GROUP_ID
                + '&city=eq.' + urllib.parse.quote(city, safe='')
                + '&title=eq.' + urllib.parse.quote(core_raw, safe='')
            )
        else:
            core_name = _escape_ilike_pattern(core_raw)
            rows = _get(
                'bookmarks?select=id,title,platform&group_id=eq.' + GROUP_ID
                + '&city=eq.' + urllib.parse.quote(city, safe='')
                + '&title=ilike.*' + urllib.parse.quote(core_name, safe='') + '*'
            )
        if rows:
            return True
    except Exception as e:
        print(f'    ! 查重（name+city）失敗（{name}）：{e}', file=sys.stderr)
    return False


def insert_bookmark(record, place):
    award = record['award_tag']
    cuisine = record.get('cuisine') or ''
    description_lines = [f'{award}｜{cuisine}'.rstrip('｜')]
    if place.get('formatted_address'):
        description_lines.append(place['formatted_address'])
    maps_url = maps_place_url(place['place_id'], place['lat'], place['lng'])

    row = {
        'group_id': GROUP_ID,
        'created_by': CREATED_BY,
        'url': maps_url,
        'source_url': record['source_url'],
        'platform': 'googlemaps',
        'title': record['name'],
        'description': '\n'.join(description_lines),
        'city': record['city'],
        # district 缺值時留 None（NULL），不要塞城市名頂替 —— CITIES 的 district
        # 是行政區清單（如「大安區」），塞「台北」這種城市名會讓前端依區篩選失效
        # （2026-09-20 codex-review P1，Claude sonnet reviewer 抓到）
        'district': record.get('district'),
        'place_type': 'restaurant',
        'tags': [award],
        'confidence': 1.0,
        'enriched_at': 'now()',
    }

    if DRY_RUN:
        print(f'    [dry-run] 會新增：{record["name"]}｜{record["city"]}｜{award}｜'
              f'place_id={place["place_id"]}｜{maps_url}')
        return True

    req = urllib.request.Request(
        f'{SUPABASE_URL}/rest/v1/bookmarks?on_conflict=group_id,url',
        data=json.dumps(row).encode(),
        headers={
            'apikey': SUPABASE_KEY,
            'Authorization': f'Bearer {SUPABASE_KEY}',
            'Content-Type': 'application/json',
            'Prefer': 'resolution=ignore-duplicates,return=representation',
        },
        method='POST',
    )
    # 回傳三態，不要把「url 衝突已存在」跟「API 真的失敗」都壓成同一個 False——
    # 否則統計報表會把真失敗誤報成「已存在跳過」，看不出真因
    # （2026-09-20 codex-review P2，Claude sonnet reviewer 抓到）：
    #   True  = 真的新增了一筆
    #   'exists' = url 衝突，DB 已有（正常情況，非錯誤）
    #   None  = API 呼叫真的失敗（需要在回報裡單獨列出來，不能算「已存在」）
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            created = json.loads(resp.read() or b'[]')
            if created:
                print(f'    + {record["name"]}（{record["city"]}）{award}')
                return True
            print(f'    = {record["name"]} 已存在（url 衝突），略過')
            return 'exists'
    except urllib.error.HTTPError as e:
        body = ''
        try:
            body = e.read().decode('utf-8', errors='ignore')[:200]
        except Exception:
            pass
        print(f'    ! 新增 {record["name"]} 失敗 HTTP {e.code}: {body}', file=sys.stderr)
        return None
    except Exception as e:
        print(f'    ! 新增 {record["name"]} 失敗：{e}', file=sys.stderr)
        return None


def main():
    with open(MICHELIN_JSON, encoding='utf-8') as f:
        data = json.load(f)
    records = data['restaurants']

    added_by_award = {}
    skipped_existing = 0
    insert_failed = []
    unmatched = []
    api_calls = 0
    # 連續同型失敗（非 ZERO_RESULTS，例如 API key 失效/配額用盡）超過這個次數就停止，
    # 不要對著同一種錯誤把剩下的配額燒光（2026-09-20 codex-review P2）
    consecutive_hard_failures = 0
    MAX_CONSECUTIVE_HARD_FAILURES = 8

    print(f'== 開始處理 {len(records)} 家餐廳（DRY_RUN={DRY_RUN}）==')

    for i, record in enumerate(records, 1):
        name, city, award = record['name'], record['city'], record['award_tag']
        place, status = places_text_search(name, city)
        api_calls += 1
        time.sleep(0.05)

        if not place:
            unmatched.append({'name': name, 'city': city, 'reason': status})
            print(f'[{i}/{len(records)}] ? {name}（{city}）Places 對不到（{status}）')
            if status in ('ZERO_RESULTS', 'OK_EMPTY_RESULTS'):
                # 資料本身查無/邊界情況，跟 API key 失效或配額用盡無關，不計入連續失敗
                consecutive_hard_failures = 0
            else:
                consecutive_hard_failures += 1
                if consecutive_hard_failures >= MAX_CONSECUTIVE_HARD_FAILURES:
                    print(f'! 連續 {consecutive_hard_failures} 次非 ZERO_RESULTS 失敗'
                          f'（最後狀態：{status}），疑似 API key 失效或配額用盡，提早停止',
                          file=sys.stderr)
                    break
            continue
        consecutive_hard_failures = 0

        maps_url = maps_place_url(place['place_id'], place['lat'], place['lng'])
        # dry-run 也做唯讀查重，讓「會新增」清單跟真跑時的數字對得起來
        # （2026-09-24 codex-review P3，already_bookmarked 只是 GET，不違反 DRY_RUN 不寫入）
        if already_bookmarked(name, city, maps_url):
            skipped_existing += 1
            print(f'[{i}/{len(records)}] = {name}（{city}）DB 已有，跳過')
            continue

        result = insert_bookmark(record, place)
        if result is True:
            added_by_award[award] = added_by_award.get(award, 0) + 1
        elif result == 'exists':
            skipped_existing += 1
        else:
            insert_failed.append({'name': name, 'city': city})

    print()
    print('== 完工統計 ==')
    total_added = sum(added_by_award.values())
    print(f'新增：{total_added}')
    for k, v in sorted(added_by_award.items()):
        print(f'  {k}: {v}')
    print(f'DB 已存在跳過：{skipped_existing}')
    print(f'寫入真失敗（非已存在，需要人工看 stderr 排查）：{len(insert_failed)}')
    print(f'Google 對不到：{len(unmatched)}')
    print(f'Places API 呼叫次數：{api_calls}')
    if insert_failed:
        print('寫入失敗清單：')
        for u in insert_failed:
            print(f'  - {u["name"]}｜{u["city"]}')
    if unmatched:
        print('未對照清單：')
        for u in unmatched:
            print(f'  - {u["name"]}｜{u["city"]}｜{u["reason"]}')

    summary = {
        'added_by_award': added_by_award,
        'total_added': total_added,
        'skipped_existing': skipped_existing,
        'insert_failed': insert_failed,
        'unmatched': unmatched,
        'api_calls': api_calls,
    }
    with open(
        os.path.join(os.path.dirname(MICHELIN_JSON), 'michelin-import-result.json'),
        'w', encoding='utf-8',
    ) as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)


if __name__ == '__main__':
    main()
