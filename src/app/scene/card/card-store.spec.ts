import { TestBed } from '@angular/core/testing';
import { RoomService } from '../../room/room.service';
import { FakeRoomService } from '../../room/testing/fake-room.service';
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
    relatedIds: [],
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
      relatedIds: [],
    });
    expect(store.card('card:remote')).toMatchObject({ name: 'Remote', faceUp: false });
  });

  it('parses malformed payloads defensively', () => {
    room.setWorldObject('card:broken', { position: 'nope', relatedIds: [1, 'ok'] });
    expect(store.card('card:broken')).toEqual({
      id: 'card:broken',
      name: 'a card',
      src: '',
      position: [0, 0, 0],
      yaw: 0,
      faceUp: true,
      tapped: false,
      relatedIds: ['ok'],
    });
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

  it('remove deletes the card; dangling relatedIds resolve to nothing', () => {
    const first = makeCard();
    const second = makeCard({ relatedIds: [first.id] });
    store.add(first);
    store.add(second);
    store.remove(first.id);
    expect(store.card(first.id)).toBeUndefined();
    // The stale reference stays in data but resolves to undefined on lookup.
    expect(store.card(second.id)!.relatedIds).toEqual([first.id]);
    expect(store.card(first.id)).toBeUndefined();
  });
});
