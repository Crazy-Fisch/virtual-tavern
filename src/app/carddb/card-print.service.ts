import { Injectable, inject } from '@angular/core';
import { DeckEntry, DeckPrint } from '../decks/deck.types';
import { CardApiService } from './card-api.service';
import { CardDatabaseService, facesOf } from './card-database.service';
import { ApiInfoCard, CardInfo, infoKey, infoOf } from './card-info';

/** One printing of a card as offered by the artwork picker. */
export type CardPrint = {
  id: string;
  name: string;
  /** Lowercase set code. */
  set: string;
  setName: string;
  collector: string;
  /** Language code, e.g. `en`, `ja`. */
  lang: string;
  /** Release date, `YYYY-MM-DD`. */
  released: string;
  src: string;
  back?: string;
  fullArt: boolean;
  textless: boolean;
  borderless: boolean;
  promo: boolean;
};

type ApiCard = ApiInfoCard & {
  id?: string;
  name?: string;
  set?: string;
  set_name?: string;
  collector_number?: string;
  lang?: string;
  released_at?: string;
  full_art?: boolean;
  textless?: boolean;
  border_color?: string;
  promo?: boolean;
  image_uris?: { normal?: string };
  card_faces?: { image_uris?: { normal?: string } }[];
};
type ApiList = { data?: ApiCard[]; has_more?: boolean; next_page?: string };
type ApiNames = { data?: string[] };
type ApiCollection = { data?: ApiCard[]; not_found?: Identifier[] };
type Identifier = { set?: string; collector_number?: string; name?: string };

/** Scryfall asks for 50-100 ms between requests (about 10 per second at most). */
const MIN_GAP_MS = 100;
/** `/cards/collection` takes at most 75 identifiers per request. */
const COLLECTION_BATCH = 75;
/** A card's prints are capped at this many result pages (175 prints each). */
const MAX_PAGES = 3;
const HEADERS = { Accept: 'application/json;q=0.9,*/*;q=0.8' };

function printOf(card: ApiCard): CardPrint | null {
  const { src, back } = facesOf(card);
  if (!card.id || !card.name || !card.set || !src) return null;
  return {
    id: card.id,
    name: card.name,
    set: card.set,
    setName: card.set_name ?? card.set.toUpperCase(),
    collector: card.collector_number ?? '',
    lang: card.lang ?? 'en',
    released: card.released_at ?? '',
    src,
    ...(back ? { back } : {}),
    fullArt: !!card.full_art,
    textless: !!card.textless,
    borderless: card.border_color === 'borderless',
    promo: !!card.promo,
  };
}

/** The deck-side record of a print: what is stored with a deck entry. */
export function toDeckPrint(print: CardPrint): DeckPrint {
  return {
    set: print.set,
    collector: print.collector,
    id: print.id,
    src: print.src,
    ...(print.back ? { back: print.back } : {}),
  };
}

function frontName(name: string): string {
  return name.split(' // ')[0]!.trim().toLowerCase();
}

/**
 * Print-level card data from the user-deposited card API (legal.md): resolves
 * the `(SET) number` of an imported decklist to the exact printing's image,
 * lists a card's English prints for the artwork picker, and finds a readable
 * default print by name. Requests are spaced `MIN_GAP_MS` apart, send an
 * `Accept` header (a browser sets its own `User-Agent` and does not let scripts
 * change it), and results are cached for the app's lifetime per API base.
 */
@Injectable({ providedIn: 'root' })
export class CardPrintService {
  private readonly api = inject(CardApiService);
  private readonly db = inject(CardDatabaseService);
  private readonly cache = new Map<string, unknown>();
  private queue: Promise<unknown> = Promise.resolve();
  private lastRequest = 0;

