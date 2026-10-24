# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm start` — dev server at http://localhost:4200 (HMR on source changes)
- `npm run build` — production build to `dist/` (default config is `production`)
- `npm run watch` — rebuild on change with the development config
- `npm test` — run unit tests with Vitest (via `@angular/build:unit-test`)
- Run a single test file: `npx ng test --include src/app/path/to/file.spec.ts`
- `npx ng generate component <name>` — scaffold (styles default to SCSS, selector prefix `app`)
- `npm run decks:manifest` — re-list `public/decks/*.txt` into `public/decks/index.json`. Runs
  automatically from the `prestart` / `prebuild` / `prebuild:pages` / `prewatch` hooks; you only
  need it by hand after adding a decklist without restarting.

There is no lint script. Formatting is Prettier (`.prettierrc`).

## Architecture

A 3D multiplayer "tavern": Angular 22 (standalone, zoneless, signal-based) drives a Three.js
scene. Multiplayer is a **hybrid**: Supabase (auth + Postgres + Realtime) is the backend for
accounts, rooms, chat, and shared world state, while the high-frequency avatar position stream
flows directly between browsers over WebRTC (Trystero) — free-tier realtime quotas cannot
absorb 15 Hz fan-out, but chat and card/zone state changes are human-rate and fit easily.

### The three networking services

- **`src/app/supabase/supabase.service.ts`** (`SupabaseService`) — thin signal wrapper around
  the single `createClient` instance. Owns the auth session (`session`, `userId`,
  `displayName`, `isGuest` signals) and auth methods (email/password sign-up/in, anonymous
  guest sign-in, `setDisplayName` via `user_metadata`). `init()` restores the persisted
  session and is wired through `provideAppInitializer` in `app.config.ts`. Credentials live
  in `src/environments/environment.ts` (publishable key — safe to commit; RLS is the
  security boundary; never the service_role key).

- **`src/app/room/room.service.ts`** (`RoomService`) — the join/leave facade and source of
  truth for room state. Signals: `currentRoom`, `joined`, `messages`, `worldState`, `userId`,
  `displayName`, `undoable`, `undoneIds`. `createRoom()` inserts an owned row (share code generated server-side);
  `joinByCode()` resolves code→room via the `get_room_by_code` security-definer RPC (rooms are
  unlistable; the room UUID is the capability). Entering a room loads persisted chat history +
  world snapshot from Postgres, subscribes to one realtime channel (`postgres_changes` on
  `chat_messages` INSERT and `world_objects` `*`, filtered by room_id), then calls
  `p2p.join(roomUuid, name)`. Chat sends are optimistic (client-generated UUID, realtime echo
  deduped by id, rollback on insert error); messages have a `kind` — `'chat'` (typed, rendered
  colored) or `'action'` (game-history line posted via `sendAction()`, rendered plain white as
  `<name>: <action>`). World objects carry a **jsonb `data` payload** keyed by an id whose
  prefix names the owning domain (`card:` CardStore, `item:` ItemStore, `zone:` ZoneStore;
  unknown prefixes such
  as `token:` rows from removed features are ignored); `setWorldObject(id, data)` /
  `setWorldObjects(entries)` upsert optimistically — a multi-entry batch is ONE request, so
  a multi-zone move like a draw commits atomically (a DB trigger stamps the authoritative
  `updated_at` used for last-writer-wins; requests dispatch through an ordered chain; the
  upsert's response row is adopted to heal client clock skew, own realtime echoes only when
  no newer write is in flight, and a failed write re-reads the rows so local state snaps
  back to the database) — and `removeWorldObject(id)` deletes. Realtime DELETE events are not filtered by Supabase, so
  the handler drops other rooms' deletes by `old.room_id`. Seating: `RoomInfo.ownerId` (from
  the create insert or the join RPC's `room_owner`) feeds `isRoomOwner`/`seatYaw` — the room
  creator sits at +Z, everyone else views from the mirrored −Z table end and spawns their
  cards with `yaw = seatYaw()` so the cards read upright from their side. Rooms are removed
  when closed (`designdocs/perstistance.md`): every client tracks realtime **presence** on
  the room channel (a per-tab key), and an explicit `leave()` that finds nobody else present
  calls the `close_room` RPC — the FK cascades take all chat/history and world objects along.
  While joined, a 5-minute `touch_room` heartbeat stamps `rooms.last_active`;
  `cleanup_stale_rooms` (fired opportunistically on every join) deletes rooms untouched for a
  day — the backstop for tabs closed without leaving (which keeps the reload-resume flow
  alive, since a reload never closes the room). An unsynced presence state never triggers
  deletion — the sweep handles those rooms instead. **Undo journal**: every own world write
  records its pre-image (null = absent) and `sendAction()` stores the batch as a world object
  `undo:<messageId>` (`{msg, t, by, before}`; silent writes such as quiet card returns attach to the latest
  action line 2 s after; life/infect changes post their own coalesced line first, see Player zones). `undoable` lists the newest 50 action lines with an entry;
  `undoTo(messageId)` folds those entries newest to oldest, restores the oldest pre-images in one
  upsert plus one delete (not journaled itself), drops the consumed entries, records the undone
  lines in the `undone:state` object (`undoneIds`, shown greyed out in History, since
  `chat_messages` cannot be deleted) and posts "undid N action(s)". **History barrier**: a new
  round calls `resetHistory(msgId)`, which stores the world object `history:start` `{msgId, t}`
  (`historyStart`, never journaled) and deletes all `undo:` entries and `undone:state`; `undoable`,
  `undoTo` and pruning only count lines strictly after the barrier line, so no state of an earlier
  game can be restored. No SQL migration.

