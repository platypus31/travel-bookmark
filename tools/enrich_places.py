"""travel-bookmark 書籤萃取核心 —— 由 tools/enrich.sh 以 stdin 餵書籤 JSON 陣列驅動。

2026-08-31 從 enrich.sh 的 `python3 -c "..."` 內嵌字串抽出來成獨立檔，原因有二：
  1. 內嵌版每個引號都要 `\\"` 逃脫，改一行就可能整段 parse 失敗，而且沒辦法 py_compile
     （對應 lessons-coding「python 邏輯 > 5 行一律獨立檔」）。
  2. 這輪要加「一篇貼文拆多個地點」，邏輯量翻倍，繼續內嵌等於埋雷。
抽出時逐字元還原 bash 雙引號逃脫，行為與內嵌版一致；設定改從環境變數讀，
credential 不再被字串插值進原始碼（也就不會出現在 ps 的 argv 裡）。

環境變數（由 enrich.sh 設好）：
  SUPABASE_URL / SUPABASE_KEY   必填
  OLLAMA_URL / OLLAMA_MODEL     必填
  GEMINI_API_KEY / GEMINI_MODEL 選填（沒 key 就只走 Ollama）
  HAS_SOURCE_URL=1              資料庫已有 bookmarks.source_url 欄位才給 1；
                                沒有的話一律退回「一篇貼文一筆書籤」的舊行為。
  MAX_PLACES                    一篇貼文最多拆幾個地點（預設 12）
"""

import json, os, sys, urllib.request, urllib.parse, urllib.error, re, html

SUPABASE_URL = os.environ['SUPABASE_URL'].rstrip('/')
SUPABASE_KEY = os.environ['SUPABASE_KEY']
OLLAMA_URL = os.environ.get('OLLAMA_URL', 'http://localhost:11434/api/generate')
OLLAMA_MODEL = os.environ.get('OLLAMA_MODEL', 'qwen2.5:3b')
GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY', '')
GEMINI_MODEL = os.environ.get('GEMINI_MODEL', 'gemini-2.5-flash')

# 資料庫還沒跑 2026-08-31-add-source-url.sql 時為 False：只更新原本那一筆，不拆多地點。
HAS_SOURCE_URL = os.environ.get('HAS_SOURCE_URL') == '1'

# DRY_RUN=1：照常呼叫 LLM，但一個字都不寫回資料庫（只印出「會寫什麼」）。
# 拿正式資料驗抽取品質時用，不會污染使用者的書籤。
DRY_RUN = os.environ.get('DRY_RUN') == '1'

try:
    MAX_PLACES = max(1, int(os.environ.get('MAX_PLACES', '12')))
except ValueError:
    MAX_PLACES = 12

GMAPS_SHORT_HOSTS = ('maps.app.goo.gl', 'goo.gl')

def _host(url):
    try:
        return (urllib.parse.urlparse(url).hostname or '').lower()
    except Exception:
        return ''

def is_gmaps_url(url):
    """Google Maps 連結（含短網址）。只認 google.<tld> 結尾，擋 maps.google.evil.com。"""
    host = _host(url)
    if not host:
        return False
    if host == 'maps.app.goo.gl':
        return True
    path = urllib.parse.urlparse(url).path or ''
    if host == 'goo.gl':
        return path.startswith('/maps')
    if re.match(r'^(?:[a-z0-9-]+\.)*google\.(?:com|[a-z]{2}|com\.[a-z]{2}|co\.[a-z]{2})$', host):
        has_q = 'q' in urllib.parse.parse_qs(urllib.parse.urlparse(url).query or '')
        return path.startswith('/maps') or (host.startswith('maps.') and has_q)
    return False

