/** One decklist line: a card name and how many copies of it. */
export type DeckEntry = { card: string; count: number };

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