- **`src/app/p2p/p2p.service.ts`** (`P2pService`) — WebRTC avatar layer over Trystero (Nostr
  strategy: peers discover via public relays, data flows P2P). Carries ONLY the `pos` and
  `name` actions. **`APP_ID`** must stay distinctive — it namespaces this app on the shared
  relays; the room key is the room UUID passed in by `RoomService`. Position is throttled:
  the scene calls `sendPosition()` every frame, the service broadcasts at `POS_HZ` (15/s)
  only when dirty. Exposes `players` (remote peers only; self is rendered locally),
  `peerCount`, `selfId`.

The database schema + RLS policies live in `supabase/schema.sql` (paste into the Supabase SQL
editor once, fresh installs only). Existing installs run the dated
`supabase/migration-*.sql` files newer than their install instead, in order (latest:
`migration-2026-08-03-world-cleanup.sql` — deletes orphaned `world_objects`/`chat_messages`
rows and re-creates their room_id FKs with on-delete-cascade, so removing a room reliably
removes its world state; before it, `migration-2026-08-03-room-cleanup.sql` —
`rooms.last_active` + the `touch_room` / `close_room` / `cleanup_stale_rooms` RPCs).
Chat identity is the Supabase auth uid (stable across sessions); avatars are keyed by
Trystero peerId with names via the `name` action — the two id spaces never need mapping.

### Payload typing constraint (important)

Trystero's `makeAction<T>` requires JSON-serializable payloads with an index signature, so
shapes sent through actions (`PosMsg`, `NameMsg`, private to `p2p.service.ts`) are declared
with **`type`, not `interface`**. `Player` can stay an `interface` because it is never sent
directly as a payload. Room/chat/world shapes live in `src/app/room/room.types.ts`.

### The scene is a fixed-camera card-table view

