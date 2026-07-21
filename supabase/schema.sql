-- VirtualTavern schema — paste into the Supabase SQL editor and run once.
-- Prerequisites (Dashboard → Authentication → Sign In / Providers):
--   * Email provider enabled, "Confirm email" DISABLED
--   * Anonymous sign-ins enabled

-- ---------- room code generation (6 chars, ambiguity-free alphabet) ----------
create or replace function public.generate_room_code()
returns text language sql volatile as $$
  select string_agg(
    substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', (floor(random() * 31) + 1)::int, 1), '')
  from generate_series(1, 6);
$$;

-- ---------- tables ----------
create table public.rooms (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references auth.users (id) on delete cascade,
  code       text not null unique default public.generate_room_code(),
  name       text check (char_length(name) <= 40),
  created_at timestamptz not null default now()
);

create table public.chat_messages (
  id          uuid primary key,                          -- client-generated for optimistic dedupe
  room_id     uuid not null references public.rooms (id) on delete cascade,
  sender_id   uuid not null default auth.uid(),
  sender_name text not null check (char_length(sender_name) between 1 and 16),
  text        text not null check (char_length(text) between 1 and 500),
  -- 'chat' = typed by a user; 'action' = game history line ("<name>: <action>")
  kind        text not null default 'chat' check (kind in ('chat', 'action')),
  created_at  timestamptz not null default now()
);
create index chat_messages_room_time on public.chat_messages (room_id, created_at desc);

create table public.world_objects (
  room_id    uuid not null references public.rooms (id) on delete cascade,
  object_id  text not null check (char_length(object_id) <= 64),
  data       jsonb not null,                             -- shape depends on the id prefix (card:/zone:)
  updated_by uuid not null default auth.uid(),
  updated_at timestamptz not null default now(),
  primary key (room_id, object_id)
);

-- imported decklists, persisted per account (guests keep none — see RLS below)
create table public.decks (
  id         uuid primary key,                           -- client-generated for optimistic writes
  owner_id   uuid not null references auth.users (id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 60),
  list       jsonb not null,                             -- [{card, count}] as parsed by decklist-parser
  created_at timestamptz not null default now()
);
create index decks_owner on public.decks (owner_id);

-- server-authoritative LWW timestamp (fixes client clock skew)
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at := now();
  return new;
end $$;
create trigger world_objects_touch
before insert or update on public.world_objects
for each row execute function public.touch_updated_at();

-- ---------- RLS ----------
alter table public.rooms         enable row level security;
alter table public.chat_messages enable row level security;
alter table public.world_objects enable row level security;
alter table public.decks         enable row level security;

-- rooms: owner-only visibility; join-by-code goes through the RPC below
create policy "rooms_owner_select" on public.rooms
  for select to authenticated using (owner_id = auth.uid());
create policy "rooms_owner_insert" on public.rooms
  for insert to authenticated with check (owner_id = auth.uid());
create policy "rooms_owner_delete" on public.rooms
  for delete to authenticated using (owner_id = auth.uid());

-- chat + world: capability model — any signed-in user (incl. guests) who knows
-- the room UUID; the UUID is only obtainable via the code RPC.
create policy "chat_select" on public.chat_messages
  for select to authenticated using (true);
create policy "chat_insert" on public.chat_messages
  for insert to authenticated with check (sender_id = auth.uid());
create policy "world_select" on public.world_objects
  for select to authenticated using (true);
create policy "world_insert" on public.world_objects
  for insert to authenticated with check (updated_by = auth.uid());
create policy "world_update" on public.world_objects
  for update to authenticated using (true) with check (updated_by = auth.uid());
create policy "world_delete" on public.world_objects
  for delete to authenticated using (true);

-- decks: owner-only, and never for anonymous (guest) sessions — deck
-- persistence is an account feature.
create policy "decks_select" on public.decks
  for select to authenticated using (owner_id = auth.uid());
create policy "decks_insert" on public.decks
  for insert to authenticated with check (
    owner_id = auth.uid()
    and coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false
  );
create policy "decks_delete" on public.decks
  for delete to authenticated using (owner_id = auth.uid());

-- ---------- join-by-code RPC (security definer so rooms stay unlistable) ----------
-- room_owner decides table seating: the creator keeps the near side, joiners
-- sit opposite. Exposing the owner's uid to joiners is fine — it is the same
-- uid they already see on every chat message the owner sends.
create or replace function public.get_room_by_code(p_code text)
returns table (room_id uuid, room_code text, room_name text, room_owner uuid)
language sql security definer set search_path = public as $$
  select r.id, r.code, r.name, r.owner_id from rooms r where r.code = upper(trim(p_code));
$$;
revoke execute on function public.get_room_by_code(text) from public, anon;
grant execute on function public.get_room_by_code(text) to authenticated;

-- ---------- realtime ----------
alter table public.world_objects replica identity full;
alter publication supabase_realtime add table public.chat_messages;
alter publication supabase_realtime add table public.world_objects;
