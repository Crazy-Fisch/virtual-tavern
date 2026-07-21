import { Component, input, output } from '@angular/core';

/** Generic modal: dims the page, centers projected content, closes on backdrop click or Esc. */
@Component({
  selector: 'app-dialog',
  templateUrl: './dialog.html',
  styleUrl: './dialog.scss',
  standalone: true,
  host: { '(document:keydown.escape)': 'close.emit()', '[class.fit]': 'fit()' },
})
export class Dialog {
  readonly heading = input('');
  /** Size the frame to the projected content (e.g. a card image) instead of the fixed width. */
  readonly fit = input(false);
  readonly close = output<void>();
}
