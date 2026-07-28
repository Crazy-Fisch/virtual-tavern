# playerui.md — implementation results

Everything requested in `playerui.md` is implemented. `npm run build` and
`npx ng test --watch=false` (117 tests) both pass. Below is what changed, per
section of the design doc, and where.

## Files touched

- `src/app/zones/zone.types.ts` — `revealed?` on `ZoneCard`; `life` on
  `PlayerZones`; new `life:<uid>` world-object id (`LIFE_PREFIX`, `lifeId`).
- `src/app/zones/zone-store.ts` — parse `revealed`; project `life:` objects;
  new `setLife`, `revealHand`, `toggleReveal`, `removeFromZone`.
- `src/app/zones/zones.ts` / `.html` / `.scss` — the whole DOM overlay rework
  (opponent zones, reworked hand, life counter, reveal toggle, zone-card drag,
  choose-deck art, 150% sizing).
- `src/app/scene/card/card.ts` — full-brightness card faces.
- `src/app/scene/card/card.spec.ts` — updated the hover test for the new
  material model.
- `src/app/room/room.types.ts` — doc comment now lists the `item:`/`life:`
  prefixes.
- `angular.json` — raised the `anyComponentStyle` budget (see "Build budget").

## choosing deck

The choose-deck picker now backs each deck tile with a cutout of its first
card's art, matching the Decks screen. New `Zones.firstCardSrc(deck)` resolves
the first decklist entry through `CardDatabaseService.lookup`, and the
`.deck-tile` style mirrors the deck-builder's art + scrim treatment.
(`zones.html` picker block, `zones.scss` `.deck-tile`, `zones.ts`.)

## ui — opponents' zones + health

- `ZoneStore.others()` already exposed every other player's zones (contents
  travel as shared world state). They now render mirrored at the **top** of the
  screen: name, life readout, hand, and piles per opponent (`zones.html`
  `.others`/`.opp`).
- Their **deck** shows a count only; **graveyard** and **exile** are examine
  buttons that open the same dialog as my own (already supported by
  `examine(uid, kind)` + `examined`/`examinedCards`).
- **Health counter.** Stored as a per-player `life:<uid>` world object
  (`{ life }`), projected into `PlayerZones.life` (null until chosen). Before a
  choice I see two vertically stacked **20 / 40** buttons; after choosing, a
  `[−] life [+]` control (minus left, plus right, clamped at 0). Others see only
  the number (`♥ N`), read-only. First choice logs
  `set their starting life to N`; +/- adjustments are silent so they don't spam
  the history. (`ZoneStore.setLife`, `Zones.chooseLife`/`bumpLife`.)

## size

Zone widgets are scaled to 150%: hand cards `6.4→9.6 --u`, piles `4.6→6.9`
wide / `6.4→9.6` tall, the drag ghost `5.6→8.4`, with the counts/labels scaled
to match.

## hand ui

- **Other players' hands** render as cards showing only the **back** (a
  card-back gradient); a card the owner has revealed shows its face instead.
  (`zones.html` `.opp-hand`/`.opp-card`.)
- **My hand caps at 10 visible cards** inside the **middle 50% of the screen**.
  The hand is wrapped in a `.hand-clip` (`width: 50vw; overflow: hidden`); cards
  are absolutely positioned about screen-centre with a spacing computed
  (`handStepPx`) so up to 10 fit exactly in that 50vw window. Cards past the
  window are clipped and reachable by **wheel-scrolling** over the hand
  (`onHandWheel`, using the real card geometry rather than DOM offsets).
- **Reveal-hand toggle** — a button to the left of the hand (bottom-left
  `.my-controls`) that flips the whole hand between revealed/hidden at once,
  overriding per-card state, exactly as specified. `allRevealed` drives its
  label; `ZoneStore.revealHand(bool)` does the whole-hand write and logs
  `revealed/hid their hand`.

## context menu for hand

Right-clicking one of my hand cards opens a small menu with **Reveal to
others / Hide from others** for just that card
(`openHandMenu` → `.hand-menu`, `ZoneStore.toggleReveal`). Reveal state is the
`revealed` flag on the hand card, so opponents' hand rendering flips that one
card face-up.

## zone ui — draggable zone cards

Cards in the examine dialog (my graveyard/exile) are now **draggable** onto the
table or into another zone, in addition to the existing **To hand** button. The
press arms a drag (shared `startDrag`, `source` = the zone); past the threshold
`beginZoneDrag` closes the dialog, lifts the card out of the zone
(`removeFromZone`, silent) and hands it to the normal
`CardInteractions.beginDragFromHand` flow:

- released over the **table** → committed as a played card (`put <name> onto the
  table`);
- released over a **zone widget** → routed into that zone by the existing
  `CardDropTarget`s (that zone logs the move);
- released off-table or **Escape** → returned to its original zone, no trace.

## card material

Table cards no longer look faded versus the dragged/HTML card. The front (art)
face is now **self-lit**: `card.ts` drives it from the texture as an
`emissiveMap` with white `emissive` and `color` set to black (killing the
light-dependent diffuse), so the art shows at full sRGB brightness like an
`<img>`. Hover **brightens** the art face via `emissiveIntensity` (1 → 1.28)
instead of tinting it, while the non-art faces keep the old emissive hover tint.
A face with no art falls back to a plainly lit material.

## Build budget note

The zones component's compiled CSS grew past the default `anyComponentStyle`
budget (6 kB warn / 8 kB error). After trimming with shared Sass placeholders
(`%card-back`, `%panel`, `%pill`) it sits at ~8.3 kB — legitimately the app's
most style-heavy component. The budget was raised to **9 kB warn / 10 kB error**
in `angular.json` (a real cap is kept). Build is clean, no warnings.

## Data-model / networking notes

- Life and reveal ride the existing shared-world-state channel
  (last-writer-wins in Postgres), so both persist and sync to late joiners with
  no schema change — `life:` is just a new object-id prefix, and `revealed` is a
  new optional field on the hand-zone payload (only stored when true, so plain
  cards round-trip unchanged and existing specs stay green).

## Not automatically verified

The build and unit tests pass, but the multi-player, top-vs-bottom seating and
live reveal/health sync are best confirmed with two browser sessions in the same
room (create a room in one, join by code in another, each choose a deck). The
single-client layout (hand fan, clipping/scroll, life picker → counter, hand
context menu, dragging from graveyard) can be exercised solo.
