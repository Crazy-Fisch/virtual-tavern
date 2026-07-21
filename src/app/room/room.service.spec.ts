import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { P2pService } from '../p2p/p2p.service';
import { SupabaseService } from '../supabase/supabase.service';
import { RoomService } from './room.service';

type QueryResult = { data: unknown; error: { message: string } | null };

/** Chainable thenable stub standing in for a PostgREST query builder. */
function makeQuery(result: QueryResult): unknown {
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

function setup(opts: { rpc?: QueryResult; tables?: Record<string, QueryResult[]> } = {}) {
  const tables = opts.tables ?? {};
  const handlers: Record<string, (payload: ChangePayload) => void> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const channel: any = {
    on: vi.fn((_ev: string, filter: { table: string }, cb: (p: ChangePayload) => void) => {
      handlers[filter.table] = cb;
      return channel;
    }),
    subscribe: vi.fn(() => channel),
  };
  const client = {
    from: vi.fn((table: string) => {
      const queued = (tables[table] ?? []).shift();
      return makeQuery(queued ?? { data: [], error: null });
    }),
    rpc: vi.fn(async () => opts.rpc ?? { data: [], error: null }),
    channel: vi.fn(() => channel),
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
  return { service: TestBed.inject(RoomService), client, handlers, p2p };
}

const flush = () => new Promise((r) => setTimeout(r));

describe('RoomService', () => {
  beforeEach(() => localStorage.clear());
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

  it('handles remote DELETE events, ignoring other rooms (deletes are unfiltered)', async () => {
    const { service, handlers } = setup({ rpc: ROOM_RPC });
    await service.joinByCode('ABC123', 'Tim');

    service.setWorldObject('card:c1', { name: 'Water Worm' });
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
});
