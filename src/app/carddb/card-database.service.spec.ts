import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { CardDbCache } from './card-db-cache';
import { CardDatabaseService, CardRecord } from './card-database.service';

/** In-memory stand-in for the IndexedDB cache (jsdom has no IndexedDB). */
class FakeCache {
  readonly store = new Map<string, unknown>();
  async get<T>(key: string): Promise<T | undefined> {
    return this.store.get(key) as T | undefined;
  }
  async put(key: string, value: unknown): Promise<void> {
    this.store.set(key, value);
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

const BULK = JSON.stringify([
  { name: 'Lightning Bolt', image_uris: { normal: 'https://img/bolt.jpg' } },
  // A reprint of the same card must not overwrite the first printing.
  { name: 'Lightning Bolt', image_uris: { normal: 'https://img/bolt-reprint.jpg' } },
  // Double-faced: image lives on the front face; resolvable by front name too.
  {
    name: 'Delver of Secrets // Insectile Aberration',
    card_faces: [{ image_uris: { normal: 'https://img/delver.jpg' } }, {}],
  },
  { object: 'card' }, // nameless junk is skipped
]);

describe('CardDatabaseService', () => {
  let cache: FakeCache;
  let service: CardDatabaseService;

  beforeEach(() => {
    cache = new FakeCache();
    TestBed.configureTestingModule({
      providers: [{ provide: CardDbCache, useValue: cache }],
    });
    service = TestBed.inject(CardDatabaseService);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('downloads and indexes the bulk file on first run, then caches the index', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => bulkResponse(BULK)));
    await service.init();
    expect(service.status()).toBe('ready');
    expect(service.lookup('lightning bolt')).toEqual({
      name: 'Lightning Bolt',
      src: 'https://img/bolt.jpg',
    });
    expect(service.lookup('Delver of Secrets')!.src).toBe('https://img/delver.jpg');
    expect(service.lookup('Delver of Secrets // Insectile Aberration')).toBeDefined();
    expect(service.lookup('No Such Card')).toBeUndefined();
    expect(service.progress()).toBe(1);
    expect(cache.store.size).toBe(1); // index persisted for the next start
  });

  it('serves from the cache without downloading', async () => {
    const index: Record<string, CardRecord> = {
      'cached card': { name: 'Cached Card', src: 'https://img/cached.jpg' },
    };
    cache.get = async <T>() => index as T; // cache hit regardless of internal key
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await service.init();
    expect(service.status()).toBe('ready');
    expect(service.cardCount()).toBe(1);
    expect(service.lookup('Cached Card')).toEqual(index['cached card']);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('reports an error status when the download fails, app keeps working', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 503, headers: { get: () => null }, body: null })),
    );
    await service.init();
    expect(service.status()).toBe('error');
    expect(service.lookup('anything')).toBeUndefined();
  });

  it('init is idempotent: repeated calls share one run', async () => {
    const fetchSpy = vi.fn(async () => bulkResponse(BULK));
    vi.stubGlobal('fetch', fetchSpy);
    await Promise.all([service.init(), service.init()]);
    await service.init();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
