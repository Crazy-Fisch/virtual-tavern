import { WritableSignal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { CardApiService } from './card-api.service';
import { CardDatabaseService, CardRecord } from './card-database.service';
import { CardDbCache } from './card-db-cache';

/** In-memory stand-in for the IndexedDB cache (jsdom has no IndexedDB). */
class FakeCache {
  readonly store = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.store.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }
}

/** A Response-alike streaming `text` in small byte chunks. */
function bulkResponse(text: string, chunkSize = 11): unknown {
  const bytes = new TextEncoder().encode(text);
  let offset = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: () => String(bytes.length) },
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.length) controller.close();
        else {
          controller.enqueue(bytes.slice(offset, offset + chunkSize));
          offset += chunkSize;
        }
      },
    }),
  };
}

/** Response-alike for the deposited API's /bulk-data listing. */
function listingResponse(
  defaultCards: Record<string, string> = {
    download_uri: 'https://api.example.com/files/default.json',
  },
): unknown {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      data: [
        { type: 'oracle_cards', download_uri: 'https://api.example.com/files/oracle.json' },
        { type: 'default_cards', ...defaultCards },
      ],
    }),
  };
}

/** A Response-alike serving pre-built byte chunks (e.g. a gzipped file). */
function byteResponse(chunks: Uint8Array[]): unknown {
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  return {
    ok: true,
    status: 200,
    headers: { get: () => String(total) },
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
  };
}

/** Gzip text the way a .json.gz / .jsonl.gz bulk file is stored. */
async function gzipChunks(text: string): Promise<Uint8Array[]> {
  const source = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
  const gzip = new CompressionStream('gzip') as unknown as ReadableWritablePair<
    Uint8Array,
    Uint8Array
  >;
  const reader = source.pipeThrough(gzip).getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
}

const BULK = JSON.stringify([
  { name: 'Lightning Bolt', image_uris: { normal: 'https://img/bolt.jpg' } },
  // A reprint of the same card must not overwrite the first printing.
  { name: 'Lightning Bolt', image_uris: { normal: 'https://img/bolt-reprint.jpg' } },
  // Double-faced: an image per face, no whole-card one; resolvable by front name too.
  {
    name: 'Delver of Secrets // Insectile Aberration',
    card_faces: [
      { image_uris: { normal: 'https://img/delver.jpg' } },
      { image_uris: { normal: 'https://img/aberration.jpg' } },
    ],
  },
  // Split card: two halves, but ONE image — it is not double-faced and must
  // get no back, or the table would offer to flip it (mdfcs.md).
  {
    name: 'Fire // Ice',
    image_uris: { normal: 'https://img/fire-ice.jpg' },
    card_faces: [{}, {}],
  },
  // Related cards: all_parts names (minus the card itself) are kept, and the
  // token they point at is an ordinary card object that indexes like any other.
  {
    name: 'Wormcaller',
    image_uris: { normal: 'https://img/wormcaller.jpg' },
    all_parts: [{ name: 'Wormcaller' }, { name: 'Worm Token' }],
  },
  { name: 'Worm Token', image_uris: { normal: 'https://img/worm-token.jpg' } },
  { object: 'card' }, // nameless junk is skipped
]);

const flush = () => new Promise((r) => setTimeout(r));

