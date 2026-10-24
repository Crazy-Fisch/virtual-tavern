import { TestBed } from '@angular/core/testing';
import { RoomService } from '../../room/room.service';
import { FakeRoomService } from '../../room/testing/fake-room.service';
import { BLOCK_Z } from './attack-zone';
import { CardStore } from './card-store';
import { CardState, newCardId } from './card.types';

function makeCard(overrides: Partial<CardState> = {}): CardState {
  return {
    id: newCardId(),
    name: 'Water Worm',
    src: 'https://example.com/worm.jpg',
    position: [0, 0.5, 0],
    yaw: 0,
    faceUp: true,
    tapped: false,
    relatedNames: [],
    ownerUid: 'user-1',
    ...overrides,
  };
}

describe('CardStore', () => {
  let store: CardStore;
  let room: FakeRoomService;

  beforeEach(() => {
    room = new FakeRoomService();
    TestBed.configureTestingModule({
      providers: [CardStore, { provide: RoomService, useValue: room }],
    });
    store = TestBed.inject(CardStore);
  });

  it('projects card world objects and ignores other id prefixes', () => {
    const card = makeCard();
    store.add(card);
    room.setWorldObject('zone:user-1:hand', { ownerName: 'Tim', cards: [] });
    expect(store.cards()).toEqual([card]);
    expect(store.card(card.id)).toEqual(card);
  });

  it('sees cards added remotely (shared world state is the source of truth)', () => {
    room.setWorldObject('card:remote', {
      name: 'Remote',
      src: 'https://example.com/r.jpg',
      position: [1, 0.5, -1],
      yaw: Math.PI,
      faceUp: false,
      relatedNames: [],
    });
    expect(store.card('card:remote')).toMatchObject({ name: 'Remote', faceUp: false });
  });

  it('parses malformed payloads defensively', () => {
    room.setWorldObject('card:broken', { position: 'nope', relatedNames: [1, 'ok'] });
    expect(store.card('card:broken')).toEqual({
      id: 'card:broken',
      name: 'a card',
      src: '',
      position: [0, 0, 0],
      yaw: 0,
      faceUp: true,
      tapped: false,
      relatedNames: ['ok'],
      ownerUid: '',
    });
  });

  it('carries a double-faced card’s second face and which one is showing (mdfcs.md)', () => {
    const card = makeCard({ backSrc: 'https://example.com/back.jpg' });
    store.add(card);
    expect(store.card(card.id)).toMatchObject({ backSrc: 'https://example.com/back.jpg' });
    store.update(card.id, { flipped: true });
    expect(store.card(card.id)!.flipped).toBe(true);
    // An ordinary card carries neither key, so it round-trips exactly as before.
    const plain = makeCard();
    store.add(plain);
    expect(store.card(plain.id)).toEqual(plain);
    expect(Object.keys(room.worldState()[plain.id]!.data)).not.toContain('backSrc');
  });

  it('updates a card without touching the others', () => {
    const first = makeCard();
    const second = makeCard();
    store.add(first);
    store.add(second);
    store.update(first.id, { yaw: Math.PI, faceUp: false });
    expect(store.card(first.id)).toMatchObject({ yaw: Math.PI, faceUp: false });
    expect(store.card(second.id)).toEqual(second);
  });

  it('preview overlays locally without writing shared state; update commits and clears it', () => {
    const card = makeCard();
    store.add(card);
    store.preview(card.id, { position: [2, 0.8, 2] });
    expect(store.card(card.id)!.position).toEqual([2, 0.8, 2]);
    // The shared world still holds the committed position.
    expect(room.worldState()[card.id]!.data['position']).toEqual([0, 0.5, 0]);

    store.update(card.id, { position: [2, 0.21, 2] });
    expect(store.card(card.id)!.position).toEqual([2, 0.21, 2]);
    expect(room.worldState()[card.id]!.data['position']).toEqual([2, 0.21, 2]);
  });

  it('clearPreview snaps back to the shared state', () => {
    const card = makeCard();
    store.add(card);
    store.preview(card.id, { position: [5, 0.8, 5] });
    store.clearPreview(card.id);
    expect(store.card(card.id)!.position).toEqual([0, 0.5, 0]);
  });

  describe('local-only cards (a hand card mid-drag)', () => {
    it('addLocal renders the card without touching the shared world', () => {
      const card = makeCard();
      store.addLocal(card);
      expect(store.card(card.id)).toEqual(card);
      expect(room.worldState()[card.id]).toBeUndefined();
    });

    it('previews overlay a local card like any other', () => {
      const card = makeCard();
      store.addLocal(card);
      store.preview(card.id, { position: [3, 0.8, 3] });
      expect(store.card(card.id)!.position).toEqual([3, 0.8, 3]);
      expect(room.worldState()[card.id]).toBeUndefined();
    });

    it('update promotes a local card into the shared world (the drop landing)', () => {
      const card = makeCard();
      store.addLocal(card);
      store.update(card.id, { position: [1, 0.21, 1] });
      expect(room.worldState()[card.id]!.data['position']).toEqual([1, 0.21, 1]);
      expect(store.cards()).toHaveLength(1); // promoted, not duplicated
    });

    it('remove discards a local card silently — the network never saw it', () => {
      const card = makeCard();
      store.addLocal(card);
      store.remove(card.id);
      expect(store.card(card.id)).toBeUndefined();
      expect(room.worldState()[card.id]).toBeUndefined();
    });
  });

  it('updateMany commits several cards in one shared batch (group drop)', () => {
    const first = makeCard();
    const second = makeCard();
    store.add(first);
    store.add(second);
    room.batches.length = 0;
    store.updateMany([
      [first.id, { position: [1, 0.21, 0] }],
      [second.id, { position: [2, 0.21, 0] }],
    ]);
    expect(room.batches).toEqual([[first.id, second.id]]);
    expect(store.card(second.id)!.position).toEqual([2, 0.21, 0]);
  });

  it('remove deletes the card; related names on other cards are untouched', () => {
    const first = makeCard();
    const second = makeCard({ relatedNames: ['Goblin Token'] });
    store.add(first);
    store.add(second);
    store.remove(first.id);
    expect(store.card(first.id)).toBeUndefined();
    // Related names are data, not references — removing cards never breaks them.
    expect(store.card(second.id)!.relatedNames).toEqual(['Goblin Token']);
  });

  describe('combat', () => {
    function table(): { a: CardState; b: CardState; x: CardState; y: CardState } {
      const a = makeCard({ name: 'Bear', position: [2, 0.21, 3] });
      const b = makeCard({ name: 'Wolf', position: [-2, 0.21, 3] });
      const x = makeCard({ name: 'Wall', ownerUid: 'user-2', position: [0, 0.21, -3] });
      const y = makeCard({ name: 'Elf', ownerUid: 'user-2', position: [1, 0.21, -3] });
      store.addMany([a, b, x, y]);
      room.actions.length = 0;
      room.batches.length = 0;
      return { a, b, x, y };
    }

    it('setAttacking marks and lines up attackers in one batch with one history line', () => {
      const { a, b } = table();
      store.setAttacking([a.id, b.id]);
      expect(room.batches).toEqual([[a.id, b.id]]);
      expect(room.actions).toEqual(['attacks with Bear and Wolf']);
      expect(store.card(a.id)!.combat).toEqual({ role: 'attack' });
      const [pa, pb] = [store.card(a.id)!.position, store.card(b.id)!.position];
      expect(pa[2]).toBeCloseTo(0); // attackers snap to the band centre
      expect(pa[0]).toBeGreaterThan(pb[0]);
      expect(pa[0]).toBeCloseTo(2);
      expect(pb[0]).toBeCloseTo(-2);
      expect(store.card(a.id)!.tapped).toBe(false);
      expect(store.hasCombat()).toBe(true);
    });

    it('hasCombat is false without attackers, and old cards have no combat field', () => {
      const { a } = table();
      expect(store.hasCombat()).toBe(false);
      expect(store.card(a.id)!.combat).toBeUndefined();
      expect('combat' in room.worldState()[a.id].data).toBe(false);
    });

    it('setBlocking stands blockers opposite the attacker, relaying everything in one batch', () => {
      const { a, b, x, y } = table();
      store.setAttacking([a.id, b.id]);
      room.actions.length = 0;
      room.batches.length = 0;
      store.setBlocking([x.id, y.id], a.id);
      expect(room.batches).toHaveLength(1);
      expect(new Set(room.batches[0])).toEqual(new Set([a.id, b.id, x.id, y.id]));
      expect(room.actions).toEqual(['blocks Bear with Wall and Elf']);
      const attacker = store.card(a.id)!.position;
      const blocker = store.card(x.id)!.position;
      expect(store.card(x.id)!.combat).toEqual({ role: 'block', target: a.id });
      expect(attacker[2]).toBeCloseTo(0);
      expect(blocker[2]).toBeCloseTo(-BLOCK_Z);
      expect((blocker[0] + store.card(y.id)!.position[0]) / 2).toBeCloseTo(attacker[0]);
    });

    it('setBlocking ignores a target that is not attacking and cards that attack', () => {
      const { a, b, x } = table();
      store.setBlocking([x.id], a.id);
      expect(room.batches).toEqual([]);
      store.setAttacking([a.id, b.id]);
      room.batches.length = 0;
      store.setBlocking([b.id], a.id);
      expect(room.batches).toEqual([]);
    });

    it('clearCombat on an attacker frees its blockers where they stand', () => {
      const { a, b, x } = table();
      store.setAttacking([a.id, b.id]);
      store.setBlocking([x.id], a.id);
      const blockerAt = store.card(x.id)!.position;
      room.actions.length = 0;
      room.batches.length = 0;
      store.clearCombat([a.id]);
      expect(room.batches).toHaveLength(1);
      expect(room.actions).toEqual(['takes Bear out of combat']);
      expect(store.card(a.id)!.combat).toBeUndefined();
      expect(store.card(x.id)!.combat).toBeUndefined();
      expect(store.card(x.id)!.position).toEqual(blockerAt);
      expect(store.card(b.id)!.combat).toEqual({ role: 'attack' });
      expect(store.card(b.id)!.position[0]).toBeCloseTo(-2);
    });

    it('clearing the last attacker ends combat', () => {
      const { a } = table();
      store.setAttacking([a.id]);
      store.clearCombat([a.id]);
      expect(store.hasCombat()).toBe(false);
    });

    it('reads combat back from a remote payload and drops garbage', () => {
      room.setWorldObject('card:r1', { name: 'R', combat: { role: 'block', target: 'card:r2' } });
      room.setWorldObject('card:r2', { name: 'S', combat: { role: 'weird' } });
      expect(store.card('card:r1')!.combat).toEqual({ role: 'block', target: 'card:r2' });
      expect(store.card('card:r2')!.combat).toBeUndefined();
    });
  });
});
