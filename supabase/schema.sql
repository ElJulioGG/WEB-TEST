-- Run this once in the Supabase SQL editor.

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  nickname text not null check (char_length(nickname) between 1 and 32),
  content  text not null check (char_length(content)  between 1 and 500),
  created_at timestamptz not null default now()
);

create index if not exists messages_created_at_idx on public.messages (created_at desc);

alter table public.messages enable row level security;

drop policy if exists "read messages" on public.messages;
create policy "read messages" on public.messages
  for select using (true);

drop policy if exists "insert messages" on public.messages;
create policy "insert messages" on public.messages
  for insert with check (
    char_length(nickname) between 1 and 32
    and char_length(content) between 1 and 500
  );

-- Keep only the last 500 messages (auto-prune on insert).
create or replace function public.prune_messages() returns trigger as $$
begin
  delete from public.messages
  where id in (
    select id from public.messages
    order by created_at desc
    offset 500
  );
  return null;
end;
$$ language plpgsql;

drop trigger if exists prune_messages_trigger on public.messages;
create trigger prune_messages_trigger
  after insert on public.messages
  for each statement execute function public.prune_messages();

-- Enable realtime (Supabase default publication). Guarded so the script can
-- be re-run safely; "alter publication ... add table" is not idempotent.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'messages'
  ) then
    alter publication supabase_realtime add table public.messages;
  end if;
end $$;


-- ============================================================================
-- Pixels (collaborative pixel canvas, one row per painted cell)
-- ============================================================================
-- The legacy stroke-based whiteboard is replaced by a per-pixel canvas, so we
-- drop the old table if it still exists.
drop table if exists public.strokes cascade;

-- An earlier version of the schema used a STORED GENERATED column for idx.
-- That breaks PostgREST upserts in some configs because the conflict-target
-- column cannot appear in the insert payload, so writes silently fail and
-- the canvas seems to "reset" on reload. We now compute idx on the client
-- and enforce it with a CHECK constraint, so the upsert payload is fully
-- self-contained.
--
-- The migration below drops the old table if it exists but does NOT match
-- the new shape (i.e. `idx` is generated, or our CHECK constraint is
-- missing). Existing painted pixels are recoverable from each client's
-- in-memory cache or via a manual `pg_dump` if you need them.
--
-- IMPORTANT: close every browser tab that has the whiteboard open before
-- running this script. Active SELECTs/INSERTs against pixels can deadlock
-- with the DROP TABLE.
do $$
begin
  if exists (select 1 from information_schema.tables
             where table_schema = 'public' and table_name = 'pixels')
     and (
       -- old generated-column variant
       exists (
         select 1 from pg_attribute a
         join pg_class c on c.oid = a.attrelid
         join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = 'pixels'
           and a.attname = 'idx' and a.attgenerated <> ''
       )
       -- or missing the new CHECK that proves we're on the latest shape
       or not exists (
         select 1 from pg_constraint
         where conname = 'pixels_idx_matches_xy'
       )
     )
  then
    drop table public.pixels cascade;
  end if;
end $$;

create table if not exists public.pixels (
  -- Client supplies idx = x * 4000 + y. The CHECK keeps the table consistent
  -- regardless of who's writing.
  idx        bigint primary key,
  x          int  not null check (x between 0 and 3999),
  y          int  not null check (y between 0 and 3999),
  color      text not null check (char_length(color) between 1 and 16),
  client_id  text not null,
  nickname   text not null check (char_length(nickname) between 1 and 32),
  updated_at timestamptz not null default now(),
  constraint pixels_idx_matches_xy check (idx = (x::bigint) * 4000 + y)
);

create index if not exists pixels_client_id_idx  on public.pixels (client_id);
create index if not exists pixels_updated_at_idx on public.pixels (updated_at desc);

alter table public.pixels enable row level security;

drop policy if exists "read pixels" on public.pixels;
create policy "read pixels" on public.pixels
  for select using (true);

drop policy if exists "insert pixels" on public.pixels;
create policy "insert pixels" on public.pixels
  for insert with check (
    char_length(nickname) between 1 and 32
    and char_length(color) between 1 and 16
  );

drop policy if exists "update pixels" on public.pixels;
create policy "update pixels" on public.pixels
  for update using (true) with check (
    char_length(nickname) between 1 and 32
    and char_length(color) between 1 and 16
  );

drop policy if exists "delete pixels" on public.pixels;
create policy "delete pixels" on public.pixels
  for delete using (true);

-- We do not add public.pixels to supabase_realtime: realtime sync uses
-- broadcast on the client (per-stroke batches), and the table is queried only
-- for history on join. Adding it to the publication would multiply egress.
