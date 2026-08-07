# Double-faced cards — implementation results

Implements `mdfcs.md`: a card with two faces now **flips to its other face** instead of showing
a generic card back, and the large card view gets a **flip button** — only for such cards.

`npm test`: **216 tests, all green** (6 of them new for this doc).
`npm run build`: clean.

---

## 1. What makes a card double-faced

The card data already carries it, as the doc says — it just wasn't being read. A Scryfall-shaped
card object has either

- a whole-card `image_uris` (an ordinary card — including **split**, **flip** and **adventure**
  cards, which read as "A // B" but are printed on one side), or
- no whole-card image and one `image_uris` per `card_faces` entry (**transform**, **modal DFC**,
  reversible, double-faced token — genuinely two-sided).

So "has a second image" _is_ the definition, and one helper decides it:

```ts
facesOf(card) -> { src, back? }   // card-database.service.ts
```

It is shared by both places card data enters the app — the bulk index (`CardDatabaseService.add`)
and the live search (`CardSearchService`) — so the table and the util window can never disagree
about what is two-sided. A split card gets `back: undefined` and behaves exactly as before;
there's a spec for that, because "A // B" in the name is the tempting-but-wrong test.

**No second name field was needed.** The card data spells a two-sided card `"Front // Back"`, so
the face names are the two halves of the name already stored — `faceName()` in `card.types.ts`
splits it, and only when `backSrc` is set (which is why a split card keeps its whole name).

## 2. The state, and how it travels

`CardState` grew two optional fields:

| field     | meaning                                                |
| --------- | ------------------------------------------------------ |
| `backSrc` | the second face's image; **absent = not double-faced** |
| `flipped` | true while the second face is the one showing          |

Optional on purpose: `CardStore.toCard` only writes the keys when there is a second face, so
every ordinary card's world-object payload is byte-for-byte what it was before this change, and
old rows load unchanged. `flipped` is shared state like `tapped` — everyone at the table sees
the same face.

Where a card gets its `backSrc`:

- **from the deck / a zone** — `Zones.tableCard()` resolves it through `CardDatabaseService.lookup`
  at the moment the card is played, exactly as `relatedNames` already worked. (That also folded
  the two near-identical spawn blocks in `beginPlay`/`beginZoneDrag` into one method.)
- **from a search hit** — `CardHit.back` → `SpawnCard.back` → `backSrc`, so a card dragged out of
  the util window can be flipped immediately.
- **from the related panel** — same route, via the database record.
- **from a hand card** — `Zones.hoverHandCard` looks it up so `V` over the hand opens a flippable
  view.

`ZoneCard` was deliberately **not** given a `back` field: a zone stores a name and a front image,
and the database is the one place that knows the rest. Adding it would have made two sources of
truth for the same fact.

## 3. Flip

`flip` (menu and **F**) now branches on the card:

| card                        | flip does                               | history line                                        |
| --------------------------- | --------------------------------------- | --------------------------------------------------- |
| ordinary                    | turns it over (unchanged)               | `turned Water Worm face down`                       |
| double-faced, face up       | shows the **other face**, still face up | `flipped Delver of Secrets to Insectile Aberration` |
| double-faced, **face down** | turns it back up                        | `turned … face up`                                  |

The face-down case is the one judgement call in here: a card lying face down has no "other face"
to show, so F there means the obvious thing — turn it back over.

**Turning a double-faced card face down is still possible**, through a "Turn face down" entry the
context menu shows _only_ for two-sided cards (a new `turnOver` action). The doc reassigns flip,
and silently dropping the ability to put a transform card face down — morph, manifest, "face-down
creature" effects — would have been a regression, so it moved rather than vanished. Ordinary
cards don't show the entry, since their `flip` already is it. The menu's flip label is
dynamic too: **"Flip to Insectile Aberration"**, so you can see what you're about to get.

`Card` (the Three component) renders `faceSrc(state)` instead of `state.src` — one line, and the
existing texture-swap effect does the rest. There is no turning animation; the doc asked for the
right face, and the card's own pose is untouched.