def parse_gmaps(url):
    """從 Google Maps 網址解出地點名稱 + 座標。

    實測 2026-08-31：Maps 頁面的 og:title 恆為 'Google Maps'、og:description 恆為
    'Find local businesses...'，地址是 JS 渲染的 → 抓 meta 完全沒用。
    唯一可靠來源是網址本身，所以這裡不連網也不需要 Places API。
    """
    name, lat, lng = None, None, None
    parsed = urllib.parse.urlparse(url)
    segs = [s for s in (parsed.path or '').split('/') if s]
    for anchor in ('place', 'search'):
        if anchor in segs:
            i = segs.index(anchor)
            if i + 1 < len(segs):
                cand = urllib.parse.unquote_plus(segs[i + 1]).strip()
                # 排除座標（十進位 + 度分秒），那是「丟針」不是店名
                is_coord = re.match(r'^-?\d+(\.\d+)?,\s*-?\d+(\.\d+)?$', cand) or \
                    re.search(r'\d+\s*°\s*\d+[\'′]\s*[\d.]+\s*["″]?\s*[NSEW]', cand, re.I)
                if cand and not cand.startswith('@') and not is_coord:
                    name = cand
            break
    if not name:
        qs = urllib.parse.parse_qs(parsed.query or '')
        q = (qs.get('q') or qs.get('query') or [None])[0]
        if q:
            qc = re.match(r'^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$', q.strip())
            if qc:
                lat, lng = qc.group(1), qc.group(2)
            else:
                name = q.strip()
    decoded = urllib.parse.unquote(url)
    m = re.search(r'!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)', decoded) or \
        re.search(r'@(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)', decoded)
    # 已從 q= 解出精確座標時不要被 @（視窗中心，較不準）覆蓋 —— 與 gmaps.ts 的 guard 一致
    if m and (lat is None or lng is None):
        lat, lng = m.group(1), m.group(2)
    return name, lat, lng

class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """讓 urlopen 不要自動跟隨 redirect，改由我們逐跳檢查目的地。"""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

def is_gmaps_short_url(url):
    """maps.app.goo.gl 全部算；goo.gl 是通用短網址，只有 /maps 開頭才算地圖。"""
    host = _host(url)
    if host == 'maps.app.goo.gl':
        return True
    if host == 'goo.gl':
        return (urllib.parse.urlparse(url).path or '').startswith('/maps')
    return False

def resolve_gmaps_short_url(url, max_hops=3):
    """展開 Google Maps 短網址，逐跳驗證下一站仍是 Google Maps。

    為什麼不直接用 urlopen 跟隨 redirect：goo.gl 是通用短網址，
    任何人都能做一個指向 127.0.0.1 / 169.254.169.254 的短網址丟進 LINE 群，
    排程就會替他對內網發請求（SSRF）。所以這裡跟 src/lib/gmaps.ts 一樣，
    每一跳都要確認目的地還是 Google Maps，不是就停手回原網址。
    """
    current = url
    opener = urllib.request.build_opener(_NoRedirect)
    for _ in range(max_hops):
        if not is_gmaps_short_url(current):
            return current
        try:
            req = urllib.request.Request(current, headers={
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
            })
            with opener.open(req, timeout=10) as resp:
                return current  # 沒有 redirect，就是終點
        except urllib.error.HTTPError as e:
            if e.code not in (301, 302, 303, 307, 308):
                return current
            loc = e.headers.get('Location')
            if not loc:
                return current
            nxt = urllib.parse.urljoin(current, loc)
            if not is_gmaps_url(nxt):
                return current  # 導去非 Google Maps 的地方，不跟
            print(f'  Resolved short URL -> {nxt[:80]}')
            current = nxt
        except Exception as e:
            print(f'  Short URL resolve error: {e}', file=sys.stderr)
            return current
    return current

