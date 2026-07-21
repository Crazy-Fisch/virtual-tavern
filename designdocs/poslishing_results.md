# Polishing — implementation results

Implements `poslishing.md`. Eight items: two bug fixes, five polish changes, and
one research-only task (Z-fighting — **documented below, deliberately not
implemented**, per the design doc). Nothing changed in the networking model; the
shared-state pattern (whole-object LWW writes through `RoomService.setWorldObject`)
is untouched apart from the new `room_owner`/seating plumbing.

---

## 1. Bug — card view dialog border didn't fit the card

**Symptom:** viewing a card framed it in a dialog only about half as wide as the
image, with the border cutting across the art.

**Cause:** `Dialog` was hard-coded to `width: min(90vw, 360px)`. A card image is
naturally wider (up to ~480px), so the frame boxed it at a fixed narrow width and
the image overflowed/looked cropped by the chrome.

**Fix:** a `fit` input on `Dialog` (`src/app/shared/dialog/dialog.ts`) that adds a
`fit` host class; the SCSS then sizes the frame to its content:

```scss
:host(.fit) & { width: fit-content; max-width: 92vw; }
```

The card view dialog opts in — `<app-dialog [heading]="card.name" [fit]="true">`
in `card-overlay.html` — so the frame now hugs the card image. Every other dialog
(auth, play, settings, deck picker) keeps the default fixed width.

## 2. Bug — dice / coins / counters removed entirely

Per "remove them entirely for now", the whole token feature is gone rather than
patched:

- **Deleted** `src/app/scene/token/` in full: `token.ts`, `token.html`,
  `token-store.ts`, `token.types.ts`, and `token-store.spec.ts` (the procedural
  d6/d12/d20/coin/±1 counter meshes and their world-state store).
- `CardInteractions` no longer raycasts or acts on tokens: the `storeFor`
  dispatch, the token branch of the context menu (roll/flip/±1/delete), and the
  token hotkeys were removed. It now handles cards only.
- `CardOverlay` lost its token context-menu block and its `TokenStore` injection.
- The util window lost the "Objects" section and its `spawn()` method (and the
  `.objects` styles) — right-clicking empty table now offers card search only.
- `Scene` dropped the `Token`/`TokenStore` imports, providers, and the `@for`
  that rendered tokens.

`token:`-prefixed rows are now an **ignored unknown prefix** in the world state
(documented in `room.types.ts` and `room.service.ts`): any leftover token rows in
an existing room's Postgres snapshot are simply skipped by both `CardStore` and
`ZoneStore`, so old rooms load cleanly without a data migration.

## 3. Cards are now real-card sized

The card GLB is authored at **10× a real card**. I measured it directly
(parsing the GLB accessor bounds): `Card.glb` is 0.635 × 0.889 m — exactly ten
times a real 63.5 × 88.9 mm card — sitting on a 4 × 6 m `Table01.glb` whose top
is at y ≈ 0.2.

`card.ts` now scales the model down:

```ts
const CARD_SCALE = 0.3; // → 0.19 × 0.27 m per card
wrapper.scale.setScalar(CARD_SCALE);
```

0.3 was chosen over true 1:1 (which would make a card ~0.063 m — about 1.6% of
screen height under the new overhead camera, unreadable) as the point where a
card reads as a proper small card on the oversized table while its face stays
legible. The scale lives on the wrapper `Group`, so hit-testing, stacking, and
the tap/flip poses all follow automatically.

## 4. Play from hand by dragging onto the table (not clicking)

Playing a hand card is now a real drag-and-drop instead of the old two-click
"attach to cursor, click to place" flow.

**Hand side** (`src/app/zones/zones.ts`): a hand card's `pointerdown` calls
`startDrag`, which only *arms* a pending drag and adds temporary document
pointermove/pointerup listeners. The card does not leave the hand until the cursor
travels past `HAND_DRAG_THRESHOLD_PX` (4 px) — so a stray click does nothing. Past
the threshold, `beginPlay` removes the card from the hand (`playFromHand`), spawns
it on the table face-up at `DRAG_Y` with `yaw = seatYaw()`, and hands the live
drag to the shared interaction layer:

```ts
this.interactions.beginDragFromHand(id, event, {
  commit: () => this.room.sendAction(`played ${taken.name}`),
  revert: () => { this.cards.remove(id); this.zones.addCard('hand', taken); },
});
```

**Table side** (`src/app/scene/card/card-interactions.ts`): `beginDragFromHand`
takes over an already-held pointer and runs the *same* drag machinery as a table
drag. A new `HandDragHooks { commit; revert }` decides the ending:

