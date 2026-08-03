import { Injectable, inject } from '@angular/core';
import { CardApiService } from '../../carddb/card-api.service';
import { relatedNamesOf } from '../../carddb/card-database.service';

/** A searchable card: what the util window needs to add it anywhere. */
export type CardHit = {
  name: string;
  /** Front-face image URL. */
  src: string;
  /** Names of related cards (tokens, meld results, …) from the API's all_parts. */
  related: string[];
};

/** Cap the hits kept per query — the util window shows 6 at once (3×2) and scrolls. */
const MAX_HITS = 30;

type ApiCard = {
  name: string;
  image_uris?: { normal?: string };
  card_faces?: { image_uris?: { normal?: string } }[];
  all_parts?: { name?: string }[];
};
type ApiList = { data?: ApiCard[] };

/** Image for a card; double-faced cards keep their images on the faces. */
function imageOf(card: ApiCard): string | undefined {
  return card.image_uris?.normal ?? card.card_faces?.[0]?.image_uris?.normal;
}

/**
 * Card search against the user-deposited card API (legal.md — the app ships
 * no endpoint of its own; `{base}/cards/search` must be Scryfall-compatible).
 * Plain fetch — no auth, CORS-open. `include_extras` asks the API to also
 * return tokens and other extras, which a Scryfall-style search hides by
 * default (moreimprovements.md "tokens"). Successful queries are cached for
 * the app's lifetime (keyed per API base, so changing the deposit never serves
 * another API's hits); callers debounce and pass an AbortSignal so stale
 * requests don't race newer ones, and check `CardApiService.configured()`
 * first — searching without a deposit throws.
 */
@Injectable({ providedIn: 'root' })
export class CardSearchService {
  private readonly api = inject(CardApiService);
  private readonly cache = new Map<string, CardHit[]>();

  /** Cards matching a name query. Empty for no matches; throws on network/API failure. */
  async search(query: string, signal?: AbortSignal): Promise<CardHit[]> {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const base = this.api.apiUrl();
    if (!base) throw new Error('No card API deposited');
    const key = `${base}|${q}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const url = `${base}/cards/search?q=${encodeURIComponent(q)}&unique=cards&order=name&include_extras=true`;
    const res = await fetch(url, { signal });
    if (res.status === 404) {
      // The Scryfall-style "no cards matched" response.
      this.cache.set(key, []);
      return [];
    }
    if (!res.ok) throw new Error(`Card search failed (${res.status})`);
    const body = (await res.json()) as ApiList;
    const hits = (body.data ?? [])
      .flatMap((card) => {
        const src = imageOf(card);
        return src ? [{ name: card.name, src, related: relatedNamesOf(card) }] : [];
      })
      .slice(0, MAX_HITS);
    this.cache.set(key, hits);
    return hits;
  }
}
