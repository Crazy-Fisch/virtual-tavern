import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { CardPrintService } from '../carddb/card-print.service';
import { SupabaseService } from '../supabase/supabase.service';
import { BuiltInDecks } from './built-in-decks';
import { DeckStore } from './deck-store';
import { Deck } from './deck.types';

const LOCAL_DECKS_KEY = 'virtual-tavern.decks';

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

function setup(
  opts: {
    guest?: boolean;
    signedOut?: boolean;
    results?: QueryResult[];
    /** Decks the app ships with, normally fetched from public/decks. */
    builtIn?: Deck[];
  } = {},
) {
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
    providers: [
      { provide: SupabaseService, useValue: supabase },
      { provide: CardPrintService, useValue: { resolveEntries: async (list: unknown) => list } },
      // Stubbed at the service seam: the real one fetches over the network.
      {
        provide: BuiltInDecks,
        useValue: { decks: signal(opts.builtIn ?? []), loaded: signal(true) },
      },
    ],
  });
  const store = TestBed.inject(DeckStore);
  TestBed.tick(); // run the session-follow effect (kicks off the initial load)
  return { store, client, calls };
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r));
};

const readLocal = (): unknown[] => {
  const raw = localStorage.getItem(LOCAL_DECKS_KEY);
  return raw ? (JSON.parse(raw) as unknown[]) : [];
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

  it('guests keep decks locally and can import (no backend calls)', async () => {
    const { store, client } = setup({ guest: true });
    await flush();
    expect(store.available()).toBe(true);
    expect(await store.import('Burn', '4 Lightning Bolt')).toBeNull();
    expect(store.decks()).toMatchObject([{ name: 'Burn' }]);
    expect(client.from).not.toHaveBeenCalled();
    expect(readLocal()).toHaveLength(1);
  });

  it('a returning guest loads their decks from localStorage', async () => {
    const local = { id: 'g1', name: 'Local', list: [{ card: 'Forest', count: 3 }] };
    localStorage.setItem(LOCAL_DECKS_KEY, JSON.stringify([local]));
    const { store, client } = setup({ guest: true });
    await flush();
    expect(store.decks()).toEqual([local]);
    expect(client.from).not.toHaveBeenCalled();
  });

  it('signed-out visitors have no decks and cannot import', async () => {
    const { store, client } = setup({ signedOut: true });
    await flush();
    expect(store.available()).toBe(false);
    expect(await store.import('Burn', '4 Lightning Bolt')).toMatch(/Sign in/);
    expect(store.decks()).toEqual([]);
    expect(client.from).not.toHaveBeenCalled();
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

  it('rolls back the optimistic deck when the account insert fails', async () => {
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

  it('renames an account deck optimistically and on the backend', async () => {
    const deck = { id: 'd1', name: 'Old', list: [{ card: 'Island', count: 1 }] };
    const { store, calls } = setup({ results: [{ data: [deck], error: null }] });
    await flush();
    store.rename('d1', 'New Name');
    expect(store.decks()[0]!.name).toBe('New Name');
    const update = calls.find((c) => c.method === 'update')!;
    expect(update.args[0]).toMatchObject({ name: 'New Name' });
  });

  it('renames a guest deck in localStorage', async () => {
    const local = { id: 'g1', name: 'Old', list: [{ card: 'Forest', count: 3 }] };
    localStorage.setItem(LOCAL_DECKS_KEY, JSON.stringify([local]));
    const { store, client } = setup({ guest: true });
    await flush();
    store.rename('g1', 'Renamed');
    expect(store.decks()[0]!.name).toBe('Renamed');
    expect((readLocal()[0] as { name: string }).name).toBe('Renamed');
    expect(client.from).not.toHaveBeenCalled();
  });

  it('remove deletes the deck optimistically and on the backend', async () => {
    const deck = { id: 'd1', name: 'Keep', list: [{ card: 'Island', count: 1 }] };
    const { store, calls } = setup({ results: [{ data: [deck], error: null }] });
    await flush();
    store.remove('d1');
    expect(store.decks()).toEqual([]);
    expect(calls.find((c) => c.method === 'delete')).toBeDefined();
  });

  it('every user gets the shipped decks, listed before their own', async () => {
    const shipped: Deck = {
      id: 'builtin:red_dragons.txt',
      name: 'Red Dragons',
      list: [{ card: 'Mountain', count: 22 }],
    };
    const { store } = setup({ guest: true, builtIn: [shipped] });
    await flush();
    expect(store.decks()).toEqual([shipped]);

    await store.import('Mine', '1 Island');
    expect(store.decks().map((d) => d.name)).toEqual(['Red Dragons', 'Mine']);
    // Shipped decks are read at load time, never copied into the player's store.
    expect(store.ownDecks().map((d) => d.name)).toEqual(['Mine']);
    expect(readLocal()).toHaveLength(1);
  });

  it('a shipped deck cannot be renamed or deleted', async () => {
    const shipped: Deck = {
      id: 'builtin:burn.txt',
      name: 'Burn',
      list: [{ card: 'Shock', count: 4 }],
    };
    const { store, calls } = setup({ builtIn: [shipped] });
    await flush();
    calls.length = 0;

    store.rename('builtin:burn.txt', 'Not Burn');
    store.remove('builtin:burn.txt');
    expect(store.decks()).toEqual([shipped]);
    expect(calls).toEqual([]); // and nothing was written anywhere
    expect(readLocal()).toEqual([]);
  });

  it('uploads a guest’s local decks into a new account on sign-in, then clears local', async () => {
    const local = { id: 'old1', name: 'Old Deck', list: [{ card: 'Swamp', count: 2 }] };
    localStorage.setItem(LOCAL_DECKS_KEY, JSON.stringify([local, { nope: true }]));
    const { store, calls } = setup(); // account load with no server decks yet
    await flush();
    expect(store.decks()).toEqual([local]);
    const insert = calls.find((c) => c.method === 'insert')!;
    expect(insert.args[0]).toMatchObject([{ id: 'old1', owner_id: 'user-1', name: 'Old Deck' }]);
    expect(localStorage.getItem(LOCAL_DECKS_KEY)).toBeNull();
  });
});
