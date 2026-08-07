import { Component } from '@angular/core';
import { HOTKEY_GUIDE } from '../hotkeys';

/**
 * The read-only controls reference (`designdocs/hotkeys.md`) — the groups and
 * rows of `HOTKEY_GUIDE`, which is generated from the same `HOTKEYS` record
 * `CardInteractions` dispatches on.
 *
 * Presentation only, so both places that show it stay identical: the menu's
 * Settings ▸ Hotkeys panel, and the in-game button beside "Untap all". Drop it
 * inside an `app-dialog` (it brings its own styles, unlike markup projected
 * straight into one).
 */
@Component({
  selector: 'app-hotkey-list',
  templateUrl: './hotkey-list.html',
  styleUrl: './hotkey-list.scss',
  standalone: true,
})
export class HotkeyList {
  protected readonly guide = HOTKEY_GUIDE;
}
