// Lists the decklists shipped with the app (defaultdecks.md).
//
// Static hosting has no directory listing, so the browser cannot discover what
// is in `public/decks/`. This writes the index it reads instead — run from the
// `pre*` npm hooks, so dropping a new `.txt` in that folder and starting or
// building the app is all it takes for the deck to reach every user.
//
// The file is committed as well as generated, so a build that bypasses the npm
// scripts (a bare `ng build`) still ships the decks that were there.

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const decksDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'decks');
const manifestPath = join(decksDir, 'index.json');

let files;
try {
  files = readdirSync(decksDir)
    .filter((name) => name.toLowerCase().endsWith('.txt'))
    .sort();
} catch {
  console.warn('[decks] public/decks does not exist — no default decks will ship.');
  process.exit(0);
}

const next = JSON.stringify(files, null, 2) + '\n';

let current = '';
try {
  current = readFileSync(manifestPath, 'utf8');
} catch {
  // no manifest yet
}

// Only write on a real change, so an unchanged manifest keeps its timestamp
// (and stays out of `git status`).
if (current === next) {
  console.log(`[decks] ${files.length} default deck(s), manifest unchanged.`);
} else {
  writeFileSync(manifestPath, next);
  console.log(`[decks] wrote manifest with ${files.length} default deck(s).`);
}
