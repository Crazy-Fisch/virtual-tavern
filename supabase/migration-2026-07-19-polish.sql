-- Migration for installs created from a schema.sql older than 2026-07-19
-- (fresh installs just run schema.sql and skip this file).
-- Paste into the Supabase SQL editor and run once, AFTER any earlier
-- migrations (migration-2026-07-18-card-game.sql).
--
-- What changes:
--   * decks table + RLS — imported decklists now persist per account instead
--     of per browser (anonymous/guest sessions cannot keep decks).
--   * get_room_by_code additionally returns the room owner's uid (room_owner),
--     which decides table seating: the creator keeps the near side, joiners
--     sit at the opposite end. Clients tolerate the old RPC (everyone seated
--     on the owner side) until this runs.

create table public.decks (
  id         uuid primary key,                           -- client-generated for optimistic writes
  owner_id   uuid not null references auth.users (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 60),
  list       jsonb not null,                             -- [{card, count}] as parsed by decklist-parser
  created_at timestamptz not null default now()
);
create index decks_owner on public.decks (owner_id);

alter table public.decks enable row level security;
create policy "decks_select" on public.decks
  for select to authenticated using (owner_id = auth.uid());
create policy "decks_insert" on public.decks
  for insert to authenticated with check (
    owner_id = auth.uid()
    and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
  );
create policy "decks_delete" on public.decks
  for delete to authenticated using (owner_id = auth.uid());

-- Return type changes, so the function must be dropped and recreated
-- (re-granting execute — drop removes the old grants).
drop function public.get_room_by_code(text);
create function public.get_room_by_code(p_code text)
returns table (room_id uuid, room_code text, room_name text, room_owner uuid)
language sql security definer set search_path = public as $$
  select r.id, r.code, r.name, r.owner_id from rooms r where r.code = upper(trim(p_code));
$$;
revoke execute on function public.get_room_by_code(text) from public, anon;
grant execute on function public.get_room_by_code(text) to authenticated;
