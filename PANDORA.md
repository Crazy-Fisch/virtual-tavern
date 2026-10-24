# Virtual Tavern in PandorasBox

- Source: `X:\CodeProjects\Web\VirtualTavern` (only read, never written from here).
- Copied: 2026-10-16 with `robocopy /E /XD node_modules dist .angular .cache`, `.git` included.
- Copied HEAD: `9bcd6a9c3f227e04db4f26d898cf98f96b0f454d` ("view fix"). Only local change at copy time: `Instructions.md` modified (same in source).
- Games project: id 3 "Virtual Tavern", type `develop`, root `games/projects/VirtualTavern`.
- Agents never push; commits stay local in this copy. The user pushes and deploys with the Push & deploy button of the Games program (project drawer, Git & deploy): origin Crazy-Fisch/virtual-tavern, branch main, then GitHub Actions deploy.yml builds and deploys to GitHub Pages (https://crazy-fisch.github.io/virtual-tavern/). The push authenticates through the system git credential helper (account Crazy-Fisch); the project git_token_env is VIRTUALTAVERN_GITHUB_TOKEN, unset on purpose, because GITHUB_TOKEN in .env cannot push. A Redeploy (workflow_dispatch) needs a token in that variable.
- After a push, the source copy on X: should run `git pull origin main` (note for the user; never touched from here).

## Sync back later
Run inside the source on X: (not from here): `git pull D:/PandorasBox/games/projects/VirtualTavern main` (use the branch checked out in the copy), after committing or stashing the local `Instructions.md` change there.

## Build and test
- `npm ci` then `npm run build` (runs `decks:manifest`, then `ng build`; output `dist/virtual-tavern`): OK, main bundle 1.33 MB.
- `npx ng test --watch=false` (Angular unit-test builder, vitest): 20 files, 219 tests passed.
- `npm ci` prints a warning about 5 packages with install scripts not covered by `allowScripts`; build and tests work regardless.

## Local commits of job `2026-10-16-virtual-tavern` (not pushed; on top of `9bcd6a9` "view fix")
| Commit | Task | Content |
| --- | --- | --- |
| 3a29d55 | t3 | New round in the same room |
| 016b0c2 | t4 | Infect counter, silent return of a dragged hand card |
| eb281cb | t5 | Per-card artwork print on deck entries, decklist import keeps (SET) number, print service |
| bdf5e23 | t5 | CODEMAP: artwork print notes |
| 86ff27c | t6 | Artwork picker in the deck view |
| 077071d | t7 | In-app deck editor (search, counts, sort/group/filter, list/grid, curve, export) |
| f1a1cf3 | t8 | Draw animation, collapsible chat/history panel |
| 36c975f | t9 | UI polish, CODEMAP "UI follow-ups" |

`git log --oneline 9bcd6a9..HEAD` in the copy shows the exact list. CODEMAP.md and CLAUDE.md in the copy describe the new code.
`PANDORA.md` and `virtualtavern.clue.md` are deliberately untracked here, so they do not travel to X:.

## Pull the commits into X:
Run on X: yourself (this job never writes there):
1. `cd X:\CodeProjects\Web\VirtualTavern`
2. `git status`: the local `Instructions.md` change is also in the copy; commit it or `git stash` it first.
3. `git pull D:/PandorasBox/games/projects/VirtualTavern main` (use the branch checked out in the copy; it fast-forwards because the copy has X:'s history).
4. `npm ci` (new files only add code, no new npm packages) and `npm run build`, `npx ng test --no-watch`.
5. Run `supabase/migration-2026-10-16-decks-update.sql` in the Supabase SQL editor (needed for saving decks in signed-in accounts).

## Final check (t9)
- `npm run build`: OK (main 1.39 MB). `npx ng test --no-watch`: 20 files, 225 tests passed.
- `npm start`: dev server booted, `http://localhost:4200/` answered 200; stopped afterwards.

## Local commits of job `2026-10-21-virtual-tavern-update` (not pushed)
| Commit | Task | Content |
| --- | --- | --- |
| 2dd4b14 | t1 | Infect below HP, chat panel left with room row and copy code, instant draw completion |
| 38c4331 | t2 | Undo journal backend in RoomService (50 actions) |
| see `git log` | t3 | History undo button with confirmation, docs |

## Local commits of job `2026-10-24-tavern-update` (not pushed)
| Commit | Task | Content |
| --- | --- | --- |
| 79f58ee | t1 | Taller deck search panel, new menu tagline, card drag keeps grab offset |
| 573cdb5 | t2 | Flat plane table, middle-drag pan, wheel zoom, recenter hotkey |
| 9925d88 | t3 | Attack zone model: combat state, pure layout, CardStore combat methods |
| 2d09143 | t4 | Attack zone interactions: drop routing, block by drag, Attack menu action, A hotkey |
| eb5b9c4 | t5 | Attack zone border with red combat glow, docs |

Final check (t5): `npx ng test --no-watch` 21 files, 266 tests passed; `npm run build` OK (main 1.41 MB); `npm start` answered 200 on http://localhost:4200/ and was stopped.
