import { CardAction } from './card.types';

/**
 * The keyboard layer, and the overview of it shown in Settings
 * (`designdocs/hotkeys.md`). Both live here so they cannot drift: the "card
 * under the cursor" section of the guide is *generated* from the same `HOTKEYS`
 * record `CardInteractions` dispatches on, so adding a key adds its row.
 *
 * Deliberately free of Three.js imports — the menu screen renders the guide and
 * must not pull the scene into its bundle.
 */

/** Keys firing card actions while a card is hovered. */
export const HOTKEYS: Readonly<Record<string, CardAction>> = {
  v: 'view',
  t: 'tap',
  r: 'rotate',
  f: 'flip',
  g: 'related',
  d: 'duplicate',
  h: 'toHand',
  e: 'toExile',
  x: 'delete',
  Delete: 'delete',
};

/** Keys that put the camera back on the seat's base view (pan and zoom reset). */
export const RECENTER_KEYS: readonly string[] = ['c', 'Home'];

/** How each card action reads in the overview (the menu labels are dynamic). */
export const CARD_ACTION_LABELS: Readonly<Record<CardAction, string>> = {
  view: 'View the card large',
  tap: 'Tap / untap',
  rotate: 'Rotate a half turn',
  flip: 'Turn face down / face up — a double-faced card shows its other side',
  turnOver: 'Turn a double-faced card face down / face up',
  related: 'Show its related cards (tokens, melds…)',
  duplicate: 'Put a copy on the table',
  toHand: 'Return it to your hand',
  toDeck: 'Put it on top of your deck',
  toGrave: 'Put it into your graveyard',
  toExile: 'Exile it',
  attack: 'Send it into the attack zone',
  delete: 'Remove it from the table',
};

/** One row of the overview. */
export interface HotkeyEntry {
  /** The key(s), already display-cased — "V", "X / Delete". */
  keys: string;
  description: string;
}

export interface HotkeyGroup {
  title: string;
  entries: readonly HotkeyEntry[];
}

/** Single letters read better upper-cased; named keys stay as they are. */
function keyLabel(key: string): string {
  return key.length === 1 ? key.toUpperCase() : key;
}

/**
 * The hovered-card rows, straight out of `HOTKEYS` — grouped by action, so the
 * two keys that both delete show up as one "X / Delete" row.
 */
function hoveredCardEntries(): HotkeyEntry[] {
  const byAction = new Map<CardAction, string[]>();
  for (const [key, action] of Object.entries(HOTKEYS)) {
    const keys = byAction.get(action) ?? [];
    keys.push(keyLabel(key));
    byAction.set(action, keys);
  }
  return [...byAction].map(([action, keys]) => ({
    keys: keys.join(' / '),
    description: CARD_ACTION_LABELS[action],
  }));
}

/**
 * What the Settings ▸ Hotkeys panel lists. Read-only for now — the design doc
 * asks for an overview, not rebinding.
 */
export const HOTKEY_GUIDE: readonly HotkeyGroup[] = [
  { title: 'A card on the table, under the cursor', entries: hoveredCardEntries() },
  {
    title: 'A card in your hand, under the cursor',
    entries: [{ keys: 'V', description: 'View the card large' }],
  },
  {
    title: 'Anywhere in a room',
    entries: [
      { keys: 'U', description: 'Untap all of your cards' },
      { keys: 'C / Home', description: 'Recenter the camera (resets pan and zoom)' },
      { keys: 'Esc', description: 'Close a menu, cancel a drag, clear the selection' },
    ],
  },
  {
    // Not hotkeys, but the other half of the same reference — a list that
    // leaves out "click to tap" is not much use to a new player.
    title: 'Mouse',
    entries: [
      { keys: 'Click a card', description: 'Tap / untap it' },
      { keys: 'Drag a card', description: 'Move it; drop it on a pile to send it there' },
      { keys: 'Drag empty table', description: 'Select every card in the box' },
      { keys: 'Right-click a card', description: 'Its actions menu' },
      { keys: 'Right-click the table', description: 'Add dice, counters or a searched card' },
      { keys: 'Click / right-click a counter', description: 'Count it up / down' },
      {
        keys: 'Click your deck',
        description: 'Draw a card (right-click for shuffle, reveal, search)',
      },
      { keys: 'Middle-drag the table', description: 'Pan the camera' },
      { keys: 'Wheel over the table', description: 'Zoom the camera in and out' },
      { keys: 'Wheel over your hand', description: 'Pan a hand too wide to fit' },
    ],
  },
];
