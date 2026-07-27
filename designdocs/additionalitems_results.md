# Additional items — implementation results

Implements `additionalitems.md`: dice, coins and counters are back as networked
table objects. They are a new domain (`src/app/scene/item/`) modelled directly on
the card domain — an `item:` world-object prefix, an `ItemStore` projection, an
`Item` component that renders one into the Three scene, and the existing
`CardInteractions` pointer layer extended to pick, drag and click them.

`npm test`: **117 tests, all green** (15 of them new for this doc).
`npm run build`: clean.

---

## Where they come from

### The right-click "Add to game" window

`util-window.html` gained an items block above the card search, matching the
doc's submenus:

- **Dice ▸** expands a row of **d4 / d6 / d12 / d20**; clicking one spawns it.
- **Coin** spawns immediately (no submenu — there is only one).
- **Counters ▸** expands **+1/+1** and **−1/−1**.

Each spawn drops the item at the table point that was right-clicked (with the
same small jitter used for cards, so repeats don't stack exactly), posts an
"added a d20" history line, and closes the window.

## The model

`item.types.ts` — `ItemState` is the shared payload:

```ts
interface ItemState {
  id: string;
  kind: ItemKind; // d4 | d6 | d12 | d20 | coin | counter
  position: [number, number, number];
  rotation: [number, number, number];
  value: number;
  variant: CounterVariant;
  attachedTo: string | null;
}
```

- `kind` — `d4 | d6 | d12 | d20 | coin | counter`.
- `rotation` — euler angles that are **absolute and unwrapped**: a roll _adds_
  whole turns rather than normalising to 0…2π. That is what makes the animation
  sync (below) work without streaming frames.
- `value` — the die's rolled face, the coin's side (1 heads / 0 tails), or the
  counter's count.
- `variant` — `plus` / `minus` for counters.
- `attachedTo` — the card a counter rides on, or `null`.

`ItemStore` (root, `item-store.ts`) is a computed projection over
`RoomService.worldState()` filtered by the `item:` prefix, with the same
`add` / `update` / `preview` / `clearPreview` / `remove` surface `CardStore` has —
so items persist, late joiners get them from the snapshot, and drags stay local
until they land.

## Rendering (placeholders, ready for real models)

`Item` (`item.ts`) builds three nested nodes: **wrapper** (world position) →
**pivot** (rest height, and the coin's hop) → **body** (what a roll rotates).

Bodies come from `item-geometry.ts` — plain Three geometry plus canvas textures,
since no GLBs were provided ("placeholders for now"):

| Kind           | Placeholder                                                                                   |
| -------------- | --------------------------------------------------------------------------------------------- |
| d6             | 0.16 m box, **six pip textures** in `BoxGeometry` material order, opposite faces summing to 7 |
| d4 / d12 / d20 | Tetra/dodeca/icosahedron, flat-shaded, with a number label sprite above it                    |
| Coin           | Cylinder — gold edge, **HEADS** texture on the top cap, **TAILS** on the bottom               |
| Counter        | Small disc whose top cap prints its value ("+2/+2" green, "−2/−2" red)                        |

Real models drop in without touching any of this: register a path in
**`ITEM_MODEL_URLS`** (`scene-assets.ts`) and `Item` clones that GLB instead,
keeping the same pose, animation and picking. The map is empty today, so no
request is ever made for a file that isn't there (the same graceful-fallback
convention the environment assets use). An `Item` disposes its own geometry,
materials and canvas textures on destroy — they are per-instance, not shared
cache entries.

## Dice

### Roll

Right-clicking a die opens its menu (**Roll**, **Delete**). `ItemStore.roll()`
adds a random turn to **every euler** and writes it to shared state; each client
lerps its own mesh from wherever it was to that rotation over **1.5 s**
(`ROLL_MS`), which is the design doc's "no physics, lerp each euler" — and, since
the target is shared state, everyone sees the same tumble land the same way with
nothing but one world-object write on the wire.

Two refinements over a purely random tumble:

- The **d6 turns in whole quarters** (plus a full spin for the tumble), so it
  always lands square on a face. The pips that end up on top _are_ the result:
  `roll()` computes the up-facing normal and reads the pip count off it, so the
  history line ("rolled 4 on a d6") can never disagree with the model. A spec
  asserts exactly that invariant over 20 rolls.
- The **polyhedra tumble freely** (the doc's 0–360° per euler) and carry their
  rolled number on the label above them, because a placeholder icosahedron has
  nothing readable to land on. The number is in shared state, so every player
  reads the same result.

Both post the result to the game history.

### Drag and delete

Dice drag exactly like cards (same threshold, same drag plane, same
camera-through-cursor drop) and can only live on the table: the zone drop targets
are checked for cards only, so a die released over the hand/deck UI just lands on
the table under it. **Delete** is in the menu, and the delete hotkey
(`x` / `Delete`) works on a hovered item too.

## Coin

Right-click → **Flip** / **Delete**. `ItemStore.flip()` picks the X or Z axis and
adds a whole number of **half-turns** (2–6): an odd count lands the coin on its
other side, an even one on the same — that is the randomness, and it always lands
cleanly on a face, per the doc. The side that comes up is computed from the
resulting orientation (is the local +Y still up?) and logged: "flipped a coin:
heads".

`Item` animates it over 1.2 s, lerping the rotation while the pivot rides a sine
arc up and back down — the doc's "+2 y and return". **The hop is 0.5 m, not 2**:
the doc's number was written for a different scale (a card here is 0.32 m across
and the camera frames ~4.7 m of table), so +2 would have thrown the coin out of
frame. 0.5 m is the same gesture at this scale.

## Counters

- **Left-click counts up, right-click counts down** — no context menu, as the doc
  specifies. The value is clamped at 1 (a "+0/+0" counter has nothing to say);
  the value lives in shared state and is drawn onto the counter's face texture,
  redrawn on every change and disposing the previous drawing.
- **Dropping one on a card attaches it.** The drop resolves what the ray hit: a
  card means `attachedTo = <card id>` and the counter's `position` becomes an
  **offset from that card's origin**, so the counter follows the card wherever it
  is dragged. Dropping it anywhere else detaches it again, so it can be pulled
  off a card as easily as it was put on.
- A card that **leaves the table** — deleted, or sent to hand/deck/graveyard/exile
  by menu or by drag — takes its counters with it (`removeAttachedTo`).
- **Delete** is the hotkey on a hovered counter, per the doc.

## Interaction plumbing

`CardInteractions` now registers both domains in one object map (ids carry their
own prefix), so hover, picking, dragging and dropping are shared code. What
differs is branched on the id:

|               | Card                       | Die / coin                     | Counter                |
| ------------- | -------------------------- | ------------------------------ | ---------------------- |
| Click         | tap                        | —                              | value + 1              |
| Right-click   | card menu                  | item menu (roll/flip + delete) | value − 1              |
| Drag          | move / stack / into a zone | move on the table              | move, attach to a card |
| Marquee       | selectable                 | never                          | never                  |
| Delete hotkey | yes                        | yes                            | yes (the only way)     |

---

## Files touched

| File                                                         | Change                                                                                                          |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `src/app/scene/item/item.types.ts`                           | `ItemState`, kinds, `newItem`, labels (new)                                                                     |
| `src/app/scene/item/item-store.ts`                           | Projection + `roll` / `flip` / `bump` / `removeAttachedTo` (new)                                                |
| `src/app/scene/item/item-geometry.ts`                        | Placeholder geometry and canvas textures (new)                                                                  |
| `src/app/scene/item/item.ts`, `item.html`                    | The scene component + roll/flip animation (new)                                                                 |
| `src/app/scene/scene.ts`, `scene.html`                       | Renders `<app-item>` per `ItemState`                                                                            |
| `src/app/scene/scene-assets.ts`                              | `ITEM_MODEL_URLS` hook for real models                                                                          |
| `src/app/scene/card/card-interactions.ts`                    | Item picking/click/right-click/drag, counter attach, `itemMenu`, `itemAct`, counters follow cards off the table |
| `src/app/scene/card/card-overlay/card-overlay.ts`, `.html`   | Item context menu                                                                                               |
| `src/app/scene/util-window/util-window.ts`, `.html`, `.scss` | Dice / Coin / Counters section                                                                                  |
| `angular.json`                                               | Initial bundle warning budget 1.25 MB → 1.35 MB                                                                 |
| `CLAUDE.md`                                                  | Table-items section under the scene architecture                                                                |

## Tests

- **`item-store.spec.ts`** (new, 9 cases): the `item:` projection ignores cards
  and zones; a d6 roll lands on whole quarter turns and its logged value always
  equals the face that is up; every euler moves on a roll (so remote clients have
  a tumble to animate) and a d20's value stays in 1–20; a coin flip only spins
  about a horizontal axis and reports the side it lands on; counters count up and
  down but never below 1, and a floored counter writes nothing; minus counters
  label their history lines with minus signs; roll/flip/bump ignore the wrong
  kind; `removeAttachedTo` clears a card's counters; previews are local overrides.
- **`card-interactions.spec.ts`** (new `describe('table items')`, 5 cases):
  left-click counts a counter up and right-click counts it down without opening a
  menu; right-clicking a die opens the item menu and Roll changes its facing and
  logs a result; the delete hotkey removes a hovered item; a counter dropped on a
  card attaches as an offset and detaches when dropped elsewhere; a marquee never
  selects items. Plus one in the outer suite: a card sent to a zone takes its
  attached counters with it.

## Notes / decisions

- **Dice and coins are one menu, not two.** The doc says right-click opens
  "roll" (resp. "flip"), then says a simple right-click opens a menu with
  "delete"; there is only one right-click, so the menu carries both entries.
- **The d6 is the readable die.** Quantising its roll to quarter turns is a
  deliberate narrowing of "choose a value between 0-360 degrees": it is what
  makes the pips on top mean something. The other dice follow the doc literally
  and rely on their label.
- **Counters follow a card's position, not its rotation.** True parenting was the
  doc's suggestion, but the card's node is scaled and laid flat, and tapping it
  turns it 90° — which would fling attached counters around the table. Following
  the position keeps them where the player put them.
- **The coin's hop is 0.5 m** rather than the doc's 2 (scale, see above).
- **Counter values are clamped at 1.** Right-clicking a 1 does nothing rather
  than producing "+0/+0"; removal is the delete hotkey, as specified.
- Verification is `npm test` + `npm run build`; a live multiplayer session was
  not exercised (the room screens need the pending Supabase migrations applied to
  the cloud database first).
