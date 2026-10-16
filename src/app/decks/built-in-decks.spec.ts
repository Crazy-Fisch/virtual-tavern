import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, vi } from 'vitest';
import { BuiltInDecks, deckNameFromFile } from './built-in-decks';

/** Files the fake server has, by URL. Anything else 404s. */
type Server = Record<string, string>;

function serve(files: Server): void {
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => {
      const body = files[url];
      if (body === undefined) {
        return Promise.resolve({ ok: false, status: 404 } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(body),
        json: () => Promise.resolve(JSON.parse(body) as unknown),
      } as Response);
    }),
  );
}

const load = async (): Promise<BuiltInDecks> => {
  TestBed.configureTestingModule({});
  const decks = TestBed.inject(BuiltInDecks); // the constructor kicks off the load
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r));
  return decks;
};

describe('BuiltInDecks', () => {
  beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => undefined));
  afterEach(() => vi.unstubAllGlobals());

  it('loads every decklist named in the manifest, in manifest order', async () => {
    serve({
      'decks/index.json': '["red_dragons.txt", "green_dinosaurs.txt"]',
      'decks/red_dragons.txt': '4x Lightning Strike (dmu) 137 [Instant]\n22x Mountain (mom) 280',
      'decks/green_dinosaurs.txt': '4 Llanowar Elves\n24 Forest',
    });
    const service = await load();
    expect(service.loaded()).toBe(true);
    expect(service.decks()).toEqual([
      {
        id: 'builtin:red_dragons.txt',
        name: 'Red Dragons',
        list: [
          { card: 'Lightning Strike', count: 4, print: { set: 'dmu', collector: '137' } },
          { card: 'Mountain', count: 22, print: { set: 'mom', collector: '280' } },
        ],
      },
      {
        id: 'builtin:green_dinosaurs.txt',
        name: 'Green Dinosaurs',
        list: [
          { card: 'Llanowar Elves', count: 4 },
          { card: 'Forest', count: 24 },
        ],
      },
    ]);
  });

  it('a missing or empty decklist costs that deck and nothing else', async () => {
    serve({
      'decks/index.json': '["gone.txt", "blank.txt", "ok.txt"]',
      'decks/blank.txt': '// nothing but a comment\n',
      'decks/ok.txt': '1 Island',
    });
    const service = await load();
    expect(service.decks().map((d) => d.id)).toEqual(['builtin:ok.txt']);
  });

  it('ships nothing (and does not throw) when there is no manifest', async () => {
    serve({});
    const service = await load();
    expect(service.decks()).toEqual([]);
    expect(service.loaded()).toBe(true);
  });

  it('names a deck after its file', () => {
    expect(deckNameFromFile('black_demons.txt')).toBe('Black Demons');
    expect(deckNameFromFile('mono-white-weenie.TXT')).toBe('Mono White Weenie');
    expect(deckNameFromFile('burn.txt')).toBe('Burn');
  });
});
