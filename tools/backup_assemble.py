#!/usr/bin/env python3
"""把 backup.sh 抓下來的分頁 JSON 併成一份備份檔。

用法：backup_assemble.py <work_dir> <out_file> <table> [<table> ...]

work_dir 裡每個 table 有一個 "<table>.pages"，內容是每行一個分頁 JSON 檔的路徑
（backup.sh 產生）。這支只做「讀分頁 → 去重（同 id 只留一筆）→ 組成一份 dict → 寫檔」，
不連網、不碰 credential（supabase_url 從環境變數帶進來只是為了寫進備份檔當註記）。

分頁 offset 在資料同時被寫入時可能重複回傳同一列，所以用 id 去重；沒有 id 的表就全留。
"""
import json
import os
import sys
from datetime import datetime, timezone, timedelta


def load_pages(work_dir, table):
    pages_file = os.path.join(work_dir, table + ".pages")
    rows = []
    seen = set()
    with open(pages_file, "r", encoding="utf-8") as fh:
        for line in fh:
            path = line.strip()
            if not path:
                continue
            with open(path, "r", encoding="utf-8") as pf:
                data = json.load(pf)
            if not isinstance(data, list):
                raise ValueError("%s: page %s is not a list" % (table, path))
            for row in data:
                rid = row.get("id") if isinstance(row, dict) else None
                if rid is not None:
                    if rid in seen:
                        continue
                    seen.add(rid)
                rows.append(row)
    return rows


def main():
    if len(sys.argv) < 4:
        print("usage: backup_assemble.py <work_dir> <out_file> <table>...", file=sys.stderr)
        return 2
    work_dir, out_file = sys.argv[1], sys.argv[2]
    tables = sys.argv[3:]

    tz = timezone(timedelta(hours=8))  # 台灣時間
    payload = {
        "exported_at": datetime.now(tz).isoformat(),
        "supabase_url": os.environ.get("SUPABASE_URL", ""),
        "counts": {},
        "tables": {},
    }
    for table in tables:
        rows = load_pages(work_dir, table)
        payload["tables"][table] = rows
        payload["counts"][table] = len(rows)

    with open(out_file, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, ensure_ascii=False, indent=2)
        fh.write("\n")

    print("assembled: " + ", ".join("%s=%d" % (t, payload["counts"][t]) for t in tables))
    return 0


if __name__ == "__main__":
    sys.exit(main())
