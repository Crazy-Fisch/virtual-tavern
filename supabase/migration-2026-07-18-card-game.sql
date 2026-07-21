-- Migration for installs created from a schema.sql older than 2026-07-18
-- (fresh installs just run schema.sql and skip this file).
-- Paste into the Supabase SQL editor and run once.
--
-- What changes:
--   * world_objects.open (boolean) -> world_objects.data (jsonb) — world objects
--     now carry structured state (cards, zones, tokens), keyed by id prefix.
--   * world_objects gains a DELETE policy (removing a card deletes its row).
--   * chat_messages gains a kind column: 'chat' (typed) vs 'action' (history).

alter table public.world_objects add column data jsonb;
update public.world_objects set data = jsonb_build_object('open', open);
alter table public.world_objects alter column data set not null;
alter table public.world_objects drop column open;

create policy "world_delete" on public.world_objects
  for delete to authenticated using (true);

alter table public.chat_messages
  add column kind text not null default 'chat' check (kind in ('chat', 'action'));
