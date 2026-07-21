# Feature Requests — Implementation Results (2026-07-18)

All six requests from `featurerequests.md` are implemented. This file records the order they
were built in (and why), what each one does, the decisions made along the way, and the one
manual step required before running.

## ⚠ Action required before running

The Supabase schema changed. In the Supabase SQL editor run **one** of:

- Existing project (created from the old schema): `supabase/migration-2026-07-18-card-game.sql`
- Fresh project: `supabase/schema.sql` (already updated)

What changed: `world_objects.open` (boolean) became `world_objects.data` (jsonb),
`world_objects` gained a DELETE policy, and `chat_messages` gained a
`kind ('chat' | 'action')` column. Until the migration runs, joining a room fails (the client
selects the new columns).

## Implementation order and rationale

1. **Networking** — everything else (zones, added cards, tokens) _is_ networked state, so the
   foundation had to come first: world objects generalized from one boolean to a jsonb
   payload, plus object deletion.
2. **History** — every later feature posts action lines, so the chat `kind` plumbing came
   second and each subsequent feature logged itself as it was built.
3. **Zones** — the hand/deck/graveyard system, needed before "adding cards" so search results
   have somewhere to go besides the table.
4. **Adding cards** — the right-click util window with card search.
5. **Other game objects** — dice/coin/counters reuse the util window and the whole
   card-networking pattern, so they came last and cheapest.

## 1. Networking (cards on the table)

- `world_objects.data` is now jsonb; the object id's prefix names the owning domain:
  `card:<uuid>` (table cards), `zone:<uid>:<kind>` (player zones), `token:<uuid>`
  (dice/coin/counters).
- `CardStore` was rewritten from a local seed list into a **computed projection over
  `RoomService.worldState()`** — every player sees the same cards, and a late joiner gets the
  full table from the persisted Postgres snapshot (this is the same load path as the first
  join, so "sync on join" needed no extra code).
- Conflict resolution is unchanged last-writer-wins on the server-stamped `updated_at`;
  deletions are real row deletes (Supabase does not filter DELETE events by room, so the
  client drops foreign-room deletes by `old.room_id`).
- **Dragging stays local until the drop**: while a card moves it follows the cursor via a
  local `preview()` override; only the placement commits (one write per move). Remote players
  see the card jump to its destination rather than a 60 Hz cursor stream — deliberate, to
  keep writes human-rate on the free tier. If smooth remote drags are wanted later, the P2P
  layer (Trystero) is the intended transport, as already noted in CLAUDE.md.
- Escape now cancels a pick-up (drops the preview, card snaps back to shared state).
- The three local seed cards are gone — tables start empty and are filled via the util
  window (feature 4) or hands/decks.

## 2. History (actions in chat)

- `chat_messages.kind`: `'chat'` (typed) vs `'action'` (history). `RoomService.sendAction()`
  posts history lines; they render **plain white** as `<username>: <action>` while typed
  messages are **colored** (lavender for others, green for self, names accented).
- Logged actions: added/played/removed a card, flip ("turned X face down"), rotate,
  to-hand/to-deck/to-graveyard moves, drew a card, shuffled their deck, dice rolls with
  result ("rolled a d20: 17"), coin flips ("flipped a coin: heads"), counter changes
  ("set a counter to 3x"). Adds into **closed zones** log without the card name ("added a
  card to their hand") so hidden information stays hidden; card _moves_ on the table are not
  logged (too spammy).
- The chat log now auto-scrolls to the newest message.

## 3. Zones (deck / graveyard / hand as HTML)

- `ZoneStore` (`src/app/zones/`) projects `zone:<uid>:<kind>` world objects
  (`{ ownerName, cards }`). Contents travel over the network — so everyone knows every zone's
  **size**, and graveyards can be **examined** by anyone — but the UI keeps hands and decks
  closed, exactly as requested.
- My zones (created empty on room entry): deck and graveyard piles bottom-right (deck drawn
  as a CSS card back with its count; graveyard shows its top card). **Right-clicking a zone
  shows context actions**: deck → Draw / Shuffle; graveyard → Examine.
- Other players appear top-right: name + hand/deck sizes + examinable graveyard.
- Examining my own graveyard offers "To hand" per card.

## 4. Cards outside the game (hand)

- My hand renders bottom-center as a **fanned arc of cards** (transform-origin below the
  screen, hover lifts and enlarges a card) — the "holding cards" look.
- **Click a hand card to play it**: it leaves the hand, spawns as a table card attached to
  the cursor (the existing click-to-move flow), and the next click places it. Cards on the
  table can go back via the card context menu: **To hand / To deck (top) / To graveyard**.
- Zone cards are pose-less (`{ id, name, src }`); a card gets a fresh `card:` world id each
  time it enters the table, which keeps zone membership and table state from ever conflicting.
- Deck **models** in 3D were skipped as the request suggested.

## 5. Adding cards (util window + search)

- **Right-clicking anywhere that isn't a card/token** opens the util window at the cursor
  (card right-clicks still open the card menu; the window closes on Escape, ×, or clicking
  elsewhere).
- Search is live (300 ms debounce, aborts stale requests, per-query cache) against the
  public **Scryfall API** — the card universe the placeholder art already came from. Results
  show in a **3-wide grid sized to 6 visible cards (3×2), scrollable** beyond that.
- Each hit has three targets: **Table** (spawns at the right-clicked table spot, slightly
  jittered so repeats don't overlap), **Hand**, or **Deck** (on top).

## 6. Other game objects

- The util window's "Objects" row spawns **d6, d12, d20, Coin, +1/+1, −1/−1, Nx** tokens at
  the clicked spot.
- Tokens are `token:` world objects rendered by a procedural `Token` component (no GLB):
  a color-coded base mesh (box/dodecahedron/icosahedron/cylinder) plus a camera-facing
  sprite label showing the rolled value / H-T / "+1/+1" / "3x".
- Tokens hover and **move exactly like cards** (same interaction layer). Right-click menus:
  dice → Roll; coin → Flip; Nx → +1 / −1; all → Delete. Dice/coins spawn pre-rolled.

## Verification

- `npm run build` (production) — clean.
- `npm test` — **60 tests / 10 files, all green**, including new suites for `ZoneStore`,
  `TokenStore`, `CardSearchService`, the rewritten `CardStore`, extended `CardInteractions`
  (zone moves, drag-cancel, util window, token hotkeys) and `RoomService` (jsonb payloads,
  action kind, DELETE handling incl. the unfiltered-delete edge case). A shared
  `FakeRoomService` test double (`src/app/room/testing/`) backs the store specs.
- Live multiplayer against real Supabase was **not** exercised here — it requires the
  migration above; after running it, `npm start`, create a room in one browser and join by
  code from a second (or an incognito window) to see table/zone/history sync.

## Known limits / sensible next steps

- Remote players see card moves on drop, not mid-drag (see feature 1 — P2P streaming is the
  designed upgrade path).
- Concurrent edits to the _same_ zone resolve whole-zone LWW (fine for one owner per zone);
  concurrent delete-vs-move of the same card resolves in arrival order — acceptable at a
  trust-based table.
- Zone RLS is capability-based like the rest of the room: any member _could_ write another
  player's zone via the API (the UI never does). Per-owner zone policies would need
  object-id-aware RLS.
- Deck import (the `/decks` screen) is still the placeholder — the natural source for filling
  decks in bulk.
- Related-cards data isn't populated by search yet (Scryfall's `all_parts` could feed it).
