-- 2026-08-31 — 讓 bookmarks.platform 接受 'googlemaps'
--
-- 為什麼需要這個檔：
-- 線上資料庫有一個 CHECK constraint `bookmarks_platform_check`，
-- 但它**從來沒有寫在 supabase-schema.sql 裡**（是當初直接在 Dashboard 加的），
-- 所以只看 repo 會以為 platform 是自由文字。實測 2026-08-31：
--   插入 platform='googlemaps' → 400 / 23514 violates check constraint "bookmarks_platform_check"
-- 結果就是 Google Maps 連結不管從 LINE 還是網頁都存不進去。
--
-- 用法：Supabase Dashboard → 左邊 SQL Editor → New query → 全選貼上 → Run
-- 安全：只放寬允許值，不動任何既有資料（跑兩次也沒關係）

alter table bookmarks drop constraint if exists bookmarks_platform_check;

alter table bookmarks add constraint bookmarks_platform_check
  check (platform in (
    'instagram',
    'xiaohongshu',
    'youtube',
    'tiktok',
    'googlemaps',
    'other'
  ));

-- 驗證（應該回傳一列，且 definition 裡看得到 googlemaps）：
-- select conname, pg_get_constraintdef(oid)
-- from pg_constraint where conname = 'bookmarks_platform_check';
