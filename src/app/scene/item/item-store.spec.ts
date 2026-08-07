import { TestBed } from '@angular/core/testing';
import { Euler, Quaternion, Vector3 } from 'three';
import { RoomService } from '../../room/room.service';
import { FakeRoomService } from '../../room/testing/fake-room.service';
import { D6_FACE_NORMALS, D6_FACE_VALUES } from './item-geometry';
import { ItemStore } from './item-store';
import {
  CounterVariant,
  DEFAULT_ITEM_COLOR,
  ItemKind,
  ItemState,
  counterLabel,
  itemLabel,
  newItem,
} from './item.types';

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

  function spawn(kind: ItemKind, variant: CounterVariant = 'plus'): ItemState {
    const item = newItem(kind, [0, 0.21, 0], { variant });
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

  it('an x counter counts in plain multiples and never drops below 1x', () => {
    const counter = spawn('counter', 'x');
    store.bump(counter.id, 1);
    store.bump(counter.id, 1);
    store.bump(counter.id, -1);
    expect(store.item(counter.id)!.value).toBe(2);
    expect(room.actions).toEqual([
      'set a counter to 2x',
      'set a counter to 3x',
      'set a counter to 2x',
    ]);

    room.actions.length = 0;
    store.bump(counter.id, -1);
    store.bump(counter.id, -1);
    expect(store.item(counter.id)!.value).toBe(1);
    expect(room.actions).toEqual(['set a counter to 1x']);
  });

  it('carries the die colour through the shared world, defaulting old dice', () => {
    const die = newItem('d20', [0, 0.21, 0], { color: 'green' });
    store.add(die);
    expect(store.item(die.id)!.color).toBe('green');
    // A die written before the palette existed, and a nonsense value, both fall
    // back rather than reaching the renderer as something unpaintable.
    room.setWorldObject('item:old', { kind: 'd6' });
    room.setWorldObject('item:bad', { kind: 'd6', color: 'chartreuse' });
    const colors = store
      .items()
      .filter((i) => i.id !== die.id)
      .map((i) => i.color);
    expect(colors).toEqual([DEFAULT_ITEM_COLOR, DEFAULT_ITEM_COLOR]);
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

  it('a local item stays off the network until update() promotes it (tableitems.md)', () => {
    const item = newItem('d6', [0, 0.5, 0]);
    store.addLocal(item);
    expect(store.item(item.id)).toBeDefined(); // visible on this client…
    expect(room.worldState()[item.id]).toBeUndefined(); // …but never sent
    store.update(item.id, { position: [1, 0.21, 2] });
    expect(room.worldState()[item.id]).toBeDefined();
    expect(store.item(item.id)!.position).toEqual([1, 0.21, 2]);
  });

  it('removing a still-local item discards it without a network write', () => {
    const item = newItem('coin', [0, 0.5, 0]);
    store.addLocal(item);
    store.remove(item.id);
    expect(store.item(item.id)).toBeUndefined();
    expect(room.worldState()[item.id]).toBeUndefined();
    expect(room.actions).toEqual([]);
  });

  it('labels each counter flavour on its face and in the history', () => {
    expect(counterLabel(2, 'plus')).toBe('+2/+2');
    expect(counterLabel(2, 'minus')).toBe('−2/−2');
    expect(counterLabel(2, 'x')).toBe('2x');
    expect(itemLabel({ kind: 'counter', variant: 'x' })).toBe('x counter');
    expect(itemLabel({ kind: 'counter', variant: 'minus' })).toBe('−1/−1 counter');
  });

  it('previews are local overrides that update() commits and clearPreview() discards', () => {
    const die = spawn('d6');
    store.preview(die.id, { position: [1, 0.5, 2] });
    expect(store.item(die.id)!.position).toEqual([1, 0.5, 2]);
    store.clearPreview(die.id);
    expect(store.item(die.id)!.position).toEqual([0, 0.21, 0]);
  });
});
