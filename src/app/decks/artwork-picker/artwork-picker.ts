import {
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { CardPrint, CardPrintService, toDeckPrint } from '../../carddb/card-print.service';
import { Dialog } from '../../shared/dialog/dialog';
import { DeckStore } from '../deck-store';
import { DeckEntry } from '../deck.types';

/**
 * "Change artwork" for one deck line: lists the card's prints from the card API
 * as a thumbnail grid (set, number, language), filters them (English only, hide
 * full-art / textless) and saves the clicked print to that line through
 * `DeckStore.setPrint`. A line of several copies can be split, so one deck can
 * hold e.g. basic lands of different arts.
 */
@Component({
  selector: 'app-artwork-picker',
  imports: [Dialog],
  templateUrl: './artwork-picker.html',
  styleUrl: './artwork-picker.scss',
  standalone: true,
})
export class ArtworkPicker {
  private readonly prints = inject(CardPrintService);
  private readonly store = inject(DeckStore);

  readonly deckId = input.required<string>();
  readonly index = input.required<number>();
  readonly entry = input.required<DeckEntry>();
  readonly close = output<void>();

  protected readonly all = signal<CardPrint[]>([]);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly englishOnly = signal(true);
  protected readonly hideSpecial = signal(false);
  protected readonly copies = signal<number | null>(null);

  protected readonly shown = computed(() => {
    const hide = this.hideSpecial();
    return this.all().filter((p) => !hide || !(p.fullArt || p.textless));
  });

  protected readonly applyTo = computed(() => {
    const total = this.entry().count;
    return Math.min(Math.max(this.copies() ?? total, 1), total);
  });

  private request = 0;

  constructor() {
    effect(() => {
      const english = this.englishOnly();
      untracked(() => void this.load(english));
    });
  }

  private async load(english: boolean): Promise<void> {
    const id = ++this.request;
    this.loading.set(true);
    this.error.set(null);
    try {
      const list = await this.prints.listPrints(this.entry().card, undefined, !english);
      if (id !== this.request) return;
      this.all.set(list);
    } catch (err) {
      if (id !== this.request) return;
      this.all.set([]);
      this.error.set(err instanceof Error ? err.message : 'Could not load the prints.');
    }
    this.loading.set(false);
  }

  protected isCurrent(print: CardPrint): boolean {
    const chosen = this.entry().print;
    if (!chosen) return false;
    if (chosen.id) return chosen.id === print.id;
    return chosen.set === print.set && chosen.collector === print.collector;
  }

  protected tag(print: CardPrint): string {
    return [
      print.fullArt && 'full art',
      print.textless && 'textless',
      print.borderless && 'borderless',
      print.promo && 'promo',
    ]
      .filter(Boolean)
      .join(' · ');
  }

  protected onCopies(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    this.copies.set(Number.isFinite(value) ? Math.round(value) : null);
  }

  protected choose(print: CardPrint): void {
    this.store.setPrint(this.deckId(), this.index(), toDeckPrint(print), this.applyTo());
    this.close.emit();
  }

  protected reset(): void {
    this.store.setPrint(this.deckId(), this.index(), undefined, this.applyTo());
    this.close.emit();
  }
}
