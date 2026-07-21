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
    relatedIds: Array.isArray(data['relatedIds'])
      ? (data['relatedIds'] as unknown[]).filter((x): x is string => typeof x === 'string')
      : [],
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
 * every intermediate cursor position. Provided BY the Scene component.
 */
@Injectable()
export class CardStore {
  private readonly room = inject(RoomService);

  /** Local-only overrides (drag pose) layered over the shared state. */
  private readonly previews = signal<Record<string, Partial<CardState>>>({});

  readonly cards = computed<CardState[]>(() => {
    const previews = this.previews();
    return Object.entries(this.room.worldState())
      .filter(([id]) => id.startsWith(CARD_PREFIX))
      .map(([id, state]) => {
        const card = toCard(id, state.data);
        const preview = previews[id];
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

  /** Commit a change to the shared state (clears any local preview). */
  update(id: string, patch: Partial<Omit<CardState, 'id'>>): void {
    const card = this.card(id);
    if (!card) return;
    this.clearPreview(id);
    this.room.setWorldObject(id, toData({ ...card, ...patch }));
  }

  /** Local-only override while dragging; update() commits it, clearPreview() discards it. */
  preview(id: string, patch: Partial<Omit<CardState, 'id'>>): void {
    this.previews.update((p) => ({ ...p, [id]: { ...p[id], ...patch } }));
  }

  clearPreview(id: string): void {
    this.previews.update(({ [id]: _, ...rest }) => rest);
  }

  /**
   * Delete the card from the shared state. Dangling relatedIds in other cards
   * are tolerated — lookups resolve them to undefined and filter them out.
   */
  remove(id: string): void {
    this.clearPreview(id);
    this.room.removeWorldObject(id);
  }
}
