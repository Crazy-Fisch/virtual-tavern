import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { P2pService } from '../p2p/p2p.service';
import { SupabaseService } from '../supabase/supabase.service';
import { RoomService } from './room.service';

type QueryResult = { data: unknown; error: { message: string } | null };

/** Chainable thenable stub standing in for a PostgREST query builder. A queued
 * promise lets a test hold a request in flight and release it later. */
function makeQuery(result: QueryResult | Promise<QueryResult>): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proxy: any = new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (v: QueryResult) => unknown) => Promise.resolve(result).then(resolve);
      }
      return () => proxy;
    },
  });
  return proxy;
}

const ROOM_RPC: QueryResult = {
  data: [{ room_id: 'r1', room_code: 'ABC123', room_name: null, room_owner: 'user-1' }],
  error: null,
};

type ChangePayload = { eventType?: string; new?: unknown; old?: unknown };

function setup(
  opts: { rpc?: QueryResult; tables?: Record<string, (QueryResult | Promise<QueryResult>)[]> } = {},
) {
  const tables = opts.tables ?? {};
  const handlers: Record<string, (payload: ChangePayload) => void> = {};
  /** Realtime presence on the room channel; tests fill it to shape leave(). */
  const presence: Record<string, unknown[]> = {};
  let presenceKey = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channel: any = {
    on: vi.fn((_ev: string, filter: { table: string }, cb: (p: ChangePayload) => void) => {
      handlers[filter.table] = cb;
      return channel;
    }),
    subscribe: vi.fn((cb?: (status: string) => void) => {
      cb?.('SUBSCRIBED');
      return channel;
    }),
    track: vi.fn(async () => 'ok'),
    presenceState: vi.fn(() => presence),
  };
  const client = {
    from: vi.fn((table: string) => {
      const queued = (tables[table] ?? []).shift();
      return makeQuery(queued ?? { data: [], error: null });
    }),
    rpc: vi.fn(async (_fn: string, _args?: Record<string, unknown>) => {
      return opts.rpc ?? { data: [], error: null };
    }),
    channel: vi.fn((_name: string, chanOpts?: { config?: { presence?: { key?: string } } }) => {
      presenceKey = chanOpts?.config?.presence?.key ?? '';
      return channel;
    }),
    removeChannel: vi.fn(),
  };
  const supabase = {
    client,
    userId: () => 'user-1',
    displayName: () => 'Tim',
    setDisplayName: vi.fn(async () => undefined),
  };
  const p2p = { join: vi.fn(), leave: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      { provide: SupabaseService, useValue: supabase },
      { provide: P2pService, useValue: p2p },
    ],
  });
  return {
    service: TestBed.inject(RoomService),
    client,
    channel,
    handlers,
    p2p,
    presence,
    presenceKey: () => presenceKey,
  };
}

const flush = () => new Promise((r) => setTimeout(r));

