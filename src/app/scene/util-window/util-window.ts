import { Component, ElementRef, effect, inject, signal, viewChild } from '@angular/core';
import { CardApiService } from '../../carddb/card-api.service';
import { CardInteractions, DRAG_Y, UtilAnchor } from '../card/card-interactions';
import { CardHit, CardSearchService } from '../card/card-search.service';
import {
  COUNTER_VARIANTS,
  CounterVariant,
  DEFAULT_ITEM_COLOR,
  DICE_KINDS,
  DiceKind,
  ITEM_COLORS,
  ItemColor,
  ItemKind,
  counterLabel,
  newItem,
} from '../item/item.types';

const SEARCH_DEBOUNCE_MS = 300;
const MIN_QUERY = 2;

/**
 * The "add to game" popup (plain Angular/HTML over the canvas), opened by
 * right-clicking empty table (CardInteractions owns the open/close state and
 * the world position where added items appear): the game items — dice
 * (d4/d6/d12/d20, cast in the colour picked from the swatch row), a coin, and
 * +1/+1, −1/−1 or plain "x" counters, each behind its own
 * expanding row — above a card search (against the user-deposited card API,
 * see legal.md; tokens included) with a scrollable 3-wide result grid. A hit
 * is *dragged* out of the grid: onto the table to add it there, or onto the
 * hand/deck/graveyard/exile widgets to route it into that zone — the same drop
 * flow a card played from the hand uses (moreimprovements.md replaced the
 * former per-hit Table/Hand/Deck buttons with this).
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
  private readonly api = inject(CardApiService);

  protected readonly diceKinds = DICE_KINDS;
  protected readonly diceColors = ITEM_COLORS;
  protected readonly counterVariants = COUNTER_VARIANTS;
  protected readonly counterLabel = counterLabel;
  /** Which item row is expanded ('dice' / 'counters'), or null. */
  protected readonly openGroup = signal<'dice' | 'counters' | null>(null);
  /** Colour the next die is cast in (newmechanics.md); sticks between spawns. */
  protected readonly diceColor = signal<ItemColor>(DEFAULT_ITEM_COLOR);
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
      // Card search needs the user-deposited API (legal.md).
      if (!this.api.configured()) {
        this.results.set([]);
        this.searching.set(false);
        this.error.set('No card API set — add one on the Decks screen.');
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

  protected toggleGroup(group: 'dice' | 'counters'): void {
    this.openGroup.update((open) => (open === group ? null : group));
  }

  protected addDie(kind: DiceKind): void {
    this.addItem(kind, { color: this.diceColor() });
  }

  protected addCoin(): void {
    this.addItem('coin');
  }

  protected addCounter(variant: CounterVariant): void {
    this.addItem('counter', { variant });
  }

  /**
   * Drag a search hit out of the window: past the drag threshold the card
   * spawns under the cursor (local-only) and the window closes; releasing it
   * over the table adds it, over a zone widget routes it there, and a miss
   * discards it. A plain click does nothing.
   */
  protected dragHit(event: PointerEvent, hit: CardHit): void {
    this.interactions.armSpawnCardDrag(event, hit, () => this.close());
  }

  /**
   * Hand a fresh item to the cursor (tableitems.md): it starts in the dragged
   * state — local to this client, floating at the right-clicked spot until the
   * mouse moves — and a click on the table places it, which is when it reaches
   * the other players and the history.
   */
  private addItem(
    kind: ItemKind,
    options: { variant?: CounterVariant; color?: ItemColor } = {},
  ): void {
    const anchor = this.interactions.utilWindow();
    if (!anchor) return;
    const [x, , z] = anchor.world;
    this.interactions.beginSpawnDrag(newItem(kind, [x, DRAG_Y, z], options));
    this.close();
  }
}
