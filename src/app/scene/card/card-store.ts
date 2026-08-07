import { Injectable, computed, inject, signal } from '@angular/core';
import { RoomService } from '../../room/room.service';
import { WorldObjectData } from '../../room/room.types';
import { CARD_PREFIX, CardState } from './card.types';

/** Defensive parse of a card world object's JSON payload. */
function toCard(id: string, data: WorldObjectData): CardState {
  const pos = Array.isArray(data['position']) ? (data['position'] as unknown[]) : [];
  return {
    id,
    name: typeof data['name'] === 'string' ? data['name'] : 'a card',
    src: typeof data['src'] === 'string' ? data['src'] : '',
    position: [Number(pos[0]) || 0, Number(pos[1]) || 0, Number(pos[2]) || 0],
    yaw: typeof data['yaw'] === 'number' ? data['yaw'] : 0,
    faceUp: data['faceUp'] !== false,
    tapped: data['tapped'] === true,
    relatedNames: Array.isArray(data['relatedNames'])
      ? (data['relatedNames'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
    ownerUid: typeof data['ownerUid'] === 'string' ? data['ownerUid'] : '',
  };
}

function toData(card: CardState): WorldObjectData {
  const { id: _, ...data } = card;
  return data;
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
}
