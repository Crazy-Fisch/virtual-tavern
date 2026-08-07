# New mechanics — implementation results

Implements `newmechanics.md`: the **x counter**, the deck's **reveal / scry** window,
and **coloured dice with a scrambling roll display**.

`npm test`: **178 tests, all green** (15 of them new for this doc).
`npm run build`: clean.

---

## 1. The x counter

A third `CounterVariant` alongside `plus` and `minus`, behaving exactly like the
±1/±1 counters — same left-click up / right-click down, same floor of 1, same
delete hotkey, same attach-to-a-card-and-ride-along — but printing a plain
multiplier.

|            | +1/+1   | −1/−1   | **x**            |
| ---------- | ------- | ------- | ---------------- |
| Face reads | `+2/+2` | `−2/−2` | **`2x`**         |
| Body       | disc    | disc    | **squared tile** |
| Colour     | green   | red     | slate            |
| Minimum    | 1       | 1       | **1x**           |

- **`counterLabel(value, variant)`** is the one place the text is decided, so the
  face texture, the history line ("set a counter to 2x") and the util-window
  button all agree by construction.
- **The squared model** is the doc's "if possible make it a squared looking 3d
  model": `makeCounterGeometry(variant)` returns a `BoxGeometry` of the same
  thickness as the disc instead of a cylinder. That moves the printed face onto a
  different material slot (`+Y` is index 2 on a box, the cylinder's top cap is
  index 1), which is what the new **`counterFaceSlot()`** exists for — it is used
  both when building the mesh and when repainting the value.
- The util window's **Counters** row is now generated from `COUNTER_VARIANTS`, so
  it grew a third button without a third hard-coded entry.

Sticking to cards needed no work at all: `CardInteractions.placeItem` branches on
`kind === 'counter'`, not on the variant, so an x counter attaches, follows its
card, and leaves the table with it like the others.

## 2. Reveal / scry

Right-clicking my deck now offers **Shuffle** and **Reveal…**, which expands to
`1 2 3 4 5` plus an **X** box (a `number` input, positive integers, Enter or the
button starts it). Asking for more cards than the deck holds reveals what there
is; an empty deck opens nothing.

### The window

A modal showing the revealed cards **top-left = first off the deck,
bottom-right = last**, with small `first` / `last` badges pinned to those two
corners. Underneath sit the four drop zones — **Hand**, **Deck (top)**,
**Bottom**, **Graveyard** — and a footer with **Undo**, a "N left" count, and
**Done**.

Dragging a card out of the grid is a self-contained pointer drag inside the
panel: past a 4 px threshold a ghost follows the cursor (drawn
`pointer-events: none` so it can never win the `elementFromPoint` hit test the
drop zones are found with), the zone under the cursor lights up, and releasing
over one routes the card there. A card that has been placed leaves an empty
dashed slot behind rather than collapsing the grid — that is what keeps the
`first` / `last` badges pointing at the corners they describe. Each drop zone
shows thumbnails of what has landed in it, in order, so the deck-top stack is
visible as it is built.

### Ordering

Per the doc, real-card stack semantics:

- **Deck (top)** — the last card put back is the **first** off the deck. Placing
  A then B then C leaves the deck `[C, B, A, …]`.
- **Bottom** — the last card sent under is the **bottom-most**. Placing A then B
  leaves `[…, A, B]`.
- **Hand** and **Graveyard** append in placement order.

### Why nothing can be lost

The design decision behind `src/app/zones/reveal.ts` is that **no card is ever in
limbo**. A reveal does not lift the top N out of the deck; it only _looks_. The
deck the session writes is always

```
deck = top ++ pending ++ rest ++ bottom
```

so a card the player has not decided about is still in the deck, in order, at
every instant. Closing the window, navigating away or losing the tab therefore
costs nothing — there is no "cards are held by the dialog" state to lose. A spec
asserts the full card multiset is unchanged after every step.

Each placement is committed immediately through the new
**`ZoneStore.applyReveal()`**, which writes deck + hand + graveyard in **one**
batch (the same atomicity `draw()` has, so a lost request cannot leave a card in
two zones or none).

### Undo

