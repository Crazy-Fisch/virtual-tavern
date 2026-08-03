# moreimprovements.md — results

Implementation notes for every section of `moreimprovements.md`. All 163 unit
tests pass (`npm test`) and the production build is clean (`npm run build`).

## persistance — world_objects cleaned up with their room

`schema.sql` has always declared `world_objects.room_id` (and
`chat_messages.room_id`) with `references rooms (id) on delete cascade`, so on
a fresh install `close_room` / `cleanup_stale_rooms` already take a removed
room's world objects and chat history with it. A live database installed from
an early schema (or one whose constraint was ever dropped) can still hold
orphans, though, so there is a new belt-and-braces migration:

- **`supabase/migration-2026-08-03-world-cleanup.sql`** (run it in the SQL
  editor after the three earlier migrations): drops both `room_id` FKs,
  **deletes every `world_objects` / `chat_messages` row whose room no longer
  exists**, and re-creates the constraints with `on delete cascade`. After it
  runs, room removal reliably cascades — no client code needed.

## item errors — NG0950, items never appeared

Root cause: `Item`'s constructor called `spawn()`, whose first statement reads
the required `state` input — but required inputs are only bound *after*
construction, so Angular threw `NG0950` and the component (and with it the
item) never materialised. `Card` has the same constructor call but survives by
luck: its spawn `await`s the card model before touching `state`.

Fix (`item.ts`): the spawn is deferred with `afterNextRender(() => void
this.spawn())`, by which point inputs are bound. The constructor's effects were
already guarded (`if (!this.wrapper) …`), so no other change was needed. The
pattern warning is now documented in CLAUDE.md.

## ui — tabbed dialogs

`menu.ts/html/scss`:

- **Play dialog**: two tabs, *Join room* (display name for guests + room code +
  Join) and *Create room* (display name for guests + room name + Create). Each
  tab is its own form with its own submit; switching tabs clears a stale error.
- **Auth dialog**: *Sign in* (email + password) and *Sign up* (email + password
  + username, `autocomplete="new-password"`) tabs, with **Continue as guest**
  at the bottom of both, as requested. The dialog heading follows the tab.
- Shared `.tabs`/`.tab` styling in `menu.scss` (underline on the active tab,
  matching the existing dialog look).

## tokens — now searchable

The in-game search hit `{base}/cards/search`, and a Scryfall-compatible API
**excludes tokens ("extras") from search results by default**. The query now
sends `include_extras=true` (`card-search.service.ts`), so tokens appear like
any other card.

On the database side, tokens are ordinary card objects in the `default_cards`
bulk file and were never filtered out by the indexer — with the index rebuild
below they now also resolve by name (`lookup('Treasure')` → token art), which
is what the related-cards panel uses.

## related cards — implemented from `all_parts`

The card JSON's `all_parts` array is now the source of related cards:

- `CardDatabaseService`: `CardRecord` gains `related?: string[]` (the card's
  `all_parts` names minus itself, first printing that carries any wins; the
  shared extractor `relatedNamesOf` lives here). The index cache key was bumped
  to `index:v3:<base>` — an existing installation rebuilds the index from the
  bulk file once (the superseded `v2` entry is deleted afterwards).
- `CardState.relatedIds` (ids of other *table* cards — never populated, so the
  feature was dead) is replaced by **`relatedNames`** (plain names). It is
  populated wherever a card reaches the table: search hits carry `all_parts`
  straight from the API, cards played from the hand / dragged out of a zone
  resolve through `db.lookup(name)?.related`.
- The related panel (`CardOverlay`) resolves those names to images via the card
  database at render time. Entries are **draggable onto the table** (see next
  section) — a spawned related card carries its *own* related names, so chains
  (e.g. meld pairs) keep working; a plain click opens the large view. A name
  the local database can't resolve still shows as a draggable text tile.
- A selection's related panel still unions every selected card's related list.

## search & related drag — buttons removed

New shared flow in `CardInteractions`:

- `armSpawnCardDrag(event, {name, src, related}, onStart?)` arms a press; past
  the 4-px threshold it spawns the card **local-only** (`CardStore.addLocal`)
  under the cursor and hands it to the existing hand-drag flow. Release over
  the table commits it to the shared world and logs `added <name>`; release
  over the hand/deck/graveyard/exile widgets routes it into that zone (the
  existing `CardDropTarget`s); a miss or Escape discards it — other players
  never see it.
- The util window's per-hit **Table / Hand / Deck buttons are removed**; a hit
  is simply dragged out (the window closes when the drag starts). Adding to
  hand or deck is the same drag released over that pile.
- The related panel's entries use the identical flow (panel closes on drag
  start).

## card drag — single cards now drag like groups

The DOM "drag ghost" (the cursor-following `<img>` that stood in for a lone
dragged card, smaller than the 3D card and always drawn untapped) is **removed
entirely**: `dragGhost` signal, the `Card` hide-while-ghosted effect, the Zones
overlay element and its styles. Every drag — single card, group, hand play,
search spawn — now moves the real 3D instance at `DRAG_Y`, so a dragged card
keeps its size, its tapped quarter-turn, and its facing, exactly like the
group-drag style the design doc asked for. (Trade-off, accepted: a card dragged
across the hand/pile widgets passes behind them for a moment.)

## untapping — "Untap all" button + `U` hotkey

- `CardState` gains **`ownerUid`** — the auth uid of whoever put the card onto
  the table, stamped on every spawn path (hand play, zone drag-out, search /
  related spawn). Cards from before this change have `''` and are never
  touched.
- `CardInteractions.untapAll()` untaps every tapped card with my `ownerUid` in
  **one batched write** (`updateMany` → a single upsert request, atomic) and
  posts `untapped all their cards`; it does nothing (and logs nothing) when no
  own card is tapped.
- Bound to the **`U` hotkey** (global — no hovered card needed; still ignored
  while typing in chat) and to a new **"Untap all"** button in the bottom-left
  controls, next to the life counter and the reveal-hand toggle.

## test/doc changes

- Specs updated for the new `CardState` shape (`relatedNames`/`ownerUid`), the
  search URL (`include_extras`), the `v3` index key, and the removed ghost; new
  coverage: untap-all (own vs. foreign cards, silent no-op), search-hit spawn
  drag (local-only until the drop, discard on a miss), `all_parts` extraction
  in search hits, related names + token resolution in the database index, and
  the v2→v3 cache rebuild.
- CLAUDE.md updated (migration pointer, drag style, related cards, tokens,
  tabs, untap-all, and the NG0950 required-input constructor warning).

## follow-ups worth knowing

- **Run the new migration** (`migration-2026-08-03-world-cleanup.sql`) in the
  Supabase SQL editor, after the three earlier pending ones.
- The card-database index is rebuilt once per deposited API (v3 — related
  names). First visit after this update re-downloads the bulk file.
- Old rooms' cards (created before `ownerUid`/`relatedNames`) keep working;
  they just have no owner (untap-all skips them) and no related entries.
