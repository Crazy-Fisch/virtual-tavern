import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { CardApiService } from './card-api.service';
import { CardDbCache } from './card-db-cache';
import { JsonChunkParser } from './json-chunk-parser';

/** Cache key of the compact index, per deposited API base URL — changing the
 * deposit therefore loads (or downloads) that API's own index. v3 added the
 * per-card related names (all_parts), so older indexes must be rebuilt. */
function indexKey(base: string): string {
  return `index:v3:${base}`;
}

/** Key the same base's index was cached under before related names existed;
 * superseded, so it is deleted when the v3 index is (re)built. */
function staleIndexKey(base: string): string {
  return `index:v2:${base}`;
}

/** Key of the index cached by builds that still shipped an app-level bulk URL
 * (pre-legal.md); tens of MB nobody will read again, so it is deleted on boot. */
const LEGACY_INDEX_KEY =
  'index:v1:https://data.scryfall.io/default-cards/default-cards-20260719091104.json';

/** What the database keeps per card: enough to resolve a decklist name to art,
 * plus the names of its related cards (tokens it creates, meld results, …). */
export type CardRecord = {
  /** Canonical card name, e.g. "Fire // Ice". */
  name: string;
  /** Front-face image URL, '' when the card has no image. */
  src: string;
  /** Related card names from the card data's all_parts; absent when none. */
  related?: string[];
};

export type CardDbStatus = 'idle' | 'downloading' | 'ready' | 'error';

type BulkCard = {
  name?: string;
  image_uris?: { normal?: string };
  card_faces?: { image_uris?: { normal?: string } }[];
  all_parts?: { name?: string }[];
};

/**
 * Names a card object is related to — its `all_parts` minus itself, deduped.
 * Shared with CardSearchService: bulk-file cards and search hits carry the
 * same shape (moreimprovements.md "related cards").
 */
export function relatedNamesOf(card: { name?: string; all_parts?: { name?: string }[] }): string[] {
  const names = new Set<string>();
  for (const part of card.all_parts ?? []) {
    if (part.name && part.name !== card.name) names.add(part.name);
  }
  return [...names];
}

/** The API's bulk-data listing (`GET {base}/bulk-data`, Scryfall-compatible).
 * Either export link works — the parser reads arrays and JSON Lines alike. */
type BulkDataList = {
  data?: { type?: string; download_uri?: string; jsonl_download_uri?: string }[];
};

/** Magic bytes of a gzip file — a `.json.gz`/`.jsonl.gz` bulk export. */
const GZIP_MAGIC = [0x1f, 0x8b] as const;
/** Magic bytes of a zstd file — offered by some APIs, but browsers can't inflate it. */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd] as const;

function startsWith(head: Uint8Array, magic: readonly number[]): boolean {
  return magic.length <= head.length && magic.every((byte, i) => head[i] === byte);
}

/** Gzip inflation as a pipeThrough stage. The cast bridges TS's DOM types,
 * whose BufferSource writable side pipeThrough's invariant generics reject. */
function gunzip(): ReadableWritablePair<Uint8Array, Uint8Array> {
  return new DecompressionStream('gzip') as unknown as ReadableWritablePair<Uint8Array, Uint8Array>;
}

/**
 * Read just enough of a byte stream to inspect its first bytes, returning an
 * equivalent stream that still yields the complete content.
 */
async function peekBytes(
  stream: ReadableStream<Uint8Array>,
  size: number,
): Promise<{ head: Uint8Array; stream: ReadableStream<Uint8Array> }> {
  const reader = stream.getReader();
  const seen: Uint8Array[] = [];
  let length = 0;
  while (length < size) {
    const { done, value } = await reader.read();
    if (done) break;
    seen.push(value);
    length += value.byteLength;
  }
  const head = new Uint8Array(Math.min(length, size));
  let offset = 0;
  for (const chunk of seen) {
    if (offset >= head.length) break;
    const take = Math.min(chunk.byteLength, head.length - offset);
    head.set(chunk.subarray(0, take), offset);
    offset += take;
  }
  const replay = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of seen) controller.enqueue(chunk);
    },
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) controller.close();
      else controller.enqueue(value);
    },
    cancel(reason) {
      void reader.cancel(reason);
    },
  });
  return { head, stream: replay };
}

/**
 * The local card database: a name→image index distilled from the bulk export
 * of the **user-deposited** card API (legal.md — the app ships no API of its
 * own). An effect follows `CardApiService.apiUrl`: while none is deposited the
 * database sits idle and empty; once one exists, the index is loaded from the
 * IndexedDB cache or — first run against that API — resolved via the API's
 * `/bulk-data` listing (`default_cards` entry, `download_uri` or
 * `jsonl_download_uri`), gunzipped in-stream when the file is a .gz, and
 * streamed through JsonChunkParser (JSON array or JSON Lines; bounded memory,
 * the full file is never held), then cached. Deck import and the in-room deck
 * chooser resolve card names here; the images themselves stay remote URLs
 * loaded on demand.
 */
@Injectable({ providedIn: 'root' })
export class CardDatabaseService {
  private readonly cache = inject(CardDbCache);
  private readonly api = inject(CardApiService);
  private index: Record<string, CardRecord> = {};
  /** Base URL the current index/run belongs to; a change aborts and reloads. */
  private currentBase: string | null = null;
  private controller?: AbortController;

