import { TestBed } from '@angular/core/testing';
import { afterEach, vi } from 'vitest';
import { CardApiService } from '../../carddb/card-api.service';
import { CardSearchService } from './card-search.service';

function scryfallResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

describe('CardSearchService', () => {
  let service: CardSearchService;
  let fetchMock: ReturnType<typeof vi.fn>;
  /** The user-deposited API base (legal.md); null = nothing deposited. */
  let apiUrl: string | null;

  beforeEach(() => {
    apiUrl = 'https://api.example.com';
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    TestBed.configureTestingModule({
      providers: [{ provide: CardApiService, useValue: { apiUrl: () => apiUrl } }],
    });
    service = TestBed.inject(CardSearchService);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('maps hits to name + image + related, using the first face for double-faced cards', async () => {
    fetchMock.mockResolvedValue(
      scryfallResponse(200, {
        data: [
          {
            name: 'Water Worm',
            image_uris: { normal: 'https://img/worm.jpg' },
            // all_parts includes the card itself — only the others are related.
            all_parts: [{ name: 'Water Worm' }, { name: 'Worm Token' }],
          },
          { name: 'Delver', card_faces: [{ image_uris: { normal: 'https://img/delver.jpg' } }] },
          { name: 'No Image' },
        ],
      }),
    );
    expect(await service.search('worm')).toEqual([
      { name: 'Water Worm', src: 'https://img/worm.jpg', related: ['Worm Token'] },
      { name: 'Delver', src: 'https://img/delver.jpg', related: [] },
    ]);
    // The query goes to the deposited API, not any baked-in endpoint — and asks
    // for extras, so tokens show up in the results (moreimprovements.md).
    expect(fetchMock.mock.calls[0]![0]).toContain('https://api.example.com/cards/search');
    expect(fetchMock.mock.calls[0]![0]).toContain('q=worm');
    expect(fetchMock.mock.calls[0]![0]).toContain('include_extras=true');
  });

  it('carries both faces of a double-faced hit, and none for a split card (mdfcs.md)', async () => {
    fetchMock.mockResolvedValue(
      scryfallResponse(200, {
        data: [
          {
            name: 'Delver of Secrets // Insectile Aberration',
            card_faces: [
              { image_uris: { normal: 'https://img/delver.jpg' } },
              { image_uris: { normal: 'https://img/aberration.jpg' } },
            ],
          },
          // Two halves, one image: reads as "A // B" but has no other side.
          {
            name: 'Fire // Ice',
            image_uris: { normal: 'https://img/fire-ice.jpg' },
            card_faces: [{}, {}],
          },
        ],
      }),
    );
    expect(await service.search('delver')).toEqual([
      {
        name: 'Delver of Secrets // Insectile Aberration',
        src: 'https://img/delver.jpg',
        back: 'https://img/aberration.jpg',
        related: [],
      },
      { name: 'Fire // Ice', src: 'https://img/fire-ice.jpg', related: [] },
    ]);
  });

  it('refuses to search while no API has been deposited (legal.md)', async () => {
    apiUrl = null;
    await expect(service.search('worm')).rejects.toThrow('No card API deposited');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('caches per query and skips queries under 2 characters', async () => {
    fetchMock.mockResolvedValue(scryfallResponse(200, { data: [] }));
    await service.search('worm');
    await service.search('  Worm '); // trimmed + case-insensitive cache key
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await service.search('w')).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('treats Scryfall 404 as no matches and throws on other failures', async () => {
    fetchMock.mockResolvedValueOnce(scryfallResponse(404, {}));
    expect(await service.search('nothing')).toEqual([]);
    fetchMock.mockResolvedValueOnce(scryfallResponse(500, {}));
    await expect(service.search('boom')).rejects.toThrow('Card search failed (500)');
  });
});
