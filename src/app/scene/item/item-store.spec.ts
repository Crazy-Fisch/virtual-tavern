import { TestBed } from '@angular/core/testing';
import { Euler, Quaternion, Vector3 } from 'three';
import { RoomService } from '../../room/room.service';
import { FakeRoomService } from '../../room/testing/fake-room.service';
import { D6_FACE_NORMALS, D6_FACE_VALUES } from './item-geometry';
import { ItemStore } from './item-store';
import { ItemKind, ItemState, newItem } from './item.types';

const HALF_PI = Math.PI / 2;

/** Independent re-derivation of the pip count facing the sky. */
function topFaceOf(rotation: [number, number, number]): number {
  const quaternion = new Quaternion().setFromEuler(new Euler(...rotation));
  let best = 0;
  let bestDot = -Infinity;
  D6_FACE_NORMALS.forEach((normal, index) => {
    const dot = normal
      .clone()
      .applyQuaternion(quaternion)
      .dot(new Vector3(0, 1, 0));
    if (dot > bestDot) {
      bestDot = dot;
      best = index;
    }
  });
  return D6_FACE_VALUES[best]!;
}

describe('ItemStore', () => {
  let store: ItemStore;
  let room: FakeRoomService;

  beforeEach(() => {
    room = new FakeRoomService();
    TestBed.configureTestingModule({ providers: [{ provide: RoomService, useValue: room }] });
    store = TestBed.inject(ItemStore);
  });

  function spawn(kind: ItemKind, variant: 'plus' | 'minus' = 'plus'): ItemState {
    const item = newItem(kind, [0, 0.21, 0], variant);
    store.add(item);
    room.actions.length = 0;
    return item;
  }

  it('projects items out of the shared world state, ignoring cards and zones', () => {
    spawn('d6');
    room.setWorldObject('card:x', { name: 'Water Worm' });
    room.setWorldObject('zone:user-1:hand', { cards: [] });
    expect(store.items()).toHaveLength(1);
    expect(store.items()[0]!.kind).toBe('d6');
  });

  it('rolling a d6 lands it square on a face, and the pips on top are the logged result', () => {
    const die = spawn('d6');
    for (let i = 0; i < 20; i++) {
      store.roll(die.id);
      const rolled = store.item(die.id)!;
      // Whole quarter turns only — that is what guarantees a face ends up up.
      for (const euler of rolled.rotation) {
        const turns = euler / HALF_PI;
        expect(Math.abs(turns - Math.round(turns))).toBeLessThan(1e-9);
      }
      expect(rolled.value).toBe(topFaceOf(rolled.rotation));
      expect(rolled.value).toBeGreaterThanOrEqual(1);
      expect(rolled.value).toBeLessThanOrEqual(6);
    }
    expect(room.actions.at(-1)).toMatch(/^rolled [1-6] on a d6$/);
  });

  it('a roll always moves every euler, so remote clients have a tumble to animate', () => {
    const die = spawn('d20');
    const before = store.item(die.id)!.rotation;
    store.roll(die.id);
    const after = store.item(die.id)!.rotation;
    for (let axis = 0; axis < 3; axis++) expect(after[axis]).not.toBe(before[axis]);
    const value = store.item(die.id)!.value;
    expect(value).toBeGreaterThanOrEqual(1);
    expect(value).toBeLessThanOrEqual(20);
    expect(room.actions).toEqual([`rolled ${value} on a d20`]);
  });

  it('flipping a coin spins it about a horizontal axis and reports the side it lands on', () => {
    const coin = spawn('coin');
    for (let i = 0; i < 20; i++) {
      store.flip(coin.id);
      const flipped = store.item(coin.id)!;
      expect(flipped.rotation[1]).toBe(0); // never spins about its own axis
      const up = new Vector3(0, 1, 0).applyQuaternion(
        new Quaternion().setFromEuler(new Euler(...flipped.rotation)),
      );
      expect(flipped.value).toBe(up.y > 0 ? 1 : 0);
      expect(room.actions.at(-1)).toBe(
        `flipped a coin: ${flipped.value === 1 ? 'heads' : 'tails'}`,
      );
    }
  });

  it('a counter counts up and down but never below 1', () => {
    const counter = spawn('counter');
    store.bump(counter.id, 1);
    store.bump(counter.id, 1);
    expect(store.item(counter.id)!.value).toBe(3);
    store.bump(counter.id, -1);
    expect(store.item(counter.id)!.value).toBe(2);
    expect(room.actions).toEqual([
      'set a counter to +2/+2',
      'set a counter to +3/+3',
      'set a counter to +2/+2',
    ]);

    room.actions.length = 0;
    store.bump(counter.id, -1);
    store.bump(counter.id, -1); // already at the floor: no write, no history line
    expect(store.item(counter.id)!.value).toBe(1);
    expect(room.actions).toEqual(['set a counter to +1/+1']);
  });

  it('a −1/−1 counter labels its history line with minus signs', () => {
    const counter = spawn('counter', 'minus');
    store.bump(counter.id, 1);
    expect(room.actions).toEqual(['set a counter to −2/−2']);
  });

  it('rolling, flipping and bumping only apply to the matching kind', () => {
    const coin = spawn('coin');
    store.roll(coin.id);
    store.bump(coin.id, 1);
    expect(store.item(coin.id)!.rotation).toEqual([0, 0, 0]);
    expect(store.item(coin.id)!.value).toBe(1);
    expect(room.actions).toEqual([]);
  });

  it('removes the counters riding on a card when that card leaves the table', () => {
    const attached = spawn('counter');
    store.update(attached.id, { attachedTo: 'card:1' });
    const loose = spawn('counter');
    store.removeAttachedTo('card:1');
    expect(store.items().map((i) => i.id)).toEqual([loose.id]);
  });

  it('previews are local overrides that update() commits and clearPreview() discards', () => {
    const die = spawn('d6');
    store.preview(die.id, { position: [1, 0.5, 2] });
    expect(store.item(die.id)!.position).toEqual([1, 0.5, 2]);
    store.clearPreview(die.id);
    expect(store.item(die.id)!.position).toEqual([0, 0.21, 0]);
  });
});
