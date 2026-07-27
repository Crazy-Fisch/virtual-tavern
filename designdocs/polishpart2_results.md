# Polish part 2 — implementation results

Implements `polishpart2.md`. Every item in the design doc is done. Nothing in the
networking model changed: cards, zones and the new items are still whole-object
last-writer-wins writes through `RoomService.setWorldObject`.

`npm test`: **14 files, 117 tests, all green** (was 93 — the extra 24 cover this
doc plus `cardselection.md` and `additionalitems.md`). `npm run build`: clean
production build.

---

## Initial (the deck gate)

### 1. Choose Deck sits in the middle of the screen

`zones.html` / `zones.scss` — the pre-game gate moved from a bottom-right button
to a centred `.gate` column (`position: absolute; inset: 0` + flex centring). The
container keeps `pointer-events: none` so the table stays visible and clickable
around it; only the buttons are hit-testable.

### 2. Pick, then confirm — or pick another

Picking a deck in the dialog no longer starts the game. `Zones.pickDeck(deck)`
stages it in a new **`pendingDeck`** signal and closes the picker; the centre of
the screen then shows the deck's name and card count, a **Confirm deck** button,
and **Choose another deck** below it (reopening the picker). `confirmDeck()` is
what resolves the decklist, calls `ZoneStore.loadDeck()` and creates the zones.

### 3. Images are only cached once a deck is confirmed

The image warm-up loop (`AssetLoaderService.loadTexture` per distinct card art)
moved out of the picker and into `confirmDeck()`. Browsing decks — or opening the
picker and backing out — now costs nothing; the download starts on confirmation,
exactly as the doc asks.

## UI sizes

### 4. One responsive unit, authored at 16:9, sane on UWQHD

`styles.scss` gained a global unit:

```scss
:root {
  --u: min(1vw, 1.7778vh); // 1% of the largest 16:9 box that fits
  --ui-gap: calc(1.6 * var(--u)); // breathing room from the screen edge
}
```

On 16:9 `--u` is 1% of the width (19.2 px at 1080p). On anything wider the height
caps it (25.6 px at UWQHD 3440×1440), so the UI grows with the window but never
stretches with the extra width — an ultrawide sees _more table_, not a bigger HUD.

The 3D view follows the same rule: `SceneCamera.setAspect()` holds the vertical
world extent fixed and only widens the frustum, so cards are the same size at
16:9 and 21:9.

### 5. Bigger zone widgets, off the screen edge

`zones.scss` is now expressed entirely in `--u`:

| Widget                    | Before     | Now (1080p)                                 |
| ------------------------- | ---------- | ------------------------------------------- |
| Hand card                 | 96 px      | `6.4u` ≈ 123 px                             |
| Deck / grave / exile pile | 64 × 88 px | `4.6u × 6.4u` ≈ 88 × 123 px                 |
| Drag ghost                | 130 px     | `5.6u` ≈ 108 px (matches the on-table card) |
| Edge inset                | 1 rem      | `--ui-gap` ≈ 31 px                          |

The hand also moved from `bottom: -30px` (cards clipped by the screen edge) to a
positive inset, so no hand card is cut off any more. Dialog content
(deck picker, examine grid) is pinned back to 14 px — those are reading surfaces,
not HUD.

## Exile zone

### 6. Exile is a real zone, next to the graveyard

`ZoneKind` gained `'exile'` (`zone.types.ts`), plus an `OPEN_ZONES` /
`OpenZoneKind` pair naming the two zones anyone may look through (graveyard,
exile). That one change propagates everywhere the kinds are enumerated:

- **`zone-store.ts`** — `loadDeck` creates it empty; the per-zone history lines
  moved into a `TAKE_ACTIONS` record so exile reads "exiled Water Worm";
  `takeToHand` already accepted any non-hand zone.
- **`zones.html`/`.scss`** — an Exile pile beside the graveyard (colder blue so
  the two never get confused), click to examine, right-click → Examine. Other
  players' summaries show `✦ n` with an examinable exile.
- **The examine dialog** is now generic: `examining` holds `{ uid, kind }`
  instead of just a uid, so the same grid serves both zones (and "To hand" still
  only shows for my own).
- **`card.types.ts` / `card-interactions.ts` / `card-overlay.html`** — a
  `toExile` card action, in the context menu and on the **`e`** hotkey.
- **`zones.ts`** — the drop targets are now generated from `ZONE_KINDS` with a
  `ZONE_SELECTORS` map, so dragging a card onto the exile pile exiles it. Adding
  a further zone later is one entry in each.

## Image problems

### 7. Cards that had art everywhere except on the table

Root cause: the same Scryfall image is used twice — as a DOM `<img>` (hand,
piles, search results, deck view) and as a WebGL texture. The `<img>`s carried no
`crossorigin` attribute, so the browser could cache an **opaque** response for
them; `TextureLoader` then asked for the same URL as a CORS request, got handed
that cached opaque response, and the upload failed. Hence: images in hand, in the
card view and in every zone, but blank card fronts on the table.

Two-part fix:

- **Every card `<img>` now sets `crossorigin="anonymous"`** (`zones.html`,
  `card-overlay.html`, `util-window.html`, `decks.html`) so both paths share one
  CORS-clean cache entry. `CLAUDE.md` records the rule for future markup.
