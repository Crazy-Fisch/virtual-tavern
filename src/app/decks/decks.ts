import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CardDatabaseService } from '../carddb/card-database.service';
import { DeckStore } from './deck-store';
import { Deck, deckSize } from './deck.types';

/** Screen anchor (relative to the page) of the right-click menu on a deck tile. */
type DeckMenu = { deckId: string; x: number; y: number };

/**
 * The deck screen: import a pasted decklist (phase 1 — no editing) and see
 * the deck overview, a grid of squares with the deck name inside and the card
 * count below. Right-clicking a tile opens a context menu to delete the deck.
 * Also surfaces the card database status, since imports resolve card names
 * against it when a deck is later loaded into a game.
 */
@Component({
  selector: 'app-decks',
  imports: [RouterLink],
  templateUrl: './decks.html',
  styleUrl: './decks.scss',
  standalone: true,
  host: { '(document:pointerdown)': 'onDocumentPointerDown($event)' },
})
export class Decks {
  protected readonly store = inject(DeckStore);
  private readonly db = inject(CardDatabaseService);
  protected readonly deckSize = deckSize;

  protected readonly name = signal('');
  protected readonly list = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly menu = signal<DeckMenu | null>(null);

  protected readonly dbLabel = computed(() => {
    switch (this.db.status()) {
      case 'ready':
        return `Card database ready — ${this.db.cardCount().toLocaleString()} cards`;
      case 'downloading':
        return `Downloading card database… ${Math.round(this.db.progress() * 100)}%`;
      case 'error':
        return 'Card database unavailable — imported decks may miss card images';
      default:
        return 'Checking card database…';
    }
  });

  protected onNameInput(event: Event): void {
    this.name.set((event.target as HTMLInputElement).value);
  }

  protected onListInput(event: Event): void {
    this.list.set((event.target as HTMLTextAreaElement).value);
  }

  protected async importDeck(): Promise<void> {
    const err = await this.store.import(this.name(), this.list());
    this.error.set(err);
    if (err) return;
    this.name.set('');
    this.list.set('');
  }

  protected openMenu(event: MouseEvent, deck: Deck): void {
    event.preventDefault();
    const host = (event.currentTarget as HTMLElement).closest('app-decks')!;
    const rect = host.getBoundingClientRect();
    this.menu.set({ deckId: deck.id, x: event.clientX - rect.left, y: event.clientY - rect.top });
  }

  protected deleteDeck(): void {
    const menu = this.menu();
    if (menu) this.store.remove(menu.deckId);
    this.menu.set(null);
  }

  /** Close the tile menu when clicking anywhere outside it. */
  protected onDocumentPointerDown(event: PointerEvent): void {
    if (!(event.target instanceof Element) || !event.target.closest('.deck-menu')) {
      this.menu.set(null);
    }
  }
}
