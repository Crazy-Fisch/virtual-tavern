-- Migration for installs created from a schema.sql older than 2026-08-03
-- (fresh installs just run schema.sql and skip this file).
-- Paste into the Supabase SQL editor and run once, AFTER the earlier
-- migrations (…-07-18-card-game.sql, …-07-19-polish.sql).
--
-- What changes (designdocs/perstistance.md — closed rooms are removed):
--   * rooms.last_active — refreshed by clients while they are in the room
--     (touch_room keep-alive, every few minutes).
--   * close_room(uuid) — called by the last player leaving a room; deletes the
--     row, and the on-delete-cascade FKs take all its chat/history messages
--     and world objects with it.
--   * cleanup_stale_rooms() — backstop for players who closed the tab instead
--     of leaving: removes rooms nobody has kept alive for a day. Clients fire
--     it opportunistically on join, so no server-side scheduler is needed.
--
-- All three are security definer because non-owners cannot touch the rooms
-- table directly; knowing the room UUID is the capability, the same trust
-- model world_objects already uses (any member can already wipe the table).

alter table public.rooms add column last_active timestamptz not null default now();

create or replace function public.touch_room(p_room_id uuid)
returns void language sql security definer set search_path = public as $$
  update rooms set last_active = now() where id = p_room_id;
$$;
revoke execute on function public.touch_room(uuid) from public, anon;
grant execute on function public.touch_room(uuid) to authenticated;

create or replace function public.close_room(p_room_id uuid)
returns void language sql security definer set search_path = public as $$
  delete from rooms where id = p_room_id;
$$;
revoke execute on function public.close_room(uuid) from public, anon;
grant execute on function public.close_room(uuid) to authenticated;

create or replace function public.cleanup_stale_rooms()
returns void language sql security definer set search_path = public as $$
  delete from rooms where last_active < now() - interval '24 hours';
$$;
revoke execute on function public.cleanup_stale_rooms() from public, anon;
grant execute on function public.cleanup_stale_rooms() to authenticated;
