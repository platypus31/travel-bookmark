-- 2026-08-31 — 一篇貼文 → 多個地點書籤（新增 bookmarks.source_url）
--
-- 要解決什麼：
-- IG / 小紅書常見「台南必吃 8 家」這種清單型貼文，一篇裡面有 8 家店。
-- 以前一篇貼文只能存成一筆書籤（因為 unique (group_id, url)），
-- 第二家以後貼過去會被當成重複，看起來像沒反應。
--
-- 怎麼改：
--   url        = 這筆書籤自己要開的連結
--                · 第一筆（貼文本人）＝ 來源貼文網址（跟以前完全一樣）
--                · 拆出來的第 2 家以後 ＝ 該店的 Google Maps 搜尋連結
--   source_url = 來源貼文網址。清單型貼文拆出來的每一筆都填同一個值，
--                網頁就靠它把「這 8 家來自同一篇」群組起來、並連回原貼文。
--                單店貼文維持 null（＝以前的行為，不受影響）。
--
-- 用法：Supabase Dashboard → 左邊 SQL Editor → New query → 全選貼上 → Run
-- 安全：只加欄位與索引，不動任何既有資料、不動任何 constraint（跑兩次也沒關係）
-- 順序：如果 2026-08-31-add-googlemaps-platform.sql 還沒跑，請先跑那支再跑這支
--       （兩支互不相干，只是先跑 googlemaps 那支才能收 Google Maps 連結）

-- ============================================================
-- 1. 新增欄位（nullable，既有列自動是 null，不會壞）
-- ============================================================

alter table bookmarks add column if not exists source_url text;

comment on column bookmarks.source_url is
  '來源貼文網址。清單型貼文（一篇多家店）拆出來的每一筆都填同一個值，用來群組顯示並連回原貼文；單店收藏為 null。';

-- ============================================================
-- 2. 群組查詢用的索引（只索引有值的列，單店收藏不佔空間）
-- ============================================================

create index if not exists bookmarks_group_source_url_idx
  on bookmarks (group_id, source_url)
  where source_url is not null;

-- ============================================================
-- 3. ⚠️ 刻意「不」動 unique (group_id, url) —— 這不是漏掉，是決定
-- ============================================================
--
-- 一開始想過把唯一鍵改成 (group_id, source_url, title) 之類，最後沒改，三個理由：
--
-- (a) 不需要改就能容納「一篇多店」。
--     拆出來的每一家 url 是「該店自己的 Google Maps 搜尋連結」，本來就各自不同，
--     8 家 = 8 個不同的 url，現有唯一鍵完全容納得下。
--
-- (b) 「同一篇貼文同一家店不該重複收」已經被現有唯一鍵擋住。
--     Google Maps 搜尋連結是由「店名＋縣市＋行政區」決定的，同一家店算出來的網址一樣
--     → 撞 unique (group_id, url) → 不會重複建。
--     而整篇貼文被重貼第二次時，第一筆的 url 就是貼文網址本身 → 一樣撞唯一鍵 →
--     LINE Bot 回「已經收藏過了」，也就不會再拆一次，不會產生 8 份分身。
--
-- (c) 🔴 動它會當場弄壞線上的 LINE Bot。
--     Bot 寫入走的是 RPC insert_bookmark_from_bot（函式本體只存在線上 DB，repo 裡沒有），
--     它靠「衝突時回傳既有那筆」來判斷重複；那段幾乎確定是 on conflict (group_id, url)。
--     把這個 unique 拿掉，on conflict 會找不到對應的唯一索引而直接報錯，
--     所有收藏都會失敗。這個風險換不到任何好處，所以不動。
--
-- 唯一鍵若真的哪天要改，必須連 RPC 本體一起改，而且要先把 RPC 現況匯出來看。

-- ============================================================
-- 驗證（跑完貼這段，應該看到 source_url 欄位與索引都在）：
-- ============================================================
-- select column_name, data_type, is_nullable
-- from information_schema.columns
-- where table_name = 'bookmarks' and column_name = 'source_url';
--
-- select indexname from pg_indexes
-- where tablename = 'bookmarks' and indexname = 'bookmarks_group_source_url_idx';