  /**
   * Prints of a card, newest first (`order=released`), with the full-art /
   * textless / borderless flags the picker shows: English only, or every
   * language with `allLanguages`. Empty when the card is unknown; throws on a
   * network or API failure.
   */
  async listPrints(name: string, signal?: AbortSignal, allLanguages = false): Promise<CardPrint[]> {
    const base = this.requireBase();
    const query = `!"${name.replace(/"/g, '')}" lang:${allLanguages ? 'any' : 'en'}`;
    const key = `prints|${base}|${query}`;
    const cached = this.cache.get(key) as CardPrint[] | undefined;
    if (cached) return cached;
    const prints = (await this.search(base, query, signal, true))
      .map(printOf)
      .filter((p): p is CardPrint => !!p);
    this.cache.set(key, prints);
    return prints;
  }

  /**
   * The print to show for a card nobody chose art for: English, a normal frame
   * with readable text (no full-art, textless or borderless), earliest paper
   * printing first. Falls back to any English print, then to any print, when
   * the card has no such one. Null when the card is unknown.
   */
  async defaultPrint(name: string, signal?: AbortSignal): Promise<CardPrint | null> {
    const base = this.requireBase();
    const exact = `!"${name.replace(/"/g, '')}"`;
    const key = `default|${base}|${exact}`;
    if (this.cache.has(key)) return this.cache.get(key) as CardPrint | null;
    const queries = [
      `${exact} lang:en -is:full -is:textless -border:borderless game:paper`,
      `${exact} lang:en`,
      exact,
    ];
    let found: CardPrint | null = null;
    for (const q of queries) {
      const first = (await this.search(base, q, signal, false)).map(printOf).find((p) => !!p);
      if (first) {
        found = first;
        break;
      }
    }
    this.cache.set(key, found);
    return found;
  }

  /**
   * Names the API completes `query` to (`/cards/autocomplete`, at most 20).
   * Empty below two characters; throws on a network or API failure.
   */
  async autocomplete(query: string, signal?: AbortSignal): Promise<string[]> {
    const q = query.trim();
    if (q.length < 2) return [];
    const base = this.requireBase();
    const key = `auto|${base}|${q.toLowerCase()}`;
    const cached = this.cache.get(key) as string[] | undefined;
    if (cached) return cached;
    const body = await this.getJson<ApiNames>(
      `${base}/cards/autocomplete?q=${encodeURIComponent(q)}`,
      signal,
      true,
    );
    const names = body?.data ?? [];
    this.cache.set(key, names);
    return names;
  }

  /**
   * One page (up to 175) of `/cards/search` results, one card per name, with
   * `more` set when a further page exists. A query nothing matched yields an
   * empty page; throws on a network or API failure.
   */
  async searchCards(
    query: string,
    page = 1,
    signal?: AbortSignal,
  ): Promise<{ cards: CardInfo[]; more: boolean }> {
    const base = this.requireBase();
    const q = query.trim();
    const key = `cards|${base}|${page}|${q.toLowerCase()}`;
    const cached = this.cache.get(key) as { cards: CardInfo[]; more: boolean } | undefined;
    if (cached) return cached;
    const url = `${base}/cards/search?q=${encodeURIComponent(q)}&unique=cards&order=name&page=${page}`;
    const body = await this.getJson<ApiList>(url, signal, true);
    const cards = (body?.data ?? []).map(infoOf).filter((c): c is CardInfo => !!c);
    const result = { cards, more: !!body?.has_more };
    this.cache.set(key, result);
    return result;
  }

