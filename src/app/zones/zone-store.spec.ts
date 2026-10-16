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

  it('revealTop peeks the top cards without moving anything, and logs only the look', () => {
    room.setWorldObject('zone:user-1:deck', {
      ownerName: 'Tim',
      cards: [card('a', 'A'), card('b', 'B'), card('c', 'C')],
    });
    room.batches.length = 0;

    expect(store.revealTop(2)).toEqual([card('a', 'A'), card('b', 'B')]);
    expect(store.mine().deck).toHaveLength(3); // nothing has moved yet
    expect(room.batches).toEqual([]);
    // The history never says what was seen — the reveal is to me alone.
    expect(room.actions).toEqual(['looked at the top 2 cards of their deck']);
  });

  it('revealTop clamps to the deck and does nothing at all when it is empty', () => {
    room.setWorldObject('zone:user-1:deck', { ownerName: 'Tim', cards: [card('a', 'A')] });
    expect(store.revealTop(5)).toEqual([card('a', 'A')]);
    expect(room.actions).toEqual(['looked at the top card of their deck']);

    room.actions.length = 0;
    room.setWorldObject('zone:user-1:deck', { ownerName: 'Tim', cards: [] });
    expect(store.revealTop(3)).toEqual([]);
    expect(room.actions).toEqual([]);
  });

  it('searchDeck hands over the whole deck untouched, and tells the table', () => {
    const deck = [card('a', 'A'), card('b', 'B')];
    room.setWorldObject('zone:user-1:deck', { ownerName: 'Tim', cards: deck });
    room.batches.length = 0;

    expect(store.searchDeck()).toEqual(deck);
    expect(store.mine().deck).toEqual(deck); // a peek, like revealTop
    expect(room.batches).toEqual([]);
    // Searching a deck is public even though what's in it isn't.
    expect(room.actions).toEqual(['searched their deck']);

    room.actions.length = 0;
    room.setWorldObject('zone:user-1:deck', { ownerName: 'Tim', cards: [] });
    expect(store.searchDeck()).toEqual([]);
    expect(room.actions).toEqual([]);
  });

  it('applyReveal writes deck, hand and graveyard in ONE batch', () => {
    store.loadDeck([card('a', 'A')]);
    room.batches.length = 0;
    store.applyReveal(
      { deck: [], hand: [card('a', 'A')], graveyard: [] },
      'put a revealed card into their hand',
    );
    expect(room.batches).toEqual([
      ['zone:user-1:deck', 'zone:user-1:hand', 'zone:user-1:graveyard'],
    ]);
    expect(store.mine().hand).toEqual([card('a', 'A')]);
    expect(store.mine().deck).toEqual([]);
    expect(room.actions.at(-1)).toBe('put a revealed card into their hand');
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

  it('startNewRound clears the table, bumps the round once and resets my side from my deck', () => {
    localStorage.clear();
    TestBed.tick();
    store.loadDeck([card('a', 'A'), card('b', 'B'), card('c', 'C')]);
    store.setLife(40);
    store.setLife(31);
    store.draw();
    room.setWorldObject('card:t1', { name: 'Water Worm' });
    room.setWorldObject('item:i1', { kind: 'die' });
    room.setWorldObject('zone:user-2:deck', { ownerName: 'Bob', cards: [card('x', 'X')] });
    room.actions.length = 0;

    store.startNewRound();
    TestBed.tick();

    expect(store.round()).toBe(1);
    expect(room.actions).toEqual(['New round started']);
    expect(room.worldState()['card:t1']).toBeUndefined();
    expect(room.worldState()['item:i1']).toBeUndefined();
    expect(store.mine().hand).toEqual([]);
    expect(store.mine().deck).toHaveLength(3);
    expect(store.mine().life).toBe(40);
    expect(store.others()).toHaveLength(1);
  });

  it('a round started by another client resets me; entering a room with a round does not', () => {
    localStorage.clear();
    store.loadDeck([card('a', 'A'), card('b', 'B')]);
    TestBed.tick();
    store.draw();
    room.setWorldObject('round:current', { n: 1, startedBy: 'user-2' });
    TestBed.tick();
    expect(store.mine().hand).toEqual([]);
    expect(store.mine().deck).toHaveLength(2);

    room.currentRoom.set({ id: 'room-2' });
    room.setWorldObject('round:current', { n: 5, startedBy: 'user-2' });
    TestBed.tick();
    store.draw();
    TestBed.tick();
    expect(store.mine().hand).toHaveLength(1);
  });

  it('without a remembered deck a new round sends me back to the deck picker', () => {
    store.loadDeck([card('a', 'A')]);
    localStorage.clear();
    TestBed.tick();
    store.startNewRound();
    TestBed.tick();
    expect(store.hasMine()).toBe(false);
  });
});
