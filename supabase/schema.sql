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
-- Whiteboard strokes (collaborative drawing canvas)
-- ============================================================================

create table if not exists public.strokes (
  id         uuid primary key,
  client_id  text not null,
  nickname   text not null check (char_length(nickname) between 1 and 32),
  color      text not null check (char_length(color) between 1 and 16),
  width      real not null check (width > 0 and width < 200),
  points     jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists strokes_created_at_idx on public.strokes (created_at desc);
create index if not exists strokes_client_id_idx  on public.strokes (client_id);

alter table public.strokes enable row level security;

drop policy if exists "read strokes" on public.strokes;
create policy "read strokes" on public.strokes
  for select using (true);

drop policy if exists "insert strokes" on public.strokes;
create policy "insert strokes" on public.strokes
  for insert with check (
    char_length(nickname) between 1 and 32
    and char_length(color) between 1 and 16
  );

drop policy if exists "delete strokes" on public.strokes;
create policy "delete strokes" on public.strokes
  for delete using (true);

-- Keep the most recent ~5000 strokes (auto-prune on insert).
create or replace function public.prune_strokes() returns trigger as $$
begin
  delete from public.strokes
  where id in (
    select id from public.strokes
    order by created_at desc
    offset 5000
  );
  return null;
end;
$$ language plpgsql;

drop trigger if exists prune_strokes_trigger on public.strokes;
create trigger prune_strokes_trigger
  after insert on public.strokes
  for each statement execute function public.prune_strokes();

-- Make DELETE events deliver the row id via realtime.
alter table public.strokes replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'strokes'
  ) then
    alter publication supabase_realtime add table public.strokes;
  end if;
end $$;
