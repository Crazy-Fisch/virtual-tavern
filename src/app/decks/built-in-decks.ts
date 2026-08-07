import { Injectable, signal } from '@angular/core';
import { Deck, builtInDeckId } from './deck.types';
import { parseDecklist } from './decklist-parser';

/** Where the shipped decklists live, relative to the app's base href. */
const DECKS_DIR = 'decks/';
const MANIFEST_URL = DECKS_DIR + 'index.json';

/**
 * Turn a filename into a deck name: `black_demons.txt` → "Black Demons". The
 * filename is the only name a plain `.txt` carries, so this is the whole
 * naming rule — rename the file to rename the deck.
 */
export function deckNameFromFile(file: string): string {
  return (
    file
      .replace(/\.txt$/i, '')
      .replace(/[_-]+/g, ' ')
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase()) || 'Default deck'
  );
}

/**
 * The decklists that ship with the app (`designdocs/defaultdecks.md`): the
 * `.txt` files under `public/decks/`, added to every user's deck list — guest
 * or account — without ever being copied into their storage.
 *
 * Static hosting has no directory listing, so the folder is enumerated at build
 * time into `public/decks/index.json` by `scripts/generate-deck-manifest.mjs`
 * (wired to the `pre*` npm scripts). This service fetches that index and each
 * listed file, parses them with the same `parseDecklist` a pasted import uses,
 * and hands `DeckStore` the result to merge in. Because they are read fresh on
 * every load rather than copied into a user's storage, a decklist added later
 * shows up for existing users too — which is the point of the design doc.
 *
 * Everything here fails soft, in the same spirit as the missing-GLB fallback:
 * no manifest, a missing file or an unparseable list costs that deck and
 * nothing else.
 */
@Injectable({ providedIn: 'root' })
export class BuiltInDecks {
  private readonly _decks = signal<Deck[]>([]);
  /** The shipped decks, in manifest order; empty until they have loaded. */
  readonly decks = this._decks.asReadonly();

  private readonly _loaded = signal(false);
  /** True once the load has finished, however it went (nothing waits on it). */
  readonly loaded = this._loaded.asReadonly();

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      const files = await this.fetchManifest();
      const decks = await Promise.all(files.map((file) => this.fetchDeck(file)));
      this._decks.set(decks.filter((deck): deck is Deck => deck !== null));
    } catch (err) {
      console.warn('[decks] Default decks unavailable.', err);
    } finally {
      this._loaded.set(true);
    }
  }

  private async fetchManifest(): Promise<string[]> {
    const response = await fetch(MANIFEST_URL);
    if (!response.ok) throw new Error(`${MANIFEST_URL}: ${response.status}`);
    const parsed: unknown = await response.json();
    return Array.isArray(parsed) ? parsed.filter((f): f is string => typeof f === 'string') : [];
  }

  /** One decklist file, or null if it is missing or holds no cards. */
  private async fetchDeck(file: string): Promise<Deck | null> {
    try {
      const response = await fetch(DECKS_DIR + encodeURIComponent(file));
      if (!response.ok) throw new Error(`${file}: ${response.status}`);
      const list = parseDecklist(await response.text());
      if (list.length === 0) return null;
      return { id: builtInDeckId(file), name: deckNameFromFile(file), list };
    } catch (err) {
      console.warn(`[decks] Default deck ${file} could not be loaded.`, err);
      return null;
    }
  }
}