  /**
   * Type, cost, colours and rarity of the named cards, keyed by `infoKey`
   * (front-face name). Names are resolved in `/cards/collection` batches, or one
   * by one through `/cards/named` when the API has no collection endpoint; a
   * name the API does not know is absent. Throws on a network or API failure.
   */
  async cardInfos(names: string[], signal?: AbortSignal): Promise<Map<string, CardInfo>> {
    const base = this.requireBase();
    const out = new Map<string, CardInfo>();
    const missing = new Map<string, string>();
    for (const name of names) {
      const key = infoKey(name);
      const hit = this.cache.get(`info|${base}|${key}`) as CardInfo | null | undefined;
      if (hit) out.set(key, hit);
      else if (hit === undefined) missing.set(key, name);
    }
    const keys = [...missing.keys()];
    for (let i = 0; i < keys.length; i += COLLECTION_BATCH) {
      const batch = keys.slice(i, i + COLLECTION_BATCH);
      const found = await this.infoBatch(
        base,
        batch.map((k) => missing.get(k)!),
        signal,
      );
      for (const key of batch) {
        const info = found.get(key) ?? null;
        this.cache.set(`info|${base}|${key}`, info);
        if (info) out.set(key, info);
      }
    }
    return out;
  }

  private async infoBatch(
    base: string,
    names: string[],
    signal?: AbortSignal,
  ): Promise<Map<string, CardInfo>> {
    const out = new Map<string, CardInfo>();
    const cards = await this.collection(
      base,
      names.map((name) => ({ name })),
      signal,
    ).catch((err) => {
      if (signal?.aborted) throw err;
      return null;
    });
    if (cards) {
      for (const card of cards) {
        const info = infoOf(card);
        if (info) out.set(infoKey(info.name), info);
      }
      return out;
    }
    for (const name of names) {
      const card = await this.getJson<ApiCard>(
        `${base}/cards/named?exact=${encodeURIComponent(name)}`,
        signal,
        true,
      );
      const info = card ? infoOf(card) : null;
      if (info) out.set(infoKey(name), info);
    }
    return out;
  }

  /**
   * Fill in the print of every entry that carries a `(SET) number` but no image
   * yet. Entries are resolved in `/cards/collection` batches; a print the API
   * does not know falls back to the name (the print is dropped, so the default
   * art applies) and a failed request leaves the entries untouched. Returns the
   * same array when nothing needed resolving.
   */
  async resolveEntries(entries: DeckEntry[], signal?: AbortSignal): Promise<DeckEntry[]> {
    const base = this.api.apiUrl();
    const pending = entries.filter((e) => e.print && !e.print.src);
    if (!base || pending.length === 0) return entries;
    const resolved = new Map<DeckEntry, DeckPrint | null>();
    try {
      const wanted = new Map<string, Identifier>();
      for (const entry of pending) wanted.set(this.keyOf(entry), this.identifierOf(entry));
      const found = new Map<string, CardPrint>();
      const keys: string[] = [];
      for (const key of wanted.keys()) {
        const hit = this.cache.get(`print|${base}|${key}`) as CardPrint | undefined;
        if (hit) found.set(key, hit);
        else keys.push(key);
      }
      for (let i = 0; i < keys.length; i += COLLECTION_BATCH) {
        const batch = keys.slice(i, i + COLLECTION_BATCH);
        const identifiers = batch.map((k) => wanted.get(k)!);
        for (const [key, print] of await this.fetchBatch(base, batch, identifiers, signal)) {
          found.set(key, print);
          this.cache.set(`print|${base}|${key}`, print);
        }
      }
      for (const entry of pending) {
        const print = found.get(this.keyOf(entry));
        resolved.set(entry, print ? toDeckPrint(print) : await this.nameFallback(entry, signal));
      }
    } catch {
      return entries; // network trouble: keep the unresolved prints for a later try
    }
    return entries.map((entry) => {
      if (!resolved.has(entry)) return entry;
      const print = resolved.get(entry);
      const next = { ...entry };
      delete next.print;
      if (print) next.print = print;
      return next;
    });
  }

  private keyOf(entry: DeckEntry): string {
    const print = entry.print!;
    return print.collector
      ? `${print.set}/${print.collector.toLowerCase()}`
      : `${print.set}|${frontName(entry.card)}`;
  }

  private identifierOf(entry: DeckEntry): Identifier {
    const print = entry.print!;
    return print.collector
      ? { set: print.set, collector_number: print.collector }
      : { set: print.set, name: entry.card };
  }

