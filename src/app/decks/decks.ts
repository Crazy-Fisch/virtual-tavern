import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CardApiService } from '../carddb/card-api.service';
import { CardDatabaseService, CardRecord } from '../carddb/card-database.service';
import { Dialog } from '../shared/dialog/dialog';
import { DeckStore } from './deck-store';
import { Deck, DeckEntry, deckSize, entrySrc, isBuiltInDeck } from './deck.types';

/** Screen anchor (relative to the page) of the right-click menu on a deck tile. */
type DeckMenu = { deck: Deck; x: number; y: number };

/**
 * The deck screen: import a pasted decklist (phase 1 — no editing) and see the
 * deck overview, a grid of squares (each backgrounded by its first card's art)
 * with the deck name inside and the card count below. Right-clicking a tile
 * opens a context menu to rename or delete the deck; left-clicking opens the
 * full-page deck view — a scrollable grid of every card resolved against the
 * card database. Also surfaces the card database status, since imports resolve
 * card names against it when a deck is later loaded into a game.
 */
@Component({
  selector: 'app-decks',
  imports: [RouterLink, Dialog],
  templateUrl: './decks.html',
  styleUrl: './decks.scss',
  standalone: true,
  host: { '(document:pointerdown)': 'onDocumentPointerDown($event)' },
})
export class Decks {
  protected readonly store = inject(DeckStore);
  protected readonly db = inject(CardDatabaseService);
  protected readonly api = inject(CardApiService);
  protected readonly deckSize = deckSize;
  /** Decks shipped with the app can't be renamed or deleted (defaultdecks.md). */
  protected readonly isBuiltIn = isBuiltInDeck;

  protected readonly name = signal('');
  protected readonly list = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly menu = signal<DeckMenu | null>(null);
  /** The deck whose full-page card view is open, or null for the overview. */
  protected readonly viewing = signal<Deck | null>(null);
  /** In-flight rename: the deck plus the edited name text, or null when closed. */
  protected readonly renaming = signal<{ id: string; name: string } | null>(null);
  /** The card-API modal's text field, or null while the modal is closed. */
  protected readonly apiDraft = signal<string | null>(null);
  protected readonly apiError = signal<string | null>(null);

  protected readonly dbLabel = computed(() => {
    if (!this.api.configured()) {
      return 'No card API deposited — card search and images are unavailable';
    }
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

  /** Resolve a decklist name to its database record (undefined = unknown card). */
  protected resolve(name: string): CardRecord | undefined {
    return this.db.lookup(name);
  }

  /** Image of a deck line: its chosen print, else the database's default art. */
  protected srcOf(entry: DeckEntry): string {
    return entrySrc(entry, this.db.lookup(entry.card)?.src);
  }

  /** First card's art, used as a deck tile's cutout background (null if unknown). */
  protected firstCardSrc(deck: Deck): string | null {
    const first = deck.list[0];
    return (first && this.srcOf(first)) || null;
  }

  protected openView(deck: Deck): void {
    this.menu.set(null);
    this.viewing.set(deck);
  }

  protected closeView(): void {
    this.viewing.set(null);
  }

  protected openMenu(event: MouseEvent, deck: Deck): void {
    event.preventDefault();
    const host = (event.currentTarget as HTMLElement).closest('app-decks')!;
    const rect = host.getBoundingClientRect();
    this.menu.set({ deck, x: event.clientX - rect.left, y: event.clientY - rect.top });
  }

  protected startRename(): void {
    const menu = this.menu();
    if (menu) this.renaming.set({ id: menu.deck.id, name: menu.deck.name });
    this.menu.set(null);
  }

  protected onRenameInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.renaming.update((r) => (r ? { ...r, name: value } : r));
  }

  protected saveRename(): void {
    const renaming = this.renaming();
    if (renaming && renaming.name.trim()) this.store.rename(renaming.id, renaming.name);
    this.renaming.set(null);
  }

  protected deleteDeck(): void {
    const menu = this.menu();
    if (menu) this.store.remove(menu.deck.id);
    this.menu.set(null);
  }

  /** Open the deposit modal, prefilled with the current API for editing. */
  protected openApiDialog(): void {
    this.apiError.set(null);
    this.apiDraft.set(this.api.apiUrl() ?? '');
  }

  protected onApiInput(event: Event): void {
    this.apiDraft.set((event.target as HTMLInputElement).value);
  }

  protected async saveApi(): Promise<void> {
    const draft = this.apiDraft();
    if (draft === null) return;
    const err = await this.api.setApiUrl(draft);
    this.apiError.set(err);
    if (!err) this.apiDraft.set(null);
  }

  /** Close the tile menu when clicking anywhere outside it. */
  protected onDocumentPointerDown(event: PointerEvent): void {
    if (!(event.target instanceof Element) || !event.target.closest('.deck-menu')) {
      this.menu.set(null);
    }
  }
}
