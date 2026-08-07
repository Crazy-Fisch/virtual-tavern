import {
  RevealSession,
  canUndo,
  currentState,
  isPending,
  matchesQuery,
  place,
  placedIn,
  revealAction,
  revealZones,
  startReveal,
  targetsFor,
  undo,
} from './reveal';
import { ZoneCard } from './zone.types';

const card = (id: string): ZoneCard => ({ id, name: id.toUpperCase(), src: `${id}.jpg` });

const DECK = [card('a'), card('b'), card('c'), card('d'), card('e')];

const ids = (cards: readonly ZoneCard[]): string[] => cards.map((c) => c.id);

/** Every card that exists anywhere, so nothing can quietly go missing. */
const everywhere = (session: RevealSession): string[] => {
  const { deck, hand, graveyard } = revealZones(session);
  return [...ids(deck), ...ids(hand), ...ids(graveyard)].sort();
};

describe('reveal (scry) session', () => {
  const start = (count = 3): RevealSession => startReveal(DECK, count, [card('h')], []);

  it('reveals the top cards in deck order and leaves every zone untouched', () => {
    const session = start();
    expect(ids(session.cards)).toEqual(['a', 'b', 'c']);
    expect(revealZones(session)).toEqual({
      deck: DECK,
      hand: [card('h')],
      graveyard: [],
    });
    expect(canUndo(session)).toBe(false);
  });

  it('reveals only what the deck has when asked for more', () => {
    expect(ids(startReveal(DECK, 99, [], []).cards)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(startReveal([], 3, [], []).cards).toEqual([]);
  });

  it('puts cards back on top as a stack — the last one placed is drawn first', () => {
    let session = start();
    session = place(session, 'a', 'deck');
    session = place(session, 'b', 'deck');
    session = place(session, 'c', 'deck');
    expect(ids(revealZones(session).deck)).toEqual(['c', 'b', 'a', 'd', 'e']);
    expect(ids(placedIn(session, 'deck'))).toEqual(['c', 'b', 'a']);
  });

  it('sends cards under the deck in placement order, the last one bottom-most', () => {
    let session = start();
    session = place(session, 'a', 'bottom');
    session = place(session, 'b', 'bottom');
    expect(ids(revealZones(session).deck)).toEqual(['c', 'd', 'e', 'a', 'b']);
  });

  it('routes cards to hand and graveyard, appending to what was already there', () => {
    let session = start();
    session = place(session, 'b', 'hand');
    session = place(session, 'a', 'graveyard');
    const zones = revealZones(session);
    expect(ids(zones.hand)).toEqual(['h', 'b']);
    expect(ids(zones.graveyard)).toEqual(['a']);
    expect(ids(zones.deck)).toEqual(['c', 'd', 'e']);
  });

  it('keeps undecided cards in the deck, so abandoning the reveal loses nothing', () => {
    let session = start();
    expect(everywhere(session)).toEqual(['a', 'b', 'c', 'd', 'e', 'h']);
    session = place(session, 'b', 'graveyard');
    // 'a' and 'c' were looked at but not placed — still sitting in the deck.
    expect(ids(revealZones(session).deck)).toEqual(['a', 'c', 'd', 'e']);
    expect(everywhere(session)).toEqual(['a', 'b', 'c', 'd', 'e', 'h']);
    session = place(session, 'c', 'deck');
    expect(everywhere(session)).toEqual(['a', 'b', 'c', 'd', 'e', 'h']);
  });

  it('a placed card leaves the grid and cannot be placed twice', () => {
    let session = start();
    expect(isPending(session, 'a')).toBe(true);
    session = place(session, 'a', 'hand');
    expect(isPending(session, 'a')).toBe(false);
    // A stale second drop is a no-op — the very same session comes back.
    expect(place(session, 'a', 'graveyard')).toBe(session);
    expect(currentState(session).pending.length).toBe(2);
  });

  it('undo walks back one step at a time, all the way to the start of the reveal', () => {
    let session = start();
    session = place(session, 'a', 'graveyard');
    session = place(session, 'b', 'hand');
    session = place(session, 'c', 'bottom');
    expect(canUndo(session)).toBe(true);

    // 'c' comes back off the bottom and is undecided again, i.e. back on top.
    session = undo(session);
    expect(ids(revealZones(session).deck)).toEqual(['c', 'd', 'e']);
    expect(isPending(session, 'c')).toBe(true);
    session = undo(session);
    session = undo(session);
    expect(canUndo(session)).toBe(false);
    expect(revealZones(session)).toEqual({ deck: DECK, hand: [card('h')], graveyard: [] });
    expect(undo(session)).toBe(session); // nothing left to undo
  });

  it('names the card only for the graveyard — the rest of a reveal is private', () => {
    expect(revealAction('hand', card('a'), 'reveal')).toBe(
      'put a card from the top of their deck into their hand',
    );
    expect(revealAction('deck', card('a'), 'reveal')).toBe(
      'put a revealed card back on top of their deck',
    );
    expect(revealAction('bottom', card('a'), 'reveal')).toBe(
      'put a revealed card on the bottom of their deck',
    );
    expect(revealAction('graveyard', card('a'), 'reveal')).toBe('put A into their graveyard');
    // A search says where the card came from, still without naming it.
    expect(revealAction('hand', card('a'), 'search')).toBe(
      'put a card from their deck into their hand',
    );
  });
});

describe('reveal session in search mode', () => {
  const HAND = [card('h')];
  /** A search starts with the whole deck revealed and nothing below it. */
  const start = (): RevealSession => startReveal(DECK, DECK.length, HAND, []);

  it('offers only hand and graveyard', () => {
    expect(targetsFor('search')).toEqual(['hand', 'graveyard']);
    expect(targetsFor('reveal')).toEqual(['hand', 'deck', 'bottom', 'graveyard']);
  });

  it('leaves the deck in its original order as cards are taken out of it', () => {
    let session = start();
    expect(ids(revealZones(session).deck)).toEqual(['a', 'b', 'c', 'd', 'e']);
    session = place(session, 'c', 'hand');
    session = place(session, 'a', 'graveyard');
    const zones = revealZones(session);
    // The untaken cards keep their relative order — a search must not reshuffle.
    expect(ids(zones.deck)).toEqual(['b', 'd', 'e']);
    expect(ids(zones.hand)).toEqual(['h', 'c']);
    expect(ids(zones.graveyard)).toEqual(['a']);
    expect(everywhere(session)).toEqual(['a', 'b', 'c', 'd', 'e', 'h']);
  });

  it('undo puts a tutored card back where it came from', () => {
    let session = start();
    session = place(session, 'c', 'hand');
    session = undo(session);
    expect(revealZones(session)).toEqual({ deck: DECK, hand: HAND, graveyard: [] });
  });

  it('filters by name, case-insensitively, and matches everything when blank', () => {
    const bolt: ZoneCard = { id: 'x', name: 'Lightning Bolt', src: 'x.jpg' };
    expect(matchesQuery(bolt, 'bolt')).toBe(true);
    expect(matchesQuery(bolt, 'LIGHT')).toBe(true);
    expect(matchesQuery(bolt, '  ')).toBe(true);
    expect(matchesQuery(bolt, 'forest')).toBe(false);
  });
});
