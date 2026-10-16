import { Component, input, output } from '@angular/core';
import { DeckRow } from '../deck-view';

/**
 * The cards of one group in the deck editor, as list rows or as image tiles.
 * Purely presentational: every button reports the row's `index` upward, the
 * editor owns the draft list.
 */
@Component({
  selector: 'app-deck-lines',
  templateUrl: './deck-lines.html',
  styleUrl: './deck-lines.scss',
  standalone: true,
})
export class DeckLines {
  readonly rows = input.required<DeckRow[]>();
  readonly mode = input<'list' | 'grid'>('list');
  /** Included decks: counts, art and removal are hidden. */
  readonly readonly = input(false);
  /** Whether a card API exists to pick artwork from. */
  readonly canArt = input(false);

  readonly delta = output<{ index: number; delta: number }>();
  readonly remove = output<number>();
  readonly artwork = output<number>();

  protected printLabel(row: DeckRow): string {
    const print = row.entry.print;
    return print ? `${print.set.toUpperCase()}${print.collector ? ' ' + print.collector : ''}` : '';
  }
}
