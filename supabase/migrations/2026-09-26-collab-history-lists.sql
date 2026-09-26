-- 2026-09-26 — 協作三功能：①誰上傳 ②誰編輯＋編輯歷史 ③個人清單
--
-- 背景（本次執行前用唯讀連線 SUPABASE_DB_URL 實測線上 DB，非憑印象猜）：
--   · profiles 線上實際欄位只有 id/display_name/group_id/created_at（沒有 line_user_id！
--     supabase-schema.sql 裡寫的 line_user_id 從未真的建到線上，又是一次 schema drift）。
--   · bookmarks.created_by 早就存在且可自由傳任意 profile id
--     （insert_bookmark_from_bot 這支 RPC 完全沒有寫死，p_created_by 直接塞進去），
--     所以「誰上傳」不需要改 RPC 簽名，只需要 webhook 端改傳「真人 profile id」
--     取代目前寫死的 LINE_DEFAULT_USER_ID（線上唯一一筆 profile 是「鴨嘴獸」機器人帳號）。
--   · profiles 的 RLS 是舊的 email-OTP 認證殘骸（auth.uid() 為主，AuthForm/SetupProfile.tsx
--     兩支元件目前完全沒有被任何頁面 import，是半成品死碼），anon key 讀不到、寫不到 profiles。
--     本檔刻意不改 profiles 的既有 4 條政策（紅線：不放寬 RLS），改用 SECURITY DEFINER
--     函式當唯一存取窗口——這正是本專案 insert_bookmark_from_bot 已經在用的既有模式，
--     不是新發明的繞法。
--   · bookmarks / groups 目前對 anon key 已經是事實上的全讀全寫（4 條 anon_* 政策
--     + allow insert），本檔新增的 lists / list_items / bookmark_edits / list_edits
--     四張表比照 bookmarks 現有的開放程度（allow all 風格），沒有比現況更寬鬆。
--   · 身分模型（2026-09-26 討論定案）：profiles 完全由 LINE webhook 建立/更新
--     （get_or_create_profile_by_line，依 LINE userId 對應），網頁「選名字」只能
--     從既有名單挑一個（list_group_members），不提供網頁端自由新增名字。這是
--     君子協定不是登入系統——任何人都能選別人的名字，資料庫層級沒有辦法驗證
--     「你選的名字真的是你」。詳見 docs/collab-design.md。
--
-- 用法：Supabase Dashboard → SQL Editor → New query → 全選貼上 → Run。
-- 冪等：整份可重複執行（drop if exists / create if not exists / or replace）。
-- 相容舊資料：新欄位全部 nullable，舊的 477 筆 bookmarks 不需回填也能正常顯示
-- （created_by 舊資料是「鴨嘴獸」bot profile，前端顯示「由 鴨嘴獸 上傳」；
--   updated_by 舊資料是 null，前端不顯示「最後編輯」那一段）。

-- ============================================================
-- 1. profiles：補 line_user_id（LINE webhook 用來對應真人）
-- ============================================================

alter table profiles add column if not exists line_user_id text;

drop index if exists profiles_line_user_id_key;
create unique index if not exists profiles_line_user_id_key
  on profiles (line_user_id)
  where line_user_id is not null;

-- ============================================================
-- 2. bookmarks：加 updated_by（最後編輯者）
-- ============================================================

alter table bookmarks add column if not exists updated_by uuid references profiles(id) on delete set null;

-- user_edited_at：「這次 UPDATE 是人按的」的一次性訊號，只有網頁端人工編輯會寫它。
-- 為什麼不能只靠 updated_by：PATCH 沒帶某欄位時 Postgres 沿用舊值，所以某筆被人編輯過一次後
-- updated_by 永久非 null，之後 enrich／add_tag（疑似重複）／backfill 等背景腳本改 title、tags、
-- description 時 NEW.updated_by 仍是那個人 → 機器改動會被誤記成他的手動編輯。
-- 背景腳本從不碰 user_edited_at → 新舊值相同 → trigger 判定不是人的動作。
alter table bookmarks add column if not exists user_edited_at timestamptz;

-- ============================================================
-- 3. bookmark_edits：完整編輯歷史（誰、何時、哪個欄位、舊值→新值）
-- ============================================================

create table if not exists bookmark_edits (
  id uuid primary key default gen_random_uuid(),
  bookmark_id uuid not null references bookmarks(id) on delete cascade,
  editor_id uuid references profiles(id) on delete set null,
  field text not null,
  old_value text,
  new_value text,
  created_at timestamptz not null default now()
);

