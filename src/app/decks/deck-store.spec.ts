import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { SupabaseService } from '../supabase/supabase.service';
import { DeckStore } from './deck-store';

const LEGACY_DECKS_KEY = 'virtual-tavern.decks';

type QueryResult = { data: unknown; error: { message: string } | null };
type Call = { method: string; args: unknown[] };

/** Chainable thenable stub standing in for a PostgREST query builder,
 * recording every chained call for assertions. */
function makeQuery(result: QueryResult, calls: Call[]): unknown {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const proxy: any = new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === 'then') {
        return (resolve: (v: QueryResult) => unknown) => Promise.resolve(result).then(resolve);
      }
      return (...args: unknown[]) => {
        calls.push({ method: String(prop), args });
        return proxy;
      };
    },
  });
  return proxy;
}

function setup(opts: { guest?: boolean; signedOut?: boolean; results?: QueryResult[] } = {}) {
  const results = opts.results ?? [];
  const calls: Call[] = [];
  const client = {
    from: vi.fn((table: string) => {
      calls.push({ method: 'from', args: [table] });
      return makeQuery(results.shift() ?? { data: [], error: null }, calls);
    }),
  };
  const supabase = {
    client,
    userId: () => (opts.signedOut ? null : 'user-1'),
    isGuest: () => opts.guest ?? false,
  };
  TestBed.configureTestingModule({
    providers: [{ provide: SupabaseService, useValue: supabase }],
  });
  const store = TestBed.inject(DeckStore);
  TestBed.tick(); // run the session-follow effect (kicks off the initial load)
  return { store, client, calls };
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r));
};

describe('DeckStore', () => {
  beforeEach(() => localStorage.clear());

  it('loads the signed-in account’s decks, dropping malformed rows', async () => {
    const good = { id: 'd1', name: 'Burn', list: [{ card: 'Lightning Bolt', count: 4 }] };
    const { store } = setup({
      results: [{ data: [good, { id: 'broken' }], error: null }],
    });
    await flush();
    expect(store.decks()).toEqual([good]);
    expect(store.available()).toBe(true);
  });

  it('guests have no decks and cannot import', async () => {
    const { store, client } = setup({ guest: true });
    await flush();
    expect(store.available()).toBe(false);
    expect(client.from).not.toHaveBeenCalled();
    expect(await store.import('Burn', '4 Lightning Bolt')).toMatch(/account/);
    expect(store.decks()).toEqual([]);
  });

  it('imports a parsed decklist and stores it on the account', async () => {
    const { store, calls } = setup();
    await flush();
    expect(await store.import('Burn', '4 Lightning Bolt\n2 Shock')).toBeNull();
    expect(store.decks()).toMatchObject([
      {
        name: 'Burn',
        list: [
          { card: 'Lightning Bolt', count: 4 },
          { card: 'Shock', count: 2 },
        ],
      },
    ]);
    const insert = calls.find((c) => c.method === 'insert')!;
    expect(insert.args[0]).toMatchObject({ owner_id: 'user-1', name: 'Burn' });
  });

  it('rejects an unparseable list without touching the backend', async () => {
    const { store, calls } = setup();
    await flush();
    calls.length = 0;
    expect(await store.import('Empty', '// nothing here')).toMatch(/No cards found/);
    expect(store.decks()).toEqual([]);
    expect(calls.find((c) => c.method === 'insert')).toBeUndefined();
  });

  it('falls back to an "Unnamed deck" name', async () => {
    const { store } = setup();
    await flush();
    await store.import('  ', '1 Island');
    expect(store.decks()[0]!.name).toBe('Unnamed deck');
  });

  it('rolls back the optimistic deck when the insert fails', async () => {
    const { store } = setup({
      results: [
        { data: [], error: null }, // initial load
        { data: null, error: { message: 'nope' } }, // failing insert
      ],
    });
    await flush();
    expect(await store.import('Burn', '4 Lightning Bolt')).toBe('nope');
    expect(store.decks()).toEqual([]);
  });

  it('remove deletes the deck optimistically and on the backend', async () => {
    const deck = { id: 'd1', name: 'Keep', list: [{ card: 'Island', count: 1 }] };
    const { store, calls } = setup({ results: [{ data: [deck], error: null }] });
    await flush();
    store.remove('d1');
    expect(store.decks()).toEqual([]);
    expect(calls.find((c) => c.method === 'delete')).toBeDefined();
  });

  it('uploads legacy localStorage decks once, then clears the key', async () => {
    const legacy = { id: 'old1', name: 'Old Deck', list: [{ card: 'Swamp', count: 2 }] };
    localStorage.setItem(LEGACY_DECKS_KEY, JSON.stringify([legacy, { nope: true }]));
    const { store, calls } = setup();
    await flush();
    expect(store.decks()).toEqual([legacy]);
    const insert = calls.find((c) => c.method === 'insert')!;
    expect(insert.args[0]).toMatchObject([{ id: 'old1', owner_id: 'user-1', name: 'Old Deck' }]);
    expect(localStorage.getItem(LEGACY_DECKS_KEY)).toBeNull();
  });
});
