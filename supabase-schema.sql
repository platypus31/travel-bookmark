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
  url text not null,
  platform text,
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
  unique (group_id, url)
);

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
