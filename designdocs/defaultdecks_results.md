# Default decks — implementation results

Implements `defaultdecks.md`: the `.txt` decklists under `public/decks/` ship with the
app and appear in every user's deck list — guest or account — including decks added
later.

`npm test`: **184 tests, all green** (6 of them new for this doc).
`npm run build`: clean, and the three decklists land in `dist/…/browser/decks/`.

---

## The problem: static hosting can't list a directory

The doc asks for "every I add" to be picked up, which means the app has to know what
is in `public/decks/`. A browser cannot ask a static host (GitHub Pages, in this
case) what files a folder holds, and Angular's build copies `public/` verbatim
without producing an index.

So the folder is enumerated at **build** time:

`scripts/generate-deck-manifest.mjs` reads `public/decks/*.txt` and writes
`public/decks/index.json` — a sorted array of filenames. It is wired to the npm
lifecycle hooks:

```
"decks:manifest": "node scripts/generate-deck-manifest.mjs",
"prestart":       "npm run decks:manifest",
"prebuild":       "npm run decks:manifest",
"prebuild:pages": "npm run decks:manifest",
"prewatch":       "npm run decks:manifest",
```

so `npm start` / `npm run build` / the Pages deploy (`build:pages`, what the GitHub
Action runs) all refresh it first. **Adding a deck is: drop the `.txt` in, rebuild.**

Two small decisions there:

- The manifest is **committed as well as generated**, so a build that bypasses the
  npm scripts (a bare `ng build`) still ships whatever was there.
- The script only writes when the content actually changed, so an unchanged manifest
  keeps its timestamp and stays out of `git status`.

## Loading them

`BuiltInDecks` (`src/app/decks/built-in-decks.ts`, root) fetches the index and then
each listed file, parsing with the **same `parseDecklist`** a pasted import uses — so
the shipped lists may be in any of the formats the app already accepts. The three
provided files are Moxfield-style (`1x Crystal Grotto (dmu) 246 [Land]`), which that
parser already handles.

The deck's name comes from its filename: `black_demons.txt` → **"Black Demons"**
(`deckNameFromFile` — underscores/hyphens to spaces, title-cased). A `.txt` carries no
other name, and this keeps the rule obvious: rename the file to rename the deck.

Everything fails soft, in the spirit of the app's missing-GLB fallback: no manifest, a
missing file, or a list with nothing parseable in it costs **that** deck and nothing
else, with a console warning.

The URLs are relative (`decks/index.json`), so they resolve against the `<base href>`
Angular stamps in — which is `/virtual-tavern/` on Pages. Verified against the dev
server that the static folder and the `/decks` **route** coexist: `/decks/index.json`
and `/decks/red_dragons.txt` serve the files, `/decks` still serves the app.

## Merging them into every user's decks

`DeckStore.decks()` is now a computed:

```ts
readonly decks = computed(() => [...this.builtIn.decks(), ...this._decks()]);
```

The player's own decks moved behind **`ownDecks()`** — that is what localStorage and
the `decks` table hold, and what `persistLocal` / `syncLocalToAccount` write.

The important choice here is **merge at read time, not copy on first run.** Copying
the shipped decks into each user's storage would have been the obvious move, but it
only works once: a decklist added next month would never reach a user who already had
their copy made, which is precisely what the doc asks for. Reading them fresh on every
load means a new `.txt` appears for everyone — existing users included — the moment it
is deployed. It also keeps three decks per user out of the `decks` table.

The consequence is that shipped decks are **read-only**: `rename()` and `remove()`
return early for a `builtin:` id, because there is nothing of the user's to write. On
the Decks screen the tile wears a small "included" badge, and its right-click menu says
so instead of offering the two actions. They are otherwise ordinary decks — viewable in
the full-page deck view, and pickable in the in-room "Choose Deck" gate, which reads
the same `decks()` and needed no change at all.

---

## Files touched

| File                                       | Change                                                                               |
| ------------------------------------------ | ------------------------------------------------------------------------------------ |
| `scripts/generate-deck-manifest.mjs`       | Writes `public/decks/index.json` from the folder (new)                               |
| `package.json`                             | `decks:manifest` + the `prestart` / `prebuild` / `prebuild:pages` / `prewatch` hooks |
| `public/decks/index.json`                  | The generated manifest (new, committed)                                              |
| `src/app/decks/built-in-decks.ts`          | `BuiltInDecks`: fetch, parse, name (new)                                             |
| `src/app/decks/deck.types.ts`              | `builtin:` id prefix + `isBuiltInDeck` / `builtInDeckId`                             |
| `src/app/decks/deck-store.ts`              | `decks()` merges shipped + own; `ownDecks()`; rename/remove ignore built-ins         |
| `src/app/decks/decks.ts`, `.html`, `.scss` | "included" badge on the tile, read-only note in the context menu                     |
| `CLAUDE.md`                                | Commands + the decks section                                                         |

## Tests

- **`built-in-decks.spec.ts`** (new, 4 cases): every decklist in the manifest loads, in
  manifest order, with ids/names/parsed lists as expected; a missing or empty decklist
  costs that deck and nothing else; no manifest at all yields no decks and no throw;
  `deckNameFromFile` covers underscores, hyphens and an uppercase extension.
- **`deck-store.spec.ts`** (+2, and the shared setup now stubs `BuiltInDecks` at the
  service seam like every other backend): shipped decks appear for a guest, ahead of
  their own, and stay out of `ownDecks()` and localStorage; a shipped deck cannot be
  renamed or deleted — it survives both calls and nothing is written anywhere.

## Notes / decisions

- **Read-time merge over first-run copy** — the load-bearing decision; see above.
- **Shipped decks are not deletable.** A "hide this one for me" list is possible but
  needs per-user state the doc doesn't ask for. If a shipped deck turns out to be
  unwanted, deleting the `.txt` removes it for everyone on the next deploy.
- **Names come from filenames.** The alternative was a name header inside each file (or
  a richer manifest), which is more flexible but adds a format the user has to remember;
  filenames are already the thing they control.
- **Folder vs. route.** `public/decks/` shares its path with the `/decks` route. Checked
  against the dev server: the static files win for `decks/*.json|txt`, and `/decks` still
  falls through to the app. On Pages the same holds — a directory with no `index.html`
  serves the SPA's `404.html` fallback at the requested URL, which is how the app's other
  routes already work there.
- Verification is `npm test`, `npm run build` (confirming the decks reach the output),
  and a dev-server fetch of the manifest and a decklist. The decks were not played through
  a live room — the room screens still need the pending Supabase migrations applied to the
  cloud database.
