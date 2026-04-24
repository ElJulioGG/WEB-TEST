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

-- Enable realtime (Supabase default publication).
alter publication supabase_realtime add table public.messages;