The session carries a history stack whose first entry is the untouched state, so
**Undo** pops one placement and re-writes the zones — repeatedly, all the way
back to the start of the reveal, exactly as the doc asks. It is disabled at the
bottom of the stack. Undo is itself a networked write ("took back their last
reveal move"), because the placements it reverses were.

### Privacy

The reveal is to the local player. The history says a look happened
("looked at the top 3 cards of their deck") and never what was seen; placements
into the closed zones stay nameless ("put a revealed card back on top of their
deck"). The **graveyard** is the exception — it is an open zone anyone can
examine, so that line names the card, matching what `takeFromTable` already does.

## 3. Dice

### Colours

`ItemState` gained a **`color`** (`green | blue | red | yellow`). The util
window's Dice row is now a swatch strip above the kind buttons: pick a colour,
then a die — the swatch sticks, so a whole matching set is a few clicks. The
colour is shared state, so every player sees the same dice.

`DIE_PALETTE` (in `item-geometry.ts`) pairs each colour with the ink that reads
on it, and one palette entry drives everything: the d6's pip faces, the
polyhedra's material, the floating number label's disc, **and** any registered
GLB. That last one matters because the d4 currently _is_ a GLB — without tinting
it, picking green and spawning a d4 would have given a grey d4. Only untextured
materials are tinted, so a model that ships its own artwork keeps it.

Dice written before this change (and any unrecognised value) fall back to the
default colour rather than reaching the renderer as something unpaintable.

### Animated numbers

> instead of showing the result during the animation, it shows different numbers
> in its appropriate range during the animation, only at the end it "decides"

The d4/d12/d20 label now cycles a fresh random number in the die's range every
70 ms while the die tumbles, and paints the real `state.value` on the frame the
animation lands. The d6 is untouched, as the doc says — its pips _are_ its
result.

The result itself is still decided the instant the die is rolled; it has to be,
because it is shared state and that is what keeps every client's tumble
identical. Only the _display_ is withheld. The scramble is local and random per
client — it is pure flavour, and every client still lands on the same number.

This needed one refactor: the label used to build a whole new `CanvasTexture` and
`SpriteMaterial` per value change, which at 14 changes a second would have
churned GPU resources. `makeValueCanvas()` now hands back one canvas that is
repainted in place, with a single `CanvasTexture` over it that simply re-uploads
(`needsUpdate`). The counter face still allocates per change, which is fine — it
changes on click, not per frame.

---

## Files touched

| File                                       | Change                                                                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `src/app/zones/reveal.ts`                  | Pure reveal-session model: `startReveal` / `place` / `undo` / `revealZones` / `revealAction` (new)                                   |
| `src/app/zones/reveal-panel/*`             | The scry window: grid, drag, drop zones, undo (new)                                                                                  |
| `src/app/zones/zone-store.ts`              | `revealTop()` (peek + log) and `applyReveal()` (one batched write + log)                                                             |
| `src/app/zones/zones.ts`, `.html`, `.scss` | Deck menu's Reveal row (1–5 and X), renders `RevealPanel`                                                                            |
| `src/app/scene/item/item.types.ts`         | `ItemColor` + palette constants, `x` counter variant, `newItem` options object, label/validation helpers                             |
| `src/app/scene/item/item-geometry.ts`      | `DIE_PALETTE`, coloured pip textures, boxed counter + `counterFaceSlot`, repaintable `makeValueCanvas` (replaces `makeValueTexture`) |
| `src/app/scene/item/item-store.ts`         | Parses/defaults `color` and validates `variant`                                                                                      |
| `src/app/scene/item/item.ts`               | Coloured bodies and GLB tinting, boxed counter face, scrambling roll label                                                           |
| `src/app/scene/util-window/*`              | Colour swatches in the Dice row; Counters row generated from `COUNTER_VARIANTS`                                                      |
| `CLAUDE.md`                                | Table-items and player-zones sections                                                                                                |

## Tests

- **`reveal.spec.ts`** (new, 9 cases): the reveal touches nothing on open; it
  clamps to the deck (and to nothing on an empty one); cards put back on top come
  off in reverse order and cards sent to the bottom in placement order; hand and
  graveyard append to what was there; **undecided cards stay in the deck and the
  full card multiset is invariant at every step**; a placed card leaves the grid
  and a stale second drop is a no-op; undo walks back one step at a time to the
  untouched start and then stops; only the graveyard's history line names a card.
- **`zone-store.spec.ts`** (+3): `revealTop` peeks without writing anything and
  logs only the look; it clamps to the deck and does nothing when empty;
  `applyReveal` writes deck + hand + graveyard in one batch.
- **`item-store.spec.ts`** (+3): an x counter counts in plain multiples and floors
  at 1x with the right history lines; a die's colour round-trips through the
  shared world while pre-palette and nonsense values fall back to the default;
  each counter flavour's face text and history label.

## Notes / decisions

- **Dice colours are chosen, not random.** The doc lists a palette without saying
  who picks; a swatch that sticks between spawns makes "give me four green dice"
  cheap and is the only reading that lets a player use colour to tell their dice
  from an opponent's.
- **The reveal commits as it goes rather than on Done.** The alternative —
  holding the cards in the dialog and writing once at the end — reads simpler but
  puts every revealed card in a place no other client (and no reload) knows
  about. Committing per placement is what makes the "no card in limbo" invariant
  possible, and it is what lets Undo be an ordinary write rather than a special
  case.
- **The panel is modal.** It borrows the shared `Dialog`, so the table and the
  zone widgets are unreachable while a reveal is open. That is deliberate: the
  session snapshots the rest of the deck at the start, and letting the player draw
  or shuffle underneath it would make that snapshot lie.
- **Undo does not un-log.** The history is an append-only record of what happened
  at the table, so taking a move back adds a line rather than deleting one.
- **The x counter's floor is 1x**, matching the ±1/±1 counters — the doc says
  "minimum is 1x" — and it is removed with the delete hotkey like the others.
- Verification is `npm test` + `npm run build`; a live multiplayer session was not
  exercised (the room screens still need the pending Supabase migrations applied
  to the cloud database).
