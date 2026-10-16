import { Component, DestroyRef, inject, input, output, signal } from '@angular/core';
import { CardInfo } from '../../carddb/card-info';
import { CardPrintService } from '../../carddb/card-print.service';

/** Wait this long after the last keystroke before asking for completions. */
const SUGGEST_DELAY_MS = 250;

/**
 * Card search for the deck editor: a query field with name completions
 * (`/cards/autocomplete`) and the full search syntax on Enter
 * (`/cards/search`), results as image tiles with an Add button. Reports the
 * chosen card through `add`; `have` lets it show how many copies are in the deck.
 */
@Component({
  selector: 'app-deck-card-search',
  templateUrl: './deck-card-search.html',
  styleUrl: './deck-card-search.scss',
  standalone: true,
})
export class DeckCardSearch {
  private readonly prints = inject(CardPrintService);

  /** Copies in the deck per lowercase card name. */
  readonly have = input<Record<string, number>>({});
  readonly add = output<CardInfo>();

  protected readonly query = signal('');
  protected readonly suggestions = signal<string[]>([]);
  protected readonly results = signal<CardInfo[]>([]);
  protected readonly more = signal(false);
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly searched = signal(false);

  private page = 1;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private suggest: AbortController | undefined;
  private search: AbortController | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.timer);
      this.suggest?.abort();
      this.search?.abort();
    });
  }

  protected onInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.query.set(value);
    clearTimeout(this.timer);
    this.suggest?.abort();
    if (value.trim().length < 2) {
      this.suggestions.set([]);
      return;
    }
    this.timer = setTimeout(() => void this.complete(value), SUGGEST_DELAY_MS);
  }

  private async complete(value: string): Promise<void> {
    this.suggest = new AbortController();
    try {
      this.suggestions.set(await this.prints.autocomplete(value, this.suggest.signal));
    } catch {
      this.suggestions.set([]);
    }
  }

  protected pick(name: string): void {
    this.query.set(name);
    void this.run(`!"${name}"`);
  }

  protected submit(): void {
    void this.run(this.query());
  }

  protected loadMore(): void {
    void this.run(this.query(), this.page + 1);
  }

  private async run(query: string, page = 1): Promise<void> {
    clearTimeout(this.timer);
    this.suggest?.abort();
    this.suggestions.set([]);
    if (!query.trim()) return;
    this.search?.abort();
    this.search = new AbortController();
    this.busy.set(true);
    this.error.set(null);
    try {
      const { cards, more } = await this.prints.searchCards(query, page, this.search.signal);
      this.page = page;
      this.results.update((old) => (page > 1 ? [...old, ...cards] : cards));
      this.more.set(more);
      this.searched.set(true);
    } catch (err) {
      if (this.search.signal.aborted) return;
      this.error.set(err instanceof Error ? err.message : 'Search failed.');
    }
    this.busy.set(false);
  }

  protected inDeck(card: CardInfo): number {
    return this.have()[card.name.toLowerCase()] ?? 0;
  }
}