def resolve_short_url(url):
    """Resolve short URLs (xhslink.com / maps.app.goo.gl etc.) to their final destination."""
    if is_gmaps_short_url(url):
        return resolve_gmaps_short_url(url)
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
    """Extract content from Xiaohongshu __INITIAL_STATE__ embedded JSON."""
    state_match = re.search(r'__INITIAL_STATE__\s*=\s*(\{.+?\})\s*</script>', raw, re.DOTALL)
    if not state_match:
        return None
    state_str = state_match.group(1)
    texts = []
    # Extract desc and title from embedded JSON
    desc_pat = re.compile(r'"desc"\s*:\s*"([^"]{10,})"')
    title_pat = re.compile(r'"title"\s*:\s*"([^"]{5,})"')
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
    """Fetch full page content from URL for better extraction."""
    try:
        # Resolve short URLs first
        url = resolve_short_url(url)

        # Google Maps：不抓網頁（og meta 是固定樣板，抓了只會餵垃圾給 LLM），
        # 直接把網址裡的地點名稱 + 座標當成來源文字。
        if is_gmaps_url(url):
            name, lat, lng = parse_gmaps(url)
            parts = []
            if name:
                parts.append(f'地點名稱：{name}')
            if lat and lng:
                parts.append(f'座標：{lat},{lng}')
            if parts:
                print(f'  Google Maps place from URL: {name}')
                return '\n'.join(parts)
            return None

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
            og_match = re.search(r'<meta[^>]*property=["\']og:description["\'][^>]*content=["\']([^"\'>]+)', raw)
            if og_match:
                texts.append(html.unescape(og_match.group(1)))
            og_title = re.search(r'<meta[^>]*property=["\']og:title["\'][^>]*content=["\']([^"\'>]+)', raw)
            if og_title:
                texts.append(html.unescape(og_title.group(1)))
            desc_match = re.search(r'<meta[^>]*name=["\']description["\'][^>]*content=["\']([^"\'>]+)', raw)
            if desc_match:
                texts.append(html.unescape(desc_match.group(1)))
            # JSON-LD
            ld_match = re.search(r'<script type=["\']application/ld\+json["\']>([^<]+)</script>', raw)
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

# ============================================================
# caption 清洗
# ============================================================
#
# IG 的 og:description 存進 DB 時長這樣（實測 2026-08-31，60 筆全是這個形狀）：
#   583 likes, 23 comments - 77_____eat on March 26, 2026: &quot;&#x53f0;&#x5357;...&quot;.
# 兩個問題：① numeric entity 沒還原，中文全是 &#x53f0; ② 前面黏著 likes/comments 殼。
# 對「一篇多店」殺傷力最大 —— 模型看到的是一堆 &#x…; 而不是店名。
# 這裡在送進 LLM 之前清一次；歷史資料另有 tools/backfill-descriptions.py 回填。

_IG_SHELL_PATTERNS = (
    # 英文版：「583 likes, 23 comments - handle on March 26, 2026: "」
    re.compile(
        r'^\s*[\d.,]+\s*[KkMm]?\s*likes?\s*,\s*[\d.,]+\s*[KkMm]?\s*comments?\s*[-–—]\s*'
        r'.{1,120}?\s+on\s+[A-Za-z]+\s+\d{1,2},\s*\d{4}\s*:\s*[""«]?',
        re.MULTILINE,
    ),
    # 繁中版：「583 個讚，23 則留言 - handle 於 2026 年 3 月 26 日：「」
    re.compile(
        r'^\s*[\d.,]+\s*[KkMm]?\s*個讚\s*[，,]\s*[\d.,]+\s*[KkMm]?\s*則留言\s*[-–—]\s*'
        r'.{1,120}?於\s*\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日\s*[：:]\s*[「""]?',
        re.MULTILINE,
    ),
)

_IG_TAIL = re.compile(r'\s*[""»」]\s*\.?\s*$')


def clean_caption(text):
    """把 IG／小紅書描述還原成人看得懂的 caption：解 HTML entity + 剝掉平台殼。

    不做的事：不截斷、不刪 hashtag（hashtag 常含地名，對 city/district 判讀有用）。
    """
    if not text:
        return text
    s = html.unescape(text)
    for pat in _IG_SHELL_PATTERNS:
        s = pat.sub('', s)
    s = _IG_TAIL.sub('', s)

    # 存進 DB 的描述是「og:title 換行 og:description」，而 og:title 就是 caption 的第一行，
    # 清完殼之後會變成同一句連著出現兩次 → 去掉重複的那一行。
    lines = s.split('\n')
    if len(lines) >= 2:
        head = lines[0].strip().rstrip('.… ')
        nxt = lines[1].strip()
        if len(head) >= 6 and nxt.startswith(head[:min(len(head), 12)]):
            lines = lines[1:]
    return '\n'.join(lines).strip()


