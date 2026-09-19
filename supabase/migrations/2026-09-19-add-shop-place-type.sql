-- 2026-09-19 — 讓 bookmarks.place_type 接受 'shop'（商店：文具店/選物店/雜貨/書店等）
--
-- 為什麼需要這個檔：
-- supabase-schema.sql 裡 place_type 目前只寫 `text`（無約束），但 HANDOFF.md 第 5 點
-- 明確記錄了 2026-08-31 的教訓 ——「線上 DB 有 bookmarks_platform_check 這個 CHECK
-- constraint，但從來沒有寫進 schema 檔」，並提醒「以後加新的 platform / place_type
-- 值，光改 TypeScript union 不夠，要一起改 DB constraint」。
-- 本次執行環境沒有 service key，讀不到線上真實 DDL，無法確認 place_type 是否也有
-- 同類型未落檔的 CHECK constraint（schema drift）。比照 platform 的做法先補上這支
-- migration：若線上真的有 `bookmarks_place_type_check`，這支跑完就能放行 'shop'；
-- 若線上其實沒有約束（與 schema 檔一致），這支等於新增一個約束把目前允許的九種
-- 值 + shop 鎖住 —— 這與現行 TypeScript union（src/lib/types.ts 的 PlaceType）完全
-- 一致，不會擋掉任何現有資料。
--
-- 用法：Supabase Dashboard → 左邊 SQL Editor → New query → 全選貼上 → Run
-- 安全：只放寬/鎖定允許值清單，不動任何既有資料（跑兩次也沒關係）

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
    'other'
  ));

-- 驗證（應該回傳一列，且 definition 裡看得到 shop）：
-- select conname, pg_get_constraintdef(oid)
-- from pg_constraint where conname = 'bookmarks_place_type_check';
