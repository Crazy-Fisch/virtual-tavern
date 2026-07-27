# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

- `npm start` — dev server at http://localhost:4200 (HMR on source changes)
- `npm run build` — production build to `dist/` (default config is `production`)
- `npm run watch` — rebuild on change with the development config
- `npm test` — run unit tests with Vitest (via `@angular/build:unit-test`)
- Run a single test file: `npx ng test --include src/app/path/to/file.spec.ts`
- `npx ng generate component <name>` — scaffold (styles default to SCSS, selector prefix `app`)

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
  `displayName`. `createRoom()` inserts an owned row (share code generated server-side);
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
  as `token:` rows from removed features are ignored); `setWorldObject(id, data)` upserts
  optimistically (a DB trigger stamps the authoritative `updated_at` used for
  last-writer-wins; own echoes are adopted unconditionally to heal client clock skew) and
  `removeWorldObject(id)` deletes. Realtime DELETE events are not filtered by Supabase, so
  the handler drops other rooms' deletes by `old.room_id`. Seating: `RoomInfo.ownerId` (from
  the create insert or the join RPC's `room_owner`) feeds `isRoomOwner`/`seatYaw` — the room
  creator sits at +Z, everyone else views from the mirrored −Z table end and spawns their
  cards with `yaw = seatYaw()` so the cards read upright from their side.

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
`migration-2026-07-19-polish.sql` — decks table + `get_room_by_code` returning the owner).
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
(`src/app/scene/camera-rig/camera-rig.ts`) poses it: a fixed bird's-eye base pose (~26° off
vertical, `CAMERA_POS`/`CAMERA_TARGET`, aimed slightly toward the player's own end) looking
down on the table from the player's table end — mirrored to the
opposite (−Z) end for non-owners via `RoomService.isRoomOwner()`, fixed once on mount — plus
a slight clamped pan toward the mouse near screen edges. There are no avatars or movement — the former door/avatar code was
removed with the pivot to a card-table view. `P2pService`'s position stream is dormant
(nothing calls `sendPosition()`; the service still provides `peerCount` for the chat badge
and is the transport to reuse for future high-frequency sync like card drags). For networked
interactive objects, use the `RoomService.worldState()`/`setWorldObject()` pattern (a stable
string id per object, last-writer-wins in Postgres). Remember to `dispose()` geometry and
materials when removing meshes you own.