describe('CardDatabaseService', () => {
  let cache: FakeCache;
  /** The user-deposited API base (legal.md); the service follows this signal. */
  let apiUrl: WritableSignal<string | null>;
  let service: CardDatabaseService;

  beforeEach(() => {
    cache = new FakeCache();
    apiUrl = signal<string | null>(null);
    TestBed.configureTestingModule({
      providers: [
        { provide: CardDbCache, useValue: cache },
        { provide: CardApiService, useValue: { apiUrl } },
      ],
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  /** Create the service (its constructor effect starts following apiUrl). */
  const init = () => (service = TestBed.inject(CardDatabaseService));

  /** Route fetches: the /bulk-data listing, then the bulk file itself. */
  function stubApi(
    bulk: unknown = bulkResponse(BULK),
    listing: unknown = listingResponse(),
  ): ReturnType<typeof vi.fn> {
    const fetchMock = vi.fn(async (url: unknown) => {
      if (String(url).endsWith('/bulk-data')) return listing;
      return bulk;
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  }

  it('stays idle and empty while no API is deposited (legal.md)', async () => {
    const fetchMock = stubApi();
    init();
    await flush();
    expect(service.status()).toBe('idle');
    expect(service.lookup('Lightning Bolt')).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a deposited API is resolved via its /bulk-data listing, indexed, and cached', async () => {
    const fetchMock = stubApi();
    init();
    apiUrl.set('https://api.example.com');
    await vi.waitFor(() => expect(service.status()).toBe('ready'));
    expect(fetchMock.mock.calls[0]![0]).toBe('https://api.example.com/bulk-data');
    expect(fetchMock.mock.calls[1]![0]).toBe('https://api.example.com/files/default.json');
    expect(service.lookup('lightning bolt')).toEqual({
      name: 'Lightning Bolt',
      src: 'https://img/bolt.jpg',
    });
    expect(service.lookup('Delver of Secrets')!.src).toBe('https://img/delver.jpg');
    expect(service.lookup('No Such Card')).toBeUndefined();
    // Both faces of a double-faced card, reachable by the front name a decklist
    // carries; a split card's single image gives no second face (mdfcs.md).
    expect(service.lookup('Delver of Secrets')!.back).toBe('https://img/aberration.jpg');
    expect(service.lookup('delver of secrets // insectile aberration')!.back).toBe(
      'https://img/aberration.jpg',
    );
    expect(service.lookup('Fire // Ice')!.back).toBeUndefined();
    expect(service.lookup('Fire')!.src).toBe('https://img/fire-ice.jpg');
    // Related names (all_parts minus self) resolve, incl. the token they name.
    expect(service.lookup('Wormcaller')!.related).toEqual(['Worm Token']);
    expect(service.lookup('Worm Token')!.src).toBe('https://img/worm-token.jpg');
    expect(service.progress()).toBe(1);
    expect(cache.store.has('index:v4:https://api.example.com')).toBe(true);
  });

  it('indexes a JSON Lines export offered via jsonl_download_uri', async () => {
    const jsonl =
      JSON.stringify({ name: 'Lightning Bolt', image_uris: { normal: 'https://img/bolt.jpg' } }) +
      '\n' +
      JSON.stringify({ name: 'Counterspell', image_uris: { normal: 'https://img/cs.jpg' } }) +
      '\n';
    const fetchMock = stubApi(
      bulkResponse(jsonl),
      listingResponse({ jsonl_download_uri: 'https://api.example.com/files/default.jsonl' }),
    );
    init();
    apiUrl.set('https://api.example.com');
    await vi.waitFor(() => expect(service.status()).toBe('ready'));
    expect(fetchMock.mock.calls[1]![0]).toBe('https://api.example.com/files/default.jsonl');
    expect(service.cardCount()).toBe(2);
    expect(service.lookup('Counterspell')!.src).toBe('https://img/cs.jpg');
  });

  it('inflates a gzip-compressed bulk file (.gz served raw, sniffed by magic bytes)', async () => {
    stubApi(byteResponse(await gzipChunks(BULK)));
    init();
    apiUrl.set('https://api.example.com');
    await vi.waitFor(() => expect(service.status()).toBe('ready'));
    expect(service.lookup('lightning bolt')).toEqual({
      name: 'Lightning Bolt',
      src: 'https://img/bolt.jpg',
    });
  });

  it('rejects a zstd-compressed bulk file with an error status', async () => {
    stubApi(byteResponse([new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x00])]));
    init();
    apiUrl.set('https://api.example.com');
    await vi.waitFor(() => expect(service.status()).toBe('error'));
  });

  it('serves the deposited API from the cache without downloading', async () => {
    const index: Record<string, CardRecord> = {
      'cached card': { name: 'Cached Card', src: 'https://img/cached.jpg' },
    };
    cache.store.set('index:v4:https://api.example.com', index);
    const fetchMock = stubApi();
    init();
    apiUrl.set('https://api.example.com');
    await vi.waitFor(() => expect(service.status()).toBe('ready'));
    expect(service.cardCount()).toBe(1);
    expect(service.lookup('Cached Card')).toEqual(index['cached card']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('older indexes (pre-related v2, pre-second-face v3) are rebuilt and dropped', async () => {
    const stale = { 'stale card': { name: 'Stale Card', src: 'https://img/stale.jpg' } };
    cache.store.set('index:v2:https://api.example.com', stale);
    cache.store.set('index:v3:https://api.example.com', stale);
    const fetchMock = stubApi();
    init();
    apiUrl.set('https://api.example.com');
    await vi.waitFor(() => expect(service.status()).toBe('ready'));
    expect(fetchMock).toHaveBeenCalled(); // neither old index satisfied v4
    expect(cache.store.has('index:v2:https://api.example.com')).toBe(false);
    expect(cache.store.has('index:v3:https://api.example.com')).toBe(false);
    expect(cache.store.has('index:v4:https://api.example.com')).toBe(true);
    expect(service.lookup('Stale Card')).toBeUndefined();
  });

  it('reports an error status when the API cannot provide the data, app keeps working', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
    );
    init();
    apiUrl.set('https://api.example.com');
    await vi.waitFor(() => expect(service.status()).toBe('error'));
    expect(service.lookup('anything')).toBeUndefined();
  });

  it('removing the deposit empties the database again', async () => {
    stubApi();
    init();
    apiUrl.set('https://api.example.com');
    await vi.waitFor(() => expect(service.status()).toBe('ready'));
    apiUrl.set(null);
    await vi.waitFor(() => expect(service.status()).toBe('idle'));
    expect(service.lookup('lightning bolt')).toBeUndefined();
    expect(service.cardCount()).toBe(0);
  });

  it('deletes the legacy app-level index cached by pre-legal.md builds', async () => {
    cache.store.set(
      'index:v1:https://data.scryfall.io/default-cards/default-cards-20260719091104.json',
      {},
    );
    stubApi();
    init();
    await flush();
    expect(cache.store.size).toBe(0);
  });
});