def _build_extract_prompt(title, description, page_text):
    """Build the extraction prompt. Shared by Gemini + Ollama."""
    sources = []
    if page_text:
        sources.append(f'網頁內容：{clean_caption(page_text)[:3000]}')
    if description:
        # 上限拉到 4000：清單型貼文的店家散落在整篇 caption，舊的 600 字會直接砍掉後面 7 家。
        desc_clean = clean_caption(description)
        if len(desc_clean) > 4000:
            desc_clean = desc_clean[:4000]
        sources.append(f'描述：{desc_clean}')
    if title:
        sources.append(f'標題：{html.unescape(title)}')

    all_text = '\n'.join(sources) if sources else '無'

    # 2026-04-24 prompt 升級（配合 Gemini 2.5 Flash 能力）：
    # - 加入「地標 → 行政區」推理規則（西子灣→鼓山區、逢甲→西屯區 等）
    # - 強化 place_type 判斷（「以為 X 實際 Y」類誘餌句式要挑出真正類型）
    return f'''你是台灣餐廳 / 景點 / 旅遊地點資訊提取助手。從以下文字中提取結構化資訊。

{all_text}

⚠️ 這篇文字可能介紹**一家店**，也可能是「台南必吃 8 家」這種**清單型貼文**。
請先判斷有幾家，再把每一家各自輸出成一個物件放進 places 陣列。

【什麼情況要輸出多個地點】
- 文字裡明確列出兩家以上**不同的店家 / 景點名稱**，常見格式：
  「1. 店名 …… 2. 店名」「①店名」「📍店名」「▍店名」「店名｜地址」「其之一：店名」
  或每段開頭一個店名、後面接地址／營業時間。
- 判準：把候選名稱抽出來後，**它們各自是不是能單獨用 Google Maps 找到的地點**？是 → 各自一筆。

【什麼情況只能輸出一個地點】（誤拆比漏拆嚴重，拿不準就只回一家）
- 整篇在講同一家店，只是列了很多**菜色 / 品項 / 套餐**（「戰斧豬排」「焦糖可頌」不是店）。
  ⚠️ 特別注意 1️⃣2️⃣3️⃣ 或 1. 2. 3. 後面接的是**菜名加價錢**（例「1️⃣脆皮鴨胸 NTD 890」）
  → 那是菜單不是店家清單，只回一家。
- 候選只是 hashtag（#高雄美食 #台南小吃）、標註帳號（@xxx）、縣市／商圈／街道名。
- 同一家店的不同寫法（中英文名、全名與簡稱）→ 合併成一筆，不要拆。

【同品牌分店】
- 文中把**兩家分店各自列出地址／營業時間** → 各自一筆，店名要帶分店名
  （例「鸚鵡螺餐酒館 左營富國店」「鸚鵡螺餐酒館 鹽埕五福店」）。
- 只順口提一句「另有 XX 店」、沒有地址 → 只留實際去的那一家。

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

- **confidence**：**這一家**提取結果的信心（0.0-1.0），每家各自給。
  - 店名明確 + 地址明確 + 類型清楚 → 0.9
  - 店名有但地址靠推理（地標→行政區）→ 0.8
  - 店名靠猜或文字模糊 → < 0.4

- **note**：這一家的一句話重點（≤30 字，例如招牌菜或特色）。沒有就填 null。

回傳格式（純 JSON，**一定要有 places 陣列**，只有一家就放一個元素）：
{{"places": [
  {{"place_name": "...", "city": "...", "district": "...", "place_type": "...", "confidence": 0.9, "note": "..."}}
]}}

多家的例子（清單型貼文）：
{{"places": [
  {{"place_name": "阿明豬心冬粉", "city": "台南", "district": "中西區", "place_type": "restaurant", "confidence": 0.9, "note": "招牌豬心處理得極嫩"}},
  {{"place_name": "阿村第二代牛肉湯", "city": "台南", "district": "中西區", "place_type": "restaurant", "confidence": 0.85, "note": "溫體牛湯頭清甜"}}
]}}

順序照文字裡出現的順序。無法判斷的欄位填 null（confidence 除外，必填）。
真的一個地點都認不出來時回 {{"places": []}}。'''


