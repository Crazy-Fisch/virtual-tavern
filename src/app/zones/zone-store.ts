import { Injectable, computed, effect, inject, untracked } from '@angular/core';
import { RoomService } from '../room/room.service';
import { CARD_PREFIX, CardState } from '../scene/card/card.types';
import { ITEM_PREFIX } from '../scene/item/item.types';
import {
  LIFE_PREFIX,
  PlayerZones,
  ROUND_ID,
  ZONE_KINDS,
  ZONE_PREFIX,
  ZoneCard,
  ZoneKind,
  lifeId,
  zoneId,
} from './zone.types';

function parseCards(value: unknown): ZoneCard[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const card = entry as Partial<ZoneCard> | null;
    if (!card || typeof card.id !== 'string' || typeof card.src !== 'string') return [];
    // `revealed` is only stored when true, so a plain card carries no such key
    // and round-trips unchanged (keeps existing specs' toEqual happy).
    const base: ZoneCard = {
      id: card.id,
      name: typeof card.name === 'string' ? card.name : 'a card',
      src: card.src,
    };
    return [card.revealed === true ? { ...base, revealed: true } : base];
  });
}

const ROUND_DECK_KEY = 'virtual-tavern.round-deck';

function emptyZones(uid: string, name: string): PlayerZones {
  return { uid, name, hand: [], deck: [], graveyard: [], exile: [], life: null, poison: 0 };
}

/** History line for a card leaving the table for each zone. */
const TAKE_ACTIONS: Readonly<Record<ZoneKind, (name: string) => string>> = {
  hand: (name) => `returned ${name} to their hand`,
  deck: (name) => `put ${name} on top of their deck`,
  graveyard: (name) => `put ${name} into their graveyard`,
  exile: (name) => `exiled ${name}`,
};

/** Fisher–Yates copy. */
function shuffled(cards: ZoneCard[]): ZoneCard[] {
  const deck = [...cards];
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  return deck;
}

/**
 * Player zones (hand / deck / graveyard), projected from the room's shared
 * world state (`zone:<uid>:<kind>` objects, data `{ ownerName, cards }`).
 * Contents travel over the network so everyone knows zone sizes and can
 * examine graveyards; the UI keeps hands and decks closed. Every mutation is
 * whole-zone last-writer-wins and posts an action-history line.
 */
@Injectable({ providedIn: 'root' })
export class ZoneStore {
  private readonly room = inject(RoomService);

  /** Every player with zones in this room (including me). */
  readonly all = computed<PlayerZones[]>(() => {
    const world = this.room.worldState();
    const players = new Map<string, PlayerZones>();
    for (const [id, state] of Object.entries(world)) {
      if (!id.startsWith(ZONE_PREFIX)) continue;
      const rest = id.slice(ZONE_PREFIX.length);
      const sep = rest.lastIndexOf(':');
      const uid = rest.slice(0, sep);
      const kind = rest.slice(sep + 1) as ZoneKind;
      if (!uid || !ZONE_KINDS.includes(kind)) continue;
      const zones = players.get(uid) ?? emptyZones(uid, 'guest');
      const ownerName = state.data['ownerName'];
      if (typeof ownerName === 'string' && ownerName) zones.name = ownerName;
      zones[kind] = parseCards(state.data['cards']);
      players.set(uid, zones);
    }
    // Second pass: attach life totals to players who already have zones (life is
    // only ever written once someone has joined, so a life-only ghost never appears).
    for (const [id, state] of Object.entries(world)) {
      if (!id.startsWith(LIFE_PREFIX)) continue;
      const zones = players.get(id.slice(LIFE_PREFIX.length));
      const life = state.data['life'];
      if (zones && typeof life === 'number') zones.life = life;
      const poison = state.data['poison'];
      if (zones && typeof poison === 'number') zones.poison = poison;
    }
    return [...players.values()];
  });

  readonly mine = computed<PlayerZones>(() => {
    const uid = this.room.userId();
    return this.all().find((p) => p.uid === uid) ?? emptyZones(uid ?? '', this.room.displayName());
  });