create index if not exists bookmark_edits_bookmark_id_idx
  on bookmark_edits (bookmark_id, created_at desc);

alter table bookmark_edits enable row level security;

-- 只開放讀（歷史紀錄任何組員都能看），寫入一律走下面的 trigger（SECURITY DEFINER
-- 繞過 RLS，跟 insert_bookmark_from_bot 同一招）。不開放 anon insert/update/delete，
-- 避免有人直接對 bookmark_edits 塞假歷史。
drop policy if exists "allow read" on bookmark_edits;
create policy "allow read" on bookmark_edits for select using (true);

-- ------------------------------------------------------------
-- 3a. trigger：bookmarks 被 UPDATE 時，若呼叫端有帶 updated_by，
--     自動比對每個可編輯欄位的新舊值並寫進 bookmark_edits。
--
--     刻意設計：只有「本次 UPDATE 有改 user_edited_at」才記錄（見第 2 段說明）。
--     這是為了不讓 tools/enrich.sh（Ollama 自動辨識）、add_tag、backfill 等
--     背景腳本（直接用 anon key UPDATE，不碰 user_edited_at）洗版編輯歷史——
--     「誰編輯」要記的是人的動作，不是背景排程的自動補值。
-- ------------------------------------------------------------

create or replace function log_bookmark_edit()
returns trigger
language plpgsql
security definer
as $$
begin
  if NEW.updated_by is null
     or NEW.user_edited_at is not distinct from OLD.user_edited_at then
    return NEW;
  end if;

  if OLD.title is distinct from NEW.title then
    insert into bookmark_edits (bookmark_id, editor_id, field, old_value, new_value)
    values (NEW.id, NEW.updated_by, 'title', OLD.title, NEW.title);
  end if;

  if OLD.description is distinct from NEW.description then
    insert into bookmark_edits (bookmark_id, editor_id, field, old_value, new_value)
    values (NEW.id, NEW.updated_by, 'description', OLD.description, NEW.description);
  end if;

  if OLD.city is distinct from NEW.city then
    insert into bookmark_edits (bookmark_id, editor_id, field, old_value, new_value)
    values (NEW.id, NEW.updated_by, 'city', OLD.city, NEW.city);
  end if;

  if OLD.district is distinct from NEW.district then
    insert into bookmark_edits (bookmark_id, editor_id, field, old_value, new_value)
    values (NEW.id, NEW.updated_by, 'district', OLD.district, NEW.district);
  end if;

  if OLD.place_type is distinct from NEW.place_type then
    insert into bookmark_edits (bookmark_id, editor_id, field, old_value, new_value)
    values (NEW.id, NEW.updated_by, 'place_type', OLD.place_type, NEW.place_type);
  end if;

  if OLD.visited is distinct from NEW.visited then
    insert into bookmark_edits (bookmark_id, editor_id, field, old_value, new_value)
    values (NEW.id, NEW.updated_by, 'visited', OLD.visited::text, NEW.visited::text);
  end if;

  if OLD.tags is distinct from NEW.tags then
    insert into bookmark_edits (bookmark_id, editor_id, field, old_value, new_value)
    values (
      NEW.id, NEW.updated_by, 'tags',
      array_to_string(OLD.tags, ', '),
      array_to_string(NEW.tags, ', ')
    );
  end if;

  return NEW;
end;
$$;

drop trigger if exists bookmark_edits_trigger on bookmarks;
create trigger bookmark_edits_trigger
  after update on bookmarks
  for each row
  execute function log_bookmark_edit();

-- ============================================================
-- 4. lists + list_items：個人清單／分類（大 pool 共用，多對多，不複製資料）
--
-- 2026-09-26 需求二次修正後定案：lists 就是「分類」，不是個人專屬地盤——
-- 同群組任何人都能建立、改名、加入/移出項目；沒有 owner 限制、沒有協作開關。
-- created_by／added_by 純粹是「這是誰做的」的紀錄欄位，不是權限欄位。
-- ============================================================

create table if not exists lists (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references groups(id) on delete cascade,
  -- 純紀錄用：誰建立了這個分類。不是權限欄位——任何組員都能改名/刪除任何清單。
  created_by uuid references profiles(id) on delete set null,
  name text not null,
  created_at timestamptz not null default now()
);

create index if not exists lists_group_id_idx on lists (group_id);
create index if not exists lists_created_by_idx on lists (created_by);

