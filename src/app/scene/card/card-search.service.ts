import { Injectable } from '@angular/core';

/** A searchable card: what the util window needs to add it anywhere. */
export type CardHit = {
  name: string;
  /** Front-face image URL. */
  src: string;
};

/** Cap the hits kept per query — the util window shows 6 at once (3×2) and scrolls. */
const MAX_HITS = 30;

type ScryfallCard = {
  name: string;
  image_uris?: { normal?: string };
  card_faces?: { image_uris?: { normal?: string } }[];
};
type ScryfallList = { data?: ScryfallCard[] };

/** Image for a card; double-faced cards keep their images on the faces. */
function imageOf(card: ScryfallCard): string | undefined {
  return card.image_uris?.normal ?? card.card_faces?.[0]?.image_uris?.normal;
}

/**
 * Card search against the public Scryfall API (the card universe the
 * placeholder art already comes from). Plain fetch — no auth, CORS-open.
 * Successful queries are cached for the app's lifetime; callers debounce and
 * pass an AbortSignal so stale requests don't race newer ones.
 */
@Injectable({ providedIn: 'root' })
export class CardSearchService {
  private readonly cache = new Map<string, CardHit[]>();

  /** Cards matching a name query. Empty for no matches; throws on network/API failure. */
  async search(query: string, signal?: AbortSignal): Promise<CardHit[]> {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const cached = this.cache.get(q);
    if (cached) return cached;

    const url = `https://api.scryfall.com/cards/search?q=${encodeURIComponent(q)}&unique=cards&order=name`;
    const res = await fetch(url, { signal });
    if (res.status === 404) {
      // Scryfall's "no cards matched" response.
      this.cache.set(q, []);
      return [];
    }
    if (!res.ok) throw new Error(`Card search failed (${res.status})`);
    const body = (await res.json()) as ScryfallList;
    const hits = (body.data ?? [])
      .flatMap((card) => {
        const src = imageOf(card);
        return src ? [{ name: card.name, src }] : [];
      })
      .slice(0, MAX_HITS);
    this.cache.set(q, hits);
    return hits;
  }
}