  readonly status = signal<CardDbStatus>('idle');
  /** Download progress 0..1 (stays 0 when the response size is unknown). */
  readonly progress = signal(0);
  readonly cardCount = signal(0);
  readonly ready = computed(() => this.status() === 'ready');

  constructor() {
    void this.cache.delete(LEGACY_INDEX_KEY);
    effect(() => {
      const base = this.api.apiUrl();
      untracked(() => this.follow(base));
    });
  }

  /** Resolve a card name — decklist spelling or a double-faced front face. */
  lookup(name: string): CardRecord | undefined {
    return this.index[name.trim().toLowerCase()];
  }

  /** Point the database at the (new) API base, dropping whatever came before. */
  private follow(base: string | null): void {
    if (base === this.currentBase) return;
    this.currentBase = base;
    this.controller?.abort();
    this.controller = undefined;
    this.index = {};
    this.cardCount.set(0);
    this.progress.set(0);
    this.status.set('idle');
    if (!base) return;
    const controller = new AbortController();
    this.controller = controller;
    void this.run(base, controller.signal);
  }

  private async run(base: string, signal: AbortSignal): Promise<void> {
    try {
      const cached = await this.cache.get<Record<string, CardRecord>>(indexKey(base));
      if (signal.aborted) return;
      if (cached && Object.keys(cached).length > 0) {
        this.adopt(cached);
        return;
      }
      this.status.set('downloading');
      const index = await this.download(base, signal);
      if (signal.aborted) return;
      this.adopt(index);
      await this.cache.put(indexKey(base), index).catch(() => undefined); // best-effort
      await this.cache.delete(staleIndexKey(base)); // superseded pre-related index
    } catch (err) {
      if (signal.aborted) return;
      console.warn('[carddb] Card database unavailable.', err);
      this.status.set('error');
    }
  }

  private adopt(index: Record<string, CardRecord>): void {
    this.index = index;
    this.cardCount.set(Object.keys(index).length);
    this.status.set('ready');
  }

  private async download(base: string, signal: AbortSignal): Promise<Record<string, CardRecord>> {
    // Ask the API where its "default cards" bulk export lives, then stream it.
    const listing = await fetch(`${base}/bulk-data`, { signal });
    if (!listing.ok) throw new Error(`Bulk data listing failed (${listing.status})`);
    const body = (await listing.json()) as BulkDataList;
    const entry = body.data?.find((e) => e.type === 'default_cards');
    const uri = entry?.download_uri ?? entry?.jsonl_download_uri;
    if (!uri) throw new Error('The deposited API lists no default_cards bulk export');

    const res = await fetch(uri, { signal });
    if (!res.ok || !res.body) throw new Error(`Bulk data download failed (${res.status})`);
    const total = Number(res.headers.get('content-length')) || 0;
    let received = 0;
    // Progress counts wire bytes — what content-length describes — before the
    // file-level decompression below inflates them.
    const counted = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => {
          received += chunk.byteLength;
          if (total > 0) this.progress.set(received / total);
          controller.enqueue(chunk);
        },
      }),
    );

    // Bulk exports increasingly are .gz *files* (served as application/gzip,
    // which fetch does NOT transparently inflate the way it does a
    // Content-Encoding: gzip response). Sniff the magic bytes rather than
    // trusting headers or the URL — a header-based guess would double-inflate
    // the transparently encoded case and feed binary to the JSON parser in
    // the raw-file case.
    const { head, stream } = await peekBytes(counted, ZSTD_MAGIC.length);
    if (startsWith(head, ZSTD_MAGIC)) {
      throw new Error('The bulk export is zstd-compressed; browsers can only inflate gzip');
    }
    const bytes = startsWith(head, GZIP_MAGIC) ? stream.pipeThrough(gunzip()) : stream;

    const index: Record<string, CardRecord> = {};
    const parser = new JsonChunkParser();
    const decoder = new TextDecoder();
    const reader = bytes.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const source of parser.push(decoder.decode(value, { stream: true }))) {
        this.add(index, JSON.parse(source) as BulkCard);
      }
    }
    for (const source of parser.push(decoder.decode())) {
      this.add(index, JSON.parse(source) as BulkCard);
    }
    return index;
  }

  /**
   * Index one card object. The bulk file holds every printing; the first one
   * with an image wins per name, and the first that knows its related parts
   * contributes those (all_parts is per printing — many carry none). Tokens
   * are ordinary card objects in the bulk file and index like any other, which
   * is what lets related names resolve to an image. Double-faced names
   * ("A // B") also resolve by their front face, since decklists usually carry
   * only that — the front key shares the record, so later merges reach both.
   */
  private add(index: Record<string, CardRecord>, card: BulkCard): void {
    if (!card.name) return;
    const src = card.image_uris?.normal ?? card.card_faces?.[0]?.image_uris?.normal ?? '';
    const related = relatedNamesOf(card);
    const key = card.name.toLowerCase();
    let record = index[key];
    if (!record) record = index[key] = { name: card.name, src };
    else if (!record.src && src) record.src = src;
    if (related.length && !record.related?.length) record.related = related;
    const front = card.name.split(' // ')[0]!;
    if (front !== card.name) {
      const frontKey = front.toLowerCase();
      if (!index[frontKey]) index[frontKey] = record;
    }
  }
}
