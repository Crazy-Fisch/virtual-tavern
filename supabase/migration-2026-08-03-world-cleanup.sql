-- Migration for installs created from a schema.sql older than 2026-08-03
-- (fresh installs just run schema.sql and skip this file).
-- Paste into the Supabase SQL editor and run once, AFTER the earlier
-- migrations (…-07-18-card-game.sql, …-07-19-polish.sql, …-08-03-room-cleanup.sql).
--
-- What changes (designdocs/moreimprovements.md — "persistance"):
--   * world_objects and chat_messages rows are guaranteed to be cleaned up
--     when their room is removed. schema.sql has always declared these FKs
--     with on delete cascade, but a database installed from an early schema
--     (or one where the constraint was dropped) can be left with rows whose
--     room no longer exists. This migration deletes any such orphans and
--     re-creates both constraints with the cascade, so close_room /
--     cleanup_stale_rooms reliably take a removed room's chat history and
--     world objects with it.

alter table public.world_objects drop constraint if exists world_objects_room_id_fkey;
alter table public.chat_messages drop constraint if exists chat_messages_room_id_fkey;

-- Orphans from rooms removed while no cascade was in place. Must go before the
-- constraints return — adding an FK validates existing rows.
delete from public.world_objects w
  where not exists (select 1 from public.rooms r where r.id = w.room_id);
delete from public.chat_messages m
  where not exists (select 1 from public.rooms r where r.id = m.room_id);

alter table public.world_objects
  add constraint world_objects_room_id_fkey
  foreign key (room_id) references public.rooms (id) on delete cascade;
alter table public.chat_messages
  add constraint chat_messages_room_id_fkey
  foreign key (room_id) references public.rooms (id) on delete cascade;
