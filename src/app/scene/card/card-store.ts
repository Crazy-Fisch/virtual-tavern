import { Injectable, computed, inject, signal } from '@angular/core';
import { RoomService } from '../../room/room.service';
import { WorldObjectData } from '../../room/room.types';
import { Seat, layoutCombat, seatOfUid } from './attack-zone';
import { CARD_PREFIX, CardCombat, CardState } from './card.types';

/** Defensive parse of a card world object's JSON payload. */
function toCard(id: string, data: WorldObjectData): CardState {
  const pos = Array.isArray(data['position']) ? (data['position'] as unknown[]) : [];
  // The second face is only carried by double-faced cards, so the keys are only
  // set when there is one — an ordinary card round-trips exactly as before.
  const backSrc = typeof data['backSrc'] === 'string' && data['backSrc'] ? data['backSrc'] : null;
  return {
    id,
    name: typeof data['name'] === 'string' ? data['name'] : 'a card',
    src: typeof data['src'] === 'string' ? data['src'] : '',
    ...(backSrc ? { backSrc, flipped: data['flipped'] === true } : {}),
    position: [Number(pos[0]) || 0, Number(pos[1]) || 0, Number(pos[2]) || 0],
    yaw: typeof data['yaw'] === 'number' ? data['yaw'] : 0,
    faceUp: data['faceUp'] !== false,
    tapped: data['tapped'] === true,
    relatedNames: Array.isArray(data['relatedNames'])
      ? (data['relatedNames'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
    ownerUid: typeof data['ownerUid'] === 'string' ? data['ownerUid'] : '',
    ...toCombat(data['combat']),
  };
}

/** Defensive parse of the optional combat role; anything unreadable means no combat. */
function toCombat(value: unknown): { combat?: CardCombat } {
  if (typeof value !== 'object' || value === null) return {};
  const { role, target } = value as Record<string, unknown>;
  if (role === 'attack') return { combat: { role } };
  if (role === 'block' && typeof target === 'string' && target) return { combat: { role, target } };
  return {};
}

function toData(card: CardState): WorldObjectData {
  const { id: _, combat, ...data } = card;
  return combat ? { ...data, combat } : data;
}

/** "A", "A and B", "A, B and C", "A, B, C and 2 more" — for history lines. */
function nameList(cards: readonly CardState[]): string {
  const names = cards.map((c) => c.name);
  if (names.length <= 3)
    return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
  return `${names.slice(0, 3).join(', ')} and ${names.length - 3} more`;
}

/**
 * The cards on the table, projected from the room's shared world state
 * (world objects with a `card:` id) so every player sees the same cards and a
 * late joiner starts from the persisted snapshot. Writes go through
 * RoomService (optimistic, last-writer-wins). Dragging stays local via
 * `preview()` until the drop commits — remote players see the placement, not
 * every intermediate cursor position. A card mid-play from the hand is more
 * private still: `addLocal()` keeps it entirely on this client until the drop
 * lands (`update()` promotes it), so other players never see a card that was
 * merely considered. Provided BY the Scene component.
 */
@Injectable()
export class CardStore {
  private readonly room = inject(RoomService);

  /** Local-only overrides (drag pose) layered over the shared state. */
  private readonly previews = signal<Record<string, Partial<CardState>>>({});
  /** Cards that exist only on this client (a hand card mid-drag). */
  private readonly locals = signal<Record<string, CardState>>({});

  readonly cards = computed<CardState[]>(() => {
    const previews = this.previews();
    const world = this.room.worldState();
    const shared = Object.entries(world)
      .filter(([id]) => id.startsWith(CARD_PREFIX))
      .map(([id, state]) => toCard(id, state.data));
    // A local card shadowed by the shared world (its own promotion) is dropped.
    const locals = Object.values(this.locals()).filter((c) => !(c.id in world));
    return [...shared, ...locals].map((card) => {
      const preview = previews[card.id];
      return preview ? { ...card, ...preview } : card;
    });
  });

  /** Snapshot lookup; reactive when called inside a computed/effect. */
  card(id: string): CardState | undefined {
    return this.cards().find((c) => c.id === id);
  }

  add(card: CardState): void {
    this.room.setWorldObject(card.id, toData(card));
  }

  /** Add several cards in one shared write — duplicating a whole selection. */
  addMany(cards: readonly CardState[]): void {
    if (cards.length === 0) return;
    this.room.setWorldObjects(cards.map((card) => [card.id, toData(card)] as const));
  }

  /**
   * Add a card only this client sees — a card leaving the hand under the
   * cursor. Nothing reaches the network until `update()` commits it (the drop
   * landing), so a player can pick a card up, think better of it, and put it
   * back without the other players ever seeing what it was
   * (stabilityandimprovements.md "game stability").
   */
  addLocal(card: CardState): void {
    this.locals.update((l) => ({ ...l, [card.id]: card }));
  }

  /** Commit a change to the shared state (clears any local preview; promotes
   * a local-only card into the shared world). */
  update(id: string, patch: Partial<Omit<CardState, 'id'>>): void {
    this.updateMany([[id, patch]]);
  }

  /** Commit several cards in one shared write — a group drop lands atomically. */
  updateMany(entries: ReadonlyArray<readonly [string, Partial<Omit<CardState, 'id'>>]>): void {
    const writes: [string, WorldObjectData][] = [];
    for (const [id, patch] of entries) {
      const card = this.card(id);
      if (!card) continue;
      this.clearPreview(id);
      this.locals.update(({ [id]: _, ...rest }) => rest);
      writes.push([id, toData({ ...card, ...patch })]);
    }
    if (writes.length) this.room.setWorldObjects(writes);
  }

  /** Local-only override while dragging; update() commits it, clearPreview() discards it. */
  preview(id: string, patch: Partial<Omit<CardState, 'id'>>): void {
    this.previews.update((p) => ({ ...p, [id]: { ...p[id], ...patch } }));
  }

  clearPreview(id: string): void {
    this.previews.update(({ [id]: _, ...rest }) => rest);
  }

  /**
   * Delete the card from the shared state. A card that never left this client
   * (addLocal, e.g. a reverted hand play) is simply discarded — the network
   * never saw it.
   */
  remove(id: string): void {
    this.clearPreview(id);
    if (id in this.locals()) {
      this.locals.update(({ [id]: _, ...rest }) => rest);
      if (!(id in this.room.worldState())) return;
    }
    this.room.removeWorldObject(id);
  }

  /** True while any card is attacking (the attack zone glows). */
  readonly hasCombat = computed(() => this.cards().some((c) => c.combat?.role === 'attack'));

  /** Send cards into the attack zone: they line up on their owner's side. One write, one history line. */
  setAttacking(ids: readonly string[]): void {
    const cards = this.existing(ids);
    if (cards.length === 0) return;
    this.commitCombat(new Map(cards.map((c) => [c.id, { role: 'attack' } as CardCombat])));
    this.room.sendAction(`attacks with ${nameList(cards)}`);
  }

  /** Block an attacker: the cards stand opposite it. Attackers cannot block, and only an attacking target counts. */
  setBlocking(ids: readonly string[], attackerId: string): void {
    const attacker = this.card(attackerId);
    if (attacker?.combat?.role !== 'attack') return;
    const cards = this.existing(ids).filter(
      (c) => c.id !== attackerId && c.combat?.role !== 'attack',
    );
    if (cards.length === 0) return;
    this.commitCombat(
      new Map(cards.map((c) => [c.id, { role: 'block', target: attackerId } as CardCombat])),
    );
    this.room.sendAction(`blocks ${attacker.name} with ${nameList(cards)}`);
  }

  /** Take cards out of combat where they stand; the blockers of a cleared attacker go with it. */
  clearCombat(ids: readonly string[]): void {
    const cards = this.existing(ids).filter((c) => c.combat);
    if (cards.length === 0) return;
    const leaving = new Set(cards.map((c) => c.id));
    const roles = new Map<string, CardCombat | undefined>(cards.map((c) => [c.id, undefined]));
    for (const c of this.cards()) {
      if (c.combat?.role === 'block' && leaving.has(c.combat.target)) roles.set(c.id, undefined);
    }
    this.commitCombat(roles);
    this.room.sendAction(`takes ${nameList(cards)} out of combat`);
  }

  private existing(ids: readonly string[]): CardState[] {
    return [...new Set(ids)].flatMap((id) => this.card(id) ?? []);
  }

  private seatOf(card: CardState): Seat {
    const room = this.room.currentRoom();
    const ctx = {
      me: this.room.userId(),
      meIsOwner: this.room.isRoomOwner(),
      ownerId: room?.ownerId,
    };
    if (card.ownerUid) return seatOfUid(card.ownerUid, ctx);
    return card.position[2] >= 0 ? 1 : -1;
  }

  /**
   * Apply role changes (undefined = leave combat) and write the recomputed layout
   * of every card still in combat, plus the changed roles, as ONE batch.
   */
  private commitCombat(roles: ReadonlyMap<string, CardCombat | undefined>): void {
    const next = this.cards().map((card) =>
      roles.has(card.id) ? withCombat(card, roles.get(card.id)) : card,
    );
    const { placements, released } = layoutCombat(next, (card) => this.seatOf(card));
    const patches = new Map<string, Partial<Omit<CardState, 'id'>>>();
    for (const [id, combat] of roles) patches.set(id, { combat });
    for (const id of released) patches.set(id, { combat: undefined });
    for (const [id, pose] of placements) {
      const card = next.find((c) => c.id === id);
      patches.set(id, { ...patches.get(id), combat: card?.combat, ...pose });
    }
    this.updateMany([...patches]);
  }
}

function withCombat(card: CardState, combat: CardCombat | undefined): CardState {
  const { combat: _, ...rest } = card;
  return combat ? { ...rest, combat } : rest;
}
