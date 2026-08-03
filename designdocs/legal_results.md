# Legal usage of API — implementation results

Implements `legal.md`: the app no longer ships any card-data API of its own.
Scryfall's terms forbid building new games on its data, so VirtualTavern now
provides only the **API usage** — every feature that needs card data reads the
base URL of an API **the user has deposited**, and until one exists no card
data is available anywhere in the app.

---

## What "an API" means here

The user deposits one **base URL** (e.g. `https://api.example.com`) of any
Scryfall-*compatible* API. From that single URL the app derives everything it
used to hardcode:

- **Card search** (util window): `GET {base}/cards/search?q=…`
- **Card database** (bulk index): `GET {base}/bulk-data`, whose listing names
  the `default_cards` export (`download_uri` or `jsonl_download_uri`), which
  is then streamed and indexed.

The bulk download pipeline is deliberately liberal in what it accepts, since
every deposited API packages its export a little differently:

- **Compression**: a raw `.gz` *file* (served as `application/gzip`, which
  `fetch` does **not** inflate, unlike a `Content-Encoding: gzip` response) is
  detected by its gzip magic bytes and inflated in-stream through
  `DecompressionStream`. Sniffing bytes rather than headers/URL is what keeps
  both serving styles working — a header guess would double-inflate one case
  and feed binary JSON.parse garbage in the other. A zstd file is rejected
  with a clear error (browsers cannot inflate zstd).
- **Format**: the former `JsonArrayChunkParser` was generalized into
  **`JsonChunkParser`** — it extracts objects by brace balance, so a JSON
  *array* export and a JSON *Lines* export parse identically (commas and
  newlines between objects are skipped the same way), still streaming with
  bounded memory.
- Download progress counts wire bytes (what `content-length` describes),
  before decompression inflates them.

The previously hardcoded `BULK_DATA_URL` (a dated `data.scryfall.io` file) and
the `api.scryfall.com` search endpoint are **gone from the codebase**.

## Depositing the API (deck overview)

The Decks screen header has a new button — **"Add card API"**, highlighted
while none is set (**"Change card API"** afterwards, same modal, per the doc's
"change/edit the same way"). It opens a `Dialog` with an explanatory line, a
URL text field, and Add/Cancel. The URL is validated (`normalizeApiUrl`: full
http(s) URL, trailing slashes stripped) and bad input shows an inline error.
The database status line reads "No card API deposited — card search and images
are unavailable" until one is added.

## Where it is stored — `CardApiService`

New root service `src/app/carddb/card-api.service.ts`:

- **Registered users**: in the account info — auth `user_metadata['card_api_url']`
  via the new `SupabaseService.setCardApiUrl` (`auth.updateUser`). No DB
  migration needed; user metadata is the doc's "account info" literally.
- **Guests**: temporarily — **sessionStorage** (key `virtual-tavern.card-api`),
  so it survives a reload but not the browser session. This is the deliberate
  reading of "saved temporary for guests", in contrast to the account storage.
- A guest's deposit **follows them into a freshly registered account** (an
  effect mirrors `DeckStore.syncLocalToAccount`): if the new account has no
  URL yet, the guest's is written to it and the temporary copy cleared.
- `apiUrl` / `configured` are signals, so every consumer reacts to a deposit
  appearing, changing, or going away.

## Consumers

- **`CardDatabaseService`** no longer has an `init()`; a constructor `effect`
  follows `apiUrl`. No deposit → status `idle`, empty index, **zero network
  traffic**. A deposit (or a changed one) aborts any in-flight load, drops the
  old index, and loads the new API — from the IndexedDB cache when this API
  was already indexed (the cache key now embeds the **base URL**), else via
  the `/bulk-data` listing + streamed download. The pre-legal cache entry
  (keyed by the old hardcoded URL, tens of MB) is deleted on boot
  (`CardDbCache` gained `delete`).