- **`AssetLoaderService.loadTexture` gained a fallback**: it still tries the
  cheap `<img>` path (now with an explicit `setCrossOrigin('anonymous')`), and on
  failure re-fetches the bytes itself with
  `fetch(url, { mode: 'cors', cache: 'reload' })` → `blob` → `createImageBitmap`
  → `Texture`. `cache: 'reload'` steps around a cache entry that was already
  poisoned — including on browsers that cached the art before this fix shipped.

Texture configuration (sRGB, `flipY = false`) moved into one
`configureCardTexture` helper shared by both paths.

## Camera

### 8. Orthographic ("isometric") top-down view

`SceneCamera` is now an **`OrthographicCamera`** instead of a 60° perspective
camera. With no perspective divide, a card at the far end of the table is drawn
at exactly the same size and shape as one right in front of you — which is the
"better card view" the doc is after; it also removes the keystoning that made
cards near the screen edges look skewed.

- **`scene-camera.ts`** — `VIEW_HEIGHT = 4.2` m of world height is mapped to the
  viewport height; `setAspect(aspect)` widens the frustum horizontally only.
- **`scene.ts`** — `resize()` calls `setAspect()` instead of poking
  `camera.aspect`.
- **`camera-rig.ts`** — the base pose is a bird's-eye ~26° off vertical, aimed
  slightly toward the player's own end (`CAMERA_TARGET.z = 0.3`) so their half of
  the table is fully framed and the crop falls on the far end. The camera's
  distance now only decides clipping, which is documented in place. The
  mouse-edge pan and the per-seat mirroring are unchanged.
- **`card.ts`** — `CARD_SCALE` 0.4 → **0.5** (0.32 × 0.44 m). Together with the
  frustum that puts a card at ≈ 82 × 114 CSS px on a 1080p screen (it was ≈ 53 ×
  77 px), and ≈ 110 × 152 px on UWQHD.

`card-interactions.spec.ts` sets the test camera up through `setAspect()` now;
every existing picking/drag test passes unchanged, since `Raycaster` and
`Vector3.project` handle both camera types.

---

## Files touched

| File                                                                              | Change                                                                                                        |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `src/styles.scss`                                                                 | Global `--u` / `--ui-gap` UI units                                                                            |
| `src/app/scene/scene-camera.ts`                                                   | Orthographic camera + `setAspect`                                                                             |
| `src/app/scene/scene.ts`                                                          | Resize through `setAspect`; renders items                                                                     |
| `src/app/scene/camera-rig/camera-rig.ts`                                          | Bird's-eye pose for the ortho camera                                                                          |
| `src/app/scene/card/card.ts`                                                      | `CARD_SCALE` 0.5                                                                                              |
| `src/app/scene/asset-loader.service.ts`                                           | CORS texture fallback via fetch + `ImageBitmap`                                                               |
| `src/app/zones/zone.types.ts`                                                     | `exile` kind, `OPEN_ZONES`/`OpenZoneKind`                                                                     |
| `src/app/zones/zone-store.ts`                                                     | Exile zone, `TAKE_ACTIONS` history lines                                                                      |
| `src/app/zones/zones.ts`, `.html`, `.scss`                                        | Centred gate + confirm step, exile pile, generic examine dialog, `--u` sizing, drop targets from `ZONE_KINDS` |
| `src/app/scene/card/card.types.ts`                                                | `toExile` (and `tap`) actions                                                                                 |
| `src/app/scene/card/card-interactions.ts`                                         | `toExile`, `e` hotkey                                                                                         |
| `src/app/scene/card/card-overlay/card-overlay.html`                               | "To exile" menu entry                                                                                         |
| `src/app/decks/decks.html`, `util-window.html`, `card-overlay.html`, `zones.html` | `crossorigin="anonymous"` on card art                                                                         |
| `angular.json`                                                                    | Initial bundle warning budget 1.25 MB → 1.35 MB (three's extra geometries)                                    |
| `CLAUDE.md`                                                                       | Architecture notes for the camera, zones, UI unit and CORS rule                                               |

## Tests

- `zone-store.spec.ts` — `loadDeck` now asserts the four zones it creates.
- `card-interactions.spec.ts` — `toExile` moves a card into the exile zone and
  logs "exiled …"; the camera is posed through `setAspect`.
- Everything else in the suite passes untouched.

## Notes / decisions

- **Framing trade-off.** The table is 4 × 6 m and each player sits at a 6 m end.
  Framing all 6 m of depth would leave the 4 m width floating in empty floor, so
  the ortho frustum shows ≈ 4.7 m of depth centred slightly toward the player.
  The far ~0.7 m of the opponent's edge is off-screen, the same compromise the
  previous camera made ("the far table end crops slightly"), now with cards ~55 %
  larger.
- The **card-image CORS fix could not be reproduced offline** — it depends on the
  browser's HTTP cache state against `cards.scryfall.io`. The fix addresses the
  documented cause (mixed CORS/no-CORS requests for one URL) from both sides and
  degrades safely: if the `<img>` path works, the fallback never runs.
- The initial-bundle **warning** budget was raised to 1.35 MB because the item
  placeholders pull in three's polyhedron/cylinder geometries. The **error**
  budget (2 MB) is untouched and not near.
- Verification here is `npm test` + `npm run build`. A live session was not
  exercised: the room screens need the pending Supabase migrations
  (`migration-2026-07-18-card-game.sql`, `migration-2026-07-19-polish.sql`) to be
  applied to the cloud database first.