- release **over the table** → `tryPlace` succeeds → `commit()` (logs "played X"),
- release **off the table** → `revert()` (card removed, returned to the hand),
- **Escape** mid-drag → `revert()`.

Two supporting changes made this one code path work for both DOM-originated and
canvas-originated drags:

- The `pointermove`/`pointerup` listeners moved from the canvas to **`window`**,
  so a drag that starts over the hand DOM keeps following the cursor and can be
  released anywhere. Hover picking is gated to `event.target === this.canvas` so
  it doesn't fire through the DOM overlays.
- `ZoneStore.playFromHand` no longer posts its own history line. The "played X"
  line is posted by the drop `commit`, so a drag released off-table reverts with
  **no false history entry**.

## 5. Camera — near-bird's-eye from the table end

`camera-rig.ts` replaces the low, angled pose with a near-top-down one:

```ts
const CAMERA_POS = new Vector3(0, 5.0, 1.8);
const CAMERA_TARGET = new Vector3(0, 0.2, -0.2);
```

That is ~20° off vertical (a slight "seated at the end of the table" tilt) looking
down from 5 m, framing the whole 6 m table with much less perspective shift than
before — a card at the far end and a card at the near end now look nearly the same
size. The subtle edge-pan toward the mouse is unchanged. (The pose is also
mirrored per seat — see item 8.)

## 6. Z-fighting when cards are placed next to each other — RESEARCH ONLY

Per the design doc this item is **researched and documented, not implemented**.
The dislike is explicit: "I don't want to offset every card by 0.001 per card
already played." What follows are the realistic options, with a recommendation.

**Context.** Today a placed card is lifted by a single fixed `PLACE_OFFSET =
0.01` above whatever surface the drop ray hit (`card-interactions.ts`). That
stops a card from fighting the *tabletop*, but two cards placed at the same height
next to (or overlapping) each other still have coplanar faces that flicker as the
depth buffer can't decide which is in front. The camera is near-ortho-ish now but
still perspective, near/far = 0.1 / 200.

### Option A — polygon offset on the card material (recommended)

Three.js/WebGL exposes `material.polygonOffset` (`polygonOffsetFactor`,
`polygonOffsetUnits`), which nudges a surface's depth values at raster time
**without moving the geometry**. Give the card faces a small negative offset and
coplanar cards stop fighting because their depth is biased apart in the buffer,
not in world space.

- **Pros:** no per-card bookkeeping, no cumulative Y creep, cards stay physically
  at the same height (so stacking maths and the "on top of" ray are unaffected).
  It's the standard fix for decals/coplanar quads.
- **Cons:** it's a global bias, not a per-instance ordering — two *exactly*
  coplanar, exactly overlapping cards still need *some* tiebreak (see B/E). Tuning
  factor/units is empirical and can vary by GPU.
- **Scope:** a few lines in `card.ts` where materials are cloned.

### Option B — deterministic render order per card (no world offset)

Keep all cards at the same Y but control *draw order* with `mesh.renderOrder` plus
`depthWrite`/`depthTest` tuning, deriving the order from a stable per-card value
(e.g. placement sequence, or a hash of the card id) rather than a growing Y. This
is the "don't offset in space, offset in the sort" approach.

- **Pros:** no Y creep; deterministic and network-stable if the ordering key is
  shared state (e.g. an `order` field already in `CardState`).
- **Cons:** render-order tricks fight the depth buffer for genuinely 3D overlaps
  (a card half-under another at a different height) — best when cards are
  effectively flat on one plane. Needs an ordering key in the shared model.

### Option C — single small epsilon by *stack depth*, not by *cards played*

The user's objection is specifically to `+0.001 × (cards ever played)` — an
ever-growing global offset. A bounded alternative is to offset by **how many cards
are already at this spot** (the local stack height under the drop), so the epsilon
is `0.001 × localStackIndex` and resets to ~0 for an isolated card. Cards placed
apart are all at ~table height; only a genuine pile spreads by millimetres, which
is physically correct anyway (a stack *is* taller).

- **Pros:** matches reality, bounded (only as tall as the actual pile), avoids the
  disliked unbounded global creep.
- **Cons:** needs the drop code to count what's already under the cursor; still a
  world-space offset (just a defensible one). This is essentially item F done
  honestly.

### Option D — logarithmic depth buffer

`WebGLRenderer({ logarithmicDepthBuffer: true }) ` redistributes depth precision so
close-together surfaces are far better separated.

