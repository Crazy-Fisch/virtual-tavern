import { Component, ElementRef, effect, inject, signal, viewChild } from '@angular/core';
import { RoomService } from '../../room/room.service';
import { ZoneStore } from '../../zones/zone-store';
import { CardInteractions, UtilAnchor } from '../card/card-interactions';
import { CardHit, CardSearchService } from '../card/card-search.service';
import { CardStore } from '../card/card-store';
import { newCardId } from '../card/card.types';

const SEARCH_DEBOUNCE_MS = 300;
const MIN_QUERY = 2;

/** Spread repeated adds around the clicked spot so cards don't overlap exactly. */
function jitter(): number {
  return (Math.random() - 0.5) * 0.12;
}

/**
 * The "add to game" popup (plain Angular/HTML over the canvas), opened by
 * right-clicking empty table (CardInteractions owns the open/close state and
 * the world position where added objects appear): card search (Scryfall) with
 * a scrollable 3-wide result grid — each hit can go to the table, my hand, or
 * on top of my deck.
 */
@Component({
  selector: 'app-util-window',
  templateUrl: './util-window.html',
  styleUrl: './util-window.scss',
  standalone: true,
})
export class UtilWindow {
  protected readonly interactions = inject(CardInteractions);
  private readonly searchService = inject(CardSearchService);
  private readonly cards = inject(CardStore);
  private readonly zones = inject(ZoneStore);
  private readonly room = inject(RoomService);

  protected readonly query = signal('');
  protected readonly results = signal<CardHit[]>([]);
  protected readonly searching = signal(false);
  protected readonly error = signal<string | null>(null);

  private readonly searchInput = viewChild<ElementRef<HTMLInputElement>>('search');

  constructor() {
    // Debounced live search; aborts the in-flight request when the query moves on.
    effect((onCleanup) => {
      const q = this.query().trim();
      if (q.length < MIN_QUERY) {
        this.results.set([]);
        this.searching.set(false);
        this.error.set(null);
        return;
      }
      const controller = new AbortController();
      const timer = setTimeout(() => {
        this.searching.set(true);
        this.error.set(null);
        this.searchService
          .search(q, controller.signal)
          .then((hits) => {
            if (controller.signal.aborted) return;
            this.results.set(hits);
            this.searching.set(false);
          })
          .catch(() => {
            if (controller.signal.aborted) return;
            this.error.set('Search failed — try again.');
            this.searching.set(false);
          });
      }, SEARCH_DEBOUNCE_MS);
      onCleanup(() => {
        clearTimeout(timer);
        controller.abort();
      });
    });

    // Focus the search box whenever the window opens.
    effect(() => {
      if (this.interactions.utilWindow()) {
        const input = this.searchInput()?.nativeElement;
        if (input) queueMicrotask(() => input.focus());
      }
    });
  }

  /** Keep the window on screen when opened near the right/bottom edge. */
  protected left(anchor: UtilAnchor): string {
    return `min(${anchor.x}px, calc(100% - 330px))`;
  }

  protected top(anchor: UtilAnchor): string {
    return `min(${anchor.y}px, calc(100% - 380px))`;
  }

  protected onInput(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected close(): void {
    this.interactions.utilWindow.set(null);
  }

  protected addToTable(hit: CardHit): void {
    const anchor = this.interactions.utilWindow();
    if (!anchor) return;
    const [x, y, z] = anchor.world;
    this.cards.add({
      id: newCardId(),
      name: hit.name,
      src: hit.src,
      position: [x + jitter(), y, z + jitter()],
      yaw: this.room.seatYaw(),
      faceUp: true,
      tapped: false,
      relatedIds: [],
    });
    this.room.sendAction(`added ${hit.name}`);
  }

  /** Closed-zone adds log without the card name, so hands/decks stay hidden. */
  protected addToHand(hit: CardHit): void {
    this.zones.addCard('hand', { id: crypto.randomUUID(), name: hit.name, src: hit.src });
    this.room.sendAction('added a card to their hand');
  }

  protected addToDeck(hit: CardHit): void {
    this.zones.addCard('deck', { id: crypto.randomUUID(), name: hit.name, src: hit.src });
    this.room.sendAction('put a card on top of their deck');
  }
}
