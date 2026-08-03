# Table items — implementation results

Implements `tableitems.md`: dice, coins and counters no longer spawn at the
right-clicked table spot — picking one in the "Add to game" window hands it to
the cursor, already in the dragged state, and a **click on the table places it
there**.

---

## The flow

1. Right-click empty table → util window → pick a d6 / coin / +1/+1 counter.
2. The window closes and the item floats at `DRAG_Y` under the cursor,
   following every mouse move (the same drag plane and preview mechanics as a
   normal item drag).
3. A **click** on the table drops it where the cursor ray lands — on the table
   surface, or on a card (a spawned counter clicked onto a card attaches to it,
   exactly like one dragged there). This is also when the "added a d6" history
   line is posted.
4. A click that hits nothing placeable (off the table) keeps the item on the
   cursor; **Escape** discards it entirely.

Note the click, not a release: an ordinary drag ends when the held button is
let go, but a spawn arrives with the button already up (it was released on the
util-window button), so the item follows the cursor freely and `pointerdown`
is what places it. The `pointerup` of that same click is explicitly ignored.

## Spawns are local until placed

The item is created through a new **local-only layer in `ItemStore`**
(`addLocal` / promote-on-`update` / discard-on-`remove`), copied from the one
`CardStore` grew for hand plays in `stabilityandimprovements.md`:

- While it follows the cursor, nothing has reached the network — other players
  cannot see an item that is merely being carried around.
- The placing click promotes it into the shared world (`update()` →
  `setWorldObject`), so remotes see it appear once, at its final spot, together
  with the history line.
- Escape (or any other cancellation) just deletes the local copy — the network
  never knew, no history line is written.

`CardInteractions` drives this with a small `spawnDrag` mode flag:
`beginSpawnDrag(item)` (called by the util window) adds the local item and
enters the normal dragging state; `onPointerDown` routes a click during a spawn
drag into the existing `tryPlace` (same raycast, same counter-attach logic);
`onPointerUp` and Escape know a spawn needs discarding instead of snapping
back.

## Files touched

| File                                              | Change                                                                                     |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `src/app/scene/item/item-store.ts`                | Local-item layer: `addLocal`, promotion in `update`, silent discard in `remove`            |
| `src/app/scene/card/card-interactions.ts`         | `beginSpawnDrag`, the `spawnDrag` mode (click places, release ignored, Escape discards)    |
| `src/app/scene/util-window/util-window.ts`, `.html` | Item picks call `beginSpawnDrag` instead of spawning at the anchor; history line moved to placement |
| `CLAUDE.md`                                       | Table-items paragraph documents the spawn-drag flow                                        |

## Tests

- **`item-store.spec.ts`** (+2): a local item is visible on this client but
  absent from the shared world until `update()` promotes it; removing a
  still-local item leaves no network write and no history.
- **`card-interactions.spec.ts`** (+4, `describe('spawn drag')`): the full
  pick → follow → click-to-place flow (placed at the cursor ray's table hit,
  promoted to the shared world, "added a d6" logged); a click that misses keeps
  the item attached to the cursor; Escape discards an unplaced spawn without a
  trace; a spawned counter clicked onto a card attaches to it.

`npx ng test` for the two touched suites: **50 tests green** (full run at the
end of this work batch — see the other `*_results.md` of this date).

## Notes / decisions

- The history line moved from the util-window pick to the placing click — an
  item that is picked and then cancelled never happened, matching how hand
  plays only log once the card actually lands.
- The spawn starts at the right-clicked world point (at drag height), so there
  is no visual jump before the first mouse move — the cursor is right there,
  since that's where the util window was opened.
- The old position jitter for repeated adds is gone for items (placement is
  exact under the cursor now); card adds from the search keep it.