describe('RoomService', () => {
  beforeEach(() => localStorage.clear());
  afterEach(() => vi.useRealTimers());
  it('returns an error for an unknown room code without joining', async () => {
    const { service, p2p } = setup({ rpc: { data: [], error: null } });
    expect(await service.joinByCode('NOPE99', 'Tim')).toBe('Room not found');
    expect(service.joined()).toBe(false);
    expect(p2p.join).not.toHaveBeenCalled();
  });

  it('joins by code, restores history, and starts the P2P layer with the room UUID', async () => {
    const chatRow = {
      id: 'm1',
      sender_id: 'u2',
      sender_name: 'Ana',
      text: 'hello',
      kind: 'chat',
      created_at: '2026-07-17T10:00:00Z',
    };
    const cardRow = {
      object_id: 'card:c1',
      data: { name: 'Water Worm', faceUp: true },
      updated_by: 'u2',
      updated_at: '2026-07-17T10:00:00Z',
    };
    const { service, p2p } = setup({
      rpc: ROOM_RPC,
      tables: {
        chat_messages: [{ data: [chatRow], error: null }],
        world_objects: [{ data: [cardRow], error: null }],
      },
    });

    expect(await service.joinByCode('abc123', 'Tim')).toBeNull();
    expect(service.joined()).toBe(true);
    expect(service.currentRoom()?.code).toBe('ABC123');
    expect(service.messages()).toEqual([
      {
        id: 'm1',
        from: 'u2',
        name: 'Ana',
        text: 'hello',
        kind: 'chat',
        t: Date.parse(chatRow.created_at),
      },
    ]);
    expect(service.worldState()['card:c1']?.data).toEqual({ name: 'Water Worm', faceUp: true });
    expect(p2p.join).toHaveBeenCalledWith('r1', 'Tim');
  });

  it('appends chat optimistically and dedupes the realtime echo by id', async () => {
    const { service, handlers } = setup({ rpc: ROOM_RPC });
    await service.joinByCode('ABC123', 'Tim');

    service.sendChat('  hi  ');
    await flush();
    const sent = service.messages();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ from: 'user-1', name: 'Tim', text: 'hi', kind: 'chat' });

    handlers['chat_messages']!({
      new: {
        id: sent[0]!.id,
        sender_id: 'user-1',
        sender_name: 'Tim',
        text: 'hi',
        kind: 'chat',
        created_at: '2026-07-17T10:00:01Z',
      },
    });
    expect(service.messages()).toHaveLength(1);
  });

  it('sendAction posts a history line with kind action', async () => {
    const { service } = setup({ rpc: ROOM_RPC });
    await service.joinByCode('ABC123', 'Tim');

    service.sendAction('added Water Worm');
    expect(service.messages()).toMatchObject([
      { name: 'Tim', text: 'added Water Worm', kind: 'action' },
    ]);
  });

  it('rolls back the optimistic message when the insert fails', async () => {
    const { service } = setup({
      rpc: ROOM_RPC,
      tables: {
        chat_messages: [
          { data: [], error: null }, // history load on join
          { data: null, error: { message: 'nope' } }, // failing insert
        ],
      },
    });
    await service.joinByCode('ABC123', 'Tim');

    service.sendChat('hi');
    expect(service.messages()).toHaveLength(1);
    await flush();
    expect(service.messages()).toHaveLength(0);
  });

  it('applies world events last-writer-wins by server timestamp', async () => {
    const { service, handlers } = setup({ rpc: ROOM_RPC });
    await service.joinByCode('ABC123', 'Tim');

    handlers['world_objects']!({
      eventType: 'UPDATE',
      new: {
        object_id: 'card:c1',
        data: { faceUp: true },
        updated_by: 'u2',
        updated_at: '2026-07-17T10:00:10Z',
      },
    });
    expect(service.worldState()['card:c1']?.data).toEqual({ faceUp: true });

    // An older (out-of-order) event must not win.
    handlers['world_objects']!({
      eventType: 'UPDATE',
      new: {
        object_id: 'card:c1',
        data: { faceUp: false },
        updated_by: 'u2',
        updated_at: '2026-07-17T10:00:05Z',
      },
    });
    expect(service.worldState()['card:c1']?.data).toEqual({ faceUp: true });
  });

  it('setWorldObject applies optimistically; removeWorldObject deletes', async () => {
    const { service } = setup({ rpc: ROOM_RPC });
    await service.joinByCode('ABC123', 'Tim');

    service.setWorldObject('card:c1', { name: 'Water Worm' });
    expect(service.worldState()['card:c1']?.data).toEqual({ name: 'Water Worm' });

    service.removeWorldObject('card:c1');
    expect(service.worldState()['card:c1']).toBeUndefined();
  });

  it('setWorldObjects applies every entry optimistically and sends ONE batched request', async () => {
    const { service, client } = setup({ rpc: ROOM_RPC });
    await service.joinByCode('ABC123', 'Tim');
    const worldRequests = () =>
      client.from.mock.calls.filter(([table]) => table === 'world_objects').length;
    const before = worldRequests();

    service.setWorldObjects([
      ['zone:user-1:deck', { cards: [] }],
      ['zone:user-1:hand', { cards: [{ id: 'a' }] }],
    ]);
    expect(service.worldState()['zone:user-1:deck']?.data).toEqual({ cards: [] });
    expect(service.worldState()['zone:user-1:hand']?.data).toEqual({ cards: [{ id: 'a' }] });
    await flush();
    expect(worldRequests()).toBe(before + 1); // deck+hand in one atomic upsert
  });

  it('adopts the upsert ack (server timestamp), so later remote writes win despite clock skew', async () => {
    const ack = {
      object_id: 'card:c1',
      data: { name: 'Mine' },
      updated_by: 'user-1',
      updated_at: '2026-07-17T10:00:10Z',
    };
    const { service, handlers } = setup({
      rpc: ROOM_RPC,
      tables: {
        world_objects: [
          { data: [], error: null }, // snapshot load on join
          { data: [ack], error: null }, // upsert ack
        ],
      },
    });
    await service.joinByCode('ABC123', 'Tim');

    // The optimistic write stamps the local clock — far ahead of the server's.
    service.setWorldObject('card:c1', { name: 'Mine' });
    await flush();
    expect(service.worldState()['card:c1']?.t).toBe(Date.parse(ack.updated_at));

    // A remote write one server-second later must now win last-writer-wins;
    // against the (much larger) optimistic local timestamp it would have lost.
    handlers['world_objects']!({
      eventType: 'UPDATE',
      new: {
        object_id: 'card:c1',
        data: { name: 'Theirs' },
        updated_by: 'u2',
        updated_at: '2026-07-17T10:00:11Z',
      },
    });
    expect(service.worldState()['card:c1']?.data).toEqual({ name: 'Theirs' });
  });

  it('a failed world write resyncs the objects from the database instead of diverging', async () => {
    const dbRow = {
      object_id: 'zone:user-1:deck',
      data: { cards: [{ id: 'top' }] },
      updated_by: 'user-1',
      updated_at: '2026-07-17T10:00:10Z',
    };
    const { service } = setup({
      rpc: ROOM_RPC,
      tables: {
        world_objects: [
          { data: [dbRow], error: null }, // snapshot load on join
          { data: null, error: { message: 'network down' } }, // failing upsert
          { data: [dbRow], error: null }, // resync select
        ],
      },
    });
    await service.joinByCode('ABC123', 'Tim');

    service.setWorldObject('zone:user-1:deck', { cards: [] });
    expect(service.worldState()['zone:user-1:deck']?.data).toEqual({ cards: [] }); // optimistic
    await flush();
    // The write never landed: local state snaps back to the database's truth
    // (the drawn card is visibly back on the deck, not silently lost).
    expect(service.worldState()['zone:user-1:deck']?.data).toEqual({ cards: [{ id: 'top' }] });
  });

  it('a failed write for an object the database never had removes it locally', async () => {
    const { service } = setup({
      rpc: ROOM_RPC,
      tables: {
        world_objects: [
          { data: [], error: null }, // snapshot load on join
          { data: null, error: { message: 'network down' } }, // failing upsert
          { data: [], error: null }, // resync select: row does not exist
        ],
      },
    });
    await service.joinByCode('ABC123', 'Tim');

    service.setWorldObject('card:new', { name: 'Ghost' });
    await flush();
    expect(service.worldState()['card:new']).toBeUndefined();
  });

  it('an own echo of an older write does not clobber a newer write still in flight', async () => {
    let release!: (v: QueryResult) => void;
    const gate = new Promise<QueryResult>((r) => (release = r));
    const { service, handlers } = setup({
      rpc: ROOM_RPC,
      tables: {
        world_objects: [
          { data: [], error: null }, // snapshot load on join
          gate, // the new write's upsert, held in flight
        ],
      },
    });
    await service.joinByCode('ABC123', 'Tim');

    service.setWorldObject('zone:user-1:hand', { cards: [{ id: 'a' }, { id: 'b' }] });
    // The realtime echo of the PREVIOUS hand write arrives while the new
    // write's request is still pending. Force-adopting it used to roll the
    // hand back (dropping the just-drawn card until — if ever — healed).
    handlers['world_objects']!({
      eventType: 'UPDATE',
      new: {
        object_id: 'zone:user-1:hand',
        data: { cards: [{ id: 'a' }] },
        updated_by: 'user-1',
        updated_at: '2026-07-17T10:00:10Z',
      },
    });
    expect(service.worldState()['zone:user-1:hand']?.data).toEqual({
      cards: [{ id: 'a' }, { id: 'b' }],
    });

    release({
      data: [
        {
          object_id: 'zone:user-1:hand',
          data: { cards: [{ id: 'a' }, { id: 'b' }] },
          updated_by: 'user-1',
          updated_at: '2026-07-17T10:00:11Z',
        },
      ],
      error: null,
    });
    await flush();
    expect(service.worldState()['zone:user-1:hand']?.data).toEqual({
      cards: [{ id: 'a' }, { id: 'b' }],
    });
    expect(service.worldState()['zone:user-1:hand']?.t).toBe(Date.parse('2026-07-17T10:00:11Z'));
  });

  it('handles remote DELETE events, ignoring other rooms (deletes are unfiltered)', async () => {
    const { service, handlers } = setup({ rpc: ROOM_RPC });
    await service.joinByCode('ABC123', 'Tim');

    service.setWorldObject('card:c1', { name: 'Water Worm' });
    await flush(); // let the write settle — a DELETE during an own in-flight write is ignored
    handlers['world_objects']!({
      eventType: 'DELETE',
      new: {},
      old: { room_id: 'other-room', object_id: 'card:c1' },
    });
    expect(service.worldState()['card:c1']).toBeDefined();

    handlers['world_objects']!({
      eventType: 'DELETE',
      new: {},
      old: { room_id: 'r1', object_id: 'card:c1' },
    });
    expect(service.worldState()['card:c1']).toBeUndefined();
  });

  it('resumes the stored room after a reload, but not after an explicit leave', async () => {
    // Reload scenario: a previous session stored the room; a fresh service resumes it.
    localStorage.setItem(
      'virtual-tavern.resume',
      JSON.stringify({ code: 'ABC123', displayName: 'Tim' }),
    );
    const { service, p2p } = setup({ rpc: ROOM_RPC });
    expect(await service.resume()).toBe(true);
    expect(service.currentRoom()?.code).toBe('ABC123');
    expect(p2p.join).toHaveBeenCalledWith('r1', 'Tim');

    // Explicit leave clears the stored room — nothing to resume next time.
    service.leave();
    expect(localStorage.getItem('virtual-tavern.resume')).toBeNull();
    expect(await service.resume()).toBe(false);
  });

  it('seats the room creator near and joiners at the opposite table end', async () => {
    const { service } = setup({
      rpc: {
        data: [{ room_id: 'r1', room_code: 'ABC123', room_name: null, room_owner: 'user-2' }],
        error: null,
      },
    });
    expect(service.isRoomOwner()).toBe(true); // outside a room: default near side
    await service.joinByCode('ABC123', 'Tim');
    expect(service.isRoomOwner()).toBe(false); // someone else's room
    expect(service.seatYaw()).toBeCloseTo(Math.PI);
  });

  it('tolerates a pre-migration join RPC without room_owner (owner seat for all)', async () => {
    const { service } = setup({
      rpc: { data: [{ room_id: 'r1', room_code: 'ABC123', room_name: null }], error: null },
    });
    await service.joinByCode('ABC123', 'Tim');
    expect(service.currentRoom()?.ownerId).toBeNull();
    expect(service.isRoomOwner()).toBe(true);
    expect(service.seatYaw()).toBe(0);
  });

  it('does not resume when nothing is stored', async () => {
    const { service, p2p } = setup({ rpc: ROOM_RPC });
    expect(await service.resume()).toBe(false);
    expect(p2p.join).not.toHaveBeenCalled();
  });

  it('leave() tears down the channel and clears all room state', async () => {
    const { service, client, p2p } = setup({ rpc: ROOM_RPC });
    await service.joinByCode('ABC123', 'Tim');

    service.leave();
    expect(service.joined()).toBe(false);
    expect(service.messages()).toEqual([]);
    expect(service.worldState()).toEqual({});
    expect(client.removeChannel).toHaveBeenCalled();
    expect(p2p.leave).toHaveBeenCalled();
  });

  describe('undo journal', () => {
    const undoKeys = (s: RoomService) =>
      Object.keys(s.worldState()).filter((id) => id.startsWith('undo:'));
    const lastMsg = (s: RoomService) => s.messages().at(-1)!;
    const remoteWorld = (
      handlers: Record<string, (p: ChangePayload) => void>,
      id: string,
      data: unknown,
      at: string,
    ) =>
      handlers['world_objects']!({
        eventType: 'UPDATE',
        new: { object_id: id, data, updated_by: 'u2', updated_at: at },
      });

    it('undoing a draw puts the card back on the deck and out of the hand', async () => {
      const { service } = setup({ rpc: ROOM_RPC });
      await service.joinByCode('ABC123', 'Tim');
      service.setWorldObjects([
        ['zone:user-1:deck', { cards: [{ id: 'a' }, { id: 'b' }] }],
        ['zone:user-1:hand', { cards: [] }],
      ]);
      service.sendAction('joined the game');
      service.setWorldObjects([
        ['zone:user-1:deck', { cards: [{ id: 'b' }] }],
        ['zone:user-1:hand', { cards: [{ id: 'a' }] }],
      ]);
      service.sendAction('drew a card');
      const draw = lastMsg(service);
      expect(service.undoable().has(draw.id)).toBe(true);

      expect(service.undoTo(draw.id)).toBe(1);
      expect(service.worldState()['zone:user-1:deck']?.data).toEqual({
        cards: [{ id: 'a' }, { id: 'b' }],
      });
      expect(service.worldState()['zone:user-1:hand']?.data).toEqual({ cards: [] });
      expect(lastMsg(service)).toMatchObject({ kind: 'action', text: 'undid 1 action' });
      expect(service.undoneIds().has(draw.id)).toBe(true);
      expect(service.undoable().has(draw.id)).toBe(false);
      expect(undoKeys(service)).toHaveLength(1); // only the join entry is left
    });

    it('a card added by the undone action is removed again, in one upsert and one delete', async () => {
      const { service, client } = setup({ rpc: ROOM_RPC });
      await service.joinByCode('ABC123', 'Tim');
      service.setWorldObject('card:keep', { name: 'Keep' });
      service.sendAction('added Keep');
      service.setWorldObject('card:new', { name: 'New' });
      service.setWorldObject('card:keep', { name: 'Keep', tapped: true });
      service.sendAction('added New and tapped Keep');
      await flush();
      const worldCalls = () => client.from.mock.calls.filter(([t]) => t === 'world_objects').length;
      const before = worldCalls();

      service.undoTo(lastMsg(service).id);
      expect(service.worldState()['card:new']).toBeUndefined();
      expect(service.worldState()['card:keep']?.data).toEqual({ name: 'Keep' });
      await flush();
      expect(worldCalls() - before).toBe(2); // restore upsert + delete (null pre-images and consumed entries)
      expect(undoKeys(service)).toHaveLength(1);
    });

    it('keeps only the newest 50 entries; the 51st oldest is pruned', async () => {
      const { service } = setup({ rpc: ROOM_RPC });
      await service.joinByCode('ABC123', 'Tim');
      const ids: string[] = [];
      for (let i = 0; i < 51; i++) {
        service.setWorldObject('card:c', { n: i });
        service.sendAction(`move ${i}`);
        ids.push(lastMsg(service).id);
      }
      expect(undoKeys(service)).toHaveLength(50);
      expect(service.undoable().size).toBe(50);
      expect(service.undoable().has(ids[0]!)).toBe(false);
      expect(service.undoable().has(ids[1]!)).toBe(true);
      expect(service.undoTo(ids[0]!)).toBe(0);
      expect(service.worldState()['card:c']?.data).toEqual({ n: 50 });
      expect(service.undoTo(ids[1]!)).toBe(50);
      expect(service.worldState()['card:c']?.data).toEqual({ n: 0 });
    });

    it("undoing across two players folds both players' entries, the oldest pre-image winning", async () => {
      const { service, handlers } = setup({ rpc: ROOM_RPC });
      await service.joinByCode('ABC123', 'Tim');
      remoteWorld(handlers, 'card:b', { name: 'old' }, '2026-07-17T10:00:00Z');
      service.setWorldObject('card:a', { name: 'a1' });
      service.sendAction('A');
      const a = lastMsg(service);

      // Player u2 changes card:b and posts a line with its journal entry.
      remoteWorld(handlers, 'card:b', { name: 'new' }, '2026-07-17T10:00:10Z');
      handlers['chat_messages']!({
        new: {
          id: 'm-u2',
          sender_id: 'u2',
          sender_name: 'Ana',
          text: 'moved B',
          kind: 'action',
          created_at: '2026-07-17T10:00:10Z',
        },
      });
      remoteWorld(
        handlers,
        'undo:m-u2',
        { msg: 'm-u2', t: Date.now(), by: 'u2', before: { 'card:b': { name: 'old' } } },
        '2026-07-17T10:00:11Z',
      );

      service.setWorldObject('card:a', { name: 'a2' });
      service.sendAction('C');
      expect([...service.undoable()]).toEqual([a.id, 'm-u2', lastMsg(service).id]);

      // Undoing u2's line also takes my newer action back, but keeps A.
      expect(service.undoTo('m-u2')).toBe(2);
      expect(service.worldState()['card:a']?.data).toEqual({ name: 'a1' });
      expect(service.worldState()['card:b']?.data).toEqual({ name: 'old' });
      expect(service.undoable().has(a.id)).toBe(true);
      expect(service.undoTo(a.id)).toBe(1);
      expect(service.worldState()['card:a']).toBeUndefined();
    });

    it('silent writes are stored after a short delay on the latest action line', async () => {
      vi.useFakeTimers();
      const { service } = setup({ rpc: ROOM_RPC });
      await service.joinByCode('ABC123', 'Tim');
      service.setWorldObject('life:user-1', { life: 20, start: 20 });
      service.sendAction('chose 20 life');
      const line = lastMsg(service);

      service.setWorldObject('life:user-1', { life: 19, start: 20 }); // silent bump
      expect(undoKeys(service)).toHaveLength(1);
      vi.advanceTimersByTime(2000);
      expect(undoKeys(service)).toHaveLength(2);

      service.undoTo(line.id);
      expect(service.worldState()['life:user-1']).toBeUndefined();
    });

    it('silent writes before any action line wait for the first one', async () => {
      vi.useFakeTimers();
      const { service } = setup({ rpc: ROOM_RPC });
      await service.joinByCode('ABC123', 'Tim');
      service.setWorldObject('life:user-1', { life: 20 });
      vi.advanceTimersByTime(5000);
      expect(undoKeys(service)).toHaveLength(0);

      service.sendAction('first');
      const [entry] = undoKeys(service);
      expect(service.worldState()[entry!]?.data['before']).toEqual({ 'life:user-1': null });
    });
  });

  describe('room lifecycle (perstistance.md)', () => {
    const closeCalls = (client: { rpc: ReturnType<typeof vi.fn> }) =>
      client.rpc.mock.calls.filter(([fn]) => fn === 'close_room');

    it('the last player leaving closes the room (chat and world cascade server-side)', async () => {
      const { service, client, presence, presenceKey } = setup({ rpc: ROOM_RPC });
      await service.joinByCode('ABC123', 'Tim');
      presence[presenceKey()] = [{ uid: 'user-1' }]; // presence synced: only me

      service.leave();
      expect(closeCalls(client)).toEqual([['close_room', { p_room_id: 'r1' }]]);
    });

    it('leaving while someone else is still present does not close the room', async () => {
      const { service, client, presence, presenceKey } = setup({ rpc: ROOM_RPC });
      await service.joinByCode('ABC123', 'Tim');
      presence[presenceKey()] = [{ uid: 'user-1' }];
      presence['other-tab'] = [{ uid: 'u2' }];

      service.leave();
      expect(closeCalls(client)).toEqual([]);
    });

    it('leaving before presence ever synced leaves the room to the stale sweep', async () => {
      const { service, client } = setup({ rpc: ROOM_RPC });
      await service.joinByCode('ABC123', 'Tim');
      // presence stays empty: this tab never saw itself on the channel

      service.leave();
      expect(closeCalls(client)).toEqual([]);
    });

    it('joining tracks presence, stamps the room alive, and sweeps stale rooms', async () => {
      const { service, client, channel, presenceKey } = setup({ rpc: ROOM_RPC });
      await service.joinByCode('ABC123', 'Tim');
      expect(presenceKey()).not.toBe(''); // a per-tab presence key was configured
      expect(channel.track).toHaveBeenCalledWith({ uid: 'user-1' });
      expect(client.rpc).toHaveBeenCalledWith('touch_room', { p_room_id: 'r1' });
      await flush();
      expect(client.rpc).toHaveBeenCalledWith('cleanup_stale_rooms', undefined);
    });

    it('a heartbeat keeps stamping the room while joined and stops on leave', async () => {
      vi.useFakeTimers(); // before the join, so the interval is a fake timer
      const { service, client } = setup({ rpc: ROOM_RPC });
      await service.joinByCode('ABC123', 'Tim');
      const touches = () => client.rpc.mock.calls.filter(([fn]) => fn === 'touch_room').length;
      const before = touches();

      vi.advanceTimersByTime(5 * 60_000);
      expect(touches()).toBe(before + 1);

      service.leave();
      vi.advanceTimersByTime(30 * 60_000);
      expect(touches()).toBe(before + 1); // heartbeat stopped with the room
    });
  });
});
