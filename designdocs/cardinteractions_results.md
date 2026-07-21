# Card Interactions — Implementation Results

Status of the features from `cardinteractions.md` (implemented 2026-07-18).

## What was built

### State layer

- `src/app/scene/card/card.types.ts` — `CardState` (id, src, position, yaw, faceUp,
  relatedIds) and the `CardAction` union (`view | rotate | flip | related | delete`).
- `src/app/scene/card/card-store.ts` — `CardStore`, the signal-based source of truth for
  cards on the table. Seeds three cards (shared placeholder artwork, related to each other)
  until deck import exists. `update()` patches a card immutably; `remove()` also strips the
  id from every other card's `relatedIds`.
- The `Card` component was rewritten to render a `CardState` input: position, yaw (rotation
  about world-up), and faceUp (flip) are applied via effects, and the Scene renders
  `@for (card of cards(); track card.id)`.

### Hover highlight ✅

- `CardInteractions` (`src/app/scene/card/card-interactions.ts`) raycasts the cursor against
  every registered card on pointermove and publishes `hoveredId`.
- `Card` now clones **all** of its materials per instance (previously only the front face)
  and sets a slight white emissive tint (`0x333333`) on all of them while hovered — the
  phase-1 "tint the entire mesh" approach; no custom shader needed.

### Left click: move + place ✅

- Click a card → it is picked up (highlights cleared), floats at an elevated Y (`DRAG_Y =
  0.8`) and follows the cursor in XZ via a cursor-ray/horizontal-plane intersection. No
  rotation changes while moving.
- Click again → a ray is cast **straight down** from the card; it lands on whatever is below
  (environment GLBs, the placeholder floor, or another card) at `hit.y + PLACE_OFFSET`.
  Nothing below = invalid position, the card stays picked up.
- **Cards stack** naturally: the down-ray hits the top card of a pile, so drops land on top.

### Right click: context menu ✅

- `CardOverlay` (`src/app/scene/card/card-overlay/`) is plain Angular/HTML (per the doc, not
  Three): an absolutely positioned popup over the canvas, `pointer-events: none` on the host
  so the canvas still receives input.
- Options: **View** (large card image in the shared `Dialog` modal), **Rotate** (yaw += π,
  same facing), **Flip** (turn over, face up/down), **Related…** (second context window
  listing related-card thumbnails; clicking one opens its large view), **Delete** (removes
  the card from the store entirely), **tba** (disabled placeholder).
- Menu opens next to the cursor; left-clicking the canvas or pressing Escape closes it.

### Hotkeys ✅

- While a card is hovered: `v` view, `r` rotate, `f` flip, `g` related, `x`/`Delete` delete.
- Defined in one `HOTKEYS` record in `card-interactions.ts` — the single place to make
  user-configurable later.
- Keystrokes are ignored while typing in inputs/textareas (e.g. chat).

## Architecture notes

- `CardInteractions` is the design doc's "CardContext": provided by the Scene component,
  attached to the canvas, owns hover/drag/menu/view/related state as signals. `CardStore`
  holds the doc's "CardState".
- Cards register their Three `Group` with `CardInteractions` on spawn and unregister on
  destroy (which also clears any hover/drag/menu state pointing at them).
- The Scene registers placement surfaces: the placeholder floor until the environment GLBs
  load, then each environment group.

## Tests

31 passing (12 added): `card-store.spec.ts` (seed/update/remove), `card-interactions.spec.ts`
(actions, hotkeys, input-guard, Escape, unregister cleanup), `card.spec.ts` rewritten for the
state input + hover tint + pose tests.

## Open items / follow-ups

- **Multiplayer sync**: interactions are local-only, as the doc doesn't cover networking.
  When needed, mirror `CardStore` mutations through `RoomService.setWorldObject()` (stable
  card id, last-writer-wins) — the store is the single choke point for that.
- **`PLACE_OFFSET` / `DRAG_Y` tuning**: placement lifts the card 0.01 above the hit surface;
  once the real table GLB + card model origins are final, these constants (top of
  `card-interactions.ts`) may need adjusting.
- **Hotkey configurability**: `HOTKEYS` is a constant; a settings-backed remap UI is a later
  feature (the Settings screen is still a sample).
- **Related cards data**: `relatedIds` currently comes from the seed; real data arrives with
  deck import (`/decks` is a placeholder).
- **tba menu option**: rendered disabled, as specified.