- **`CardSearchService`** builds its query URL from the deposit and throws
  when there is none; its cache is keyed per API+query so changing the deposit
  never serves another API's hits. The util window checks `configured()`
  before searching and shows "No card API set — add one on the Decks screen."
- The app initializer now just creates `CardDatabaseService` eagerly (nothing
  to await — nothing may download at boot anyway until a deposit exists).

## Files touched

| File                                                | Change                                                                    |
| --------------------------------------------------- | -------------------------------------------------------------------------- |
| `src/app/carddb/card-api.service.ts` (+ spec)       | New: deposit storage (account/guest), validation, guest→account sync        |
| `src/app/supabase/supabase.service.ts`              | `setCardApiUrl` (auth user_metadata)                                        |
| `src/app/carddb/card-database.service.ts` (+ spec)  | Follows the deposit by effect; `/bulk-data` discovery; gzip sniff + inflate; per-API cache key; legacy-cache cleanup |
| `src/app/carddb/json-chunk-parser.ts` (+ spec)      | Generalized from `json-array-chunk-parser.ts` (deleted): JSON array **and** JSON Lines |
| `src/app/carddb/card-db-cache.ts`                   | `delete(key)`                                                               |
| `src/app/scene/card/card-search.service.ts` (+ spec)| Searches `{base}/cards/search`; throws without a deposit; per-API cache     |
| `src/app/scene/util-window/util-window.ts`          | "No card API set" message instead of a doomed search                        |
| `src/app/decks/decks.ts`, `.html`, `.scss`          | Deposit button + modal, "no API" status line                                |
| `src/app/app.config.ts`                             | Initializer creates the DB service instead of calling `init()`              |
| `CLAUDE.md`                                         | Card-API section; Scryfall references rewritten as "the deposited API"      |

## Tests

Full suite: **158 tests, 16 files, all green**; production build clean.

- **`card-api.service.spec.ts`** (new, 6): nothing configured signed-out/undeposited;
  guest deposits land in sessionStorage only; account deposits go through
  `setCardApiUrl` into user_metadata; invalid URLs are rejected with a message;
  a guest deposit follows into a fresh account and the temp copy is cleared;
  `normalizeApiUrl` trims, strips slashes, rejects non-http(s).
- **`card-database.service.spec.ts`** (rewritten, 9): idle + zero fetches
  without a deposit; deposit → `/bulk-data` listing → `default_cards` download
  → indexed and cached under the per-API key; a JSONL export via
  `jsonl_download_uri`; a gzip-compressed file (magic-byte sniff + inflate); a
  zstd file → `error`; cache hit skips the download; API failure → `error`
  status; removing the deposit empties the database; the legacy app-level
  cache entry is deleted on boot.
- **`json-chunk-parser.spec.ts`** (replaces the array parser's spec, 6): both
  shapes whole and split across arbitrary chunk boundaries, BOM/whitespace
  prefixes, CRLF + blank lines + missing trailing newline, bounded buffering.
- **`card-search.service.spec.ts`**: queries hit the deposited base URL; a
  search without a deposit throws before any fetch.

## Notes / decisions

- **"Temporary" for guests = sessionStorage.** localStorage would be exactly
  as permanent as account storage, which would make the doc's guest/account
  contrast meaningless; sessionStorage survives reloads (so the in-room
  resume flow keeps working) but not the browser session.
- **One base URL, two derived endpoints.** The doc says "the user has to tell
  what api to use … it can be any other" — a single Scryfall-compatible base
  URL keeps the modal to one field and lets the app derive search and bulk
  data itself, instead of asking the user for multiple endpoints.
- **No hidden fallback.** There is deliberately no default, sample, or
  environment-level API URL left anywhere in the source; a fresh install shows
  placeholders and a disabled search until the user deposits something.
- The card *images* (`src` URLs stored in decks/world state) come from
  whatever API produced them and keep working like any remote URL; the app
  itself never contacts an API the user didn't deposit.
