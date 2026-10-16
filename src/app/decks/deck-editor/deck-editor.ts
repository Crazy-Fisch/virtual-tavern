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
import { CardApiService } from '../../carddb/card-api.service';
import { CardDatabaseService } from '../../carddb/card-database.service';
import { CardInfo, infoKey } from '../../carddb/card-info';
import { CardPrintService } from '../../carddb/card-print.service';
import { Dialog } from '../../shared/dialog/dialog';
import { ArtworkPicker } from '../artwork-picker/artwork-picker';
import { DeckCardSearch } from '../deck-card-search/deck-card-search';
import { DeckCurve } from '../deck-curve/deck-curve';
import { exportDecklist, withAdded, withDelta, withPrint, withoutLine } from '../deck-edit';
import { DeckLines } from '../deck-lines/deck-lines';
import { DeckStore } from '../deck-store';
import {
  CARD_TYPES,
  COLOR_NAMES,
  DeckFilter,
  DeckRow,
  GroupKey,
  MAX_CMC,
  NO_FILTER,
  SortKey,
  cmcLabel,
  deckCount,
  filterRows,
  groupRows,
  isFiltering,
  manaCurve,
  sortRows,
} from '../deck-view';
import { Deck, DeckEntry, DeckPrint, entrySrc, isBuiltInDeck } from '../deck.types';

const SORTS: { key: SortKey; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'cmc', label: 'Mana value' },
  { key: 'color', label: 'Color' },
  { key: 'type', label: 'Type' },
  { key: 'rarity', label: 'Rarity' },
];
const GROUPS: { key: GroupKey; label: string }[] = [
  { key: 'none', label: 'No grouping' },
  { key: 'type', label: 'Type' },
  { key: 'color', label: 'Color' },
  { key: 'cmc', label: 'Mana value' },
];

/**
 * Edit a saved deck: add cards found through the card API, change counts,
 * pick artwork per line, and look at the list sorted, grouped and filtered as
 * a list or as image tiles, with a mana curve. Edits stay in a draft until
 * Save writes them through `DeckStore.save`; the game reads the saved deck.
 * Included decks open read-only with a "Save a copy" button instead. The deck
 * model has one flat list, so there are no separate sideboard or commander
 * sections.
 */
@Component({
  selector: 'app-deck-editor',
  imports: [Dialog, ArtworkPicker, DeckCardSearch, DeckCurve, DeckLines],
  templateUrl: './deck-editor.html',
  styleUrl: './deck-editor.scss',
  standalone: true,
})
export class DeckEditor {
  private readonly store = inject(DeckStore);
  private readonly prints = inject(CardPrintService);
  private readonly db = inject(CardDatabaseService);
  protected readonly api = inject(CardApiService);

  readonly deck = input.required<Deck>();
  /** Leave the editor (after any unsaved-changes question). */
  readonly close = output<void>();
  /** A copy of an included deck was saved and should be opened instead. */
  readonly copied = output<Deck>();

  protected readonly sorts = SORTS;
  protected readonly groups = GROUPS;
  protected readonly types = CARD_TYPES;
  protected readonly colorLetters = ['W', 'U', 'B', 'R', 'G', 'C'];
  protected readonly colorNames = COLOR_NAMES;
  protected readonly cmcValues = Array.from({ length: MAX_CMC + 1 }, (_, i) => i);
  protected readonly cmcLabel = cmcLabel;

  protected readonly readonly = computed(() => isBuiltInDeck(this.deck().id));

