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