- **Pros:** one flag; helps everywhere, not just cards.
- **Cons:** a real cost/compatibility hit (per-fragment depth writes, disables
  some optimizations, occasional artefacts), and it *reduces the likelihood* of
  fighting rather than *guaranteeing* an order for truly coplanar quads. Overkill
  for a flat card table.

### Option E — tighten the near/far planes

Precision is spent across `[near, far]`. Ours is `0.1 … 200`, but the table view
never sees anything past a few metres. Pulling far in to ~50 and near out to ~1
concentrates depth precision where the cards actually are.

- **Pros:** free, no per-object work, helps all coplanar cases a bit.
- **Cons:** a *mitigation*, not a *fix* — reduces flicker frequency but two
  perfectly coplanar faces can still tie. Best combined with A.

### Option F — physical stacking (real card thickness)

Treat `PLACE_OFFSET` as a real card thickness and add it *only when a drop lands on
another card* (which the placement ray already detects), so a pile genuinely
steps up card-by-card while a card dropped on the *table* sits at table height.

- **Pros:** physically correct, bounded to actual pile height, no global counter.
- **Cons:** same family as C; only addresses the "dropped on another card" case,
  not two cards laid side-by-side at identical height (that's A/B/E territory).

### Recommendation

**Adopt A (polygon offset) as the baseline** — it's the least intrusive, needs no
shared-state changes, and directly targets coplanar flicker without moving cards.
Pair it with **E (tighter near/far)** since that's free and complementary. If
*exact* overlap ordering ever matters (two cards dropped on the same spot), add a
shared `order` field and use **B**, or lean on **F/C** for piles where a small,
*bounded, stack-local* step is physically justified — the key being that the
offset tracks the local pile, never "every card ever played". Explicitly **not**
recommended: D (cost out of proportion to a flat table) and the unbounded global
`+0.001 × playedCount` the user rejected.

## 7. Decks persist per logged-in account; hidden for guests

Deck storage moved from per-browser `localStorage` to a per-account Supabase table.

- **`decks` table** (`supabase/schema.sql`, and `migration-2026-07-19-polish.sql`
  for existing installs): `id` (client-generated uuid for optimistic writes),
  `owner_id`, `name` (1–60 chars), `list` jsonb, `created_at`. RLS is owner-only;
  crucially the **insert** policy also requires a non-anonymous JWT
  (`coalesce((auth.jwt() ->> 'is_anonymous')::boolean, false) = false`), so a
  guest session cannot write decks even if the client tried.
- **`DeckStore`** (`src/app/decks/deck-store.ts`) is now Supabase-backed:
  `available()` is true only for signed-in non-guests; a session-following
  `effect` loads the account's decks on sign-in and clears them on sign-out;
  `import`/`remove` are optimistic with rollback and return the error-string / null
  convention. A one-time `migrateLegacy` uploads any decks left in the old
  `virtual-tavern.decks` localStorage key on the first signed-in load, trimming
  names to satisfy the DB check.
- **Guests are excluded end-to-end:** `import` refuses with an "account needed"
  message; the menu's Decks link is wrapped in `@if (session && !isGuest)`; and a
  new **`decksGuard`** redirects `/decks` to `/` for guests/signed-out visitors —
  so the screen can't be reached by typing the URL either.
- **Signed-out screen:** the Decks button is gone (same `@if`), matching "the
  decks menu from the signed-out screen can be removed".

## 8. 1v1 seating — joiners sit opposite the room creator

Players used to share one table side; now the creator keeps their side and anyone
joining views from the opposite end. Room size is **not** restricted.

- **Who owns the room:** `get_room_by_code` now also returns `room_owner`
  (`r.owner_id`); `RoomInfo` gained `ownerId: string | null`. `createRoom` sets
  the owner to self; `joinByCode` reads it from the RPC. A pre-migration RPC
  without `room_owner` is tolerated (null → everyone seated on the owner side).
- **Seat math** (`room.service.ts`): `isRoomOwner` is true when I created the room
  (or ownership is unknown); `seatYaw` is `0` for the owner and `Math.PI` for a
  joiner.
- **Camera** (`camera-rig.ts`): mirrors the base pose to the `−Z` end for
  non-owners (`const side = isRoomOwner() ? 1 : -1`), fixed once on mount, so a
  joiner literally looks from the far end of the table.
- **Card orientation:** cards a player spawns (from hand, or via the util window's
  add-to-table) use `yaw: seatYaw()`, so they read upright from *that* player's
  side instead of appearing upside-down.

---

## Files touched

| File | Change |
| --- | --- |
| `src/app/shared/dialog/dialog.ts`, `.scss` | `fit` input + `fit`-mode width (bug 1) |
| `src/app/scene/card/card-overlay/card-overlay.html`, `.ts` | View dialog uses `[fit]`; token menu/`TokenStore` removed |
| `src/app/scene/token/**` | **Deleted** (item 2) |
| `src/app/scene/card/card-interactions.ts` | Token code removed; `DRAG_Y` lowered; `HandDragHooks` + `beginDragFromHand`; window-level pointer listeners; hover gated to canvas |
| `src/app/scene/card/card.ts` | `CARD_SCALE = 0.3` on the wrapper (item 3) |
| `src/app/scene/util-window/util-window.ts`, `.html`, `.scss` | Token spawn UI removed; add-to-table uses `seatYaw()` |
| `src/app/scene/scene.ts`, `scene.html` | Token/`TokenStore` imports, providers, `@for` removed |
| `src/app/scene/camera-rig/camera-rig.ts` | New overhead pose; mirrored per seat (items 5, 8) |
| `src/app/zones/zones.ts`, `.html`, `.scss` | Drag-to-play from hand; guest hint in deck picker (item 4) |
| `src/app/zones/zone-store.ts` | `playFromHand` no longer logs (line moved to drop commit) |
| `src/app/room/room.types.ts` | `RoomInfo.ownerId`; token→ignored-prefix comment |
| `src/app/room/room.service.ts` | `isRoomOwner`/`seatYaw`; owner plumbed through create/join |
| `src/app/room/testing/fake-room.service.ts` | `isRoomOwner`/`seatYaw` stubs |
| `src/app/decks/deck-store.ts` | Supabase-backed per-account store + legacy migration (item 7) |
| `src/app/decks/decks.ts`, `decks-guard.ts` | Async import; `decksGuard` |
| `src/app/menu/menu.html` | Decks link gated to signed-in non-guests |
| `src/app/app.routes.ts` | `/decks` guarded by `decksGuard` |
| `supabase/schema.sql`, `supabase/migration-2026-07-19-polish.sql` | `decks` table + RLS; `get_room_by_code` returns `room_owner` |
| `CLAUDE.md` | Architecture notes updated to match all of the above |
| Specs | Token specs deleted; deck/seating/hand-drag tests added (below) |

## Tests

- `card-interactions.spec.ts` — token provider/hotkey tests removed; the pointer
  suite gained hand-drag cases via a `beginHandDrag` helper: a hand card dragged
  onto the table places at the release point and calls `commit` once (not
  `revert`); released off-table calls `revert` (not `commit`); Escape reverts. The
  `move` helper now dispatches bubbling events (the follow listener is on window).
- `room.service.spec.ts` — `ROOM_RPC` carries `room_owner`; a joiner of someone
  else's room gets `isRoomOwner() === false` / `seatYaw() ≈ π`; a pre-migration
  RPC without `room_owner` leaves `ownerId` null and seats everyone owner-side.
- `deck-store.spec.ts` — rewritten around a chainable PostgREST stub: load +
  malformed-row filtering, guests blocked from importing, import insert payload,
  unparseable list rejected, "Unnamed deck" fallback, insert rollback, remove, and
  the legacy-localStorage migration.
- `zone-store.spec.ts` — `playFromHand` asserted to remove silently (no action
  line).
- `card.spec.ts` — token provider removed.

`npm test`: **13 files, 87 tests, all green.** `npm run build`: clean production
build.

## Migration required (existing installs)

Run **`supabase/migration-2026-07-19-polish.sql`** once in the Supabase SQL
editor, after the earlier migrations. It creates the `decks` table + RLS and
redefines `get_room_by_code` to return `room_owner`. Until it runs, deck saving
fails (no table) and every player is seated on the owner's side (the client
tolerates the older RPC). Fresh installs get all of this from `schema.sql` and
skip the migration.

## Notes / deferred

- **Z-fighting (item 6) is documentation only** — no code change, by request. See
  the section above for options and the recommendation (polygon offset + tighter
  near/far).
- The card scale (0.3) is a readability compromise, not true 1:1 — a genuinely
  real-scale card is unreadable under the overhead camera on the oversized table.
  Adjust `CARD_SCALE` in `card.ts` if a different balance is wanted.
- Seating is fixed on mount for the whole stay in a room; there's no live
  re-seating if ownership somehow changed mid-session (it can't today).