## 4. The flip button in the large view

The **V** view now shows `↻ Flip to <other face>` under the image — and only when the card has a
second face.

This meant merging the two view dialogs. There were two, near-identical: one for a table card
(`viewCardId`) and one for a card with no table instance (`viewImage` — related entries, hand
cards). A third copy of the flip button was not on the table, so `CardOverlay` now normalises
both into one `ViewedCard { name, src, backSrc? }` and renders a single dialog. Closing clears
both signals.

The dialog's flip is **view-only**: it changes what you're looking at, never the card on the
table (the doc says "to view the other side"). It opens on whichever face the card is actually
showing, and a small effect keyed on the viewed card's identity resets that when the dialog moves
to another card — so the button can't leak a face from the card you looked at before.

## 5. Cache version

The distilled index gained a field, so its key went **`index:v3:` → `index:v4:`**; the same base's
v2 _and_ v3 entries are dropped once the new one is built (before, only the single previous
version was cleaned up — a user jumping two versions left an orphan behind). Existing users
re-download the bulk file once, as with every previous index change.

---

## Files touched

| File                                        | Change                                                                    |
| ------------------------------------------- | ------------------------------------------------------------------------- |
| `src/app/carddb/card-database.service.ts`   | `facesOf()`, `CardRecord.back`, index v4, stale v2+v3 cleanup             |
| `src/app/scene/card/card-search.service.ts` | Hits carry `back` (via the shared `facesOf`)                              |
| `src/app/scene/card/card.types.ts`          | `backSrc`/`flipped`, `faceSrc()`/`faceName()`, `turnOver` action          |
| `src/app/scene/card/card-store.ts`          | Parses/writes the two fields only when there is a second face             |
| `src/app/scene/card/card.ts`                | Renders the face currently showing                                        |
| `src/app/scene/card/card-interactions.ts`   | `flip` transforms; `turnOver`; `SpawnCard.back` → `backSrc`               |
| `src/app/scene/card/card-overlay/*`         | Dynamic flip label, turn-over entry, one merged view dialog + flip button |
| `src/app/scene/card/hotkeys.ts`             | F's description; `turnOver` label                                         |
| `src/app/zones/zones.ts`                    | `tableCard()` resolves back + related; hand hover carries `back`          |
| `CLAUDE.md`                                 | Card-interaction and card-database sections                               |

## Tests

- **`card-database.service.spec.ts`** (+0 new cases, extended fixtures): both faces of a
  double-faced card are indexed and reachable by the **front** name a decklist carries; a split
  card with one image gets no back; the stale-index case now covers v2 **and** v3.
- **`card-search.service.spec.ts`** (+1): a double-faced hit carries `back`, a split card doesn't.
- **`card-store.spec.ts`** (+1): `backSrc`/`flipped` round-trip through the shared world, and an
  ordinary card's payload still has no such keys.
- **`card-interactions.spec.ts`** (+4): flip shows the other face and logs both face names; flip
  again returns; `turnOver` turns a two-sided card down and flip brings it back up; a one-faced
  card is unaffected; a search hit dragged onto the table keeps its second face and flips.

## Notes / decisions

- **"Has a second image", not "has `//` in the name"**, is the two-sided test — otherwise Fire //
  Ice would sprout a flip button that shows nothing new.
- **`turnOver` has no hotkey.** F is the doc's flip; face-down is rare enough for the menu, and
  claiming another letter for it would cost a key that reads better elsewhere. It is a normal
  `CardAction`, so binding one later is a single line in `HOTKEYS`.
- **The zone round-trip re-resolves the second face from the database** rather than storing it on
  `ZoneCard`. Same trade-off `relatedNames` already made; the one visible consequence is that a
  double-faced card played while the database is still downloading would come up flip-less, which
  is the same window in which it would come up art-less anyway.
- **No flip animation** and no change to the tapped/face-down pose — the texture swaps.
- Verification is `npm test` + `npm run build`. The rendered result was not seen in a live room:
  the room screens still need the pending Supabase migrations applied to the cloud database.