def gemini_extract(title, description, page_text):
    """2026-04-24 主模型：Gemini 2.5 Flash。品質 > Ollama qwen2.5:3b，每天 1500 次免費。"""
    if not GEMINI_API_KEY:
        return None
    prompt = _build_extract_prompt(title, description, page_text)
    endpoint = f'https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}'
    payload = json.dumps({
        'contents': [{'parts': [{'text': prompt}]}],
        'generationConfig': {
            'temperature': 0.1,
            # 512 只夠一家；清單型貼文要吐 8-12 個物件，塞不下會被截斷成壞 JSON
            'maxOutputTokens': 2048,
            'responseMimeType': 'application/json',
        }
    }).encode()
    req = urllib.request.Request(endpoint, data=payload,
                                  headers={'Content-Type': 'application/json'})
    try:
        # 60s（原本 20s）：caption 上限拉到 4000 字、輸出從 1 家變成最多 12 家，
        # 2.5 Flash 想加吐的時間實測會超過 20s，逾時就整批 fallback 到 3b 小模型，很虧。
        with urllib.request.urlopen(req, timeout=60) as resp:
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
                # 2026-04-24 修 codex-review P1：原 regex r'\{[^{}]*\}' 不支援 nested JSON
                # 改成「第一個 { 到最後一個 }」的 slice，處理 nested + pretty-printed
                s = text.find('{'); e = text.rfind('}')
                if s != -1 and e > s:
                    try:
                        return json.loads(text[s:e+1])
                    except json.JSONDecodeError:
                        pass
                print(f'  Gemini: unparseable JSON: {text[:100]}', file=sys.stderr)
    except urllib.error.HTTPError as e:
        body = ''
        # 2026-04-24 修 codex-review P1：bare except 會吞 KeyboardInterrupt/SystemExit，改 Exception
        try: body = e.read().decode('utf-8', errors='ignore')[:200]
        except Exception: pass
        print(f'  Gemini HTTP {e.code}: {body}', file=sys.stderr)
    except Exception as e:
        print(f'  Gemini error: {e}', file=sys.stderr)
    return None