Card interactions (see `designdocs/cardinteractions.md` and
`designdocs/featurerequests.md`) are **networked**: `CardStore`
(`src/app/scene/card/card-store.ts`, types in `card.types.ts`) is a computed projection over
`RoomService.worldState()` (`card:` ids), so every player sees the same table and a
late joiner starts from the persisted snapshot. Mutations write back through
`setWorldObject`/`removeWorldObject`; dragging stays a local `preview()` override until the
drop commits (remote players see the placement, not the 60 Hz cursor path — the P2P layer is
still the transport to reuse if live drag streaming is ever wanted). Cards render small
(`CARD_SCALE` in `card.ts` scales the 10×-authored model down onto the oversized table; each
cloned material also gets a small negative `polygonOffset` so coplanar cards don't z-fight).
While a card is being dragged its 3D instance is hidden and a DOM "ghost" (`dragGhost` signal,
rendered by the Zones overlay) follows the cursor on top of all UI, so the dragged card never
disappears behind the hand/pile widgets. `CardInteractions`
(`src/app/scene/card/card-interactions.ts`, provided by Scene, attached to the canvas)
raycasts hover/picking for cards, runs the drag-to-move flow (press and drag past
a small threshold → float at `DRAG_Y` → release commits onto whatever the camera-through-cursor
ray hits: table/floor/another card, so cards stack; a drop over a registered **`CardDropTarget`**
— the hand/deck/graveyard/exile UI, registered by Zones — routes the card into that zone
instead; a
drop that hits nothing snaps the card back; Escape cancels; a plain click taps/untaps a card —
a networked quarter turn via the `tapped` field on CardState), posts action-history lines, and
owns the popup state rendered by
`CardOverlay` (context menus for cards — view/tap/rotate/flip/related/to-hand/to-deck/
to-graveyard/to-exile/delete, and the item menu) plus the **util window**
(`src/app/scene/util-window/`), opened by right-clicking empty table: the game items
(dice/coin/counters, see below) above a debounced card search
via `CardSearchService` (`card-search.service.ts`, Scryfall fetch, cached) with per-hit
add-to-table/hand/deck. Hotkeys on the hovered card live in the `HOTKEYS` record.
`CardInteractions.beginDragFromHand(id, event, hooks)` lets a card played from the hand DOM
continue in this same drag flow — the `HandDragHooks` `commit` (table drop, logs the play)
and `revert` (off-table miss or Escape, back into the hand) decide the ending. The pointer
listeners live on `window` (not the canvas) so a hand drag started over DOM keeps following;
hover picking is gated to moves whose target is the canvas.

**Selection** (`designdocs/cardselection.md`): dragging on empty table draws a marquee
(`marquee` signal, drawn by `CardOverlay`); on release every card whose origin projects
inside it lands in `selectedIds` and renders with the hover highlight. Pressing one selected
card drags the whole group (offsets kept, no DOM ghost — the cards stay in the scene);
a plain click still taps just one; `act()` applies `GROUP_ACTIONS` (`card.types.ts`:
tap/related/delete) to the whole selection and drops the selection for anything else.
Clicking empty table, or grabbing/right-clicking a card that is not selected, clears it.

**Table items** (`designdocs/additionalitems.md`) live in `src/app/scene/item/`: `ItemStore`
(root) projects `item:` world objects into `ItemState` (kind, position, absolute unwrapped
`rotation`, `value`, `variant`, `attachedTo`) exactly like `CardStore` does for cards, and the
`Item` component renders one — a placeholder body from `item-geometry.ts` (pip-textured d6
box, polyhedra for d4/d12/d20 with a value label sprite, a two-faced coin cylinder, a counter
disc whose canvas texture prints "+2/+2") unless a GLB is registered in `ITEM_MODEL_URLS`
(`scene-assets.ts`), in which case it clones that instead. Rolls and flips are plain state
writes: `roll()`/`flip()` add whole turns to `rotation` (the d6 in quarter turns, so the pips
on top _are_ the logged result; the coin in half turns, so odd counts land it on the other
side) and every client lerps its own mesh over 1.5 s — no frame streaming and no physics.
Counters count up on left-click, down on right-click, have no menu (delete hotkey while
hovered), and attach to a card when dropped on one: `attachedTo` + a position that becomes an
offset from that card's origin, so the counter follows it and leaves the table with it.

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
My deck pile draws on **left-click** and opens a right-click menu (shuffle only); the graveyard
and exile piles open on click. A card dragged onto a zone widget is absorbed by that zone:
Zones registers a
`CardDropTarget` per kind (hit-tested with `elementFromPoint`) that calls `takeFromTable`.
Other players' zone counts sit top-right, with examinable graveyard and exile. Zones are
**not** created on entry: until a player joins the game the
zone UI is hidden behind a **centred** "Choose Deck" button (`hasMine()` is the gate) whose
picker lists `DeckStore` decks; picking one only stages it (`pendingDeck`) — **confirming** is
what resolves every decklist entry against the card database, calls `loadDeck()` (zones
created with the shuffled deck), and starts prefetching the card images, so merely browsing
decks never costs a download. `refreshOwnerName()` only renames zones that already exist
(rejoin).

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
`{card, count}` list; phase 1 import-only via `parseDecklist` (Arena/Moxfield/Archidekt/MTGO/
plain); import/rename/remove are optimistic with rollback. The Decks screen (`decks.ts`) shows
each deck as a square backed by a cutout of its first card's art (right-click → rename/delete),
and left-clicking a deck opens a full-page **deck view** — a scrollable grid of every card,
images resolved via the card database (white placeholder while loading, pink for an unknown
name); "← Back" returns to the overview.
`CardDatabaseService` (root) is the local card database: `init()` (fired, not awaited, from an
app initializer) loads a compact name→image index from the IndexedDB cache (`CardDbCache`) or,
on first run, streams the Scryfall bulk-data download through `JsonArrayChunkParser`
(~450 MB — never buffered whole; bounded memory) and caches the distilled index. `lookup(name)`
resolves decklist names (incl. double-faced front faces) to `{name, src}`. The cache key
embeds `BULK_DATA_URL`, so pointing it at a newer export invalidates the cache.

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
`ITEM_MODEL_URLS` is empty, so dice/coins/counters render procedural placeholders and no
request is ever made for a file that isn't there.

`loadTexture` (card art, from Scryfall) tries an `<img>` first and falls back to fetching the
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
rotates). Follow this pattern for future instanced scene objects.

### Routing and screens

`App` is just a `<router-outlet>`. Routes (`app.routes.ts`):

- `''` → `Menu` (`src/app/menu/`): landing screen. Signed out, the primary button opens the
  Auth dialog (email/password sign-in, sign-up with a chosen **username** stored as
  `display_name` so an account is never shown as "Guest", continue-as-guest). Signing in lands
  back on the menu (not straight into Play). Signed in, the primary button opens the Play
  dialog: join-by-code or create-room (room name **required, ≥3 chars**). Only guests type a
  per-room display name; registered players always play under their username. Also Decks
  (`routerLink="/decks"`, shown for anyone signed in — guests included), Settings (sample,
  not-yet-persisted), and Sign out.
- `'decks'` → `Decks` (`src/app/decks/`, guarded by `decksGuard` — only fully signed-out
  visitors are redirected to `/`): deck screen — import a pasted decklist, deck-square overview
  (left-click to open the full-page deck view, right-click to rename/delete), card database
  status line.
- `'tavern'` → `Tavern` (`src/app/tavern/`): hosts `Scene` + `Chat`. Guarded by `tavernGuard`
  (`tavern-guard.ts`, an async `CanActivateFn`): if no room is joined it first tries
  `RoomService.resume()` — the current room is persisted in localStorage on entry and cleared
  only by an explicit `leave()`, so a page reload rejoins the same room (re-validated through
  the join-by-code RPC) — and redirects to `/` only if that fails.

`Chat` (`src/app/chat/`) is the in-room overlay and the game history: shows the room name and
share code + peer count, renders `room.messages()` (own messages matched by auth uid; `'action'`
kind lines plain white, typed messages colored, log pinned to the newest message), and its
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
