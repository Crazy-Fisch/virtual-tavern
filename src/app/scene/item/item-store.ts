import { Injectable, computed, inject, signal } from '@angular/core';
import { Euler, Quaternion, Vector3 } from 'three';
import { RoomService } from '../../room/room.service';
import { WorldObjectData } from '../../room/room.types';
import { D6_FACE_NORMALS, D6_FACE_VALUES } from './item-geometry';
import { DIE_FACES, ITEM_PREFIX, ItemKind, ItemState, counterLabel, isDice } from './item.types';

const TAU = Math.PI * 2;
const QUARTER = Math.PI / 2;
const UP = new Vector3(0, 1, 0);

/** Random integer in [min, max]. */
function randInt(min: number, max: number): number {
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** Defensive parse of an item world object's JSON payload. */
function toItem(id: string, data: WorldObjectData): ItemState {
  const pos = Array.isArray(data['position']) ? (data['position'] as unknown[]) : [];
  const rot = Array.isArray(data['rotation']) ? (data['rotation'] as unknown[]) : [];
  return {
    id,
    kind: (typeof data['kind'] === 'string' ? data['kind'] : 'd6') as ItemKind,
    position: [Number(pos[0]) || 0, Number(pos[1]) || 0, Number(pos[2]) || 0],
    rotation: [Number(rot[0]) || 0, Number(rot[1]) || 0, Number(rot[2]) || 0],
    value: typeof data['value'] === 'number' ? data['value'] : 1,
    variant: data['variant'] === 'minus' ? 'minus' : 'plus',
    attachedTo: typeof data['attachedTo'] === 'string' ? data['attachedTo'] : null,
  };
}

function toData(item: ItemState): WorldObjectData {
  const { id: _, ...data } = item;
  return data;
}

/** Orientation an euler triple represents. */
function quaternionOf(rotation: readonly [number, number, number]): Quaternion {
  return new Quaternion().setFromEuler(new Euler(rotation[0], rotation[1], rotation[2]));
}

/**
 * Dice, coins and counters on the table, projected from the room's shared world
 * state (world objects with an `item:` id) exactly like CardStore does for
 * cards — so every player sees the same items and a late joiner starts from the
 * persisted snapshot. Rolls and flips are ordinary state writes: the item's new
 * (absolute, unwrapped) rotation lands in shared state and every client animates
 * its own mesh toward it, which is how the tumble stays in sync without
 * streaming frames.
 */
@Injectable({ providedIn: 'root' })
export class ItemStore {
  private readonly room = inject(RoomService);

  /** Local-only overrides (drag pose) layered over the shared state. */
  private readonly previews = signal<Record<string, Partial<ItemState>>>({});
  /** Items that exist only on this client (a fresh spawn still on the cursor). */
  private readonly locals = signal<Record<string, ItemState>>({});

  readonly items = computed<ItemState[]>(() => {
    const previews = this.previews();
    const world = this.room.worldState();
    const shared = Object.entries(world)
      .filter(([id]) => id.startsWith(ITEM_PREFIX))
      .map(([id, state]) => toItem(id, state.data));
    // A local item shadowed by the shared world (its own promotion) is dropped.
    const locals = Object.values(this.locals()).filter((i) => !(i.id in world));
    return [...shared, ...locals].map((item) => {
      const preview = previews[item.id];
      return preview ? { ...item, ...preview } : item;
    });
  });

  /** Snapshot lookup; reactive when called inside a computed/effect. */
  item(id: string): ItemState | undefined {
    return this.items().find((i) => i.id === id);
  }

  add(item: ItemState): void {
    this.room.setWorldObject(item.id, toData(item));
  }

  /**
   * Add an item only this client sees — a util-window spawn still following
   * the cursor (tableitems.md). Nothing reaches the network until `update()`
   * commits it (the placing click), so an item picked from the window and then
   * cancelled was never seen by the other players.
   */
  addLocal(item: ItemState): void {
    this.locals.update((l) => ({ ...l, [item.id]: item }));
  }

  /** Commit a change to the shared state (clears any local preview; promotes
   * a local-only item into the shared world). */
  update(id: string, patch: Partial<Omit<ItemState, 'id'>>): void {
    const item = this.item(id);
    if (!item) return;
    this.clearPreview(id);
    this.locals.update(({ [id]: _, ...rest }) => rest);
    this.room.setWorldObject(id, toData({ ...item, ...patch }));
  }

  /** Local-only override while dragging; update() commits it, clearPreview() discards it. */
  preview(id: string, patch: Partial<Omit<ItemState, 'id'>>): void {
    this.previews.update((p) => ({ ...p, [id]: { ...p[id], ...patch } }));
  }

  clearPreview(id: string): void {
    this.previews.update(({ [id]: _, ...rest }) => rest);
  }

  /** Delete the item; one that never left this client is simply discarded. */
  remove(id: string): void {
    this.clearPreview(id);
    if (id in this.locals()) {
      this.locals.update(({ [id]: _, ...rest }) => rest);
      if (!(id in this.room.worldState())) return;
    }
    this.room.removeWorldObject(id);
  }

  /** Counters riding on a card leave the table with it. */
  removeAttachedTo(cardId: string): void {
    for (const item of this.items()) if (item.attachedTo === cardId) this.remove(item.id);
  }

  /**
   * Roll a die: no physics, a tumble instead (per the design doc) — every euler
   * gains a random turn and each client lerps to it over 1.5 s.
   *
   * The d6's turns are whole quarters, so it always lands square on a face and
   * the pips that end up on top *are* the result. The polyhedra tumble freely
   * and carry their rolled number on the label above them, since a placeholder
   * icosahedron has nothing readable to land on.
   */
  roll(id: string): void {
    const item = this.item(id);
    if (!item || !isDice(item.kind)) return;
    const [x, y, z] = item.rotation;
    const rotation: [number, number, number] =
      item.kind === 'd6'
        ? [x + quarterTurns(), y + quarterTurns(), z + quarterTurns()]
        : [x + freeTurn(), y + freeTurn(), z + freeTurn()];
    const value = item.kind === 'd6' ? topFace(rotation) : randInt(1, DIE_FACES[item.kind]);
    this.update(id, { rotation, value });
    this.room.sendAction(`rolled ${value} on a ${item.kind}`);
  }

  /**
   * Flip a coin: it hops (the `Item` component's arc) while spinning about X or
   * Z by a whole number of half-turns — an odd count lands it on its other side,
   * an even one on the same, which is the randomness.
   */
  flip(id: string): void {
    const item = this.item(id);
    if (!item || item.kind !== 'coin') return;
    const rotation: [number, number, number] = [...item.rotation];
    const axis = Math.random() < 0.5 ? 0 : 2;
    rotation[axis] += randInt(2, 6) * Math.PI; // 2–6 half-turns
    const value = UP.clone().applyQuaternion(quaternionOf(rotation)).y > 0 ? 1 : 0;
    this.update(id, { rotation, value });
    this.room.sendAction(`flipped a coin: ${value === 1 ? 'heads' : 'tails'}`);
  }

  /** Left-click raises a counter, right-click lowers it (never below 1). */
  bump(id: string, delta: number): void {
    const item = this.item(id);
    if (!item || item.kind !== 'counter') return;
    const value = Math.max(1, item.value + delta);
    if (value === item.value) return;
    this.update(id, { value });
    this.room.sendAction(`set a counter to ${counterLabel(value, item.variant)}`);
  }
}

/** A random whole number of quarter turns, plus one full turn to make it tumble. */
function quarterTurns(): number {
  return randInt(1, 4) * QUARTER + TAU;
}

/** A free random angle (the design doc's 0–360°), plus a full turn to tumble. */
function freeTurn(): number {
  return Math.random() * TAU + TAU;
}

/** Which of the d6's faces points at the sky after a roll — that's the result. */
function topFace(rotation: [number, number, number]): number {
  const quaternion = quaternionOf(rotation);
  let best = 0;
  let bestDot = -Infinity;
  D6_FACE_NORMALS.forEach((normal, index) => {
    const dot = normal.clone().applyQuaternion(quaternion).dot(UP);
    if (dot > bestDot) {
      bestDot = dot;
      best = index;
    }
  });
  return D6_FACE_VALUES[best] ?? 1;
}
