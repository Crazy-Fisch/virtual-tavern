# CODEMAP (Virtual Tavern) - terse, for agents. Detail: CLAUDE.md (long, accurate), designdocs/*.md

## Stack
Angular 22 (standalone, zoneless, signals, @if/@for, templateUrl+styleUrl .html/.scss, no `.component` suffix), TypeScript ~6.0 strict (`noPropertyAccessFromIndexSignature`: use `obj['k']`), Three 0.185 (3D table, orthographic cam), Supabase (auth+Postgres+Realtime, publishable key in src/environments/environment.ts), Trystero 0.25 (WebRTC, dormant: only pos/name actions, peerCount), Vitest 4 via `@angular/build:unit-test` + jsdom. Prettier (.prettierrc), no lint. Deploy: GitHub Pages (.github/workflows/deploy.yml, `build:pages`).

## Commands (cwd = this dir; node_modules installed)
- dev: `npm start` (http://localhost:4200; prestart regenerates public/decks/index.json)
- build: `npm run build` (-> dist/virtual-tavern/browser)
- test: `npm test` (agents: `npx ng test --no-watch`; one file: `npx ng test --include src/app/<path>.spec.ts`)
- Supabase is remote (no local backend). SQL change = new `supabase/migration-YYYY-MM-DD-*.sql` + update `supabase/schema.sql`.

## Layout (src/app)
- `supabase/` SupabaseService (auth session signals, setCardApiUrl in user_metadata)
- `room/` RoomService (rooms, chat/history, world_objects sync), room.types.ts, `testing/fake-room.service.ts` (use in store/component specs)
- `p2p/` P2pService (Trystero, no game state)
- `scene/` Scene (renderer; provides SceneGraph/SceneCamera/CardInteractions), `card/` (card-store, card-interactions 994 lines, card.ts, card.types.ts, hotkeys.ts, card-overlay/ menus + viewImage dialog, card-search.service.ts), `item/` (dice/coin/counters ON TABLE: item-store, item.ts, item-geometry.ts, item.types.ts), `util-window/` (right-click table: items + card search), camera-rig/
- `zones/` ZoneStore (zone-store.ts), Zones overlay (zones.ts/.html/.scss: hand fan, piles, life, deck picker, opponents), reveal.ts + reveal-panel/ (scry/search)
- `decks/` DeckStore, decklist-parser.ts, deck.types.ts, built-in-decks.ts (public/decks/*.txt + index.json), decks.ts/.html/.scss (Decks screen + deck view grid), decks-guard.ts
- `carddb/` CardApiService (user-deposited Scryfall-compatible base URL), CardDatabaseService (bulk index), card-db-cache.ts (IndexedDB), json-chunk-parser.ts
- `chat/` Chat (chat.ts/.html/.scss) = chat + history panel + Leave
- `menu/` Menu (auth, play dialog create/join room, settings); `tavern/` Tavern (hosts Scene+Chat; tavern-guard resumes room); `shared/dialog/` Dialog
- routes (app.routes.ts): '' Menu, 'decks' Decks (decksGuard), 'tavern' Tavern (tavernGuard)

## Room/game/round state + sync
- NO "game" or "round" object exists. A room = rooms row (id, code, name, owner_id). All shared state = `world_objects` rows (room_id, object_id, jsonb data, updated_at trigger, last-writer-wins) + `chat_messages` rows (kind 'chat'|'action'). Delivered through ONE Supabase realtime channel (postgres_changes) per room; presence is used for close-room detection. P2P is NOT used for game state.
- RoomService (room/room.service.ts): signals currentRoom, joined, messages, worldState, userId, displayName; `createRoom/joinByCode/resume`, `sendChat`, `sendAction(text)` (history line, kind 'action'), `setWorldObject(id,data)`, `setWorldObjects([[id,data],...])` (ONE atomic upsert), `removeWorldObject(id)` (single delete, NO bulk delete), `leave()` (close_room RPC if last out; FK cascade deletes all rows), `isRoomOwner()/seatYaw()`.
- world object id prefixes: `card:<uuid>` CardStore, `item:<uuid>` ItemStore, `zone:<uid>:<hand|deck|graveyard|exile>` ZoneStore ({ownerName, cards:[{id,name,src,revealed?}]}), `life:<uid>` ({life}). Unknown prefixes are ignored by all stores, so a new prefix (e.g. `round:`) is safe for old code but must be parsed in new code.
- A player "joins the game" by choosing a deck: Zones `confirmDeck()` -> `ZoneStore.loadDeck(cards)` (zone-store.ts:113) rewrites MY 4 zones (fresh shuffled deck). Table cards, items and life are NOT reset by it. Re-picking a deck is today's only (per-player) restart.

## Counters
- Life only: `LIFE_PREFIX/lifeId()` zone.types.ts; `ZoneStore.setLife` zone-store.ts:256 (silent after the first, logs only the starting choice); `PlayerZones.life` filled in zone-store.ts ~81-87; UI `Zones.chooseLife/bumpLife` zones.ts:305-315, template zones.html:89-101 (own, bottom-left) and zones.html:7 (`opp-life`, opponents top-right). Starting-life options const near zones.ts:43.
- No poison/infect anywhere (grep empty). Table counters (+/-/x) are ItemStore items, unrelated to player totals.

## Card zones, moves, history
- ZoneStore (zones/zone-store.ts): `all/mine/others/hasMine`, `write(kind,cards)` / `writeZones([[kind,cards]...])` (atomic), `draw()` :139 (moves deck[0] to END of hand; logs "drew a card"), `shuffle`, `revealTop/searchDeck` (log only), `applyReveal`, `takeFromTable(card,kind)` :204 (logs via TAKE_ACTIONS :36), `addCard(kind,card)` (silent), `playFromHand(id)` (silent), `removeFromZone` (silent), `revealHand/toggleReveal`.
- Hand UI: zones.ts (`startDrag` arms press, `beginPlay` :412 hand->table drag, `beginZoneDrag` graveyard/exile->table, `handCardTransform`, wheel scroll `handScroll`, `confirmDeck` :219 resolves names via `db.lookup`, `tableCard()` zone card -> CardState); zones.html (hand ~:60-90, piles, deck picker ~:225-270). Drop targets registered in zones.ts ~:125-160 (`accept: takeFromTable(card, kind)` :131).
- Table drag: card-interactions.ts `beginDragFromHand` :316, drop handling ~:630-650 (`dropTargetAt` -> `target.accept(card)`; else `tryPlace` + `handDrag.commit()`; else `handDrag.revert()`), Escape revert ~:727, `tryPlace` :833. Menu action switch ~:430-510 (`toHand` :475, `toZone` :543 -> takeFromTable).
- All history lines = `room.sendAction(text)` (grep `sendAction` in zone-store.ts, card-interactions.ts, zones.ts, reveal-panel.ts, item/, util-window/).
- QUIET RETURN CAUSE: a hand card dragged and dropped back on the HAND widget hits a CardDropTarget -> `takeFromTable(card,'hand')` -> logs "returned <name> to their hand" (TAKE_ACTIONS.hand, zone-store.ts:37). Off-table drop / Escape (`revert`) already log nothing. Fix: skip the log when the card came from the hand (local-only card: `room.worldState()[card.id]` is absent in takeFromTable, or pass a flag through `CardDropTarget.accept`). Keep the log for real table->hand (menu toHand / H hotkey).

## Deck model + import
- `Deck {id,name,list: DeckEntry[]}`, `DeckEntry {card: string, count: number}` (decks/deck.types.ts): NO set/collector/printing info.
- `parseDecklist(text)` decks/decklist-parser.ts: counts (`4`, `4x`, `x4`), SB:, section headers, `[cat]` `*F*` `^x^` markers; `SET_AND_COLLECTOR` regex (`(SET) 123`) is stripped in `stripDecorations` and DISCARDED; duplicates merge by lowercased name. Spec: decklist-parser.spec.ts.
- DeckStore (decks/deck-store.ts): `decks()` = builtIn + own; `import(name,text)` :87 (parseDecklist -> Deck); `rename/remove`; guests = localStorage `virtual-tavern.decks`, accounts = Supabase `decks` table (id, owner_id, name, `list` jsonb; schema.sql:48, owner-only RLS). No edit/update method (import-only); `syncLocalToAccount` uploads guest decks. Built-in decks are read-only (`isBuiltInDeck`, id `builtin:<file>`, public/decks/*.txt, same parser).
- Decks screen decks.ts/.html: textarea import, deck squares (first-card art via db.lookup), deck view = card grid (decks.html ~:33), card-API deposit modal.
- In game: entries expanded to `ZoneCard {id: uuid, name, src}` per copy in zones.ts `confirmDeck` using `db.lookup(entry.card)` (by name only).

## Scryfall usage
- Only via the user-deposited Scryfall-compatible base URL (CardApiService; designdocs/legal.md); the app ships no endpoint. `normalizeApiUrl` card-api.service.ts:8.
- Bulk: CardDatabaseService (carddb/card-database.service.ts) `GET {base}/bulk-data` -> `default_cards` download_uri / jsonl_download_uri, streamed (gunzip via DecompressionStream, JsonChunkParser, ~450MB) -> compact `Record<name, CardRecord{name,src,back?,related?}>` cached in IndexedDB (card-db-cache.ts), key `index:v4:<base>`; `lookup(name)` ~:176. Indexing keeps the FIRST printing per name (source of the bad art: foreign text, full art). Image = `image_uris.normal` (`facesOf()`); DFC = per-face images. Set / collector_number / lang / id are in the bulk data but NOT stored in the index: for print choice extend the record and bump the index version (`index:v5`, add old key to staleIndexKeys), or fetch per card.
- Search: card-search.service.ts `GET {base}/cards/search?q=...&include_extras=true` (`CardHit`), cached per API+query. Not used yet but available on Scryfall: `/cards/search?q=!"name"&unique=prints`, `/cards/<set>/<cn>`, `/cards/named?exact=`.
- Textures: AssetLoaderService.loadTexture(src) (img first, CORS fetch/ImageBitmap fallback, cached); every card `<img>` needs `crossorigin="anonymous"`.
- Art is resolved to a URL at deck-confirm time and then frozen in ZoneCard.src / CardState.src, so an override only has to change what `confirmDeck` and the deck view / deck square images resolve.

## Chat / history panel
- chat/chat.ts: `tab` signal 'chat'|'history', `visible` computed filters room.messages() by kind, auto-scroll effect, `leave()`, `send()`. chat.html: `.panel` > `.head` (room name, code badge, peers, Leave) / `.tabs` / `#log` / `.compose`. chat.scss positions it as an absolute overlay. Hosted by tavern/tavern.html next to the scene. No fold state exists.

## Feature -> files to touch
1. New round in same room: room/room.service.ts (bulk `removeWorldObjectsByPrefix`/reset + round marker world object `round:` or action line), zones/zone-store.ts (`newRound()`: clear card:/item:/zone:/life: and reset counters; every client must react to the marker by resetting its own zones/life), scene/card/card-store.ts + scene/item/item-store.ts (remove all), zones/zones.ts/.html/.scss (New round button + confirm Dialog, back to deck picker via the `hasMine` gate), room/testing/fake-room.service.ts, zone-store.spec.ts. No SQL needed (reuses world_objects).
2. Infect/poison counter: zones/zone.types.ts (`POISON_PREFIX`/`poisonId`, or add `poison` to the `life:<uid>` data), zones/zone-store.ts (parse like life ~:81, `setPoison`, `PlayerZones.poison`), zones/zones.ts/.html/.scss (own counter next to life :89-101, opponents beside `opp-life` :7), zone-store.spec.ts, hotkeys/Instructions.md if listed.
3. Quiet return to hand: zones/zone-store.ts:204-209 `takeFromTable`, zones/zones.ts:131 drop target, scene/card/card-interactions.ts:630-640 (+ `CardDropTarget` type ~:60); specs zone-store.spec.ts / card-interactions.spec.ts.
4. Artwork override + import set/collector parsing: decks/deck.types.ts (`DeckEntry` + optional `set`, `collector`, `art` src/print id), decks/decklist-parser.ts (capture `(SET) 123`; merge key name+set+collector so different lands stay separate) + decklist-parser.spec.ts, decks/deck-store.ts (persist new fields; jsonb needs no migration; add `update`), carddb/card-database.service.ts + card-db-cache.ts (index set/collector/id/lang, `lookupPrint(name,set,cn)`; prefer English non-full-art default; bump cache version), zones/zones.ts `confirmDeck` (use entry print per copy), carddb/card-search.service.ts or card-api.service.ts (fetch prints list for the picker), decks.ts/.html (deck view images from override), built-in-decks.ts (same parser).
5. Artwork picker GUI: decks/decks.ts/.html/.scss (deck view: click a card -> modal with print grid using shared/dialog), data from item 4; optionally the in-game deck pick preview in zones.html.
6. In-app deck editor: new component e.g. decks/deck-editor/ (+ route in app.routes.ts or inside decks.ts deck view), decks/deck-store.ts (`update/save`, add/remove/count; cloud `update` on `decks` table: CHECK schema.sql ~:97-110 for an update policy, add a migration if missing), decks/deck.types.ts, card-search.service.ts for adding cards; sort/filter needs card metadata (type_line, cmc, colors, rarity are NOT in the compact index -> extend CardRecord + cache version, otherwise name/count only), decks.html/.scss.
7. Draw animation: zones/zones.ts (`draw()` ~:330; track last-drawn ZoneCard id, note ZoneStore.draw appends to END of hand), zones.html hand loop ~:60-90 (class binding), zones.scss (keyframes fly from deck + highlight); own hand only, opponents optional (`opp-hand`).
8. Collapsible history/chat: chat/chat.ts (`collapsed` signal, persist in localStorage, unread badge), chat.html, chat.scss; tavern/tavern.html/.scss if layout depends on width.
9. UI weak spots (candidates): menu/menu.html/.scss (auth + Play dialogs), decks.html/.scss (import-only, no sort), zones.html/.scss (deck picker, wheel-only hand scroll, pile sizing), chat.scss (fixed overlay), styles.scss (`--u` unit), card-overlay menus, util-window; Instructions.md is the one modified tracked file in git.

## Tests
Specs sit beside sources (*.spec.ts); stores use FakeRoomService; mock at the service seam, not supabase-js internals. Existing specs: decklist-parser, reveal, zone-store, card-store, item-store, card-interactions, hotkeys, room.service, card-database.service, card-api.service, json-chunk-parser, built-in-decks, deck-store, tavern-guard, app.

## Rules for work here
Commit locally only (own .git here), NEVER push; never touch X:\CodeProjects. Follow the project CLAUDE.md conventions (zoneless signals, bracket index access, `crossorigin="anonymous"` on card imgs) and update it when architecture changes.

## Done: new round (t3, commit 3a29d55)
- `round:current` world object `{n, startedBy}` (ROUND_ID in zone.types.ts). `ZoneStore.startNewRound()` clears `card:`/`item:` via `RoomService.removeWorldObjects(ids)` (new bulk delete, also in FakeRoomService) and bumps n; an effect in ZoneStore constructor makes EVERY client call private `resetForRound()` when n rises (not on room entry). Reset = deck rebuilt from localStorage `virtual-tavern.round-deck:<room>:<uid>` (name+src only, saved in `loadDeck`), life back to `life:<uid>.start`; no remembered deck -> zones removed -> deck picker.
- `life:<uid>` data is now `{life, start}`: t4 must keep `start` when adding poison (setLife preserves it). New resets must also zero poison in `resetForRound`.
- Permission: any player may start (confirm dialog, `confirmingRound` in zones.ts). No turn counter exists, so nothing to reset there.
- Component style budget raised to 12kB warn / 14kB error (zones.scss was at the 9kB warning).

## Done: infect counter + quiet return (t4)
- Poison lives in `life:<uid>` as `{life, start, poison}` (no new prefix); `PlayerZones.poison` (0 default), `ZoneStore.setPoison(n)` (needs a life total first, clamps >= 0, silent), `setLife` preserves it, `resetForRound` zeroes it. `POISON_LETHAL = 10` in zone.types.ts. UI: `.counters` row next to life in zones.html (own, lethal class at 10) and `.opp-poison` badge for opponents (shown when > 0).
- Quiet return: `takeFromTable(card,'hand')` for a local-only card (not in worldState) adds it to the hand with no history line; every other zone/table->hand still logs.

## Done: artwork data + import prints (t5)
- `DeckEntry.print?: DeckPrint {set, collector?, id?, src?, back?}` (deck.types.ts); `entrySrc(entry, fallback)` = print src else db default; `printKey()`. Parser keeps `(SET) 123` as `print` (set lowercase, unresolved = no `src`); lines merge by name + print, so lands of different sets stay separate. `*F*` markers are ignored.
- `CardPrintService` (carddb/card-print.service.ts): `resolveEntries(entries)` (batched `POST /cards/collection` 75 ids, single `GET /cards/:set/:cn` or `/cards/named?exact&set` fallback, name fallback drops the print), `listPrints(name)` (English prints, newest first, flags fullArt/textless/borderless/promo, for the t6 picker), `defaultPrint(name)`; 100 ms request spacing, `Accept` header, in-memory cache. `toDeckPrint(CardPrint)` gives the storable form.
- `DeckStore.import` resolves prints before storing; `resolvedList(deck)` (used by Zones.confirmDeck) resolves leftovers (built-in decks, imports without API) and saves them back for own decks; `setPrint(deckId, index, print|undefined, count?)` sets/clears the art of a line (splits copies, merges equal lines, persists local or cloud). t6 calls `setPrint`.
- Card db index is `index:v5` (stores `set`/`collector` of the shown print); default print per name = highest `printScore` (English, not full-art/textless/borderless), earliest on ties.
- Not done: ZoneCard has no `back`, so a chosen DFC print still flips to the default back face (`tableCard` uses `db.lookup().back`).

## Done: artwork picker (t6)
- `ArtworkPicker` (decks/artwork-picker/): dialog with a print grid (set code, #, language, set name, full-art/textless/borderless/promo tag) from `CardPrintService.listPrints(name, signal, allLanguages)`; filters English only (reloads with `lang:any` when off) and hide full-art/textless; "Apply to N of M copies" splits a line; "Use default art" clears. Saves via `DeckStore.setPrint`. `CardPrint.lang` added.
- Decks deck view: "Change artwork" button per card tile (own decks with a card API only; built-in decks show a note). `viewDeck` computed follows the store so a change shows at once; in game `confirmDeck` already reads `entrySrc`, so each line's art reaches the hand and table.
