# Persistence (room cleanup) — implementation results

Implements `perstistance.md`: it was **not already happening** — rooms (and
their chat, history and world state) lived forever. Now a room that is closed
(no players left) is removed from the database, two ways: immediately when the
last player clicks Leave, and by a stale sweep for rooms whose players just
closed the tab.

---

## What was already in place

`chat_messages` and `world_objects` both reference `rooms (id)` with
**`on delete cascade`**, so deleting the room row was always going to take the
chat/history entries and the world snapshot with it. What was missing was
anything that ever deleted a room.

## The immediate path: the last player leaving closes the room

The room's existing realtime channel now also carries **Supabase presence**:

- On join, `RoomService.enterRoom` configures the channel with a **per-tab
  presence key** (`crypto.randomUUID()` — two tabs of the same account count
  as two players) and `track()`s itself once subscribed.
- An explicit `leave()` checks, before tearing the channel down, whether
  presence shows **only this tab** on the channel. If so, it fires the new
  `close_room` RPC; the cascades do the rest.
- Deletion is deliberately conservative: if presence never synced (dead
  realtime connection, instant join/leave), the check reports "not alone" and
  the room is left to the stale sweep rather than pulled out from under
  players the client couldn't see.

A page reload never runs `leave()` (that has always been the resume
mechanism), so reloading cannot close a room. If two players leave in the same
instant, each may see the other still present and nobody deletes — the sweep
is the backstop for that rare race too.

## The backstop: stale rooms are swept

Closing the tab skips `leave()`, so those rooms need a liveness signal:

- **`rooms.last_active`** (new column, default `now()`): stamped by the
  `touch_room` RPC on every join and then every **5 minutes** by a heartbeat
  interval while the client stays in the room.
- **`cleanup_stale_rooms`** deletes every room whose `last_active` is older
  than **24 hours**. There is no server-side scheduler (free tier, zero ops):
  clients fire it opportunistically after joining a room — join first stamps
  the joined room, *then* sweeps, so the sweep can never race the room being
  entered.

The 24 h window is deliberate: the resume feature stores the room across
browser restarts, and a player who shuts the laptop mid-game should find the
room again the next day. While any tab is open the heartbeat keeps the room
alive indefinitely, so long sessions are never at risk.

## Database changes

`supabase/migration-2026-08-03-room-cleanup.sql` (existing installs — **must
be run in the cloud DB**) and the same additions in `schema.sql` (fresh
installs):

- `alter table rooms add column last_active timestamptz not null default now()`
- `touch_room(uuid)`, `close_room(uuid)`, `cleanup_stale_rooms()` — all
  `security definer` (non-owners cannot touch the `rooms` table under its RLS)
  and granted to `authenticated` only. Any room member being able to close a
  room is the same capability trust model the world objects already use — the
  room UUID is unguessable and whoever has it can already wipe the table.

## Files touched

| File                                              | Change                                                                     |
| ------------------------------------------------- | -------------------------------------------------------------------------- |
| `supabase/migration-2026-08-03-room-cleanup.sql`  | New migration: `last_active` + the three lifecycle RPCs                     |
| `supabase/schema.sql`                             | Same additions for fresh installs                                           |
| `src/app/room/room.service.ts`                    | Presence key + `track`, last-out `close_room` on `leave()`, join-time touch + sweep, heartbeat |
| `src/app/room/room.service.spec.ts`               | Channel stub grew presence/track; 5 new lifecycle tests                     |
| `CLAUDE.md`                                       | Room lifecycle documented in the RoomService section; latest-migration note |

## Tests

`room.service.spec.ts`, new `describe('room lifecycle')` (23 tests total in
the suite, all green):

- The last player leaving calls `close_room` with the room id.
- Leaving while someone else is present does not.
- Leaving before presence ever synced does not (sweep territory).
- Joining tracks presence with a per-tab key, stamps `touch_room`, then fires
  `cleanup_stale_rooms`.
- The heartbeat stamps again after 5 minutes and stops with `leave()`
  (fake timers).

## Notes / decisions

- **Why presence and not the P2P peer count:** Trystero's WebRTC layer can
  fail (NAT) while Supabase realtime — the thing the room actually runs on —
  works fine; deleting a room because WebRTC couldn't connect would destroy a
  live game. Presence rides the same channel the room depends on anyway.
- **Why client-fired sweep and not pg_cron:** no scheduler to provision or
  monitor; the sweep is one indexed-by-PK delete and runs at most once per
  room join.
- The fix to `enterRoom` captures the channel in a local before `subscribe()`
  — the status callback could otherwise run before `this.channel` is assigned
  (it did, synchronously, in the test stub) and skip the `track()`.
- Verification is `npx ng test`; the live behaviour needs the new migration
  applied to the cloud database first (tracked with the two already-pending
  migrations).