create table if not exists list_items (
  list_id uuid not null references lists(id) on delete cascade,
  bookmark_id uuid not null references bookmarks(id) on delete cascade,
  added_at timestamptz not null default now(),
  -- 這筆是誰加進清單的，清單項目顯示「X 加入」。
  added_by uuid references profiles(id) on delete set null,
  primary key (list_id, bookmark_id)
);

create index if not exists list_items_bookmark_id_idx on list_items (bookmark_id);

alter table lists enable row level security;
alter table list_items enable row level security;

-- 比照 bookmarks 現有的開放程度（anon 全讀全寫），不比現況更寬鬆：
-- 這兩張表本來就設計成「同群組任何人都能編輯」，不需要額外收緊。
drop policy if exists "allow all" on lists;
create policy "allow all" on lists for all using (true) with check (true);

drop policy if exists "allow all" on list_items;
create policy "allow all" on list_items for all using (true) with check (true);

-- ============================================================
-- 4a. list_edits：清單變動紀錄（新增/移除/改名項目）
--
-- 選「在 RPC 裡寫入」而不是 trigger：remove/rename 這幾個動作「是誰做的」
-- 只有呼叫端知道，trigger 拿不到呼叫者身份（除非另外用 session variable 傳，
-- 等於又多一套機制）。三個動作類型統一走 list_add_item / list_remove_item /
-- list_rename 這三支 SECURITY DEFINER RPC，變動 + 寫歷史在同一支函式、同一顆
-- Postgres 交易裡完成（要嘛都成功要嘛都失敗），不是 trigger + API 兩套並存。
-- ============================================================

create table if not exists list_edits (
  id uuid primary key default gen_random_uuid(),
  list_id uuid not null references lists(id) on delete cascade,
  editor_id uuid references profiles(id) on delete set null,
  action text not null check (action in ('add', 'remove', 'rename')),
  bookmark_id uuid references bookmarks(id) on delete set null,
  detail text,
  created_at timestamptz not null default now()
);

create index if not exists list_edits_list_id_idx on list_edits (list_id, created_at desc);

alter table list_edits enable row level security;

-- 跟 bookmark_edits 同規格：只開放讀，寫入一律走上面說的 RPC（SECURITY DEFINER）。
drop policy if exists "allow read" on list_edits;
create policy "allow read" on list_edits for select using (true);

-- ============================================================
-- 5. SECURITY DEFINER 函式：profiles 的唯一 anon 存取窗口
--    （不改 profiles 既有 4 條 RLS 政策，這是新增的旁門，不是拆牆）
--
-- 2026-09-26 需求二次修正：身分＝LINE 名字。網頁不再提供「自由新增名字」，
-- profiles 只由 LINE webhook（get_or_create_profile_by_line）建立/更新，
-- 網頁「選名字」只能從 list_group_members 回傳的既有名單挑一個。
-- ============================================================

-- 5a. 列出某群組成員（選名字畫面 + 顯示「由 X 上傳／X 編輯／X 加入」用，
--     一律是 LINE 顯示名稱）。刻意不回傳 line_user_id／group_id，
--     前端不需要也不該看到 LINE 內部 ID。
create or replace function list_group_members(p_group_id uuid)
returns table (id uuid, display_name text, created_at timestamptz)
language sql
security definer
stable
as $$
  select p.id, p.display_name, p.created_at
  from profiles p
  where p.group_id = p_group_id
  order by p.created_at asc;
$$;

-- 5b. LINE webhook 用：依 LINE userId 找/建 profile，displayName 每次都同步更新
--     （LINE 那邊改暱稱，我們這邊也跟著更新，不會卡在第一次抓到的舊名字）。
--     這是 profiles 資料的唯一寫入來源——網頁端不再有對應的「新增名字」函式。
create or replace function get_or_create_profile_by_line(
  p_group_id uuid,
  p_line_user_id text,
  p_display_name text
)
returns profiles
language plpgsql
security definer
as $$
declare
  v_profile profiles;
begin
  insert into profiles (id, display_name, group_id, line_user_id)
  values (gen_random_uuid(), coalesce(nullif(trim(p_display_name), ''), 'LINE 使用者'), p_group_id, p_line_user_id)
  on conflict (line_user_id) where line_user_id is not null
  do update set display_name = coalesce(nullif(trim(excluded.display_name), ''), profiles.display_name)
  returning * into v_profile;

  return v_profile;
end;
$$;

grant execute on function list_group_members(uuid) to anon, authenticated;
grant execute on function get_or_create_profile_by_line(uuid, text, text) to anon, authenticated;

