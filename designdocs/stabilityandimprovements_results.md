# Stability & improvements — results

Implementation results for `stabilityandimprovements.md`. All items are done;
`npm test` (133 tests, 15 files) and the production build are green.

## game stability

### Networked copy appearing when a hand drag starts

**Root cause.** `Zones.beginPlay` (and `beginZoneDrag`) created the played card
through `CardStore.add`, which writes a shared world object immediately — at
`[0, DRAG_Y, 0]`, the middle of the table. Only the drag *preview* was local,
so every other player saw the card pop up mid-table the moment it left the
hand, revealing cards that were merely being considered.

**Fix.** `CardStore` gained a **local-only card layer**:

- `addLocal(card)` renders the card on this client only — nothing reaches the
  network. `Zones.beginPlay`/`beginZoneDrag` now use it.
- `update()` (the drop landing on the table) **promotes** the card into the
  shared world — that is the first moment other players see it, already at its
  final position.
- `remove()` on a still-local card (a drag released off the table, or Escape)
  just discards it — the network never saw the card, so the revert leaves no
  trace.
- A hand card dropped straight onto a zone widget (deck/graveyard/…) discards
  the local copy before the zone absorbs it (`CardInteractions.onPointerUp`),
  and `ZoneStore.takeFromTable` skips the world-object delete when the card
  was never networked.

Files: `card-store.ts`, `zones.ts`, `card-interactions.ts`, `zone-store.ts`.

### Drawn cards vanishing (not in hand, not in deck)

**Root causes** (three compounding problems in the world-write path):

1. `ZoneStore.draw()` issued **two independent upserts** (deck without the
   card, hand with it). If the hand request was lost, the card was gone from
   both zones in the database; `setWorldObject` ignored errors entirely, so
   nothing ever noticed.
2. Separate HTTP requests have no ordering guarantee, so rapid draws could
   commit out of order at the server.
3. Own realtime echoes were force-adopted *unconditionally* (to heal client
   clock skew). An echo of draw #1's hand arriving after the optimistic write
   of draw #2 rolled the hand back to one card.

**Fix** — the world-write path in `RoomService` was rebuilt:

- **Atomic batches.** New `setWorldObjects(entries)` upserts several objects
  in ONE request; PostgREST wraps it in a single transaction (the table's
  primary key `(room_id, object_id)` is the conflict target). `draw()` now
  writes deck+hand as one batch, `loadDeck()` all four zones, and a group
  card-drop commits through the new `CardStore.updateMany`. A half-applied
  draw is now impossible.
- **Ordered dispatch.** All world mutations (upserts and deletes) leave
  through a promise chain, so a later request can never overtake an earlier
  one.
- **Ack adoption.** Each upsert now `select()`s the written rows back and
  adopts the trigger-stamped `updated_at` — the authoritative server clock
  replaces the optimistic local one as soon as the request resolves, healing
  clock skew without relying on the echo.
- **Guarded echoes.** An own realtime echo is only force-adopted when no newer
  write for that object is in flight (tracked per-id in `pendingWrites`);
  the in-flight write's own ack carries the newer truth. Remote DELETE echoes
  are likewise ignored while an own write for that id is pending (the upsert
  re-creates the row).
- **Resync instead of silent divergence.** A failed write re-reads the
  affected rows and adopts whatever the database holds. A lost draw now shows
  up as the card visibly back on top of the deck — annoying but honest, and
  never a lost card.

Regression tests: atomic batch dispatch, ack adoption vs. clock skew, failed
writes resyncing (row present and row absent), and the in-flight echo guard
(`room.service.spec.ts`); batch assertions for `draw`/`loadDeck`
(`zone-store.spec.ts`, via the new `FakeRoomService.batches` recorder) and for
group drops (`card-store.spec.ts`).

Files: `room.service.ts`, `zone-store.ts`, `card-store.ts`,
`card-interactions.ts`, `testing/fake-room.service.ts`.