  protected readonly name = signal('');
  protected readonly draft = signal<DeckEntry[]>([]);
  protected readonly infos = signal<ReadonlyMap<string, CardInfo>>(new Map());
  protected readonly view = signal<'list' | 'grid'>('list');
  protected readonly sort = signal<SortKey>('name');
  protected readonly descending = signal(false);
  protected readonly group = signal<GroupKey>('type');
  protected readonly filter = signal<DeckFilter>(NO_FILTER);
  protected readonly searching = signal(false);
  protected readonly artworkOf = signal<number | null>(null);
  protected readonly exporting = signal(false);
  protected readonly confirmLeave = signal(false);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);
  protected readonly copyLabel = signal('Copy');

  protected readonly dirty = computed(
    () =>
      this.name() !== this.deck().name ||
      JSON.stringify(this.draft()) !== JSON.stringify(this.deck().list),
  );

  protected readonly rows = computed<DeckRow[]>(() => {
    this.db.ready();
    const infos = this.infos();
    return this.draft().map((entry, index) => {
      const info = infos.get(infoKey(entry.card));
      const fallback = this.db.lookup(entry.card)?.src || info?.src;
      return { entry, index, info, src: entrySrc(entry, fallback) };
    });
  });
  protected readonly shown = computed(() =>
    sortRows(filterRows(this.rows(), this.filter()), this.sort(), this.descending()),
  );
  protected readonly sections = computed(() => groupRows(this.shown(), this.group()));
  protected readonly total = computed(() => deckCount(this.rows()));
  protected readonly shownCount = computed(() => deckCount(this.shown()));
  protected readonly filtering = computed(() => isFiltering(this.filter()));
  protected readonly curve = computed(() => manaCurve(this.rows()));
  protected readonly have = computed(() => {
    const have: Record<string, number> = {};
    for (const { entry } of this.rows()) {
      const key = entry.card.toLowerCase();
      have[key] = (have[key] ?? 0) + entry.count;
    }
    return have;
  });
  protected readonly artworkEntry = computed(() => {
    const index = this.artworkOf();
    return index === null ? null : (this.draft()[index] ?? null);
  });
  protected readonly exportText = computed(() =>
    this.exporting() ? exportDecklist(this.draft()) : '',
  );

  private loadedFor: string | null = null;
  private readonly asked = new Set<string>();

  constructor() {
    // Start from the stored deck, and again whenever the editor is pointed at another one.
    effect(() => {
      const deck = this.deck();
      untracked(() => {
        if (this.loadedFor === deck.id) return;
        this.loadedFor = deck.id;
        this.name.set(deck.name);
        this.draft.set(deck.list);
      });
    });
    // Fetch type, cost and rarity for cards the editor has not seen yet.
    effect(() => {
      const names = this.draft().map((e) => e.card);
      const apiUrl = this.api.apiUrl();
      untracked(() => void this.loadInfos(apiUrl ? names : []));
    });
  }

  private async loadInfos(names: string[]): Promise<void> {
    const wanted = names.filter((n) => !this.asked.has(infoKey(n)));
    if (wanted.length === 0) return;
    for (const n of wanted) this.asked.add(infoKey(n));
    try {
      const found = await this.prints.cardInfos(wanted);
      this.infos.update((old) => new Map([...old, ...found]));
    } catch {
      for (const n of wanted) this.asked.delete(infoKey(n));
    }
  }

  protected add(card: CardInfo): void {
    this.infos.update((old) => new Map(old).set(infoKey(card.name), card));
    this.asked.add(infoKey(card.name));
    this.draft.update((list) => withAdded(list, card.name));
  }

  protected change(event: { index: number; delta: number }): void {
    this.draft.update((list) => withDelta(list, event.index, event.delta));
  }

  protected remove(index: number): void {
    this.draft.update((list) => withoutLine(list, index));
  }

  protected applyArtwork(
    index: number,
    event: { print: DeckPrint | undefined; count: number },
  ): void {
    this.draft.update((list) => withPrint(list, index, event.print, event.count));
    this.artworkOf.set(null);
  }

  protected onName(event: Event): void {
    this.name.set((event.target as HTMLInputElement).value);
  }

  protected onText(event: Event): void {
    const text = (event.target as HTMLInputElement).value;
    this.filter.update((f) => ({ ...f, text }));
  }

  protected toggleColor(letter: string): void {
    this.filter.update((f) => ({ ...f, colors: toggled(f.colors, letter) }));
  }

  protected toggleType(type: string): void {
    this.filter.update((f) => ({ ...f, types: toggled(f.types, type) }));
  }

  protected toggleCmc(value: number): void {
    this.filter.update((f) => ({ ...f, cmcs: toggled(f.cmcs, value) }));
  }

  protected clearFilter(): void {
    this.filter.set(NO_FILTER);
  }

  protected onSort(event: Event): void {
    this.sort.set((event.target as HTMLSelectElement).value as SortKey);
  }

  protected onGroup(event: Event): void {
    this.group.set((event.target as HTMLSelectElement).value as GroupKey);
  }

  protected revert(): void {
    this.name.set(this.deck().name);
    this.draft.set(this.deck().list);
    this.error.set(null);
  }

  protected async save(): Promise<void> {
    this.saving.set(true);
    this.error.set(null);
    const error = await this.store.save(this.deck().id, this.name(), this.draft());
    this.saving.set(false);
    if (error) {
      this.error.set(error);
      return;
    }
    const saved = this.store.decks().find((d) => d.id === this.deck().id);
    if (saved) {
      this.name.set(saved.name);
      this.draft.set(saved.list);
    }
  }

  /** Leave the editor, asking first when there are unsaved changes. */
  requestClose(): void {
    if (this.dirty() && !this.readonly()) this.confirmLeave.set(true);
    else this.close.emit();
  }

  protected async saveAndLeave(): Promise<void> {
    await this.save();
    this.confirmLeave.set(false);
    if (!this.error()) this.close.emit();
  }

  protected async saveCopy(): Promise<void> {
    this.error.set(null);
    const { deck, error } = await this.store.create(`${this.name()} (copy)`, this.draft());
    if (deck) this.copied.emit(deck);
    else this.error.set(error);
  }

  protected async copyExport(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.exportText());
      this.copyLabel.set('Copied');
    } catch {
      this.copyLabel.set('Select the text and copy it');
    }
    setTimeout(() => this.copyLabel.set('Copy'), 2000);
  }

  protected download(): void {
    const url = URL.createObjectURL(new Blob([this.exportText()], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `${this.name().trim() || 'deck'}.txt`;
    link.click();
    URL.revokeObjectURL(url);
  }
}

function toggled<T>(set: T[], value: T): T[] {
  return set.includes(value) ? set.filter((v) => v !== value) : [...set, value];
}