  /**
   * One `/cards/collection` request (single GETs when the API has no collection
   * endpoint). Prints found are keyed like `keyOf`; unknown ones are absent.
   * Throws when the API cannot be reached, so a failure is not read as "unknown".
   */
  private async fetchBatch(
    base: string,
    keys: string[],
    identifiers: Identifier[],
    signal?: AbortSignal,
  ): Promise<Map<string, CardPrint>> {
    const out = new Map<string, CardPrint>();
    const cards = await this.collection(base, identifiers, signal).catch((err) => {
      if (signal?.aborted) throw err;
      return null;
    });
    if (cards) {
      for (const card of cards) {
        const print = printOf(card);
        if (!print) continue;
        out.set(`${print.set}/${print.collector.toLowerCase()}`, print);
        out.set(`${print.set}|${frontName(print.name)}`, print);
      }
      return out;
    }
    for (let i = 0; i < keys.length; i++) {
      const id = identifiers[i]!;
      const path = id.collector_number
        ? `/cards/${encodeURIComponent(id.set!)}/${encodeURIComponent(id.collector_number)}`
        : `/cards/named?exact=${encodeURIComponent(id.name!)}&set=${encodeURIComponent(id.set!)}`;
      const card = await this.getJson<ApiCard>(`${base}${path}`, signal, true);
      const print = card ? printOf(card) : null;
      if (print) out.set(keys[i]!, print);
    }
    return out;
  }

  private async collection(
    base: string,
    identifiers: Identifier[],
    signal?: AbortSignal,
  ): Promise<ApiCard[]> {
    const body = await this.throttled(async () => {
      const res = await fetch(`${base}/cards/collection`, {
        method: 'POST',
        headers: { ...HEADERS, 'Content-Type': 'application/json' },
        body: JSON.stringify({ identifiers }),
        signal,
      });
      if (!res.ok) throw new Error(`Card collection failed (${res.status})`);
      return (await res.json()) as ApiCollection;
    });
    return body.data ?? [];
  }

  /** The requested print was not found: drop it, or pin a readable default when the database has none. */
  private async nameFallback(entry: DeckEntry, signal?: AbortSignal): Promise<DeckPrint | null> {
    if (this.db.lookup(entry.card)?.src) return null;
    const print = await this.defaultPrint(entry.card, signal).catch(() => null);
    return print ? toDeckPrint(print) : null;
  }

  private async search(
    base: string,
    query: string,
    signal: AbortSignal | undefined,
    variations: boolean,
  ): Promise<ApiCard[]> {
    const cards: ApiCard[] = [];
    let url: string | undefined =
      `${base}/cards/search?q=${encodeURIComponent(query)}&unique=prints&order=released` +
      (variations ? '&include_variations=true' : '');
    for (let page = 0; url && page < MAX_PAGES; page++) {
      const body: ApiList | null = await this.getJson<ApiList>(url, signal, true);
      if (!body) break;
      cards.push(...(body.data ?? []));
      url = body.has_more ? body.next_page : undefined;
    }
    return cards;
  }

  /** GET a JSON document; a 404 (Scryfall's "nothing matched") yields null when `allow404`. */
  private async getJson<T>(url: string, signal?: AbortSignal, allow404 = false): Promise<T | null> {
    return this.throttled(async () => {
      const res = await fetch(url, { headers: HEADERS, signal });
      if (allow404 && res.status === 404) return null;
      if (!res.ok) throw new Error(`Card API request failed (${res.status})`);
      return (await res.json()) as T;
    });
  }

  /** Run requests one at a time, at least `MIN_GAP_MS` apart. */
  private throttled<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const wait = this.lastRequest + MIN_GAP_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.lastRequest = Date.now();
      return task();
    });
    this.queue = run.catch(() => undefined);
    return run;
  }

  private requireBase(): string {
    const base = this.api.apiUrl();
    if (!base) throw new Error('No card API deposited');
    return base;
  }
}