  readonly others = computed<PlayerZones[]>(() =>
    this.all().filter((p) => p.uid !== this.room.userId()),
  );

  /**
   * Whether I have zones in this room yet — i.e. joined the game by loading
   * a deck. Until then the zone UI stays hidden (the room's "choose deck"
   * gate); zones are created by loadDeck, never implicitly.
   */
  readonly hasMine = computed<boolean>(() => this.all().some((p) => p.uid === this.room.userId()));

  /** The room's current round number (0 until someone starts a new round). */
  readonly round = computed<number>(() => {
    const n = this.room.worldState()[ROUND_ID]?.data['n'];
    return typeof n === 'number' ? n : 0;
  });

  /** Room and round last reacted to, so entering a room never replays its old round marker. */
  private seenRound: { roomId: string; n: number } | null = null;

  constructor() {
    effect(() => {
      const room = this.room.currentRoom();
      const n = this.round();
      if (!room) {
        this.seenRound = null;
        return;
      }
      if (this.seenRound?.roomId !== room.id) {
        this.seenRound = { roomId: room.id, n };
        return;
      }
      if (n > this.seenRound.n) {
        this.seenRound = { roomId: room.id, n };
        untracked(() => this.resetForRound());
      }
    });
  }

  /**
   * Sit down at the table: create my zones with the chosen deck (shuffled),
   * hand and graveyard empty. Re-loading a deck replaces my zones — a fresh
   * game for me, other players' zones untouched.
   */
  loadDeck(cards: ZoneCard[]): void {
    if (!this.room.userId()) return;
    this.rememberDeck(cards);
    this.writeZones([
      ['hand', []],
      ['graveyard', []],
      ['exile', []],
      ['deck', shuffled(cards)],
    ]);
    this.room.sendAction(`joined the game with a ${cards.length}-card deck`);
  }

  /**
   * Start a new round in this room (any player may; the UI confirms first):
   * the table's cards and items are cleared for everyone and the round marker
   * is bumped, which makes every client — this one included — reset its own
   * zones and life from the deck it chose (`resetForRound`). Room, players
   * and decks stay.
   */
  startNewRound(): void {
    const uid = this.room.userId();
    if (!uid) return;
    const table = Object.keys(this.room.worldState()).filter(
      (id) => id.startsWith(CARD_PREFIX) || id.startsWith(ITEM_PREFIX),
    );
    this.room.removeWorldObjects(table);
    this.room.setWorldObject(ROUND_ID, { n: this.round() + 1, startedBy: uid });
    this.room.sendAction('New round started');
  }

  /**
   * Reset MY side for a new round: a freshly shuffled copy of my chosen deck, empty
   * hand/graveyard/exile, life back to my starting total. Silent (the starter logs
   * once). Without a remembered deck (storage cleared) my zones are removed instead,
   * which sends me back to the deck picker.
   */
  private resetForRound(): void {
    const uid = this.room.userId();
    if (!uid || !this.hasMine()) return;
    const deck = this.recallDeck();
    if (deck) {
      this.writeZones([
        ['hand', []],
        ['graveyard', []],
        ['exile', []],
        ['deck', shuffled(deck.map((c) => ({ ...c, id: crypto.randomUUID() })))],
      ]);
      const start = this.room.worldState()[lifeId(uid)]?.data['start'];
      if (typeof start === 'number')
        this.room.setWorldObject(lifeId(uid), { life: start, start, poison: 0 });
    } else {
      this.room.removeWorldObjects([...ZONE_KINDS.map((k) => zoneId(uid, k)), lifeId(uid)]);
    }
  }

  private deckKey(): string | null {
    const roomId = this.room.currentRoom()?.id;
    const uid = this.room.userId();
    return roomId && uid ? `${ROUND_DECK_KEY}:${roomId}:${uid}` : null;
  }

  private rememberDeck(cards: ZoneCard[]): void {
    const key = this.deckKey();
    if (!key) return;
    try {
      localStorage.setItem(key, JSON.stringify(cards.map(({ name, src }) => ({ name, src }))));
    } catch {
      // storage full or unavailable: a new round then falls back to the deck picker
    }
  }

