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
  prefix names the owning domain (`card:` CardStore, `zone:` ZoneStore; unknown prefixes such
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
`SceneGraph`) and is driven by the `CameraRig` component
(`src/app/scene/camera-rig/camera-rig.ts`): a fixed near-bird's-eye base pose (~20° off
vertical, `CAMERA_POS`/`CAMERA_TARGET` in camera-rig.ts) looking down on the table from the
player's table end — mirrored to the opposite (−Z) end for non-owners via
`RoomService.isRoomOwner()`, fixed once on mount — plus a slight clamped pan toward the
mouse near screen edges. There are no avatars or movement — the former door/avatar code was
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
(`CARD_SCALE` in `card.ts` scales the 10×-authored model down to ~real proportions on the
oversized table). `CardInteractions`
(`src/app/scene/card/card-interactions.ts`, provided by Scene, attached to the canvas)
raycasts hover/picking for cards, runs the drag-to-move flow (press and drag past
a small threshold → float at `DRAG_Y` → release commits onto whatever the camera-through-cursor
ray hits: table/floor/another card, so cards stack; a drop that hits nothing snaps the card
back; Escape cancels; a plain click taps/untaps a card — a networked quarter turn via the
`tapped` field on CardState), posts action-history lines, and owns the popup state rendered by
`CardOverlay` (context menus for cards — view/rotate/flip/related/to-hand/to-deck/
to-graveyard/delete) plus the **util window**
(`src/app/scene/util-window/`), opened by right-clicking empty table: debounced card search
via `CardSearchService` (`card-search.service.ts`, Scryfall fetch, cached) with per-hit
add-to-table/hand/deck. Hotkeys on the hovered card live in the `HOTKEYS` record.
`CardInteractions.beginDragFromHand(id, event, hooks)` lets a card played from the hand DOM
continue in this same drag flow — the `HandDragHooks` `commit` (table drop, logs the play)
and `revert` (off-table miss or Escape, back into the hand) decide the ending. The pointer
listeners live on `window` (not the canvas) so a hand drag started over DOM keeps following;
hover picking is gated to moves whose target is the canvas. Dice/coins/counters (the former
`src/app/scene/token/` `TokenStore` + procedural `Token`) were removed.

Player zones (hand/deck/graveyard) live in `src/app/zones/`: `ZoneStore` (root service)
projects `zone:<uid>:<kind>` world objects (`{ ownerName, cards }`; whole-zone LWW writes) and
owns draw/shuffle/play/take mutations, most posting a history line; closed zones (hand/deck)
log without card names. (`playFromHand` is the exception — it removes the card silently, and
the drop `commit` posts the "played X" line, so a drag released off the table reverts without
a trace.) The `Zones` component (rendered inside Scene, so it can reach the
Scene-provided stores) is the DOM overlay: my hand fanned bottom-center (drag a card onto the
table to play it — `startDrag` arms a press on pointerdown; past a small threshold it hands
off to `CardInteractions.beginDragFromHand`, spawning the card face-up at `seatYaw()` and
following the cursor; releasing over the table commits, releasing off-table returns it to the
hand), my deck/graveyard piles with right-click menus (draw/shuffle/examine), other players'
zone counts top-right with examinable graveyards. Zones are **not** created on entry: until a player joins the game the
zone UI is hidden behind a bottom-right "Choose Deck" button (`hasMine()` is the gate) whose
picker lists `DeckStore` decks; choosing one resolves every decklist entry against the card
database, calls `loadDeck()` (zones created with the shuffled deck), and prefetches the card
images. `refreshOwnerName()` only renames zones that already exist (rejoin).

Decks and the card database (`src/app/decks/`, `src/app/carddb/`): `DeckStore` (root) persists
imported decks per account in the Supabase `decks` table (owner-only RLS; `Deck` = id + name +
`{card, count}` list; phase 1 import-only via `parseDecklist`, a multi-format text parser —
Arena/Moxfield/Archidekt/MTGO/plain). Decks are an **account feature**: `available()` is false
for guests and signed-out users (no decks, imports blocked, and the Decks screen hidden on the
menu + guarded by `decksGuard`). A session-following `effect` loads the account's decks on
sign-in and clears them on sign-out; imports/removes are optimistic with rollback. Decks
imported before this (the old per-browser localStorage) are uploaded once on the first
signed-in load (`migrateLegacy`).
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
so the app works before any GLB exists.

Instanced objects (cards) are Angular components that render into Three, not the DOM: the
Scene component provides `SceneGraph` (`src/app/scene/scene-graph.ts`, a root `Group` added
to the Three scene), and `Card` (`src/app/scene/card/card.ts`, rendered per `CardState` by
the Scene's `@for`) clones the shared card model (`CARD_MODEL_URL`), takes per-instance
clones of **all** its materials (so hover can tint the whole mesh; the front-face clone —
name matching `/front|artwork/i` — is textured from `state().src` via
`AssetLoaderService.loadTexture`, cached, sRGB, `flipY = false` to match glTF UVs), and
registers its `Group` with `CardInteractions` for raycast picking. On destroy a card
disposes only its cloned materials — geometry/textures stay shared. Follow this pattern for
future instanced scene objects.

### Routing and screens

`App` is just a `<router-outlet>`. Routes (`app.routes.ts`):

- `''` → `Menu` (`src/app/menu/`): landing screen. Signed out, the primary button opens the
  Auth dialog (email/password sign-in, sign-up, continue-as-guest). Signed in, it opens the
  Play dialog (display name + join-by-code or create-room); success navigates to `/tavern`.
  Also Decks (`routerLink="/decks"`, shown only for signed-in non-guests — decks are an
  account feature), Settings (sample, not-yet-persisted), and Sign out.
- `'decks'` → `Decks` (`src/app/decks/`, guarded by `decksGuard` — guests and signed-out
  visitors are redirected to `/`): deck screen — import a pasted decklist (name +
  textarea), overview grid of deck squares (name + card count, right-click to delete), card
  database status line.
- `'tavern'` → `Tavern` (`src/app/tavern/`): hosts `Scene` + `Chat`. Guarded by `tavernGuard`
  (`tavern-guard.ts`, an async `CanActivateFn`): if no room is joined it first tries
  `RoomService.resume()` — the current room is persisted in localStorage on entry and cleared
  only by an explicit `leave()`, so a page reload rejoins the same room (re-validated through
  the join-by-code RPC) — and redirects to `/` only if that fails.

`Chat` (`src/app/chat/`) is the in-room overlay and the game history: shows the room share
code + peer count, renders `room.messages()` (own messages matched by auth uid; `'action'`
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
