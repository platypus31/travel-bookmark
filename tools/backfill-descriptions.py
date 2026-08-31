#!/usr/bin/env python3
"""一次性回填：把 bookmarks.description 裡的 HTML entity 與 IG 殼清乾淨。

為什麼要回填（不是「新的乾淨就好」）：
  網頁的搜尋框會比對 description（ClientApp.tsx 的 filters.search），
  而舊資料的描述整段是 &#x53f0;&#x5357; 這種 entity ——
  也就是說「搜披薩」永遠搜不到任何一筆的內文，這是使用者看得到的壞掉。
  實測 2026-08-31：DB 裡 52 筆有描述的書籤全部是未解碼狀態。

用法：
  python3 tools/backfill-descriptions.py            # dry-run，只印出會改什麼
  python3 tools/backfill-descriptions.py --apply    # 真的寫回（會先存備份檔）
  python3 tools/backfill-descriptions.py --restore backups/xxx.json   # 從備份還原

安全設計：
  · 預設 dry-run，要 --apply 才寫
  · --apply 一定先把「所有會被改到的列的原始 description」整包存成 JSON 備份，
    存檔失敗就中止不寫（清洗雖然不損失資訊，但覆蓋正式資料一定要有回頭路）
  · 只動 description 一個欄位，其它欄位一律不碰
  · 清完等於原值的列直接跳過，不做無意義的寫入
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / 'tools'))

ENV_FILE = REPO / '.env.local'
BACKUP_DIR = REPO / 'backups'


def load_env():
    """從 .env.local 讀 Supabase credential（與 enrich.sh 同一個來源）。"""
    if not ENV_FILE.exists():
        sys.exit(f'❌ 找不到 {ENV_FILE}')
    url = key = None
    for line in ENV_FILE.read_text(encoding='utf-8').splitlines():
        if line.startswith('NEXT_PUBLIC_SUPABASE_URL='):
            url = line.split('=', 1)[1].strip().strip('"')
        elif line.startswith('NEXT_PUBLIC_SUPABASE_ANON_KEY='):
            key = line.split('=', 1)[1].strip().strip('"')
    if not url or not key or 'YOUR_SUPABASE' in url or 'YOUR_SUPABASE' in key:
        sys.exit('❌ .env.local 裡的 Supabase credential 不完整或還是 placeholder')
    return url.rstrip('/'), key


def api(url, key, path, data=None, method='GET'):
    req = urllib.request.Request(
        f'{url}/rest/v1/{path}',
        data=json.dumps(data).encode() if data is not None else None,
        headers={
            'apikey': key,
            'Authorization': f'Bearer {key}',
            'Content-Type': 'application/json',
            'Prefer': 'return=minimal',
        },
        method=method,
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        body = resp.read()
        return json.loads(body) if body else None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true', help='真的寫回資料庫（預設只 dry-run）')
    ap.add_argument('--restore', metavar='BACKUP.json', help='從備份檔還原 description')
    args = ap.parse_args()

    supabase_url, supabase_key = load_env()

    # clean_caption 住在 enrich_places.py，那支在 import 時會讀 stdin 跑主流程，
    # 所以這裡先餵一個空陣列進去，讓它跑完 0 筆再借用函式。
    # 一定要直接賦值不能用 setdefault：SUPABASE_URL / SUPABASE_KEY 是很通用的名字，
    # 呼叫端環境若剛好已經有（別的專案、別的排程），setdefault 會靜默沿用舊值，
    # 讓這支「會寫回正式資料」的腳本打到另一個 Supabase 專案而且毫無警告。
    os.environ['SUPABASE_URL'] = supabase_url
    os.environ['SUPABASE_KEY'] = supabase_key
    import io
    import importlib.util
    real_stdin, sys.stdin = sys.stdin, io.StringIO('[]')
    spec = importlib.util.spec_from_file_location('enrich_places', REPO / 'tools' / 'enrich_places.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    sys.stdin = real_stdin
    clean_caption = module.clean_caption

    if args.restore:
        rows = json.loads(Path(args.restore).read_text(encoding='utf-8'))
        print(f'從 {args.restore} 還原 {len(rows)} 筆…')
        for row in rows:
            api(supabase_url, supabase_key, f'bookmarks?id=eq.{row["id"]}',
                {'description': row['description']}, method='PATCH')
        print('✅ 還原完成')
        return

    rows = api(supabase_url, supabase_key,
               'bookmarks?select=id,title,description&description=not.is.null&limit=1000')
    print(f'撈到 {len(rows)} 筆有描述的書籤')

    changes = []
    for row in rows:
        old = row.get('description') or ''
        new = clean_caption(old)
        if new and new != old:
            changes.append({'id': row['id'], 'title': row.get('title'), 'old': old, 'new': new})

    print(f'需要清洗的：{len(changes)} 筆')
    if not changes:
        return

    total_before = sum(len(c['old']) for c in changes)
    total_after = sum(len(c['new']) for c in changes)
    print(f'描述總長度 {total_before} → {total_after} 字元')
    for c in changes[:3]:
        print(f'  · {c["title"]}：{len(c["old"])} → {len(c["new"])}')
        print(f'    清後開頭：{c["new"][:60]}')

    if not args.apply:
        print('\n（dry-run，沒有寫入任何東西。確認 OK 後加 --apply）')
        return

    BACKUP_DIR.mkdir(exist_ok=True)
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    backup = BACKUP_DIR / f'descriptions-{stamp}.json'
    backup.write_text(
        json.dumps([{'id': c['id'], 'description': c['old']} for c in changes],
                   ensure_ascii=False, indent=1),
        encoding='utf-8',
    )
    print(f'\n📦 原值已備份到 {backup}')

    ok = 0
    for c in changes:
        try:
            api(supabase_url, supabase_key, f'bookmarks?id=eq.{c["id"]}',
                {'description': c['new']}, method='PATCH')
            ok += 1
        except urllib.error.HTTPError as e:
            detail = ''
            try:
                detail = e.read().decode('utf-8', errors='ignore')[:200]
            except Exception:
                pass
            print(f'  ! {c["title"]} 失敗 HTTP {e.code}: {detail}', file=sys.stderr)
        except Exception as e:
            print(f'  ! {c["title"]} 失敗：{e}', file=sys.stderr)

    print(f'✅ 完成 {ok}/{len(changes)} 筆')
    if ok < len(changes):
        print(f'   要全部復原：python3 tools/backfill-descriptions.py --restore {backup}')


if __name__ == '__main__':
    main()