  private recallDeck(): ZoneCard[] | null {
    const key = this.deckKey();
    if (!key) return null;
    try {
      const raw = JSON.parse(localStorage.getItem(key) ?? 'null') as unknown;
      if (!Array.isArray(raw) || raw.length === 0) return null;
      return raw.map((c: { name?: string; src?: string }) => ({
        id: '',
        name: typeof c.name === 'string' ? c.name : 'a card',
        src: typeof c.src === 'string' ? c.src : '',
      }));
    } catch {
      return null;
    }
  }

  /** Keep my ownerName fresh on rejoin. Touches only zones that already exist. */
  refreshOwnerName(): void {
    const uid = this.room.userId();
    if (!uid) return;
    const world = this.room.worldState();
    const name = this.room.displayName();
    for (const kind of ZONE_KINDS) {
      const existing = world[zoneId(uid, kind)];
      if (existing && existing.data['ownerName'] !== name)
        this.write(kind, parseCards(existing.data['cards']));
    }
  }

  /** Move the top card of my deck into my hand — one atomic write, so a lost
   * request can never leave the card in neither zone (stabilityandimprovements.md). */
  draw(): void {
    const { deck, hand } = this.mine();
    const top = deck[0];
    if (!top) return;
    this.writeZones([
      ['deck', deck.slice(1)],
      ['hand', [...hand, top]],
    ]);
    this.room.sendAction('drew a card');
  }

  shuffle(): void {
    const deck = this.mine().deck;
    if (deck.length === 0) return;
    this.write('deck', shuffled(deck));
    this.room.sendAction('shuffled their deck');
  }

  /**
   * Look at the top `count` cards of my deck (newmechanics.md "scrying"):
   * nothing moves, so this is only the peek — the reveal panel writes back
   * through `applyReveal` as the player deals with each card. The history
   * records that a look happened, never what was seen.
   */
  revealTop(count: number): ZoneCard[] {
    const deck = this.mine().deck;
    const cards = deck.slice(0, Math.max(0, Math.min(Math.floor(count), deck.length)));
    if (cards.length === 0) return [];
    this.room.sendAction(
      `looked at the top ${cards.length === 1 ? 'card' : `${cards.length} cards`} of their deck`,
    );
    return cards;
  }

  /**
   * Look through my whole deck (finaltouches.md "searching deck" — a tutor).
   * Like `revealTop` this only peeks; the search panel writes back through
   * `applyReveal` as cards are taken out. Everyone is told a search happened,
   * since in a real game that is public even though the cards are not.
   */
  searchDeck(): ZoneCard[] {
    const deck = this.mine().deck;
    if (deck.length === 0) return [];
    this.room.sendAction('searched their deck');
    return deck;
  }

  /**
   * Commit one step of a reveal: the three zones it can touch, written in ONE
   * batch so a card can never be in two zones (or none) even if the request is
   * lost. Undo goes through here too — it is just an earlier set of zones.
   */
  applyReveal(
    zones: { deck: ZoneCard[]; hand: ZoneCard[]; graveyard: ZoneCard[] },
    action: string,
  ): void {
    this.writeZones([
      ['deck', zones.deck],
      ['hand', zones.hand],
      ['graveyard', zones.graveyard],
    ]);
    this.room.sendAction(action);
  }

  /** Move a card from the table into one of my zones (deck = on top). */
  takeFromTable(card: CardState, kind: ZoneKind): void {
    // A hand card dropped onto a zone widget mid-drag is still local-only —
    // there is no shared object to delete (see CardStore.addLocal).
    const onTable = !!this.room.worldState()[card.id];
    if (onTable) this.room.removeWorldObject(card.id);
    this.addCard(kind, { id: crypto.randomUUID(), name: card.name, src: card.src });
    // A local-only card dropped back on the hand never left it: no history line.
    if (kind === 'hand' && !onTable) return;
    this.room.sendAction(TAKE_ACTIONS[kind](card.name));
  }

