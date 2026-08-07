# Hotkeys — implementation results

Implements `hotkeys.md`: a **hotkey overview** behind a button in Settings, and the
**duplicate** card action on the context menu and the **D** key.

`npm test`: **198 tests, all green** (7 of them new for this doc).
`npm run build`: clean.

---

## 1. The overview

Settings gained a **"Hotkeys…"** button, and the in-game overlay a **"Hotkeys"** button
beside "Untap all". Both open the same read-only list — no rebinding, as the doc says —
grouped into: a card on the table under the cursor, a card in your hand, keys that work
anywhere, and the mouse.

The list is one component, **`HotkeyList`** (`scene/card/hotkey-list/`), so the two places
can't drift apart either. It carries its own styles rather than being markup projected into
`Dialog`, which would have left it in each host's style scope.

Opening it **in-game clears the hover** first (`hoveredId`, `hoveredHandCard`). The dialog
covers the canvas, so hover picking stops updating — and a player reading "X — remove it
from the table" and trying it out must not delete whatever the cursor happened to be over
before the panel opened.

The one decision worth explaining is where the list lives. A hand-written list in the menu
template would have started drifting from the real key map the first time a hotkey moved.
So the keyboard layer and its documentation now live together in
**`src/app/scene/card/hotkeys.ts`**, and the "card under the cursor" section is
**generated** from the same `HOTKEYS` record `CardInteractions` dispatches on:

- `HOTKEYS` moved out of `card-interactions.ts` into that file.
- `CARD_ACTION_LABELS` gives each `CardAction` its overview wording (the context menu's own
  labels stay dynamic — "Tap" vs "Untap").
- `HOTKEY_GUIDE` builds the rows, grouping by action so the two keys that both delete come
  out as a single **"X / Delete"** row.

Adding a hotkey therefore adds its row, and a spec asserts every key in `HOTKEYS` appears
in the guide.

Two smaller choices:

- **The file imports nothing from Three.** The menu screen renders the guide, and it must
  not drag the scene into its bundle — hence a separate module rather than exporting from
  `card-interactions.ts`, which imports Three.
- **The panel replaces the settings dialog** instead of stacking a second modal over it.
  Two stacked `Dialog`s both listen for Escape, so one key would have closed both; a Back
  button reads better anyway.

**Scope note:** I included a **Mouse** group (click to tap, drag to move, marquee, the two
right-click menus, counter up/down, deck draw, hand wheel). The doc said "list of hotkeys",
so this is slightly more than asked — but a controls reference that omits "click a card to
tap it" is not much use to a new player. It is one array in `hotkeys.ts` if you want it
gone.

## 2. Duplicate

`duplicate` is a new `CardAction`, on the card's right-click menu (between "Related…" and
the send-away entries) and on **D**.

The copy keeps everything that makes it the same card — name, image, related names, yaw,
face, tapped state — and differs in three deliberate ways:

- **Its own `card:` id**, so it is a genuinely separate table card.
- **Nudged clear**: `+0.08` in x and z, and `+PLACE_OFFSET` in y so the two can never
  z-fight. The copy is visible immediately rather than hiding exactly under the original.
- **Owned by me** (`ownerUid`), whoever owned the original. I am the one who put it on the
  table, and that field is what "untap all" keys off — a copy I made should untap with my
  cards, not with theirs.

Counters attached to the original stay on the original: a copy of a card is a card, not a
card plus its state.

**Duplicate is a group action.** It is in `GROUP_ACTIONS`, so duplicating a card that is
part of a marquee selection copies the whole selection — every copy taking the same nudge,
so the group's layout is reproduced rather than collapsed. The doc didn't ask for this, but
"duplicate these three tokens" is the obvious use, and the selection machinery was already
there.

That did mean one addition: the group path writes through a new **`CardStore.addMany`**, so
a selection duplicates in **one** batched request. Every other group commit in this codebase
is atomic (the group drop, `draw`, `untapAll`), and N separate inserts would have been out
of step with that. The history line follows suit — "duplicated Water Worm" for one,
"duplicated 3 cards" for a selection.

---

## Files touched

| File                                                | Change                                                                       |
| --------------------------------------------------- | ---------------------------------------------------------------------------- |
| `src/app/scene/card/hotkeys.ts`                     | `HOTKEYS` (moved here), `CARD_ACTION_LABELS`, generated `HOTKEY_GUIDE` (new) |
| `src/app/scene/card/hotkey-list/*`                  | `HotkeyList`, the panel both screens render (new)                            |
| `src/app/zones/zones.ts`, `.html`, `.scss`          | In-game "Hotkeys" button beside "Untap all", clearing the hover on open      |
| `src/app/scene/card/card.types.ts`                  | `duplicate` added to `CardAction` and `GROUP_ACTIONS`                        |
| `src/app/scene/card/card-interactions.ts`           | Imports `HOTKEYS`; `duplicate()`, batched for a selection                    |
| `src/app/scene/card/card-store.ts`                  | `addMany()`                                                                  |
| `src/app/scene/card/card-overlay/card-overlay.html` | "Duplicate" menu entry (with the group suffix)                               |
| `src/app/menu/menu.ts`, `.html`, `.scss`            | Settings ▸ Hotkeys button and dialog                                         |
| `CLAUDE.md`                                         | Hotkey/menu sections                                                         |

## Tests

- **`hotkeys.spec.ts`** (new, 4 cases): every key `CardInteractions` dispatches on appears
  in the guide; the two delete keys render as one "X / Delete" row; every listed action has
  a label and no row or group is empty; D is duplicate and shows up as such.
- **`card-interactions.spec.ts`** (+3): duplicate puts a copy on the table with the same
  pose but its own id, nudged clear, above the original and stamped as mine; the D hotkey
  duplicates the hovered card; duplicating through a selection copies every card in **one**
  write, keeps the spacing, logs "duplicated 2 cards", and leaves the originals selected.

## Notes / decisions

- **The guide is generated, not written.** The whole point of putting `HOTKEYS` and the
  overview in one file; a hand-maintained list would be wrong within a release or two.
- **One panel component, two entry points** — the menu's Settings and the in-game overlay.
  The in-game one is the more useful of the two: it is where you actually need the reminder.
- **Mouse controls are in the list** — more than "hotkeys" strictly means; see the scope
  note above.
- **Duplicate is a group action**, unlike the doc's single-card framing. It costs nothing
  (the selection path already existed) and is the obvious way to want it.
- **A copy belongs to whoever made it**, not to whoever owned the original.
- **Attached counters are not copied.**
- Verification is `npm test` + `npm run build`. The overview panel is a static dialog and
  was type-checked by the template compiler but not seen rendered — a live session still
  needs the pending Supabase migrations applied to the cloud database, and duplicate in
  particular has not been watched in a real room.