## card sizes

The 3D card (`CARD_SCALE = 0.5`) drew at ~82 px wide on a 1080p screen while
the DOM drag ghost was `8.4 --u` ≈ 161 px — nearly double, so a card visibly
shrank when dropped. They now meet in the middle at the same size:

- `CARD_SCALE` **0.5 → 0.75** (`card.ts`): a table card is now 0.48 × 0.67 m,
  ~122 px wide at 1080p.
- `.drag-ghost` width **8.4 → 6.38 --u** (`zones.scss`): 0.635 · 0.75 / 4.2
  (the camera's `VIEW_HEIGHT`) of the viewport height = 6.38 `--u` at 16:9 and
  wider, so the ghost and the placed card render the same width at any window
  size. (Hand-fan cards keep their larger 9.6 `--u` readability size.)

## items

**Root cause.** `public/models/d4.glb` *was* loading — but invisibly. The GLB
is authored ~1.73 m wide (Blender default size; the placeholder d4 is 0.2 m)
and its mesh has **no material**, which per the glTF spec defaults to white at
**full metalness** — and a fully metallic surface renders near-black in
three.js without an environment map. The result: a giant, effectively black
pyramid nobody recognised as a die.

**Fix** (`item.ts`, applies to every registered item model, not just the d4):

- `normalizeModel()` — after cloning, the model is uniformly scaled so its
  largest dimension matches the placeholder's size for that kind, centred on
  its bounding box (rolls tumble about the middle), and the rest lift is
  recomputed from its real height so it sits on the table. Authored scale and
  origin no longer matter (`scene-assets.ts` comment updated accordingly).
- `claimMaterials()` — an untextured full-metal material (the glTF default) is
  made matte (`metalness 0.1`), so it shades like the placeholder dice instead
  of rendering black.

The d4 now appears as a die-sized, properly lit model.

## game ui

Hand-size text counters for a quick overview:

- **My hand**: a `✋ N` chip in the bottom-left corner of the hand area
  (`.hand-count`, inside `.hand-clip` — the fan stays centred, so the corner
  is free).
- **Opponents**: a `✋ N` chip added as the first entry of each opponent's pile
  row (`.mini.hand-size`), next to the existing deck/graveyard/exile counts —
  the count was previously only visible as a hover tooltip.

Files: `zones.html`, `zones.scss`.

## zone ui

The "To hand" button under each card in the graveyard/exile examine dialog was
removed — cards are dragged out of the open dialog instead (onto the table or
any zone widget, including the hand, which logs "returned … to their hand" as
before). The now-unused `Zones.toHand()` and `ZoneStore.takeToHand()` were
deleted along with the dead button styles.

Files: `zones.html`, `zones.ts`, `zones.scss`, `zone-store.ts`.

## chat & history

The chat panel now has two tabs (`.tabs` above the log):

- **Chat** (default): user-typed messages, coloured as before.
- **History**: the game's action lines (`kind: 'action'`), plain white.

The log auto-scroll follows the active tab, each tab has its own empty-state
hint, and the compose box stays available on both tabs (typing always sends a
chat message). Storage and networking are unchanged — messages already carried
a `kind`; the tabs are purely a view-side split, so old rooms' history sorts
itself correctly.

Files: `chat.ts`, `chat.html`, `chat.scss`, new `chat.spec.ts`.

## camera movement

The mouse-near-edge camera pan is gone. `CameraRig` now only sets the fixed
base pose (still mirrored to the −Z table end for non-owners) — the pointer
listeners, per-frame damping loop, and tilt math were removed entirely rather
than gated behind a setting, per the design doc's "can be disabled".

Files: `camera-rig.ts`, comment updates in `scene.ts`.

## documentation

`CLAUDE.md` was updated where this work made it inaccurate: the world-write
pipeline (batching/ack/resync), `CardStore.addLocal`, item-model
normalisation, the chat tabs, and the removed camera pan.
