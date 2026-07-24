import { Injectable, computed, inject } from '@angular/core';
import { RoomService } from '../room/room.service';
import { CardState } from '../scene/card/card.types';
import { PlayerZones, ZONE_KINDS, ZONE_PREFIX, ZoneCard, ZoneKind, zoneId } from './zone.types';

function parseCards(value: unknown): ZoneCard[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const card = entry as Partial<ZoneCard> | null;
    return card && typeof card.id === 'string' && typeof card.src === 'string'
      ? [{ id: card.id, name: typeof card.name === 'string' ? card.name : 'a card', src: card.src }]
      : [];
  });
}

function emptyZones(uid: string, name: string): PlayerZones {
  return { uid, name, hand: [], deck: [], graveyard: [] };
}

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
    const players = new Map<string, PlayerZones>();
    for (const [id, state] of Object.entries(this.room.worldState())) {
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

  /**
   * Sit down at the table: create my zones with the chosen deck (shuffled),
   * hand and graveyard empty. Re-loading a deck replaces my zones — a fresh
   * game for me, other players' zones untouched.
   */
  loadDeck(cards: ZoneCard[]): void {
    if (!this.room.userId()) return;
    this.write('hand', []);
    this.write('graveyard', []);
    this.write('deck', shuffled(cards));
    this.room.sendAction(`joined the game with a ${cards.length}-card deck`);
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

  /** Move the top card of my deck into my hand. */
  draw(): void {
    const { deck, hand } = this.mine();
    const top = deck[0];
    if (!top) return;
    this.write('deck', deck.slice(1));
    this.write('hand', [...hand, top]);
    this.room.sendAction('drew a card');
  }

  shuffle(): void {
    const deck = this.mine().deck;
    if (deck.length === 0) return;
    this.write('deck', shuffled(deck));
    this.room.sendAction('shuffled their deck');
  }

  /** Move a card from the table into one of my zones (deck = on top). */
  takeFromTable(card: CardState, kind: ZoneKind): void {
    this.room.removeWorldObject(card.id);
    this.addCard(kind, { id: crypto.randomUUID(), name: card.name, src: card.src });
    this.room.sendAction(
      kind === 'hand'
        ? `returned ${card.name} to their hand`
        : kind === 'deck'
          ? `put ${card.name} on top of their deck`
          : `put ${card.name} into their graveyard`,
    );
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

  /** Retrieve a card from one of my zones back into my hand (graveyard examine). */
  takeToHand(kind: Exclude<ZoneKind, 'hand'>, zoneCardId: string): void {
    const zone = this.mine()[kind];
    const card = zone.find((c) => c.id === zoneCardId);
    if (!card) return;
    this.write(
      kind,
      zone.filter((c) => c.id !== zoneCardId),
    );
    this.write('hand', [...this.mine().hand, card]);
    this.room.sendAction(`returned ${card.name} to their hand`);
  }

  private write(kind: ZoneKind, cards: ZoneCard[]): void {
    const uid = this.room.userId();
    if (!uid) return;
    this.room.setWorldObject(zoneId(uid, kind), {
      ownerName: this.room.displayName(),
      cards,
    });
  }
}
