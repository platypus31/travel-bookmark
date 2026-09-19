-- 2026-09-19 — 讓 bookmarks.place_type 接受 'drinks'（手搖：手搖飲/茶飲/果汁站等以外帶為主的飲料店）
--
-- 為什麼需要這個檔：
-- 比照同日的 supabase/migrations/2026-09-19-add-shop-place-type.sql——
-- supabase-schema.sql 裡 place_type 的 CHECK constraint 是本機 schema 檔紀錄的版本，
-- 但 HANDOFF.md 第 5 點記錄過線上 DB 曾出現 CHECK constraint 與 schema 檔不同步的
-- schema drift（bookmarks_platform_check 案例）。本次執行環境沒有 service key，讀不到
-- 線上真實 DDL，無法確認線上是否已經手動加過 'drinks'。這支 migration 用
-- drop-then-add 的寫法確保跑完後線上約束一定跟 src/lib/types.ts 的 PlaceType union
-- 一致，不論線上原本有沒有約束、原本的清單是新是舊都安全（跑兩次也沒關係）。
--
-- 用法：Supabase Dashboard → 左邊 SQL Editor → New query → 全選貼上 → Run
-- 安全：只放寬/鎖定允許值清單，不動任何既有資料
--
-- ⚠️ 執行順序：若 2026-09-19-add-shop-place-type.sql 尚未跑過，建議先跑那支，
-- 或直接跑這支也行——本檔的允許值清單已經同時包含 shop 與 drinks，效果等價。

alter table bookmarks drop constraint if exists bookmarks_place_type_check;

alter table bookmarks add constraint bookmarks_place_type_check
  check (place_type is null or place_type in (
    'restaurant',
    'cafe',
    'attraction',
    'bar',
    'hotel',
    'bakery',
    'dessert',
    'nightmarket',
    'shop',
    'drinks',
    'other'
  ));

-- 驗證（應該回傳一列，且 definition 裡看得到 drinks）：
-- select conname, pg_get_constraintdef(oid)
-- from pg_constraint where conname = 'bookmarks_place_type_check';