`src/app/scene/scene.ts` (`Scene` component) owns the WebGLRenderer and render loop. The
camera lives in `SceneCamera` (`src/app/scene/scene-camera.ts`, provided by Scene like
`SceneGraph`) and is **orthographic** — the design docs' "isometric" view: every card is
drawn the same size wherever it lies. `SceneCamera.setAspect()` (called by `Scene.resize`)
keeps the vertical extent fixed at `VIEW_HEIGHT` and only widens the frustum, so an
ultrawide screen sees more table rather than smaller cards. The `CameraRig` component
(`src/app/scene/camera-rig/camera-rig.ts`) seats it: a bird's-eye base pose (~26° off
vertical, `CAMERA_TARGET` + `CAMERA_OFFSET`, aimed toward the player's own end, z = 1) looking
down on the table from the player's table end — mirrored to the
opposite (−Z) end for non-owners via `RoomService.isRoomOwner()`, set once on mount through
`SceneCamera.setBasePose` (the former mouse-edge pan was removed as irritating under the
orthographic view). **Camera controls** live in `SceneCamera` (listeners attached by Scene next
to `CardInteractions`): middle-mouse drag pans — it intersects the cursor ray with the tabletop
before/after each move and shifts camera and target by the difference, so the table point under
the cursor follows it for both seats; the wheel over the canvas zooms (`camera.zoom`,
`MIN_ZOOM` 0.5 … `MAX_ZOOM` 2.5, around the cursor; the listener is non-passive and only reacts
when the canvas itself is the target, so the hand's wheel scroll in `zones.ts` still works); `C`
or `Home` (`RECENTER_KEYS` in `hotkeys.ts`, listed in `HOTKEY_GUIDE`) resets pan and zoom to the
base pose. The pan is clamped so the look-at point stays within `TABLE_WIDTH` × `TABLE_DEPTH`.
`apply()` refreshes `updateProjectionMatrix`/`updateMatrixWorld` on every change, because
`CardInteractions.setRayFromCursor` raycasts through the camera before the next render. Only
button 0 starts card drags and marquees, so the middle button never does. **The table is a flat
plane**, not a model: `Scene.addTable` builds a `PlaneGeometry(TABLE_WIDTH, TABLE_DEPTH)` (7 × 10 m,
constants in `scene-assets.ts`, along with `TABLE_Y` = 0.2, the tabletop height cards and drags
are tuned for) at `TABLE_Y`, registers it as a pick surface, and dresses it with `PLANK_WOOD`
through `applyTextureSet`; its UVs are scaled to a square so a 1.5 m tile is not stretched.
`Table01.glb` stays in `public/models/` but is no longer in `ENVIRONMENT_ASSETS` (empty); the
dark 40 × 40 m floor below remains as the fallback surface. `AttackZoneBorder` (`src/app/scene/attack-zone-border.ts`, created by Scene) outlines the attack zone band on the plane: a flat additive, unlit strip just above `TABLE_Y` (polygonOffset, not raycastable, not a surface). It shows a faint neutral outline, fades to a slightly pulsing red glow while `CardStore.hasCombat()` is true (pulse skipped under `prefers-reduced-motion`), and is disposed in `ngOnDestroy`; the glow stays at low opacity because there is no tone mapping. There are no
avatars or movement — the former door/avatar code was
removed with the pivot to a card-table view. `P2pService`'s position stream is dormant
(nothing calls `sendPosition()`; the service still provides `peerCount` for the chat badge
and is the transport to reuse for future high-frequency sync like card drags). For networked
interactive objects, use the `RoomService.worldState()`/`setWorldObject()` pattern (a stable
string id per object, last-writer-wins in Postgres). Remember to `dispose()` geometry and
materials when removing meshes you own.

**Lighting** (`textures.md`) is a warm tavern interior, set up in `Scene.ngAfterViewInit`: a
near-white warm `HemisphereLight` plus a weak overhead `DirectionalLight` fill, and two
fire-coloured `PointLight` "torches" at x = ±9, y = 2.6 (intensity 140, scaled for the 7 × 10 m
table; lights only, so pan and zoom cannot frame them) whose inverse-square falloff makes the
long table edges ~20% hotter than the middle (centre ≈3.0, edges ≈3.7, short ends ≈2.8). They flicker (±8%, two out-of-phase sines) from the render loop. Two constraints
bound the constants and are worth respecting when touching them. Only the torches are
saturated: three shades diffuse as `albedo / π × irradiance`, and the plank texture is already
a deep brown, so a saturated ambient crushes what green and blue it has left and the table
goes flat orange. And total irradiance sits at ~π — the point where a surface renders as its
own base colour — because the renderer runs with **no tone mapping** (so card art, drawn
emissive at full strength, matches the same image in the DOM), which means bright lit surfaces
clip rather than roll off. `TORCH_INTENSITY` is the value with the ceiling. The intensities
were derived by reproducing that shading math against the textures' measured average colours,
not by eye — re-check the same way rather than nudging blind.

Card interactions (see `designdocs/cardinteractions.md` and
`designdocs/featurerequests.md`) are **networked**: `CardStore`
(`src/app/scene/card/card-store.ts`, types in `card.types.ts`) is a computed projection over
`RoomService.worldState()` (`card:` ids), so every player sees the same table and a
late joiner starts from the persisted snapshot. Mutations write back through
`setWorldObject`/`removeWorldObject`; dragging stays a local `preview()` override until the
drop commits (remote players see the placement, not the 60 Hz cursor path — the P2P layer is
still the transport to reuse if live drag streaming is ever wanted). A card being played out
of the hand is more private still: `CardStore.addLocal()` keeps it entirely on this client
until the drop lands (`update()` promotes it into the shared world), so other players never
see a card that was merely considered. Cards render small
(`CARD_SCALE` in `card.ts` scales the 10×-authored model down onto the oversized table; each
cloned material also gets a small negative `polygonOffset` so coplanar cards don't z-fight).
A dragged card stays its 3D instance throughout — same size, same tapped pose, exactly like
a group drag (the former DOM "drag ghost" that stood in for a lone card was removed for that
consistency; a card dragged over the hand/pile widgets simply passes behind them).
`CardInteractions`
(`src/app/scene/card/card-interactions.ts`, provided by Scene, attached to the canvas)
raycasts hover/picking for cards, runs the drag-to-move flow (press and drag past
a small threshold → float at `DRAG_Y` → release commits onto whatever the camera-through-cursor
ray hits: table/floor/another card, so cards stack; a drop over a registered **`CardDropTarget`**
— the hand/deck/graveyard/exile UI, registered by Zones — routes the card into that zone
instead; a
drop that hits nothing snaps the card back; Escape cancels; a plain click taps/untaps a card —
a networked quarter turn via the `tapped` field on CardState), posts action-history lines, and
owns the popup state rendered by
`CardOverlay` (context menus for cards — view/tap/rotate/flip/related/duplicate/to-hand/
to-deck/to-graveyard/to-exile/delete, plus **turnOver** on a double-faced card only, and the
item menu) plus the **util window**
(`src/app/scene/util-window/`), opened by right-clicking empty table: the game items
(dice/coin/counters, see below) above a debounced card search
via `CardSearchService` (`card-search.service.ts` — fetches `{base}/cards/search` on the
user-deposited card API with `include_extras=true` so **tokens** show up too, cached per
API+query; without a deposit the util window shows a pointer to the Decks screen). A search
hit is **dragged** out of the grid (`armSpawnCardDrag` → the private `beginSpawnCardDrag`:
local-only spawn under the cursor, same drop flow as a hand play — table adds it, a zone
widget absorbs it, a miss discards it unseen; the former per-hit Table/Hand/Deck buttons are
gone). **Related cards** work the same way: `CardState.relatedNames` carries the names from
the card data's `all_parts` (populated by search hits and, for deck cards, by
`CardDatabaseService.lookup`), the panel resolves them to images via the card database, and
each entry is draggable onto the table (click = view large).
**Double-faced cards** (`designdocs/mdfcs.md`) ride along the same seam: a card object with
no whole-card image but an image per `card_faces` entry is two-sided, so `facesOf()`
(card-database.service.ts, shared with `CardSearchService`) yields `{src, back}` and
`CardState` carries `backSrc` + `flipped`. `flip`/**F** on such a card lying face up
_transforms_ it — the "other side" is a second front, not the card back — while a face-down
one turns back up and the menu's extra "Turn face down" entry covers the rest; the two face
names are the halves of the card's `"Front // Back"` name (`faceName()`/`faceSrc()` in
`card.types.ts`; a split card has one image, hence no `backSrc`, and never flips). The large
card view gains a "Flip to …" button for them — one dialog now serves table cards, related
entries and hand cards, and its flip is view-only (it never writes to the card). Hotkeys on the hovered card
live in the `HOTKEYS` record — which, with the labels and the read-only overview built from
it, lives in **`src/app/scene/card/hotkeys.ts`** (`designdocs/hotkeys.md`; keep that file free
of Three imports — the `HotkeyList` component beside it renders `HOTKEY_GUIDE`, and it is
shown both on the menu screen, behind Settings ▸ Hotkeys, and in-game from the Zones
overlay's "Hotkeys" button, which clears the hover first so trying out a key doesn't act on
a card behind the dialog). **D** duplicates: a copy of the
card, same pose, nudged clear and stamped with _my_ uid, and it is a `GROUP_ACTION`, so a
selection duplicates as one batched write keeping its layout.
**U** is global — `untapAll()` untaps every tapped card whose
`CardState.ownerUid` (stamped on every card put onto the table) is mine, in one batched
write, and the Zones overlay offers the same as an "Untap all" button next to the life
counter, alongside a **Hotkeys** button. **V** also works over a card in the **hand** (`designdocs/finaltouches.md`): hover
picking is a raycast and can't see DOM cards, so Zones publishes the one under the cursor into
`hoveredHandCard`, and the key opens `viewImage` — the shared "view a card with no table
instance" popup that the related panel uses too. **Both hovers are only trusted while the cursor
is demonstrably still on them**, because neither is cleared reliably by events: a pointer move
over the canvas re-picks `hoveredId` _and_ drops the hand hover, a move anywhere else clears
`hoveredId` (a DOM overlay is not the table), and the hand hover carries its ZoneCard id so
`handHover()` — the computed the keydown handler reads, never the raw signal — can ignore a card
that has left the hand. Playing a card destroys its hand button under the cursor, so no
`pointerleave` ever fires; without those rules **V** kept opening the card you last touched,
outranking whatever you were actually pointing at, and X/Delete could hit a card you had long
since moved away from. `CardInteractions.beginDragFromHand(id, event, hooks)` lets a card played from the
hand DOM continue in this same drag flow — the `HandDragHooks` `commit` (table drop, logs
the play) and `revert` (off-table miss or Escape, back into the hand) decide the ending. The
pointer listeners live on `window` (not the canvas) so a hand drag started over DOM keeps
following; hover picking is gated to moves whose target is the canvas.

**Attack zone / combat** (`src/app/scene/card/attack-zone.ts`, pure geometry, no Angular/Three): a horizontal band across the table centre, |z| <= `ZONE_HALF_DEPTH` (half the depth of the band that once held two whole lanes of cards), full table width. `CardState.combat` is absent (not in combat), `{role:'attack'}` or `{role:'block', target: attackerId}`. Seats: the room owner sits at +Z, everyone else at -Z (`seatOfUid`); attackers snap to the vertical centre of the band (z = 0, both seats), blockers stand on the defender's side just outside the band (z = −seat·`BLOCK_Z`, one card length plus `LANE_GAP` from the attacker, so they never cover it). `layoutCombat(cards, seatOf)` returns the pose of every combat card: attackers keep their dropped x (z snaps to 0), ordered by x then id, and are pushed apart only to avoid overlap: attackers closer than `ZONE_PADDING` merge into a cluster that stands side by side around the mean of its members' x, clamped to stay on the table, repeated until none overlap; the blockers of one attacker are centred on it, side by side while they fit the attacker's width, then overlapping each other (at most `BLOCKER_MAX_OVERLAP`, each one lifted by `STACK_LIFT`), and only then does the attacker slot widen and push its neighbours apart. Tapping is never touched (manual); blockers whose attacker is gone are `released`. `CardStore.setAttacking/setBlocking/clearCombat/relayoutCombat` write roles plus the whole layout in ONE `updateMany` batch and one history line, so the undo journal covers combat writes. Triggers: a drop whose centre lies in the band (`CardInteractions.routeCombat`, run after every drop, the primary card decides for a dragged multi-selection), a drop onto an opponent's attacker (block), the card menu entries Attack / Remove from combat (group actions, so a selection acts together; hotkey **A** = attack) and dragging a combat card out of the band (leaves combat). The glow state is `hasCombat` (any attacker).

**Selection** (`designdocs/cardselection.md`): dragging on empty table draws a marquee
(`marquee` signal, drawn by `CardOverlay`); on release every card whose origin projects
inside it lands in `selectedIds` and renders with the hover highlight. Pressing one selected
card drags the whole group (offsets kept, the cards stay in the scene — like every drag);
a plain click still taps just one; `act()` applies `GROUP_ACTIONS` (`card.types.ts`:
tap/related/delete) to the whole selection and drops the selection for anything else.
Clicking empty table, or grabbing/right-clicking a card that is not selected, clears it.
A dragged selection released over a zone widget goes into that zone as a whole: `CardInteractions` hands the primary card plus every group member to `CardDropTarget.acceptMany`, `ZoneStore.takeManyFromTable` deletes the table cards with one bulk delete, writes the zone once (deck: first card on top; other zones append) and posts ONE history line (names listed for graveyard/exile only), so it is one undo point; the selection is cleared and `routeCombat` does not run for the absorbed cards.

**Table items** (`designdocs/additionalitems.md`) live in `src/app/scene/item/`: `ItemStore`
(root) projects `item:` world objects into `ItemState` (kind, position, absolute unwrapped
`rotation`, `value`, `variant`, `color`, `attachedTo`) exactly like `CardStore` does for
cards, and the
`Item` component renders one — a placeholder body from `item-geometry.ts` (pip-textured d6
box, polyhedra for d4/d12/d20 with a value label sprite, a two-faced coin cylinder, a counter
disc whose canvas texture prints "+2/+2") unless a GLB is registered in `ITEM_MODEL_URLS`
(`scene-assets.ts`), in which case it clones that instead. An item picked in the util window
is not dropped at the click point: it spawns local-only (`ItemStore.addLocal`, mirroring
`CardStore`) already attached to the cursor via `CardInteractions.beginSpawnDrag`, and a
_click_ on the table (not a release — the button isn't held) places it, which is when the
shared world and the history first see it; Escape discards it unseen
(`designdocs/tableitems.md`). Rolls and flips are plain state
writes: `roll()`/`flip()` add whole turns to `rotation` (the d6 in quarter turns, so the pips
on top _are_ the logged result; the coin in half turns, so odd counts land it on the other
side) and every client lerps its own mesh over 1.5 s — no frame streaming and no physics.
Dice carry a **`color`** from the four-swatch palette in `DIE_PALETTE` (green/blue/red/yellow,
picked in the util window and sticky between spawns); it paints the d6's pip faces, the
polyhedra, the number label, and any registered GLB's untextured materials. A polyhedron's
label is one canvas repainted in place, so while the die tumbles it can cycle random in-range
numbers and only "decide" on `state.value` when it lands (`designdocs/newmechanics.md`).
Counters count up on left-click, down on right-click, have no menu (delete hotkey while
hovered), and attach to a card when dropped on one: `attachedTo` + a position that becomes an
offset from that card's origin, so the counter follows it and leaves the table with it. Their
`variant` is `plus` / `minus` / **`x`** — the last a plain multiplier ("2x") on a squared body
rather than a disc, which is why `counterFaceSlot()` exists (the printed face is material 1 on
the cylinder, 2 on the box). The two bodies also carry that face on differently-mapped
surfaces — Three maps the box's +Y as `u→+X, v→−Z` but the cylinder's cap as `u→+Z, v→+X`, a
quarter turn apart — so `makeCounterTexture` draws the disc's text rotated back to match
(derivation is in its doc comment). On top of that, `Item` gives a counter's pivot a **local**
`seatYaw()` turn so its value reads right way up from whichever end the viewer sits at; it is
deliberately not in the shared `ItemState`, and dice/coins are left alone.

Player zones (hand/deck/graveyard/exile) live in `src/app/zones/`: `ZoneStore` (root service)
projects `zone:<uid>:<kind>` world objects (`{ ownerName, cards }`; whole-zone LWW writes) and
owns draw/shuffle/play/take mutations, most posting a history line; closed zones (hand/deck)
log without card names. (`playFromHand` is the exception — it removes the card silently, and
the drop `commit` posts the "played X" line, so a drag released off the table reverts without
a trace.) The `Zones` component (rendered inside Scene, so it can reach the
Scene-provided stores) is the DOM overlay: my hand fanned bottom-center (drag a card onto the
table to play it — `startDrag` arms a press on pointerdown; past a small threshold it hands
off to `CardInteractions.beginDragFromHand`, spawning the card face-up at `seatYaw()` and
following the cursor; releasing over the table commits, releasing off-table returns it to the
hand; a hand too wide to fit is pannable by wheeling over it — `onHandWheel` shifts `handScroll`).
My deck pile draws on **left-click** and opens a right-click menu (shuffle, **Reveal** —
the top 1–5 cards, or an X typed in — and **Search**); the graveyard
and exile piles open on click. A card dragged onto a zone widget is absorbed by that zone:
Zones registers a
`CardDropTarget` per kind (hit-tested with `elementFromPoint`) that calls `takeFromTable`.
My **life and infect totals** (`life:<uid>` `{life, start, poison}`) are +/− buttons around a number; clicking the number swaps it for a small number input (`Zones.editing`, Enter/blur commits, Escape cancels, empty/NaN ignored). `ZoneStore.setLife/setPoison` write at once and post history lines "life 20 → 17" / "infect 2 → 3": a burst of +/− clicks is coalesced (value before the first click, one line 1 s after the last click, at most 1.5 s after the first so it stays below RoomService's 2 s quiet flush and the burst's pre-image lands on the new line — undoing the line restores the old total); a typed total (`immediate`), `startNewRound` and service destroy flush at once, a round reset by another client drops a pending line. The starting-life choice keeps its own line.
Other players' zone counts sit top-right, with examinable graveyard and exile. Zones are
**not** created on entry: until a player joins the game the
zone UI is hidden behind a **centred** "Choose Deck" button (`hasMine()` is the gate) whose
picker lists `DeckStore` decks; picking one only stages it (`pendingDeck`) — **confirming** is
what resolves every decklist entry against the card database, calls `loadDeck()` (zones
created with the shuffled deck), and starts prefetching the card images, so merely browsing
decks never costs a download. `refreshOwnerName()` only renames zones that already exist
(rejoin).
**Draw animation** (Zones): `draw()` hides the drawn hand card (`arriving`), a decorative `.fly` copy flies from the deck pile to the card's measured slot and flips face up (`flights`), then the card glows for 1.5 s (`fresh`). Every draw starts its own flight at once, so quick draws fly concurrently (no queue, nothing is finished early); an effect on the hand (`syncOwnFlights`) re-aims running flights at their card's new slot when the fan re-spreads (`tx`/`ty`/`rot`, transitioned through the `@property` vars in `styles.scss`) and ends only the flight of a card that left the hand. Opponents' draws (deck shrinks while hand grows by k) fly one card back per drawn card from their deck chip (max 5, staggered 80 ms). `prefers-reduced-motion` skips the flight and keeps the glow.

**Looking at my own deck** is `src/app/zones/reveal.ts` (pure) plus the `RevealPanel` component
(`reveal-panel/`), in two `RevealMode`s over one session model: **reveal** — scry the top n
(`designdocs/newmechanics.md`), routing cards to hand / deck (top) / bottom / graveyard — and
**search** — a tutor through the whole deck (`designdocs/finaltouches.md`), which just starts
with every card revealed, offers only hand/graveyard (`targetsFor`), filters by name
(`matchesQuery`), and adds a "Shuffle & close" button.
`ZoneStore.revealTop(n)` / `searchDeck()` only _peek_ — they move
nothing and log that a look happened, never what was seen — and the panel then routes each
card by drag, committing every step through
`applyReveal()` (deck + hand + graveyard in **one** batch). The load-bearing invariant is that
**no card is ever in limbo**: a revealed card the player has not placed is still sitting in the
deck, so `revealZones()` derives the deck as `top ++ pending ++ rest ++ bottom` and abandoning
the panel (or the tab) loses nothing. Cards put back on top go on as a stack — last placed is
first drawn. `undo()` pops one entry off the session's history, which starts at the untouched
state, so undo walks all the way back to the moment of the reveal.

The in-game overlays are sized in the global **`--u`** unit (`styles.scss`): 1% of the largest
16:9 box that fits the viewport (`min(1vw, 1.7778vh)`), with `--ui-gap` insetting widgets from
the screen edge. The UI is authored at 16:9 and grows with the window; on an ultrawide the
height caps the unit so nothing balloons.

Decks and the card database (`src/app/decks/`, `src/app/carddb/`): `DeckStore` (root) stores
decks either **locally** (guests — browser localStorage, key `virtual-tavern.decks`, per-device
and lost if cleared, which is acceptable) or **on the account** (signed-in non-guests — the
Supabase `decks` table, owner-only RLS). `available()` is true for anyone signed in (guest or
account) and false only when fully signed out; `decksGuard` and the menu's Decks link mirror
that. A session-following `effect` picks the store: a guest reads local decks, an account loads
its cloud decks and **`syncLocalToAccount`** uploads any local guest decks into the account
once (so a guest who registers keeps what they built), then clears local. `Deck` = id + name +
`{card, count, print?}` list; imported via `parseDecklist` (Arena/Moxfield/Archidekt/MTGO/
plain) or built in the deck editor; import/rename/remove are optimistic with rollback, and
`save(id, name, list)` / `create()` back the editor (`save` needs the `decks_update` policy,
`migration-2026-10-16-decks-update.sql`, and rolls back with a message without it). `decks()` is the player's own decks
with the **shipped** ones in front (see below); `ownDecks()` is the writable half, and it is
what localStorage/the `decks` table hold. The Decks screen (`decks.ts`) shows
each deck as a square backed by a cutout of its first card's art (right-click → rename/delete),
and left-clicking a deck opens the full-page **deck editor** (`decks/deck-editor/`): a draft
list with Save/Revert (Save writes through `DeckStore.save`; leaving with changes asks first),
name edit, card search (`deck-card-search`: `/cards/autocomplete` + `/cards/search` through
`CardPrintService`), +/− counts, per-line artwork picker, list or image-grid view (`deck-lines`),
sort (name/mana value/color/type/rarity), group (type/color/mana value), filters (text, color,
type, mana value), group and total counts, a mana curve (`deck-curve`) and decklist export with
`(SET) number`. Type/cost/rarity come from `CardPrintService.cardInfos` (`/cards/collection` by
name, cached; `carddb/card-info.ts`), the pure sort/group/filter logic is `deck-view.ts`, list
edits are `deck-edit.ts`. The deck model is one flat list, so there are no sideboard/commander
sections. Included decks open read-only with "Save a copy to edit". "← Back" returns to the
overview; "+ New deck" creates an empty deck and opens it.
**Default decks** (`designdocs/defaultdecks.md`) are plain decklist `.txt` files in
`public/decks/`. Static hosting has no directory listing, so
`scripts/generate-deck-manifest.mjs` writes `public/decks/index.json` from that folder (wired
to the `pre*` npm scripts, and committed so a bare `ng build` still ships them); `BuiltInDecks`
(root, `built-in-decks.ts`) fetches the index and each file, parses them with the same
`parseDecklist`, and names each deck after its file (`black_demons.txt` → "Black Demons").
`DeckStore` merges them in at **read** time instead of copying them into anyone's storage —
that is what makes a decklist added later show up for existing users — and they are read-only
(`isBuiltInDeck`, id `builtin:<file>`; rename/remove ignore them). A missing manifest, file or
unparseable list costs that deck and nothing else, like the missing-GLB fallback. Adding a deck
is therefore: drop the `.txt` in, rebuild.
**The card API is user-deposited** (`designdocs/legal.md`): the app ships **no** card-data
endpoint of its own. `CardApiService` (root, `src/app/carddb/card-api.service.ts`) holds the
base URL of the Scryfall-_compatible_ API the user has provided — registered users keep it in
their account info (auth `user_metadata['card_api_url']`, written via
`SupabaseService.setCardApiUrl`), guests only temporarily in sessionStorage; a guest's deposit
follows them into a fresh account like decks do. The Decks screen's header has the
add/change-API button and modal (`apiDraft`/`saveApi`); until something is deposited,
`configured()` is false, card search errors with a pointer to that screen, and the card
database sits idle and empty.
`CardDatabaseService` (root) is the local card database: an `effect` follows
`CardApiService.apiUrl` (the service is created eagerly by an app initializer, never awaited)
— once an API exists it loads a compact name→image index from the IndexedDB cache
(`CardDbCache`) or, on first run against that API, resolves the download via the API's
`/bulk-data` listing (`default_cards` entry — `download_uri` or `jsonl_download_uri`),
gunzips `.gz` files in-stream (`DecompressionStream`, chosen by sniffing the magic bytes —
headers can't distinguish a raw `.gz` file from a transparently `Content-Encoding`-inflated
response), and streams it through `JsonChunkParser` (JSON array **or** JSON Lines; ~450 MB —
never buffered whole; bounded memory), caching the distilled index. `lookup(name)`
resolves decklist names (incl. double-faced front faces) to `{name, src, back?, related?}` —
`related` holds the card's `all_parts` names (tokens it creates, meld results, …), `back` the
second face of a double-faced card (mdfcs.md; the front-name alias shares the record, so a
decklist that spells only the front still reaches it), and
tokens are indexed like any other bulk-file card, which is what the related panel resolves
against. The cache key embeds the API base URL plus an index version (`index:v4:` since the
second face was added; the same base's v2/v3 entries are deleted after the rebuild), so changing
the deposit loads that API's own index (and the pre-deposit legacy cache entry is deleted
on boot). Zone cards keep only a name and a front image: `Zones.tableCard()` re-resolves the
related names **and** the second face through `lookup` whenever a card leaves a zone for the
table, so those facts live in exactly one place.

### 3D assets

Environment models are **plain GLB** files (no Draco) in `public/models/` (served at
`/models/*.glb`), registered in the `ENVIRONMENT_ASSETS` manifest
(`src/app/scene/scene-assets.ts` — the Blender export convention is documented there: 1 unit
= 1 m, +Y up, origin at floor level). `AssetLoaderService`
(`src/app/scene/asset-loader.service.ts`) wraps GLTFLoader with promise caching (dedupe +
instant rejoin) and `loading`/`progress`/`error` signals that drive the scene's loading
overlay. Cached Groups are never disposed — `dispose()` is only for replaced procedural
placeholders. Missing model files fall back gracefully to the procedural floor (console warn),
so the app works before any GLB exists. Item models are optional in the same spirit:
a kind without an `ITEM_MODEL_URLS` entry renders its procedural placeholder and no request
is ever made for a file that isn't there; a registered model (currently the d4) is
normalised on load to the placeholder's size and centred on its bounding box
(`Item.normalizeModel`), so authored scale/origin don't matter, and untextured full-metal
default materials are made matte so they don't render black.

An environment asset may also carry a **`PbrTextureSet`** (`textures.md`): base colour + any
of normal/roughness/AO under `public/textures/`, plus a **`tileMetres`**. After the GLB loads,
`applyTextureSet` (`src/app/scene/environment-material.ts`) replaces _every_ material in it
with one `MeshStandardMaterial` built from those maps — the table wears
`textures/PlankFloor/` this way. It is not awaited: the model is on the table wearing its
authored material while the maps download. Two things to know. The **repeat is measured, not
guessed**: a Blender unwrap packs the faces into an atlas, so 0..1 UV is the whole model and
the tiling has to come from the ratio of UV area to world area over every triangle ("UV units
per metre"), which is what makes `tileMetres` mean metres. And it runs **once per model**
(`WeakMap`), because `AssetLoaderService` hands the same cached `Group` to every scene mount.
There is deliberately no height/displacement entry — displacement is per-vertex and these are
low-poly boxes, so the relief comes from the normal map. `AssetLoaderService.loadTexture`
takes a **`TextureKind`** for this: `'color'` (sRGB, the default, card art and base colour)
or `'data'` (linear — a gamma-decoded normal/roughness/AO map is simply wrong); the cache key
includes it.

`loadTexture` (card art, from the deposited card API) tries an `<img>` first and falls back to fetching the
bytes in CORS mode and building the texture from an `ImageBitmap`. That fallback exists
because the same art is also shown in the DOM: an `<img>` **without** `crossorigin` can leave
an opaque response in the HTTP cache that then fails as a WebGL texture — cards with images
everywhere except on the table. Every card `<img>` in the app therefore sets
`crossorigin="anonymous"`; keep it that way when adding new ones.

Instanced objects (cards, items) are Angular components that render into Three, not the DOM: the
Scene component provides `SceneGraph` (`src/app/scene/scene-graph.ts`, a root `Group` added
to the Three scene), and `Card` (`src/app/scene/card/card.ts`, rendered per `CardState` by
the Scene's `@for`) clones the shared card model (`CARD_MODEL_URL`), takes per-instance
clones of **all** its materials (so hover can tint the whole mesh; the front-face clone —
name matching `/front|artwork/i` — is textured from `state().src` via
`AssetLoaderService.loadTexture`, cached, sRGB, `flipY = false` to match glTF UVs), and
registers its `Group` with `CardInteractions` for raycast picking. On destroy a card
disposes only its cloned materials — geometry/textures stay shared. `Item`
(`src/app/scene/item/item.ts`) follows the same pattern for dice/coins/counters, but owns its
procedural geometry and canvas textures too, so it disposes those as well; its nodes are
wrapper (world position) → pivot (rest height, and the coin's hop) → body (what a roll
rotates). Follow this pattern for future instanced scene objects — and never read the
required `state` input synchronously in the constructor: inputs are bound only after
construction (NG0950). `Item` defers its spawn with `afterNextRender`; `Card` gets away
with a constructor call only because its spawn `await`s the model load before touching
`state`.

### Routing and screens

`App` is just a `<router-outlet>`. Routes (`app.routes.ts`):

- `''` → `Menu` (`src/app/menu/`): landing screen. Signed out, the primary button opens the
  Auth dialog — **tabbed**: a Sign in tab (email/password) and a Sign up tab (email/password +
  a chosen **username** stored as `display_name` so an account is never shown as "Guest"),
  with continue-as-guest at the bottom of both. Signing in lands
  back on the menu (not straight into Play). Signed in, the primary button opens the Play
  dialog — also tabbed: Join room (by code) / Create room (room name **required, ≥3 chars**).
  Only guests type a per-room display name (shown on both tabs); registered players always
  play under their username. Also Decks
  (`routerLink="/decks"`, shown for anyone signed in — guests included), Settings (sample,
  not-yet-persisted, plus a **Hotkeys** button opening the read-only controls overview —
  it replaces the settings dialog rather than stacking a second modal, with a Back button),
  and Sign out.
- `'decks'` → `Decks` (`src/app/decks/`, guarded by `decksGuard` — only fully signed-out
  visitors are redirected to `/`): deck screen — import a pasted decklist or start an empty deck, deck-square overview
  (left-click to open the full-page deck editor, right-click to rename/delete), card database
  status line, and the card-API deposit button + modal (legal.md).
- `'tavern'` → `Tavern` (`src/app/tavern/`): hosts `Scene` + `Chat`. Guarded by `tavernGuard`
  (`tavern-guard.ts`, an async `CanActivateFn`): if no room is joined it first tries
  `RoomService.resume()` — the current room is persisted in localStorage on entry and cleared
  only by an explicit `leave()`, so a page reload rejoins the same room (re-validated through
  the join-by-code RPC) — and redirects to `/` only if that fails.

`Chat` (`src/app/chat/`) is the in-room panel docked left of the table (Tavern is a flex row, so the scene takes the width a fold frees; `collapsed` persisted in localStorage `virtual-tavern.chat-collapsed`, folded slim bar with an unread badge counting chat messages from others since the fold) and the game history: shows the room name and
share code + peer count, and renders `room.messages()` split over two tabs — **Chat**
(default) with the user-typed messages (own messages matched by auth uid, colored) and
**History** with the `'action'`-kind game lines since the latest new round (from the
`room.historyStart()` barrier line on, matched by message id, fallback by time `t`; the "New round
started" line is the first one; plain white; undone lines grey and struck through). The Chat tab
keeps all typed messages. History lines in `room.undoable()` carry a ↶ button, and an "Undo last" button sits above
the log; both open a `Dialog` confirmation ("Undo N action(s)? … This affects all players.") and only
its Undo button calls `room.undoTo()`. The room name has its own row, the share code has a Copy
button. The log stays pinned to the
newest message of the active tab, and its
Leave button calls `room.leave()` and routes back to `/`. Popups use the reusable `Dialog`
(`src/app/shared/dialog/`), a modal that projects content via `<ng-content>` and emits `close`
on backdrop click or Esc. Its `fit` input sizes the frame to the projected content instead of
the default fixed width (used by the card view dialog so the frame hugs the card image rather
than boxing it at a half-width). Note: content projected into `Dialog` stays in the
**parent's** style scope (emulated encapsulation), so style projected form elements from the
parent's `.scss`.

## Conventions

- **Zoneless + signals throughout.** No `zone.js`; use signals, `computed`, and the new control
  flow (`@if`/`@for`/`@empty`). Components are standalone (declared explicitly with
  `standalone: true`); each has its template and styles in
  sibling `.html`/`.scss` files referenced via `templateUrl`/`styleUrl` (no inline `template:`
  or `styles:`).
- Filenames omit the `.component` suffix (`scene.ts`, `chat.ts`), matching Angular 22 defaults.
- TypeScript is strict, incl. `noPropertyAccessFromIndexSignature` — index into records with
  bracket notation (`worldState()[id]`, `user_metadata['display_name']`).
- Tests mock at the service seam (`{ provide: SupabaseService, useValue: ... }` with a small
  chainable query-builder stub) — never mock supabase-js internals. See
  `src/app/room/room.service.spec.ts` for the pattern. Stores/components above RoomService
  use the shared `FakeRoomService` (`src/app/room/testing/fake-room.service.ts`): an
  in-memory world with synchronous writes and recorded action lines.
