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

create table if not exists public.pixels (
  -- Composite-derived id lets us batch-delete by primary key.
  -- Canvas is 4000x4000, so idx = x * 4000 + y is unique and fits in bigint.
  idx        bigint generated always as ((x::bigint) * 4000 + y) stored primary key,
  x          int  not null check (x between 0 and 3999),
  y          int  not null check (y between 0 and 3999),
  color      text not null check (char_length(color) between 1 and 16),
  client_id  text not null,
  nickname   text not null check (char_length(nickname) between 1 and 32),
  updated_at timestamptz not null default now()
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