  /** Add a card to one of my zones (deck = on top). Used by the util window; logging is the caller's. */
  addCard(kind: ZoneKind, card: ZoneCard): void {
    const zone = this.mine()[kind];
    this.write(kind, kind === 'deck' ? [card, ...zone] : [...zone, card]);
  }

  /**
   * Take a card out of my hand to play it onto the table. Returns the removed
   * card (the caller spawns it as a table card), or null if it is gone —
   * e.g. already played in another tab. Logging is the caller's: the "played"
   * history line belongs to the drop landing, not the pick-up (a drag released
   * off the table reverts via addCard and must leave no trace).
   */
  playFromHand(zoneCardId: string): ZoneCard | null {
    const { hand } = this.mine();
    const card = hand.find((c) => c.id === zoneCardId);
    if (!card) return null;
    this.write(
      'hand',
      hand.filter((c) => c.id !== zoneCardId),
    );
    return card;
  }

  /**
   * Remove a card from one of my zones and return it, without logging — the
   * silent pick-up for dragging a card out of a zone (the drop landing decides
   * what history line, if any, to post). Returns null if the card is gone.
   */
  removeFromZone(kind: ZoneKind, zoneCardId: string): ZoneCard | null {
    const zone = this.mine()[kind];
    const card = zone.find((c) => c.id === zoneCardId);
    if (!card) return null;
    this.write(
      kind,
      zone.filter((c) => c.id !== zoneCardId),
    );
    return card;
  }

  /**
   * Set my life total. The first time (life was unset) logs the starting choice;
   * later adjustments are silent so the +/- buttons don't spam the history.
   */
  setLife(life: number): void {
    const uid = this.room.userId();
    if (!uid) return;
    const first = this.mine().life === null;
    const start = this.room.worldState()[lifeId(uid)]?.data['start'];
    this.room.setWorldObject(lifeId(uid), {
      life,
      start: typeof start === 'number' ? start : life,
      poison: this.mine().poison,
    });
    if (first) this.room.sendAction(`set their starting life to ${life}`);
  }

  /** Set my infect/poison counters (0 and up). Silent like life changes; needs a life total first. */
  setPoison(poison: number): void {
    const uid = this.room.userId();
    const { life } = this.mine();
    if (!uid || life === null) return;
    const start = this.room.worldState()[lifeId(uid)]?.data['start'];
    this.room.setWorldObject(lifeId(uid), {
      life,
      start: typeof start === 'number' ? start : life,
      poison: Math.max(0, Math.round(poison)),
    });
  }

  /**
   * Reveal or hide my whole hand to the other players at once — overriding any
   * per-card reveal state, as the toggle is meant to (playerui.md).
   */
  revealHand(revealed: boolean): void {
    const hand = this.mine().hand;
    if (hand.length === 0) return;
    this.write(
      'hand',
      hand.map((c) => ({ ...c, revealed })),
    );
    this.room.sendAction(revealed ? 'revealed their hand' : 'hid their hand');
  }

  /** Toggle whether one hand card's face is shown to the other players. */
  toggleReveal(zoneCardId: string): void {
    const hand = this.mine().hand;
    const card = hand.find((c) => c.id === zoneCardId);
    if (!card) return;
    const revealed = !card.revealed;
    this.write(
      'hand',
      hand.map((c) => (c.id === zoneCardId ? { ...c, revealed } : c)),
    );
    this.room.sendAction(revealed ? `revealed ${card.name}` : `hid ${card.name}`);
  }

  private write(kind: ZoneKind, cards: ZoneCard[]): void {
    this.writeZones([[kind, cards]]);
  }

  /** Write several of my zones in one shared batch (atomic on the server). */
  private writeZones(zones: ReadonlyArray<readonly [ZoneKind, ZoneCard[]]>): void {
    const uid = this.room.userId();
    if (!uid) return;
    const name = this.room.displayName();
    this.room.setWorldObjects(
      zones.map(([kind, cards]) => [zoneId(uid, kind), { ownerName: name, cards }]),
    );
  }
}
