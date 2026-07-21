# Placing cards — implementation results

Implements `placingcards.md` (drag-to-move + tap-on-click, camera-ray placement).
All changes are in the interaction layer and the card state model; the networking
pattern (whole-card LWW writes through `RoomService.setWorldObject`) is unchanged.

## Mouse interaction

The old click-to-move flow (click picks up, next click drops) is replaced in
`src/app/scene/card/card-interactions.ts`:

- **Hover** — unchanged: the cursor ray highlights the topmost card/token.
- **Click = tap.** `pointerdown` on a card/token now only records a _press_.
  If the pointer is released within 4 px of travel (`DRAG_THRESHOLD_PX`), it
  counts as a click and toggles the card's new **`tapped: boolean`** state
  (`CardState` in `card.types.ts`). Tapping is networked like every other card
  mutation and posts a history line (`tapped <name>` / `untapped <name>`).
  Clicking a token does nothing — tapping is a card notion.
- **Rendering the tap** — `Card.applyPose` (`card.ts`) renders `tapped` as a
  clockwise quarter turn (−90°) applied on top of the stored `yaw`, so tapping
  never destroys a card's own rotation and untapping restores it exactly.
  Storing the flag instead of mutating `yaw` by ±90° also makes the toggle
  immune to drift from concurrent writers.
- **Drag = move.** Once a press travels past the threshold, the card enters the
  drag state: it floats at `DRAG_Y` following the cursor as a local-only
  preview (remote players still only see the final placement). Releasing the
  button places it (see below). `pointerup` is listened on `window`, so a drag
  ends even when released off-canvas.
- **Snap back.** If the release ray hits nothing placeable (e.g. released off
  the table), the local preview is discarded and the card snaps back to its
  pre-drag position — the shared state was never touched during the drag, so
  snap-back is free. Escape still cancels a drag the same way.

## Placement is now where you actually point

`tryPlace` no longer casts straight down from the floating card's origin (which
drifted from the cursor under the tilted camera). It now casts **from the camera
through the cursor** — the equivalent of Unity's
`Camera.ScreenPointToRay(mousePos)`, which in three.js is
`Raycaster.setFromCamera(ndc, camera)` — and places the object at the first hit
among the environment surfaces and the other registered cards/tokens (the
dragged object itself is excluded from the targets). Hitting another card
places on top of it, so stacking still works; the hit point gets the usual
`PLACE_OFFSET` lift against z-fighting.

The same cursor-ray placement is used by the "placing" flow (a card played from
hand or added by the util window rides the cursor untethered): the next click
drops it at the clicked point. Unlike a drag, a failed placing click keeps the
card attached to the cursor — a freshly played card has no table position to
snap back to.

## Files touched

| File | Change |
| --- | --- |
| `src/app/scene/card/card-interactions.ts` | Press/drag/tap state machine, `window` pointerup, camera-ray `tryPlace`, `toggleTap`, snap-back |
| `src/app/scene/card/card.types.ts` | `CardState.tapped: boolean` |
| `src/app/scene/card/card-store.ts` | Defensive parse of `tapped` (defaults `false`, so pre-existing cards are untapped) |
| `src/app/scene/card/card.ts` | `applyPose` renders the tap quarter-turn |
| `src/app/zones/zones.ts`, `src/app/scene/util-window/util-window.ts` | New cards spawn `tapped: false` |
| `CLAUDE.md` | Interaction-flow description updated |
| Specs | Fixtures gained `tapped`; new tests (below) |

## Tests

`card-interactions.spec.ts` grew a `pointer flow (tap / drag / place)` suite
that runs the real raycasting end-to-end in jsdom: the canvas rect is mocked to
800×600, the `SceneCamera` is posed over the table like `CameraRig`, and real
three.js geometry (a 20×20 plane surface + a box for the card) is registered so
the camera-through-cursor rays hit actual meshes. Screen coordinates for the
synthetic pointer events are derived by projecting world points through the
camera, so the assertions prove the "place where I clicked" requirement:

- a click without dragging taps, a second click untaps (position untouched,
  both logged to history),
- a drag places the card at the exact world point under the release cursor
  (x/z match the targeted table point, y = table + `PLACE_OFFSET`), and a drag
  is not a tap,
- a drag released where the ray misses everything snaps the card back,
- a played card (`beginPlacing`) is placed at the clicked point, and the
  placing click does not tap it.

`card.spec.ts` verifies the tapped quarter-turn (and its removal on untap) on
the rendered wrapper. All fixtures across the specs carry the new field.

`npm test`: 10 files, 65 tests, all green. `npm run build`: clean.

## Notes / known limitations

- The design doc says tap rotates "+90deg"; the implementation turns the card
  **clockwise** (−90° about world-up), matching the physical card-game
  convention. Flip the sign of `-HALF_PI` in `card.ts` if the other direction
  is wanted.
- Tokens drag-move exactly like cards but ignore plain clicks (no tap). Their
  roll/flip actions stay in the right-click menu.
- Pre-existing quirk kept: pressing Escape while a freshly played card rides
  the cursor leaves it committed at its spawn position floating at `DRAG_Y`
  (returning it to the hand would need cross-store surgery and wasn't in
  scope).
- Releasing a drag over a DOM overlay (chat, zones) places the card at the
  table point under the cursor — the overlays don't shield the canvas ray.
