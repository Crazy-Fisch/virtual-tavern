---
for: *
output: ai
expires: 2026-12-15
by: 2026-10-16-virtual-tavern/t2
why: code map written after reading CLAUDE.md and the stores/components of the project
---
read: CODEMAP.md first (file map per feature), then the project CLAUDE.md for detail
use: build `npm run build`; test `npx ng test --no-watch`; dev `npm start` (port 4200)
note: commit locally only (own .git here); agents never push. The user pushes and deploys with the Push & deploy button of the Games program (origin Crazy-Fisch/virtual-tavern main -> GitHub Actions deploy.yml -> Pages); push uses the system git credential helper (VIRTUALTAVERN_GITHUB_TOKEN stays unset, GITHUB_TOKEN cannot push); after a push the user runs `git pull origin main` in the X: copy; never touch X:\CodeProjects
note: Angular 22 zoneless/signals; bracket access on index signatures; card imgs need crossorigin="anonymous"
note: no python in this shell, use node for scripted edits; a bash heredoc with a lone apostrophe in text can break, use the Write tool for big files
note: the Supabase decks table needs migration-2026-10-16-decks-update.sql applied remotely for account deck edits/renames (guests use localStorage)
