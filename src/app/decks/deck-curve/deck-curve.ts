import { Component, computed, input } from '@angular/core';
import { cmcLabel } from '../deck-view';

/** Mana curve: one bar per mana value (0 to 7+) with its copy count; lands are not counted. */
@Component({
  selector: 'app-deck-curve',
  templateUrl: './deck-curve.html',
  styleUrl: './deck-curve.scss',
  standalone: true,
})
export class DeckCurve {
  readonly curve = input.required<number[]>();

  protected readonly bars = computed(() => {
    const curve = this.curve();
    const top = Math.max(1, ...curve);
    return curve.map((count, value) => ({
      label: cmcLabel(value),
      count,
      height: (count / top) * 100,
    }));
  });
}
