/**
 * A chosen printing of a card. A decklist import records only `set` (+
 * `collector`); the print service later fills `id`/`src`/`back` from the card
 * API. A print with a `src` wins over the card database's default art
 * everywhere the card renders.
 */
export type DeckPrint = {
  /** Lowercase set code, e.g. `m10`. */
  set: string;
  collector?: string;
  /** Scryfall card id. */
  id?: string;
  /** Front-face image URL; absent while the print is not resolved yet. */
  src?: string;
  /** Second face of a double-faced print. */
  back?: string;
};

/** One decklist line: a card name, how many copies of it, and an optional chosen print. */
export type DeckEntry = { card: string; count: number; print?: DeckPrint };

/** Identity of an entry's print, so copies with different art stay separate lines. */
export function printKey(print: DeckPrint | undefined): string {
  return print ? `${print.set}/${print.collector ?? ''}/${print.id ?? ''}` : '';
}

/** Image to show for an entry: its chosen print, else the database's default art. */
export function entrySrc(entry: DeckEntry, fallback?: string): string {
  return entry.print?.src || fallback || '';
}

/**
 * A player-built deck (the design doc's "basic json file with a name and a
 * decklist"). Phase 1 is import-only: decks are created by parsing a pasted
 * decklist and can be deleted, not edited. Stored locally by DeckStore —
 * decks are personal, not room state.
 */
export type Deck = {
  id: string;
  name: string;
  list: DeckEntry[];
};

/** Total number of cards in a deck (sum of the entry counts). */
export function deckSize(deck: Deck): number {
  return deck.list.reduce((total, entry) => total + entry.count, 0);
}

/**
 * Id prefix of a deck that ships with the app rather than belonging to the
 * player (`defaultdecks.md` — the `.txt` files under `public/decks/`). They are
 * merged into everyone's deck list by `DeckStore` but are read-only: they live
 * in the build, not in localStorage or the `decks` table, so there is nothing
 * to rename or delete.
 */
export const BUILTIN_DECK_PREFIX = 'builtin:';

export function builtInDeckId(file: string): string {
  return BUILTIN_DECK_PREFIX + file;
}

export function isBuiltInDeck(id: string): boolean {
  return id.startsWith(BUILTIN_DECK_PREFIX);
}
