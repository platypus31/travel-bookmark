-- Travel Bookmark — Supabase 資料庫初始化
-- 用法：登入 Supabase Dashboard → 左邊 SQL Editor → New query → 全選貼上 → Run
-- 安全：這會建立 3 個表 + 塞入預設 group / profile，不會動到既有資料

-- ============================================================
-- 1. 建表
-- ============================================================

-- 群組表（LINE 群組對應）
create table if not exists groups (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz default now()
);

-- 使用者表
create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  line_user_id text unique,
  display_name text,
  created_at timestamptz default now()
);

-- 書籤表
create table if not exists bookmarks (
  id uuid primary key default gen_random_uuid(),
  group_id uuid references groups(id),
  created_by uuid references profiles(id),
  -- 這筆書籤自己要開的連結。清單型貼文拆出來的地點存該店的 Google Maps 搜尋連結。
  url text not null,
  -- 2026-08-31：來源貼文網址。一篇貼文多家店時，拆出來的每一筆填同一個值（群組顯示用）；
  -- 單店收藏維持 null。既有安裝請改跑 supabase/migrations/2026-08-31-add-source-url.sql
  source_url text,
  -- 2026-08-31：線上 DB 一直有這個 CHECK 但以前沒寫進本檔（schema drift），
  -- 補寫出來並加入 googlemaps。既有安裝請改跑
  -- supabase/migrations/2026-08-31-add-googlemaps-platform.sql
  platform text check (platform in (
    'instagram', 'xiaohongshu', 'youtube', 'tiktok', 'googlemaps', 'other'
  )),
  title text,
  description text,
  image_url text,
  city text,
  district text,
  place_type text,
  tags text[],
  visited boolean default false,
  confidence numeric default 0,
  enriched_at timestamptz,
  created_at timestamptz default now(),
  -- ⚠️ 這個唯一鍵是線上 RPC insert_bookmark_from_bot 的 on conflict 目標，動它會弄壞 LINE Bot。
  -- 一篇貼文多家店為什麼不用改它，見 supabase/migrations/2026-08-31-add-source-url.sql 第 3 段。
  unique (group_id, url)
);

-- 群組查詢用（只索引清單型貼文拆出來的列）
create index if not exists bookmarks_group_source_url_idx
  on bookmarks (group_id, source_url)
  where source_url is not null;

-- ============================================================
-- 2. Row Level Security
-- ============================================================

alter table groups enable row level security;
alter table profiles enable row level security;
alter table bookmarks enable row level security;

-- 簡單政策：允許所有人讀寫（自己用夠了；正式對外要改更嚴）
drop policy if exists "allow all" on groups;
drop policy if exists "allow all" on profiles;
drop policy if exists "allow all" on bookmarks;
create policy "allow all" on groups     for all using (true);
create policy "allow all" on profiles   for all using (true);
create policy "allow all" on bookmarks  for all using (true);

-- ============================================================
-- 3. 插入預設資料（LINE Bot 會寫入這個 group / user）
-- ============================================================

insert into groups (id, name)
values ('00000000-0000-0000-0000-000000000001', 'default')
on conflict (id) do nothing;

insert into profiles (id, display_name)
values ('00000000-0000-0000-0000-000000000002', 'bot')
on conflict (id) do nothing;

-- ============================================================
-- ✅ 完成！現在去拿 API 金鑰：
-- Project Settings → API → 複製 Project URL 和 anon public key
-- ============================================================
