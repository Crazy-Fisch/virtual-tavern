# Card selection — implementation results

Implements `cardselection.md`. Every line of the design doc is done. Selection is
**local, not networked**: it is a way of pointing at cards, like hover, so two
players can each have their own selection without fighting over shared state.
Only the results of a group action (positions, tapped flags, deletions) travel,
through the same `setWorldObject` writes single cards already used.

`npm test`: **117 tests, all green** (8 of them new for this doc).
`npm run build`: clean.

---

## 1. Dragging over the table draws a selection rectangle

`CardInteractions.onPointerDown` used to ignore a press that picked no card. It
now remembers it (`marqueeStart`), and `onPointerMove` promotes it to a marquee
once the cursor travels past `MARQUEE_THRESHOLD_PX` (5 px, so a click is never
mistaken for a rectangle). The rectangle lives in the **`marquee`** signal in
scene-host CSS px and is drawn by `CardOverlay` (`.marquee` — a translucent
violet box, `pointer-events: none`, since the pointer flow that drives it lives
on the canvas underneath).

## 2. Release selects every card whose origin it covers

`selectWithin()` projects each `CardState.position` through the camera into
screen space and keeps the ones inside the released rectangle — the doc's
"origins are covered" rule, so a card is selected by where it _is_, not by how
much of its art happens to overlap. The result lands in the **`selectedIds`**
signal (a `ReadonlySet`).

Projection works unchanged under the new orthographic camera (see
`polishpart2_results.md`).

## 3. Selected cards show the hover state

`card.ts` now tints when the card is hovered **or** selected
(`interactions.isSelected(id)`), so a selection reads at a glance with no new
visual language.

## 4. The selection drags as one, keeping offsets and states

Pressing any selected card starts a **group drag**: `beginDrag` snapshots the
other selected cards' start positions (`dragGroup`) and the pressed card's
position (`dragOrigin`). Every `dragTo` computes the cursor's delta on the drag
plane and previews the whole group at that offset; `tryPlace` commits the same
delta to each card at the drop surface's height. Only `position` is written, so
tapped/flipped/face-down states ride along untouched.

One deliberate difference from a single-card drag: a group has **no DOM drag
ghost**. The ghost exists so a lone dragged card can't hide behind the hand UI;
for a group it would only show one card of many, so the cards stay in the 3D
scene where their relative layout is visible. `DragGhost` gained an `id` field
and `Card` now hides itself only when _it_ is the ghosted card, which made this
a two-line change.

## 5. Cards in a selection still tap individually

A press released without travelling is still a tap, and it still applies to the
one card under the cursor — the selection is not cleared and the other cards are
untouched.

## 6. Right-click on a selected card: group actions only

`act(cardId, action)` is now selection-aware:

- If the card is selected **and** the action is in **`GROUP_ACTIONS`**
  (`card.types.ts`: `tap`, `related`, `delete`) it applies to every selected
  card. Delete removes them all; tap toggles each card's own `tapped` flag;
  Related opens one panel listing the related cards of _all_ the owners.
- Anything else (view, rotate, flip, to-hand/deck/graveyard/exile) **clears the
  selection and acts on the clicked card alone**, exactly as the doc specifies.

The menu shows what will happen: a `N cards selected` header, and the three group
entries carry a `(N)` suffix. A **Tap / Untap** entry was added to the menu
(tapping was click-only before) so the group action is reachable, and `t` joined
the hotkey table.

The related panel's anchor became `RelatedAnchor { ids: string[], x, y }` so it
can carry several owners; `CardOverlay` unions and de-duplicates their
`relatedIds` before resolving them to cards, and the header shows the owner count.

## 7. Clicking elsewhere clears the selection

All four routes are covered:

- clicking empty table (press on nothing → `clearSelection`, then a marquee only
  if the cursor moves),
- pressing a card that is not selected,
- right-clicking a card that is not selected (its menu opens, targeting it alone),
- right-clicking empty table (opens the util window),

plus `Escape`, which also cancels a marquee in progress, and any non-group action.

---

## Files touched

| File                                                                | Change                                                                                                                                                                          |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/app/scene/card/card-interactions.ts`                           | `marquee`/`selectedIds`/`selectionSize` signals, marquee press→drag→release flow, `selectWithin`, group drag (`dragGroup`/`dragOrigin`), selection-aware `act`, `RelatedAnchor` |
| `src/app/scene/card/card.types.ts`                                  | `tap` action, `GROUP_ACTIONS`                                                                                                                                                   |
| `src/app/scene/card/card.ts`                                        | Selected cards wear the hover tint; hide only when ghosted                                                                                                                      |
| `src/app/scene/card/card-overlay/card-overlay.ts`, `.html`, `.scss` | Marquee rectangle, group header + `(N)` suffixes, Tap entry, multi-owner related panel                                                                                          |
| `CLAUDE.md`                                                         | Selection section under the scene architecture                                                                                                                                  |

## Tests

Eight cases in `card-interactions.spec.ts` (`describe('selection')`):

- a drag over empty table selects the cards inside it and leaves one outside it
  alone, and the `marquee` signal is exposed while dragging and cleared on release;
- a click on empty table clears the selection;
- dragging one selected card moves the whole group with offsets preserved, and
  exposes no drag ghost;
- clicking one card of a selection taps only it and keeps the selection;
- `tap` hits the group while `flip` drops the selection and hits one card;
- deleting through a selection removes every selected card;
- the related panel lists every selected card as an owner;
- right-clicking a card outside the selection clears it and targets that card.

## Notes / decisions

- **Selection is per-player and never leaves the browser.** Nothing in the doc
  asks for a shared selection, and sharing one would need conflict rules for two
  players grabbing overlapping groups.
- **Rectangle test uses card origins**, per the doc. A card whose art overlaps
  the rectangle but whose origin does not is _not_ selected — predictable when
  cards are stacked.
- **Group drops are coplanar**: every card in the group lands at the height of
  whatever the pressed card was dropped onto. Dropping a group onto another card
  therefore stacks them all at that card's height rather than preserving
  individual stacking heights.
- **Table items are never selected** (see `additionalitems_results.md`): the doc
  says "all card objects", and dice/counters have their own click semantics.
