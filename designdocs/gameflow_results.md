# Game flow — implementation results

Implements `gameflow.md`: deck creation (import-only), the local Scryfall card
database, and the "choose deck" gate when entering a room.

## Deck creation (`src/app/decks/`)


- **Model** (`deck.types.ts`): a deck is exactly the doc's "basic json file" —
  `{ id, name, list }` with entries `{ card: "Water Worm", count: 1 }`.
  `deckSize()` sums the counts for the overview tiles.
- **Importer** (`decklist-parser.ts`): one parser covers the common export
  formats without needing a format switch — plain name-per-line lists, leading
  counts (`4`, `4x`), trailing counts (`Name x4`), MTGO's `SB:` prefix,
  Arena/Moxfield/Scryfall `(SET) 123` suffixes, and Archidekt's `[Category]`
  / `*F*` / `^Have^` markers. Section headers (Deck, Sideboard, Commander,
  About + its `Name …` line, …), blank lines, and `//`/`#` comments are
  skipped; duplicate names merge counts case-insensitively. Split-card names
  ("Fire // Ice") and parenthesized name parts ("B.F.M. (Big Furry Monster)")
  survive intact. Everything currently lands in one list — board sections are
  not distinguished yet.
- **Storage** (`deck-store.ts`): decks persist in localStorage
  (`virtual-tavern.decks`, same key style as the room resume key) — they are
  personal, device-local data, not room state. Import-only per phase 1:
  `import(name, text)` and `remove(id)` are the whole API; corrupt persisted
  state is discarded defensively.
- **UI** (`decks.ts/.html/.scss`): the placeholder page became the deck
  screen — an import form (name + pasted decklist, with an error line when
  nothing parses) and the overview grid: square tiles with the deck name
  inside and the card count below, per the doc. Right-clicking a tile opens a
  context menu with **Delete deck**; clicking anywhere else closes it. A
  status line in the header shows the card database state (checking /
  downloading with % / ready with card count / error).

## Resources — the card database (`src/app/carddb/`)

The doc's bulk file (`BULK_DATA_URL` in `card-database.service.ts`, the dated
`default-cards-20260719091104.json` URI) is ~450 MB — far too large to
`JSON.parse` whole or to keep around. The pipeline instead:

- **`JsonArrayChunkParser`** — a small streaming scanner for a huge JSON array
  of objects: fed decoded text chunks as they download, it emits each
  completed top-level element as its own small JSON string (string/escape and
  brace-depth aware, so chunk boundaries can fall anywhere). Memory stays
  bounded by one card object plus the unscanned tail; the full file never
  exists in memory.
- **`CardDatabaseService`** — distills each card into a compact index entry
  `{ name, src }` keyed by lowercase name (`src` = Scryfall "normal" image;
  double-faced cards use the front face's image and are also keyed by their
  front-face name, since decklists usually carry only that). First printing
  with an image wins; reprints don't overwrite. The finished index (a few
  tens of MB for ~35k names, versus 450 MB raw) is what gets cached.
- **`CardDbCache`** — a tiny promise wrapper over an IndexedDB key-value
  store (localStorage quotas are far too small). The cache key embeds the
  bulk URL, so pointing `BULK_DATA_URL` at a newer export invalidates the
  cache — the seed of the later update system.
- **App start**: a second `provideAppInitializer` in `app.config.ts` fires
  `init()` **without awaiting it** — "check and load on start" per the doc,
  but a first-run 450 MB download must never block boot. `init()` is
  idempotent (one shared run), exposes `status` / `progress` / `cardCount`
  signals, and on any failure degrades to `error`: the app keeps working,
  deck imports just resolve without images until the next start.

## Entering a room

- `ZoneStore.ensure()` (auto-created empty zones for every visitor) is gone.
  Zones are now only created by the new **`loadDeck(cards)`** — hand and
  graveyard empty, the deck shuffled in (Fisher–Yates, extracted from
  `shuffle()`), and a `joined the game with a N-card deck` history line. The
  new **`hasMine`** computed ("do I have zones in this room?") is the gate;
  `refreshOwnerName()` still refreshes my display name on rejoin but never
  creates zones.
- The `Zones` component hides the whole zone UI while `hasMine()` is false and
  instead shows the bottom-right **Choose Deck** button. It opens a dialog
  listing the imported decks as the same square tiles; picking one resolves
  every decklist entry through `CardDatabaseService.lookup()` (canonical name
  + image URL; unresolved names keep the decklist spelling with an empty
  image), expands the counts into individual `ZoneCard`s, and calls
  `loadDeck`. The game UI appears reactively the moment my zones exist —
  which also means a rejoin into a running session skips the gate entirely,
  and other players see my zones the same way they always did.
- **Image warming**: choosing a deck immediately fires
  `AssetLoaderService.loadTexture()` for every distinct card image in the
  deck (the doc's "start loading all the images into cache") — this fills
  both the texture cache used by table cards and the browser HTTP cache used
  by the hand/graveyard `<img>`s.

## Cards

Cards continue to carry their image URL in shared state (`ZoneCard.src` /
`CardState.src`), so remote players need no database of their own to render
them. Per the doc's cache→database order, a card **played from hand** re-checks
the database when its `src` is empty (e.g. the deck was imported before the
database finished downloading) and heals the image at that moment; the actual
pixels then come from the texture/HTTP cache warmed at deck load.

## Tests

31 new tests (86 total, all green; production build clean):

- `decklist-parser.spec.ts` — plain/`4x`/`x4` counts, an Arena export with
  sections and set suffixes, Archidekt markers, `SB:`, case-insensitive
  merging, `//` split-card names vs. comments, the B.F.M. parenthesis edge.
- `deck-store.spec.ts` — import/persist/reload across store instances,
  reject-empty, unnamed fallback, remove, corrupt-state recovery.
- `json-array-chunk-parser.spec.ts` — whole-array and per-1/3/7/16-byte chunk
  feeds, quotes/escapes/braces-in-strings, junk before the array.
- `card-database.service.spec.ts` — streaming download → ready (progress,
  dedupe, DFC front-face alias, nameless-junk skip, index persisted), pure
  cache hit (no fetch), download failure → `error`, idempotent `init()`.
- `zone-store.spec.ts` — `loadDeck` creates the three zones with the shuffled
  deck and logs the join; `refreshOwnerName` renames without ever creating.

## Notes / known limitations

- **Deck storage is device-local** (localStorage). The doc frames decks as
  personal JSON files, so no Supabase schema change was needed; syncing decks
  to accounts is a natural later step.
- The card database index keeps one image per name — printings/languages are
  collapsed, which is exactly what deck import needs. The util window's
  Scryfall **search** API usage is untouched (different feature: fuzzy search
  vs. exact resolution).
- Old cached indexes under superseded bulk URLs linger in IndexedDB until an
  update system cleans them up.
- The first-run download is large (~450 MB over the wire). Status/progress is
  visible on the Decks page; there is deliberately no consent gate per the
  doc's "upon application start we check and load this file".
- Board sections (sideboard/commander) all merge into the one decklist for
  now; the parser already skips their headers, so splitting them later is a
  parser-output change, not a format change.
- Loading a deck mid-session replaces that player's zones (fresh game for
  them); cards they already had on the table stay on the table.
