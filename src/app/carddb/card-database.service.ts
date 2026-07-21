import { Injectable, computed, inject, signal } from '@angular/core';
import { CardDbCache } from './card-db-cache';
import { JsonArrayChunkParser } from './json-array-chunk-parser';

/** The Scryfall "default cards" bulk export this build uses as its card database. */
export const BULK_DATA_URL =
  'https://data.scryfall.io/default-cards/default-cards-20260719091104.json';

/**
 * Cache key of the compact index. Includes the source URL, so pointing
 * BULK_DATA_URL at a newer export invalidates the cache — the seed of the
 * later update system.
 */
const INDEX_KEY = `index:v1:${BULK_DATA_URL}`;

/** What the database keeps per card: enough to resolve a decklist name to art. */
export type CardRecord = {
  /** Canonical (Scryfall) card name, e.g. "Fire // Ice". */
  name: string;
  /** Front-face image URL (Scryfall "normal" size), '' when the card has no image. */
  src: string;
};

export type CardDbStatus = 'idle' | 'downloading' | 'ready' | 'error';

type ScryfallCard = {
  name?: string;
  image_uris?: { normal?: string };
  card_faces?: { image_uris?: { normal?: string } }[];
};

/**
 * The local card database (the design doc's "resources"): a name→image index
 * distilled from the Scryfall bulk file. On app start `init()` loads the
 * index from the IndexedDB cache, or — first run — streams the bulk download
 * through JsonArrayChunkParser (bounded memory; the full file is never held)
 * and caches the result. Deck import and the in-room deck chooser resolve
 * card names here; the images themselves stay remote URLs loaded on demand.
 */
@Injectable({ providedIn: 'root' })
export class CardDatabaseService {
  private readonly cache = inject(CardDbCache);
  private index: Record<string, CardRecord> = {};
  private initPromise?: Promise<void>;

  readonly status = signal<CardDbStatus>('idle');
  /** Download progress 0..1 (stays 0 when the response size is unknown). */
  readonly progress = signal(0);
  readonly cardCount = signal(0);
  readonly ready = computed(() => this.status() === 'ready');

  /**
   * Check the cache and (first run) download the bulk file. Idempotent —
   * fired without await from the app initializer so boot never blocks on it.
   */
  init(): Promise<void> {
    return (this.initPromise ??= this.run());
  }

  /** Resolve a card name — decklist spelling or a double-faced front face. */
  lookup(name: string): CardRecord | undefined {
    return this.index[name.trim().toLowerCase()];
  }

  private async run(): Promise<void> {
    try {
      const cached = await this.cache.get<Record<string, CardRecord>>(INDEX_KEY);
      if (cached && Object.keys(cached).length > 0) {
        this.adopt(cached);
        return;
      }
      this.status.set('downloading');
      const index = await this.download();
      this.adopt(index);
      await this.cache.put(INDEX_KEY, index).catch(() => undefined); // best-effort
    } catch (err) {
      console.warn('[carddb] Card database unavailable.', err);
      this.status.set('error');
    }
  }

  private adopt(index: Record<string, CardRecord>): void {
    this.index = index;
    this.cardCount.set(Object.keys(index).length);
    this.status.set('ready');
  }

  private async download(): Promise<Record<string, CardRecord>> {
    const res = await fetch(BULK_DATA_URL);
    if (!res.ok || !res.body) throw new Error(`Bulk data download failed (${res.status})`);
    const total = Number(res.headers.get('content-length')) || 0;
    const index: Record<string, CardRecord> = {};
    const parser = new JsonArrayChunkParser();
    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (total > 0) this.progress.set(received / total);
      for (const source of parser.push(decoder.decode(value, { stream: true }))) {
        this.add(index, JSON.parse(source) as ScryfallCard);
      }
    }
    return index;
  }

  /**
   * Index one card object. The bulk file holds every printing; the first one
   * with an image wins per name. Double-faced names ("A // B") also resolve
   * by their front face, since decklists usually carry only that.
   */
  private add(index: Record<string, CardRecord>, card: ScryfallCard): void {
    if (!card.name) return;
    const src = card.image_uris?.normal ?? card.card_faces?.[0]?.image_uris?.normal ?? '';
    const key = card.name.toLowerCase();
    const existing = index[key];
    if (!existing) index[key] = { name: card.name, src };
    else if (!existing.src && src) existing.src = src;
    const front = card.name.split(' // ')[0]!;
    if (front !== card.name) {
      const frontKey = front.toLowerCase();
      if (!index[frontKey]) index[frontKey] = { name: card.name, src };
    }
  }
}
