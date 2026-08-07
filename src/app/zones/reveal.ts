import { ZoneCard } from './zone.types';

/**
 * Looking at the top cards of your own deck and dealing with them one by one —
 * scry, surveil, "look at the top four" (newmechanics.md "scrying & other
 * actions"). Everything here is pure: the panel (`reveal-panel/`) holds a
 * session, applies moves to it, and writes the three zones the session derives
 * (`revealZones`) back through ZoneStore in one batch after every step.
 *
 * The invariant that makes this safe to abandon at any moment: **no card is
 * ever in limbo.** A card the player has not decided about is still sitting in
 * the deck exactly where it was, so closing the panel — or the tab — loses
 * nothing. A revealed card is only *moved* when it is dropped on a zone.
 */
export type RevealTarget = 'hand' | 'deck' | 'bottom' | 'graveyard';

export const REVEAL_TARGETS: readonly RevealTarget[] = ['hand', 'deck', 'bottom', 'graveyard'];

/**
 * The two things a panel can be: looking at the **top** of the deck (scry), or
 * looking **through** it for a card (a tutor — finaltouches.md "searching
 * deck"). Both are the same session over the same zones; a search just starts
 * with the whole deck revealed, offers fewer destinations, and filters by name.
 */
export type RevealMode = 'reveal' | 'search';

/** A search only offers the two zones the design doc names. */
export const SEARCH_TARGETS: readonly RevealTarget[] = ['hand', 'graveyard'];

export function targetsFor(mode: RevealMode): readonly RevealTarget[] {
  return mode === 'search' ? SEARCH_TARGETS : REVEAL_TARGETS;
}

/** Cards whose name contains the query (case-insensitive); blank shows all. */
export function matchesQuery(card: ZoneCard, query: string): boolean {
  const q = query.trim().toLowerCase();
  return q.length === 0 || card.name.toLowerCase().includes(q);
}

/** Button label for each drop zone under the revealed cards. */
export const REVEAL_TARGET_LABELS: Readonly<Record<RevealTarget, string>> = {
  hand: 'Hand',
  deck: 'Deck (top)',
  bottom: 'Bottom',
  graveyard: 'Graveyard',
};

/** Shortcut counts in the deck menu's Reveal row; any other number goes in "X". */
export const REVEAL_COUNTS: readonly number[] = [1, 2, 3, 4, 5];

/**
 * One step of a reveal, and one entry on the undo stack. Each list holds the
 * cards routed there so far; `pending` is what the player has not placed yet.
 */
export interface RevealState {
  /** Revealed cards still undecided, top of the deck first. */
  readonly pending: readonly ZoneCard[];
  /**
   * Cards put back on top. Index 0 ends up on top of the deck — i.e. the card
   * placed *last* is the one drawn first, exactly like a real stack.
   */
  readonly top: readonly ZoneCard[];
  /** Cards sent under the deck, in placement order (the last one is bottom-most). */
  readonly bottom: readonly ZoneCard[];
  /** Cards moved into hand / graveyard, in placement order. */
  readonly hand: readonly ZoneCard[];
  readonly graveyard: readonly ZoneCard[];
}

/**
 * A reveal in progress: what was looked at, the untouched parts of the zones it
 * can write to, and the undo stack. `history[0]` is the state the reveal
 * started in, so undoing repeatedly walks all the way back to it.
 */
export interface RevealSession {
  /** The revealed cards in deck order — the grid's layout, first to last. */
  readonly cards: readonly ZoneCard[];
  /** The rest of the deck, below the revealed window. */
  readonly rest: readonly ZoneCard[];
  /** Hand and graveyard as they were when the reveal started. */
  readonly baseHand: readonly ZoneCard[];
  readonly baseGraveyard: readonly ZoneCard[];
  /** Undo stack, oldest first; the last entry is the current state. */
  readonly history: readonly RevealState[];
}

/** Start a session over the top `cards` of `deck`. */
export function startReveal(
  deck: readonly ZoneCard[],
  count: number,
  hand: readonly ZoneCard[],
  graveyard: readonly ZoneCard[],
): RevealSession {
  const cards = deck.slice(0, Math.max(0, Math.min(count, deck.length)));
  return {
    cards,
    rest: deck.slice(cards.length),
    baseHand: hand,
    baseGraveyard: graveyard,
    history: [{ pending: cards, top: [], bottom: [], hand: [], graveyard: [] }],
  };
}

export function currentState(session: RevealSession): RevealState {
  return session.history[session.history.length - 1]!;
}

/** Whether a revealed card is still undecided — its grid slot empties once placed. */
export function isPending(session: RevealSession, cardId: string): boolean {
  return currentState(session).pending.some((c) => c.id === cardId);
}

export function canUndo(session: RevealSession): boolean {
  return session.history.length > 1;
}

/**
 * Route one revealed card to a zone, pushing the result onto the undo stack.
 * Returns the session unchanged if the card is not pending (a double drop).
 */
export function place(session: RevealSession, cardId: string, target: RevealTarget): RevealSession {
  const state = currentState(session);
  const card = state.pending.find((c) => c.id === cardId);
  if (!card) return session;
  const pending = state.pending.filter((c) => c.id !== cardId);
  const next: RevealState =
    target === 'deck'
      ? { ...state, pending, top: [card, ...state.top] } // last back on top = first off
      : target === 'bottom'
        ? { ...state, pending, bottom: [...state.bottom, card] }
        : target === 'hand'
          ? { ...state, pending, hand: [...state.hand, card] }
          : { ...state, pending, graveyard: [...state.graveyard, card] };
  return { ...session, history: [...session.history, next] };
}

/** Step back one placement; at the start of the reveal this is a no-op. */
export function undo(session: RevealSession): RevealSession {
  if (!canUndo(session)) return session;
  return { ...session, history: session.history.slice(0, -1) };
}

/** Cards routed to a zone in the current state — what the drop zone shows. */
export function placedIn(session: RevealSession, target: RevealTarget): readonly ZoneCard[] {
  const state = currentState(session);
  return target === 'deck' ? state.top : state[target];
}

/**
 * The three zones as they stand — written back in one batch after every step.
 * Cards still pending sit in the deck under whatever was put back on top, so
 * the deck always holds every card that has not been moved out of it.
 */
export function revealZones(session: RevealSession): {
  deck: ZoneCard[];
  hand: ZoneCard[];
  graveyard: ZoneCard[];
} {
  const state = currentState(session);
  return {
    deck: [...state.top, ...state.pending, ...session.rest, ...state.bottom],
    hand: [...session.baseHand, ...state.hand],
    graveyard: [...session.baseGraveyard, ...state.graveyard],
  };
}

/**
 * History line for a placement. Closed zones stay nameless — a look through
 * your own deck is private, and naming what went into your hand would give the
 * search away; the graveyard is an open zone anyone can examine, so that one
 * names the card.
 */
export function revealAction(target: RevealTarget, card: ZoneCard, mode: RevealMode): string {
  const from = mode === 'search' ? 'their deck' : 'the top of their deck';
  switch (target) {
    case 'hand':
      return `put a card from ${from} into their hand`;
    case 'deck':
      return 'put a revealed card back on top of their deck';
    case 'bottom':
      return 'put a revealed card on the bottom of their deck';
    case 'graveyard':
      return `put ${card.name} into their graveyard`;
  }
}
