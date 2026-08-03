import { TestBed } from '@angular/core/testing';
import { RoomService } from '../room/room.service';
import { FakeRoomService } from '../room/testing/fake-room.service';
import { CardState } from '../scene/card/card.types';
import { ZoneStore } from './zone-store';
import { ZoneCard } from './zone.types';

const card = (id: string, name: string): ZoneCard => ({
  id,
  name,
  src: `https://example.com/${id}.jpg`,
});

const tableCard = (name: string): CardState => ({
  id: 'card:t1',
  name,
  src: 'https://example.com/t1.jpg',
  position: [0, 0.5, 0],
  yaw: 0,
  faceUp: true,
  tapped: false,
  relatedNames: [],
  ownerUid: 'user-1',
});

describe('ZoneStore', () => {
  let store: ZoneStore;
  let room: FakeRoomService;

  beforeEach(() => {
    room = new FakeRoomService();
    TestBed.configureTestingModule({
      providers: [{ provide: RoomService, useValue: room }],
    });
    store = TestBed.inject(ZoneStore);
  });

  it('loadDeck creates my zones with the shuffled deck and logs the join', () => {
    expect(store.hasMine()).toBe(false);
    store.loadDeck([card('a', 'A'), card('b', 'B'), card('c', 'C')]);
    expect(store.hasMine()).toBe(true);
    expect(store.mine()).toMatchObject({
      uid: 'user-1',
      name: 'Tim',
      hand: [],
      graveyard: [],
      exile: [],
    });
    expect([...store.mine().deck.map((c) => c.id)].sort()).toEqual(['a', 'b', 'c']);
    expect(Object.keys(room.worldState()).sort()).toEqual([
      'zone:user-1:deck',
      'zone:user-1:exile',
      'zone:user-1:graveyard',
      'zone:user-1:hand',
    ]);
    expect(room.actions).toEqual(['joined the game with a 3-card deck']);
  });

  it('refreshOwnerName updates a stale name without touching cards, and never creates zones', () => {
    store.refreshOwnerName();
    expect(store.hasMine()).toBe(false); // no zones until a deck is loaded

    room.setWorldObject('zone:user-1:deck', { ownerName: 'Old', cards: [card('a', 'Ace')] });
    store.refreshOwnerName();
    expect(store.mine().name).toBe('Tim');
    expect(store.mine().deck).toEqual([card('a', 'Ace')]);
    expect(Object.keys(room.worldState())).toEqual(['zone:user-1:deck']);
  });

  it('splits players into mine and others', () => {
    store.loadDeck([]);
    room.setWorldObject('zone:user-2:hand', { ownerName: 'Ana', cards: [card('a', 'Ace')] });
    room.setWorldObject('zone:user-2:graveyard', { ownerName: 'Ana', cards: [] });
    expect(store.others()).toMatchObject([{ uid: 'user-2', name: 'Ana' }]);
    expect(store.others()[0]!.hand).toHaveLength(1);
  });

  it('draw moves the top of the deck into my hand and logs it', () => {
    room.setWorldObject('zone:user-1:deck', {
      ownerName: 'Tim',
      cards: [card('top', 'Top'), card('under', 'Under')],
    });
    store.draw();
    expect(store.mine().deck).toEqual([card('under', 'Under')]);
    expect(store.mine().hand).toEqual([card('top', 'Top')]);
    expect(room.actions).toEqual(['drew a card']);
  });

  it('draw writes deck and hand in ONE batch, so a lost request cannot eat the card', () => {
    room.setWorldObject('zone:user-1:deck', { ownerName: 'Tim', cards: [card('top', 'Top')] });
    room.batches.length = 0;
    store.draw();
    expect(room.batches).toEqual([['zone:user-1:deck', 'zone:user-1:hand']]);
  });

  it('loadDeck creates all four zones in one atomic batch', () => {
    store.loadDeck([card('a', 'A')]);
    expect(room.batches).toEqual([
      ['zone:user-1:hand', 'zone:user-1:graveyard', 'zone:user-1:exile', 'zone:user-1:deck'],
    ]);
  });

  it('drawing from an empty deck does nothing', () => {
    store.draw();
    expect(room.actions).toEqual([]);
  });

  it('shuffle keeps the same cards and logs it', () => {
    const cards = [card('a', 'A'), card('b', 'B'), card('c', 'C')];
    room.setWorldObject('zone:user-1:deck', { ownerName: 'Tim', cards });
    store.shuffle();
    expect([...store.mine().deck].map((c) => c.id).sort()).toEqual(['a', 'b', 'c']);
    expect(room.actions).toEqual(['shuffled their deck']);
  });

  it('takeFromTable removes the table card and puts it in the zone (deck = on top)', () => {
    room.setWorldObject('card:t1', { name: 'Water Worm' });
    room.setWorldObject('zone:user-1:deck', { ownerName: 'Tim', cards: [card('old', 'Old')] });

    store.takeFromTable(tableCard('Water Worm'), 'deck');
    expect(room.worldState()['card:t1']).toBeUndefined();
    expect(store.mine().deck.map((c) => c.name)).toEqual(['Water Worm', 'Old']);
    expect(room.actions).toEqual(['put Water Worm on top of their deck']);
  });

  it('takeFromTable logs zone-appropriate history lines', () => {
    store.takeFromTable(tableCard('Water Worm'), 'hand');
    store.takeFromTable(tableCard('Water Worm'), 'graveyard');
    expect(room.actions).toEqual([
      'returned Water Worm to their hand',
      'put Water Worm into their graveyard',
    ]);
  });

  it('playFromHand removes the card and returns it silently; unknown ids return null', () => {
    room.setWorldObject('zone:user-1:hand', { ownerName: 'Tim', cards: [card('a', 'Ace')] });
    expect(store.playFromHand('a')).toEqual(card('a', 'Ace'));
    expect(store.mine().hand).toEqual([]);
    // No history line here: "played X" is posted by the drop commit, so a
    // drag released off the table can revert without leaving a trace.
    expect(room.actions).toEqual([]);
    expect(store.playFromHand('a')).toBeNull();
  });

  it('takeFromTable with a local-only card (hand drag onto a zone) deletes nothing', () => {
    // The card never reached the shared world (CardStore.addLocal), so there
    // is no world object to remove — but the zone still absorbs it.
    store.takeFromTable(tableCard('Water Worm'), 'graveyard');
    expect(store.mine().graveyard.map((c) => c.name)).toEqual(['Water Worm']);
    expect(room.actions).toEqual(['put Water Worm into their graveyard']);
  });
});