-- ============================================================
-- 6. 清單動作 RPC：異動 + 寫 list_edits 在同一顆交易裡完成
--
-- 沒有權限檢查（by design，見 docs/collab-design.md）：lists 是分類不是私人
-- 地盤，同群組任何人都能加入/移出/改名。actor id 由前端傳入，純粹是「誰做的」
-- 的紀錄用途，不是資安邊界——選名字本身就是君子協定，這幾支函式沒有必要
-- 假裝自己在做權限驗證。
-- ============================================================

-- 6a. 加入收藏到清單。任何組員都可以。
create or replace function list_add_item(p_list_id uuid, p_bookmark_id uuid, p_actor_id uuid)
returns void
language plpgsql
security definer
as $$
declare
  v_inserted int;
begin
  if not exists (select 1 from lists where id = p_list_id) then
    raise exception '清單不存在';
  end if;

  insert into list_items (list_id, bookmark_id, added_by)
  values (p_list_id, p_bookmark_id, p_actor_id)
  on conflict (list_id, bookmark_id) do nothing;

  get diagnostics v_inserted = row_count;
  if v_inserted > 0 then
    insert into list_edits (list_id, editor_id, action, bookmark_id)
    values (p_list_id, p_actor_id, 'add', p_bookmark_id);
  end if;
end;
$$;

-- 6b. 從清單移出收藏（不刪 bookmark 本身，只拿掉多對多關聯）。任何組員都可以。
create or replace function list_remove_item(p_list_id uuid, p_bookmark_id uuid, p_actor_id uuid)
returns void
language plpgsql
security definer
as $$
declare
  v_deleted int;
begin
  if not exists (select 1 from lists where id = p_list_id) then
    raise exception '清單不存在';
  end if;

  delete from list_items where list_id = p_list_id and bookmark_id = p_bookmark_id;

  get diagnostics v_deleted = row_count;
  if v_deleted > 0 then
    insert into list_edits (list_id, editor_id, action, bookmark_id)
    values (p_list_id, p_actor_id, 'remove', p_bookmark_id);
  end if;
end;
$$;

-- 6c. 改清單名稱。任何組員都可以。
create or replace function list_rename(p_list_id uuid, p_new_name text, p_actor_id uuid)
returns lists
language plpgsql
security definer
as $$
declare
  v_list lists;
  v_old_name text;
  v_new_name text := trim(p_new_name);
begin
  if v_new_name = '' or v_new_name is null then
    raise exception '清單名稱不能是空字串';
  end if;

  select * into v_list from lists where id = p_list_id;
  if not found then
    raise exception '清單不存在';
  end if;

  v_old_name := v_list.name;

  update lists set name = v_new_name where id = p_list_id
  returning * into v_list;

  if v_old_name is distinct from v_new_name then
    insert into list_edits (list_id, editor_id, action, detail)
    values (p_list_id, p_actor_id, 'rename', v_old_name || ' → ' || v_new_name);
  end if;

  return v_list;
end;
$$;

-- 6d. 刪除整個清單。任何組員都可以（跟其他清單動作權限一致）。
-- list_items / list_edits 都靠 FK on delete cascade 自動清掉，不需要另外處理。
create or replace function list_delete(p_list_id uuid)
returns void
language plpgsql
security definer
as $$
declare
  v_deleted int;
begin
  delete from lists where id = p_list_id;
  get diagnostics v_deleted = row_count;
  if v_deleted = 0 then
    raise exception '清單不存在';
  end if;
end;
$$;

grant execute on function list_add_item(uuid, uuid, uuid) to anon, authenticated;
grant execute on function list_remove_item(uuid, uuid, uuid) to anon, authenticated;
grant execute on function list_rename(uuid, text, uuid) to anon, authenticated;
grant execute on function list_delete(uuid) to anon, authenticated;

-- ============================================================
-- 驗證（跑完貼這幾段，確認都有東西）：
-- ============================================================
-- select column_name from information_schema.columns where table_name='profiles' and column_name='line_user_id';
-- select column_name from information_schema.columns where table_name='bookmarks' and column_name='updated_by';
-- select tablename from pg_tables where tablename in ('bookmark_edits','lists','list_items','list_edits');
-- select proname from pg_proc where proname in ('list_group_members','get_or_create_profile_by_line','log_bookmark_edit','list_add_item','list_remove_item','list_rename','list_delete');
-- select tgname from pg_trigger where tgname = 'bookmark_edits_trigger';