def ollama_extract(title, description, page_text):
    """Fallback：Ollama qwen2.5:3b。Gemini 不可用 / 被限流時用。"""
    prompt = _build_extract_prompt(title, description, page_text)
    payload = json.dumps({
        'model': OLLAMA_MODEL,
        'prompt': prompt,
        'stream': False,
        'format': 'json',
        # 同 gemini：多地點的輸出比單店長很多，300 會被截斷
        'options': {'temperature': 0.1, 'num_predict': 1200}
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
                # 同 gemini_extract：改 slice 處理 nested JSON（P1 fix）
                s = text.find('{'); e = text.rfind('}')
                if s != -1 and e > s:
                    try:
                        return json.loads(text[s:e+1])
                    except json.JSONDecodeError:
                        pass
    except Exception as e:
        print(f'  Ollama error: {e}', file=sys.stderr)
    return None


def extract_place_info(title, description, page_text):
    """主入口：Gemini 2.5 Flash first，失敗 fallback Ollama qwen2.5:3b。"""
    # 2026-04-24 修 codex-review P2：key 未設時明確 log「skipped」不說「failed」
    if not GEMINI_API_KEY:
        print('  [gemini skipped (no API key), using ollama]')
    else:
        result = gemini_extract(title, description, page_text)
        if result:
            print('  [extracted by gemini]')
            return result
        print('  [gemini failed, fallback ollama]')
    # Fallback Ollama
    result = ollama_extract(title, description, page_text)
    if result:
        print('  [extracted by ollama]')
    return result


# ============================================================
# 一篇貼文 → 多個地點
# ============================================================

VALID_PLACE_TYPES = (
    'restaurant', 'cafe', 'bar', 'hotel', 'attraction',
    'bakery', 'dessert', 'nightmarket', 'other',
)

# 明顯不是店名的候選：hashtag / 標註帳號 / 純縣市名。模型偶爾還是會吐這些，兜底擋掉。
_NON_PLACE = re.compile(r'^[#@]|^(台|臺)[北中南東]$|^高雄$|^新北$')


def _clamp_confidence(value, default=0.5):
    try:
        return max(0.0, min(1.0, float(value)))
    except (ValueError, TypeError):
        return default


def normalize_places(result):
    """把 LLM 回的東西正規化成 place dict 陣列。

    吃三種形狀：新的 {"places": [...]}、{"places": {...}}、以及舊的單一物件
    {"place_name": ...}（Ollama 偶爾會不照新格式回，舊格式必須繼續能用，
    否則模型一退化就整條管線壞掉）。
    """
    if not isinstance(result, dict):
        return []

    raw = result.get('places')
    if isinstance(raw, dict):
        raw = [raw]
    elif not isinstance(raw, list):
        raw = [result] if ('place_name' in result or 'confidence' in result) else []

    out, seen = [], set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        name = item.get('place_name')
        name = name.strip() if isinstance(name, str) else None
        if name and (len(name) > 40 or _NON_PLACE.match(name)):
            name = None

        key = name.lower() if name else None
        if key and key in seen:
            continue
        if key:
            seen.add(key)

        city = item.get('city')
        city = re.sub(r'[市縣]$', '', city.strip()) if isinstance(city, str) and city.strip() else None
        district = item.get('district')
        district = district.strip() if isinstance(district, str) and district.strip() else None
        place_type = item.get('place_type')
        place_type = place_type if place_type in VALID_PLACE_TYPES else None
        note = item.get('note')
        note = note.strip()[:60] if isinstance(note, str) and note.strip() else None

        out.append({
            'place_name': name,
            'city': city,
            'district': district,
            'place_type': place_type,
            'confidence': _clamp_confidence(item.get('confidence')),
            'note': note,
        })

    # 沒名字的項目只在「整篇就只認出一個地點」時有意義（照舊只補 city/type 給原書籤）；
    # 拆多筆的時候沒名字＝沒辦法產生 Google Maps 連結，直接丟掉。
    if len(out) > 1:
        out = [p for p in out if p['place_name']]
    return out[:MAX_PLACES]


def maps_search_url(place):
    """拆出來的地點自己的連結。

    刻意用 Google Maps 搜尋網址而不是 Places API：① 不用 API key、不用配額
    ② 由「店名＋縣市＋行政區」決定，同一家店算出來一定一樣 → 直接靠現有的
    unique (group_id, url) 擋掉「同一篇同一家店重複收」。格式與網頁上那顆
    📍 Google Maps 按鈕（ClientApp.tsx）一致。
    """
    query = ' '.join(x for x in (place['place_name'], place['city'], place['district']) if x)
    return 'https://www.google.com/maps/search/' + urllib.parse.quote(query, safe='')


def insert_place_bookmark(parent, place, source_url):
    """把拆出來的地點寫成一筆新書籤。回傳 True 表示真的新增了一筆。

    衝突處理走 on_conflict + ignore-duplicates：同一篇被重貼、或同一家店已經
    被收過時，PostgREST 直接略過不報錯（回傳空陣列），所以這個函式可以重複跑。
    """
    if DRY_RUN:
        print(f'    [dry-run] 會新增：{place["place_name"]}｜{place["city"] or "?"} '
              f'{place["district"] or ""}｜{place["place_type"]}｜conf={place["confidence"]}'
              f'｜{place["note"] or ""}')
        print(f'              url={maps_search_url(place)}')
        return True

    row = {
        'group_id': parent.get('group_id'),
        'created_by': parent.get('created_by'),
        'url': maps_search_url(place),
        'source_url': source_url,
        'platform': parent.get('platform'),
        'title': place['place_name'],
        'description': place['note'],
        'city': place['city'],
        'district': place['district'] or place['city'],
        'place_type': place['place_type'],
        'confidence': place['confidence'],
        'enriched_at': 'now()',
    }
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
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            created = json.loads(resp.read() or b'[]')
            if created:
                print(f'    + {place["place_name"]}（{place["city"] or "?"} {place["district"] or ""}）')
                return True
            print(f'    = {place["place_name"]} 已存在，略過')
            return False
    except urllib.error.HTTPError as e:
        body = ''
        try:
            body = e.read().decode('utf-8', errors='ignore')[:200]
        except Exception:
            pass
        print(f'    ! 新增 {place["place_name"]} 失敗 HTTP {e.code}: {body}', file=sys.stderr)
    except Exception as e:
        print(f'    ! 新增 {place["place_name"]} 失敗：{e}', file=sys.stderr)
    return False


def check_duplicate(bookmark_id, title, city):
    """Check if another bookmark has the same title + city. Returns duplicate ID or None."""
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
    """Add a tag to bookmark's tags array if not already present."""
    if DRY_RUN:
        print(f'  [dry-run] 會加標籤 {bookmark_id[:8]}: {new_tag}')
        return
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
    """Patch bookmark in Supabase."""
    updates['enriched_at'] = 'now()'

    if DRY_RUN:
        print(f'  [dry-run] 會更新 {bookmark_id[:8]}: {json.dumps(updates, ensure_ascii=False)}')
        return True

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
    """Download image and upload to Supabase Storage. Returns public URL or None."""
    if DRY_RUN:
        print(f'  [dry-run] 會上傳封面圖 {bookmark_id[:8]}')
        return None
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
created = 0   # 清單型貼文拆出來、實際新增的書籤數

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
    places = normalize_places(result)
    if not places:
        # Mark as processed with low confidence so it retries next time (up to 3 attempts)
        if old_confidence is None:
            update_bookmark(bid, {'confidence': 0.1})
            print(f'  No result, set confidence=0.1 for retry')
        else:
            update_bookmark(bid, {'confidence': 0.6})
            print(f'  No result on retry, marking as done')
        continue

    # 第一個地點蓋回原本這筆書籤（行為與單店時代完全相同），其餘的另外開新書籤。
    primary = places[0]
    extras = places[1:]

    # 只有「還沒被拆過的貼文本人」才准拆：
    #   source_url is null → 一般單店書籤，第一次判定
    #   source_url == url  → 這筆就是貼文本人（拆過一次，重跑時要能補新的地點）
    # 反過來說，拆出來的子書籤（url 是 Google Maps 連結、source_url 是貼文）永遠不會再拆，
    # 否則重新辨識一次就會多長出一批分身。
    parent_source = bm.get('source_url') or None
    can_split = HAS_SOURCE_URL and url and (parent_source is None or parent_source == url)
    if extras and not can_split:
        if not HAS_SOURCE_URL:
            reason = 'source_url 欄位還沒建立'
        elif not url:
            reason = '這筆書籤沒有 url，拆出來也連不回原貼文'
        else:
            reason = '這筆是拆出來的子書籤'
        print(f'  找到 {len(places)} 個地點但不拆（{reason}），只取第一個')
        extras = []

    updates = {}
    confidence = primary['confidence']
    updates['confidence'] = confidence

    # Update title if the model found a better place name (only if confident enough)
    place_name = primary['place_name']
    if place_name and place_name != title and confidence >= 0.5:
        updates['title'] = place_name
        print(f'  Title: {title[:30]} -> {place_name}')
    elif place_name and confidence < 0.5:
        print(f'  Title skipped (low confidence {confidence}): {place_name}')

    # Update city
    if primary['city'] and primary['city'] != bm.get('city'):
        updates['city'] = primary['city']
        print(f'  City: {primary["city"]}')

    # Update district (fallback to city if not detected)
    if primary['district']:
        if primary['district'] != bm.get('district'):
            updates['district'] = primary['district']
            print(f'  District: {primary["district"]}')
    elif not bm.get('district'):
        fallback_city = updates.get('city') or bm.get('city') or ''
        if fallback_city:
            updates['district'] = fallback_city
            print(f'  District (fallback to city): {fallback_city}')

    # Update place_type
    if primary['place_type'] and primary['place_type'] != bm.get('place_type'):
        updates['place_type'] = primary['place_type']
        print(f'  Type: {primary["place_type"]}')

    # 清單型貼文：原書籤自己也要標上 source_url，網頁才知道它跟拆出來的那幾筆是同一篇。
    if extras:
        updates['source_url'] = url

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

        # 清單型貼文：把第 2 家以後各自寫成一筆書籤，全部指回同一個 source_url
        if extras:
            print(f'  清單型貼文，另外拆出 {len(extras)} 個地點：')
            for place in extras:
                if insert_place_bookmark(bm, place, url):
                    created += 1

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

print(f'Done: {enriched}/{len(bookmarks)} enriched, {created} extra places created')
